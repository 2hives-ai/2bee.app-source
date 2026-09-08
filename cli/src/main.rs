//! `2bee-slice` — headless harness around the CAM core.
//!
//! This binary exists so the gates run the SAME code the browser worker runs.
//! A gate that exercises a different build than the product ships is not a gate.
//!
//! Usage:
//!   2bee-slice fixture <name> [flags]     emit G-code for a named fixture
//!   2bee-slice fixtures                   list fixture names
//!   2bee-slice import <file> [flags]      plan from a DXF, SVG or STL
//!   2bee-slice recommend <file> [flags]   which cutter per feature, and WHY
//!   2bee-slice route <job|file> [flags]   reorder the cuts, and report the travel
//!   2bee-slice fit <file> [flags]         the datum shift that lands it inside travel
//!   2bee-slice layout --drawing … [flags] several drawings on one workpiece, checked
//!   2bee-slice version                    print the G-code contract version
//!   2bee-slice buildid                    print the core source fingerprint (gate K3)
//!
//! The four engine commands print their REASONS, not just their answers. A bare
//! verdict — "use the 6mm", "saved 300mm", "it fits" — throws away the half that
//! makes it checkable, and an unreviewable answer about a 2.2 kW spindle is worse
//! than no answer.
//!
//! 🔴 **A refusal exits NON-ZERO and prints NO G-code** (gate G13's property).
//! None of the four emit G-code at all, so for them the property reduces to the
//! exit code — and that is exactly what a script reads:
//!   0  the question was answered
//!   1  REFUSED — a feature has no tool, a program will not fit, parts interfere
//!   2  the invocation was wrong (unreadable file, unknown flag value, bad number)
//!
//! Import flags:
//!   --plant <name>               accepted ONLY as `none`. A known plant is
//!                                refused with the reason (the core's import
//!                                path takes no plant), an unknown one exits 2
//!                                exactly as `report` does
//!   --format <dxf|svg|stl|obj|3mf|step|auto>  default auto — decided by CONTENT, not by the
//!                                file's name
//!   --z <mm>                     section Z for a MESH. An STL is a 3D mesh and
//!                                this engine is 2.5D, so it enters as ONE FLAT
//!                                SLICE at this Z — not as 3D surfacing. Omit it
//!                                and the mesh is sectioned at its mid-height,
//!                                which the report says out loud.
//!   --json                       emit the whole report instead of G-code
//!
//! Flags:
//!   --plant <defect>   plant a deliberate defect (see `--plant list`)
//!   --no-arcs          force arc degradation to linear moves
//!   --probe            emit the touch-plate Z-zero sequence
//!   --spoilboard-zero  Z is zeroed on the spoilboard, not the workpiece top
//!   --machine-x <mm>   override X travel (default 600)
//!   --machine-y <mm>   override Y travel (default 900)
//!   --entry <mode>     Plunge | Ramp | Helix. Helix is REFUSED as unimplemented
//!                      (exit 1, no G-code) rather than cut as a linear ramp
//!   --sim-cell <mm>    simulation grid size (default 0.6), must be positive
//!
//! 🔴 EVERY flag in this binary is REFUSED by the subcommand that does not read
//! it, with exit 2 and the flag named — `flags_for` / `check_flags`. A flag
//! accepted and discarded is worse than one that errors: the operator, the
//! script and the GATE all believe a setting took effect. `job --config` was
//! discarded entirely and `import --plant` exited 0 doing nothing, and the
//! second could make a negative control vacuous.
//!
//! 🔴 EVERY numeric flag in this binary REFUSES a value it cannot read, with
//! exit 2 and the flag named. ABSENT and UNPARSEABLE are different answers and
//! must never collapse into each other. The travel flags are the reason this is
//! a rule and not a preference: an unreadable `--machine-x` used to fall back to
//! the DEFAULT travel, which is LARGER than the machine anyone would be overriding
//! it for — so the failure mode was not a refused job, it was a program posted
//! against a machine bigger than the one it would run on.
//!
//! Engine-command flags (recommend / route / fit / layout):
//!   --format <dxf|svg|stl|obj|3mf|step|auto>  as `import`: decided by CONTENT, not by name
//!   --z <mm>                     section Z for a mesh
//!   --tool <id>                  a tool id from the built-in library
//!   --thickness <mm>             workpiece thickness (default 18)
//!   --material <name>            Plywood|MDF|Hardwood|Softwood|Acrylic|Aluminium
//!   --collet <mm>                the collet FITTED in the spindle. Absent is
//!                                UNDECLARED, which is unchecked, not passed
//!   --spare-collet <mm>          repeatable — collets the shop owns
//!   --json                       the whole answer as JSON

use twobee_cam::fixtures as jobs;

use std::process::ExitCode;

use twobee_cam::geometry::Part;
use twobee_cam::layout::{Clearance, Layout, PlacedDrawing};
use twobee_cam::optimise::optimise_route;
use twobee_cam::placement::{plan_datum_shift, Extent, Placement};
use twobee_cam::recommend::{recommend, DepthSource, Feature, RecommendOptions};
use twobee_cam::rect_profile::{build, Plant, RectJob};
use twobee_cam::toolpath::{operations_for_part, Operation};
use twobee_cam::tools::{default_library, Material, ShankFit, ToolSpec};
use twobee_cam::{
    post_grblhal, CutSide, EntryMode, Machine, OperationParams, PostOptions, Stock, Tool, ZDatum,
    GCODE_CONTRACT_VERSION,
};

/// Chaining tolerance for intake, in mm.
///
/// ⚠ The core's own value (`fixtures::IMPORT_TOL_MM`) is a PRIVATE const and is
/// not exported, so this is a hand-kept copy and it can drift. It is written
/// here rather than guessed at a call site so there is one place to fix when the
/// core exports it. Two intake tolerances is two sets of chaining bugs.
const IMPORT_TOL_MM: f64 = 0.02;

/// The cutter used when the caller names none. It is PRINTED on every answer
/// that depends on it, because a tool the operator did not choose deciding
/// whether their part fits is the same defect as a guessed cutter diameter.
const DEFAULT_TOOL_ID: &str = "End Mill - Down-cut 6mm 2F";

const FIXTURES: &[(&str, &str)] = &[
    ("rect-profile", "120x80 outside profile, 18mm ply, 6mm 2F down-cut, ramp entry"),
    ("rect-arcs", "same part with 8mm corner radii — exercises real G2/G3 emission"),
    ("rect-inside", "inside cut: the hole is kept, tool runs inside the line"),
    ("drill-peck", "four 6mm holes, G83 peck cycle"),
];

const PLANTS: &[(&str, &str)] = &[
    ("offbed", "shift the part past the far edge of the X travel"),
    ("deep", "cut 7mm past the workpiece into the spoilboard"),
    ("paren", "part name with parentheses — ends a grblHAL comment early"),
    ("spindle-off", "cutting moves with the spindle never started"),
    ("rpm", "request an rpm the spindle cannot deliver"),
    ("arc-first", "emit an arc before any positioning move"),
];

fn plant_from(s: &str) -> Option<Plant> {
    Some(match s {
        "none" => Plant::None,
        "offbed" => Plant::OffBed,
        "deep" => Plant::ThroughSpoilboard,
        "paren" => Plant::ParenInName,
        "spindle-off" => Plant::SpindleNeverOn,
        "rpm" => Plant::RpmOutOfRange,
        "arc-first" => Plant::ArcBeforePosition,
        _ => return None,
    })
}

// ===========================================================================
//  Which flags each subcommand actually READS
// ===========================================================================
//
// 🔴 A flag that is accepted and discarded is WORSE than one that errors. The
// operator, the script and — this is the one that bites — the GATE all believe
// a setting took effect. Two live instances were measured on 2026-08-09:
// `job <name> --config <file>` built no `JobConfig` at all, and
// `import <file> --plant <name>` exited 0 having done nothing. The second is
// the sharper case: a negative control driven that way runs CLEAN and reads as
// a passing control, which turns this lane's core safety mechanism into
// decoration.
//
// The general defect was not those two flags — it was that NOTHING in this
// binary rejected a flag it did not read. `flag_value` scans for a name and
// finds nothing; a typo, a flag from a sibling subcommand and a flag that was
// never implemented are all indistinguishable from "not given". So the fix is
// a per-subcommand list of the flags that are READ, and a refusal for anything
// else — the same rule `--entry`, `--material` and `--tool` already apply to
// their VALUES, applied one level up to the flag names.
//
// ⚠ The lists below are the CONTRACT, and they are checked against the code by
// `every_listed_flag_is_read_by_its_subcommand` in the test module — a list
// that drifts from the parser re-opens exactly this hole while looking like a
// guard.
struct FlagSpec {
    /// `--name <value>` — the following argument is its value and is skipped.
    value: &'static [&'static str],
    /// `--name` — present or absent, nothing follows.
    boolean: &'static [&'static str],
}

/// The flags a subcommand reads, or `None` if this is not a subcommand.
fn flags_for(cmd: &str) -> Option<FlagSpec> {
    Some(match cmd {
        "version" | "buildid" | "fixtures" | "jobs" | "plants" | "dialect-rules" | "nest-check"
        | "drill-check" => FlagSpec { value: &[], boolean: &[] },
        "job" => FlagSpec {
            value: &["--plant", "--config", "--sim-cell"],
            boolean: &["--no-probe"],
        },
        "report" => {
            FlagSpec { value: &["--plant", "--config", "--sim-cell"], boolean: &[] }
        }
        "import" => FlagSpec {
            value: &["--format", "--z", "--config", "--sim-cell", "--plant"],
            boolean: &["--json"],
        },
        "fixture" => FlagSpec {
            value: &["--plant", "--machine-x", "--machine-y", "--entry"],
            boolean: &["--probe", "--no-arcs", "--spoilboard-zero"],
        },
        "recommend" => FlagSpec {
            value: &[
                "--machine-x", "--machine-y", "--collet", "--spare-collet", "--thickness",
                "--sheet-x", "--sheet-y", "--material", "--z", "--drill-tolerance", "--format",
                // `--depth` declares the feature depth a DXF cannot carry. See
                // `DepthSource`: without it every feature is priced as a through
                // cut at stock thickness, and that assumption now rides beside
                // the number instead of only in the footer.
                "--depth",
            ],
            boolean: &["--json", "--all-rejections", "--no-prefer-fewer-tools"],
        },
        // `--tool` and `--plant` are BOTH listed and only ONE of them applies,
        // decided by whether the target is a file or a job name. Listing them
        // here keeps the message about the branch rather than about the
        // spelling; `run_route` refuses the one that does not apply, naming
        // which target it was given.
        "route" => FlagSpec {
            value: &[
                "--tool", "--plant", "--thickness", "--sheet-x", "--sheet-y", "--z",
                "--depth-per-pass", "--format",
            ],
            boolean: &["--json"],
        },
        "fit" => FlagSpec {
            value: &[
                "--tool", "--tool-radius", "--machine-x", "--machine-y", "--collet",
                "--spare-collet", "--thickness", "--sheet-x", "--sheet-y", "--z",
                "--travel-margin", "--format",
            ],
            boolean: &["--json"],
        },
        "layout" => FlagSpec {
            value: &[
                "--drawing", "--at", "--rot", "--id", "--cutter", "--clearance-margin",
                "--travel-margin", "--machine-x", "--machine-y", "--collet", "--spare-collet",
                "--thickness", "--sheet-x", "--sheet-y", "--z", "--format",
            ],
            boolean: &["--json"],
        },
        // 🔴 `nest` takes `--offset` and NOT `--at`; `layout` takes `--at` and
        // NOT `--offset`. Neither list carries the other's flag, so passing the
        // wrong one is REFUSED by name rather than read as the one it does know.
        // They are different questions — a delta from as-drawn versus an
        // absolute corner position — and a flag quietly answering the other one
        // moves a part by the whole distance between the drawing's own origin
        // and the workpiece's. See `Placed::is_delta`.
        "nest" => FlagSpec {
            value: &[
                "--drawing", "--offset", "--rot", "--id", "--config", "--sim-cell", "--format",
                "--z", "--plant",
            ],
            boolean: &["--json"],
        },
        _ => return None,
    })
}

/// Refuse any `--flag` this subcommand does not read.
///
/// 🔴 The value of a value-taking flag is SKIPPED rather than examined. A tool
/// id, a material name or a file path is the caller's data and must never be
/// re-interpreted as a flag — that is how a checker starts refusing a legal
/// invocation, which costs more than the hole it closes.
fn check_flags(spec: &FlagSpec, args: &[String]) -> Result<(), String> {
    let mut i = 1usize; // args[0] is the subcommand itself
    while i < args.len() {
        let a = args[i].as_str();
        if !a.starts_with("--") {
            i += 1;
            continue;
        }
        if spec.value.contains(&a) {
            i += 2;
            continue;
        }
        if spec.boolean.contains(&a) {
            i += 1;
            continue;
        }
        let mut known: Vec<&str> = spec.value.iter().chain(spec.boolean.iter()).copied().collect();
        known.sort_unstable();
        return Err(format!(
            "`{}` does not read the flag {a}, so it was REFUSED rather than ignored — a flag \
             that is accepted and discarded reads to an operator, a script and a gate as a \
             setting that took effect. {}",
            args[0],
            if known.is_empty() {
                "this subcommand takes no flags".to_string()
            } else {
                format!("flags it does read: {}", known.join(" "))
            }
        ));
    }
    Ok(())
}

