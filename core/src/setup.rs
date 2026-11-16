//! **What the human must do at the machine before this program runs** — read
//! off the EMITTED PROGRAM, cross-checked against the job that produced it.
//!
//! Copyright (C) 2026 2BEE FARM PTY LTD.
//! Licensed under the GNU Affero General Public License v3 or later.
//!
//! # Why this exists
//!
//! The founder's three-step app (Design → Change → Make) ends with a setup
//! checklist: which cutter to fit, when the program will stop for a tool or
//! clamp change, which workpiece to load, where Z0 is. Before this module the
//! browser GUESSED that list from the catalogue's bounding box. A guessed
//! checklist is the worst kind: it reads like an instruction and describes a
//! job the machine is not going to run.
//!
//! 🔴 **Assert on the EMITTED PROGRAM, never on the setting that was supposed to
//! produce it** (`AGENTS.md`, standing rules — bitten four times). So every fact
//! below that the program text CAN carry is read from the text, and the job is
//! used only to CROSS-CHECK it. Where the two disagree the disagreement goes in
//! [`SetupFacts::mismatches`] — it is never resolved silently in either
//! direction, because "which one is right" is exactly the question an operator
//! standing at the spindle cannot answer.
//!
//! # What this does NOT do
//!
//! - **It does not plan, post or change anything.** It reads a finished program.
//! - **It does not validate the program.** Travel, depth, collet and fixture
//!   refusals belong to the planner and the post; a program they refused never
//!   reaches here (see [`setup_for_reference_job`]).
//! - **It cannot see what the text does not say.** A tool change names the tool
//!   but carries no diameter, so the diameter of every tool after the first comes
//!   from the job's tool list and says so in its `diameter_source`. The Z datum
//!   is not written in the program at all, so it is the job's declaration and
//!   says so. Nothing here is filled in from a default.
//! - **Nothing here has been checked against a physical machine.** Like every
//!   other output of this lane: no air cut, no coupon, no ply.

use serde::Serialize;

use crate::feeds::{cutting_feeds_in_program, strip_comments};
use crate::job::Job;
use crate::tools::Material;
use crate::toolpath::parse_banner;
use crate::types::{Stock, Tool};

/// The comment prefix the post writes before a tool-change `M0`
/// (`post_grblhal.rs`, `MoveKind::ToolChange`).
pub const TOOL_CHANGE_PREFIX: &str = "TOOL CHANGE -> ";
/// The comment prefix the post writes before a clamp-change `M0`
/// (`post_grblhal.rs`, `MoveKind::ClampChange`).
pub const CLAMP_CHANGE_PREFIX: &str = "CLAMP CHANGE -> ";
/// The comment prefix the post writes before the SECOND `M0` of a cutter
/// change on a machine with no Z probe (`post_grblhal.rs`,
/// `MoveKind::ManualZero`): the person sets Z zero by hand, then resumes.
pub const ZERO_PREFIX: &str = "SET Z ZERO -> ";
/// The comment prefix the post writes before the `M0` that follows a probe
/// against a touch plate lying ON THE WORK (`post_grblhal.rs`, `emit_probe`):
/// the plate is still under the cutter, and the person takes it off.
pub const PLATE_PREFIX: &str = "TOUCH PLATE -> ";
/// What a clamp-only stop on a machine with NO Z probe tells the operator
/// (founder 2026-10-16: *"have as a warning allow without z probe"*). The
/// same cutter stays in the collet, so Z is still right — UNLESS someone
/// knocks the cutter or the spindle while moving the clamp, and nothing will
/// re-check it. ASCII only: it is written into the program as a comment.
pub const CLAMP_NO_ZCHECK: &str =
    "Z not re-checked after the clamp move - do not touch the spindle or the cutter while moving the clamp";
/// The header comment naming the first tool (`post_grblhal.rs`, preamble).
pub const TOOL_HEADER_PREFIX: &str = "tool: ";
/// The comment `job.rs` writes when the fitted collet is the wrong size.
pub const COLLET_PREFIX: &str = "collet: ";

/// What the JOB says, used only to cross-check what the PROGRAM says.
///
/// Built from a [`Job`] by [`SetupDeclared::from_job`]. It is a separate type so
/// a host whose program did not come from a `Job` can still be cross-checked —
/// and so this module states, in one place, exactly which parts of the job it
/// reads.
#[derive(Clone, Debug)]
pub struct SetupDeclared {
    pub stock: Stock,
    /// `None` = the source did not declare a material, reported as such.
    pub material: Option<Material>,
    /// Every distinct cutter the job's operations name, in operation order.
    /// The planner reorders operations by tool, so this order is NOT the order
    /// of use — the order of use is read from the program.
    pub tools: Vec<Tool>,
    /// `PostOptions::work_offset` the job asked the post for (54 = G54).
    pub work_offset: u32,
    /// Where these declarations came from, for every `source` field below.
    pub source: String,
}

impl SetupDeclared {
    pub fn from_job(job: &Job) -> Self {
        let mut tools: Vec<Tool> = Vec::new();
        for op in &job.operations {
            if !tools.iter().any(|t| t.name == op.tool.name) {
                tools.push(op.tool.clone());
            }
        }
        Self {
            stock: job.stock.clone(),
            material: Some(job.material),
            tools,
            work_offset: job.post.work_offset,
            source: format!("job `{}`", job.name),
        }
    }
}

/// One cutter, in the order the program asks for it.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct ToolStep {
    /// 0 = the tool fitted before the program starts; 1.. = each tool change.
    pub index: usize,
    /// The name exactly as the PROGRAM writes it (sanitised by the post:
    /// `(`/`)` become `_`).
    pub name: String,
    /// `None` when neither the program nor the job's tool list gives one.
    pub diameter_mm: Option<f64>,
    pub diameter_source: String,
    /// `false` ⇒ the program fits a cutter the job does not list. Also in
    /// [`SetupFacts::mismatches`].
    pub in_job_tool_list: bool,
    /// 1-based line of the comment that names this tool (header or
    /// `TOOL CHANGE ->`).
    pub named_at_line: Option<usize>,
    /// 1-based line of the `M0` that stops the program for this tool. `None`
    /// for tool 0 — it is fitted before the program is started.
    pub pause_line: Option<usize>,
}

/// One program stop for a work-holding change.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct ClampPause {
    /// What the post told the operator to do (the text after `CLAMP CHANGE ->`).
    pub instruction: String,
    pub named_at_line: usize,
    pub pause_line: usize,
}

/// An `M0` that is neither a tool change nor a clamp change. Reported, never
/// dropped: an operator meeting an unexplained stop has to know it is coming.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct OtherPause {
    pub pause_line: usize,
    /// The comment on the line before it, if any.
    pub preceding_comment: Option<String>,
}

/// A line the program carries for the operator (collet warnings).
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct ProgramNote {
    pub line: usize,
    pub text: String,
}

