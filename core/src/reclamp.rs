//! **Re-clamping mid-job** — when a cut has to pass where a clamp stands, the
//! job is split into two clamping phases with a pause between them.
//!
//! Copyright (C) 2026 2BEE FARM PTY LTD.
//! Licensed under the GNU Affero General Public License v3 or later.
//!
//! # The founder's question this answers (2026-10-16)
//!
//! *"How the tool will cut under the clamp? if the clamp needs to be removed and
//! reapplied during the job show it in the timeline and the 3d"* — and earlier,
//! *"so I have to move the clamps(s) during the job? have multiple phases?"*
//!
//! It does not cut under the clamp. Ever. The fixture check refuses any cutting
//! move that enters a clamp footprint (`FixtureFinding::CutsClamp`), and that
//! does not change here. What changes is that a job whose outline runs under a
//! clamp is no longer a dead end:
//!
//! 1. **Phase 1** cuts every operation that is clear of the clamps as they were
//!    fitted (set A).
//! 2. **The program stops** — the post's existing work-holding pause:
//!    retract, `M5`, `( CLAMP CHANGE -> … )`, `M0` (`post_grblhal.rs`,
//!    `MoveKind::ClampChange`), then a Z re-reference when the job asks for one.
//!    No new dialect: it is the same observable a tool change already has.
//! 3. **The operator moves the named clamps** to positions B — one at a time,
//!    the others staying tight, so the work is never loose.
//! 4. **Phase 2** cuts the rest, checked against set B.
//!
//! # What makes a position B acceptable — all four, or no plan
//!
//! * **Clear of EVERY cut in the job**, not only the ones still to come, at the
//!   largest cutter radius in the job — the same margin the fixture check uses
//!   on the assembled program. Clear of the cuts already made means the clamp
//!   is set down on material that is still standing, never on a kerf and never
//!   on a part phase 1 has already freed.
//! * **The same grip on the work.** B is A slid along the clamp's own axes, and
//!   only to where the area of the footprint over the workpiece is within 5% of
//!   what A had. A clamp that reached 30 mm onto the work still reaches 30 mm
//!   onto it. Sliding it further on would move a toggle clamp's bolted base
//!   onto the work, and sliding it off would loosen the grip — the footprint
//!   model cannot tell a base from a pad, so neither is offered.
//! * **Not on top of another clamp** in set B.
//! * **At least one other clamp stays tight while it moves.** A job held by one
//!   clamp cannot move it without letting the work go, so that is refused.
//!
//! # A part's interior and its release stay in order
//!
//! If a hole of a part goes to phase 2, that part's outline goes to phase 2 as
//! well — through `optimise::release_attribution`, the same "which outline
//! frees which hole" the router already uses. Cutting the outline in phase 1
//! and the hole in phase 2 would be cutting a part held by its tabs alone.
//!
//! # What this does NOT do
//!
//! - **It does not decide the work is HELD.** The hold-down check
//!   (`fixture::check_hold_down_phased`) reads the emitted program against the
//!   clamp set in force at each move and refuses what it refuses today. This
//!   module only proposes the positions; it is not the check.
//! - **It does not check that a clamp physically fits where it is sent** —
//!   T-slots, table edges, the clamp's own reach. The footprint is a rectangle.
//! - **It moves no part and no cut.** Placement is the operator's (or the
//!   placement planner's); this only moves clamps, and only between phases.
//! - **Nothing here has been run on a machine.** No air cut, no coupon, no ply.

use crate::fixture::{Clamp, ClampPhase, FixtureFinding, Fixturing};
use crate::toolpath::{Operation, WorkpieceEdgeRule};
use crate::types::{Machine, Stock, Toolpath};

/// Search step for the slide, mm. A clamp is moved by hand; a finer step would
/// promise a precision nobody places a clamp to.
pub const SLIDE_STEP_MM: f64 = 2.5;
/// How far the grip (footprint area over the workpiece) may change, as a
/// fraction. Chosen, not measured: it is "the same reach" with room for the
/// sampling grid, not a holding-force threshold.
pub const GRIP_TOLERANCE: f64 = 0.05;

/// One clamp the operator moves at the pause. Positions are the footprint
/// CENTRE, machine coordinates — where a person looks for a clamp.
#[derive(Clone, Debug, PartialEq)]
pub struct ClampMove {
    pub clamp: String,
    pub from: (f64, f64),
    pub to: (f64, f64),
}

#[derive(Clone, Debug)]
pub struct ReclampPlan {
    /// Phase (0 or 1) of each operation, by index into the operations given.
    pub op_phase: Vec<usize>,
    /// `[A, B]`. B carries the operator's instruction as its note.
    pub phases: Vec<ClampPhase>,
    pub moves: Vec<ClampMove>,
}

#[derive(Clone, Debug)]
pub enum Reclamp {
    /// No operation crosses a clamp (or there are no clamps): one phase.
    NotNeeded,
    Planned(ReclampPlan),
    /// A cut crosses a clamp and no acceptable B exists. The reason names the
    /// clamp and what stopped it; the fixture check still refuses the job.
    Impossible(String),
}

/// The instruction printed at the pause, and in the program comment. No `(`,
/// `)` or `;` — the post rewrites parentheses and every reader of this dialect
/// treats `;` as the start of a comment.
pub fn instruction(moves: &[ClampMove]) -> String {
    let each: Vec<String> = moves
        .iter()
        .map(|m| {
            format!(
                "{} from X{:.1} Y{:.1} to X{:.1} Y{:.1}",
                m.clamp, m.from.0, m.from.1, m.to.0, m.to.1
            )
        })
        .collect();
    if moves.len() == 1 {
        format!("move clamp {} while the other clamps stay tight", each[0])
    } else {
        format!(
            "move {} clamps ONE AT A TIME, the others staying tight: {}",
            moves.len(),
            each.join(" and ")
        )
    }
}

fn centre(c: &Clamp) -> (f64, f64) {
    let k = c.corners();
    (
        (k[0].0 + k[1].0 + k[2].0 + k[3].0) / 4.0,
        (k[0].1 + k[1].1 + k[2].1 + k[3].1) / 4.0,
    )
}