fn flag_value(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

/// Every occurrence of a repeatable flag, in the order they were written.
fn flag_values(args: &[String], name: &str) -> Vec<String> {
    let mut out = Vec::new();
    for (i, a) in args.iter().enumerate() {
        if a == name {
            if let Some(v) = args.get(i + 1) {
                out.push(v.clone());
            }
        }
    }
    out
}

fn has_flag(args: &[String], name: &str) -> bool {
    args.iter().any(|a| a == name)
}

/// A numeric flag, or an error naming it.
///
/// 🔴 ABSENT and UNPARSEABLE are different answers and must never collapse into
/// each other. `--margin 1,5` is a typo; treating it as "no margin given" is how
/// an operator ends up believing they set a clearance that was never read. The
/// same reasoning `import`'s `--z` is written with, applied everywhere rather
/// than once.
fn num_flag(args: &[String], name: &str) -> Result<Option<f64>, String> {
    match flag_value(args, name) {
        None => Ok(None),
        Some(s) => match s.parse::<f64>() {
            Ok(v) if v.is_finite() => Ok(Some(v)),
            _ => Err(format!("{name} '{s}' is not a finite number in millimetres")),
        },
    }
}

fn num_flag_or(args: &[String], name: &str, default: f64) -> Result<f64, String> {
    Ok(num_flag(args, name)?.unwrap_or(default))
}

/// A POSITIONAL number, or an error naming which argument it is.
///
/// The same rule as [`num_flag`], applied to the arguments that have no flag to
/// name them. `2bee-slice nest-check 3O 0 0` (letter O) must not read as "no
/// rotation given" and quietly check the UNROTATED placement instead — a nest
/// check that answered a question nobody asked reports clear about a workpiece that
/// was never examined.
fn pos_num(args: &[String], i: usize, what: &str, default: f64) -> Result<f64, String> {
    match args.get(i) {
        None => Ok(default),
        Some(s) => match s.parse::<f64>() {
            Ok(v) if v.is_finite() => Ok(v),
            _ => Err(format!("{what} (argument {i}) '{s}' is not a finite number")),
        },
    }
}

/// `--machine-x` / `--machine-y`, applied to a machine, refusing what it cannot
/// read.
///
/// 🔴 ONE implementation, used by every command that takes these two flags.
/// They previously had two: the engine commands parsed them strictly through
/// [`num_flag`], while `fixture` used `.parse().ok()` and read an unparseable
/// value as ABSENT. That asymmetry is not merely sloppy — the fallback is the
/// DEFAULT travel, which is LARGER than the small machine anyone would be
/// overriding it for. `--machine-x 60O` (letter O) therefore posted a program
/// checked against 600mm of travel while the operator believed they had said
/// 600 to a machine they had told it about. The failure mode of a misread
/// travel limit is a program that runs past the end of the axis, so this flag
/// must never fail open.
fn apply_travel(args: &[String], m: &mut Machine) -> Result<(), String> {
    if let Some(v) = num_flag(args, "--machine-x")? {
        m.travel_x_mm = v;
    }
    if let Some(v) = num_flag(args, "--machine-y")? {
        m.travel_y_mm = v;
    }
    Ok(())
}

/// The simulation cell size in mm, strict and POSITIVE.
///
/// `.parse().ok()` here read `--sim-cell 0,6` as "not given" and silently used
/// 0.6. The cell size decides whether a gouge is SEEN at all, so an unread
/// value is a verification quietly answering a different question than the one
/// asked — and it answers it with a green. Zero or negative is not a coarse
/// grid, it is not a grid, and it is refused rather than clamped.
fn sim_cell_from(args: &[String]) -> Result<f64, String> {
    match num_flag(args, "--sim-cell")? {
        None => Ok(0.6),
        Some(v) if v > 0.0 => Ok(v),
        Some(v) => Err(format!(
            "--sim-cell '{v}' is not a positive size in millimetres — a zero or negative cell is \
             not a coarse grid, it is no grid at all"
        )),
    }
}

/// `--entry <Plunge|Ramp|Helix>` for the fixture path, or an error naming it.
///
/// Exposed so the fixture generator's REFUSAL of an unimplemented mode is
/// reachable from the command line. A refusal nobody can trigger is a refusal
/// nobody has watched happen.
fn entry_from(args: &[String]) -> Result<Option<EntryMode>, String> {
    let Some(s) = flag_value(args, "--entry") else {
        return Ok(None);
    };
    match s.to_ascii_lowercase().as_str() {
        "plunge" => Ok(Some(EntryMode::Plunge)),
        "ramp" => Ok(Some(EntryMode::Ramp)),
        "helix" => Ok(Some(EntryMode::Helix)),
        _ => Err(format!(
            "--entry '{s}' is not an entry mode this core knows. known: Plunge, Ramp, Helix"
        )),
    }
}

/// Report an invocation error the same way everywhere: one `error:` line and
/// exit 2. Exit 2 is "you asked wrongly"; exit 1 is "the answer is a refusal".
/// Collapsing the two would let a script read a typo as a clear answer.
fn bad_invocation(why: impl AsRef<str>) -> ExitCode {
    eprintln!("error: {}", why.as_ref());
    ExitCode::from(2)
}

/// `--config <file>`, read the SAME way on every host that takes it.
///
/// 🔴 ONE implementation, for the reason `apply_travel` is one: `report` and
/// `import` each grew their own copy and `job` grew NONE — it parsed no config
/// at all and every setting in the file was discarded in silence. Three copies
/// of a reader is three chances for one of them to be missing, and the missing
/// one is invisible precisely because it never complains.
///
/// The two failures stay TOLD APART even though both exit 2: "I could not open
/// your file" sends the caller to the path, "your file is not the configuration
/// I expected" sends them to its contents, and `serde_json`'s message names the
/// line.
fn config_from(args: &[String]) -> Result<twobee_cam::fixtures::JobConfig, String> {
    match flag_value(args, "--config") {
        None => Ok(Default::default()),
        Some(p) => match std::fs::read_to_string(&p) {
            Ok(t) => serde_json::from_str(&t)
                .map_err(|e| format!("configuration {p} rejected: {e}")),
            Err(e) => Err(format!("cannot read {p}: {e}")),
        },
    }
}

// ===========================================================================
//  Shared setup for the four engine commands
// ===========================================================================

fn machine_from(args: &[String]) -> Result<Machine, String> {
    let mut m = Machine::default();
    apply_travel(args, &mut m)?;
    if let Some(v) = num_flag(args, "--collet")? {
        m.collet_mm = v;
    }
    for s in flag_values(args, "--spare-collet") {
        match s.parse::<f64>() {
            Ok(v) if v.is_finite() && v > 0.0 => m.spare_collets_mm.push(v),
            _ => return Err(format!("--spare-collet '{s}' is not a positive number in millimetres")),
        }
    }
    Ok(m)
}

fn stock_from(args: &[String]) -> Result<Stock, String> {
    let mut s = Stock::default();
    if let Some(v) = num_flag(args, "--thickness")? {
        s.thickness_mm = v;
    }
    if let Some(v) = num_flag(args, "--sheet-x")? {
        s.size_x_mm = v;
    }
    if let Some(v) = num_flag(args, "--sheet-y")? {
        s.size_y_mm = v;
    }
    Ok(s)
}

fn material_from(args: &[String]) -> Result<Material, String> {
    match flag_value(args, "--material") {
        None => Ok(Material::Plywood),
        Some(s) => Material::from_str(&s).ok_or_else(|| {
            format!(
                "--material '{s}' is not a material this core knows. known: {}",
                Material::all().iter().map(|m| m.as_str()).collect::<Vec<_>>().join(", ")
            )
        }),
    }
}

/// The tool, taken from the built-in library BY ID.
///
/// An unknown id is refused rather than substituted. A recommendation, a datum
/// shift and a clearance check all move with the cutter, so falling back to
/// "something similar" would answer a different question than the one asked.
fn tool_from(args: &[String]) -> Result<ToolSpec, String> {
    let id = flag_value(args, "--tool").unwrap_or_else(|| DEFAULT_TOOL_ID.into());
    default_library()
        .into_iter()
        .find(|t| t.id == id)
        .ok_or_else(|| format!("--tool '{id}' is not in the built-in library; run with a known id"))
}

// ===========================================================================
//  Intake — one loader, shared by all four
// ===========================================================================

/// Why a drawing did not become geometry — and which exit code that is.
///
/// 🔴 The two are genuinely different facts. "I could not read your file" is a
/// typo; "I read your file and there is nothing in it that can be cut" is a
/// refusal about the drawing. A script that saw one code for both would read a
/// mis-typed path as a drawing with nothing in it to cut.
enum LoadError {
    Invocation(String),
    Refused(String),
}

impl LoadError {
    fn report(&self) -> ExitCode {
        match self {
            LoadError::Invocation(m) => {
                eprintln!("error: {m}");
                ExitCode::from(2)
            }
            LoadError::Refused(m) => {
                eprintln!("refused: {m}");
                ExitCode::from(1)
            }
        }
    }
}

struct Drawing {
    /// What to call this drawing in a finding.
    label: String,
    parts: Vec<Part>,
    unit_note: String,
    unsupported: Vec<String>,
    open_contours: usize,
    /// Present only when a mesh was sectioned at a Z NOBODY CHOSE.
    z_note: Option<String>,
}

impl Drawing {
    fn extent(&self) -> Option<Extent> {
        Extent::from_parts(&self.parts)
    }

    fn print_intake(&self) {
        eprintln!("note: {}: {}", self.label, self.unit_note);
        if let Some(n) = &self.z_note {
            eprintln!("note: {}: {n}", self.label);
        }
        for u in &self.unsupported {
            eprintln!("note: {}: NOT IMPORTED — {u}", self.label);
        }
        if self.open_contours > 0 {
            eprintln!(
                "note: {}: {} contour(s) did not close and were not turned into a cut",
                self.label, self.open_contours
            );
        }
    }
}

/// Read a drawing as BYTES and let the CONTENT decide the format.
///
/// 🔴 Deliberately the same order of decisions `import` makes, and for the same
/// reason: the extension is a claim made by whoever named the file, and a binary
/// STL called `part.dxf` must still reach the section path rather than yield an
/// empty drawing that reads downstream exactly like a valid drawing with no
/// features.
fn load_drawing(
    path: &str,
    format: &str,
    z_section_mm: Option<f64>,
    sheet_height_mm: f64,
    label: &str,
) -> Result<Drawing, LoadError> {
    let data = std::fs::read(path)
        .map_err(|e| LoadError::Invocation(format!("cannot read {path}: {e}")))?;

    let is_mesh = format.eq_ignore_ascii_case("stl")
        || format.eq_ignore_ascii_case("obj")
        || format.eq_ignore_ascii_case("3mf")
        || format.eq_ignore_ascii_case("step")
        || twobee_cam::mesh::looks_like_stl(&data)
        || twobee_cam::mesh::looks_like_3mf(&data)
        || (std::str::from_utf8(&data).map_or(false, |t|
            twobee_cam::mesh::looks_like_obj(t) || twobee_cam::mesh::looks_like_step(t)));
    let mut z_note = None;

    let is_obj = format.eq_ignore_ascii_case("obj")
        || (is_mesh
            && !format.eq_ignore_ascii_case("stl")
            && !format.eq_ignore_ascii_case("3mf")
            && !twobee_cam::mesh::looks_like_stl(&data)
            && !twobee_cam::mesh::looks_like_3mf(&data)
            && std::str::from_utf8(&data).map_or(false, |t| twobee_cam::mesh::looks_like_obj(t)));
    let is_3mf = format.eq_ignore_ascii_case("3mf")
        || (is_mesh && !is_obj && twobee_cam::mesh::looks_like_3mf(&data));
    let is_step = format.eq_ignore_ascii_case("step")
        || (is_mesh && !is_obj && !is_3mf
            && std::str::from_utf8(&data).map_or(false, |t| twobee_cam::mesh::looks_like_step(t)));

    let imported = if is_mesh {
        // 3MF: parse as 3MF mesh (ZIP archive)
        if is_3mf {
            let mesh = twobee_cam::mesh::parse_3mf(&data);
            let z = match z_section_mm {
                Some(z) => z,
                None => match mesh.z_span() {
                    Some((lo, hi)) => {
                        let z = (lo + hi) * 0.5;
                        z_note = Some(format!(
                            "no section Z was given — this mesh was sectioned at its \
                             MID-HEIGHT, z = {z:.3}mm, of a solid spanning z = \
                             {lo:.3}..{hi:.3}mm. That Z was CHOSEN FOR YOU: a different Z \
                             gives a different outline"
                        ));
                        z
                    }
                    None => {
                        z_note = Some(
                            "no section Z was given and the mesh has no measurable extent — \
                             z = 0.000mm was used"
                                .into(),
                        );
                        0.0
                    }
                },
            };
            twobee_cam::mesh::section(&mesh, z, IMPORT_TOL_MM)
        // OBJ: parse as OBJ mesh
        } else if is_obj {
            let text = std::str::from_utf8(&data)
                .map_err(|e| LoadError::Invocation(format!("OBJ file is not valid UTF-8: {e}")))?;
            let mesh = twobee_cam::mesh::parse_obj(text);
            let z = match z_section_mm {
                Some(z) => z,
                None => match mesh.z_span() {
                    Some((lo, hi)) => {
                        let z = (lo + hi) * 0.5;
                        z_note = Some(format!(
                            "no section Z was given — this mesh was sectioned at its \
                             MID-HEIGHT, z = {z:.3}mm, of a solid spanning z = \
                             {lo:.3}..{hi:.3}mm. That Z was CHOSEN FOR YOU: a different Z \
                             gives a different outline"
                        ));
                        z
                    }
                    None => {
                        z_note = Some(
                            "no section Z was given and the mesh has no measurable extent — \
                             z = 0.000mm was used"
                                .into(),
                        );
                        0.0
                    }
                },
            };
            twobee_cam::mesh::section(&mesh, z, IMPORT_TOL_MM)
        } else if is_step {
            // 🔴 REFUSED, and refused HARD: exit 1 with zero bytes on stdout.
            //
            // This used to tessellate the planar faces and section the triangles
            // — a DIFFERENT reader from the one the browser used on the same
            // file, so one STEP part had two answers and no gate drove either.
            // Both readers are gone; `mesh::STEP_REFUSAL` is the one message all
            // three doors now give. See `mesh::refuse_step` for the three ways
            // the old reader produced a plausible-looking wrong part.
            return Err(LoadError::Refused(twobee_cam::mesh::STEP_REFUSAL.into()));
        } else {
            // STL
            match twobee_cam::mesh::parse_stl(&data) {
                Some(mesh) => {
                    let z = match z_section_mm {
                        Some(z) => z,
                        None => match mesh.z_span() {
                            Some((lo, hi)) => {
                                let z = (lo + hi) * 0.5;
                                z_note = Some(format!(
                                    "no section Z was given — this mesh was sectioned at its \
                                     MID-HEIGHT, z = {z:.3}mm, of a solid spanning z = \
                                     {lo:.3}..{hi:.3}mm. That Z was CHOSEN FOR YOU: a different Z \
                                     gives a different outline"
                                ));
                                z
                            }
                            None => {
                                z_note = Some(
                                    "no section Z was given and the mesh has no measurable extent — \
                                     z = 0.000mm was used"
                                        .into(),
                                );
                                0.0
                            }
                        },
                    };
                    twobee_cam::mesh::section(&mesh, z, IMPORT_TOL_MM)
                }
                // Declared a mesh and unreadable as one. The core owns that refusal
                // by name; the Z is echoed back exactly as asked so nothing implies
                // one was chosen.
                None => twobee_cam::mesh::parse_stl_section(&data, z_section_mm.unwrap_or(0.0), IMPORT_TOL_MM),
            }
        }
    } else {
        match format {
            "auto" => twobee_cam::import::parse_bytes(&data, sheet_height_mm, 0.0, IMPORT_TOL_MM),
            "dxf" | "svg" => {
                let Ok(text) = std::str::from_utf8(&data) else {
                    return Err(LoadError::Invocation(format!(
                        "{path} was read as '{format}', which is a text format, but it is not \
                         valid UTF-8 — it was NOT imported. A binary STL belongs on the mesh path"
                    )));
                };
                if format == "svg" {
                    twobee_cam::import::parse_svg(text, sheet_height_mm, IMPORT_TOL_MM)
                } else {
                    twobee_cam::import::parse_dxf(text, IMPORT_TOL_MM)
                }
            }
            other => {
                return Err(LoadError::Invocation(format!(
                    "unknown format '{other}' — expected dxf, svg, stl, obj, 3mf, step or auto"
                )))
            }
        }
    };

    // The same prefix `fixtures::plan_report_import_bytes` uses, so a part is
    // called the same thing whichever command imported it. `layout` qualifies it
    // further as `drawing/part`, which is where the drawing's name belongs.
    let parts = twobee_cam::import::to_parts(&imported, "part");
    if parts.is_empty() {
        // Say WHICH question failed. "No contours" is true of a drawing and
        // misleading about a solid, where the usual cause is a section plane
        // that missed the part entirely.
        let mut why = if is_mesh {
            format!(
                "{path}: the STL SECTION produced no closed outline that could be cut — either \
                 the plane crossed no geometry, or the mesh is open at that Z"
            )
        } else {
            format!("{path}: produced no closed outline that could be cut — check for open contours")
        };
        if imported.open_contours > 0 {
            why.push_str(&format!(" ({} contour(s) did not close)", imported.open_contours));
        }
        for u in &imported.unsupported {
            why.push_str(&format!("; NOT IMPORTED — {u}"));
        }
        return Err(LoadError::Refused(why));
    }

    Ok(Drawing {
        label: label.to_string(),
        parts,
        unit_note: imported.unit_note,
        unsupported: imported.unsupported,
        open_contours: imported.open_contours,
        z_note,
    })
}

/// Basename without extension — the default id for a drawing on the workpiece.
fn label_for(path: &str) -> String {
    std::path::Path::new(path)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "drawing".into())
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let cmd = args.first().map(String::as_str).unwrap_or("help");

    // 🔴 BEFORE any work, and before any positional is read: a flag this
    // subcommand does not consume is refused by name. An unknown command falls
    // through to the usage block below, which is a different error and says so.
    if let Some(spec) = flags_for(cmd) {
        if let Err(e) = check_flags(&spec, &args) {
            return bad_invocation(e);
        }
    }

    match cmd {
        "version" => {
            println!("2bee-slice {}", env!("CARGO_PKG_VERSION"));
            println!("gcode-contract {GCODE_CONTRACT_VERSION}");
            ExitCode::SUCCESS
        }
        // Prints the core's source fingerprint and NOTHING else — the gate
        // compares this stdout against the wasm's `build_id()` verbatim. Any
        // extra line here becomes a diff the gate would have to parse around,
        // and a gate that parses is a gate that can parse wrongly.
        "buildid" => {
            println!("{}", twobee_cam::BUILD_ID);
            ExitCode::SUCCESS
        }
        "fixtures" => {
            for (n, d) in FIXTURES {
                println!("{n:<14} {d}");
            }
            ExitCode::SUCCESS
        }
        "jobs" => {
            for (n, d) in jobs::JOBS {
                println!("{n:<12} {d}");
            }
            ExitCode::SUCCESS
        }
        // 🔴 The registry gate PLANT reads. It comes OUT OF THE BINARY on
        // purpose: a hand-kept list in the gate file is a second place for a
        // plant to exist, and the whole finding this subcommand answers is that
        // a plant can be registered in one place and consumed in none.
        //
        // Both families are printed through one path — the post-level plants
        // (`rect_profile::Plant`, host `fixture`) and the job-level ones
        // (`JobPlant`) — because they are equally able to go inert and were
        // equally unaudited. A plant present in `PLANTS`/`JOB_PLANTS` with no
        // contract row prints as `contract=MISSING` rather than being dropped:
        // a registry that silently omits what it cannot describe is how the
        // orphans survived in the first place.
        "plants" => {
            for (n, d) in PLANTS.iter().chain(jobs::JOB_PLANTS.iter()) {
                match jobs::plant_contract(n) {
                    Some(c) => println!(
                        "{}\thost={}\ttarget={}\teffect={}\tgate={}\tconfig={}\t{}",
                        c.name,
                        c.host,
                        c.target,
                        c.effect.as_str(),
                        if c.gate.is_empty() { "NONE" } else { c.gate },
                        c.config.unwrap_or("-"),
                        d
                    ),
                    None => println!(
                        "{n}\thost=?\ttarget=?\teffect=?\tgate=NONE\tconfig=-\tcontract=MISSING {d}"
                    ),
                }
            }
            ExitCode::SUCCESS
        }
        "job" => {
            let Some(name) = args.get(1) else {
                eprintln!("job: name required");
                return ExitCode::from(2);
            };
            run_job(name, &args)
        }
        // The SAME call the browser makes, printed as JSON. Gate I1 compares
        // this byte-for-byte against what the page produces; if they differ,
        // one of the two hosts is not running the code we gated.
        "report" => {
            let Some(name) = args.get(1) else {
                eprintln!("report: job name required");
                return ExitCode::from(2);
            };
            let plant_name = flag_value(&args, "--plant").unwrap_or_else(|| "none".into());
            let Some(plant) = jobs::job_plant_from(&plant_name) else {
                eprintln!("unknown plant '{plant_name}'");
                return ExitCode::from(2);
            };
            let cfg = match config_from(&args) {
                Ok(c) => c,
                Err(e) => return bad_invocation(e),
            };
            let cell = match sim_cell_from(&args) {
                Ok(v) => v,
                Err(e) => return bad_invocation(e),
            };
            match twobee_cam::fixtures::plan_report(name, plant, &cfg, cell) {
                Some(r) => {
                    // 🔴 THE THIRD DOOR, AND THE ONE THE PLANT IS DOCUMENTED TO BE
                    // DRIVEN THROUGH. `job` gained the gouge warning on 2026-08-27,
                    // `import` and `nest` the same day; `report` was missed for two
                    // rounds. It is JSON-ONLY — so the justification given for
                    // hoisting the other two above their `--json` branches ("a
                    // script is exactly the caller that greps `^warning:`") applies
                    // to 100% of this door's callers, not most of them. `README.md`
                    // and `import`'s own refusal text both tell the reader to fire
                    // a gouge plant HERE.
                    //
                    // stderr, so the JSON on stdout is untouched: gate `I1` compares
                    // stdout and no gate asserts this door's stderr is empty.
                    if let Some(w) =
                        gouge_warning(r.sim.gouge, &gouge_detail_from_first(r.sim.first.as_deref()))
                    {
                        eprintln!("{w}");
                    }
                    println!("{}", serde_json::to_string(&r).unwrap());
                    ExitCode::SUCCESS
                }
                None => {
                    eprintln!("unknown job '{name}'");
                    ExitCode::from(2)
                }
            }
        }
        "import" => {
            let Some(path) = args.get(1) else {
                eprintln!("import: file required");
                return ExitCode::from(2);
            };
            // 🔴 Read as BYTES, and let the CORE decide the format from the
            // CONTENT. Two reasons, and neither is style:
            //   - A binary STL is not text. `read_to_string` refuses it outright
            //     (and a host that replaced the undecodable bytes instead would
            //     hand the sectioner a mesh missing facets, which cuts an
            //     outline with a side missing and still looks like a part).
            //   - The extension is a claim made by whoever named the file. The
            //     specific case is a binary STL whose 80-byte header begins with
            //     the text `solid`; named `part.dxf` it would reach the DXF
            //     reader, yield an empty drawing, and read downstream exactly
            //     like a valid drawing with no features.
            // `--format` overrides for the rare file that needs it.
            let fmt = flag_value(&args, "--format").unwrap_or_else(|| "auto".into());
            let data = match std::fs::read(path) {
                Ok(t) => t,
                Err(e) => {
                    eprintln!("error: cannot read {path}: {e}");
                    return ExitCode::from(2);
                }
            };
            // The section Z for a mesh. ABSENT and UNPARSEABLE are different
            // answers: absent means "you did not choose one" and the core
            // sections at mid-height and says so, whereas `--z 9,5` is a typo
            // that must not silently become the same thing — that is how an
            // operator ends up believing they set a Z that was never read.
            let z_section_mm: Option<f64> = match flag_value(&args, "--z") {
                None => None,
                Some(s) => match s.parse::<f64>() {
                    Ok(v) if v.is_finite() => Some(v),
                    _ => {
                        eprintln!("error: --z '{s}' is not a number in millimetres");
                        return ExitCode::from(2);
                    }
                },
            };
            let cfg = match config_from(&args) {
                Ok(c) => c,
                Err(e) => return bad_invocation(e),
            };
            // 🔴 `--plant` on this path. It is REFUSED, never ignored — the
            // hole `SLICER-GATES.md` recorded against REL and TOOL, measured
            // again 2026-08-09: `import <dxf> --plant <anything>` exited 0 and
            // emitted a byte-identical program, so a negative control driven
            // this way would have run clean and read as a passing control.
            //
            // An UNKNOWN plant exits 2 exactly as `report` does, so a control
            // written against either path means the same thing. A KNOWN plant
            // also exits 2, and that is not the same defect wearing a new hat:
            // the import path in the core takes no plant argument at all
            // (`fixtures::plan_report_import_bytes*`), so there is nothing to
            // apply. Saying so is the refusal this lane's rules require —
            // "refuse rather than approximate" — and it names the core change
            // that would let the flag bite.
            if let Some(name) = flag_value(&args, "--plant") {
                if jobs::job_plant_from(&name).is_none() {
                    eprintln!("error: unknown job plant '{name}'. known:");
                    for (n, d) in jobs::JOB_PLANTS {
                        eprintln!("  {n:<16} {d}");
                    }
                    return ExitCode::from(2);
                }
                if name != "none" {
                    return bad_invocation(format!(
                        "'{name}' is a known job plant, but `import` cannot apply one: the core's \
                         import path (fixtures::plan_report_import_bytes) takes no plant \
                         argument, so accepting the flag here would report a defect that was \
                         never planted — a control that can never go red. Drive the plant through \
                         `report <job> --plant {name}`, or add the plant parameter to the core's \
                         import path first"
                    ));
                }
            }
            let cell = match sim_cell_from(&args) {
                Ok(v) => v,
                Err(e) => return bad_invocation(e),
            };
            let r = twobee_cam::fixtures::plan_report_import_bytes(
                &data,
                &fmt,
                z_section_mm,
                &cfg,
                cell,
            );
            // 🔴 THE GOUGE WARNING IS OUTSIDE THE `--json` BRANCH, and it was
            // inside it until 2026-08-27. `--json` is how a SCRIPT drives this
            // door, and a script is exactly the caller that greps `^warning:` —
            // so the one severity line was silenced for the reader most likely
            // to be keying off it, while the count survived in `sim.gouge`. The
            // sentence goes to stderr and the JSON to stdout, so nothing a
            // parser reads is disturbed.
            if let Some(w) = gouge_warning(r.sim.gouge, &gouge_detail_from_first(r.sim.first.as_deref())) {
                eprintln!("{w}");
            }
            if args.iter().any(|a| a == "--json") {
                println!("{}", serde_json::to_string(&r).unwrap());
            } else {
                // EVERY channel, from one place. See `report_channel_lines` for
                // the two this door used to drop and what that cost.
                for line in report_channel_lines(&r) {
                    eprintln!("{line}");
                }
                if let Some(w) =
                    unenforced_feed_limit(cfg.machine.as_ref().and_then(|m| m.max_feed_mm_min), &r.gcode)
                {
                    eprintln!("warning: {w}");
                }
                eprintln!(
                    "import: ok={} cut={:.0}mm deepest={:.2}mm gouge={} tabs={}",
                    r.ok, r.cutting_distance_mm, r.deepest_z_mm, r.sim.gouge, r.tab_lifts
                );
                if r.ok {
                    print!("{}", r.gcode);
                }
            }
            if r.ok { ExitCode::SUCCESS } else { ExitCode::from(1) }
        }
        // The gate reads its banned-word list FROM HERE rather than keeping its
        // own copy. Two lists drift, and the one that drifts is always the one
        // nobody is looking at.
        "dialect-rules" => {
            // 🔴 A TYPO USED TO ANSWER WITH THE CNC RULESET, AT EXIT 0.
            //
            // This was `_ => Cnc`, so `dialect-rules fmd`, `dialect-rules laser`
            // and a MISSING argument all returned the CNC banned-word list and
            // the CNC dialect facts — a wrong question answered confidently with
            // the rules for a different process. Found by gate TECH's own
            // downgrade on 2026-08-10, which could not go red for its headline
            // reason and went looking for one it could.
            //
            // The lane's rule is refuse rather than approximate: an un-postable
            // technology returns `None`, not a fallback. Same here — an
            // unrecognised name is NAMED and refused, and the absent argument is
            // a DIFFERENT fact from an unrecognised one, so it says so.
            let t = match args.get(1).map(String::as_str) {
                Some("cnc") | Some("CNC") => twobee_cam::tech::Technology::Cnc,
                Some("fdm") | Some("FDM") => twobee_cam::tech::Technology::Fdm,
                Some(other) => {
                    eprintln!(
                        "error: `dialect-rules` does not know the technology `{other}`. It was \
                         NOT answered with the CNC rules — a banned-word list for the wrong \
                         process is worse than no answer. Known: cnc, fdm"
                    );
                    std::process::exit(2);
                }
                None => {
                    eprintln!(
                        "error: `dialect-rules` needs a technology. Naming none is not the same \
                         as naming `cnc`, and it used to be answered as if it were. Known: cnc, fdm"
                    );
                    std::process::exit(2);
                }
            };
            println!(
                "{}",
                serde_json::json!({
                    "technology": t.as_str(),
                    "implemented": t.implemented(),
                    "has_post": twobee_cam::post::for_technology(t).is_some(),
                    "banned": t.banned_output()
                        .iter()
                        .map(|(w, why)| serde_json::json!({"pattern": w, "why": why}))
                        .collect::<Vec<_>>(),
                    "required": t.required_output(),
                })
            );
            ExitCode::SUCCESS
        }
        "nest-check" => {
            let (rot, dx, dy) = match (
                pos_num(&args, 1, "rotation in degrees", 0.0),
                pos_num(&args, 2, "dx in millimetres", 0.0),
                pos_num(&args, 3, "dy in millimetres", 0.0),
            ) {
                (Ok(r), Ok(x), Ok(y)) => (r, x, y),
                (Err(e), _, _) | (_, Err(e), _) | (_, _, Err(e)) => return bad_invocation(e),
            };
            match jobs::nest_check(rot, dx, dy) {
                Ok(m) => {
                    println!("{m}");
                    ExitCode::SUCCESS
                }
                Err(why) => {
                    eprintln!("error: {why}");
                    ExitCode::from(1)
                }
            }
        }
        "drill-check" => {
            // ABSENT and UNPARSEABLE both exit 2, but they are told apart in the
            // message: "you gave me nothing" and "I could not read what you
            // gave me" send the caller to two different places.
            let Some(s) = args.get(1) else {
                eprintln!("error: drill-check: a diameter in millimetres is required");
                return ExitCode::from(2);
            };
            let d = match s.parse::<f64>() {
                Ok(v) if v.is_finite() => v,
                _ => {
                    return bad_invocation(format!(
                        "drill-check: diameter '{s}' is not a finite number in millimetres"
                    ))
                }
            };
            match jobs::drill_check(d) {
                Ok(id) => {
                    println!("{id}");
                    ExitCode::SUCCESS
                }
                Err(why) => {
                    eprintln!("error: {why}");
                    ExitCode::from(1)
                }
            }
        }
        "fixture" => {
            let Some(name) = args.get(1) else {
                eprintln!("fixture: name required");
                return ExitCode::from(2);
            };
            run_fixture(name, &args)
        }
        "recommend" => run_recommend(&args),
        "route" => run_route(&args),
        "fit" => run_fit(&args),
        "layout" => run_layout(&args),
        "nest" => run_nest(&args),
        _ => {
            eprintln!("usage: 2bee-slice <fixture|fixtures|job|jobs|report|import|nest|recommend|route|fit|layout|version> [name] [flags]");
            eprintln!("  --plant <{}>", PLANTS.iter().map(|p| p.0).collect::<Vec<_>>().join("|"));
            eprintln!("  import <file> [--format dxf|svg|stl|obj|3mf|step|auto] [--z <mm>] [--config f] [--json]");
            eprintln!("  job <name> [--plant p] [--config f] [--sim-cell mm] [--no-probe]  — --config is APPLIED");
            eprintln!("  a flag a subcommand does not read is REFUSED (exit 2), never ignored");
            eprintln!("  --z is the SECTION Z for a mesh: an STL enters as one flat slice, not as 3D surfacing");
            eprintln!("  recommend <file>      which cutter per feature, with the REASON and every rejection");
            eprintln!("  route <job|file>      reorder the cuts; prints link travel WITH its basis");
            eprintln!("  fit <file>            already inside / shift by X,Y / will-not-fit + the axis");
            eprintln!("  nest [<file>] [--drawing <f> [--offset <dx>,<dy>] [--rot <deg>] [--id <s>]]… [--config f]");
            eprintln!("  nest EMITS a program from N placed drawings and REFUSES the workpiece with no");
            eprintln!("  G-code if any pair of parts shares material or is closer than the cutter.");
            eprintln!("  --offset is a DELTA from where the drawing was drawn (0,0 = as drawn);");
            eprintln!("  layout's --at is an ABSOLUTE corner position. Neither takes the other's flag.");
            eprintln!("  layout --drawing <f> --at <x>,<y> [--rot <deg>] [--id <s>] … --cutter <mm>");
            eprintln!("  --clearance-margin (clear MATERIAL between parts) and --travel-margin (standoff");
            eprintln!("  from the soft limits) are two different physical questions and two flags");
            eprintln!("  exit 0 = answered · 1 = REFUSED · 2 = bad invocation. None of THOSE FOUR emit");
            eprintln!("  G-code — recommend, route, fit and layout answer a question. `nest` DOES emit.");
            ExitCode::from(2)
        }
    }
}