/// A datum the program itself SETS (`G10 L20 P<n> <axis><value>`), i.e. a
/// touch-plate result written into a work offset.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct DatumSet {
    pub line: usize,
    /// `G10 L20 P1` = G54, P2 = G55, …
    pub coordinate_system: String,
    pub axis: char,
    pub value_mm: f64,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct WorkOffsetFact {
    /// Every work-offset word the program commands (`G54`…`G59.3`), first
    /// appearance order. Normally exactly one.
    pub in_program: Vec<String>,
    pub first_line: Option<usize>,
    /// What the job asked the post for.
    pub declared: String,
    pub source: String,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct ZDatumFact {
    /// `"workpiece top"` or `"spoilboard top"` — [`crate::types::ZDatum::label`].
    pub declared: String,
    /// Emitted Z of the workpiece top face under that datum.
    pub workpiece_top_emitted_z_mm: f64,
    /// Emitted Z of the workpiece underside (= spoilboard top) under that datum.
    pub workpiece_underside_emitted_z_mm: f64,
    /// `G10 L20 … Z` lines: the program sets Z0 itself from the touch plate.
    /// Empty ⇒ the operator must set Z0 by hand before starting.
    pub set_by_program: Vec<DatumSet>,
    pub source: String,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct XyZeroFact {
    /// `G10 L20 … X/Y` lines: the program sets XY itself from a corner plate.
    pub set_by_program: Vec<DatumSet>,
    /// Plain statement of the convention, or `"not defined by the post"`.
    pub convention: String,
    pub source: String,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct WorkpieceFact {
    pub size_x_mm: f64,
    pub size_y_mm: f64,
    pub thickness_mm: f64,
    /// `None` = the source declared no material.
    pub material: Option<String>,
    /// Where the workpiece's lower-left corner sits in program XY.
    pub origin_x_mm: f64,
    pub origin_y_mm: f64,
    pub rotation_deg: f64,
    pub source: String,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct DepthFact {
    /// Most negative ABSOLUTE Z the program commands. `None` = no absolute Z
    /// word was found at all.
    pub deepest_emitted_z_mm: Option<f64>,
    pub deepest_line: Option<usize>,
    /// How far below the workpiece top that is.
    pub depth_below_top_mm: Option<f64>,
    pub workpiece_thickness_mm: f64,
    /// Does any move reach the workpiece underside?
    pub cuts_through: bool,
    /// How far past the underside, into the spoilboard. `0.0` if it does not.
    pub into_spoilboard_mm: f64,
    /// Z words NOT counted: relative-mode (`G91`) moves, probe moves (`G38.x`)
    /// and datum writes (`G10`). They are not positions in the work frame.
    pub z_words_not_counted: usize,
    pub source: String,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct SpindleFact {
    /// Every distinct `S` word, first-appearance order, rpm.
    pub rpm: Vec<f64>,
    pub first_line: Option<usize>,
    pub source: String,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct FeedFact {
    /// Every distinct cutting feed (probe feeds excluded), mm/min.
    pub cutting_mm_min: Vec<f64>,
    pub min_mm_min: Option<f64>,
    pub max_mm_min: Option<f64>,
    pub source: String,
}

/// The physical setup this program needs. Every field carries its `source`.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct SetupFacts {
    /// `true` only when the program and the job agree on every cross-checked
    /// fact AND nothing below is pending.
    pub ok: bool,
    /// Program-vs-job disagreements. Never resolved here.
    pub mismatches: Vec<String>,
    /// Facts this reader could not establish from the text, with the reason.
    pub pending: Vec<String>,
    /// Cutters in the order the program uses them.
    pub tools: Vec<ToolStep>,
    pub tool_changes: usize,
    pub clamp_changes: Vec<ClampPause>,
    /// The second stop of a cutter change on a machine with no Z probe: the
    /// person sets Z zero by hand (`ZERO_PREFIX`). Same shape as a clamp
    /// pause — what they are told, where, and the `M0`.
    pub zero_pauses: Vec<ClampPause>,
    /// The stop after a probe against a plate lying on the work: the person
    /// takes the plate off (`PLATE_PREFIX`). Same shape as a clamp pause.
    pub plate_pauses: Vec<ClampPause>,
    pub other_pauses: Vec<OtherPause>,
    pub collet_notes: Vec<ProgramNote>,
    pub work_offset: WorkOffsetFact,
    pub z_datum: ZDatumFact,
    pub xy_zero: XyZeroFact,
    pub workpiece: WorkpieceFact,
    pub depth: DepthFact,
    pub spindle: SpindleFact,
    pub feeds: FeedFact,
}

/// The same substitution the post makes before writing a comment
/// (`post_grblhal.rs` `sanitize`, private there). A job name compared against
/// program text must go through it, or a tool whose name holds a parenthesis
/// reads as a mismatch it is not.
///
/// ⚠ A COPY of a private function; `same_sanitize_as_the_post` holds them
/// together by round-tripping a name through the real post.
fn as_the_post_writes(t: &str) -> String {
    // No longer a copy (2026-10-14): the post's sanitize became ASCII-only, and a
    // second copy is exactly how the two would drift. Call the real one.
    crate::post_grblhal::sanitize(t)
}

/// `( text )` → `text`. Only a line that is a comment and nothing else.
fn whole_line_comment(line: &str) -> Option<&str> {
    let t = line.trim();
    let inner = t.strip_prefix('(')?.strip_suffix(')')?;
    Some(inner.trim())
}

/// `(letter, value-text)` words of a comment-stripped block. The value text is
/// kept so `G59.1` and `G38.2` survive as written.
fn words(code: &str) -> Vec<(char, String)> {
    let mut out = Vec::new();
    let chars: Vec<char> = code.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c.is_ascii_alphabetic() {
            let letter = c.to_ascii_uppercase();
            let mut j = i + 1;
            while j < chars.len() && chars[j] == ' ' {
                j += 1;
            }
            let start = j;
            while j < chars.len()
                && (chars[j].is_ascii_digit() || matches!(chars[j], '.' | '-' | '+'))
            {
                j += 1;
            }
            if j > start {
                out.push((letter, chars[start..j].iter().collect()));
            }
            i = j.max(i + 1);
        } else {
            i += 1;
        }
    }
    out
}

/// `End Mill - Down-cut 6mm 2F D6.00mm F2` → (`End Mill - Down-cut 6mm 2F`, 6.00).
fn parse_tool_header(s: &str) -> Option<(String, f64)> {
    let mut it = s.rsplitn(3, ' ');
    let flutes = it.next()?;
    let dia = it.next()?;
    let name = it.next()?;
    flutes.strip_prefix('F')?.parse::<u32>().ok()?;
    let d = dia.strip_prefix('D')?.strip_suffix("mm")?.parse::<f64>().ok()?;
    if name.is_empty() || !d.is_finite() {
        return None;
    }
    Some((name.to_string(), d))
}

fn push_unique(v: &mut Vec<f64>, x: f64) {
    if !v.iter().any(|y| (y - x).abs() < 1e-9) {
        v.push(x);
    }
}

// ===========================================================================
//  OPERATOR INTERVENTIONS — every stop where a person must act
// ===========================================================================
//
// Founder 2026-10-16: *"cnc clamp phase is not just clamp, if tool needs to be
// changed in general … this is generic tool change what needs to be done by
// the user"*. One shape for every kind: the program STOPS (`M0` — the only
// pause this post writes; it writes no `M6`), the change comments right before
// it say what to do, and the program may re-reference Z before it cuts again.
// Read off the EMITTED text, so the timeline, the run steps and the checklist
// describe the stops the file will actually make.
//
// ⚠ Kinds this post writes today: a cutter change and a clamp move. A
// TOOLHEAD change (spindle -> laser, drag knife) is NOT modelled anywhere in
// this core — no `Tool` or `Machine` field says which head a cutter needs —
// so no program can contain one, and none is invented here. An `M0` with no
// change comment is reported as `unexplained`, never guessed.

/// One item of work at a stop.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct InterventionItem {
    /// `cutter` | `clamps` | `plate` (take the touch plate off the work after
    /// a probe) | `zero` (a hand-zero stop that follows no cutter change —
    /// never planned by this core, reported if a program has one)
    pub kind: &'static str,
    /// The comment's text: the cutter to fit, or the clamp instruction.
    pub text: String,
    pub named_at_line: usize,
}

/// One stop the operator must deal with before pressing resume.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Intervention {
    /// 1-based line of the `M0`.
    pub pause_line: usize,
    /// Empty = an `M0` nothing explains.
    pub items: Vec<InterventionItem>,
    /// The program probes Z (`G38.x`) after this stop and before it cuts again.
    pub reprobe: bool,
    /// A cutter change on a machine with no Z probe: the program stops a
    /// SECOND time, at this 1-based `M0` line, for the person to set Z zero by
    /// hand. Part of the same intervention — no motion between the two stops.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub zero_pause_line: Option<usize>,
    /// What that second stop tells the person (the text after `SET Z ZERO ->`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub zero_instruction: Option<String>,
    /// A stated risk the person must read, the program having no check for
    /// it. Today: a clamp-only stop after which nothing re-measures Z
    /// ([`CLAMP_NO_ZCHECK`]) — derived from the EMITTED program (no `G38`
    /// after the stop, no hand zero), not from the job's settings.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

/// Every operator stop in an emitted program, in order.
pub fn interventions_of(gcode: &str) -> Vec<Intervention> {
    let lines: Vec<&str> = gcode.lines().collect();
    let mut out: Vec<Intervention> = Vec::new();
    let mut pending: Vec<InterventionItem> = Vec::new();
    let mut zero_pending: Option<(usize, String)> = None;
    // Blocks (not comments) since the last `M0` — a hand-zero stop belongs to
    // the stop before it only when nothing ran in between.
    let mut blocks_since_m0 = usize::MAX;
    for (i, raw) in lines.iter().enumerate() {
        if let Some(c) = whole_line_comment(raw) {
            if let Some(rest) = c.strip_prefix(ZERO_PREFIX) {
                zero_pending = Some((i + 1, rest.trim().to_string()));
            } else if let Some(rest) = c.strip_prefix(PLATE_PREFIX) {
                pending.push(InterventionItem { kind: "plate", text: rest.trim().into(), named_at_line: i + 1 });
            } else if let Some(rest) = c.strip_prefix(TOOL_CHANGE_PREFIX) {
                pending.push(InterventionItem { kind: "cutter", text: rest.trim().into(), named_at_line: i + 1 });
            } else if let Some(rest) = c.strip_prefix(CLAMP_CHANGE_PREFIX) {
                pending.push(InterventionItem { kind: "clamps", text: rest.trim().into(), named_at_line: i + 1 });
            }
            continue;
        }
        let code = strip_comments(raw);
        let ws = words(&code);
        if ws.is_empty() {
            continue;
        }
        let m0 = ws.iter().any(|(l, n)| *l == 'M' && n.parse::<f64>().ok() == Some(0.0));
        if !m0 {
            // A change comment is answered by the NEXT block or not at all;
            // `setup_facts` reports the mismatch, this reader drops nothing
            // silently because it only emits stops that exist.
            pending.clear();
            zero_pending = None;
            blocks_since_m0 = blocks_since_m0.saturating_add(1);
            continue;
        }
        if let Some((zl, text)) = zero_pending.take() {
            // The second stop of a hand-zeroed cutter change: folded into the
            // stop it follows, which must be a cutter change with nothing run
            // in between. Otherwise it stands alone, as a stop of its own.
            if let Some(last) = out.last_mut().filter(|l| {
                blocks_since_m0 == 0 && l.zero_pause_line.is_none() && l.items.iter().any(|it| it.kind == "cutter")
            }) {
                last.zero_pause_line = Some(i + 1);
                last.zero_instruction = Some(text);
                last.warning = None;
                blocks_since_m0 = 0;
                continue;
            }
            pending.push(InterventionItem { kind: "zero", text, named_at_line: zl });
        }
        blocks_since_m0 = 0;
        // Re-reference after the stop: a G38 before the next cutting block.
        let mut reprobe = false;
        for later in &lines[i + 1..] {
            let w = words(&strip_comments(later));
            if w.iter().any(|(l, n)| *l == 'G' && n.starts_with("38.")) {
                reprobe = true;
                break;
            }
            if w.iter().any(|(l, n)| *l == 'G' && matches!(n.as_str(), "1" | "01" | "2" | "02" | "3" | "03" | "81" | "82" | "83")) {
                break;
            }
        }
        let items = std::mem::take(&mut pending);
        let clamp_only = !items.is_empty() && items.iter().all(|it| it.kind == "clamps");
        let warning = (clamp_only && !reprobe).then(|| CLAMP_NO_ZCHECK.to_string());
        out.push(Intervention { pause_line: i + 1, items, reprobe, zero_pause_line: None, zero_instruction: None, warning });
    }
    out
}


/// Derive the physical setup from the EMITTED PROGRAM, cross-checked against
/// what the job declared.
pub fn setup_facts(declared: &SetupDeclared, gcode: &str) -> SetupFacts {
    let stock = &declared.stock;
    let datum = stock.z_datum;
    let mut mismatches: Vec<String> = Vec::new();
    let mut pending: Vec<String> = Vec::new();

    let mut tools: Vec<ToolStep> = Vec::new();
    let mut header_diameter: Option<f64> = None;
    let mut clamp_changes = Vec::new();
    let mut zero_pauses: Vec<ClampPause> = Vec::new();
    let mut awaiting_zero: Option<(usize, String)> = None;
    let mut plate_pauses: Vec<ClampPause> = Vec::new();
    let mut awaiting_plate: Option<(usize, String)> = None;
    let mut other_pauses = Vec::new();
    let mut collet_notes = Vec::new();
    let mut offsets: Vec<String> = Vec::new();
    let mut offset_line: Option<usize> = None;
    let mut z_sets = Vec::new();
    let mut xy_sets = Vec::new();
    let mut deepest: Option<(f64, usize)> = None;
    let mut z_skipped = 0usize;
    let mut rpm: Vec<f64> = Vec::new();
    let mut rpm_line: Option<usize> = None;

    // Distance mode. `None` until the program states one: a Z word before that
    // has no frame, so it is not counted (and is reported).
    let mut absolute: Option<bool> = None;
    let mut z_before_mode = 0usize;
    // The last non-blank line, for attributing an `M0` to the comment the post
    // writes immediately before it.
    let mut prev: Option<(usize, String)> = None;
    // Tool/clamp change comments waiting for their `M0`. More than one when a
    // clamp move and a cutter change share ONE stop (`post_grblhal.rs`,
    // `stop_open`): the comments come back to back and one `M0` answers all.
    let mut awaiting_pause: Vec<(usize, String, bool)> = Vec::new();

    for (i, raw) in gcode.lines().enumerate() {
        let line_no = i + 1;
        if raw.trim().is_empty() {
            continue;
        }
        if let Some(c) = whole_line_comment(raw) {
            if let Some(rest) = c.strip_prefix(TOOL_HEADER_PREFIX) {
                if tools.is_empty() {
                    match parse_tool_header(rest) {
                        Some((name, d)) => {
                            header_diameter = Some(d);
                            tools.push(ToolStep {
                                index: 0,
                                name,
                                diameter_mm: Some(d),
                                diameter_source: format!(
                                    "program line {line_no}: header `tool:` comment (2 decimals)"
                                ),
                                in_job_tool_list: false,
                                named_at_line: Some(line_no),
                                pause_line: None,
                            });
                        }
                        None => pending.push(format!(
                            "line {line_no}: a `tool:` header this reader cannot parse: `{c}`"
                        )),
                    }
                }
            } else if let Some(rest) = c.strip_prefix(TOOL_CHANGE_PREFIX) {
                awaiting_pause.push((line_no, rest.to_string(), true));
            } else if let Some(rest) = c.strip_prefix(CLAMP_CHANGE_PREFIX) {
                awaiting_pause.push((line_no, rest.to_string(), false));
            } else if let Some(rest) = c.strip_prefix(ZERO_PREFIX) {
                awaiting_zero = Some((line_no, rest.to_string()));
            } else if let Some(rest) = c.strip_prefix(PLATE_PREFIX) {
                awaiting_plate = Some((line_no, rest.to_string()));
            } else if c.starts_with(COLLET_PREFIX) {
                collet_notes.push(ProgramNote { line: line_no, text: c.to_string() });
            } else if let Some((_op, banner_tool)) = parse_banner(c) {
                // The banner names the cutter the planner meant for this
                // operation; it must be the one the program last asked for.
                match tools.last() {
                    Some(t) if t.name == banner_tool => {}
                    Some(t) => mismatches.push(format!(
                        "line {line_no}: operation banner says `{banner_tool}` but the cutter \
                         the program last asked for is `{}`",
                        t.name
                    )),
                    None => mismatches.push(format!(
                        "line {line_no}: operation banner names `{banner_tool}` before the \
                         program has named any tool"
                    )),
                }
            }
            prev = Some((line_no, c.to_string()));
            continue;
        }

        let code = strip_comments(raw);
        let ws = words(&code);
        let has_g = |v: &str| ws.iter().any(|(l, n)| *l == 'G' && n == v);
        let has_m0 = ws.iter().any(|(l, n)| *l == 'M' && n.parse::<f64>().ok() == Some(0.0));

        for (l, n) in &ws {
            if *l == 'G' {
                match n.as_str() {
                    "90" => absolute = Some(true),
                    "91" => absolute = Some(false),
                    "54" | "55" | "56" | "57" | "58" | "59" | "59.1" | "59.2" | "59.3" => {
                        let w = format!("G{n}");
                        if !offsets.contains(&w) {
                            offsets.push(w);
                        }
                        offset_line.get_or_insert(line_no);
                    }
                    _ => {}
                }
            }
        }

        // `G10 L20 P<n> <axis><v>` — the program writes a datum.
        if has_g("10") && ws.iter().any(|(l, n)| *l == 'L' && n == "20") {
            let p = ws
                .iter()
                .find(|(l, _)| *l == 'P')
                .and_then(|(_, n)| n.parse::<u32>().ok())
                .unwrap_or(0);
            let cs = if (1..=6).contains(&p) { format!("G{}", 53 + p) } else { format!("P{p}") };
            for (l, n) in &ws {
                if let ('X' | 'Y' | 'Z', Ok(v)) = (*l, n.parse::<f64>()) {
                    let s = DatumSet { line: line_no, coordinate_system: cs.clone(), axis: *l, value_mm: v };
                    if *l == 'Z' {
                        z_sets.push(s);
                    } else {
                        xy_sets.push(s);
                    }
                }
            }
        }

        let probe = ws.iter().any(|(l, n)| *l == 'G' && n.starts_with("38."));
        let datum_write = has_g("10");
        for (l, n) in &ws {
            match (*l, n.parse::<f64>()) {
                ('Z', Ok(z)) => {
                    if probe || datum_write || absolute == Some(false) {
                        z_skipped += 1;
                    } else if absolute.is_none() {
                        z_before_mode += 1;
                    } else if deepest.map_or(true, |(d, _)| z < d) {
                        deepest = Some((z, line_no));
                    }
                }
                ('S', Ok(s)) => {
                    push_unique(&mut rpm, s);
                    rpm_line.get_or_insert(line_no);
                }
                _ => {}
            }
        }

        if has_m0 {
            if let Some((l, text)) = awaiting_plate.take() {
                plate_pauses.push(ClampPause { instruction: text.trim().to_string(), named_at_line: l, pause_line: line_no });
                prev = Some((line_no, code.trim().to_string()));
                continue;
            }
        } else if let Some((l, _)) = awaiting_plate.take() {
            if !ws.is_empty() {
                mismatches.push(format!(
                    "line {l}: a touch-plate comment whose next block (line {line_no}) is not `M0` — \
                     the program would not stop for the plate to be taken off"
                ));
            }
        }
        if has_m0 {
            if let Some((l, text)) = awaiting_zero.take() {
                zero_pauses.push(ClampPause { instruction: text.trim().to_string(), named_at_line: l, pause_line: line_no });
                prev = Some((line_no, code.trim().to_string()));
                continue;
            }
        } else if let Some((l, _)) = awaiting_zero.take() {
            if !ws.is_empty() {
                mismatches.push(format!(
                    "line {l}: a set-Z-zero comment whose next block (line {line_no}) is not `M0` — \
                     the program would not stop for it"
                ));
            }
        }
        if has_m0 && awaiting_pause.is_empty() {
            other_pauses.push(OtherPause {
                pause_line: line_no,
                preceding_comment: prev.as_ref().map(|(_, c)| c.clone()),
            });
        }
        if has_m0 {
            for (l, text, is_tool) in std::mem::take(&mut awaiting_pause) {
                match (is_tool, l, text) {
                    (true, l, text) => {
                        let named = text.trim().to_string();
                        if let Some(cur) = tools.last() {
                            if cur.name == named {
                                mismatches.push(format!(
                                    "line {line_no}: the program stops to change `{named}` for \
                                     itself"
                                ));
                            }
                        }
                        tools.push(ToolStep {
                            index: tools.len(),
                            name: named,
                            diameter_mm: None,
                            diameter_source: String::new(),
                            in_job_tool_list: false,
                            named_at_line: Some(l),
                            pause_line: Some(line_no),
                        });
                    }
                    (false, l, text) => clamp_changes.push(ClampPause {
                        instruction: text.trim().to_string(),
                        named_at_line: l,
                        pause_line: line_no,
                    }),
                }
            }
        } else if !awaiting_pause.is_empty() && !ws.is_empty() {
            // The post writes the `M0` on the very next block. Anything else
            // first means the pause is not where the comment says it is.
            for (l, _, _) in std::mem::take(&mut awaiting_pause) {
                mismatches.push(format!(
                    "line {l}: a change comment whose next block (line {line_no}) is not `M0` — \
                     the program would not stop for it"
                ));
            }
        }
        prev = Some((line_no, code.trim().to_string()));
    }
    for (l, _, _) in awaiting_pause {
        mismatches.push(format!(
            "line {l}: a change comment at the end of the program with no `M0` after it"
        ));
    }
    if z_before_mode > 0 {
        pending.push(format!(
            "{z_before_mode} Z word(s) appear before any G90/G91 — no frame, not counted in depth"
        ));
    }

    // ---- tools: cross-check program against the job's list -----------------
    if tools.is_empty() && !gcode.trim().is_empty() {
        pending.push(
            "the program names no tool (no `tool:` header) — comments may be switched off; the \
             cutter to fit cannot be read from this program"
                .into(),
        );
    }
    for step in tools.iter_mut() {
        let found = declared.tools.iter().find(|t| as_the_post_writes(&t.name) == step.name);
        step.in_job_tool_list = found.is_some();
        match found {
            None => mismatches.push(format!(
                "the program fits `{}` (line {}) and the job's tool list does not contain it",
                step.name,
                step.named_at_line.unwrap_or(0)
            )),
            Some(t) => {
                if step.index == 0 {
                    // The header writes 2 decimals; 3.175 prints as 3.17.
                    if let Some(d) = header_diameter {
                        if (d - t.diameter_mm).abs() > 0.005 + 1e-9 {
                            mismatches.push(format!(
                                "header says `{}` is D{d}mm, the job's tool list says {}mm",
                                step.name, t.diameter_mm
                            ));
                        }
                    }
                    step.diameter_mm = Some(t.diameter_mm);
                    step.diameter_source = format!(
                        "{}; agrees with job tool list ({}mm) within the header's 2 decimals",
                        step.diameter_source, t.diameter_mm
                    );
                } else {
                    step.diameter_mm = Some(t.diameter_mm);
                    step.diameter_source = format!(
                        "{} tool list, matched by name — the TOOL CHANGE comment carries no \
                         diameter",
                        declared.source
                    );
                }
            }
        }
        if step.diameter_mm.is_none() && step.diameter_source.is_empty() {
            step.diameter_source = "unknown: not in the program text and not in the job's tool \
                                    list"
                .into();
        }
    }
    for t in &declared.tools {
        let w = as_the_post_writes(&t.name);
        if !tools.iter().any(|s| s.name == w) {
            mismatches.push(format!(
                "{} lists `{}` and the program never asks for it",
                declared.source, t.name
            ));
        }
    }

    // ---- work offset --------------------------------------------------------
    let declared_offset = format!("G{}", declared.work_offset);
    if offsets.is_empty() {
        pending.push("the program commands no work offset (G54…G59)".into());
    } else if offsets.len() > 1 || offsets[0] != declared_offset {
        mismatches.push(format!(
            "the program commands {} and the job asked for {declared_offset}",
            offsets.join(", ")
        ));
    }

    // ---- depth --------------------------------------------------------------
    let top = datum.surface_z_mm(stock);
    let underside = datum.through_z_mm(stock);
    let (deepest_z, deepest_line) = match deepest {
        Some((z, l)) => (Some(z), Some(l)),
        None => (None, None),
    };
    let cuts_through = deepest_z.is_some_and(|z| z <= underside + 1e-6);
    let into_spoilboard = deepest_z.map_or(0.0, |z| (underside - z).max(0.0));

    let feeds = cutting_feeds_in_program(gcode);
    let fmin = feeds.iter().cloned().fold(None, |a: Option<f64>, v| Some(a.map_or(v, |a| a.min(v))));
    let fmax = feeds.iter().cloned().fold(None, |a: Option<f64>, v| Some(a.map_or(v, |a| a.max(v))));

    let xy_convention = if xy_sets.is_empty() {
        "not defined by the post: the program writes no XY datum. Program XY is the planner's \
         frame (Stock::place) — the workpiece's lower-left corner at the origin given in \
         `workpiece`, measured from the work offset's XY zero — and the operator must set that \
         XY zero before starting"
            .to_string()
    } else {
        "set by the program from a corner plate (G10 L20 lines in `set_by_program`); the value \
         written is the plate corner's position in program XY, so XY zero lands where the \
         planner's frame puts it"
            .to_string()
    };

    let ok = mismatches.is_empty() && pending.is_empty();
    SetupFacts {
        ok,
        tool_changes: tools.len().saturating_sub(1),
        tools,
        clamp_changes,
        zero_pauses,
        plate_pauses,
        other_pauses,
        collet_notes,
        work_offset: WorkOffsetFact {
            in_program: offsets,
            first_line: offset_line,
            declared: declared_offset,
            source: format!(
                "program: G54…G59.3 words; declared: {} PostOptions::work_offset",
                declared.source
            ),
        },
        z_datum: ZDatumFact {
            declared: datum.label().to_string(),
            workpiece_top_emitted_z_mm: top,
            workpiece_underside_emitted_z_mm: underside,
            set_by_program: z_sets,
            source: format!(
                "{} Stock::z_datum — the emitted text carries no datum statement; top/underside \
                 via ZDatum::surface_z_mm / through_z_mm. `set_by_program` read from G10 L20 lines",
                declared.source
            ),
        },
        xy_zero: XyZeroFact {
            set_by_program: xy_sets,
            convention: xy_convention,
            source: "program: G10 L20 X/Y lines; convention: post_grblhal.rs (writes XY only in \
                     the corner-plate probe) and types.rs Stock::place"
                .into(),
        },
        workpiece: WorkpieceFact {
            size_x_mm: stock.size_x_mm,
            size_y_mm: stock.size_y_mm,
            thickness_mm: stock.thickness_mm,
            material: declared.material.map(|m| m.as_str().to_string()),
            origin_x_mm: stock.origin_x_mm,
            origin_y_mm: stock.origin_y_mm,
            rotation_deg: stock.rotation_deg,
            source: format!(
                "{} Stock + material — the program text does not carry the workpiece",
                declared.source
            ),
        },
        depth: DepthFact {
            deepest_emitted_z_mm: deepest_z,
            deepest_line,
            depth_below_top_mm: deepest_z.map(|z| top - z),
            workpiece_thickness_mm: stock.thickness_mm,
            cuts_through,
            into_spoilboard_mm: into_spoilboard,
            z_words_not_counted: z_skipped,
            source: format!(
                "program: most negative absolute Z (G90; G91/G38.x/G10 excluded); compared with \
                 the workpiece underside at emitted Z {underside:.3} ({} datum)",
                datum.label()
            ),
        },
        spindle: SpindleFact {
            rpm,
            first_line: rpm_line,
            source: "program: S words".into(),
        },
        feeds: FeedFact {
            cutting_mm_min: feeds,
            min_mm_min: fmin,
            max_mm_min: fmax,
            source: "program: feeds::cutting_feeds_in_program (F words, probe feeds excluded)"
                .into(),
        },
        mismatches,
        pending,
    }
}

/// The setup answer, as the CLI and the browser both get it — for a reference
/// job ([`setup_for_reference_job`]) and for an imported design
/// ([`setup_for_import`] / [`setup_for_import_many`]) alike.
#[derive(Clone, Debug, Serialize)]
pub struct SetupAnswer {
    /// The job name the planning door reported (`plate`, `imported.stl`, …).
    pub job: String,
    /// `true` ⇒ a program exists AND its setup facts are clean.
    pub ok: bool,
    /// Why there is no setup checklist: the job's own refusals/errors. A
    /// program that must not be sent gets no checklist.
    pub refused: Vec<String>,
    pub facts: Option<SetupFacts>,
    /// SHA-256 (lower-case hex) of the exact G-code text these facts were read
    /// from. `None` exactly when `facts` is `None`.
    ///
    /// 🔴 It is how a host proves the checklist on screen belongs to the program
    /// it is about to download: hash the `gcode` its own plan call returned and
    /// compare. Unequal means the two calls planned different jobs (a different
    /// config, a different placement, a stale wasm) and the checklist describes
    /// a program the machine will not run.
    pub gcode_sha256: Option<String>,
}

/// THE ONE DOOR both setup paths go through: a [`crate::fixtures::Report`] from
/// a checked planning call, and the declarations to cross-check its program
/// against.
///
/// `declared` is a closure so a refused plan never builds them — a refusal has
/// no program, and declarations with nothing to check are not needed.
fn answer_from_report(
    report: &crate::fixtures::Report,
    declared: impl FnOnce() -> (SetupDeclared, Vec<String>),
) -> SetupAnswer {
    if !report.ok || report.gcode.trim().is_empty() {
        let mut refused: Vec<String> =
            report.refusals.iter().chain(report.errors.iter()).cloned().collect();
        if refused.is_empty() {
            refused.push("the job emitted no program".into());
        }
        return SetupAnswer {
            job: report.job.clone(),
            ok: false,
            refused,
            facts: None,
            gcode_sha256: None,
        };
    }
    let (declared, undeclared) = declared();
    let mut facts = setup_facts(&declared, &report.gcode);
    // A fact the operator never declared, which the planner therefore took
    // from a default, is PENDING — "nobody said" and "checked" are different
    // facts and only the second is safe (the undeclared-fixture rule).
    if !undeclared.is_empty() {
        facts.pending.extend(undeclared);
        facts.ok = false;
    }
    SetupAnswer {
        job: report.job.clone(),
        ok: facts.ok,
        refused: Vec::new(),
        facts: Some(facts),
        gcode_sha256: Some(sha256_hex(report.gcode.as_bytes())),
    }
}

/// Plan a reference job through the SAME checked door every host uses
/// ([`crate::fixtures::plan_report`]) and derive its setup from the program that
/// door emitted. `None` = unknown job name.
///
/// The job is built a second time for the declarations (`build` + `apply`, the
/// same two calls `plan_report` makes); both are deterministic.
pub fn setup_for_reference_job(
    name: &str,
    plant: crate::fixtures::JobPlant,
    cfg: &crate::fixtures::JobConfig,
    sim_cell_mm: f64,
) -> Option<SetupAnswer> {
    let report = crate::fixtures::plan_report(name, plant, cfg, sim_cell_mm)?;
    let mut built = crate::fixtures::build(name, plant)?;
    cfg.apply(&mut built);
    let mut a = answer_from_report(&report, || (SetupDeclared::from_job(&built.job), Vec::new()));
    // The reference door reports under the fixture's own name.
    a.job = name.to_string();
    Some(a)
}

/// Setup for ONE imported drawing — the bytes, format and section Z exactly as
/// the wasm `plan_import_bytes` takes them — planned by the SAME core call that
/// export makes ([`crate::fixtures::plan_report_import_bytes`], a one-element
/// [`crate::fixtures::plan_report_import_many`]).
///
/// The surface and loaded-mesh requests are not arguments: they change the size
/// of the answer, never the program (see `report_of_with_surface`).
pub fn setup_for_import(
    data: &[u8],
    format: &str,
    z_section_mm: Option<f64>,
    cfg: &crate::fixtures::JobConfig,
    sim_cell_mm: f64,
) -> SetupAnswer {
    let report =
        crate::fixtures::plan_report_import_bytes(data, format, z_section_mm, cfg, sim_cell_mm);
    answer_from_report(&report, || declared_for_import(cfg, &report))
}

/// Setup for N placed drawings — the engine the browser plans EVERY import
/// through ([`crate::fixtures::plan_report_import_many`], wasm
/// `plan_import_many`), so a drawing dragged or turned on the workpiece gets the
/// checklist of the program that is actually cut.
pub fn setup_for_import_many(
    sources: &[crate::fixtures::ImportSource<'_>],
    cfg: &crate::fixtures::JobConfig,
    sim_cell_mm: f64,
) -> SetupAnswer {
    let report = crate::fixtures::plan_report_import_many(sources, cfg, sim_cell_mm, None, None);
    answer_from_report(&report, || declared_for_import(cfg, &report))
}

/// What an IMPORTED job declares, for the cross-check.
///
/// The import engine builds its `Job` internally and does not return it, so the
/// declarations are taken from the two things that DO come out of that one
/// call, never from a second planning run:
///
/// - **stock, material, work offset**: `Job::new` + `JobConfig::apply` — the
///   same constructor and the same apply the engine runs. Operations are
///   irrelevant to these fields; no geometry is read or planned here.
/// - **tools**: the planner's own `tools_used` from that report (the job's
///   grouped operations, in order of use — `job.rs`, not the program text),
///   each resolved to its full record in `cfg.merged_library` by name. A name
///   the library cannot resolve is NOT given an invented diameter: it is
///   declared by name only and reported as pending.
///
/// Returns the declarations and the list of facts the CONFIG did not declare
/// (workpiece size/thickness, material): the planner fell back to a default
/// for those, and a checklist built on a default is pending, not clean.
fn declared_for_import(
    cfg: &crate::fixtures::JobConfig,
    report: &crate::fixtures::Report,
) -> (SetupDeclared, Vec<String>) {
    use crate::fixtures::{BuiltJob, JobPlant};
    use crate::types::Machine;
    let mut built = BuiltJob {
        job: Job::new(report.job.clone(), Machine::default(), Stock::default()),
        dogbones: Vec::new(),
        keep: Vec::new(),
        remove: Vec::new(),
        remove_depth_mm: 0.0,
        notes: Vec::new(),
        plant: JobPlant::None,
    };
    cfg.apply(&mut built);

    let mut undeclared: Vec<String> = Vec::new();
    let st = cfg.stock.as_ref();
    for (field, have, used) in [
        ("stock.size_x_mm", st.and_then(|s| s.size_x_mm), built.job.stock.size_x_mm),
        ("stock.size_y_mm", st.and_then(|s| s.size_y_mm), built.job.stock.size_y_mm),
        ("stock.thickness_mm", st.and_then(|s| s.thickness_mm), built.job.stock.thickness_mm),
    ] {
        if have.is_none() {
            undeclared.push(format!(
                "`{field}` is not declared in the config, so the planner used the default \
                 {used}mm — measure the workpiece and declare it"
            ));
        }
    }
    let material = match cfg.material.as_deref() {
        None => {
            undeclared.push(format!(
                "`material` is not declared in the config, so feeds were planned for the \
                 default ({}) — declare the material that is actually on the bed",
                built.job.material.as_str()
            ));
            None
        }
        Some(m) if crate::tools::Material::from_str(m).is_some() => Some(built.job.material),
        Some(m) => {
            undeclared.push(format!(
                "`material` \"{m}\" is not a material this core knows, so feeds were planned \
                 for {} — declare one it recognises",
                built.job.material.as_str()
            ));
            None
        }
    };

    let mut notes = Vec::new();
    let lib = cfg.merged_library(&mut notes);
    let mut tools: Vec<Tool> = Vec::new();
    for name in &report.tools_used {
        if tools.iter().any(|t| &t.name == name) {
            continue;
        }
        match lib.iter().find(|s| &s.tool.name == name) {
            Some(s) => tools.push(s.tool.clone()),
            None => {
                undeclared.push(format!(
                    "the planner used `{name}`, which the config's tool library cannot resolve \
                     by name, so its diameter is unknown here"
                ));
                tools.push(Tool { name: name.clone(), ..Tool::default() });
            }
        }
    }

    let declared = SetupDeclared {
        stock: built.job.stock.clone(),
        material,
        tools,
        work_offset: built.job.post.work_offset,
        source: format!("imported job `{}` (config + planner tools_used)", report.job),
    };
    (declared, undeclared)
}

/// SHA-256 of `data`, lower-case hex. FIPS 180-4; no dependency, because the
/// core's dependency list is not this module's to widen. Pinned by the
/// standard test vectors in `setup_sha256_matches_the_fips_vectors`.
pub fn sha256_hex(data: &[u8]) -> String {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];
    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];
    let mut msg = data.to_vec();
    let bit_len = (data.len() as u64).wrapping_mul(8);
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bit_len.to_be_bytes());
    for chunk in msg.chunks(64) {
        let mut w = [0u32; 64];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([chunk[4 * i], chunk[4 * i + 1], chunk[4 * i + 2], chunk[4 * i + 3]]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16].wrapping_add(s0).wrapping_add(w[i - 7]).wrapping_add(s1);
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh] = h;
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let t1 = hh.wrapping_add(s1).wrapping_add(ch).wrapping_add(K[i]).wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(maj);
            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b;
            b = a;
            a = t1.wrapping_add(t2);
        }
        for (x, v) in h.iter_mut().zip([a, b, c, d, e, f, g, hh]) {
            *x = x.wrapping_add(v);
        }
    }
    h.iter().map(|x| format!("{x:08x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fixtures::{plan_report, JobConfig, JobPlant};

    fn answer(name: &str) -> (SetupFacts, String) {
        let r = plan_report(name, JobPlant::None, &JobConfig::default(), 0.6).unwrap();
        assert!(r.ok, "{name} must plan clean: {:?}", r.refusals);
        let a = setup_for_reference_job(name, JobPlant::None, &JobConfig::default(), 0.6).unwrap();
        (a.facts.expect("a clean job has facts"), r.gcode)
    }

    fn line(g: &str, n: usize) -> &str {
        g.lines().nth(n - 1).unwrap()
    }

    #[test]
    fn setup_multi_tool_reads_the_tool_change_from_the_text() {
        let (f, g) = answer("multi-tool");
        assert!(f.ok, "mismatches {:?} pending {:?}", f.mismatches, f.pending);
        assert_eq!(f.tools.len(), 2, "{:?}", f.tools);
        assert_eq!(f.tool_changes, 1);
        // Tool 0 from the header, tool 1 from the TOOL CHANGE comment, each
        // checked against the line it claims.
        let t0 = &f.tools[0];
        assert!(line(&g, t0.named_at_line.unwrap()).contains(&format!("tool: {}", t0.name)));
        assert!((t0.diameter_mm.unwrap() - 3.175).abs() < 1e-9);
        let t1 = &f.tools[1];
        assert!(line(&g, t1.named_at_line.unwrap())
            .contains(&format!("{TOOL_CHANGE_PREFIX}{}", t1.name)));
        assert_eq!(line(&g, t1.pause_line.unwrap()).trim(), "M0");
        assert_eq!(t1.diameter_mm, Some(6.0));
        // Every M0 in the text is accounted for.
        let m0 = g.lines().filter(|l| l.trim() == "M0").count();
        assert_eq!(m0, f.tool_changes + f.clamp_changes.len() + f.plate_pauses.len() + f.other_pauses.len());
        // Collet warning is in the text and reported.
        assert!(!f.collet_notes.is_empty());
        // Touch plate: the program writes Z0 itself.
        assert!(!f.z_datum.set_by_program.is_empty());
        assert_eq!(f.work_offset.in_program, vec!["G54".to_string()]);
    }

    #[test]
    fn setup_plate_depth_and_spindle_match_the_emitted_words() {
        let (f, g) = answer("plate");
        assert!(f.ok, "mismatches {:?} pending {:?}", f.mismatches, f.pending);
        // Recompute the deepest Z independently: absolute-mode, non-probe,
        // non-G10 lines only.
        let mut abs = false;
        let mut want = f64::INFINITY;
        for l in g.lines() {
            let c = strip_comments(l);
            if c.contains("G90") {
                abs = true;
            }
            if c.contains("G91") {
                abs = false;
            }
            if !abs || c.contains("G38.") || c.contains("G10") {
                continue;
            }
            for w in c.split_whitespace() {
                if let Some(v) = w.strip_prefix('Z').and_then(|v| v.parse::<f64>().ok()) {
                    want = want.min(v);
                }
            }
        }
        let got = f.depth.deepest_emitted_z_mm.unwrap();
        assert!((got - want).abs() < 1e-9, "deepest {got} vs independent {want}");
        assert!(line(&g, f.depth.deepest_line.unwrap()).contains(&format!("Z{got:.3}")));
        let t = f.workpiece.thickness_mm;
        assert_eq!(f.depth.cuts_through, got <= -t + 1e-6);
        assert!((f.depth.into_spoilboard_mm - (-t - got).max(0.0)).abs() < 1e-9);
        // Every S word appears in the text.
        assert!(!f.spindle.rpm.is_empty());
        for s in &f.spindle.rpm {
            assert!(g.contains(&format!("S{s:.0}")), "S{s} not in program");
        }
        assert!(f.feeds.min_mm_min.unwrap() <= f.feeds.max_mm_min.unwrap());
        assert_eq!(f.z_datum.declared, "workpiece top");
    }

    /// 🔴 THE NEGATIVE CONTROL: a TOOL CHANGE the job does not list must be a
    /// mismatch, and must flip `ok`.
    #[test]
    fn setup_plant_unknown_tool_change_is_a_mismatch() {
        let (_, g) = answer("multi-tool");
        let built = crate::fixtures::build("multi-tool", JobPlant::None).unwrap();
        let declared = SetupDeclared::from_job(&built.job);
        let planted = g.replacen(
            "( TOOL CHANGE -> End Mill - Down-cut 6mm 2F )",
            "( TOOL CHANGE -> V-bit 90deg PLANTED )",
            1,
        );
        assert_ne!(planted, g, "the plant must actually change the program");
        let f = setup_facts(&declared, &planted);
        assert!(!f.ok);
        assert!(
            f.mismatches.iter().any(|m| m.contains("V-bit 90deg PLANTED")
                && m.contains("does not contain it")),
            "{:?}",
            f.mismatches
        );
        // And the job's 6mm is now never asked for — also reported.
        assert!(f.mismatches.iter().any(|m| m.contains("never asks for it")), "{:?}", f.mismatches);
    }

    /// A job the planner refuses gets NO checklist — a setup list for a program
    /// that must not be sent is an instruction to run it.
    #[test]
    fn setup_refused_job_gets_no_facts() {
        let p = crate::fixtures::job_plant_from("cut-clamp").unwrap();
        let a = setup_for_reference_job("clamped", p, &JobConfig::default(), 0.6).unwrap();
        assert!(!a.ok);
        assert!(a.facts.is_none());
        assert!(!a.refused.is_empty());
    }

    #[test]
    fn setup_clamp_change_and_bare_m0_are_reported_not_dropped() {
        let declared = SetupDeclared {
            stock: Stock::default(),
            material: None,
            tools: vec![Tool { name: "T6".into(), ..Tool::default() }],
            work_offset: 54,
            source: "test".into(),
        };
        let g = "( tool: T6 D6.00mm F2 )\nG17 G21 G90 G54 G94 G40\nG0 Z5.000\nM3 S12000\n\
                 G1 Z-19.500 F300.0\nG0 Z5.000\nM5\n( CLAMP CHANGE -> phase 2: move bar )\nM0\n\
                 ( operator check )\nM0\nM30\n";
        let f = setup_facts(&declared, g);
        assert_eq!(f.clamp_changes.len(), 1);
        assert_eq!(f.clamp_changes[0].pause_line, 9);
        assert_eq!(f.other_pauses.len(), 1);
        assert_eq!(f.other_pauses[0].pause_line, 11);
        assert!(f.depth.cuts_through);
        assert!((f.depth.into_spoilboard_mm - 1.5).abs() < 1e-9);
        assert_eq!(f.spindle.rpm, vec![12000.0]);
        assert_eq!(f.workpiece.material, None);
    }

    #[test]
    fn setup_header_diameter_disagreeing_with_job_is_a_mismatch() {
        let declared = SetupDeclared {
            stock: Stock::default(),
            material: None,
            tools: vec![Tool { name: "T6".into(), diameter_mm: 6.0, ..Tool::default() }],
            work_offset: 54,
            source: "test".into(),
        };
        let f = setup_facts(&declared, "( tool: T6 D8.00mm F2 )\nG90 G54\nG0 Z5\n");
        assert!(f.mismatches.iter().any(|m| m.contains("D8mm")), "{:?}", f.mismatches);
    }

    /// The copy of the post's private `sanitize` must agree with the real post:
    /// a tool name with parentheses, emitted by the real post, must cross-check
    /// clean.
    #[test]
    fn setup_same_sanitize_as_the_post() {
        use crate::types::{Machine, OperationParams, Toolpath, Move, Vec3};
        let tool = Tool { name: "Odd (v2) cutter".into(), ..Tool::default() };
        let mut path = Toolpath {
            moves: vec![Move::spindle_on(18000.0), Move::feed_to(Vec3::new(10.0, 10.0, -1.0), 600.0)],
            tool: tool.clone(),
            ..Default::default()
        };
        path.recompute_bounds();
        let stock = Stock::default();
        let r = crate::post_grblhal(
            &path,
            &Machine::default(),
            &stock,
            &OperationParams::default(),
            &crate::PostOptions::default(),
        );
        assert!(r.gcode.contains("Odd _v2_ cutter"), "{}", r.gcode);
        let declared = SetupDeclared {
            stock,
            material: None,
            tools: vec![tool],
            work_offset: 54,
            source: "test".into(),
        };
        let f = setup_facts(&declared, &r.gcode);
        assert!(f.tools[0].in_job_tool_list, "{:?}", f.mismatches);
    }

    // ---- the IMPORT path ----------------------------------------------------

    /// A 100 x 60 x 18 plate with a 20 x 20 square through-hole, as a closed
    /// BINARY STL built by hand (top + bottom annulus, outer + inner walls), at
    /// (50, 50) on the bed. Binary because that is the flavour the browser
    /// meshes a catalogue SCAD to.
    fn plate_with_hole_stl() -> Vec<u8> {
        let (x0, y0, sx, sy, t) = (50.0f32, 50.0f32, 100.0f32, 60.0f32, 18.0f32);
        let (hx0, hy0, hs) = (x0 + 40.0, y0 + 20.0, 20.0f32);
        let outer = [[x0, y0], [x0 + sx, y0], [x0 + sx, y0 + sy], [x0, y0 + sy]];
        let inner = [[hx0, hy0], [hx0 + hs, hy0], [hx0 + hs, hy0 + hs], [hx0, hy0 + hs]];
        let mut tris: Vec<[[f32; 3]; 3]> = Vec::new();
        let p = |q: [f32; 2], z: f32| [q[0], q[1], z];
        for i in 0..4 {
            let j = (i + 1) % 4;
            // Top and bottom: the trapezoid between outer edge i and inner edge i.
            for z in [0.0, t] {
                tris.push([p(outer[i], z), p(outer[j], z), p(inner[j], z)]);
                tris.push([p(outer[i], z), p(inner[j], z), p(inner[i], z)]);
            }
            // Outer and inner walls.
            for ring in [&outer, &inner] {
                tris.push([p(ring[i], 0.0), p(ring[j], 0.0), p(ring[j], t)]);
                tris.push([p(ring[i], 0.0), p(ring[j], t), p(ring[i], t)]);
            }
        }
        let mut out = vec![0u8; 80];
        out.extend_from_slice(&(tris.len() as u32).to_le_bytes());
        for tri in &tris {
            out.extend_from_slice(&[0u8; 12]);
            for v in tri {
                for c in v {
                    out.extend_from_slice(&c.to_le_bytes());
                }
            }
            out.extend_from_slice(&[0u8; 2]);
        }
        out
    }

    fn import_cfg() -> JobConfig {
        serde_json::from_str(
            r#"{"tool_id":"End Mill - Down-cut 6mm 2F","material":"Plywood",
                "stock":{"size_x_mm":300,"size_y_mm":200,"thickness_mm":18}}"#,
        )
        .unwrap()
    }

    #[test]
    fn an_import_never_probes_with_the_reference_fixtures_plate() {
        // bughunt 2026-11-15: the import job borrowed the reference machine, so a host that
        // sent no plate got `G10 L20 P1 Z1.600` (a fixture constant) and setup called it a fact.
        let stl = plate_with_hole_stl();
        let r = crate::fixtures::plan_report_import_bytes(&stl, "auto", Some(9.0), &import_cfg(), 2.0);
        assert!(r.ok, "{:?} {:?}", r.refusals, r.errors);
        assert!(!r.gcode.contains("G38.2") && !r.gcode.contains("G10 L20"), "an import probed with nobody's plate");
        // Probing turned on with no plate stated: REFUSED (decision #43), never 1.6.
        let mut cfg: JobConfig = serde_json::from_str(
            r#"{"tool_id":"End Mill - Down-cut 6mm 2F","material":"Plywood","machine":{"probe_enabled":true},
                "stock":{"size_x_mm":300,"size_y_mm":200,"thickness_mm":18}}"#,
        )
        .unwrap();
        let r = crate::fixtures::plan_report_import_bytes(&stl, "auto", Some(9.0), &cfg, 2.0);
        assert!(!r.ok && !r.gcode.contains("Z1.600"), "probing with an undeclared plate was planned");
        cfg = serde_json::from_str(
            r#"{"tool_id":"End Mill - Down-cut 6mm 2F","material":"Plywood","machine":{"probe_enabled":true,"touch_plate_mm":15},
                "stock":{"size_x_mm":300,"size_y_mm":200,"thickness_mm":18}}"#,
        )
        .unwrap();
        let r = crate::fixtures::plan_report_import_bytes(&stl, "auto", Some(9.0), &cfg, 2.0);
        assert!(r.ok && r.gcode.contains("G10 L20 P1 Z15.000"), "a stated plate was not used");
    }

    #[test]
    fn setup_import_reads_the_plate_with_a_hole_off_the_emitted_program() {
        let stl = plate_with_hole_stl();
        let cfg = import_cfg();
        // The plan the browser gets — the same core call.
        let r = crate::fixtures::plan_report_import_bytes(&stl, "auto", Some(9.0), &cfg, 2.0);
        assert!(r.ok, "the import must plan: refusals {:?} errors {:?}", r.refusals, r.errors);
        assert!(
            r.notes.iter().any(|n| n.contains("1 part(s) imported with 1 interior feature")),
            "the hole was lost in the section: {:?}",
            r.notes
        );
        let a = setup_for_import(&stl, "auto", Some(9.0), &cfg, 2.0);
        assert!(a.refused.is_empty(), "{:?}", a.refused);
        let f = a.facts.as_ref().expect("a planned import has facts");
        assert!(a.ok && f.ok, "mismatches {:?} pending {:?}", f.mismatches, f.pending);
        assert!(f.mismatches.is_empty(), "{:?}", f.mismatches);
        // The checklist belongs to THIS program, byte for byte.
        assert_eq!(a.gcode_sha256.as_deref(), Some(sha256_hex(r.gcode.as_bytes()).as_str()));
        assert_eq!(a.job, r.job);
        // Workpiece from the config, not a default.
        assert_eq!(f.workpiece.thickness_mm, 18.0);
        assert_eq!((f.workpiece.size_x_mm, f.workpiece.size_y_mm), (300.0, 200.0));
        assert_eq!(f.workpiece.material.as_deref(), Some("Plywood"));
        // Every tool is named on the line the facts claim.
        assert!(!f.tools.is_empty());
        for t in &f.tools {
            assert!(t.in_job_tool_list, "{t:?}");
            let l = line(&r.gcode, t.named_at_line.unwrap());
            assert!(l.contains(&t.name), "line {:?} does not name {}", l, t.name);
        }
        // A through-cut: the deepest emitted Z reaches the underside.
        let deepest = f.depth.deepest_emitted_z_mm.unwrap();
        assert!(f.depth.cuts_through, "deepest {deepest} vs underside -18");
        assert!(deepest <= -18.0 + 1e-6 && deepest > -20.0, "deepest {deepest}");
        assert!(line(&r.gcode, f.depth.deepest_line.unwrap()).contains(&format!("Z{deepest:.3}")));
    }

    #[test]
    fn setup_import_many_is_the_same_answer_for_one_drawing_as_drawn() {
        let stl = plate_with_hole_stl();
        let cfg = import_cfg();
        let one = setup_for_import(&stl, "auto", Some(9.0), &cfg, 2.0);
        let mut src = crate::fixtures::ImportSource::as_drawn(
            crate::fixtures::LONE_DRAWING_ID,
            &stl,
            "auto",
        );
        src.z_section_mm = Some(9.0);
        let many = setup_for_import_many(std::slice::from_ref(&src), &cfg, 2.0);
        assert_eq!(one.gcode_sha256, many.gcode_sha256);
        assert_eq!(one.facts, many.facts);
    }

    /// A refused import gets NO checklist — no tool selected is the founder's
    /// case, and the plan refuses it rather than substituting a cutter.
    #[test]
    fn setup_import_with_no_tool_is_refused_with_no_facts() {
        let stl = plate_with_hole_stl();
        let cfg: JobConfig = serde_json::from_str(
            r#"{"material":"Plywood","stock":{"size_x_mm":300,"size_y_mm":200,"thickness_mm":18}}"#,
        )
        .unwrap();
        let a = setup_for_import(&stl, "auto", Some(9.0), &cfg, 2.0);
        assert!(!a.ok);
        assert!(a.facts.is_none());
        assert!(a.gcode_sha256.is_none());
        assert!(!a.refused.is_empty());
    }

    /// An undeclared workpiece or material is planned on a default — so the
    /// checklist is PENDING on it, never clean.
    #[test]
    fn setup_import_on_a_default_workpiece_is_pending_not_clean() {
        let stl = plate_with_hole_stl();
        let cfg: JobConfig =
            serde_json::from_str(r#"{"tool_id":"End Mill - Down-cut 6mm 2F"}"#).unwrap();
        let a = setup_for_import(&stl, "auto", Some(9.0), &cfg, 2.0);
        // Measured 2026-10-14: the default workpiece (600x900x18) plans this
        // part, so there IS a program — and its checklist must not be clean.
        let f = a.facts.as_ref().expect("the default workpiece plans this part");
        assert!(!a.ok && !f.ok);
        assert!(f.pending.iter().any(|p| p.contains("stock.thickness_mm")), "{:?}", f.pending);
        assert!(f.pending.iter().any(|p| p.contains("`material`")), "{:?}", f.pending);
        assert_eq!(f.workpiece.material, None);
        assert!(f.mismatches.is_empty(), "{:?}", f.mismatches);
    }

    #[test]
    fn setup_sha256_matches_the_fips_vectors() {
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            sha256_hex(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
            "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
        );
    }
}