/// Point in a convex quad (either winding).
fn in_convex(q: &[(f64, f64); 4], p: (f64, f64)) -> bool {
    let mut sign = 0.0_f64;
    for i in 0..4 {
        let a = q[i];
        let b = q[(i + 1) % 4];
        let cr = (b.0 - a.0) * (p.1 - a.1) - (b.1 - a.1) * (p.0 - a.0);
        if cr.abs() < 1e-12 {
            continue;
        }
        if sign == 0.0 {
            sign = cr.signum();
        } else if cr.signum() != sign {
            return false;
        }
    }
    true
}

/// Sample points over the footprint, `n` x `n`, cell-centred.
fn samples(c: &Clamp, n: usize) -> Vec<(f64, f64)> {
    let k = c.corners();
    let (o, u, v) = (k[0], (k[1].0 - k[0].0, k[1].1 - k[0].1), (k[3].0 - k[0].0, k[3].1 - k[0].1));
    let mut out = Vec::with_capacity(n * n);
    for i in 0..n {
        for j in 0..n {
            let (a, b) = ((i as f64 + 0.5) / n as f64, (j as f64 + 0.5) / n as f64);
            out.push((o.0 + u.0 * a + v.0 * b, o.1 + u.1 * a + v.1 * b));
        }
    }
    out
}

/// Area of the footprint lying over the workpiece, mm^2 (sampled).
fn grip_mm2(c: &Clamp, stock_quad: &[(f64, f64); 4]) -> f64 {
    const N: usize = 24;
    let pts = samples(c, N);
    let inside = pts.iter().filter(|p| in_convex(stock_quad, **p)).count();
    inside as f64 / (N * N) as f64 * c.w * c.h
}

fn overlaps(a: &Clamp, b: &Clamp) -> bool {
    let ka = a.corners();
    let kb = b.corners();
    // Corner or centre of either inside the other, or a sampled point of A in B.
    ka.iter().any(|p| b.contains(p.0, p.1, 0.0))
        || kb.iter().any(|p| a.contains(p.0, p.1, 0.0))
        || samples(a, 8).iter().any(|p| b.contains(p.0, p.1, 0.0))
}

fn bbox(c: &Clamp) -> (f64, f64, f64, f64) {
    let k = c.corners();
    let xs = k.iter().map(|p| p.0);
    let ys = k.iter().map(|p| p.1);
    (
        xs.clone().fold(f64::INFINITY, f64::min),
        ys.clone().fold(f64::INFINITY, f64::min),
        xs.fold(f64::NEG_INFINITY, f64::max),
        ys.fold(f64::NEG_INFINITY, f64::max),
    )
}

/// Which clamps (by name) one operation's own path crosses — a cut through the
/// footprint, or a rapid over it below its height.
fn clamps_hit(
    path: &Toolpath,
    fixturing: &Fixturing,
    r: f64,
    stock: &Stock,
    machine: &Machine,
) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for f in fixturing.check(path, r, stock.thickness_mm, machine) {
        let name = match f {
            FixtureFinding::CutsClamp { clamp, .. } => clamp,
            FixtureFinding::RapidBelowClamp { clamp, .. } => clamp,
            _ => continue,
        };
        if !out.contains(&name) {
            out.push(name);
        }
    }
    out
}

/// Split the job into clamping phases if — and only if — an operation crosses a
/// clamp. See the module header for every rule a plan must satisfy.
///
/// `ops` must already be in MACHINE coordinates (the datum applied), which is
/// where `plan_job` calls this from.
pub fn plan_reclamp(
    ops: &[Operation],
    fixturing: &Fixturing,
    machine: &Machine,
    stock: &Stock,
    edge_rule: Option<&WorkpieceEdgeRule>,
) -> Reclamp {
    if fixturing.clamps.is_empty() || ops.is_empty() {
        return Reclamp::NotNeeded;
    }
    // The margin the fixture check uses on the assembled program
    // (`job.rs`, `biggest_r`). A smaller one here would choose a B that the
    // final per-phase check then refuses.
    let r = ops.iter().map(|o| o.tool.radius_mm()).fold(0.0_f64, f64::max);
    let paths: Vec<Toolpath> = ops
        .iter()
        .map(|op| {
            let mut p = crate::toolpath::plan_operation_with_edge_rule(op, machine, stock, edge_rule).path;
            p.recompute_bounds();
            p
        })
        .collect();

    let hits: Vec<Vec<String>> =
        paths.iter().map(|p| clamps_hit(p, fixturing, r, stock, machine)).collect();
    if hits.iter().all(|h| h.is_empty()) {
        return Reclamp::NotNeeded;
    }

    // ---- which operations wait for phase 2 ---------------------------------
    let mut phase: Vec<usize> = hits.iter().map(|h| usize::from(!h.is_empty())).collect();
    let attr = crate::optimise::release_attribution(ops);
    // A part whose interior work waits must not be released before it.
    loop {
        let mut changed = false;
        for i in 0..ops.len() {
            if phase[i] == 1 && !attr[i].1 {
                if let Some(p) = attr[i].0 {
                    if phase[p] == 0 {
                        phase[p] = 1;
                        changed = true;
                    }
                }
            }
        }
        if !changed {
            break;
        }
    }
    let mut moving: Vec<String> = Vec::new();
    for (i, h) in hits.iter().enumerate() {
        if phase[i] == 1 {
            for n in h {
                if !moving.contains(n) {
                    moving.push(n.clone());
                }
            }
        }
    }

    let crossing = |name: &str| -> String {
        let names: Vec<&str> = ops
            .iter()
            .zip(&hits)
            .filter(|(_, h)| h.iter().any(|x| x == name))
            .map(|(o, _)| o.name.as_str())
            .collect();
        names.join(", ")
    };

    if fixturing.clamps.len() < 2 {
        let n = &fixturing.clamps[0].name;
        return Reclamp::Impossible(format!(
            "the cut {} runs under clamp `{n}`, and it is the only clamp: moving it mid-job \
             would leave the work held by nothing while it moves. Add a second clamp so one \
             stays tight while the other is moved",
            crossing(n)
        ));
    }

    // ---- where each moving clamp goes --------------------------------------
    let stock_quad = [
        stock.place(0.0, 0.0),
        stock.place(stock.size_x_mm, 0.0),
        stock.place(stock.size_x_mm, stock.size_y_mm),
        stock.place(0.0, stock.size_y_mm),
    ];
    let reach = stock.size_x_mm.max(stock.size_y_mm);
    let steps = (reach / SLIDE_STEP_MM).ceil() as i64;
    let path_box: Vec<(f64, f64, f64, f64)> =
        paths.iter().map(|p| (p.min_x - r, p.min_y - r, p.max_x + r, p.max_y + r)).collect();

    let mut b_set: Vec<Clamp> = fixturing.clamps.clone();
    let mut moves: Vec<ClampMove> = Vec::new();
    for name in &moving {
        let Some(ci) = b_set.iter().position(|c| &c.name == name) else { continue };
        let a = b_set[ci].clone();
        let grip_a = grip_mm2(&a, &stock_quad);
        let (s, c) = {
            let t = a.rotation_deg.to_radians();
            (t.sin(), t.cos())
        };
        // The clamp's own axes: along its width, along its height.
        let axes = [(c, s), (-s, c)];
        let mut found: Option<Clamp> = None;
        'search: for k in 1..=steps {
            let d = k as f64 * SLIDE_STEP_MM;
            for (ax, ay) in axes {
                for sign in [1.0, -1.0] {
                    let mut cand = a.clone();
                    cand.x += ax * d * sign;
                    cand.y += ay * d * sign;
                    let g = grip_mm2(&cand, &stock_quad);
                    if grip_a <= 0.0 {
                        if g > 0.0 {
                            continue;
                        }
                    } else if (g - grip_a).abs() > GRIP_TOLERANCE * grip_a {
                        continue;
                    }
                    if b_set.iter().enumerate().any(|(j, o)| j != ci && overlaps(&cand, o)) {
                        continue;
                    }
                    let one = Fixturing { clamps: vec![cand.clone()], confirmed_clear: true };
                    let cb = bbox(&cand);
                    let clear = paths.iter().zip(&path_box).all(|(p, pb)| {
                        let apart = pb.2 < cb.0 || pb.0 > cb.2 || pb.3 < cb.1 || pb.1 > cb.3;
                        // Rapids at safe Z can cross far outside a path's
                        // cutting box only within the box itself, so a box
                        // miss is a clean miss.
                        apart || clamps_hit(p, &one, r, stock, machine).is_empty()
                    });
                    if clear {
                        found = Some(cand);
                        break 'search;
                    }
                }
            }
        }
        match found {
            Some(b) => {
                moves.push(ClampMove { clamp: a.name.clone(), from: centre(&a), to: centre(&b) });
                b_set[ci] = b;
            }
            None => {
                return Reclamp::Impossible(format!(
                    "the cut {} runs under clamp `{name}`, and no position found by sliding that \
                     clamp along its own axes (in {SLIDE_STEP_MM} mm steps, up to {reach:.0} mm) \
                     clears every cut in the job while keeping the same grip on the work and \
                     staying off the other clamps. Move the clamp or the part by hand",
                    crossing(name)
                ));
            }
        }
    }

    let note = instruction(&moves);
    Reclamp::Planned(ReclampPlan {
        op_phase: phase,
        phases: vec![
            ClampPhase::new(fixturing.clamps.clone()).with_note("clamps as first fitted"),
            ClampPhase::new(b_set).with_note(note),
        ],
        moves,
    })
}