/// The observable outcome of one `fixture` run — **the pair [`emit`] turns into
/// an exit code**, which is exactly what makes it the right thing for the plant
/// audit to compare two runs on.
///
/// 🔴 The same three observables `fixtures::PLANT_OBSERVABLES` names, for a host
/// that produces a [`twobee_cam::PostResult`] rather than a `Report`: is there a
/// program at all, and if so what does it say. There is no simulation on this
/// door, so there is no `verdict` limb — and no post-level plant declares one
/// (`PLANT_CONTRACTS` gives all six `refuses` or `program-differs`).
enum FixtureRun {
    /// The generator refused: exit 1, no program.
    Refused(String),
    Posted(twobee_cam::PostResult),
}

impl FixtureRun {
    fn fingerprint(&self) -> String {
        match self {
            FixtureRun::Refused(why) => format!("refused|{why}"),
            FixtureRun::Posted(r) => {
                format!("ok={}|errors={:?}|program={}", r.ok(), r.errors, r.gcode)
            }
        }
    }

    /// Did this run produce a program a sender could be handed? A refusal and a
    /// post that came back `!ok` are the same answer here — `emit` prints
    /// nothing on stdout for either.
    fn emitted(&self) -> bool {
        matches!(self, FixtureRun::Posted(r) if r.ok() && !r.gcode.is_empty())
    }

    fn program(&self) -> &str {
        match self {
            FixtureRun::Refused(_) => "",
            FixtureRun::Posted(r) => &r.gcode,
        }
    }
}

fn run_fixture(name: &str, args: &[String]) -> ExitCode {
    let plant_name = flag_value(args, "--plant").unwrap_or_else(|| "none".into());
    let Some(plant) = plant_from(&plant_name) else {
        eprintln!("unknown plant '{plant_name}'. known:");
        for (n, d) in PLANTS {
            eprintln!("  {n:<12} {d}");
        }
        return ExitCode::from(2);
    };

    let run = match plan_fixture(name, args, plant) {
        Err(e) => return bad_invocation(e),
        Ok(None) => {
            eprintln!("unknown fixture '{name}'. run `2bee-slice fixtures`");
            return ExitCode::from(2);
        }
        Ok(Some(r)) => r,
    };

    // 🔴 IS THE PLANT ACTUALLY IN FORCE? The same rule the `job` host applies
    // through `fixtures::plant_audit`, and it is here because this host has the
    // SAME defect, reached through a different door. Measured 2026-08-12:
    //
    //   fixture rect-profile --plant offbed                       -> exit 1
    //   fixture rect-profile --plant offbed --machine-x 5000 --machine-y 5000
    //                                                             -> exit 0, 959 bytes
    //
    // `offbed` shifts the part past the far edge of the X travel; widening the
    // travel puts it back on the bed. Gate G3's negative control, switched off
    // from the command line, emitting a program with nothing to say that the
    // defect it names is not in it. `--config` is not the mechanism here and
    // that is the point — **the mechanism is any setting applied after the
    // plant**, so the audit is over the plant's OWN EFFECT rather than over a
    // list of settings that could reach it.
    if plant != Plant::None {
        let clean = match plan_fixture(name, args, Plant::None) {
            Ok(Some(c)) => Some(c),
            // The clean twin cannot fail where the planted one succeeded — the
            // flags are identical — but if it ever does, that is PENDING and
            // PENDING refuses here for the same reason it does in the core.
            _ => None,
        };
        let key = twobee_cam::fixtures::PLANT_DISARMED_KEY;
        let inert = match &clean {
            Some(c) => c.fingerprint() == run.fingerprint(),
            None => true,
        };
        if inert {
            eprintln!(
                "refused: {name} — {key} — `--plant {plant_name}` announced itself and this run \
                 contains no trace of it: this invocation planned WITH the plant and WITHOUT it \
                 are IDENTICAL (same refusal, same program), so the defect the plant names is not \
                 in what would have been emitted. No program is emitted: a negative control that \
                 has been switched off is a FAILURE, not a footnote. DERIVED from the plant's own \
                 effect on this run — re-run it without the flags this invocation carries, or on \
                 the fixture `PLANT_CONTRACTS` declares it non-vacuous on"
            );
            return ExitCode::from(1);
        }
        // 🔴 AND THE HARDER HALF: it changed something, but is it still the
        // change the GATE reads? `--plant offbed --machine-x 5000` still moves
        // the part and no longer produces the travel refusal G3 watches for.
        // Asked only on the fixture the contract declares — off-target the
        // declared effect is the wrong question. `verdict_available: false`:
        // this door runs no simulation.
        if let (Some(c), Some(cl)) = (
            twobee_cam::fixtures::plant_contract(&plant_name).filter(|c| c.target == name),
            clean.as_ref(),
        ) {
            if let Err(why) = twobee_cam::fixtures::declared_effect_holds(
                c,
                run.emitted(),
                cl.emitted(),
                run.program() == cl.program(),
                false,
                true,
                // This fixture host reads no plan notes, so a `NoteDisappears`
                // contract is PENDING here rather than passed — which is the
                // arm's own rule, and the same one `verdict_available: false`
                // above already follows.
                None,
            ) {
                eprintln!(
                    "refused: {name} — {key} — {why}. The run is NOT inert, which is why nothing \
                     that merely asks \"did anything change?\" can see this. No program is \
                     emitted: a control watching for a consequence this run does not produce is \
                     switched off, whatever else the plant is doing"
                );
                return ExitCode::from(1);
            }
        }
    }

    match run {
        FixtureRun::Refused(why) => {
            eprintln!("refused: {name} — {why}");
            ExitCode::from(1)
        }
        FixtureRun::Posted(res) => emit(res),
    }
}

/// Plan one `fixture` run — **and nothing else**. No printing, no exit code.
///
/// 🔴 Split out of `run_fixture` in 2026-08-12 so the negative-control audit can
/// plan the SAME invocation with the plant and without it. A second copy of this
/// setup would let the audit check a run this host never makes, which is the
/// failure the audit exists to catch, one layer up.
///
/// `Err` is a bad invocation (exit 2), `Ok(None)` an unknown fixture name.
fn plan_fixture(name: &str, args: &[String], plant: Plant) -> Result<Option<FixtureRun>, String> {
    let mut machine = Machine {
        collet_mm: 6.0,
        probe_enabled: has_flag(args, "--probe"),
        ..Machine::default()
    };
    // 🔴 The SAME strict parse the engine commands use — see `apply_travel`.
    // This is where `--machine-x 60O` used to fall back to the 600mm default in
    // silence.
    apply_travel(args, &mut machine)?;
    let entry = entry_from(args)?;

    // 🔴 `--spoilboard-zero` IS A SETUP FACT, AND IT IS SET ON THE SETUP.
    //
    // It used to be `PostOptions::z_offset_mm = stock.thickness_mm` — a raw
    // millimetre shift handed to the post, sitting beside a `Stock` that still
    // said "top". The two could disagree, and every reader of the emitted
    // program (`check_hold_down` above all) read the `Stock` and got the wrong
    // answer. The flag always MEANT "this setup zeroes Z on the spoilboard";
    // now it says so, in the one place that answers it.
    let mut stock = Stock::default();
    if has_flag(args, "--spoilboard-zero") {
        stock.z_datum = ZDatum::SpoilboardTop;
    }
    let stock = stock;
    let tool = Tool {
        name: "End Mill - Down-cut 6mm 2F".into(),
        diameter_mm: 6.0,
        flutes: 2,
        shank_mm: 6.0,
        chipload_mm: 0.10,
        ..Tool::default()
    };

    let mut op = OperationParams { depth_total_mm: stock.thickness_mm, ..OperationParams::default() };
    if let Some(e) = entry {
        op.entry = e;
    }

    let mut job = RectJob {
        name: name.to_string(),
        tool: tool.clone(),
        stock: stock.clone(),
        plant,
        ..RectJob::default()
    };

    match name {
        "rect-profile" => {}
        "rect-arcs" => job.corner_r_mm = 8.0,
        "rect-inside" => {
            op.side = CutSide::Inside;
            job.op.side = CutSide::Inside;
        }
        "drill-peck" => {
            // Drilling is a different op; it does not go through rect_profile.
            // It also never READS `op.entry`, so accepting `--entry` here would
            // let an operator believe they had set a mode nothing consumed —
            // the same shape of defect as a flag that fails open.
            if entry.is_some() {
                return Err(
                    "--entry does not apply to `drill-peck`: a peck cycle has no entry mode, and \
                     accepting the flag would report a setting nothing reads"
                        .to_string(),
                );
            }
            return Ok(Some(plan_drill(&machine, &stock, &tool, &op, plant)));
        }
        _ => return Ok(None),
    }
    job.op = OperationParams { side: job.op.side, ..op.clone() };

    // The generator can REFUSE — an entry mode it does not implement is named,
    // not approximated. A refusal is exit 1 and NO G-code on stdout (gate G13's
    // property): a program that was refused must not be pipeable into a sender.
    let (path, program_name) = match build(&job) {
        Ok(v) => v,
        Err(why) => return Ok(Some(FixtureRun::Refused(why))),
    };

    let opts = PostOptions {
        program_name,
        emit_arcs: !args.iter().any(|a| a == "--no-arcs"),
        ..PostOptions::default()
    };

    Ok(Some(FixtureRun::Posted(post_grblhal(&path, &machine, &stock, &job.op, &opts))))
}

fn plan_drill(
    machine: &Machine,
    stock: &Stock,
    tool: &Tool,
    op: &OperationParams,
    plant: Plant,
) -> FixtureRun {
    use twobee_cam::{Move, Toolpath, Vec3};

    let feed = 600.0;
    let depth = -(op.depth_total_mm);
    let mut mv = vec![Move::comment("drill: 4x 6mm through, peck")];
    if plant != Plant::SpindleNeverOn {
        mv.push(Move::spindle_on(op.rpm));
    }
    for (x, y) in [(60.0, 60.0), (160.0, 60.0), (160.0, 120.0), (60.0, 120.0)] {
        mv.push(Move::drill(Vec3::new(x, y, depth), op.peck_depth_mm, feed));
    }
    mv.push(Move::spindle_off());

    let mut path = Toolpath { moves: mv, tool: tool.clone(), ..Default::default() };
    path.recompute_bounds();

    let opts = PostOptions { program_name: "drill-peck".into(), ..PostOptions::default() };
    FixtureRun::Posted(post_grblhal(&path, machine, stock, op, &opts))
}

/// EVERY channel a [`twobee_cam::fixtures::Report`] carries, as lines, in one
/// place.
///
/// 🔴 This function exists because `import` and `nest` each hand-rolled this
/// block and **both dropped the same two channels** — `warnings` and
/// `fixture_findings` — while `job` printed them. Measured 2026-08-10:
///
/// * `import <dxf> --config '{…"machine":{"spindle_max_rpm":9000}}'` emitted
///   `S18000` and said nothing, while the same over-speed reached `--json` as
///   `warnings: ["requested spindle speed exceeds the spindle's maximum"]` and
///   reached the operator on the `job` door and in the browser
///   (`web/src/App.tsx` renders `report.warnings`). Gate `SPIN` was green about
///   that warning through the `fixture` door the whole time.
/// * Worse: `import` with a clamp declared over the part exited **1** with
///   `ok=false` and **printed no reason at all** — `errors` and `refusals` were
///   both empty and all 26 findings, including `CutsClamp`, were in
///   `fixture_findings`. The one door a real drawing goes through refused a job
///   and did not say why.
///
/// So the lines are built HERE and printed by both callers. Two copies drift,
/// and the one that drifts is always the one nobody is looking at.
///
/// Severity ascends down the list so the worst thing sits closest to the
/// summary line the caller prints last.
fn report_channel_lines(r: &twobee_cam::fixtures::Report) -> Vec<String> {
    let mut out = Vec::with_capacity(
        r.notes.len()
            + r.warnings.len()
            + r.fixture_findings.len()
            + r.errors.len()
            + r.refusals.len(),
    );
    for n in &r.notes {
        out.push(format!("note: {n}"));
    }
    for w in &r.warnings {
        out.push(format!("warning: {w}"));
    }
    // Same prefix `job` uses, deliberately: an operator reading two doors must
    // not have to learn two vocabularies for the same fact.
    for f in &r.fixture_findings {
        out.push(format!("fixture: {f}"));
    }
    for e in &r.errors {
        out.push(format!("error: {e}"));
    }
    for x in &r.refusals {
        out.push(format!("refused: {x}"));
    }
    out
}

/// The highest feed word in an EMITTED program, **split by what the move is
/// for**: `(cutting, probing)`.
///
/// Read out of the program text, never off the settings that were supposed to
/// produce it — this lane's standing rule, and the reason the finding below was
/// invisible for so long: every consumer of `max_feed_mm_min` reads the plan.
///
/// Comments are stripped first. `( tool: End Mill - Down-cut 6mm 2F D6.00mm F2 )`
/// is a real line of our own output and `F2` in it is a FLUTE COUNT, not a feed.
///
/// 🔴 **The split is not a filter.** Dropping the probing feeds would trade one
/// invisible number for another — a `probe_seek_feed` declared at 5,000mm/min
/// would vanish from this report entirely. Both maxima are returned and the
/// caller says different things about them, because they are different facts.
/// The classification itself is [`twobee_cam::feeds::feed_role_of_line`], in the
/// CORE: *"a G38.2 is not a cut"* is a machining rule, and a host that
/// re-derived it would be the second copy.
fn max_feed_in_program(gcode: &str) -> (Option<f64>, Option<f64>) {
    let mut cutting: Option<f64> = None;
    let mut probing: Option<f64> = None;
    for line in gcode.lines() {
        // 🔴 THE CORE'S SCANNER, NOT A THIRD COPY. This hand-rolled its own
        // (`split_whitespace` + `strip_prefix('F')`) and was blind to BOTH
        // syntaxes the core reader was taught on 2026-08-28: `G1X1F5000` — no
        // token starts with `F` — and `F 5000` — the token is `"F"` and the rest
        // is empty. **This is the SAFETY reader**, feeding the feed-ceiling
        // backstop, so the miss here is physical rather than visual: a second
        // producer emitting either form got an over-ceiling cutting feed past
        // the check in silence while the browser's summary displayed it
        // correctly. It also split on `;` BEFORE handling parens, so a `;`
        // inside a `( … )` comment truncated the line and the two readers
        // answered differently for the same program.
        let bare = twobee_cam::feeds::strip_comments(line);
        // Classified on the COMMENT-STRIPPED line. `( G91 applies to G38.2 )` is
        // a real line of our own output, and a scanner that matched the text
        // discussing what it scans for would file a cutting move as a probe —
        // exempting the very thing the ceiling is meant to catch.
        let role = twobee_cam::feeds::feed_role_of_line(&bare);
        for v in twobee_cam::feeds::feed_words_on_line(&bare) {
            let slot = match role {
                twobee_cam::feeds::FeedRole::Cutting => &mut cutting,
                twobee_cam::feeds::FeedRole::Probing => &mut probing,
            };
            *slot = Some(slot.map_or(v, |m: f64| m.max(v)));
        }
    }
    (cutting, probing)
}

/// A backstop that reads the EMITTED program back against
/// `machine.max_feed_mm_min` — and reports **two different facts**, because
/// after 2026-08-11 there are two.
///
/// **Physical failure it guards:** the program commands a cutting feed the
/// machine cannot deliver. grblHAL clamps each axis to its own `$110–$112`
/// silently, so the chipload the plan was built from is not the chipload that
/// happens — the cutter rubs instead of cutting and burns the edge — and the
/// run-time estimate is wrong in the same breath.
///
/// # 🔴 What this block used to say, and why it is corrected rather than deleted
///
/// It read *"`machine.max_feed_mm_min` IS DECLARED AND NOT ENFORCED"*, *"only
/// the first exists today"*, and *"the clamp belongs in core/src/job.rs"*. **All
/// three were true when written and none of them is true now.** A comment that
/// overstates COVERAGE is the defect this lane keeps finding; a comment that
/// overstates EXPOSURE is the same defect mirrored, and it costs real hours —
/// nobody re-tests a blocker that names a reason.
///
/// The ceiling is now enforced **in the core**, on every door, at four points:
///
/// | what | where | how |
/// |---|---|---|
/// | derived feed, `tool_ids` door | `recommend::limits_for` | `feeds::resolve_feed` |
/// | derived feed, `tool_id` door | `job::plan_job` | `feeds::resolve_feed` |
/// | feed the operator typed | `job::plan_job` | `feeds::pinned_feed` — REFUSES |
/// | plunge (`op.plunge_mm_min`) | `job::plan_job` | `feeds::plunge_feed` — REFUSES |
///
/// A derived feed obeys the ceiling by taking the SPINDLE down so the chip is
/// unchanged; a typed feed and a plunge are **refused**, because reducing a
/// number somebody declared is overruling them silently.
///
/// # What is still uncovered, named so this does not read as complete
///
/// 1. 🔴 **The `fixture` door has no ceiling of any kind.**
///    `core/src/rect_profile.rs` is a fixture generator that never calls
///    `plan_job`, so `2bee-slice fixture <name>` emits whatever the RectJob
///    carries. That module's own header says it is *"not the CAM engine"*;
///    extending it would contradict its scope, so the gap is recorded here
///    rather than papered over.
/// 2. ⚠ **Probe feeds are EXEMPT from the cutting ceiling, by decision** — see
///    `feeds::FeedRole::Probing` for the three reasons. This function reports
///    them **separately and in different words**, so an intended exemption
///    cannot be read as a leak and a leak cannot hide behind the exemption.
/// 3. ~~*"Nothing checks the probe feeds against anything at all."*~~ **CLOSED
///    2026-08-11 and struck rather than deleted**, because a stale 🔴 lies
///    exactly like a stale ✅ and nobody re-tests a blocker that names a reason.
///    `post_grblhal::probe_feed_errors` now sits beside `probe_travel_errors`
///    and refuses on `feeds::probe_feed_faults` — the two feeds against **each
///    other** (the re-probe must be slower than the seek) and both against the
///    machine's **declared rapid rate**, with **no invented threshold**;
///    `ProbeFeedFault`'s header derives why there is no absolute probing ceiling
///    and why sourcing one would be the `touch_plate_mm` mistake again.
/// 4. 🔴 **NEW, found while closing 3 and named rather than left implicit: no
///    host can declare a probe feed at all.** `MachineCfg` carries no
///    `probe_seek_feed`/`probe_feed` and is `deny_unknown_fields`, so `--config`
///    REJECTS the whole file for naming one; there is no CLI flag; and the
///    browser sends `..Machine::default()`. Every reachable door therefore emits
///    the built-in 200/25, whose attribution to grblHAL
///    `docs/materials-research.md` §3.4 records as **UNVERIFIED**. That is safe
///    by absence, not by design — and it is the reason the check above cannot be
///    exercised through a real door today.
///
/// Silent when no limit was declared, and silent when nothing exceeds it: a
/// warning that is always on is a warning nobody reads.
fn unenforced_feed_limit(declared: Option<f64>, gcode: &str) -> Option<String> {
    let limit = declared.filter(|v| v.is_finite() && *v > 0.0)?;
    let (cutting, probing) = max_feed_in_program(gcode);
    let mut out: Vec<String> = Vec::new();

    // 🔴 A CUTTING feed over the ceiling should now be UNREACHABLE through
    // `job`, `import` and `nest`. This arm is kept armed anyway — it is the
    // backstop that would catch a fifth door arriving without the check, and a
    // control deleted because "the thing it watches for cannot happen" is a
    // control removed exactly when the codebase stops being the one that was
    // measured.
    if let Some(hi) = cutting.filter(|v| *v > limit) {
        out.push(format!(
            "this program commands F{hi:.1} on a CUTTING move and `machine.max_feed_mm_min` was \
             declared as {limit:.1}mm/min. 🔴 THAT SHOULD BE IMPOSSIBLE — the core enforces this \
             ceiling on every door (derived feeds via feeds::resolve_feed, typed feeds via \
             feeds::pinned_feed, plunges via feeds::plunge_feed), so a cutting feed above it \
             means a path reached the post WITHOUT going through core/src/job.rs::plan_job. \
             grblHAL will clamp each axis to its own $110-112 without saying so, which makes the \
             chipload the plan was built from and the run time it estimates both about a cut that \
             will not happen. Treat this as a DEFECT IN THE PLANNER, not as a setting to change"
        ));
    }

    // ⚠ ...and the exemption, said out loud. An exemption nobody can see is
    // indistinguishable from a leak, and these two were indistinguishable for
    // exactly as long as nobody printed the difference.
    if let Some(hi) = probing.filter(|v| *v > limit) {
        out.push(format!(
            "this program commands F{hi:.1} on a probing move and `machine.max_feed_mm_min` was \
             declared as {limit:.1}mm/min. This is NOT a leak and NOT a planner defect: {}",
            twobee_cam::feeds::FeedRole::Probing.why_exempt()
        ));
    }

    if out.is_empty() {
        None
    } else {
        Some(out.join(" || "))
    }
}

/// The one sentence this CLI says about a simulated gouge, on every door.
///
/// 🔴 ONE FUNCTION BECAUSE THERE ARE THREE DOORS AND THEY DISAGREED. `job`
/// gained this warning on 2026-08-27 and `import` and `nest` — **the two a real
/// user actually drives** — did not, so the same finding reached an operator at
/// two different severities depending on which subcommand they typed. That is
/// the shape of defect the `DOOR` gate exists for one layer down.
///
/// ⚠ IT IS A WARNING AND NOT A REFUSAL, DELIBERATELY, AND THE REASON TRAVELS
/// WITH THE TEXT. The height map counts GOUGES and is blind to material left
/// standing (`FUNCTIONAL-SPEC.md` H1), and `simulate_and_check` walks the
/// PLAN's arcs rather than the emitted chords, so a degraded-arc program that
/// cuts across its own bore reports `gouge=0`. A check with known blind spots
/// that REFUSES becomes a check people route around, and the route around it
/// removes the number as well as the block.
///
/// `detail` is whatever that door can say about HOW DEEP — the two questions
/// are different and only one of them is alarming: 2984 cells at 0.2mm is an
/// artefact of the cell size on a finish pass, one cell at 18mm is a cutter
/// through the part.
/// The `detail` for [`gouge_warning`] on a door that has only `SimCounts`.
///
/// 🔴 `SimCounts::first` IS THE FIRST FINDING OF ANY CLASS, NOT THE FIRST GOUGE.
/// `core/src/sim.rs` pushes `Spoilboard` before `Gouge`, so on a program that
/// both runs past the board edge and gouges, `first` is the spoilboard one —
/// and quoting it after the words "GOUGED CELL(S)" invites the operator to read
/// its `past_mm: 0.3` as the gouge depth. Measured 2026-08-27 by review, after
/// the warning had already been wired on two doors this way.
///
/// So the string is quoted ONLY when it is a gouge, and the count-only form of
/// the sentence is used otherwise. **Saying less is available; saying the wrong
/// depth is not.**
fn gouge_detail_from_first(first: Option<&str>) -> String {
    match first {
        Some(f) if f.trim_start().starts_with("Gouge") => format!(", first: {f}"),
        _ => String::new(),
    }
}

fn gouge_warning(gouge: usize, detail: &str) -> Option<String> {
    if gouge == 0 {
        return None;
    }
    Some(format!(
        "warning: THE SIMULATION FOUND {gouge} GOUGED CELL(S){detail} — this program removes \
         material the design says should stay. It is still emitted and the exit code is \
         unchanged: the height map counts gouges and is blind to material left standing, and it \
         walks the PLAN's arcs rather than the emitted chords, so refusing on it would be \
         refusing on a check with known blind spots. Nothing here has decided the part is scrap; \
         nothing here has decided it is not."
    ))
}

fn emit(res: twobee_cam::PostResult) -> ExitCode {
    for w in &res.warnings {
        eprintln!("warning: {w}");
    }
    for e in &res.errors {
        eprintln!("error: {e}");
    }
    if !res.ok() {
        // No G-code on stderr-clean failure. A file that cannot be run is worse
        // than no file: emitting it anyway is how a bad program reaches a
        // spindle because someone piped stdout and ignored the exit code.
        return ExitCode::from(1);
    }
    print!("{}", res.gcode);
    ExitCode::SUCCESS
}

fn run_job(name: &str, args: &[String]) -> ExitCode {
    // Every invocation error is decided BEFORE any work is reported. A bad
    // number found halfway down exits 2 after printing a summary, and a
    // half-printed report is the thing a reader trusts and a script greps.
    let cell = match sim_cell_from(args) {
        Ok(v) => v,
        Err(e) => return bad_invocation(e),
    };
    let plant_name = flag_value(args, "--plant").unwrap_or_else(|| "none".into());
    let Some(plant) = jobs::job_plant_from(&plant_name) else {
        eprintln!("unknown job plant '{plant_name}'. known:");
        for (n, d) in jobs::JOB_PLANTS {
            eprintln!("  {n:<16} {d}");
        }
        return ExitCode::from(2);
    };

    // 🔴 `--config` is HONOURED here, and until 2026-08-09 it was not: `run_job`
    // built no `JobConfig` at all, so `job plate --config <anything>` — including
    // a path that does not exist — emitted a byte-identical program and exited 0.
    // Every machine, workpiece, clamp, tool and op setting in the file was discarded
    // without a word, on the one host that prints the G-code an operator would
    // send to the machine.
    //
    // It goes through `JobConfig::apply`, which is the same call
    // `fixtures::plan_report_with_surface` makes for `report` — reused rather
    // than re-derived, because a second way to apply a config is a second place
    // for a safety setting to be dropped.
    let cfg = match config_from(args) {
        Ok(c) => c,
        Err(e) => return bad_invocation(e),
    };
    // 🔴 ONE recipe for "how this host prepares a run", used for the run itself
    // AND for the negative-control audit below. Written as one closure rather
    // than twice because the audit's whole value is that it compares the program
    // the operator is about to be handed against the same program without the
    // plant — including `--no-probe`, which is applied here and nowhere the core
    // can see. Two copies would let the audit drift into checking a job this
    // host never runs.
    let no_probe = args.iter().any(|a| a == "--no-probe");
    let prepare = |c: &jobs::JobConfig, p: jobs::JobPlant| -> Option<jobs::BuiltJob> {
        let mut b = jobs::build(name, p)?;
        c.apply(&mut b);
        // AFTER the config, deliberately: an explicit flag on the command line is
        // the more specific instruction and wins over the file. The reverse order
        // would let a config silently switch probing back on under a caller who
        // typed `--no-probe`.
        if no_probe {
            b.job.probe_after_toolchange = false;
        }
        Some(b)
    };
    let Some(built) = prepare(&cfg, plant) else {
        eprintln!("unknown job '{name}'. run `2bee-slice jobs`");
        return ExitCode::from(2);
    };

    // 🔴 IS THE PLANT ACTUALLY IN FORCE ON THIS RUN? `JobConfig::apply` runs
    // after `build` and overwrites the very fields the plants plant, so
    // `--plant cut-clamp --config '{"clamps":[]}'` used to exit 0 with a full
    // program under a `PLANTED: a clamp sitting on top of the part` note. A
    // negative control that has been switched off while still announcing itself
    // is a control reporting that it fired when it did not. `plant_audit`
    // decides from the plant's OWN EFFECT — this same run planned with and
    // without it — and returns `NotPlanted` immediately when no plant was asked
    // for, so a real job pays nothing.
    let bite = jobs::plant_audit(name, plant, &cfg, |c, p| {
        prepare(c, p).map(|b| twobee_cam::fixtures::report_of(&b, cell))
    });

    let r = jobs::run(&built);

    // The plant's own announcement, prefixed when it turned out not to be true.
    let mut notes: Vec<String> = built.notes.iter().chain(r.notes.iter()).cloned().collect();
    bite.rewrite_notes(&mut notes);
    for n in &notes {
        eprintln!("note: {n}");
    }
    for f in &r.fixture_findings {
        eprintln!("fixture: {f:?}");
    }
    for x in &r.refusals {
        eprintln!("refused: {} — {}", x.what, x.why);
    }
    if let Some(why) = bite.refusal() {
        eprintln!("refused: {name} — {why}");
    }

    eprintln!(
        "summary: tools={} changes={} cut={:.0}mm rapid={:.0}mm est={:.0}s deepest={:.2}mm",
        r.summary.tools_used.len(),
        r.summary.tool_changes,
        r.summary.cutting_distance_mm,
        r.summary.rapid_distance_mm,
        r.summary.estimated_seconds,
        r.summary.deepest_z_mm
    );

    // Simulation. Reported ALWAYS, not only on request: a verification that has
    // to be asked for is one that gets skipped on the day it would have mattered.
    // ONE implementation, in the core. This used to be a second copy of the
    // simulate-and-check logic and it carried the same datum defect the core
    // copy did — a second copy of a safety check is a second place to be wrong.
    // 🔴 THE WIDE DOOR, deliberately. `simulate_and_check` drops the coverage,
    // and its own header says so: *"this drops the coverage and therefore cannot
    // tell a measured 0 from an unasked one … anything that REPORTS a number to
    // a person must go through `simulate_and_check_with_coverage` instead."*
    // This function reports numbers to a person on every run.
    let (_hm, checked) =
        twobee_cam::fixtures::simulate_and_check_with_coverage(&built, &r.path, cell);
    let findings = &checked.findings;
    // Findings are summarised by kind. Printing 40,000 cells is the same as
    // printing nothing — nobody reads it and the one that matters is buried.
    let mut gouge = 0usize;
    let mut uncut = 0usize;
    for f in findings {
        match f {
            twobee_cam::sim::SimFinding::Gouge { .. } => gouge += 1,
            twobee_cam::sim::SimFinding::Uncut { .. } => uncut += 1,
            // Counted by CLASS — see `below_sheet_counts`, which is where the
            // arm that used to say `=> spoil += 1` now lives.
            twobee_cam::sim::SimFinding::Spoilboard { .. } => {}
        }
    }
    let below = below_sheet_counts(findings);
    eprintln!(
        "sim: cell={cell}mm gouge={gouge} uncut={uncut} spoilboard={} below_sheet={}",
        below.total(),
        below.as_line()
    );
    // 🔴 THE DEPTH LIMB, ON ITS OWN LINE AND UNDER ITS OWN KEYS.
    //
    // A separate line rather than more fields on `sim:` because the harness
    // reads `/spoilboard=(\d+)/` off that stream and a gate that anchors to the
    // end of it would silently start matching something else. And under its own
    // keys because it answers a DIFFERENT question from `below_sheet`: that one
    // is *"is there a board under this XY"*, this one is *"the board is under
    // here — did the cut go past its underside"*. A job can be over the board
    // with an unknown thickness, or past the edge with a known one, and folding
    // the two into one verdict hides half of each.
    //
    // ⚠ `board_depth=board-depth-unknown` is PENDING, never a pass:
    // `through_board=0` beside it means the question was not asked.
    eprintln!("sim board: {}", board_depth_line(&checked.board_depth));
    // The SENTENCE, not just the class — the same pairing the position limb has,
    // and for the same reason: a reader who sees three integers and no words can
    // read `0` as clean. Both halves exist because either alone can be missed —
    // the class by a human, the sentence by a gate.
    let board_name = built
        .job
        .machine
        .spoilboard
        .as_ref()
        .map(|b| b.name.clone())
        .unwrap_or_else(|| "(none declared)".to_string());
    if let Some(note) = checked.board_depth.through_note(&board_name) {
        eprintln!("sim board: {note}");
    }
    if let Some(why) = checked.board_depth.why_not() {
        eprintln!("sim board: THROUGH-THE-BOARD NOT CHECKED ON THIS JOB — {why}.");
    }
    if let Some(f) = findings.first() {
        eprintln!("sim first finding: {f:?}");
    }

    // ── A GOUGE IS A WARNING, AND IT WAS NOT ONE UNTIL 2026-08-27 ───────────
    //
    // 🔴 `job plate --plant gouge` printed `sim: … gouge=2984`, a first finding
    // 18mm deep, EXIT 0, and the whole program on stdout — with no `warning:`
    // and no `error:` anywhere. Two channels carried the fact and neither used
    // the words this CLI reserves for severity, so a caller that greps for
    // `^warning:` or reads the exit code saw a clean run. The standing test for
    // this lane is *would you stand next to the machine while this program
    // runs?*, and nothing on that path made a person answer it.
    //
    // ⚠ IT IS A WARNING AND NOT A REFUSAL, DELIBERATELY, AND THE REASON IS IN
    // THE SENTENCE RATHER THAN LEFT TO BE INFERRED. The height map has named
    // blind spots — it counts GOUGES and is blind to material left standing
    // (`FUNCTIONAL-SPEC.md` H1), and `simulate_and_check` walks the PLAN's arcs,
    // so a degraded-arc program cutting chords reports `gouge=0`. A check with
    // known blind spots that REFUSES becomes a check people route around, and
    // the route around it is `--no-sim`-shaped: it removes the number as well as
    // the block. So the program still posts and the exit code is unchanged —
    // what changes is that the finding now says so in the CLI's own vocabulary.
    //
    // The depth is printed with the count because they are different questions:
    // 2984 cells at 0.2mm is a finish-pass artefact of the cell size, and one
    // cell at 18mm is a cutter through the part.
    if gouge > 0 {
        let deepest = findings
            .iter()
            .filter_map(|f| match f {
                twobee_cam::sim::SimFinding::Gouge { depth_mm, .. } => Some(*depth_mm),
                _ => None,
            })
            .fold(0.0f64, f64::max);
        if let Some(w) = gouge_warning(gouge, &format!(", DEEPEST {deepest:.2}mm")) {
            eprintln!("{w}");
        }
    }


    // Tab audit. Reported as a count so a gate can assert on it without
    // re-deriving the geometry.
    let tabs = count_tab_lifts(&r.path);
    eprintln!("tabs: lifts={tabs}");
    eprintln!("dogbones: {}", built.dogbones.len());
    // The DESIGN floor for the removed region, reported so a gate can compare
    // the emitted program against the part rather than against a number copied
    // into the gate — a copy drifts silently the day the fixture changes.
    eprintln!("removal: design_depth={:.3}mm", built.remove_depth_mm);

    // 🔴 A DISARMED PLANT REFUSES, on the same terms as any other refusal: exit
    // 1 and NOTHING on stdout. The alternative — a loud note above a program
    // that still posts — leaves a control that merely admits it is switched off,
    // and every gate reading this run would inherit the claim that it fired.
    if !r.is_runnable() || bite.refusal().is_some() {
        return ExitCode::from(1);
    }

    let opts = PostOptions { program_name: name.to_string(), ..PostOptions::default() };
    let post = post_grblhal(
        &r.path,
        &built.job.machine,
        &built.job.stock,
        &OperationParams::default(),
        &opts,
    );
    // Same report on this door as on `import`/`nest`, for the same reason the
    // channels above are shared: one job through two doors must not tell an
    // operator two different things.
    if let Some(w) =
        unenforced_feed_limit(cfg.machine.as_ref().and_then(|m| m.max_feed_mm_min), &post.gcode)
    {
        eprintln!("warning: {w}");
    }
    emit(post)
}

/// Cells that went below the underside of the workpiece, **split by what was
/// underneath** — [`twobee_cam::sim::BelowSheet`].
///
/// # 🔴 One number for two physical events, until 2026-08-10
///
/// The core gained the distinction in `a4e109eb30` and this file did not read
/// it: the summary printed a single `spoilboard=N`, so **a sacrificial
/// through-cut over the board and a 2.2 kW spindle driving a cutter into the
/// machine's own frame printed identically** — same word, same count. A finding
/// that cannot tell those apart is one an operator learns to wave through,
/// because most of the time it is the harmless one, and the CLI is the binary
/// every gate drives.
///
/// ⚠ **`SpoilboardUndeclared` is not a midpoint between the other two.** It is
/// the absence of an answer — the depth was measured and the position was not —
/// and it must read as UNCHECKED, never as either verdict. That is why it is
/// printed as its own count under its own name rather than folded in with the
/// harmless class.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct BelowSheetCounts {
    over: usize,
    past_edge: usize,
    undeclared: usize,
}

impl BelowSheetCounts {
    /// Every cell below the underside, whatever was under it. This is the number
    /// the line has always printed as `spoilboard=`.
    fn total(&self) -> usize {
        self.over + self.past_edge + self.undeclared
    }

    /// The classes, keyed by the CORE's own names ([`twobee_cam::sim::BelowSheet::as_str`]).
    ///
    /// 🔴 The separator is a COLON, not `=`, and that is not a style choice.
    /// The harness reads `/spoilboard=(\d+)/` off this stream; a class printed
    /// as `over-spoilboard=3` would contain the literal `spoilboard=3` and any
    /// such regex could bind to the wrong number the day the fields are
    /// reordered. `over-spoilboard:3` cannot alias it at all. The total keeps
    /// its historical key and its historical position, first on the line.
    fn as_line(&self) -> String {
        use twobee_cam::sim::BelowSheet::*;
        format!(
            "{}:{} {}:{} {}:{}",
            OverSpoilboard.as_str(),
            self.over,
            PastSpoilboardEdge.as_str(),
            self.past_edge,
            SpoilboardUndeclared.as_str(),
            self.undeclared
        )
    }
}

/// The one match arm that reads `below`. Split out of `run_job` so it can be
/// asserted on directly: the old counter is one edit away (add the three
/// together and print the sum), and a control has to be able to make that edit
/// go red.
fn below_sheet_counts(findings: &[twobee_cam::sim::SimFinding]) -> BelowSheetCounts {
    use twobee_cam::sim::{BelowSheet, SimFinding};
    let mut c = BelowSheetCounts::default();
    for f in findings {
        let SimFinding::Spoilboard { below, .. } = f else { continue };
        match below {
            BelowSheet::OverSpoilboard => c.over += 1,
            BelowSheet::PastSpoilboardEdge => c.past_edge += 1,
            BelowSheet::SpoilboardUndeclared => c.undeclared += 1,
        }
    }
    c
}

/// The DEPTH limb's line — *"the board is under here; did the cut go past its
/// underside?"*
///
/// Split out of `run_job` for the same reason [`below_sheet_counts`] was: the
/// dangerous edit is one line long — print the count and drop the class — and a
/// control has to be able to make that edit go red.
///
/// 🔴 **`board_depth=board-depth-unknown` is PENDING and `through_board=0`
/// beside it is NOT a pass.** The two are printed together precisely so neither
/// can be read alone: an integer cannot say "nobody asked", and this is the
/// third counter in this codebase to need a companion for that reason.
///
/// ⚠ **Keys are chosen so nothing here can alias the historical `spoilboard=`.**
/// The gate harness reads `/spoilboard=(\d+)/` off this stream; `board_depth=`
/// and `through_board=` share no substring with it, and the class VALUES
/// (`through-board`, `inside-board`, `board-depth-unknown`) contain no `=` at
/// all. This line is also emitted separately from `sim:` rather than appended to
/// it, so a gate anchored to the end of that line keeps matching what it always
/// matched.
fn board_depth_line(d: &twobee_cam::sim::SpoilboardDepth) -> String {
    format!(
        "board_depth={} through_board={} tested={} thickness={} deepest_past={:.3}mm",
        d.verdict().as_str(),
        d.cells_through_board,
        d.cells_tested,
        match d.declared_thickness_mm {
            Some(t) => format!("{t}mm"),
            None => "undeclared".to_string(),
        },
        d.deepest_past_underside_mm
    )
}