// ===========================================================================
//  Fewer operator stops — founder 2026-10-16: "the change should be optimized,
//  less change, have multiple tool change it once, make it quicker"
// ===========================================================================
//
// The route module already groups every cutter's work so each cutter is
// fitted once per run of work (N tools, N-1 changes). Splitting a job at a
// clamp move can cost an EXTRA change: phase 1 ends on cutter A, phase 2
// starts on cutter B, and A comes back later. `align_boundaries` makes the
// cutter at the end of a phase the one the next phase starts with, when that
// is possible without cutting a part free before its own interior work; and
// `job.rs` writes a clamp move and a cutter change that still coincide as ONE
// stop. Neither may trade a hard constraint for a stop: every candidate order
// is re-checked by `release_order_violations`, and `job.rs` runs the same
// check on the final sequence, so a reorder that slipped past here is still
// refused.

/// Cutter changes the group sequence implies: one per adjacent pair whose
/// cutter differs. The same count `job.rs` turns into `ToolChange` moves.
pub fn cutter_changes(groups: &[(crate::types::Tool, Vec<Operation>)]) -> usize {
    groups.windows(2).filter(|w| w[0].0.name != w[1].0.name).count()
}

/// Every place in `seq` where a part's releasing outline comes BEFORE an
/// interior feature of that same part — by `optimise::release_attribution`,
/// the classification the router itself uses. Empty = the order is safe on
/// that rule. Unattributable operations make no claim either way.
pub fn release_order_violations(seq: &[Operation]) -> Vec<String> {
    let attr = crate::optimise::release_attribution(seq);
    let mut out = Vec::new();
    for (o, (_, outer)) in attr.iter().enumerate() {
        if !outer {
            continue;
        }
        let late: Vec<&str> = attr
            .iter()
            .enumerate()
            .filter(|(i, (part, is_outer))| !is_outer && *part == Some(o) && *i > o)
            .map(|(i, _)| seq[i].name.as_str())
            .collect();
        if !late.is_empty() {
            out.push(format!(
                "`{}` is cut before {} of its own interior features ({}) — after the outline the \
                 part is held by its tabs alone, and every cut after it is made on a part that \
                 can lift into the spindle",
                seq[o].name,
                late.len(),
                late.join(", ")
            ));
        }
    }
    out
}