/// Count TABS in the emitted path.
///
/// 🔴 The obvious metric — "moves above the deepest Z" — does not measure tabs.
/// It measures depth passes, because every pass above the last one is also
/// above the deepest Z. With tabs deliberately disabled it read 64 against a
/// baseline of 65: a plant that changed nothing observable, which would have
/// let gate P1 pass on a program with no tabs at all.
///
/// A tab is a LOCAL excursion: the tool is cutting at final depth, rises, and
/// comes back down to final depth. That shape is what is counted here.
fn count_tab_lifts(path: &twobee_cam::Toolpath) -> usize {
    use twobee_cam::MoveKind;
    let cutting: Vec<f64> = path
        .moves
        .iter()
        .filter(|m| matches!(m.kind, MoveKind::Feed | MoveKind::ArcCW | MoveKind::ArcCCW))
        .map(|m| m.to.z)
        .collect();
    let deepest = cutting.iter().cloned().fold(f64::INFINITY, f64::min);
    if !deepest.is_finite() {
        return 0;
    }
    let at_depth = |z: f64| (z - deepest).abs() < 1e-6;
    let lifted = |z: f64| z > deepest + 0.5 && z < -1e-6;

    let mut tabs = 0usize;
    let mut i = 0usize;
    while i < cutting.len() {
        if at_depth(cutting[i]) {
            // Walk forward over a contiguous lift and require a return to depth.
            let mut j = i + 1;
            while j < cutting.len() && lifted(cutting[j]) {
                j += 1;
            }
            if j > i + 1 && j < cutting.len() && at_depth(cutting[j]) {
                tabs += 1;
                i = j;
                continue;
            }
        }
        i += 1;
    }
    tabs
}

// ===========================================================================
//  recommend — which cutter per feature, and WHY
// ===========================================================================

/// What a recommendation CANNOT tell you.
///
/// Carried to the operator rather than left in `recommend.rs`'s doc comment. A
/// caveat that only exists in the source is a caveat only the person who does
/// not need it will read.
const RECOMMEND_CAVEATS: &[&str] = &[
    "every feature here is priced as a THROUGH cut at the workpiece thickness. A pocket with a floor \
     is a different depth and therefore possibly a different tool — this command was not asked \
     about it",
    "it does not order the operations, does not assign operations to features, and does not decide \
     pocket-vs-cutout for an ambiguous inner loop. It answers 'which tool, and why' and stops",
    "sharp internal corners are REPORTED, not capped. A round tool cuts that pocket correctly and \
     leaves a fillet of its own radius in each corner — 'leaves a fillet' and 'cuts it square' are \
     different facts, and a square mating part cares which one happened",
    "an UNDECLARED collet is unchecked, not passed. Pass --collet <mm> (and --spare-collet <mm>) to \
     turn the shank rule from a report into a check",
    "the candidates are this core's BUILT-IN LIBRARY, not the contents of your drawer. A tool you own \
     and it does not know cannot win, and a tool it knows and you do not own can",
];

/// Which numbered rule a rejection is, for grouping.
///
/// 🔴 The grouping exists because printing 46 sentences per feature across 22
/// features is the same as printing nothing — nobody reads it and the one that
/// matters is buried, which is the reasoning `run_job` already applies to sim
/// findings. **Nothing is dropped**: every rejected tool is still named, still
/// under the rule it broke, one worked example per rule keeps the arithmetic on
/// screen, and `--all-rejections` (and `--json`, always) gives every sentence.
fn reject_rule(r: &twobee_cam::recommend::RejectReason) -> &'static str {
    use twobee_cam::recommend::RejectReason as R;
    match r {
        R::InvalidTool { .. } => "the tool definition is invalid",
        R::WrongCategory { .. } => "wrong category — this tool cannot perform this operation",
        R::MachineCannotHoldIt { .. } => "rule 4 — the machine cannot hold it",
        R::InternalRadiusTooSmall { .. } => "rule 1 — tighter internal radius than the tool's own",
        R::LargerThanTheHole { .. } => "rule 1 — larger than the hole",
        R::WillNotFitInside { .. } => "rule 1 — does not fit inside the loop",
        R::TooShortToReach { .. } => "rule 3 — too short to reach the depth",
        R::NotAnExactDrill { .. } => "rule 2 — not an exact-diameter drill, and never rounded",
        R::MaterialRpmFloorAboveCap { .. } => "rule 5 — material rpm cap below the tool's floor",
        // ⚠ Added by the core change that made the feed ceiling hold the chip
        // instead of thinning it. This arm is the COMPILER-FORCED half of a new
        // `RejectReason` variant — an exhaustive match in this crate cannot
        // build without it — and nothing else in `cli/` was touched.
        R::NoSpeedHoldsTheChip { .. } => {
            "rule 7 — no spindle speed both obeys the feed ceiling and holds the chip"
        }
    }
}

fn shank_words(fit: &ShankFit) -> (&'static str, String) {
    match fit {
        ShankFit::Fitted => ("fitted", "runs with the collet already in the spindle".into()),
        ShankFit::NeedsCollet { .. } => ("needs_collet", fit.why()),
        ShankFit::None { .. } => ("none", fit.why()),
        ShankFit::Undeclared => ("undeclared", fit.why()),
    }
}