/// Reorder whole tool GROUPS inside each phase (never across the pause) so
/// the cutter is the same either side of each phase boundary, when that
/// lowers the total number of cutter changes and keeps the release order.
/// `ignore_release` is the negative-control knob only.
pub fn align_boundaries(
    groups: &mut Vec<(crate::types::Tool, Vec<Operation>)>,
    phase_of: &[usize],
    ignore_release: bool,
) {
    let seq_ok = |g: &Vec<(crate::types::Tool, Vec<Operation>)>| -> bool {
        if ignore_release {
            return true;
        }
        let seq: Vec<Operation> = g.iter().flat_map(|(_, o)| o.iter().cloned()).collect();
        release_order_violations(&seq).is_empty()
    };
    for b in 1..groups.len() {
        if phase_of[b] == phase_of[b - 1] || groups[b].0.name == groups[b - 1].0.name {
            continue;
        }
        let (lo, hi) = {
            let p0 = phase_of[b - 1];
            let p1 = phase_of[b];
            let lo = (0..b).find(|i| phase_of[*i] == p0).unwrap_or(0);
            let hi = (b..groups.len()).rev().find(|i| phase_of[*i] == p1).unwrap_or(b);
            (lo, hi)
        };
        let now = cutter_changes(groups);
        let mut best: Option<Vec<(crate::types::Tool, Vec<Operation>)>> = None;
        // A: bring a later group of the outgoing cutter to the front of the
        // incoming phase.
        for j in (b + 1)..=hi {
            if groups[j].0.name == groups[b - 1].0.name {
                let mut c = groups.clone();
                let g = c.remove(j);
                c.insert(b, g);
                if cutter_changes(&c) < now && seq_ok(&c) {
                    best = Some(c);
                    break;
                }
            }
        }
        // B: send an earlier group of the incoming cutter to the end of the
        // outgoing phase.
        if best.is_none() {
            for i in lo..(b - 1) {
                if groups[i].0.name == groups[b].0.name {
                    let mut c = groups.clone();
                    let g = c.remove(i);
                    c.insert(b - 1, g);
                    if cutter_changes(&c) < now && seq_ok(&c) {
                        best = Some(c);
                        break;
                    }
                }
            }
        }
        if let Some(c) = best {
            *groups = c;
        }
    }
}

// ===========================================================================
//  Tests — every one reads the EMITTED PROGRAM (`post_grblhal` output), never
//  the plan's phase list, per the lane rule. The plan is used only to know
//  which clamp set the program SAYS is in force after each pause.
// ===========================================================================
#[cfg(test)]
mod tests {
    use super::*;
    use crate::fixture::Clamp;
    use crate::job::{plan_job, Job, JobResult};
    use crate::post_grblhal::{post_grblhal, PostOptions};
    use crate::geometry::Contour;
    use crate::toolpath::OpRole;
    use crate::types::*;

    fn machine() -> Machine {
        Machine { collet_mm: 6.0, probe_enabled: true, touch_plate_mm: Some(1.6), ..Machine::default() }
    }
    fn tool6() -> Tool {
        Tool { name: "6mm".into(), diameter_mm: 6.0, shank_mm: 6.0, flutes: 2, chipload_mm: 0.1, ..Tool::default() }
    }
    fn outline(name: &str, c: Contour) -> Operation {
        let (part, role) = crate::toolpath::test_part_and_role(name);
        Operation {
            name: name.into(),
            part,
            role,
            contour: c,
            tool: tool6(),
            params: OperationParams { side: CutSide::Outside, depth_total_mm: 12.0, ..OperationParams::default() },
        }
    }
    fn hole(name: &str, x: f64, y: f64) -> Operation {
        Operation {
            name: name.into(),
            part: crate::toolpath::test_part_and_role(name).0,
            role: OpRole::Interior,
            contour: Contour::circle(x, y, 3.0),
            tool: tool6(),
            params: OperationParams {
                side: CutSide::Inside,
                op_type: OpType::Drill,
                depth_total_mm: 12.0,
                ..OperationParams::default()
            },
        }
    }
    /// Left-edge clamp `c1` reaching 30 mm onto the work across y 100..140 —
    /// exactly where the outline's left edge (x 20, cut at x 17) runs.
    fn clamps() -> Vec<Clamp> {
        vec![
            Clamp::new("c1", -50.0, 100.0, 80.0, 40.0, 20.0),
            Clamp::new("c2", 570.0, 400.0, 80.0, 40.0, 20.0),
            Clamp::new("c3", 280.0, 870.0, 40.0, 80.0, 20.0),
        ]
    }
    fn job(cl: Vec<Clamp>, auto: bool) -> Job {
        let mut j = Job::new("reclamp", machine(), Stock::default());
        // `Contour::rect(x, y, w, h)`: the panel is x 20..420, y 20..320.
        j.operations = vec![
            hole("h1", 100.0, 100.0),
            hole("h2", 300.0, 200.0),
            outline("panel", Contour::rect(20.0, 20.0, 400.0, 300.0)),
        ];
        j.fixturing = Fixturing { clamps: cl, confirmed_clear: false };
        j.auto_reclamp = auto;
        j
    }
    /// The program text the post writes for this plan — written even for a
    /// refused plan, so a negative control can read what WOULD have run.
    fn emitted(j: &Job, r: &JobResult) -> String {
        post_grblhal(&r.path, &j.machine, &j.stock, &OperationParams::default(), &PostOptions::default()).gcode
    }

    /// Read the emitted program back into one `Toolpath` per clamp phase,
    /// split at each `( CLAMP CHANGE -> … )`. Only what the program SAYS:
    /// G0/G1/G2/G3 and the drill cycles, modal, absolute. Anything else that
    /// moves an axis (the probe) makes the position unknown until restated.
    fn phases_of(gcode: &str) -> Vec<Toolpath> {
        let mut out = vec![Toolpath::default()];
        let (mut x, mut y, mut z): (Option<f64>, Option<f64>, Option<f64>) = (None, None, None);
        let mut mode: i64 = -1;
        for raw in gcode.lines() {
            let t = raw.trim();
            if t.starts_with("( CLAMP CHANGE ->") {
                out.push(Toolpath::default());
                continue;
            }
            let code = crate::feeds::strip_comments(raw);
            if code.trim().is_empty() {
                continue;
            }
            let up = code.to_ascii_uppercase();
            let mut words: Vec<(char, f64)> = Vec::new();
            for w in up.split_whitespace() {
                let mut ch = w.chars();
                if let Some(c) = ch.next() {
                    if let Ok(v) = ch.as_str().parse::<f64>() {
                        words.push((c, v));
                    }
                }
            }
            let get = |l: char| words.iter().find(|(c, _)| *c == l).map(|(_, v)| *v);
            let mut probe = false;
            for (c, v) in &words {
                if *c == 'G' {
                    let g = (v * 10.0).round() as i64;
                    match g {
                        0 | 10 | 20 | 30 | 810 | 820 | 830 => mode = g,
                        382 | 383 | 384 | 385 => probe = true,
                        _ => {}
                    }
                }
            }
            if probe || up.contains("G91") || up.contains("G92") || up.contains("G10") {
                z = None;
                continue;
            }
            let (nx, ny, nz) = (get('X').or(x), get('Y').or(y), get('Z').or(z));
            let moved = get('X').is_some() || get('Y').is_some() || get('Z').is_some();
            if moved {
                if let (Some(a), Some(b), Some(c)) = (nx, ny, nz) {
                    let p = Vec3::new(a, b, c);
                    let m = match mode {
                        0 => Some(Move::rapid(p)),
                        10 => Some(Move::feed_to(p, 1.0)),
                        20 | 30 => {
                            let (i, j) = (get('I').unwrap_or(0.0), get('J').unwrap_or(0.0));
                            Some(Move::arc(mode == 20, p, Vec2::new(x.unwrap_or(a) + i, y.unwrap_or(b) + j), 1.0))
                        }
                        // A canned cycle bores at XY to Z: a plunge at the point.
                        810 | 820 | 830 => Some(Move::feed_to(p, 1.0)),
                        _ => None,
                    };
                    if let Some(m) = m {
                        out.last_mut().unwrap().moves.push(m);
                    }
                }
                x = nx;
                y = ny;
                // After a cycle the modal Z is the retract plane, not the hole.
                z = if (810..=830).contains(&mode) { get('R').or(z) } else { nz };
            }
        }
        out
    }

    fn crossings(path: &Toolpath, set: &[Clamp], j: &Job) -> Vec<FixtureFinding> {
        let f = Fixturing { clamps: set.to_vec(), confirmed_clear: true };
        f.check(path, 3.0, j.stock.thickness_mm, &j.machine)
            .into_iter()
            .filter(|x| matches!(x, FixtureFinding::CutsClamp { .. } | FixtureFinding::RapidBelowClamp { .. }))
            .collect()
    }

    fn cut_xs(path: &Toolpath) -> Vec<f64> {
        path.moves.iter().filter(|m| m.kind != MoveKind::Rapid && m.to.z < 0.0).map(|m| m.to.x).collect()
    }

    /// 🔴 THE PROPERTY: the outline runs under `c1`; the program cuts the holes,
    /// STOPS for the clamp, and cuts the outline — and in the emitted text no
    /// cut and no rapid crosses a clamp of the set in force at that point.
    #[test]
    fn reclamp_splits_the_job_and_no_cut_crosses_the_clamps_in_force() {
        let j = job(clamps(), true);
        let r = plan_job(&j);
        assert!(r.is_runnable(), "refused: {:?} {:?}", r.refusals, r.fixture_findings);
        assert_eq!(r.clamp_phases.len(), 2, "{:?}", r.notes);
        assert_eq!(r.clamp_moves.len(), 1);
        assert_eq!(r.clamp_moves[0].clamp, "c1");
        let g = emitted(&j, &r);
        if std::env::var("RECLAMP_DUMP").is_ok() {
            eprintln!("{g}");
        }
        let lines: Vec<&str> = g.lines().map(|l| l.trim()).collect();

        // The pause: exactly one, M0 directly after the comment, spindle off
        // and the tool retracted BEFORE the comment.
        let at: Vec<usize> =
            (0..lines.len()).filter(|i| lines[*i].starts_with("( CLAMP CHANGE ->")).collect();
        assert_eq!(at.len(), 1, "expected one clamp-change pause:\n{g}");
        let p = at[0];
        assert_eq!(lines[p + 1], "M0", "the clamp comment is not followed by M0:\n{g}");
        let before = &lines[p.saturating_sub(4)..p];
        assert!(before.iter().any(|l| *l == "M5"), "spindle not stopped before the pause: {before:?}");
        assert!(before.iter().any(|l| l.starts_with("G0 Z")), "no retract before the pause: {before:?}");
        assert!(lines[p].contains("c1 from X") && lines[p].contains("other clamps stay tight"), "{}", lines[p]);
        // The re-reference after it, because the job asks for one.
        assert!(lines[p + 2..(p + 20).min(lines.len())].iter().any(|l| l.contains("G38.2")), "no Z re-reference after the pause:\n{g}");

        let ph = phases_of(&g);
        assert_eq!(ph.len(), 2);
        let (a, b) = (&r.clamp_phases[0].clamps, &r.clamp_phases[1].clamps);
        assert!(crossings(&ph[0], a, &j).is_empty(), "phase 1 crosses set A: {:?}", crossings(&ph[0], a, &j));
        assert!(crossings(&ph[1], b, &j).is_empty(), "phase 2 crosses set B: {:?}", crossings(&ph[1], b, &j));
        // …and the split was NEEDED: what phase 2 cuts really does run where
        // `c1` stood. Without this the test would pass on a job that never
        // crossed a clamp at all.
        assert!(
            crossings(&ph[1], a, &j).iter().any(|f| matches!(f, FixtureFinding::CutsClamp { clamp, .. } if clamp == "c1")),
            "phase 2 does not cross c1's first position — the fixture proves nothing"
        );
        // The outline (left edge cut at x≈17) is after the pause, the holes before.
        assert!(cut_xs(&ph[1]).iter().any(|x| (x - 17.0).abs() < 0.5), "outline not in phase 2");
        assert!(!cut_xs(&ph[0]).iter().any(|x| (x - 17.0).abs() < 0.5), "outline cut before the clamp moved");
        // c1 slid along Y only, and kept its reach onto the work.
        let mv = &r.clamp_moves[0];
        assert!((mv.from.0 - mv.to.0).abs() < 1e-9, "c1 moved in X: {mv:?}");
        assert!(r.notes.iter().any(|n| n.starts_with("CLAMPS MOVE MID-JOB")), "{:?}", r.notes);
    }

    /// NEGATIVE CONTROL: the plan "forgets" to move the clamp. The program
    /// still pauses, then cuts through `c1`. The core must refuse it, and the
    /// emitted-program reader above must see the crossing.
    #[test]
    fn reclamp_plant_keeps_clamps_is_refused_and_the_reader_sees_it() {
        let mut j = job(clamps(), true);
        j.plant_reclamp_keeps_clamps = true;
        let r = plan_job(&j);
        assert!(!r.is_runnable(), "the planted job was accepted");
        assert!(
            r.fixture_findings.iter().any(|f| matches!(f, FixtureFinding::CutsClamp { clamp, .. } if clamp == "c1")),
            "{:?}",
            r.fixture_findings
        );
        let g = emitted(&j, &r);
        let ph = phases_of(&g);
        assert_eq!(ph.len(), 2, "the plant must still pause:\n{g}");
        assert!(!crossings(&ph[1], &r.clamp_phases[1].clamps, &j).is_empty(), "the reader missed the crossing");
    }