fn run_recommend(args: &[String]) -> ExitCode {
    let Some(path) = args.get(1).filter(|a| !a.starts_with("--")) else {
        return bad_invocation("recommend: a drawing file is required");
    };

    let machine = match machine_from(args) {
        Ok(m) => m,
        Err(e) => return bad_invocation(e),
    };
    let stock = match stock_from(args) {
        Ok(s) => s,
        Err(e) => return bad_invocation(e),
    };
    let material = match material_from(args) {
        Ok(m) => m,
        Err(e) => return bad_invocation(e),
    };
    let z = match num_flag(args, "--z") {
        Ok(v) => v,
        Err(e) => return bad_invocation(e),
    };
    let drill_tol = match num_flag(args, "--drill-tolerance") {
        Ok(v) => v,
        Err(e) => return bad_invocation(e),
    };
    let fmt = flag_value(args, "--format").unwrap_or_else(|| "auto".into());

    let mut opts = RecommendOptions::default();
    // The negative control for rule 6, exposed on purpose: it shows what the
    // preference actually bought instead of asserting it bought something.
    if has_flag(args, "--no-prefer-fewer-tools") {
        opts.prefer_fewer_tool_changes = false;
    }
    if let Some(t) = drill_tol {
        opts.drill_tolerance_mm = t;
    }

    let drawing = match load_drawing(path, &fmt, z, stock.size_y_mm, &label_for(path)) {
        Ok(d) => d,
        Err(e) => return e.report(),
    };

    let library = default_library();
    /* 🔴 `--depth` TURNS AN ASSUMPTION INTO A DECLARATION, which is the same
     * move `--collet` already makes for the shank rule ("pass --collet <mm> to
     * turn the shank rule from a report into a check"). A DXF carries no Z, so
     * without it every feature is priced as a through cut at stock thickness —
     * stated AT the number now, not only in the footer. */
    let declared_depth = flag_value(args, "--depth").and_then(|v| v.parse::<f64>().ok());
    let features: Vec<Feature> = match declared_depth {
        Some(d) => drawing
            .parts
            .iter()
            .flat_map(|p| Feature::from_part_at(p, d, DepthSource::Declared))
            .collect(),
        None => drawing.parts.iter().flat_map(|p| Feature::from_part(p, &stock)).collect(),
    };
    let rec = recommend(&features, &machine, &stock, material, library.as_slice(), &opts);

    if has_flag(args, "--json") {
        let choices: Vec<serde_json::Value> = rec
            .choices
            .iter()
            .map(|c| {
                let (fit_kind, fit_why) = match &c.shank_fit {
                    Some(f) => {
                        let (k, w) = shank_words(f);
                        (Some(k), Some(w))
                    }
                    None => (None, None),
                };
                serde_json::json!({
                    "feature": c.feature_id,
                    "kind": c.kind.as_str(),
                    "depth_mm": c.depth_mm,
                    "tool": c.tool_id,
                    "satisfied": c.is_satisfied(),
                    "reason": c.reason,
                    "runner_up": c.alternatives.first(),
                    "alternatives": c.alternatives,
                    "rejected": c.rejected.iter().map(|r| serde_json::json!({
                        "tool": r.tool_id,
                        "rule_broken": r.reason.why(),
                        "sentence": r.sentence(),
                    })).collect::<Vec<_>>(),
                    "shank_fit": fit_kind,
                    "shank_fit_why": fit_why,
                    "limits": c.limits.map(|l| serde_json::json!({
                        "rpm": l.rpm,
                        "feed_mm_min": l.feed_mm_min,
                        "depth_per_pass_mm": l.depth_per_pass_mm,
                        "passes": l.passes,
                    })),
                    "geometry": {
                        "min_internal_radius_mm": c.geometry.min_internal_radius_mm,
                        "sharp_internal_corners": c.geometry.sharp_internal_corners,
                    },
                    "notes": c.notes,
                })
            })
            .collect();
        println!(
            "{}",
            serde_json::to_string(&serde_json::json!({
                "drawing": path,
                "format_requested": fmt,
                "material": material.as_str(),
                "stock_thickness_mm": stock.thickness_mm,
                "machine": {
                    "travel_x_mm": machine.travel_x_mm,
                    "travel_y_mm": machine.travel_y_mm,
                    "collet_mm": machine.collet_mm,
                    "spare_collets_mm": machine.spare_collets_mm,
                },
                "prefer_fewer_tool_changes": opts.prefer_fewer_tool_changes,
                "drill_tolerance_mm": opts.drill_tolerance_mm,
                "library_size": library.len(),
                "parts": drawing.parts.len(),
                "features": features.len(),
                "complete": rec.is_complete(),
                "tool_set": rec.tool_set,
                "tool_changes": rec.tool_changes(),
                "unsatisfied": rec.unsatisfied,
                "notes": rec.notes,
                "choices": choices,
                "cannot_tell_you": RECOMMEND_CAVEATS,
            }))
            .unwrap()
        );
    } else {
        drawing.print_intake();
        println!(
            "recommend: {} — {} part(s), {} feature(s), {} at {}mm thick, against {} tool(s) in the built-in library",
            path,
            drawing.parts.len(),
            features.len(),
            material.as_str(),
            stock.thickness_mm,
            library.len()
        );
        println!();
        for c in &rec.choices {
            /* The assumption rides BESIDE the number. It used to live only in
             * the caveat block at the foot of the output, and a reader acted on
             * "18.000mm deep" as a measured fact while having read the caveat. */
            match c.depth {
                DepthSource::Declared => println!(
                    "feature {} ({}, {:.3}mm deep — declared)",
                    c.feature_id,
                    c.kind.as_str(),
                    c.depth_mm
                ),
                DepthSource::AssumedThroughStock => println!(
                    "feature {} ({}, {:.3}mm deep — 🔴 {})",
                    c.feature_id,
                    c.kind.as_str(),
                    c.depth_mm,
                    DepthSource::AssumedThroughStock.note()
                ),
            }
            match &c.tool_id {
                Some(t) => println!("  TOOL     {t}"),
                None => println!("  TOOL     NONE — this feature has no tool in this library"),
            }
            println!("  REASON   {}", c.reason);
            if let Some(l) = c.limits {
                println!(
                    "  limits   {}rpm, {:.1}mm/min, {:.2}mm per pass, {} pass(es)",
                    l.rpm, l.feed_mm_min, l.depth_per_pass_mm, l.passes
                );
            }
            if let Some(f) = &c.shank_fit {
                let (k, w) = shank_words(f);
                println!("  shank    {k}{}", if w.is_empty() { String::new() } else { format!(" — {w}") });
            }
            match c.geometry.min_internal_radius_mm {
                Some(r) => println!(
                    "  geometry tightest internal radius {r:.3}mm, {} sharp internal corner(s)",
                    c.geometry.sharp_internal_corners
                ),
                None => println!(
                    "  geometry no internal radius caps this feature, {} sharp internal corner(s)",
                    c.geometry.sharp_internal_corners
                ),
            }
            if let Some(r) = c.alternatives.first() {
                println!("  runner-up {r}");
                if c.alternatives.len() > 1 {
                    println!("  also ok  {}", c.alternatives[1..].join(", "));
                }
            }
            // 🔴 The rejections are the half that makes the winner checkable.
            // A bare tool name looks like a decision somebody made.
            //
            // A feature with NO tool gets every sentence in full whatever was
            // asked for: that is the case where each individual rule is the
            // answer, and summarising it would summarise away the finding.
            let full = has_flag(args, "--all-rejections") || !c.is_satisfied();
            if full {
                println!("  rejected {} tool(s):", c.rejected.len());
                for r in &c.rejected {
                    println!("    - {}", r.sentence());
                }
            } else {
                let mut rules: Vec<(&'static str, Vec<&twobee_cam::recommend::Rejection>)> =
                    Vec::new();
                for r in &c.rejected {
                    let k = reject_rule(&r.reason);
                    match rules.iter_mut().find(|(n, _)| *n == k) {
                        Some((_, v)) => v.push(r),
                        None => rules.push((k, vec![r])),
                    }
                }
                println!(
                    "  rejected {} tool(s), by the rule each broke ({} rule(s); --all-rejections \
                     for every sentence):",
                    c.rejected.len(),
                    rules.len()
                );
                for (rule, rs) in &rules {
                    println!(
                        "    {rule} ({}): {}",
                        rs.len(),
                        rs.iter().map(|r| r.tool_id.as_str()).collect::<Vec<_>>().join(", ")
                    );
                    // One worked example keeps the arithmetic on screen rather
                    // than only the conclusion.
                    println!("      e.g. {}", rs[0].sentence());
                }
            }
            for n in &c.notes {
                println!("  note     {n}");
            }
            println!();
        }
        println!(
            "tool set ({}, {} change(s)): {}",
            rec.tool_set.len(),
            rec.tool_changes(),
            if rec.tool_set.is_empty() { "—".into() } else { rec.tool_set.join(" -> ") }
        );
        for n in &rec.notes {
            println!("note: {n}");
        }
        if !rec.unsatisfied.is_empty() {
            println!("UNSATISFIED: {}", rec.unsatisfied.join(", "));
        }
        println!();
        println!("what this CANNOT tell you:");
        for c in RECOMMEND_CAVEATS {
            println!("  - {c}");
        }
    }

    if rec.is_complete() {
        ExitCode::SUCCESS
    } else {
        // A feature with no tool means the job cannot be cut as drawn. That is a
        // refusal, and a refusal exits non-zero whatever else was printed.
        ExitCode::from(1)
    }
}

// ===========================================================================
//  route — reorder the cuts, and report the travel WITH its basis
// ===========================================================================

fn run_route(args: &[String]) -> ExitCode {
    let Some(target) = args.get(1).filter(|a| !a.starts_with("--")) else {
        return bad_invocation("route: a job name or a drawing file is required");
    };

    let stock = match stock_from(args) {
        Ok(s) => s,
        Err(e) => return bad_invocation(e),
    };
    let z = match num_flag(args, "--z") {
        Ok(v) => v,
        Err(e) => return bad_invocation(e),
    };
    let depth_per_pass = match num_flag_or(args, "--depth-per-pass", 4.0) {
        Ok(v) => v,
        Err(e) => return bad_invocation(e),
    };
    let fmt = flag_value(args, "--format").unwrap_or_else(|| "auto".into());

    // 🔴 Which artefact was measured, decided by ONE rule and PRINTED. A true
    // report about the wrong artefact reads exactly like a finding.
    let (ops, source) = if std::path::Path::new(target).exists() {
        // 🔴 `--plant` reaches nothing on the drawing branch — a drawing is not
        // a reference job and has no plant registry — so it is refused rather
        // than read past. The two branches of this command take two different
        // flag sets, and a flag that belongs to the OTHER branch is exactly as
        // silent as one that belongs to no branch at all.
        if let Some(p) = flag_value(args, "--plant") {
            return bad_invocation(format!(
                "--plant '{p}' does not apply when the target is a DRAWING ({target}): plants are \
                 defects planted into a reference JOB, and this branch builds operations from a \
                 file. Run `2bee-slice route <job> --plant {p}` for the planted job"
            ));
        }
        let spec = match tool_from(args) {
            Ok(t) => t,
            Err(e) => return bad_invocation(e),
        };
        let drawing = match load_drawing(target, &fmt, z, stock.size_y_mm, &label_for(target)) {
            Ok(d) => d,
            Err(e) => return e.report(),
        };
        drawing.print_intake();
        let params = OperationParams {
            depth_total_mm: stock.thickness_mm,
            depth_per_pass_mm: depth_per_pass,
            ..OperationParams::default()
        };
        let ops: Vec<Operation> = drawing
            .parts
            .iter()
            .flat_map(|p| operations_for_part(p, &spec.tool, &params))
            .collect();
        (ops, format!("drawing `{target}` cut with `{}`", spec.id))
    } else {
        // The mirror of the drawing branch: a reference job's operations come
        // with their tools already attached, so `--tool` selects nothing here.
        if let Some(t) = flag_value(args, "--tool") {
            return bad_invocation(format!(
                "--tool '{t}' does not apply when the target is a JOB ('{target}'): a reference \
                 job's operations carry the cutters the job builds them with, and nothing here \
                 would read this id. Pass a drawing file to route it with a chosen tool"
            ));
        }
        let plant_name = flag_value(args, "--plant").unwrap_or_else(|| "none".into());
        let Some(plant) = jobs::job_plant_from(&plant_name) else {
            return bad_invocation(format!("unknown job plant '{plant_name}'"));
        };
        let Some(built) = jobs::build(target, plant) else {
            return bad_invocation(format!(
                "'{target}' is neither a file on disk nor a known job. run `2bee-slice jobs`"
            ));
        };
        for n in &built.notes {
            eprintln!("note: {n}");
        }
        (built.job.operations, format!("job `{target}` (plant {plant_name})"))
    };

    if ops.is_empty() {
        eprintln!("refused: {source} produced no operations — there is nothing to route");
        return ExitCode::from(1);
    }

    let names_before: Vec<String> = ops.iter().map(|o| o.name.clone()).collect();
    let (routed, r) = optimise_route(ops);
    let names_after: Vec<String> = routed.iter().map(|o| o.name.clone()).collect();

    // ⚠ The travel number is meaningless without this. It is printed WITH the
    // figure and never after it, so a number cannot be copied out alone.
    let mut basis: Vec<String> = vec![
        format!(
            "from_emitted_program = {} — this is PLAN-side link travel between operation anchors, \
             NOT the emitted program's rapid distance (`2bee-slice job` reports that one, and it \
             is a different, larger number)",
            r.basis.from_emitted_program
        ),
        format!(
            "inter_operation_only = {} — rapid INSIDE an operation (lead-ins, tab lifts, \
             pass-to-pass returns) is not counted; reordering does not change it",
            r.basis.inter_operation_only
        ),
        format!("xy_only = {} — Z is not counted; every link retracts and plunges the same", r.basis.xy_only),
        format!(
            "before_is_tool_grouped = {} — the 'before' figure is measured on the input ALREADY \
             GROUPED BY TOOL, because job.rs groups it downstream whether this module runs or not. \
             Measuring against the raw input would credit this module with the grouping's saving",
            r.basis.before_is_tool_grouped
        ),
        format!(
            "anchored_on_unoffset_contour = {} operation(s) — their anchor is the contour's first \
             vertex, not where the tool actually enters, so those links are out by up to one tool \
             radius at each end",
            r.basis.anchored_on_unoffset_contour
        ),
    ];
    for b in &r.basis.blind_spots {
        basis.push(format!("blind spot: {b}"));
    }

    if has_flag(args, "--json") {
        println!(
            "{}",
            serde_json::to_string(&serde_json::json!({
                "source": source,
                "method": r.method,
                "operations": r.operations,
                "tool_groups": r.tool_groups,
                "tool_changes_before": r.tool_changes_before,
                "tool_changes_after": r.tool_changes_after,
                "tools_used": names_tools(&routed),
                "reordered": r.reordered,
                "moved_operations": r.moved_operations,
                "link_travel_before_mm": r.link_travel_before_mm,
                "link_travel_after_mm": r.link_travel_after_mm,
                "reduction_mm": r.reduction_mm(),
                "reduction_pct": r.reduction_pct(),
                "segments_considered": r.segments_considered,
                "two_opt_passes": r.two_opt_passes,
                "two_opt_skipped": r.two_opt_skipped,
                "pinned": r.pinned,
                // 🔴 `RouteReport::refusals` is documented FATAL in the core —
                // "a part that is still worked on after the operation that
                // releases it" — and until 2026-08-10 this door printed it
                // NOWHERE: it was absent from these keys and from the human
                // output below, while the two adjacent, lesser channels
                // (`warnings`, `notes`) were printed in both. `job` sees these
                // (`job::report_route` turns each into a `Refusal` that stops
                // the program existing); the advisory door reported a tidy
                // reordering and exited 0.
                "refusals": r.refusals.iter()
                    .map(|x| serde_json::json!({"what": x.what, "why": x.why}))
                    .collect::<Vec<_>>(),
                "warnings": r.warnings,
                "notes": r.notes,
                "order_before": names_before,
                "order_after": names_after,
                "travel_basis": basis,
            }))
            .unwrap()
        );
    } else {
        println!("route: {source}");
        println!("method: {}", r.method);
        println!(
            "operations={} tool_groups={} tool_changes={}->{} reordered={} moved={}",
            r.operations,
            r.tool_groups,
            r.tool_changes_before,
            r.tool_changes_after,
            r.reordered,
            r.moved_operations
        );
        println!("tools used: {}", names_tools(&routed).join(", "));
        match r.reduction_pct() {
            Some(p) => println!(
                "link travel: before {:.3}mm -> after {:.3}mm  (removed {:.3}mm, {:.1}%)",
                r.link_travel_before_mm, r.link_travel_after_mm, r.reduction_mm(), p
            ),
            // `None` is not 0%. A one-operation job had no travel to reduce, and
            // "0% improvement" would claim an optimisation ran and found nothing.
            None => println!(
                "link travel: before {:.3}mm -> after {:.3}mm  (no link travel to reduce — this \
                 is NOT a 0% improvement)",
                r.link_travel_before_mm, r.link_travel_after_mm
            ),
        }
        println!("segments_considered={} two_opt_passes={}", r.segments_considered, r.two_opt_passes);
        for s in &r.two_opt_skipped {
            println!("2-opt skipped: {s}");
        }
        for p in &r.pinned {
            println!("pinned: {p}");
        }
        for w in &r.warnings {
            println!("warning: {w}");
        }
        for n in &r.notes {
            println!("note: {n}");
        }
        // 🔴 FATAL, and printed last of the channels because it is the worst
        // thing this module can find. See the JSON key above for what dropping
        // it cost.
        for x in &r.refusals {
            println!("refused: {} — {}", x.what, x.why);
        }
        println!();
        println!("order before -> after:");
        for (i, n) in names_after.iter().enumerate() {
            let from = names_before.iter().position(|b| b == n);
            match from {
                Some(f) if f != i => println!("  {i:>3}. {n}   (was {f})"),
                _ => println!("  {i:>3}. {n}"),
            }
        }
        println!();
        println!("TRAVEL BASIS — what these two numbers are NOT:");
        for b in &basis {
            println!("  - {b}");
        }
    }

    // Negative would mean the reorder made it worse, which the search never
    // accepts — so it is a bug report, not a result, and it must not exit clean.
    if r.reduction_mm() < -1e-6 {
        eprintln!(
            "error: the reorder INCREASED link travel by {:.6}mm. The search never accepts a worse \
             order, so this is a defect in the router, not a result",
            -r.reduction_mm()
        );
        return ExitCode::from(1);
    }
    // A refusal exits non-zero whatever else was printed — the same rule
    // `recommend` (unsatisfied feature) and `layout` (interference finding)
    // already follow on this host.
    //
    // ⚠ NOT DEMONSTRATED FROM THIS DOOR, and said so rather than implied:
    // `run_route` calls `optimise_route`, which sorts release-last, so the
    // residue this vector holds — a precedence CYCLE between two tools — cannot
    // be constructed from a drawing or a reference job on the command line
    // today. The core reaches it (`core/src/optimise.rs:1519` asserts exactly
    // one refusal naming the part and both stranded holes, via
    // `GroupOrder::FirstAppearance`). So this arm is a correctness guarantee,
    // not a control anybody has watched go red.
    if !r.refusals.is_empty() {
        return ExitCode::from(1);
    }
    ExitCode::SUCCESS
}

/// Distinct tool names in the order they are first used.
fn names_tools(ops: &[Operation]) -> Vec<String> {
    let mut v: Vec<String> = Vec::new();
    for o in ops {
        if !v.iter().any(|n| *n == o.tool.name) {
            v.push(o.tool.name.clone());
        }
    }
    v
}

// ===========================================================================
//  fit — the datum shift that lands the program inside travel
// ===========================================================================

const FIT_CAVEATS: &[&str] = &[
    "the shift is REPORTED, never applied. The datum is the part's position relative to the \
     CLAMPS, and the clamps are bolted to the machine — they do not travel with the workpiece. Shifting \
     3mm to clear a soft limit moves the program 3mm into whatever is holding the work down",
    "the tool radius is a PARAMETER, not a measurement: this core cannot see which side of which \
     contour the tool runs on. If some contours are cut inside, the real extent is smaller than \
     the one reported here",
    "the extent measured is the DRAWING's, grown by the tool radius — not a planned toolpath's. \
     Lead-in arcs, ramp entries and any lead-out sit outside it and are not counted",
    "a WILL-NOT-FIT carries no shift on purpose. Rotating the WORKPIECE is a different question \
     (Stock::rotation_deg) and this command did not ask it",
];

fn run_fit(args: &[String]) -> ExitCode {
    let Some(path) = args.get(1).filter(|a| !a.starts_with("--")) else {
        return bad_invocation("fit: a drawing file is required");
    };

    let machine = match machine_from(args) {
        Ok(m) => m,
        Err(e) => return bad_invocation(e),
    };
    let stock = match stock_from(args) {
        Ok(s) => s,
        Err(e) => return bad_invocation(e),
    };
    let z = match num_flag(args, "--z") {
        Ok(v) => v,
        Err(e) => return bad_invocation(e),
    };
    let margin = match num_flag_or(args, "--travel-margin", 0.0) {
        Ok(v) => v,
        Err(e) => return bad_invocation(e),
    };
    let explicit_radius = match num_flag(args, "--tool-radius") {
        Ok(v) => v,
        Err(e) => return bad_invocation(e),
    };
    let fmt = flag_value(args, "--format").unwrap_or_else(|| "auto".into());

    let spec = match tool_from(args) {
        Ok(t) => t,
        Err(e) => return bad_invocation(e),
    };
    let (radius, radius_from) = match explicit_radius {
        Some(r) => (r, "--tool-radius".to_string()),
        None => (spec.tool.radius_mm(), format!("tool `{}`", spec.id)),
    };

    let drawing = match load_drawing(path, &fmt, z, stock.size_y_mm, &label_for(path)) {
        Ok(d) => d,
        Err(e) => return e.report(),
    };
    let Some(extent) = drawing.extent() else {
        eprintln!("refused: {path} has no measurable extent, so there is nothing to place");
        return ExitCode::from(1);
    };

    let placement = plan_datum_shift(extent, radius, margin, &machine);

    if has_flag(args, "--json") {
        println!(
            "{}",
            serde_json::to_string(&serde_json::json!({
                "drawing": path,
                "machine": {"travel_x_mm": machine.travel_x_mm, "travel_y_mm": machine.travel_y_mm},
                "drawn_extent": {
                    "min_x": extent.min_x, "min_y": extent.min_y,
                    "max_x": extent.max_x, "max_y": extent.max_y,
                },
                "tool_radius_mm": radius,
                "tool_radius_from": radius_from,
                "travel_margin_mm": margin,
                "placement": placement,
                "fits": placement.fits(),
                "describe": placement.describe(),
                "cannot_tell_you": FIT_CAVEATS,
            }))
            .unwrap()
        );
    } else {
        drawing.print_intake();
        println!("fit: {path} on {} ({:.1} x {:.1}mm of travel)", machine.name, machine.travel_x_mm, machine.travel_y_mm);
        println!(
            "drawn extent: X {:.3} .. {:.3}, Y {:.3} .. {:.3}",
            extent.min_x, extent.max_x, extent.min_y, extent.max_y
        );
        println!(
            "tool radius: {radius:.3}mm (from {radius_from}) · travel margin {margin:.3}mm off \
             each soft limit"
        );
        println!();
        match &placement {
            Placement::AlreadyInside { .. } => println!("ALREADY INSIDE — {}", placement.describe()),
            Placement::ShiftDatum { dx_mm, dy_mm, .. } => {
                println!("SHIFT DATUM — {}", placement.describe());
                println!(
                    "  add {dx_mm:+.3} to Stock::origin_x_mm and {dy_mm:+.3} to Stock::origin_y_mm"
                );
            }
            Placement::WillNotFit { overhangs, .. } => {
                println!("WILL NOT FIT — {}", placement.describe());
                for o in overhangs {
                    println!(
                        "  {} over by {:.3}mm (needs {:.3}mm, {:.3}mm available)",
                        o.axis.as_str(), o.over_mm, o.needed_mm, o.available_mm
                    );
                }
            }
        }
        println!();
        println!("what this CANNOT tell you:");
        for c in FIT_CAVEATS {
            println!("  - {c}");
        }
    }

    if placement.fits() {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(1)
    }
}

// ===========================================================================
//  layout — several drawings on one workpiece, checked against each other
// ===========================================================================

const LAYOUT_CAVEATS: &[&str] = &[
    "🔴 NAMED FALSE RED: the check compares OUTER boundary against OUTER boundary. A part \
     deliberately nested inside another part's HOLE is refused as an overlap even though that \
     drop-out material is genuinely available. The workaround is to draw the nested part as part \
     of the same drawing. Refusing a legal nest costs a re-draw; permitting an illegal one costs \
     a cutter",
    "it is NOT a nester. It checks a placement you chose and never moves a part to resolve a \
     finding — for the same reason `fit` never applies its own shift: the clamps do not move with \
     the parts",
    "it says nothing about TABS. Three parts with one of them tabbed still leaves two loose pieces \
     under the spindle; tabs are per-part and the caller sets them",
    "an EMPTY finding list means every pair was examined and every pair is clear. A pair that \
     could not be examined comes back as `not_checked`, which is a refusal and not a pass",
    "the operation order this layout would emit is the SAFE one (finish a part before starting the \
     next). `2bee-slice job` regroups by tool, which is faster and interleaves parts — that \
     trade-off is stated here, not resolved",
];

/// One `--drawing … --at … --rot … --id …` group, read IN ORDER.
///
/// Order matters: `--at` belongs to the `--drawing` it follows. A flag-scan that
/// ignored position would silently apply one position to every drawing, which
/// would stack them and then report the overlap it created itself.
struct Placed {
    path: String,
    id: Option<String>,
    x: f64,
    y: f64,
    rot: f64,
    /// 🔴 WHICH QUESTION THE NUMBERS ANSWER, and the two subcommands do not ask
    /// the same one.
    ///
    /// * `layout --at <x>,<y>` — the ABSOLUTE workpiece position of the drawing's
    ///   lower-left corner. Right for a grader: the caller already knows where
    ///   everything is and is asking whether that arrangement can be cut.
    /// * `nest --offset <dx>,<dy>` — a DELTA from where the drawing was drawn.
    ///   Right for an emitter, because **zero has to mean AS DRAWN**: a nest
    ///   that defaulted every drawing to the workpiece corner would move geometry
    ///   the operator never touched, and the program would still look right.
    ///
    /// The flags are not interchangeable and neither subcommand accepts the
    /// other's — `flags_for` refuses it by name rather than reading it as the
    /// one it does know, which would silently answer a different question.
    is_delta: bool,
}

fn parse_placements(args: &[String]) -> Result<Vec<Placed>, String> {
    let mut out: Vec<Placed> = Vec::new();
    let mut i = 0usize;
    while i < args.len() {
        match args[i].as_str() {
            "--drawing" => {
                let Some(p) = args.get(i + 1) else {
                    return Err("--drawing needs a file path".into());
                };
                out.push(Placed {
                    path: p.clone(),
                    id: None,
                    x: 0.0,
                    y: 0.0,
                    rot: 0.0,
                    // 🔴 A drawing with NO placement flag is AS DRAWN, which is
                    // a zero DELTA — not a zero absolute position. The default
                    // has to be the delta reading, because the two agree only
                    // for a drawing whose own origin is already the workpiece
                    // corner. Measured 2026-08-10: defaulting this to `false`
                    // made `nest --drawing a --drawing b --offset 300,0` refuse
                    // as if `--at` had been passed, which is gate MULTI's
                    // paired-positive limb going red for a harness fault.
                    is_delta: true,
                });
                i += 2;
            }
            // Two flags, two meanings, and the difference is recorded on the
            // placement rather than left to the caller to remember. See
            // `Placed::is_delta`.
            "--at" | "--offset" => {
                let flag = args[i].as_str();
                let Some(v) = args.get(i + 1) else {
                    return Err(format!("{flag} needs <x>,<y> in millimetres"));
                };
                let Some(last) = out.last_mut() else {
                    return Err(format!(
                        "{flag} came before any --drawing; it belongs to the drawing it follows"
                    ));
                };
                let mut it = v.split(',');
                let (Some(xs), Some(ys), None) = (it.next(), it.next(), it.next()) else {
                    return Err(format!("{flag} '{v}' is not <x>,<y> in millimetres"));
                };
                let (Ok(x), Ok(y)) = (xs.trim().parse::<f64>(), ys.trim().parse::<f64>()) else {
                    return Err(format!("{flag} '{v}' is not two finite numbers in millimetres"));
                };
                if !x.is_finite() || !y.is_finite() {
                    return Err(format!("{flag} '{v}' is not two finite numbers in millimetres"));
                }
                last.x = x;
                last.y = y;
                last.is_delta = flag == "--offset";
                i += 2;
            }
            "--rot" => {
                let Some(v) = args.get(i + 1) else {
                    return Err("--rot needs a number of degrees".into());
                };
                let Some(last) = out.last_mut() else {
                    return Err("--rot came before any --drawing".into());
                };
                match v.parse::<f64>() {
                    Ok(d) if d.is_finite() => last.rot = d,
                    _ => return Err(format!("--rot '{v}' is not a finite number of degrees")),
                }
                i += 2;
            }
            "--id" => {
                let Some(v) = args.get(i + 1) else {
                    return Err("--id needs a name".into());
                };
                let Some(last) = out.last_mut() else {
                    return Err("--id came before any --drawing".into());
                };
                last.id = Some(v.clone());
                i += 2;
            }
            _ => i += 1,
        }
    }
    Ok(out)
}

fn run_layout(args: &[String]) -> ExitCode {
    let placements = match parse_placements(args) {
        Ok(p) => p,
        Err(e) => return bad_invocation(e),
    };
    if placements.is_empty() {
        return bad_invocation(
            "layout: at least one --drawing <file> is required. Usage: --drawing <f> \
             --at <x>,<y> [--rot <deg>] [--id <name>] … --cutter <mm> [--clearance-margin <mm>] \
             [--travel-margin <mm>]",
        );
    }

    // 🔴 The cutter diameter is REQUIRED and is never defaulted. The gap check
    // is a machining constraint — the channel between two parts has to be wider
    // than the tool that travels down it — so a default would make the check
    // pass or fail on a number nobody chose, which is worse than not having the
    // check because a person would trust it.
    let Some(cutter_arg) = flag_value(args, "--cutter") else {
        return bad_invocation(
            "layout: --cutter <mm> is REQUIRED. The clearance check is 'does the tool fit down the \
             channel between these parts', so it cannot be answered without the tool's diameter, \
             and a default would decide it on a number nobody chose",
        );
    };
    let cutter = match cutter_arg.parse::<f64>() {
        Ok(v) if v.is_finite() => v,
        _ => return bad_invocation(format!("--cutter '{cutter_arg}' is not a finite number in millimetres")),
    };
    // 🔴 TWO DIFFERENT MARGINS, and they must not share a flag. The CLEARANCE
    // margin is extra clear MATERIAL between two parts; the TRAVEL margin is how
    // far to stay off the machine's soft limits. One number answering two
    // physical questions is a proxy bug — set 5mm of part spacing and you would
    // silently have moved the program 5mm in off the soft limits as well.
    let clearance_margin = match num_flag_or(args, "--clearance-margin", 0.0) {
        Ok(v) => v,
        Err(e) => return bad_invocation(e),
    };
    let travel_margin = match num_flag_or(args, "--travel-margin", 0.0) {
        Ok(v) => v,
        Err(e) => return bad_invocation(e),
    };
    let Some(clearance) = Clearance::new(cutter, clearance_margin) else {
        return bad_invocation(format!(
            "--cutter {cutter} / --clearance-margin {clearance_margin} is not a usable clearance: \
             the cutter diameter must be positive and finite, and a zero-diameter clearance would \
             silently weaken the check to the margin alone"
        ));
    };

    let machine = match machine_from(args) {
        Ok(m) => m,
        Err(e) => return bad_invocation(e),
    };
    let stock = match stock_from(args) {
        Ok(s) => s,
        Err(e) => return bad_invocation(e),
    };
    let z = match num_flag(args, "--z") {
        Ok(v) => v,
        Err(e) => return bad_invocation(e),
    };
    let fmt = flag_value(args, "--format").unwrap_or_else(|| "auto".into());

    let mut layout = Layout::new();
    let mut loaded: Vec<(String, Placed)> = Vec::new();
    for p in placements {
        let id = p.id.clone().unwrap_or_else(|| label_for(&p.path));
        let drawing = match load_drawing(&p.path, &fmt, z, stock.size_y_mm, &id) {
            Ok(d) => d,
            Err(e) => return e.report(),
        };
        drawing.print_intake();
        let placed = match PlacedDrawing::new(&id, drawing.parts) {
            Ok(d) => d.at(p.x, p.y).rotated(p.rot),
            Err(e) => return bad_invocation(e.describe()),
        };
        if let Err(e) = layout.add(placed) {
            return bad_invocation(format!(
                "{} — pass --id <name> to tell the two apart",
                e.describe()
            ));
        }
        loaded.push((id, p));
    }

    let findings = layout.check(&clearance);
    let notes = layout.notes();
    // The travel question is asked of the UNION extent grown by the tool radius,
    // exactly as `fit` does. The radius is printed with the answer, because a
    // placement that moves with a number nobody saw is a placement nobody can
    // check.
    let travel_radius = clearance.cutter_diameter_mm() * 0.5;
    let placement = layout.plan_placement(travel_radius, travel_margin, &machine);

    if has_flag(args, "--json") {
        println!(
            "{}",
            serde_json::to_string(&serde_json::json!({
                "clearance": {
                    "cutter_diameter_mm": clearance.cutter_diameter_mm(),
                    "clearance_margin_mm": clearance.margin_mm(),
                    "required_mm": clearance.required_mm(),
                },
                "travel": {
                    "tool_radius_mm": travel_radius,
                    "travel_margin_mm": travel_margin,
                },
                "drawings": loaded.iter().map(|(id, p)| {
                    let d = layout.get(id);
                    serde_json::json!({
                        "id": id,
                        "file": p.path,
                        "x_mm": p.x,
                        "y_mm": p.y,
                        "rotation_deg": p.rot,
                        "square_to_the_bed": d.map(|d| d.is_square()),
                        "parts": d.map(|d| d.parts().len()),
                    })
                }).collect::<Vec<_>>(),
                "parts": layout.laid_out().iter().map(|l| l.part_ref().qualified()).collect::<Vec<_>>(),
                "notes": notes,
                "placement": placement,
                "clear": findings.is_empty(),
                "findings": findings.iter().map(|f| serde_json::json!({
                    "finding": f,
                    "describe": f.describe(),
                })).collect::<Vec<_>>(),
                "cannot_tell_you": LAYOUT_CAVEATS,
            }))
            .unwrap()
        );
    } else {
        println!(
            "layout: {} drawing(s), {} part(s) · clearance {:.3}mm ({:.3}mm cutter + {:.3}mm margin)",
            layout.len(),
            layout.laid_out().len(),
            clearance.required_mm(),
            clearance.cutter_diameter_mm(),
            clearance.margin_mm()
        );
        for (id, p) in &loaded {
            let d = layout.get(id);
            let ext = d.and_then(|d| d.placed_extent());
            match ext {
                Some(e) => println!(
                    "  `{id}` from {} at ({:.3}, {:.3}) rot {:.3}deg · {} part(s) · X {:.3} .. {:.3}, Y {:.3} .. {:.3}",
                    p.path, p.x, p.y, p.rot,
                    d.map(|d| d.parts().len()).unwrap_or(0),
                    e.min_x, e.max_x, e.min_y, e.max_y
                ),
                None => println!("  `{id}` from {} at ({:.3}, {:.3}) rot {:.3}deg · no measurable extent", p.path, p.x, p.y, p.rot),
            }
        }
        for n in &notes {
            println!("note: {n}");
        }
        match &placement {
            Some(pl) => println!(
                "workpiece inside travel (union extent grown by {travel_radius:.3}mm of tool radius, \
                 {travel_margin:.3}mm off each soft limit): {}",
                pl.describe()
            ),
            None => println!("workpiece inside travel: nothing placed, so there is no extent to check"),
        }
        println!();
        if findings.is_empty() {
            println!(
                "CLEAR — every pair was examined and no pair shares material or is closer than \
                 {:.3}mm",
                clearance.required_mm()
            );
        } else {
            println!("REFUSED — {} interference finding(s):", findings.len());
            for f in &findings {
                println!("  - {}", f.describe());
            }
        }
        println!();
        println!("what this CANNOT tell you:");
        for c in LAYOUT_CAVEATS {
            println!("  - {c}");
        }
    }

    if findings.is_empty() {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(1)
    }
}

// ===========================================================================
//  Tests — the flag parsers, both directions
// ===========================================================================
//
// 🔴 BOTH directions, deliberately. A "fix" that refuses every value passes any
// test that only checks a bad value is refused, and it would take the CLI down
// while looking green. So every case here is a PAIR: the bad value is refused
// AND the good value still arrives, unchanged, at the field it sets.
#[cfg(test)]
mod tests {

    #[test]
    fn the_feed_backstop_sees_the_syntaxes_grblhal_accepts() {
        // 🔴 THIS IS THE SAFETY READER, and it was blind to both of these until
        // 2026-08-28 while the browser's display row read them correctly. An
        // over-ceiling cutting feed written without a space walked past the
        // ceiling in SILENCE. Now it and the core's display reader are the same
        // scanner, and this test is what keeps them one.
        for prog in ["G1X1F5000\n", "G1 X1 F 5000\n", "G1 X1 F5000\n"] {
            let (cutting, probing) = super::max_feed_in_program(prog);
            assert_eq!(cutting, Some(5000.0), "cutting feed missed in {prog:?}");
            assert_eq!(probing, None, "nothing probes in {prog:?}");
        }
    }

    #[test]
    fn the_backstop_and_the_display_reader_cannot_disagree() {
        // Same program, both readers, on the syntaxes that used to separate
        // them — including a `;` inside a `( … )` comment, where the backstop
        // used to truncate the line and the core did not.
        let prog = "( plate ; not a comment terminator )\nG1X1F4800\nG38.2 Z-3 F200\n";
        let (cutting, probing) = super::max_feed_in_program(prog);
        let display = twobee_cam::feeds::cutting_feeds_in_program(prog);
        assert_eq!(cutting, Some(4800.0));
        assert_eq!(probing, Some(200.0), "the probe seek must still be classified as one");
        assert_eq!(display, vec![4800.0], "the display reader must agree and exclude the probe");
    }

    // ── THE GOUGE SENTENCE ──────────────────────────────────────────────────
    //
    // 🔴 PINNED HERE BECAUSE TWO OF ITS THREE DOORS CANNOT BE PLANTED. `job`
    // takes `--plant gouge` and gate `P9` watches it go red. `import` and `nest`
    // REFUSE that flag, by design and with a good reason — it plants into a
    // FIXTURE job and those two build a job from the operator's own drawings —
    // so the warning is WIRED on them and unfireable from the CLI. Naming that
    // rather than implying coverage: what these tests hold is the sentence and
    // the silence, not the wiring on those two doors.

    #[test]
    fn a_clean_simulation_says_nothing_at_all() {
        // The green path first: a gate that fires on clean input is worse than
        // no gate, and this one prints to the same stream every caller greps.
        assert!(super::gouge_warning(0, ", DEEPEST 18.00mm").is_none());
        assert!(super::gouge_warning(0, "").is_none());
    }

    #[test]
    fn the_gouge_warning_carries_the_count_the_depth_and_the_word_warning() {
        let w = super::gouge_warning(2984, ", DEEPEST 18.00mm").expect("a gouge must warn");
        // The severity word, because a caller greps `^warning:` and the whole
        // defect was that two channels carried the fact and neither used it.
        assert!(w.starts_with("warning: "), "must speak at severity: {w}");
        assert!(w.contains("2984"), "must carry the count: {w}");
        // The DEPTH, because 2984 cells at 0.2mm is a cell-size artefact and one
        // cell at 18mm is a cutter through the part.
        assert!(w.contains("18.00mm"), "must carry the depth: {w}");
        // And it must say the program still comes out, or it reads as a refusal
        // and an operator goes looking for a file that is sitting there.
        assert!(w.contains("still emitted"), "must not read as a refusal: {w}");
    }

    #[test]
    fn a_first_finding_that_is_not_a_gouge_is_not_quoted_after_the_word_gouged() {
        // 🔴 THE DEFECT THIS PINS. `SimCounts::first` is the first finding of ANY
        // class, and `core/src/sim.rs` pushes `Spoilboard` before `Gouge` — so a
        // program that runs past the board edge AND gouges reports the spoilboard
        // one. Quoted after "GOUGED CELL(S)" it invites the operator to read its
        // `past_mm: 0.3` as the gouge depth. This shipped on two doors for hours.
        // 🔴 THE REAL `Debug` OUTPUT, NOT A HAND-WRITTEN LOOKALIKE. `first` is
        // `format!("{f:?}")` of a core enum across a crate boundary, and Rust
        // guarantees nothing about derived `Debug`. Feeding this test a literal
        // would test the helper against MY MODEL of that string — which is the
        // exact mistake the audit that produced this helper was written up for.
        // Formatted from the enum, so a rename, a reordered field or a
        // hand-written `impl Debug` moves this test rather than sliding under it.
        let spoil = format!(
            "{:?}",
            twobee_cam::sim::SimFinding::Spoilboard {
                x: 12.0,
                y: 8.0,
                past_mm: 0.3,
                below: twobee_cam::sim::BelowSheet::OverSpoilboard,
            }
        );
        let spoil = spoil.as_str();
        assert_eq!(super::gouge_detail_from_first(Some(spoil)), "");
        // Saying LESS is available; saying the wrong depth is not.
        let w = super::gouge_warning(3, &super::gouge_detail_from_first(Some(spoil)))
            .expect("a gouge must still warn");
        assert!(!w.contains("past_mm"), "a non-gouge finding reached the gouge sentence: {w}");
        assert!(w.contains("3 GOUGED CELL(S) —"), "must fall back to the count-only form: {w}");
    }

    #[test]
    fn a_first_finding_that_is_a_gouge_is_quoted() {
        // The other half, so the fix cannot be "return empty always" — which
        // would pass the test above and silently drop the depth on every door.
        let g = format!(
            "{:?}",
            twobee_cam::sim::SimFinding::Gouge { x: 61.2, y: 117.6, depth_mm: 18.0 }
        );
        let g = g.as_str();
        let d = super::gouge_detail_from_first(Some(g));
        assert!(d.contains("depth_mm: 18.0"), "the gouge's own depth must survive: {d}");
        assert_eq!(super::gouge_detail_from_first(None), "");
    }

    #[test]
    fn the_warning_survives_a_door_that_knows_no_depth() {
        // `import`/`nest` have a first-finding string and no deepest figure.
        // The sentence must still be a sentence.
        let w = super::gouge_warning(7, "").expect("a gouge must warn");
        assert!(w.contains("7 GOUGED CELL(S) —"), "detail-free form must read cleanly: {w}");
    }
    use super::*;

    fn a(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    /// 🔴 A PENDING DEPTH LIMB AND A CLEAN ONE MUST NOT PRINT THE SAME LINE.
    ///
    /// The failure guarded here is one word wide: `through_board=0` is printed
    /// in both states, and it is the CLASS beside it that says whether the zero
    /// was measured. A host that prints only the integer reports the board with
    /// no declared thickness exactly as it reports a board the cutter stopped
    /// 5mm inside.
    #[test]
    fn an_unchecked_board_depth_and_a_clean_one_do_not_print_the_same_line() {
        use twobee_cam::sim::SpoilboardDepth;
        let unchecked = SpoilboardDepth {
            board_declared: true,
            declared_thickness_mm: None,
            underside_z_mm: None,
            cells_tested: 0,
            cells_through_board: 0,
            deepest_past_underside_mm: 0.0,
            first_through: None,
        };
        let clean = SpoilboardDepth {
            board_declared: true,
            declared_thickness_mm: Some(18.0),
            underside_z_mm: Some(-36.0),
            cells_tested: 40_000,
            cells_through_board: 0,
            deepest_past_underside_mm: 0.0,
            first_through: None,
        };
        let red = SpoilboardDepth { cells_through_board: 12, ..clean };

        let (u, c, r) = (board_depth_line(&unchecked), board_depth_line(&clean), board_depth_line(&red));
        // All three carry `through_board=0`-shaped text; none may be confusable.
        assert_ne!(u, c, "PENDING and CLEAN printed identically");
        assert_ne!(c, r, "CLEAN and THROUGH-THE-BOARD printed identically");
        assert!(u.contains("board_depth=board-depth-unknown"), "{u}");
        assert!(u.contains("thickness=undeclared"), "{u}");
        assert!(c.contains("board_depth=inside-board"), "{c}");
        assert!(c.contains("tested=40000"), "a clean verdict must show it tested something: {c}");
        assert!(r.contains("board_depth=through-board") && r.contains("through_board=12"), "{r}");

        // 🔴 THE ALIASING CONTROL. The gate harness reads `/spoilboard=(\d+)/`
        // off this stream. Nothing on this line may satisfy that regex, on any
        // of the three states, or a gate could bind to the wrong number.
        for line in [&u, &c, &r] {
            assert!(!line.contains("spoilboard="), "this line can alias the old key: {line}");
        }
    }

    /// 🔴 CUTTING THE SPOILBOARD AND CUTTING THE MACHINE MUST NOT PRINT THE SAME
    /// LINE.
    ///
    /// The core separated the classes; this host still summed them, so the two
    /// programs were indistinguishable on the one stream every gate reads. The
    /// control is the old counter — add the three together and print a single
    /// number — and it is what these assertions are shaped to catch: they are
    /// per-class, and no two classes are given the same count, so a summing
    /// implementation cannot satisfy any of them by accident.
    #[test]
    fn a_cut_into_the_spoilboard_and_a_cut_into_the_machine_are_counted_apart() {
        use twobee_cam::sim::{BelowSheet, SimFinding};
        let below = |b: BelowSheet| SimFinding::Spoilboard { x: 1.0, y: 2.0, past_mm: 0.5, below: b };
        // Deliberately different counts per class, and a gouge/uncut in the mix
        // so the filter has something to reject.
        let findings = vec![
            SimFinding::Gouge { x: 0.0, y: 0.0, depth_mm: 1.0 },
            below(BelowSheet::OverSpoilboard),
            below(BelowSheet::OverSpoilboard),
            below(BelowSheet::PastSpoilboardEdge),
            below(BelowSheet::PastSpoilboardEdge),
            below(BelowSheet::PastSpoilboardEdge),
            SimFinding::Uncut { x: 0.0, y: 0.0, standing_mm: 1.0 },
            below(BelowSheet::SpoilboardUndeclared),
        ];
        let c = below_sheet_counts(&findings);
        assert_eq!((c.over, c.past_edge, c.undeclared), (2, 3, 1), "{c:?}");
        // The historical total is unchanged — the line still answers the old
        // question as well as the new one.
        assert_eq!(c.total(), 6, "a gouge or an uncut cell was counted as below the workpiece");

        let line = c.as_line();
        assert!(line.contains("past-spoilboard-edge:3"), "{line}");
        assert!(line.contains("over-spoilboard:2"), "{line}");
        assert!(line.contains("spoilboard-undeclared:1"), "{line}");

        // 🔴 The harness reads `/spoilboard=(\d+)/` off this stream. Assert that
        // no CLASS field can bind to that regex, or the day the fields are
        // reordered the gate silently starts reading a different number.
        assert!(!line.contains("spoilboard="), "a class field can alias the total's key: {line}");

        // And an empty finding list is three zeros, not an absent line: "nothing
        // went below the workpiece" is an answer and has to be printed as one.
        assert_eq!(below_sheet_counts(&[]).total(), 0);
        assert!(below_sheet_counts(&[]).as_line().contains("past-spoilboard-edge:0"));
    }

    /// 🔴 The whole report reaches the operator, through the door a real drawing
    /// goes through.
    ///
    /// Driven through the REAL core on the REAL import path, not against a
    /// hand-built struct: the defect was never in the `Report` type, it was in
    /// this host deciding which of its fields to say out loud.
    ///
    /// The `assert!(!…is_empty())` lines are not belt-and-braces. Without them
    /// this test passes the day the core stops producing a warning or a fixture
    /// finding at all — a control that goes quiet with the thing it watches.
    #[test]
    fn every_channel_a_report_carries_reaches_the_operator() {
        let dxf = include_bytes!("../../gates/fixtures/plate.dxf");
        let plan = |json: &str| {
            let cfg: twobee_cam::fixtures::JobConfig =
                serde_json::from_str(json).expect("the config the test is about must parse");
            twobee_cam::fixtures::plan_report_import_bytes(dxf, "auto", None, &cfg, 0.6)
        };
        let count = |r: &twobee_cam::fixtures::Report| {
            r.notes.len()
                + r.warnings.len()
                + r.fixture_findings.len()
                + r.errors.len()
                + r.refusals.len()
        };

        // ⚠ TWO plans, not one, and the reason is itself the shape this lane
        // keeps meeting: `warnings` is the POST's channel, so a job that refuses
        // never posts and never warns. Asking one config for both would have
        // produced a green that proved only half of what it claimed.

        // (a) A spindle the tool over-runs. Runnable, and it warns.
        //
        // 🔴 RE-POINTED 2026-08-11, not relaxed, and the reason is the finding.
        // This read `{"machine":{"spindle_max_rpm":9000}}` with no `op`, and it
        // warned because the singular `tool_id` door stamped the cutter onto
        // every operation and left `rpm` on the 18000 the operation was BUILT
        // with — so the post found a commanded speed the spindle could not
        // deliver. Since the door collapse that config DERIVES its rpm through
        // `recommend`, which already obeys `spindle_max_rpm`, so nothing is ever
        // commanded above it and there is correctly nothing to warn about.
        // **The warning did not stop reaching the operator; the defect it
        // reported stopped being emitted.** Re-pointed at the case that can
        // still produce one — an rpm the OPERATOR typed, which `op` applies
        // after the assignment and which the post is right to flag rather than
        // silently overrule. The instruction in the assertion below is obeyed:
        // re-point, never delete.
        let over = plan(
            r#"{"tool_id":"End Mill - Down-cut 6mm 2F",
                "machine":{"spindle_max_rpm":9000},
                "op":{"rpm":18000}}"#,
        );
        assert!(over.ok, "this half must produce a RUNNABLE program, or it warns about nothing");
        assert!(!over.notes.is_empty(), "the fixture stopped producing notes; this is vacuous");
        assert!(
            !over.warnings.is_empty(),
            "the spindle over-speed no longer reaches `warnings`; re-point this test at whatever \
             does, do not delete the assertion"
        );
        let lines = report_channel_lines(&over);
        for prefix in ["note: ", "warning: "] {
            assert!(
                lines.iter().any(|l| l.starts_with(prefix)),
                "no `{prefix}` line — a channel the report carries is not printed: {lines:#?}"
            );
        }
        assert_eq!(lines.len(), count(&over), "a line the report does not carry, or one missing");

        // (b) A clamp bolted over the part. It REFUSES — and until 2026-08-10
        // this door printed `ok=false` and not one word of why, because the
        // whole reason was in `fixture_findings` and nothing here read it.
        let clamped = plan(
            r#"{"tool_id":"End Mill - Down-cut 6mm 2F",
                "clamps":[{"name":"bar-on-part","x":80,"y":40,"w":60,"h":40,"height_mm":40}]}"#,
        );
        assert!(!clamped.ok, "a clamp over the part must refuse, or this half is vacuous");
        assert!(
            !clamped.fixture_findings.is_empty(),
            "the clamp no longer reaches `fixture_findings`; this half is vacuous"
        );
        let lines = report_channel_lines(&clamped);
        assert!(
            lines.iter().any(|l| l.starts_with("fixture: ")),
            "no `fixture: ` line: {lines:#?}"
        );
        assert!(
            lines.iter().any(|l| l.contains("CutsClamp")),
            "the reason the job was refused must be on screen: {lines:#?}"
        );
        assert_eq!(lines.len(), count(&clamped));
    }

    /// `errors` and `refusals` keep their prefixes — the two channels this door
    /// always printed. Asserted so a re-order or a re-word is a red, not a
    /// surprise for whoever greps this output.
    #[test]
    fn the_channels_that_always_printed_still_print_under_their_own_names() {
        let dxf = include_bytes!("../../gates/fixtures/plate.dxf");
        // Off the far edge of the travel -> an `errors` entry from the travel check.
        let cfg: twobee_cam::fixtures::JobConfig = serde_json::from_str(
            r#"{"tool_id":"End Mill - Down-cut 6mm 2F","stock":{"origin_x_mm":700}}"#,
        )
        .unwrap();
        let r = twobee_cam::fixtures::plan_report_import_bytes(dxf, "auto", None, &cfg, 0.6);
        assert!(!r.errors.is_empty(), "the travel check no longer errors; this test is vacuous");
        let lines = report_channel_lines(&r);
        assert!(
            lines.iter().any(|l| l.starts_with("error: ")),
            "the travel error must still be printed: {lines:#?}"
        );
    }

    /// 🔴 `F2` in `( tool: End Mill - Down-cut 6mm 2F D6.00mm F2 )` is a FLUTE
    /// COUNT and it is a real line of our own output. A reader that took it for
    /// a feed would report `F2` as this program's maximum and the check above it
    /// would never fire again.
    #[test]
    fn a_flute_count_inside_a_comment_is_not_a_feed() {
        let g = "( tool: End Mill - Down-cut 6mm 2F D6.00mm F2 )\nG1 X10.000 F900.0\n";
        assert_eq!(max_feed_in_program(g), (Some(900.0), None));
        // …and a comment is the only thing on the line: no feed at all.
        assert_eq!(max_feed_in_program("( F99999 )\nG0 X1\n"), (None, None));
        // A semicolon comment is stripped too.
        assert_eq!(max_feed_in_program("G1 X1 F100.0 ; was F9000\n"), (Some(100.0), None));
        // The MAXIMUM, not the first or the last.
        assert_eq!(
            max_feed_in_program("G1 F200.0\nG1 F3600.0\nG1 F25.0\n"),
            (Some(3600.0), None)
        );
    }

    /// 🔴 THE SPLIT, ASSERTED AT REAL EMITTED LINES. A probing feed and a
    /// cutting feed must not land in the same number, or the exemption and the
    /// leak are one figure again.
    #[test]
    fn a_probing_feed_and_a_cutting_feed_are_counted_separately() {
        // Verbatim from `job plate --config '{"machine":{"max_feed_mm_min":150},
        // "op":{"feed_mm_min":100}}'` at HEAD 026a6c9523.
        let g = "G91\nG38.2 Z-30.000 F200.0\nG0 Z2.000\nG38.2 Z-4.000 F25.0\nG90\n\
                 G1 Z-0.400 F300.0\nG1 Y70.000 F100.0\n";
        assert_eq!(max_feed_in_program(g), (Some(300.0), Some(200.0)));

        // 🔴 The scanner must not classify by the text that DISCUSSES probing.
        // `( G91 applies to G38.2 )` is a real line of our own output; a cutting
        // move carrying that comment must stay a cutting move, or the ceiling
        // can be escaped by writing a comment.
        let camouflaged = "G1 X10.000 F3600.0 ( G91 applies to G38.2 )\n";
        assert_eq!(
            max_feed_in_program(camouflaged),
            (Some(3600.0), None),
            "a comment mentioning G38.2 exempted a cutting move"
        );
    }

    /// The exemption speaks in DIFFERENT WORDS from the leak, and the leak arm
    /// still fires. Both directions, because a report that only ever says one
    /// thing has stopped distinguishing anything.
    #[test]
    fn the_probe_exemption_is_reported_as_an_exemption_and_not_as_a_leak() {
        let probe_only = "G38.2 Z-30.000 F200.0\nG1 X1 F100.0\n";
        let w = unenforced_feed_limit(Some(150.0), probe_only)
            .expect("F200 probing against a declared 150 must be SAID, not swallowed");
        assert!(w.contains("probing move"), "{w}");
        assert!(w.contains("NOT a leak"), "{w}");
        assert!(!w.contains("DEFECT IN THE PLANNER"), "an exemption read as a leak: {w}");

        // …and the negative control: a real cutting overrun still reads as a
        // planner defect, in the loud words.
        let cutting = "G1 X1 F3600.0\n";
        let d = unenforced_feed_limit(Some(900.0), cutting).expect("F3600 against 900");
        assert!(d.contains("DEFECT IN THE PLANNER"), "{d}");
        assert!(!d.contains("NOT a leak"), "{d}");
    }

    /// The three states of a declared feed limit, and only one of them speaks.
    #[test]
    fn a_feed_limit_speaks_only_when_it_was_declared_and_the_program_broke_it() {
        let over = "G1 X1 F3600.0\n";
        let under = "G1 X1 F300.0\n";

        // Not declared: silent. `max_feed_mm_min` has a 6000 default in the core,
        // so firing on the default would put this line on every job that ever
        // ran fast — a warning that is always on is a warning nobody reads.
        assert!(unenforced_feed_limit(None, over).is_none());
        // Declared and honoured by the program: silent.
        assert!(unenforced_feed_limit(Some(900.0), under).is_none());
        // Exactly at the limit is not over it.
        assert!(unenforced_feed_limit(Some(3600.0), over).is_none());
        // Declared and broken: names BOTH numbers, and says the limit was not
        // applied rather than implying it was.
        let w = unenforced_feed_limit(Some(900.0), over).expect("F3600 against a declared 900");
        assert!(w.contains("F3600.0"), "the emitted feed must be quoted: {w}");
        assert!(w.contains("900.0"), "the declared limit must be quoted: {w}");
        // ⚠ CHANGED 2026-08-11 with the sentence it reads. This used to require
        // "DOES NOT ENFORCE", which was the honest wording while the core did
        // not — the core now enforces on every door, so a cutting feed above
        // the ceiling means a path skipped `plan_job`, and the report has to say
        // THAT instead. A test pinning the old sentence would have kept a stale
        // 🔴 alive by making the correction fail.
        assert!(
            w.contains("SHOULD BE IMPOSSIBLE") && w.contains("DEFECT IN THE PLANNER"),
            "it must name a planner defect rather than an unapplied setting — a host that \
             reports a cap must not read as a host that applied one, and a host that says \
             'not enforced' about an enforced ceiling overstates exposure: {w}"
        );
        // Junk in the declaration is not a limit.
        assert!(unenforced_feed_limit(Some(0.0), over).is_none());
        assert!(unenforced_feed_limit(Some(f64::NAN), over).is_none());
    }

    /// 🔴 INVERTED 2026-08-11, exactly as its previous body instructed — *"when
    /// `core/src/job.rs::plan_job` clamps the feed, invert this into the
    /// assertion that it does; do not delete it."* It used to assert the DEFECT:
    /// this config emitted **F20000.0** against a declared 900mm/min ceiling,
    /// on the door the browser takes for a single cutter.
    ///
    /// ⚠ **The core did NOT clamp — it REFUSES**, and the difference is the
    /// point rather than a detail. A typed feed and a declared ceiling are two
    /// declarations that contradict each other, and only the person who made
    /// both can resolve it; a program quietly run at 900 is a program the
    /// operator did not write. So the assertion is that **no program comes back
    /// at all**, which is a stronger thing than a clamp and could not be
    /// expressed by editing the number this test used to read.
    ///
    /// The same measurement now lives beside the code that makes it true, in
    /// `core/src/job.rs::feed_ceiling_tests`; this one keeps the CLI's own view
    /// of it, because a host that reports a cap must not start reading as a host
    /// that applied one.
    /// 🔴 RE-POINTED 2026-08-11 BY THE DOOR COLLAPSE, and the re-point is the
    /// measurement the commit was asked for: **does the ceiling still bind on
    /// every door?** It does, and both refusing arms are still reachable through
    /// a real `--config` — but the ceiling this test used to pass under, 900,
    /// now refuses EARLIER and for a DIFFERENT true reason, so keeping the old
    /// number would have kept a green that no longer proved `pinned_feed`.
    ///
    /// At `max_feed_mm_min: 900` the singular door never asked `recommend`, so
    /// the typed 20000 reached `pinned_feed` and was refused naming both
    /// numbers. Now `recommend` runs first and finds that a Ø6mm 2-flute cutter
    /// cannot hold 0.100mm of chip under a 900mm/min ceiling at any rpm it can
    /// be turned at — also true, also a refusal, also zero bytes, but it is not
    /// this test's subject. So both cases are asserted: 900 still refuses (the
    /// SAFETY property is unchanged), and 3000 — a ceiling `recommend` can live
    /// with — is where `pinned_feed` itself is exercised.
    #[test]
    fn a_pinned_feed_over_the_declared_limit_is_refused_and_no_program_comes_back() {
        let dxf = include_bytes!("../../gates/fixtures/plate.dxf");
        let plan = |json: &str| {
            let cfg: twobee_cam::fixtures::JobConfig =
                serde_json::from_str(json).expect("config should parse");
            twobee_cam::fixtures::plan_report_import_bytes(dxf, "auto", None, &cfg, 0.6)
        };

        let r = plan(
            r#"{"tool_id":"End Mill - Down-cut 6mm 2F",
                "machine":{"max_feed_mm_min":3000},
                "op":{"feed_mm_min":20000}}"#,
        );
        assert!(
            !r.ok,
            "F20000 against a declared 3000 was planned; the core stopped refusing a pinned feed \
             over the ceiling"
        );
        assert!(
            max_feed_in_program(&r.gcode) == (None, None),
            "a refused job still handed back feeds to run: {}",
            r.gcode
        );
        let said = r.refusals.join("\n");
        assert!(
            said.contains("20000") && said.contains("3000"),
            "both numbers, or the operator cannot tell which to change: {said}"
        );
        assert!(said.contains("REFUSED"), "{said}");
        // …and the host's own report cannot fire on a program that does not
        // exist, which is what keeps `unenforced_feed_limit` honest rather than
        // decorative.
        assert!(unenforced_feed_limit(Some(3000.0), &r.gcode).is_none());

        // A PLUNGE over the same ceiling, through the same door. `recommend`
        // never sets `plunge_mm_min` and `op` is applied after the assignment,
        // so this arm is untouched by the collapse — asserted rather than
        // assumed, because "untouched" is exactly the claim a collapse breaks.
        let p = plan(
            r#"{"tool_id":"End Mill - Down-cut 6mm 2F",
                "machine":{"max_feed_mm_min":3000},
                "op":{"plunge_mm_min":20000}}"#,
        );
        assert!(!p.ok, "a plunge of 20000 under a 3000 ceiling was planned");
        assert!(p.gcode.is_empty(), "a refused plunge still handed back a program");
        let said = p.refusals.join("\n");
        assert!(
            said.contains("20000") && said.contains("3000") && said.contains("PLUNGE"),
            "the plunge refusal must name both numbers and say it is a cutting move: {said}"
        );

        // …and the ceiling the singular door used to be caught at still refuses,
        // with no program. Kept so this file records that the SAFETY property is
        // unchanged and only which check fires has moved.
        let low = plan(
            r#"{"tool_id":"End Mill - Down-cut 6mm 2F",
                "machine":{"max_feed_mm_min":900},
                "op":{"feed_mm_min":20000}}"#,
        );
        assert!(!low.ok && low.gcode.is_empty(), "a 900mm/min ceiling stopped refusing entirely");
    }

    #[test]
    fn a_flag_that_cannot_be_read_is_never_read_as_absent() {
        // The letter O for a zero — the typo the travel flags were losing.
        let e = num_flag(&a(&["--machine-x", "60O"]), "--machine-x").unwrap_err();
        assert!(e.contains("--machine-x"), "the message must name the flag: {e}");
        assert!(e.contains("60O"), "the message must quote what it received: {e}");

        // …and every other shape of unreadable value.
        for bad in ["1,5", "", "6mm", "nan", "inf", "--probe"] {
            assert!(
                num_flag(&a(&["--machine-x", bad]), "--machine-x").is_err(),
                "'{bad}' was accepted as a travel limit"
            );
        }

        // ABSENT is still absent, and a real number still arrives.
        assert_eq!(num_flag(&a(&["--probe"]), "--machine-x"), Ok(None));
        assert_eq!(num_flag(&a(&["--machine-x", "600"]), "--machine-x"), Ok(Some(600.0)));
        assert_eq!(num_flag(&a(&["--machine-x", "-3.5"]), "--machine-x"), Ok(Some(-3.5)));
    }

    /// 🔴 The asymmetry that made this dangerous rather than merely sloppy: the
    /// fallback is the DEFAULT travel, which is LARGER than the small machine
    /// anyone would be overriding it for. So the test asserts on the MACHINE,
    /// not on the parser — "the flag errored" and "the travel limit was not
    /// silently widened" are different claims and only the second is the risk.
    #[test]
    fn an_unreadable_travel_limit_never_reaches_the_machine() {
        let mut m = Machine::default();
        let default_x = m.travel_x_mm;
        assert!(apply_travel(&a(&["--machine-x", "10O"]), &mut m).is_err());
        assert_eq!(
            m.travel_x_mm, default_x,
            "a refused flag must leave the machine untouched, not half-applied"
        );

        // The good value still lands, on both axes.
        let mut m = Machine::default();
        apply_travel(&a(&["--machine-x", "100", "--machine-y", "250"]), &mut m).unwrap();
        assert_eq!((m.travel_x_mm, m.travel_y_mm), (100.0, 250.0));
    }

    #[test]
    fn a_positional_number_is_refused_by_position_and_by_name() {
        let args = a(&["nest-check", "3O", "0", "0"]);
        let e = pos_num(&args, 1, "rotation in degrees", 0.0).unwrap_err();
        assert!(e.contains("rotation in degrees") && e.contains("3O"), "{e}");
        // The other two positions still read, and a missing one is still the
        // default rather than an error.
        assert_eq!(pos_num(&args, 2, "dx in millimetres", 0.0), Ok(0.0));
        assert_eq!(pos_num(&args, 9, "dy in millimetres", 0.0), Ok(0.0));
        assert_eq!(pos_num(&a(&["x", "30.5"]), 1, "rotation", 0.0), Ok(30.5));
    }

    #[test]
    fn the_sim_cell_is_strict_and_positive() {
        assert!(sim_cell_from(&a(&["--sim-cell", "0,6"])).is_err());
        assert!(sim_cell_from(&a(&["--sim-cell", "0"])).is_err(), "0 is not a grid");
        assert!(sim_cell_from(&a(&["--sim-cell", "-0.6"])).is_err(), "negative is not a grid");
        // Absent keeps the documented default; a real value is used as given.
        assert_eq!(sim_cell_from(&a(&[])), Ok(0.6));
        assert_eq!(sim_cell_from(&a(&["--sim-cell", "0.25"])), Ok(0.25));
    }

    #[test]
    fn an_unknown_entry_mode_is_named_and_the_known_ones_still_work() {
        let e = entry_from(&a(&["--entry", "Spiral"])).unwrap_err();
        assert!(e.contains("Spiral") && e.contains("Plunge"), "name it and list the known ones: {e}");
        assert_eq!(entry_from(&a(&[])), Ok(None));
        assert_eq!(entry_from(&a(&["--entry", "Ramp"])), Ok(Some(EntryMode::Ramp)));
        assert_eq!(entry_from(&a(&["--entry", "plunge"])), Ok(Some(EntryMode::Plunge)));
        // Helix PARSES — it is a mode this core knows — and is refused later,
        // by the generator, as unimplemented. A parse error here would say the
        // wrong thing: "no such mode" rather than "that mode is not built".
        assert_eq!(entry_from(&a(&["--entry", "Helix"])), Ok(Some(EntryMode::Helix)));
    }

    /// 🔴 A PAIR, like every other case here. "The unknown flag errored" alone
    /// is satisfied by a checker that refuses everything, which would take the
    /// CLI down while looking green — so the flags each subcommand DOES read
    /// must still pass on the same call.
    #[test]
    fn a_flag_a_subcommand_does_not_read_is_refused_by_name() {
        let spec = flags_for("job").unwrap();
        let e = check_flags(&spec, &a(&["job", "plate", "--no-such-flag"])).unwrap_err();
        assert!(e.contains("--no-such-flag"), "the message must name the flag: {e}");
        assert!(e.contains("--config"), "and list what it does read: {e}");

        // The two defects this check exists for, from the other direction.
        // `--config` on `job` and `--plant` on `import` are now READ, so they
        // must not be refused as unknown.
        check_flags(&spec, &a(&["job", "plate", "--config", "f.json"])).unwrap();
        check_flags(&spec, &a(&["job", "plate", "--plant", "gouge", "--no-probe"])).unwrap();
        let imp = flags_for("import").unwrap();
        check_flags(&imp, &a(&["import", "p.dxf", "--plant", "gouge"])).unwrap();
        check_flags(&imp, &a(&["import", "p.dxf", "--format", "stl", "--z", "12", "--json"]))
            .unwrap();

        // A flag that belongs to a DIFFERENT subcommand is exactly as unread as
        // one that belongs to none — `--sim-cell` means nothing to `fixture`.
        assert!(check_flags(
            &flags_for("fixture").unwrap(),
            &a(&["fixture", "rect-profile", "--sim-cell", "0.2"])
        )
        .is_err());
        // …and the flags `fixture` genuinely takes still pass.
        check_flags(
            &flags_for("fixture").unwrap(),
            &a(&["fixture", "rect-profile", "--plant", "deep", "--no-arcs", "--spoilboard-zero"]),
        )
        .unwrap();

        // Subcommands that take no flags at all say so rather than listing none.
        let e = check_flags(&flags_for("version").unwrap(), &a(&["version", "--json"])).unwrap_err();
        assert!(e.contains("takes no flags"), "{e}");
        assert!(flags_for("no-such-command").is_none(), "an unknown command is a different error");
    }

    /// 🔴 A VALUE is never re-read as a flag.
    ///
    /// The cheapest way to write this checker is to refuse every `--token` it
    /// does not recognise — which would refuse `--id --json`, a legal (if odd)
    /// drawing name, and refuse `--material --z` if anyone ever had such a
    /// material. A checker that starts rejecting legal invocations costs more
    /// than the hole it closed, so the value slot is SKIPPED, not examined.
    #[test]
    fn the_value_of_a_flag_is_never_mistaken_for_a_flag() {
        let spec = flags_for("layout").unwrap();
        check_flags(&spec, &a(&["layout", "--id", "--json", "--cutter", "6"])).unwrap();
        // Negative coordinates are values too, and they start with a dash.
        check_flags(&spec, &a(&["layout", "--drawing", "a.dxf", "--at", "-5,-10", "--cutter", "6"]))
            .unwrap();
        // The unknown one is still caught when it is genuinely in a flag slot.
        assert!(check_flags(&spec, &a(&["layout", "--cutter", "6", "--nope"])).is_err());
    }

    /// 🔴 The lists in `flags_for` are a CONTRACT, and a contract that drifts
    /// from the code re-opens the hole while looking like a guard. Every flag
    /// listed for a subcommand must appear as a literal in this file — the
    /// cheapest available proof that something parses it.
    ///
    /// ⚠ What this does NOT prove: that the literal is read by the RIGHT
    /// subcommand's handler. `--z` is read by four of them and this test cannot
    /// tell them apart. It catches the failure that actually happens — a flag
    /// listed here and implemented nowhere — and says out loud that it does not
    /// catch the other one.
    #[test]
    fn every_listed_flag_is_read_by_its_subcommand() {
        let src = include_str!("main.rs");
        // The lists themselves are in this file, so a flag naming ITSELF only
        // inside `flags_for` would pass. Cut the table out before searching.
        let table_start = src.find("fn flags_for(").expect("flags_for is in this file");
        let table_end = src[table_start..].find("\n/// Refuse any").expect("check_flags follows it")
            + table_start;
        let body = format!("{}{}", &src[..table_start], &src[table_end..]);
        for cmd in [
            "job", "report", "import", "fixture", "recommend", "route", "fit", "layout", "nest",
        ] {
            let spec = flags_for(cmd).unwrap();
            for f in spec.value.iter().chain(spec.boolean.iter()) {
                assert!(
                    body.contains(&format!("\"{f}\"")),
                    "`{cmd}` lists {f} but nothing outside the table parses it"
                );
            }
        }
    }
}