    /// Off by default: the existing refusal stands, nothing is split.
    #[test]
    fn reclamp_is_off_unless_asked_for() {
        let j = job(clamps(), false);
        let r = plan_job(&j);
        assert!(!r.is_runnable());
        assert!(r.clamp_phases.is_empty());
        assert!(!emitted(&j, &r).contains("CLAMP CHANGE"));
    }

    /// One clamp cannot be moved without letting the work go: refused, named.
    #[test]
    fn reclamp_with_one_clamp_is_refused_not_moved() {
        let j = job(vec![Clamp::new("c1", -50.0, 100.0, 80.0, 40.0, 20.0)], true);
        let r = plan_job(&j);
        assert!(!r.is_runnable());
        assert!(r.clamp_phases.is_empty());
        assert!(r.notes.iter().any(|n| n.contains("only clamp")), "{:?}", r.notes);
    }

    /// A hole under a clamp drags its own part's OUTLINE after the pause: the
    /// interior is never cut after the part it is in has been released.
    #[test]
    fn reclamp_part_interior_waits_with_its_outline() {
        let mut j = Job::new("interior", machine(), Stock::default());
        j.operations = vec![
            outline("p1", Contour::rect(200.0, 100.0, 200.0, 200.0)),
            hole("p1_h", 280.0, 165.0),
            outline("p2", Contour::rect(20.0, 500.0, 130.0, 150.0)),
        ];
        // A bar ON the part, over the hole, and two edge clamps clear of all.
        j.fixturing = Fixturing {
            clamps: vec![
                Clamp::new("bar", 250.0, 150.0, 60.0, 30.0, 20.0),
                Clamp::new("e1", 570.0, 400.0, 80.0, 40.0, 20.0),
                Clamp::new("e2", -50.0, 400.0, 80.0, 40.0, 20.0),
            ],
            confirmed_clear: false,
        };
        j.auto_reclamp = true;
        let r = plan_job(&j);
        assert!(r.is_runnable(), "refused: {:?} {:?} {:?}", r.refusals, r.fixture_findings, r.notes);
        let ph = phases_of(&emitted(&j, &r));
        assert_eq!(ph.len(), 2);
        // p1's outline cuts at x≈197; p2's at x≈17.
        assert!(cut_xs(&ph[1]).iter().any(|x| (x - 197.0).abs() < 0.5), "p1 outline not after the pause");
        assert!(!cut_xs(&ph[0]).iter().any(|x| (x - 197.0).abs() < 0.5), "p1 released before its hole");
        assert!(cut_xs(&ph[0]).iter().any(|x| (x - 17.0).abs() < 0.5), "p2 should cut before the pause");
    }

    // ---- the hold-down check reads the clamps in force AT EACH MOVE --------

    fn slot_then_pocket() -> String {
        let b1 = crate::toolpath::op_banner("slot", "T");
        let b2 = crate::toolpath::op_banner("pocket", "T");
        format!(
            "( tool: T D4.00mm F2 )\nG17 G21 G90 G54 G94\nG0 Z5.000\nM3 S12000\n( {b1} )\n\
             G0 X100.000 Y-5.000\nG1 Z-10.500 F300.0\nG1 X100.000 Y105.000 F600.0\nG0 Z5.000\nM5\n\
             ( CLAMP CHANGE -> move L )\nM0\nM3 S12000\n( {b2} )\nG0 X30.000 Y50.000\n\
             G1 Z-3.000 F300.0\nG1 X50.000 Y50.000 F600.0\nG0 Z5.000\nM5\nM30\n"
        )
    }
    fn small_stock() -> Stock {
        Stock { size_x_mm: 200.0, size_y_mm: 100.0, thickness_mm: 10.0, ..Stock::default() }
    }

    /// The slot splits the sheet in phase 1; in phase 2 the pocket is on the
    /// LEFT piece. Set B holds only the right piece, so the pocket is cut in
    /// material nothing holds — refused by the phased check, and invisible to
    /// a single-set check that still believes `L` stands where it started.
    #[test]
    fn hold_down_judges_each_move_against_the_clamps_in_force() {
        let g = slot_then_pocket();
        let tools = vec![("T".to_string(), 2.0)];
        let l = Clamp::new("L", 5.0, 40.0, 20.0, 20.0, 20.0);
        let r = Clamp::new("R", 175.0, 40.0, 20.0, 20.0, 20.0);
        let a = Fixturing { clamps: vec![l.clone(), r.clone()], confirmed_clear: false };
        let b_bad = Fixturing {
            clamps: vec![Clamp::new("L", 150.0, 70.0, 20.0, 20.0, 20.0), r.clone()],
            confirmed_clear: false,
        };
        let b_good = Fixturing {
            clamps: vec![Clamp::new("L", 5.0, 70.0, 20.0, 20.0, 20.0), r.clone()],
            confirmed_clear: false,
        };
        let unheld = |rep: &crate::fixture::HoldDownReport| {
            rep.findings.iter().any(|f| matches!(f, crate::fixture::HoldDownFinding::UnrestrainedMaterialMachined { .. }))
        };
        // What a single-set reader saw: the same moves, no pause, set A throughout.
        let unphased = g.replace("( CLAMP CHANGE -> move L )\nM0\n", "");
        assert_ne!(unphased, g, "premise: the pause was not removed");
        let single = crate::fixture::check_hold_down(&unphased, &a, &small_stock(), &tools, 1.0);
        let bad = crate::fixture::check_hold_down_phased(&g, &[a.clone(), b_bad], &small_stock(), &tools, 1.0);
        let good = crate::fixture::check_hold_down_phased(&g, &[a.clone(), b_good], &small_stock(), &tools, 1.0);
        assert!(bad.ran() && good.ran() && single.ran(), "{:?} / {:?}", bad.basis.pending, single.basis.pending);
        assert!(unheld(&bad), "the pocket on the unheld piece was not refused: {:?}", bad.findings);
        assert!(!unheld(&good), "a held piece was refused: {:?}", good.findings);
        // The blindness the phased check exists to remove.
        assert!(!unheld(&single), "premise: the single-set check should read the piece as held");
        // A pause count that disagrees with the sets is PENDING, not judged.
        let wrong = crate::fixture::check_hold_down_phased(&g, &[a], &small_stock(), &tools, 1.0);
        assert!(!wrong.ran(), "a 1-set check of a 2-phase program ran");
    }

    // ---- fewer operator stops (founder: "less change … make it quicker") ---

    fn tool3() -> Tool {
        Tool { name: "3mm".into(), diameter_mm: 3.0, shank_mm: 6.0, flutes: 2, chipload_mm: 0.05, ..Tool::default() }
    }
    fn with_tool(mut o: Operation, t: Tool) -> Operation {
        // A drilled hole is the cutter's own diameter: shrink it with the tool.
        if o.params.op_type == OpType::Drill {
            if let Some((x0, y0, x1, y1)) = o.contour.bounds() {
                o.contour = Contour::circle((x0 + x1) / 2.0, (y0 + y1) / 2.0, t.diameter_mm / 2.0);
            }
        }
        o.tool = t;
        o
    }
    fn count(g: &str, needle: &str) -> usize {
        g.lines().filter(|l| l.trim().starts_with(needle)).count()
    }
    /// The `M0`s for a cutter or clamp change. A probing machine also stops
    /// after every probe for the touch plate to be taken off the work; those
    /// stops are counted by `plate_stops` and are not what these tests are about.
    fn m0s(g: &str) -> usize {
        let lines: Vec<&str> = g.lines().collect();
        (0..lines.len())
            .filter(|&i| lines[i].trim() == "M0")
            .filter(|&i| i == 0 || !lines[i - 1].trim_start().starts_with("( TOUCH PLATE ->"))
            .count()
    }

    fn plate_stops(g: &str) -> usize {
        count(g, "( TOUCH PLATE ->")
    }

    /// `interventions_of` without the plate-removal stops (see `m0s`).
    fn change_stops(g: &str) -> Vec<crate::setup::Intervention> {
        crate::setup::interventions_of(g)
            .into_iter()
            .filter(|s| !s.items.iter().all(|i| i.kind == "plate"))
            .collect()
    }

    fn noprobe(mut j: Job) -> Job {
        j.machine.probe_enabled = false;
        j.machine.touch_plate_mm = None;
        j
    }

    /// 🔴 Founder 2026-10-16: *"have as a warning allow without z probe"*. A
    /// clamp-only stop (same cutter in the collet) on a machine with NO probe
    /// is ALLOWED: no re-probe, no hand zero, and the warning written into the
    /// program before the stop. Read off the EMITTED program.
    #[test]
    fn reclamp_clamp_only_stop_without_a_probe_is_allowed_with_the_warning() {
        let j = noprobe(job(clamps(), true));
        let r = plan_job(&j);
        assert!(r.is_runnable(), "refused: {:?} {:?}", r.refusals, r.fixture_findings);
        let g = emitted(&j, &r);
        if std::env::var("RECLAMP_DUMP").is_ok() {
            eprintln!("{g}");
        }
        let lines: Vec<&str> = g.lines().map(str::trim).collect();
        let at: Vec<usize> = (0..lines.len()).filter(|i| lines[*i].starts_with("( CLAMP CHANGE ->")).collect();
        assert_eq!(at.len(), 1, "{g}");
        let p = at[0];
        assert_eq!(lines[p + 1], "M0");
        let warn = format!("( {} )", crate::setup::CLAMP_NO_ZCHECK);
        let w = lines[..p].iter().rposition(|l| *l == warn).expect("no warning before the stop");
        assert!(p - w <= 4, "the warning is not at the stop: line {w} vs {p}");
        assert!(!g.contains("G38"), "a probe on a machine with none:\n{g}");
        assert!(!g.contains("SET Z ZERO"), "a hand zero for a cutter that did not change");
        assert_eq!(m0s(&g), 1);
        let st = crate::setup::interventions_of(&g);
        assert_eq!(st.len(), 1);
        assert!(!st[0].reprobe);
        assert_eq!(st[0].warning.as_deref(), Some(crate::setup::CLAMP_NO_ZCHECK));
        assert!(r.notes.iter().any(|n| n.contains("WARNING") && n.contains(crate::setup::CLAMP_NO_ZCHECK)), "{:?}", r.notes);
        // Still split and still clear of the clamps in force.
        let ph = phases_of(&g);
        assert_eq!(ph.len(), 2);
        assert!(crossings(&ph[0], &r.clamp_phases[0].clamps, &j).is_empty());
        assert!(crossings(&ph[1], &r.clamp_phases[1].clamps, &j).is_empty());
        // CONTROL for the derivation: the same job on a probing machine
        // re-probes after the stop and so carries no warning.
        let jp = job(clamps(), true);
        let gp = emitted(&jp, &plan_job(&jp));
        let sp = change_stops(&gp);
        assert!(sp[0].reprobe && sp[0].warning.is_none(), "{sp:?}");
        // The datum probe and the re-reference each end with the plate stop.
        assert_eq!(plate_stops(&gp), 2, "{gp}");
        assert!(!gp.contains(crate::setup::CLAMP_NO_ZCHECK));
    }

    /// A clamp move merged with a cutter change on a machine with NO probe:
    /// the new cutter needs Z set again, so it is the hand-zero path — one
    /// intervention, two `M0`, no probe, no clamp warning (Z IS set again).
    #[test]
    fn reclamp_merged_stop_without_a_probe_sets_z_by_hand() {
        let mut j = noprobe(job(clamps(), true));
        j.operations[2] = with_tool(j.operations[2].clone(), tool3());
        let r = plan_job(&j);
        assert!(r.is_runnable(), "{:?} {:?}", r.refusals, r.fixture_findings);
        let g = emitted(&j, &r);
        if std::env::var("RECLAMP_DUMP").is_ok() {
            eprintln!("{g}");
        }
        assert_eq!(m0s(&g), 2, "{g}");
        assert_eq!(count(&g, "( CLAMP CHANGE ->"), 1);
        assert_eq!(count(&g, "( TOOL CHANGE ->"), 1);
        assert_eq!(count(&g, "( SET Z ZERO ->"), 1);
        assert!(!g.contains("G38"));
        assert!(!g.contains(crate::setup::CLAMP_NO_ZCHECK));
        let lift = crate::post_grblhal::rezero_lift_errors(&g, 5.0);
        assert!(lift.is_empty(), "{lift:?}");
        let st = crate::setup::interventions_of(&g);
        assert_eq!(st.len(), 1, "{st:?}");
        assert_eq!(st[0].items.iter().map(|i| i.kind).collect::<Vec<_>>(), vec!["clamps", "cutter"]);
        assert!(st[0].zero_pause_line.is_some() && st[0].warning.is_none());
        let f = crate::setup::setup_facts(&crate::setup::SetupDeclared::from_job(&j), &g);
        assert!(f.mismatches.is_empty(), "{:?}", f.mismatches);
        assert!(f.other_pauses.is_empty());
        assert_eq!(r.summary.tool_changes, 1);
        let ph = phases_of(&g);
        assert_eq!(ph.len(), 2);
        assert!(crossings(&ph[1], &r.clamp_phases[1].clamps, &j).is_empty());
    }