// ---------------------------------------------------------------------------
//  nest — N drawings, one program, and a refusal before either
// ---------------------------------------------------------------------------
//
// Founder, 2026-08-10: *"In the drawings I should able to add more than 1
// drawings, I should able to rotate the drawings"*.
//
// 🔴 THIS EMITS. `layout` grades a placement and prints no G-code; `nest` plans
// the job and prints the program the machine would run. That difference is why
// the overlap check is not advisory here: two parts on the same material means
// cutting the first destroys the second's edge and leaves it loose under a
// 2.2 kW spindle while the program is still running. A condemned workpiece exits
// non-zero with **nothing on stdout** — the same shape gate G13 holds, because a
// rejected program that still prints G-code gets run anyway.
//
// 🔴 AND IT MOVES NOTHING. Not to open a channel, not to clear a clamp, not by a
// millimetre. The clamps are bolted to the machine and do not travel with the
// parts. The refusal names both parts and the numbers; the operator re-nests.
fn run_nest(args: &[String]) -> ExitCode {
    let mut placements = match parse_placements(args) {
        Ok(p) => p,
        Err(e) => return bad_invocation(e),
    };
    // A bare positional file is the FIRST drawing. It is not sugar: gate PLANT
    // drives every plant as `<host> <target>`, so a control on this path has to
    // be reachable without a flag. It is prepended rather than appended so
    // `nest a.dxf --drawing b.dxf` reads left to right, and a `--offset` cannot
    // silently attach to it — `--offset` binds to the drawing it FOLLOWS, and
    // nothing follows a positional.
    if let Some(first) = args.get(1).filter(|a| !a.starts_with("--")) {
        placements.insert(
            0,
            Placed {
                path: first.clone(),
                id: None,
                x: 0.0,
                y: 0.0,
                rot: 0.0,
                is_delta: true,
            },
        );
    }
    if placements.is_empty() {
        return bad_invocation(
            "nest: at least one drawing is required, as a positional file or --drawing <file>. \
             Usage: nest [<file>] [--drawing <f> [--offset <dx>,<dy>] [--rot <deg>] [--id <name>]]… \
             [--config <f>] [--z <mm>] [--sim-cell <mm>] [--json]",
        );
    }
    // 🔴 `--at` belongs to `layout` and means something else here — an absolute
    // corner position rather than a delta from as-drawn. `flags_for` refuses it
    // by name before this point; this asserts the invariant rather than trusting
    // it, because the two flags differ by the whole distance between a drawing's
    // own origin and the workpiece's.
    if placements.iter().any(|p| !p.is_delta) {
        return bad_invocation(
            "nest: --at is `layout`'s flag and means an ABSOLUTE corner position. Here the \
             placement is a DELTA from where the drawing was drawn, so that zero means AS DRAWN — \
             use --offset <dx>,<dy>",
        );
    }

    // 🔴 The ONLY plant this path applies is `overlap-unchecked`. Every other is
    // a fixture plant and `nest` builds no fixture, so it is REFUSED rather than
    // accepted and discarded — a flag that is honoured is a precondition of the
    // control below meaning anything, and `import --plant` exited 0 doing
    // nothing for exactly this reason.
    let plant = match flag_value(args, "--plant") {
        None => twobee_cam::fixtures::JobPlant::None,
        Some(name) => match twobee_cam::fixtures::job_plant_from(&name) {
            None => {
                eprintln!("error: unknown job plant '{name}'. known:");
                for (n, d) in twobee_cam::fixtures::JOB_PLANTS {
                    eprintln!("  {n:<20} {d}");
                }
                return ExitCode::from(2);
            }
            Some(twobee_cam::fixtures::JobPlant::None) => twobee_cam::fixtures::JobPlant::None,
            Some(twobee_cam::fixtures::JobPlant::OverlapUnchecked) => {
                twobee_cam::fixtures::JobPlant::OverlapUnchecked
            }
            // `reach-blind` belongs on THIS path and nowhere else: the defect it
            // restores is about a DRAWING whose slot the cutter cannot enter, so
            // it can only be planted where a drawing is what the job is built
            // from. It suppresses one note and leaves the program byte-identical
            // — see `PlantEffect::NoteDisappears`.
            Some(twobee_cam::fixtures::JobPlant::ReachBlind) => {
                twobee_cam::fixtures::JobPlant::ReachBlind
            }
            Some(_) => {
                return bad_invocation(format!(
                    "'{name}' is a known job plant, but `nest` cannot apply one: it plants a \
                     defect into a FIXTURE job, and this subcommand builds a job from the \
                     drawings you gave it. Accepting it here would report a defect that was never \
                     planted — a control that can never go red. The plants this path applies \
                     are `overlap-unchecked` and `reach-blind`"
                ));
            }
        },
    };

    let cfg = match config_from(args) {
        Ok(c) => c,
        Err(e) => return bad_invocation(e),
    };
    let cell = match sim_cell_from(args) {
        Ok(v) => v,
        Err(e) => return bad_invocation(e),
    };
    let fmt = flag_value(args, "--format").unwrap_or_else(|| "auto".into());
    // The section Z for a mesh. ABSENT and UNPARSEABLE are different answers:
    // absent means "you did not choose one" and the core sections at mid-height
    // and says so, whereas `--z 9,5` is a typo that must not silently become the
    // same thing.
    let z_section_mm: Option<f64> = match flag_value(args, "--z") {
        None => None,
        Some(s) => match s.parse::<f64>() {
            Ok(v) if v.is_finite() => Some(v),
            _ => return bad_invocation(format!("--z '{s}' is not a number in millimetres")),
        },
    };

    // 🔴 Read as BYTES and let the CORE decide the format from the CONTENT — the
    // same rule `import` follows and for the same reason: the extension is a
    // claim made by whoever named the file, and a binary STL called `part.dxf`
    // would otherwise reach the DXF reader and yield an empty drawing that reads
    // downstream exactly like a valid drawing with no features.
    let mut blobs: Vec<(String, Vec<u8>, f64, f64, f64)> = Vec::with_capacity(placements.len());
    for p in &placements {
        let id = p.id.clone().unwrap_or_else(|| label_for(&p.path));
        let data = match std::fs::read(&p.path) {
            Ok(d) => d,
            Err(e) => {
                eprintln!("error: cannot read {}: {e}", p.path);
                return ExitCode::from(2);
            }
        };
        blobs.push((id, data, p.x, p.y, p.rot));
    }

    let sources: Vec<twobee_cam::fixtures::ImportSource<'_>> = blobs
        .iter()
        .map(|(id, data, dx, dy, rot)| twobee_cam::fixtures::ImportSource {
            id: id.clone(),
            data,
            format: fmt.clone(),
            z_section_mm,
            offset_mm: [*dx, *dy],
            rotation_deg: *rot,
        })
        .collect();

    let r = twobee_cam::fixtures::plan_report_import_many_planted(
        &sources, plant, &cfg, cell, None, None,
    );

    // Outside the `--json` branch for the same reason `import`'s is — see there.
    if let Some(w) = gouge_warning(r.sim.gouge, &gouge_detail_from_first(r.sim.first.as_deref())) {
        eprintln!("{w}");
    }
    if has_flag(args, "--json") {
        println!("{}", serde_json::to_string(&r).unwrap());
    } else {
        // The SAME printer `import` uses. This block was a second copy and it
        // dropped the same two channels — see `report_channel_lines`.
        for line in report_channel_lines(&r) {
            eprintln!("{line}");
        }
        if let Some(w) =
            unenforced_feed_limit(cfg.machine.as_ref().and_then(|m| m.max_feed_mm_min), &r.gcode)
        {
            eprintln!("warning: {w}");
        }
        eprintln!(
            "nest: {} drawing(s) · ok={} cut={:.0}mm deepest={:.2}mm gouge={} tabs={}",
            sources.len(),
            r.ok,
            r.cutting_distance_mm,
            r.deepest_z_mm,
            r.sim.gouge,
            r.tab_lifts
        );
        // 🔴 stdout carries the program and NOTHING ELSE, and only when the job
        // was accepted. Everything above is stderr, so a caller piping stdout to
        // a file gets a runnable program or an empty file — never a refusal
        // sitting at the top of something a controller will try to execute.
        if r.ok {
            print!("{}", r.gcode);
        }
    }
    if r.ok {
        ExitCode::SUCCESS
    } else {
        ExitCode::from(1)
    }
}