    /// Holes on the 6mm, the outline (under c1) on the 3mm: the clamp move
    /// and the cutter change fall at the same point. Unoptimised: two `M0`.
    /// Optimised: ONE `M0` carrying both instructions and one re-probe.
    #[test]
    fn reclamp_merges_a_clamp_move_and_a_cutter_change_into_one_stop() {
        let mk = |unopt: bool| {
            let mut j = job(clamps(), true);
            j.operations[2] = with_tool(j.operations[2].clone(), tool3());
            j.plant_interventions_unoptimised = unopt;
            let r = plan_job(&j);
            assert!(r.is_runnable(), "{:?} {:?}", r.refusals, r.fixture_findings);
            (emitted(&j, &r), r, j)
        };
        let (before, _, _) = mk(true);
        let (after, r, j) = mk(false);
        assert_eq!(m0s(&before), 2, "premise: unoptimised is two stops:\n{before}");
        assert_eq!(m0s(&after), 1, "not merged:\n{after}");
        assert_eq!(count(&after, "( CLAMP CHANGE ->"), 1);
        assert_eq!(count(&after, "( TOOL CHANGE ->"), 1);
        assert_eq!(count(&after, "G38.2 Z-30"), count(&before, "G38.2 Z-30") - 1, "one re-probe saved");
        let stops = change_stops(&after);
        assert_eq!(stops.len(), 1);
        let kinds: Vec<&str> = stops[0].items.iter().map(|i| i.kind).collect();
        assert_eq!(kinds, vec!["clamps", "cutter"]);
        assert!(stops[0].reprobe);
        // The checklist reader sees both at the same stop, and no mismatch.
        let f = crate::setup::setup_facts(&crate::setup::SetupDeclared::from_job(&j), &after);
        assert!(f.mismatches.is_empty(), "{:?}", f.mismatches);
        assert_eq!(f.clamp_changes.len(), 1);
        assert_eq!(Some(f.clamp_changes[0].pause_line), f.tools.last().and_then(|t| t.pause_line));
        assert_eq!(r.interventions.merged, 1);
        assert_eq!(r.interventions.stops, 1);
        assert_eq!(r.interventions.stops_unmerged, 2);
    }

    /// Phase 1 holds a 6mm hole and a 3mm hole, phase 2 the 6mm outline. The
    /// router's order ends phase 1 on the 3mm, so the 6mm comes back after the
    /// pause: 2 cutter changes. Reordering the phase-1 groups ends it on the
    /// 6mm: 1 cutter change. Counted in the EMITTED program.
    #[test]
    fn reclamp_reorders_so_one_cutter_carries_across_the_pause() {
        let mk = |unopt: bool| {
            let mut j = job(clamps(), true);
            j.operations[1] = with_tool(j.operations[1].clone(), tool3());
            j.plant_interventions_unoptimised = unopt;
            let r = plan_job(&j);
            assert!(r.is_runnable(), "{:?} {:?}", r.refusals, r.fixture_findings);
            emitted(&j, &r)
        };
        let (before, after) = (mk(true), mk(false));
        assert_eq!(count(&before, "( TOOL CHANGE ->"), 2, "premise:\n{before}");
        assert_eq!(count(&after, "( TOOL CHANGE ->"), 1, "not reordered:\n{after}");
        assert!(m0s(&after) < m0s(&before));
        // …and still nothing crosses a clamp of its own phase.
        let r = plan_job(&{
            let mut j = job(clamps(), true);
            j.operations[1] = with_tool(j.operations[1].clone(), tool3());
            j
        });
        let ph = phases_of(&after);
        let j = job(clamps(), true);
        assert!(crossings(&ph[0], &r.clamp_phases[0].clamps, &j).is_empty());
        assert!(crossings(&ph[1], &r.clamp_phases[1].clamps, &j).is_empty());
    }

    /// HARD CONSTRAINT: the only reorder that would save a cutter change puts
    /// a part's outline before its own hole. Not taken; and with the knob
    /// that lets the reorder ignore the release order, the final-sequence
    /// check REFUSES the job.
    #[test]
    fn reclamp_never_trades_the_release_order_for_a_stop() {
        let mk = |plant: bool| {
            let mut j = Job::new("release", machine(), Stock::default());
            j.operations = vec![
                with_tool(hole("p1_h", 300.0, 200.0), tool3()),
                outline("p1", Contour::rect(200.0, 100.0, 200.0, 200.0)),
                with_tool(hole("edge", 10.0, 120.0), tool3()),
            ];
            j.fixturing = Fixturing { clamps: clamps(), confirmed_clear: false };
            j.auto_reclamp = true;
            j.plant_reorder_ignores_release = plant;
            let r = plan_job(&j);
            (emitted(&j, &r), r)
        };
        let (honest, r) = mk(false);
        assert!(r.is_runnable(), "{:?} {:?} {:?}", r.refusals, r.fixture_findings, r.notes);
        assert_eq!(r.clamp_phases.len(), 2);
        // p1's hole (x 300, 3mm) is cut before p1's outline (x≈197).
        let ph = phases_of(&honest);
        let xs = cut_xs(&ph[0]);
        let hole_at = xs.iter().position(|x| (x - 300.0).abs() < 0.01);
        let outline_at = xs.iter().position(|x| (x - 197.0).abs() < 0.5);
        assert!(hole_at.is_some() && outline_at.is_some() && hole_at < outline_at, "{xs:?}");
        let (_, planted) = mk(true);
        assert!(!planted.is_runnable(), "the release-breaking reorder was accepted");
        assert!(
            planted.refusals.iter().any(|x| x.why.contains("before 1 of its own interior features")),
            "{:?}",
            planted.refusals
        );
    }
}
