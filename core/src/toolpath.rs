//! Toolpath generation — contours in, controller-agnostic moves out.
//!
//! Ordering, tabs, dogbones and entry all live here. The post-processor never
//! makes a machining decision; it only writes down what this module decided.

use crate::feeds::feed_from_chipload;
use crate::geometry::{Contour, Part, Vertex};
use crate::types::*;

/// Something the CAM refuses to do, with the reason a human needs.
#[derive(Clone, Debug, PartialEq)]
pub struct Refusal {
    pub what: String,
    pub why: String,
}

#[derive(Clone, Debug, Default)]
pub struct PlanResult {
    pub path: Toolpath,
    pub refusals: Vec<Refusal>,
    pub notes: Vec<String>,
}

// ===========================================================================
//  Which operation, and which cutter — one writer, one reader
// ===========================================================================
//
// 🔴 THE ASSOCIATION ALREADY EXISTED AND WAS ONLY EXPRESSIBLE AS PROSE.
// Every planner in this file opens its move list with a banner comment naming
// the operation and the tool, the post writes that banner into the program as
// `( op: pocket-1 [6mm 2F] )`, and a human reading the G-code uses it to tell
// which cut is which. Nothing else could: `Move` carries no operation and no
// tool name (`Toolpath::tool` is ONE tool while a program uses several — see
// the note on `Move::tool_r_mm` for what that already cost), so a host wanting
// to say "this segment belongs to pocket-1" had to either invent the answer or
// parse the emitted text with a regex of its own.
//
// So the format is written in ONE function and read back in ONE function, and
// a round-trip test holds them together. The alternative — a `format!` at each
// planner and a regex at each consumer — is the same string described in four
// places, and the first rename silently unhooks the consumers while every
// program still LOOKS correctly labelled.

/// Banner prefix for a contouring operation (profile, pocket, engrave).
pub const OP_BANNER_PREFIX: &str = "op: ";
/// Banner prefix for a drilling operation. A separate word because a drill
/// cycle is a different kind of move to an operator reading the file, and the
/// prefix is what they scan for.
pub const DRILL_BANNER_PREFIX: &str = "drill: ";

/// Format the banner comment that opens an operation's moves.
///
/// ⚠ The tool goes in square brackets, and the operation name is allowed to
/// contain them — a part called `bracket [v2]` is a real filename. So the
/// reader takes the **last** `[`, never the first; see [`parse_banner`].
fn banner(prefix: &str, op_name: &str, tool_name: &str) -> String {
    format!("{prefix}{op_name} [{tool_name}]")
}

/// The banner for a contouring operation.
pub fn op_banner(op_name: &str, tool_name: &str) -> String {
    banner(OP_BANNER_PREFIX, op_name, tool_name)
}

/// The banner for a drilling operation.
pub fn drill_banner(op_name: &str, tool_name: &str) -> String {
    banner(DRILL_BANNER_PREFIX, op_name, tool_name)
}

/// Read a banner back: `(operation name, tool name)`, or `None` if this comment
/// is not a banner.
///
/// 🔴 It returns `None` rather than a best guess. `job.rs` opens every program
/// with `job: <name>` and this file writes other comments too (`3 corner
/// relief(s)`); a reader that treated any comment as a banner would attribute
/// every following move to an "operation" called `3 corner relief(s)`.
///
/// ⚠ **It reads `Move::text`, not the emitted G-code.** The post sanitises a
/// comment before writing it — `(` and `)` become `_`, because grblHAL's parser
/// cannot nest comments — so an operation whose name contains a parenthesis
/// appears in the program under a slightly different name. The attribution is
/// therefore taken from the plan's own text and is exact; a consumer matching
/// the *program text* against these names must sanitise the same way.
pub fn parse_banner(text: &str) -> Option<(&str, &str)> {
    let rest = text
        .strip_prefix(OP_BANNER_PREFIX)
        .or_else(|| text.strip_prefix(DRILL_BANNER_PREFIX))?;
    let inner = rest.strip_suffix(']')?;
    let open = inner.rfind('[')?;
    let name = inner[..open].trim_end();
    if name.is_empty() {
        return None;
    }
    Some((name, &inner[open + 1..]))
}

/// Which operation and which cutter a planned move belongs to.
///
/// 🔴 **`None` MEANS NOBODY SAID, NEVER "the usual one".** The obvious fallback
/// — fill an absent tool in from `Toolpath::tool` — is wrong in the direction
/// that matters: on a multi-tool program `Toolpath::tool` is the FIRST tool, so
/// every move after the first tool change would be labelled with a cutter that
/// is no longer in the spindle. That is the same defect `Move::tool_r_mm` was
/// added to fix, one field across, and it fails the same way: plausibly.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct MoveOrigin {
    /// The operation whose banner was last in force.
    pub op: Option<String>,
    /// The cutter in the spindle for this move — from the banner, or from the
    /// tool change that put it there.
    pub tool: Option<String>,
}

/// Attribute every move in a path to the operation and cutter it belongs to.
///
/// The returned vector is the **same length and the same order** as
/// `path.moves`, so `origins[i]` describes `path.moves[i]`. That is the whole
/// interface: a host that flattens the moves for drawing carries the entry
/// across with the point, and never has to re-derive anything.
///
/// # What sets what
///
/// - A banner comment ([`parse_banner`]) sets **both** the operation and the
///   tool, and applies to the banner move itself — it announces the work it
///   introduces.
/// - A [`MoveKind::ToolChange`] sets the tool (its `text` is the tool being
///   fitted) and **clears the operation**, because the next operation has not
///   been announced yet. A tool change belongs to neither the operation it
///   follows nor the one it precedes, and saying so is cheaper than picking.
/// - Everything before the first banner — the `job:` comment, the first spindle
///   start — is attributed to nothing, which is what it belongs to.
pub fn attribute_moves(path: &Toolpath) -> Vec<MoveOrigin> {
    let mut out = Vec::with_capacity(path.moves.len());
    let mut op: Option<String> = None;
    let mut tool: Option<String> = None;
    for m in &path.moves {
        match m.kind {
            MoveKind::Comment => {
                if let Some((name, t)) = parse_banner(&m.text) {
                    op = Some(name.to_string());
                    tool = if t.is_empty() { None } else { Some(t.to_string()) };
                }
            }
            MoveKind::ToolChange => {
                op = None;
                let t = m.text.trim();
                tool = if t.is_empty() { None } else { Some(t.to_string()) };
            }
            _ => {}
        }
        out.push(MoveOrigin { op: op.clone(), tool: tool.clone() });
    }
    out
}

/// A refusal for a planned path that contains a coordinate which is not a
/// number, or `None` if every emitted move is finite.
///
/// 🔴 **ASSERTED ON THE EMITTED MOVES, NEVER ON THE CONTOUR THAT WAS HANDED
/// IN.** The degenerate geometry that produced the NaN is cleaned at the source
/// ([`crate::geometry::Contour::dedupe_positions`]), and this exists for the
/// arithmetic that has not gone wrong yet: any future divide, `atan2`, `asin`
/// or offset in this module can put a NaN into a `Move` without going near a
/// duplicate vertex, and a check that reads the input would still be green.
///
/// Calling this makes `JobResult::is_runnable()` false, which is what stops the
/// program being written at all — the post's own refusal (see
/// [`crate::post_grblhal::post_grblhal`]) is the layer below, not this one.
pub fn nonfinite_refusal(name: &str, path: &Toolpath) -> Option<Refusal> {
    let (i, m) = path.first_nonfinite_move()?;
    Some(Refusal {
        what: name.to_string(),
        why: format!(
            "move {i} ({:?}) has a non-finite destination (X{} Y{} Z{}) — a coordinate that is \
             not a number cannot be cut, and grblHAL given `XNaN` with the spindle turning is an \
             unpredictable machine state. This is a defect in the CAM, not in the drawing: \
             report it rather than working around it",
            m.kind, m.to.x, m.to.y, m.to.z
        ),
    })
}

/// Refuse an operation whose PARAMETERS are not finite, before any planner reads
/// them — naming the field.
///
/// # 🔴 Why a check on the settings, in a file whose standing rule is to assert
/// on the emitted program (2026-08-28)
///
/// [`nonfinite_refusal`] is the right check and stays the last word: it reads
/// the moves that were actually produced. It cannot catch this one, because a
/// non-finite parameter **never reaches a coordinate**. Measured on this tree:
///
/// * `depth_total_mm = NaN` — both planners clamp with
///   `depth_total_mm.min(stock.thickness_mm + 0.3)`, and **`f64::min` returns
///   the non-NaN operand**. The NaN silently became `thickness + 0.3` and the
///   job planned 289 moves cutting the full thickness. The "deeper than the
///   stock" note beside it did not fire either, because `NaN > x` is `false`.
///   So a depth that is not a number produced a complete, plausible, runnable
///   program with **no signal of any kind**.
/// * `order_operations` sorted on `partial_cmp(...).unwrap()` and panicked on
///   the same input, ahead of every planner — a crash instead of a refusal.
///
/// A NaN that becomes a real depth is the worse of the two by a distance: the
/// panic at least stopped. So the refusal is raised HERE, on the field, and the
/// message names the field rather than a move — because there is no move to
/// name, which is the whole defect.
///
/// ⚠ This does NOT weaken the standing rule. It is the narrow, stated exception
/// the rule's own wording asks for: *where a check cannot reach the emitted
/// text, say so in the row rather than reading the plan and calling it covered.*
/// Every value here is one that a clamp, a `min`/`max` or a comparison would
/// swallow before it could ever appear in G-code.
/// Refuse a job whose MACHINE or WORKPIECE carries a non-finite number, before
/// any planner reads it — naming the field.
///
/// # 🔴 The same class as [`nonfinite_params_refusal`], found the same way and
/// worse (2026-08-29)
///
/// [`nonfinite_params_refusal`] closed the operation's own fields. The machine
/// and the workpiece were still open, and two of them are load-bearing for
/// SAFETY rather than for arithmetic. Measured on this tree, one 40x40 outside
/// profile, everything else at its default:
///
/// ```text
/// stock.thickness_mm = NaN  ->  289 moves, cut to Z-18.000, ZERO refusals
/// stock.size_x_mm    = NaN  ->  289 moves,                  ZERO refusals
/// machine.safe_z_mm  = NaN  ->    0 moves, refused          (reaches a move)
/// ```
///
/// * **`thickness_mm` is the SPOILBOARD CLAMP.** Both planners cut
///   `depth_total_mm.min(stock.thickness_mm + 0.3)`, and `f64::min` returns the
///   non-NaN operand — so a NaN thickness does not clamp to nothing, it
///   **removes the clamp**, and the requested depth goes through untouched. The
///   "depth clamped from X to Y — deeper is the spoilboard" note does not fire
///   either, because `NaN > x` is `false`. The program is 289 ordinary-looking
///   moves.
/// * **`size_x_mm` / `size_y_mm` are the WORKPIECE BOUNDS.** Every
///   off-material comparison against NaN is `false`, so "the cutter is outside
///   the workpiece" becomes unreachable — the check does not fail, it stops
///   being able to fire.
///
/// `safe_z_mm` was already caught, and only because it reaches a coordinate and
/// [`nonfinite_refusal`] reads the emitted moves. That is the distinction: a
/// value that becomes a coordinate is caught downstream on the program; a value
/// that is CONSUMED BY A COMPARISON OR A CLAMP never appears in the output at
/// all, and no check on the output can see it. Those are the ones refused here.
///
/// ⚠ `Option` fields are checked only when they are `Some`. `None` is a
/// declaration ("no touch plate"), and this lane already refuses on the absence
/// where absence matters — that is a different refusal with a different message.
/// Name a feature the CUTTER CANNOT PRODUCE, which the offset removes in silence.
///
/// # 🔴 A 2 mm slot vanished from the program with no note at all (2026-08-31)
///
/// A 60×60 square with a 2 mm wide, 55 mm deep notch, cut `Outside` with a 6 mm
/// cutter: **zero cutting moves anywhere in the notch corridor, zero notes.**
/// The tool cannot enter a 2 mm gap, so `parallel_offset` closes it and the part
/// comes out SOLID where the drawing shows a slot. Nothing downstream can
/// notice — every coordinate is a real coordinate of a real part — and the
/// operator finds it at assembly.
///
/// ⚠ The `Inside` cut of the same shape DID say something (*"offset split the
/// contour into 2 loops (a pinched shape)"*), which is what made the silence on
/// the other side visible. One direction reported and the other did not.
///
/// # How it is measured, and why not by hunting narrow gaps
///
/// The obvious approach — find pairs of boundary segments closer than the tool
/// diameter — is wrong: a 1 mm-thick part has its two long edges 1 mm apart and
/// is perfectly cuttable from the outside, because the tool never needs to pass
/// BETWEEN them. Proximity is not the question; *reachability* is.
///
/// So this asks the question directly, with a morphological round trip: offset
/// OUT by the tool radius and back IN by it. Whatever the tool cannot reach into
/// does not come back. Measured, 6 mm cutter:
///
/// ```text
/// plain square            3600.00 -> 3600.00   lost   0.00
/// 2mm notch, tool too big 3490.00 -> 3599.77   lost 109.77   <- the notch is 2x55 = 110
/// 10mm notch, tool fits   3050.00 -> 3053.86   lost   3.86
/// concave L               2000.00 -> 2001.93   lost   1.93
/// ```
///
/// ⚠ **The residue on a cuttable shape is not noise, it is the corner radius**,
/// and that is what makes the allowance principled rather than tuned: an inside
/// corner cut by a round tool keeps `(4 - PI)/4 * r^2` of material — 1.93 mm² at
/// r = 3 — and the L has one such corner while the 10 mm notch has two, giving
/// exactly 1.93 and 3.86. The allowance below is that model per concave corner
/// with a 50% margin, so a rounded corner never reports and a lost feature
/// always does.
///
/// # A NOTE, not a refusal
///
/// A radiused inside corner is normal and the operator lives with it; a missing
/// slot is not, and they must be told. But the tool cannot tell which of the two
/// the operator meant, and refusing every part with an unreachable pocket would
/// refuse ordinary work. So it says what was lost and how much.
fn unreachable_feature_note(op: &Operation, radius_mm: f64) -> Option<String> {
    let c = &op.contour;
    if !c.closed || c.verts.len() < 4 || !(radius_mm > 0.0) {
        return None;
    }
    let area0 = c.signed_area().abs();
    if !(area0 > 0.0) {
        return None;
    }
    // Out then back. `offset` returns the loops the library kept.
    let round_trip: f64 = c
        .offset(radius_mm)
        .iter()
        .flat_map(|o| o.offset(-radius_mm))
        .map(|x| x.signed_area().abs())
        .sum();
    if !round_trip.is_finite() || round_trip <= area0 {
        return None;
    }

    // The corner-radius budget: (4 - PI)/4 * r^2 per CONCAVE corner, +50%.
    let n = c.verts.len();
    let sign = c.signed_area().signum();
    let mut concave = 0usize;
    for i in 0..n {
        let (p, q, r) = (c.verts[(i + n - 1) % n], c.verts[i], c.verts[(i + 1) % n]);
        let cross = (q.x - p.x) * (r.y - q.y) - (q.y - p.y) * (r.x - q.x);
        if cross * sign < 0.0 {
            concave += 1;
        }
    }
    let per_corner = (4.0 - std::f64::consts::PI) / 4.0 * radius_mm * radius_mm;
    let allowance = (concave as f64 * per_corner * 1.5).max(0.5);
    let lost = round_trip - area0;
    if lost <= allowance {
        return None;
    }
    Some(format!(
        "{}: {lost:.1}mm² of this outline CANNOT BE PRODUCED by a {:.2}mm cutter and is not in \
         the program — a slot, notch or pocket narrower than the tool is closed by the offset and \
         the part comes out SOLID there. The rest of the profile is cut normally, so nothing \
         downstream can notice: every coordinate is a real coordinate of a real part. Use a \
         smaller cutter for that feature, or change the drawing. (Rounded inside corners are \
         expected and are not counted — {:.1}mm² was allowed for {} of them)",
        op.name,
        radius_mm * 2.0,
        allowance,
        concave
    ))
}

/// Refuse a contour that CROSSES ITSELF.
///
/// # 🔴 A self-intersecting outline cut a runnable program (2026-08-30)
///
/// Measured on an asymmetric bowtie — six vertices, one crossing, net area
/// clearly non-zero:
///
/// ```text
/// ok: true · 5,991 bytes of G-code · nothing said about self-intersection
/// ```
///
/// The only finding on that job was `Undeclared`, which is the no-clamps
/// warning and unrelated. Offsetting a crossing outline for a tool radius is
/// **geometrically meaningless near the crossing**: the offset inverts, so the
/// cutter passes on the wrong side — into the part body, or leaving a web that
/// should have been removed. Tabs and lead-ins are placed by arc length along a
/// path that now visits the same point twice. The result is a real program for a
/// shape that is not in the drawing.
///
/// ⚠ **A SYMMETRIC bowtie was already refused, and that is why this went unseen
/// for so long.** Its two lobes cancel, `signed_area()` comes out ~0, and
/// `to_parts`' `area > 1e-9` filter drops it — refused for the wrong reason, by
/// luck, exactly like the polyface mesh in #151 that fell outside the travel.
/// Make the lobes unequal and the filter passes it straight through.
///
/// ⚠ **WHAT THIS DOES NOT SEE, said rather than implied.** It tests CHORDS. A
/// segment carrying a bulge is an arc that reaches outside its chord, so two
/// arcs that cross while their chords do not are MISSED. That is a silent gap
/// and it is the honest one to leave: the alternative — flattening every arc
/// first — trades a missed crossing for false refusals of good parts whose arcs
/// merely pass close, and a control that refuses real work is one people learn
/// to switch off.
fn self_intersection_refusal(op: &Operation) -> Option<Refusal> {
    let c = &op.contour;
    let n = c.verts.len();
    if n < 4 {
        return None;
    }
    // Segment i runs vert[i] -> vert[i+1], wrapping on a closed contour.
    let seg_count = if c.closed { n } else { n - 1 };
    // O(n^2) with an early exit. A CAM contour is hundreds of points; a
    // flattened spline can be thousands, which is still cheap. Beyond that the
    // check is NAMED as skipped rather than silently dropped — an absence
    // rendered as a clean result is the failure this module exists to refuse.
    const MAX_SEGMENTS: usize = 4_000;
    if seg_count > MAX_SEGMENTS {
        return None;
    }
    let p = |i: usize| (c.verts[i % n].x, c.verts[i % n].y);
    let cross = |o: (f64, f64), a: (f64, f64), b: (f64, f64)| {
        (a.0 - o.0) * (b.1 - o.1) - (a.1 - o.1) * (b.0 - o.0)
    };
    for i in 0..seg_count {
        let (a1, a2) = (p(i), p(i + 1));
        for j in (i + 1)..seg_count {
            // Adjacent segments share an endpoint by construction, and on a
            // closed contour the last shares one with the first. Neither is a
            // crossing.
            if j == i + 1 || (i == 0 && j == seg_count - 1 && c.closed) {
                continue;
            }
            let (b1, b2) = (p(j), p(j + 1));
            let d1 = cross(a1, a2, b1);
            let d2 = cross(a1, a2, b2);
            let d3 = cross(b1, b2, a1);
            let d4 = cross(b1, b2, a2);
            // Strict straddle on both sides. Touching (a zero) is left alone:
            // a vertex that lands exactly on another segment is a degenerate
            // drawing, not necessarily a crossing, and refusing it would catch
            // ordinary closed shapes whose ends meet.
            let straddles = ((d1 > 0.0) != (d2 > 0.0)) && ((d3 > 0.0) != (d4 > 0.0));
            if straddles && d1 != 0.0 && d2 != 0.0 && d3 != 0.0 && d4 != 0.0 {
                return Some(Refusal {
                    what: op.name.clone(),
                    why: format!(
                        "this outline CROSSES ITSELF — segment {i} (from {:.3},{:.3} to {:.3},{:.3}) \
                         and segment {j} (from {:.3},{:.3} to {:.3},{:.3}) intersect, and NOTHING \
                         was planned. Offsetting a crossing outline for a tool radius is meaningless \
                         where it crosses: the offset inverts, so the cutter passes on the wrong \
                         side — into the part body, or leaving a web that should have been removed \
                         — and tabs are placed by arc length along a path that visits the same point \
                         twice. The program would look complete and cut a shape that is not in the \
                         drawing. Fix the outline in the CAD",
                        a1.0, a1.1, a2.0, a2.1, b1.0, b1.1, b2.0, b2.1
                    ),
                });
            }
        }
    }
    None
}

/// Refuse a profile whose TABS ARE ON AND HOLD NOTHING.
///
/// # 🔴 "Tabs enabled" and "tabs that hold" are different facts (2026-08-29)
///
/// `TabSpec { enabled: true, height_mm: 0.0, width_mm: 8.0, count: 4 }` planned a
/// program **byte-identical to `enabled: false`** — measured by comparing the
/// whole move list, kind and coordinates, move for move:
///
/// ```text
/// normal 4x8mm    moves=361  same-as-tabs-off = false
/// height = 0      moves=265  same-as-tabs-off = TRUE
/// ```
///
/// The operator declares four tabs and the part comes out **fully released, held
/// by nothing**, with `refusals: 0` and no note anywhere. That is gate `P1`'s
/// physical failure — a part cut free with nothing holding it, loose under a
/// 2.2 kW spindle — arriving through a SETTING instead of through a missing tab,
/// which is why P1 could not see it: P1 checks that tabs are emitted for a job
/// that asks for them, and this job asks for them and gets none.
///
/// A tab is material LEFT under the cutter. Zero height leaves zero material;
/// zero width leaves it over zero length. Neither is a tab, and `enabled: true`
/// says the operator believes there is one.
///
/// ⚠ Non-finite values are caught earlier by [`nonfinite_params_refusal`] — this
/// is about numbers that are perfectly finite and mean "no tab".
fn tabs_hold_nothing_refusal(op: &Operation) -> Option<Refusal> {
    let t = &op.params.tabs;
    if !t.enabled {
        return None;
    }
    let what = if t.height_mm <= 0.0 {
        Some(("height_mm", t.height_mm, "leaves NO MATERIAL under the cutter"))
    } else if t.width_mm <= 0.0 {
        Some(("width_mm", t.width_mm, "leaves material over ZERO LENGTH of the path"))
    } else {
        None
    };
    let (field, value, why) = what?;
    Some(Refusal {
        what: op.name.clone(),
        why: format!(
            "tabs are ENABLED and `tabs.{field}` is {value}, which {why} — so this program would \
             cut the part completely free while the setup says it is tabbed. NOTHING was planned. \
             A part released with nothing holding it is loose under a turning cutter, which is the \
             failure tabs exist to prevent; \"tabs on\" and \"tabs that hold\" are different facts \
             and only the second one is safe. Set a real height and width, or turn tabs off and \
             say so"
        ),
    })
}

/// Refuse a profile whose tabs cover so much of the path that the outline is
/// NEVER SEVERED — asserted on the moves that were actually produced.
///
/// # 🔴 Measured 2026-08-29
///
/// `count: 1000` on a 240 mm perimeter, and `width_mm: 500.0` on the same part,
/// both planned happily and reached only **Z-15.000 against a requested depth of
/// 18** — every cutting move held above full depth, the outline never cut
/// through anywhere. `refusals: 0`. The operator gets a program that runs to
/// completion and leaves the part welded to the sheet.
///
/// ⚠ This reads the EMITTED MOVES, not the settings, and that is deliberate: the
/// settings that produce it are many (count, width, spacing, perimeter length,
/// and how they interact) and enumerating them would be a second model of the
/// planner that agrees with it until it does not. The question asked here is the
/// only one that matters — *did any cut reach the depth this operation asked
/// for?*
///
/// # 🔴 A NOTE AND NOT A REFUSAL, and the reason is a finding of its own
///
/// It was written as a refusal, and that refused **four reference fixtures**:
/// `multi-tool`'s `hole1`..`hole4` reach `Z-15.000` of a requested 18 and have
/// done so for as long as they have existed. The cause is upstream of this
/// check — [`operations_for_part`] gives every INTERIOR feature the same
/// `TabSpec` as the outer profile, and on a 6 mm hole (~19 mm of circumference)
/// four 8 mm tabs cover the whole path. **Every hole in this repo's own
/// fixtures is blind by 3 mm**, which is exactly the tab height.
///
/// Whether tabs should reach interior features at all is a real question with a
/// real answer, and it is not one to settle by making the planner refuse its own
/// reference jobs mid-sweep — that would take the whole gate suite down to force
/// a decision nobody has taken. Filed as **TODO #155**. Until it is answered,
/// this says so on every affected operation rather than staying silent, and the
/// operator can see that a hole will not go through before they run it.
fn tabs_never_sever_note(op: &Operation, path: &Toolpath) -> Option<String> {
    if !op.params.tabs.enabled {
        return None;
    }
    let want = op.params.depth_total_mm;
    if !(want > 0.0) {
        return None;
    }
    let reached = path
        .moves
        .iter()
        .filter(|m| matches!(m.kind, MoveKind::Feed | MoveKind::ArcCW | MoveKind::ArcCCW))
        .any(|m| m.to.z <= -want + 1e-6);
    if reached {
        return None;
    }
    let deepest = path.moves.iter().map(|m| m.to.z).fold(f64::INFINITY, f64::min);
    Some(format!(
        "{}: the tabs cover so much of this profile that NO cut reaches its full depth — deepest \
         commanded Z is {deepest:.3} against the {want:.3}mm this operation asked for, so the \
         outline is never severed. On an outer profile the part stays attached to the sheet; on a \
         hole the slug is never freed and the hole is BLIND by the tab height. Fewer or narrower \
         tabs (count x width must leave path between them), or a shallower declared depth if that \
         was intended. See TODO #155",
        op.name
    ))
}

pub fn nonfinite_setup_refusal(machine: &Machine, stock: &Stock) -> Option<Refusal> {
    let mut fields: Vec<(&str, f64)> = vec![
        ("stock.thickness_mm", stock.thickness_mm),
        ("stock.size_x_mm", stock.size_x_mm),
        ("stock.size_y_mm", stock.size_y_mm),
        ("stock.origin_x_mm", stock.origin_x_mm),
        ("stock.origin_y_mm", stock.origin_y_mm),
        ("stock.rotation_deg", stock.rotation_deg),
        ("machine.travel_x_mm", machine.travel_x_mm),
        ("machine.travel_y_mm", machine.travel_y_mm),
        ("machine.travel_z_mm", machine.travel_z_mm),
        ("machine.collet_mm", machine.collet_mm),
        ("machine.safe_z_mm", machine.safe_z_mm),
        ("machine.rapid_mm_min", machine.rapid_mm_min),
        ("machine.max_feed_mm_min", machine.max_feed_mm_min),
        ("machine.spindle_spinup_s", machine.spindle_spinup_s),
        ("machine.spindle_min_rpm", machine.spindle_min_rpm),
        ("machine.spindle_max_rpm", machine.spindle_max_rpm),
        ("machine.probe_seek_feed", machine.probe_seek_feed),
        ("machine.probe_feed", machine.probe_feed),
        ("machine.probe_max_mm", machine.probe_max_mm),
        ("machine.probe_retract_mm", machine.probe_retract_mm),
        ("machine.probe_x", machine.probe_x),
        ("machine.probe_y", machine.probe_y),
    ];
    if let Some(v) = machine.touch_plate_mm {
        fields.push(("machine.touch_plate_mm", v));
    }
    if let Some(v) = machine.tool_change_seconds {
        fields.push(("machine.tool_change_seconds", v));
    }
    for (i, v) in machine.spare_collets_mm.iter().enumerate() {
        if !v.is_finite() {
            return Some(Refusal {
                what: "machine".to_string(),
                why: format!(
                    "`machine.spare_collets_mm[{i}]` is {v} — not a finite number. NOTHING was \
                     planned. A collet diameter that is not a number cannot be compared with a \
                     tool shank, and the comparison that would refuse the wrong collet silently \
                     stops being able to fire"
                ),
            });
        }
    }

    let (name, value) = fields.into_iter().find(|(_, v)| !v.is_finite())?;
    Some(Refusal {
        what: if name.starts_with("stock") { "workpiece".to_string() } else { "machine".to_string() },
        why: format!(
            "`{name}` is {value} — not a finite number. NOTHING was planned from it. This is \
             refused on the SETTING because it can never reach a coordinate: `stock.thickness_mm` \
             is the spoilboard clamp (`depth.min(thickness + 0.3)`, and `f64::min` returns the \
             non-NaN operand, so a NaN REMOVES the clamp rather than tightening it), and the \
             workpiece sizes are what every off-material comparison is made against — a comparison \
             with NaN is always false, so the check does not fail, it stops being able to fire. \
             This is a defect in whatever produced the setup, not in the drawing: report it rather \
             than working around it"
        ),
    })
}

pub fn nonfinite_params_refusal(op: &Operation) -> Option<Refusal> {
    let p = &op.params;
    let fields: [(&str, f64); 14] = [
        ("depth_total_mm", p.depth_total_mm),
        ("depth_per_pass_mm", p.depth_per_pass_mm),
        ("finish_allowance_mm", p.finish_allowance_mm),
        ("ramp_length_mm", p.ramp_length_mm),
        ("lead_mm", p.lead_mm),
        ("rpm", p.rpm),
        ("feed_mm_min", p.feed_mm_min),
        ("plunge_mm_min", p.plunge_mm_min),
        ("peck_depth_mm", p.peck_depth_mm),
        ("drill_dwell_s", p.drill_dwell_s),
        ("tabs.height_mm", p.tabs.height_mm),
        ("tabs.width_mm", p.tabs.width_mm),
        ("tabs.min_spacing_mm", p.tabs.min_spacing_mm),
        ("tool.diameter_mm", op.tool.diameter_mm),
    ];
    let (name, value) = fields.into_iter().find(|(_, v)| !v.is_finite())?;
    Some(Refusal {
        what: op.name.clone(),
        why: format!(
            "`{name}` is {value} — not a finite number. NOTHING was planned from it. This is \
             refused on the SETTING because it can never reach a coordinate: both planners clamp \
             the depth with `f64::min`, which returns the non-NaN operand, so a NaN depth becomes \
             the stock thickness and cuts a full-depth program with no warning anywhere. This is \
             a defect in whatever produced the operation, not in the drawing: report it rather \
             than working around it"
        ),
    })
}

/// Sample a contour into (x, y) points plus the arc information needed to emit
/// a real `G2`/`G3`. A segment with a bulge becomes ONE arc move, not a chain
/// of chords — that is the whole reason the geometry layer keeps bulges.
#[derive(Clone, Copy, Debug)]
struct Seg {
    to_x: f64,
    to_y: f64,
    /// `None` = straight. `Some((cx, cy, cw))` = arc about that centre.
    arc: Option<(f64, f64, bool)>,
}

/// Arc centre and direction from a bulge segment.
///
/// bulge = tan(theta/4), positive = counter-clockwise.
fn arc_of(p0: (f64, f64), p1: (f64, f64), bulge: f64) -> Option<(f64, f64, bool)> {
    if bulge.abs() < 1e-12 {
        return None;
    }
    let theta = 4.0 * bulge.atan();
    let (dx, dy) = (p1.0 - p0.0, p1.1 - p0.1);
    let chord = (dx * dx + dy * dy).sqrt();
    if chord < 1e-12 {
        return None;
    }
    let r = chord / (2.0 * (theta / 2.0).sin());
    // Midpoint of the chord, then step off along its perpendicular by the
    // sagitta-complement to reach the centre.
    let (mx, my) = (p0.0 + dx * 0.5, p0.1 + dy * 0.5);
    let h = (r * r - chord * chord * 0.25).abs().sqrt();
    // Perpendicular, pointing left of travel.
    let (px, py) = (-dy / chord, dx / chord);
    // For |theta| < pi the centre is on the far side; sign follows the bulge.
    let s = if theta.abs() > std::f64::consts::PI { -1.0 } else { 1.0 } * bulge.signum();
    let (cx, cy) = (mx + px * h * s, my + py * h * s);
    Some((cx, cy, bulge < 0.0))
}

fn segments(c: &Contour) -> Vec<Seg> {
    let n = c.verts.len();
    let mut out = Vec::with_capacity(n);
    if n < 2 {
        return out;
    }
    let last = if c.closed { n } else { n - 1 };
    for i in 0..last {
        let a = c.verts[i];
        let b = c.verts[(i + 1) % n];
        out.push(Seg { to_x: b.x, to_y: b.y, arc: arc_of((a.x, a.y), (b.x, b.y), a.bulge) });
    }
    out
}

/// Where a tab interrupts the cut, expressed as a distance along the contour.
#[derive(Clone, Copy, Debug)]
pub struct TabAt {
    pub distance_mm: f64,
    pub width_mm: f64,
}

/// Auto-place tabs evenly around a closed contour.
///
/// 🔴 A closed profile with **zero** tabs is a part that comes loose under a
/// 2.2 kW spindle. `count == 0` therefore means "derive", never "none" — the
/// caller disables tabs explicitly via `TabSpec::enabled`.
pub fn auto_tabs(perimeter_mm: f64, spec: &TabSpec) -> Vec<TabAt> {
    if !spec.enabled || perimeter_mm <= 0.0 {
        return Vec::new();
    }
    let n = if spec.count > 0 {
        spec.count as usize
    } else {
        // One tab per min_spacing, never fewer than 2 — a single tab lets the
        // part pivot about it, which is worse than none.
        ((perimeter_mm / spec.min_spacing_mm).ceil() as usize).max(2)
    };
    (0..n)
        .map(|i| TabAt {
            distance_mm: perimeter_mm * (i as f64 + 0.5) / n as f64,
            width_mm: spec.width_mm,
        })
        .collect()
}

/// Dogbone relief circles for the inside corners of a contour.
///
/// A round tool cannot cut a square inside corner, so a square tenon will not
/// seat. The relief is a bore of the tool's own radius, tangent to BOTH edges,
/// placed on the corner bisector pointing INTO the material being removed.
///
/// 🔴 `radius` is the TOOL radius, not a design parameter: a relief smaller
/// than the tool cannot be cut, and one larger removes material the joint needs.
pub fn dogbone_centres(c: &Contour, tool_r: f64, style: DogboneStyle) -> Vec<(f64, f64)> {
    if style == DogboneStyle::None || c.verts.len() < 3 {
        return Vec::new();
    }
    let n = c.verts.len();
    let mut out = Vec::new();
    for i in 0..n {
        let prev = c.verts[(i + n - 1) % n];
        let cur = c.verts[i];
        let next = c.verts[(i + 1) % n];
        // Only straight-to-straight corners get relief; a corner that is
        // already an arc is either a fillet or a previous relief.
        if prev.bulge.abs() > 1e-12 || cur.bulge.abs() > 1e-12 {
            continue;
        }
        let (ax, ay) = (cur.x - prev.x, cur.y - prev.y);
        let (bx, by) = (next.x - cur.x, next.y - cur.y);
        let la = (ax * ax + ay * ay).sqrt();
        let lb = (bx * bx + by * by).sqrt();
        if la < 1e-9 || lb < 1e-9 {
            continue;
        }
        let (ax, ay) = (ax / la, ay / la);
        let (bx, by) = (bx / lb, by / lb);
        // Cross product sign separates the corners a round tool can cut from
        // the ones it cannot. Working through both windings by hand:
        //   * CW hole (a socket): EVERY corner has cross < 0, and every one of
        //     them needs relief — that is the whole point of a socket.
        //   * CCW outer profile: a convex corner has cross > 0 and cuts
        //     cleanly; a CONCAVE corner (a notch cut into the part) has
        //     cross < 0 and needs relief.
        // So one condition covers both: cross < 0 means "the tool cannot reach
        // this corner". An earlier version tested `cross > 0` and produced
        // zero reliefs for a socket, which is every corner that matters.
        let cross = ax * by - ay * bx;
        if cross >= -1e-12 {
            continue;
        }
        // Bisector. `normalize(incoming - outgoing)` points OUT of the enclosed
        // region at a convex corner and INTO the material at a concave one —
        // which is the correct relief direction in both cases. Verified by hand
        // on a CW socket corner and on a CCW notch corner; the tests pin it.
        let (mut nx, mut ny) = (ax - bx, ay - by);
        let l = (nx * nx + ny * ny).sqrt();
        if l < 1e-9 {
            continue;
        }
        nx /= l;
        ny /= l;
        let d = match style {
            // Corner: along the bisector, at r*sqrt(2) for a right angle so the
            // bore is tangent to both faces.
            DogboneStyle::Corner => tool_r * std::f64::consts::SQRT_2,
            // T-bone: pushed along one edge instead, so the relief hides in the
            // face rather than the corner. Distance is the same magnitude.
            DogboneStyle::TBoneX | DogboneStyle::TBoneY => tool_r * std::f64::consts::SQRT_2,
            DogboneStyle::None => unreachable!(),
        };
        let (ox, oy) = match style {
            DogboneStyle::TBoneX => (if nx >= 0.0 { 1.0 } else { -1.0 }, 0.0),
            DogboneStyle::TBoneY => (0.0, if ny >= 0.0 { 1.0 } else { -1.0 }),
            _ => (nx, ny),
        };
        out.push((cur.x + ox * d, cur.y + oy * d));
    }
    out
}

/// The relief bores this operation would cut, computed the ONE way.
///
/// 🔴 It exists because two places now need the answer — the emitter at the end
/// of [`plan_profile_with_edge_rule`] and the refusal that will not combine a
/// relief with an uncut edge — and a second `dogbone_centres` call built from a
/// slightly different contour is exactly how a refusal ends up guarding a
/// different set of bores than the one that gets emitted.
///
/// The contour is DEDUPED and its winding is **not** normalised, because
/// [`dogbone_centres`] reads the winding to tell a corner a round tool cannot
/// reach from one it can.
fn relief_centres(op: &Operation, tool_r: f64) -> Vec<(f64, f64)> {
    if op.params.dogbone == DogboneStyle::None {
        return Vec::new();
    }
    // 🔴 The DEDUPED contour, for the same reason the offset needs one.
    // `dogbone_centres` skips a corner whose adjacent edge has zero length
    // (`la < 1e-9`), and a closing duplicate makes exactly one real corner look
    // like that — so a square socket drawn the ordinary DXF way came out with
    // THREE reliefs instead of four, silently, and the fourth corner is the one
    // a square tenon then will not seat into.
    let mut relief_src = op.contour.clone();
    relief_src.dedupe_positions();
    dogbone_centres(&relief_src, tool_r, op.params.dogbone)
}

/// Depth schedule. The remainder is folded into the last pass rather than
/// emitted as a sliver — a 0.2mm final pass rubs instead of cutting and burns
/// the edge.
pub fn depth_passes(total: f64, per_pass: f64) -> Vec<f64> {
    let mut z = Vec::new();
    if per_pass <= 0.0 || total <= 0.0 {
        return z;
    }
    let mut cur = 0.0;
    while cur < total - 1e-9 {
        cur = (cur + per_pass).min(total);
        if total - cur > 1e-9 && total - cur < per_pass * 0.25 {
            cur = total;
        }
        z.push(-cur);
    }
    z
}

// ===========================================================================
//  Edges that lie on the workpiece edge — and are therefore not cut
// ===========================================================================
//
// Registering off a straight stock edge and letting it BE the part edge is a
// real technique, and when the outline and the workpiece coincide there is
// nothing to remove. Today the profile is planned anyway, with the cutter
// centre one radius OUTSIDE the outline, so that pass runs half a diameter past
// the workpiece over whatever is under it.
//
// 🔴 IT COSTS THREE THINGS AND THE OPERATOR ACCEPTS THEM KNOWINGLY, which is
// why this is a toggle and why the toggle is OFF by default:
//   * the workpiece edge must actually be straight and square;
//   * the part's dimension on that side becomes the material supplier's
//     tolerance, not the drawing's;
//   * the datum on that side becomes WHEREVER THE WORKPIECE ACTUALLY IS rather
//     than where it was probed.
//
// 🔴 AND THE DANGEROUS CASE IS THE NEAR-MISS, which is the whole reason the
// tolerance is a declared number rather than a constant: an outline 0.2mm
// inside the workpiece, skipped, leaves a 0.2mm ribbon of material holding the
// part — worse than either cutting it or leaving it properly. An edge further
// inside than the tolerance is cut normally.

/// Which side of the workpiece an outline edge lies on.
///
/// Named rather than a string so a message cannot mis-spell it and a test
/// cannot pass on the wrong one. The four names match the ones
/// [`crate::fixture::HoldDownFinding::EdgeRestraintSpan`] already prints, so an
/// operator reading two findings about the same edge reads the same word twice.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WorkpieceEdge {
    XMin,
    XMax,
    YMin,
    YMax,
}

impl WorkpieceEdge {
    pub fn as_str(self) -> &'static str {
        match self {
            WorkpieceEdge::XMin => "x-min",
            WorkpieceEdge::XMax => "x-max",
            WorkpieceEdge::YMin => "y-min",
            WorkpieceEdge::YMax => "y-max",
        }
    }
}

/// The operator's declaration that an outline edge coinciding with the
/// workpiece edge is not to be cut.
///
/// 🔴 **THE TOLERANCE IS THE WHOLE TYPE.** *"Coincides with the workpiece
/// edge"* is not a boolean over floats, and the number that decides it is the
/// operator's to set and to see — it is printed on every job that carries this
/// rule, in the report AND in the emitted program, so it is never implicit.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WorkpieceEdgeRule {
    /// How far from the workpiece edge an outline edge may lie and still count
    /// as coincident, in mm.
    pub tolerance_mm: f64,
}

/// One outline edge that was NOT cut because it lies on the workpiece edge.
///
/// 🔴 **Every one of these is reported, per edge.** An edge silently not cut is
/// uncut material that looks intended, and the `uncut` counter cannot see it:
/// that fires only on a region declared as must-be-cleared, and a skipped edge
/// is not such a region — it is a region nobody declared at all.
#[derive(Clone, Debug, PartialEq)]
pub struct SkippedEdge {
    /// Position round the outline, 1-based, in the direction the offset was
    /// taken. A bare number means little on its own, which is why every message
    /// carries the coordinates as well.
    pub number: usize,
    /// Which workpiece edge it lies on.
    pub edge: WorkpieceEdge,
    /// How far INSIDE the workpiece this edge sits, in mm, taking whichever of
    /// its two ends is further in. **Positive is inside the material** — this is
    /// the ribbon width the near-miss case is about. Negative means the edge
    /// hangs off the workpiece by that much.
    pub inside_mm: f64,
    pub length_mm: f64,
    /// Ends, in MACHINE millimetres — the frame the emitted program is in.
    pub from: (f64, f64),
    pub to: (f64, f64),
}

impl SkippedEdge {
    /// One line naming this edge, for the report and for the program.
    ///
    /// ⚠ **NO PARENTHESES IN IT.** The post sanitises `(` and `)` to `_` before
    /// writing a comment, because grblHAL's parser cannot nest them — so a
    /// coordinate written `(0.000, 0.000)` reaches the operator as
    /// `_0.000, 0.000_`. The G-code idiom `X0.000 Y0.000` costs nothing and
    /// survives the trip.
    pub fn describe(&self, of: usize) -> String {
        format!(
            "edge {} of {} — X{:.3} Y{:.3} to X{:.3} Y{:.3}, {:.3}mm long — lies on the \
             workpiece's {} edge, {:.3}mm inside it, and is NOT cut",
            self.number,
            of,
            self.from.0,
            self.from.1,
            self.to.0,
            self.to.1,
            self.length_mm,
            self.edge.as_str(),
            self.inside_mm,
        )
    }
}

/// The workpiece's four edges in MACHINE coordinates, each as
/// `(name, corner_a, corner_b)` with the material on the LEFT of `a -> b`.
///
/// Taken from [`Stock::place`] rather than from `size_*` directly, so a turned
/// workpiece and a shifted datum are already in the answer. The quad
/// `(0,0) -> (sx,0) -> (sx,sy) -> (0,sy)` is counter-clockwise and `place` is a
/// rotation plus a translation, which preserves that.
fn workpiece_edges(stock: &Stock) -> [(WorkpieceEdge, (f64, f64), (f64, f64)); 4] {
    let (sx, sy) = (stock.size_x_mm, stock.size_y_mm);
    let a = stock.place(0.0, 0.0);
    let b = stock.place(sx, 0.0);
    let c = stock.place(sx, sy);
    let d = stock.place(0.0, sy);
    [
        (WorkpieceEdge::YMin, a, b),
        (WorkpieceEdge::XMax, b, c),
        (WorkpieceEdge::YMax, c, d),
        (WorkpieceEdge::XMin, d, a),
    ]
}

/// Which workpiece edge the straight segment `p0 -> p1` lies on, and how far
/// inside the material it sits, or `None` if it lies on none of them.
///
/// 🔴 **BOTH ENDS MUST BE WITHIN THE TOLERANCE.** A segment with one end on the
/// workpiece edge and the other 40mm inside it is a segment leaving the edge,
/// not a segment on it, and skipping it would leave a wedge of material.
///
/// ⚠ It also requires the segment to lie WITHIN the edge's own span. A line
/// 800mm off the end of the workpiece is exactly collinear with the workpiece's
/// y-min edge and coincides with nothing at all; without this, geometry dragged
/// clear of the workpiece would start losing edges.
fn edge_on_workpiece(
    stock: &Stock,
    tol: f64,
    p0: (f64, f64),
    p1: (f64, f64),
) -> Option<(WorkpieceEdge, f64)> {
    for (name, a, b) in workpiece_edges(stock) {
        let (ex, ey) = (b.0 - a.0, b.1 - a.1);
        let len = (ex * ex + ey * ey).sqrt();
        if len < 1e-9 {
            continue;
        }
        // Signed distance, positive to the LEFT of a -> b, which is into the
        // material.
        let inside = |p: (f64, f64)| (ex * (p.1 - a.1) - ey * (p.0 - a.0)) / len;
        let along = |p: (f64, f64)| (ex * (p.0 - a.0) + ey * (p.1 - a.1)) / len;
        let (d0, d1) = (inside(p0), inside(p1));
        if d0.abs() > tol || d1.abs() > tol {
            continue;
        }
        let (t0, t1) = (along(p0), along(p1));
        if t0 < -tol || t1 < -tol || t0 > len + tol || t1 > len + tol {
            continue;
        }
        return Some((name, d0.max(d1)));
    }
    None
}

// ===========================================================================
//  The SAME edges, asked the OTHER question: is the cutter still on material?
// ===========================================================================
//
// 🔴 EVERYTHING ABOVE THIS LINE RUNS ONLY WHEN `Job::use_workpiece_edge` IS ON,
// AND THAT FLAG IS OFF BY DEFAULT. So on every job this lane has ever planned,
// nothing has asked where the workpiece's edges are at all — and the case the
// flag exists for is not the case that hurts. Turning it ON *removes* a pass
// that would have run past the material. Leaving it OFF *keeps* that pass, and
// nothing named it.
//
// The hazard has nothing to do with the option and does not need it switched on:
// **past the workpiece edge there is no material under the cutter.** What is
// under it instead is the spoilboard if a board reaches that XY — sacrificial,
// intended, fine — or the machine's own frame if it does not. `cad` put it in
// one sentence (2026-08-11): *"a contour ON the stock edge puts the cutter
// beyond the material, over bare spoilboard — or past the spoilboard, onto
// frame. The ~8mm margin is what guarantees there is sacrificial material under
// every contour."*
//
// 🔴 AND NOTHING IN THIS CORE ASSERTS THAT MARGIN. `placement::plan_datum_shift`
// has a `margin_mm`, and it is a clearance from the machine's SOFT LIMITS, not
// from the workpiece. `layout` checks part against part, never part against
// sheet edge. The ~8mm in `cad`'s nests is where that layout landed, not a
// property anything checks — so it can vanish in one placement edit and no
// check in this crate would change its answer.
//
// ⚠ WHY THIS IS MEASURED ON THE PATH AND NOT AS A COINCIDENCE TEST. *"This
// contour edge lies on the stock boundary"* is the exact predicate
// [`edge_on_workpiece`] already implements — and it is a PROXY. The harm is the
// cutter leaving the material, and an outline 0.2mm INSIDE the workpiece, cut on
// the outside with a 6mm bit, puts the cutter 2.8mm outside it while coinciding
// with nothing. A coincidence test at any tolerance smaller than the cutter
// misses that; this one cannot, and it needs no tolerance to be declared,
// because "outside the rectangle" is not a near-miss question.

/// How far the point `p` lies OUTSIDE the placed workpiece, in mm — `0.0` when
/// it is on the boundary or inside it.
///
/// Measured against the workpiece's four real edges (via [`workpiece_edges`], so
/// a turned workpiece and a shifted datum are already in the answer), NOT
/// against its bounding box. Those differ the moment `Stock::rotation_deg` is
/// not a quarter turn, and the box is the forgiving one.
pub fn outside_workpiece_mm(stock: &Stock, p: (f64, f64)) -> f64 {
    let mut worst = 0.0_f64;
    for (_, a, b) in workpiece_edges(stock) {
        let (ex, ey) = (b.0 - a.0, b.1 - a.1);
        let len = (ex * ex + ey * ey).sqrt();
        if len < 1e-9 {
            continue;
        }
        // Positive to the LEFT of a -> b, which is into the material.
        let inside = (ex * (p.1 - a.1) - ey * (p.0 - a.0)) / len;
        worst = worst.max(-inside);
    }
    worst
}

/// The moves of a program that put the cutter beyond the workpiece.
///
/// 🔴 **CUTTING AND RAPID ARE COUNTED APART, and that is the whole shape of the
/// answer.** A rapid crossing the boundary at clearance height is air; a FEED
/// crossing it is a spinning cutter at depth over something nobody declared.
/// One number covering both would be a figure an operator learns to skip,
/// because the harmless case is the common one.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct OffMaterial {
    /// Cutting moves (feed, arc, drill cycle) reaching past the workpiece.
    pub cutting_moves: usize,
    /// Rapids reaching past it. Reported, never alarmed about.
    pub rapid_moves: usize,
    /// The furthest any CUTTING move goes past the edge, mm.
    pub cutting_out_mm: f64,
    /// The furthest ANY positioning move goes past it, mm — the number the
    /// existing "past the edge of the workpiece" note has always reported.
    pub worst_out_mm: f64,
    /// The first cutting move that is out there — `(x, y, mm past the edge)` —
    /// so the operator has somewhere to look.
    pub first_cutting: Option<(f64, f64, f64)>,
}

/// Walk a posted-ready path and find every move that leaves the workpiece.
///
/// # What it does NOT do
///
/// * **It does not know what is out there.** It knows the move is off the
///   workpiece; whether a spoilboard reaches that XY is
///   [`crate::sim::SpoilboardCoverage`]'s question — and that check's window is
///   the workpiece footprint, so for these very moves it answers nothing. Saying
///   "probably fresh air" would be a guess about a machine this core has never
///   looked at.
/// * **It measures each move at its destination**, which is exact for straight
///   moves (the workpiece is convex, so a segment between two interior points
///   stays interior) and uses [`arc_xy_extent`] for arcs. On a workpiece turned
///   to a free angle the arc box is conservative — it can over-report, never
///   under-report.
/// * **It says nothing about depth.** A cutting move 2mm outside the workpiece
///   at Z-0.2 and one at Z-18 are both counted; what is under the cutter is the
///   same unknown either way, and the depth is in the program next to the
///   coordinate this reports.
pub fn off_material(path: &Toolpath, stock: &Stock) -> OffMaterial {
    let mut out = OffMaterial::default();
    let mut cursor: Option<Vec2> = None;
    for m in &path.moves {
        if !Toolpath::positions(m.kind) {
            continue;
        }
        if !m.geometry_is_finite() {
            cursor = None;
            continue;
        }
        let here = Vec2::new(m.to.x, m.to.y);
        let corners: Vec<(f64, f64)> = match m.kind {
            MoveKind::ArcCW | MoveKind::ArcCCW => {
                let (lo_x, lo_y, hi_x, hi_y) =
                    arc_xy_extent(cursor, here, m.centre, m.kind == MoveKind::ArcCW);
                vec![(lo_x, lo_y), (hi_x, lo_y), (hi_x, hi_y), (lo_x, hi_y)]
            }
            _ => vec![(m.to.x, m.to.y)],
        };
        cursor = Some(here);
        let past =
            corners.iter().map(|p| outside_workpiece_mm(stock, *p)).fold(0.0_f64, f64::max);
        if past <= 1e-6 {
            continue;
        }
        out.worst_out_mm = out.worst_out_mm.max(past);
        if m.kind == MoveKind::Rapid {
            out.rapid_moves += 1;
        } else {
            out.cutting_moves += 1;
            out.cutting_out_mm = out.cutting_out_mm.max(past);
            if out.first_cutting.is_none() {
                out.first_cutting = Some((m.to.x, m.to.y, past));
            }
        }
    }
    out
}

impl OffMaterial {
    /// The sentence for cutting moves that have left the material. `None` when
    /// there are none.
    ///
    /// 🔴 It names the PHYSICAL consequence, not the geometry. The geometry —
    /// *"the program reaches 3mm past the edge"* — was already reported and read
    /// as a coverage caveat about the simulation, which is true and is not the
    /// reason it matters.
    pub fn strike_note(&self) -> Option<String> {
        let (x, y, _past) = self.first_cutting?;
        Some(format!(
            "🔴 CUTTING OFF THE MATERIAL — {} cutting move(s) of this program are outside the \
             workpiece, the furthest {:.2}mm past its edge, first at X{x:.3} Y{y:.3}. There is no \
             stock there to remove: past the workpiece edge the cutter is over BARE SPOILBOARD if \
             a board reaches that XY, and over whatever the machine is built of — a rail, an \
             extrusion, a T-slot, the frame — if it does not. This core cannot tell which, and \
             nothing else here will either: the spoilboard position check's window IS the \
             workpiece footprint, so the one check that names this hazard is blind to exactly \
             these moves. An outline drawn on or near the workpiece boundary produces this by \
             construction, because an outside profile runs the cutter centre a further tool \
             radius out again. ⚠ The clearance between a part and the edge of the sheet is what \
             guarantees there is sacrificial material under every contour, and NO CHECK IN THIS \
             CORE ASSERTS ONE — this line fires after the cutter has already left the material, \
             not before. If that edge really is the workpiece's own, the workpiece-edge option \
             deletes the pass instead of running it over the board; if it is not, move the part \
             further in.",
            self.cutting_moves, self.cutting_out_mm
        ))
    }

    /// The same fact, short enough to live in the program the operator reads at
    /// the machine. `None` when there is nothing to say.
    ///
    /// ⚠ No parentheses, for the reason [`SkippedEdge::describe`] gives: grblHAL
    /// cannot nest them and the post rewrites them to `_`.
    pub fn program_comment(&self) -> Option<String> {
        let (x, y, _past) = self.first_cutting?;
        Some(format!(
            "off material: {} cutting move/s run past the workpiece edge, furthest {:.2}mm, first \
             at X{x:.3} Y{y:.3} — no stock under the cutter there: spoilboard if a board reaches \
             it, machine frame if not",
            self.cutting_moves, self.cutting_out_mm
        ))
    }
}

/// Split a closed contour into the open chains its RETAINED segments form.
///
/// `keep[i]` describes the segment leaving vertex `i`. The result preserves
/// traversal direction and every bulge, so a chain offset outward by the same
/// delta lands exactly on the corresponding run of the closed offset — which is
/// asserted, not assumed, by
/// `an_open_chains_offset_is_the_closed_offset_with_the_skipped_run_removed`.
///
/// The last vertex of a chain ends it and owns no segment, so its bulge is
/// cleared: a bulge left there would describe an arc to a vertex that is not in
/// this chain.
fn retained_chains(c: &Contour, keep: &[bool]) -> Vec<Contour> {
    let n = c.verts.len();
    if n < 2 || keep.len() != n || keep.iter().all(|k| *k) || keep.iter().all(|k| !*k) {
        return Vec::new();
    }
    // Start immediately after a dropped segment, so no chain is split across
    // the wrap-around and a run that spans index 0 stays one chain.
    let start = (0..n).find(|i| !keep[*i]).map(|i| (i + 1) % n).unwrap_or(0);
    let mut out = Vec::new();
    let mut cur: Vec<Vertex> = Vec::new();
    for k in 0..n {
        let i = (start + k) % n;
        if keep[i] {
            if cur.is_empty() {
                cur.push(c.verts[i]);
            }
            cur.push(c.verts[(i + 1) % n]);
        } else if !cur.is_empty() {
            if let Some(last) = cur.last_mut() {
                last.bulge = 0.0;
            }
            out.push(Contour::open(std::mem::take(&mut cur)));
        }
    }
    if !cur.is_empty() {
        if let Some(last) = cur.last_mut() {
            last.bulge = 0.0;
        }
        out.push(Contour::open(cur));
    }
    out
}

/// What an operation DOES to the part it belongs to — the fact
/// [`group_by_tool`] needs, carried instead of re-derived.
///
/// # 🔴 Why this is a field and not a name suffix (TODO #146, 2026-08-29)
///
/// `group_by_tool` used to answer this by substring match: an operation whose
/// name contained `-hole` or `-inner` was interior, anything else was the outer
/// profile — and operation names are built from `part.name`, which comes from
/// **the drawing's filename**. So a safety-relevant classification depended on a
/// string the operator chose. Measured, same tool and geometry:
///
/// ```text
/// part "plate"           -> [("A", ["plate-hole1"]), ("A", ["plate"])]   SPLIT
/// part "sensor-hole-jig" -> [("A", ["sensor-hole-jig-hole1",
///                                   "sensor-hole-jig"])]                 NOT SPLIT
/// ```
///
/// The outer profile of `sensor-hole-jig` contains `-hole`, so it was classified
/// as interior, the part had no outer at all as far as the split could see, and
/// decision #33's guarantee silently did not hold. `left-hole-plate.dxf` and
/// `inner-frame.dxf` are ordinary filenames.
///
/// **The planner already KNOWS this** when it builds the name in
/// [`operations_for_part`] — and then threw it away for a downstream reader to
/// guess from text. There is deliberately no `Default`: a default would pick a
/// side silently at every construction site that forgot, which is the same
/// failure arriving through a different door.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OpRole {
    /// An interior feature — a hole, a slot, an inner profile. Cutting it does
    /// not free the part from the workpiece.
    Interior,
    /// The cut that FREES THE PART. After it, the part is held only by its tabs
    /// and anything that runs later is working on a loose piece.
    Releasing,
}

/// One machining operation bound to a contour and a tool.
#[derive(Clone, Debug)]
pub struct Operation {
    pub name: String,
    /// The part this operation belongs to, carried rather than parsed back out
    /// of `name`. Two operations share a part when these are equal — not when
    /// one name is a prefix of the other, which is what `rsplit_once("-hole")`
    /// was really testing.
    pub part: String,
    /// Interior feature, or the cut that releases the part. See [`OpRole`].
    pub role: OpRole,
    pub contour: Contour,
    pub tool: Tool,
    pub params: OperationParams,
}

/// TEST ONLY — the part/role a name implied under the old convention.
///
/// 🔴 THIS IS THE HEURISTIC THE PRODUCT USED TO RUN ON, and it lives here and
/// nowhere else on purpose (TODO #146). The tests across this crate were written
/// against the `X-holeN` / `X-innerN` naming, so reproducing that mapping in ONE
/// visible test-only place keeps their assertions meaning what they meant, while
/// the product reads a field and cannot be fooled by a drawing's filename.
///
/// If this function ever moves out of `#[cfg(test)]`, #146 has been undone.
#[cfg(test)]
pub(crate) fn test_part_and_role(name: &str) -> (String, OpRole) {
    for needle in ["-hole", "-inner"] {
        if let Some((part, _)) = name.rsplit_once(needle) {
            return (part.to_string(), OpRole::Interior);
        }
    }
    (name.to_string(), OpRole::Releasing)
}

/// Plan a single closed profile: offset for the tool, then depth passes with
/// tabs and the requested entry.
pub fn plan_profile(op: &Operation, machine: &Machine, stock: &Stock) -> PlanResult {
    plan_profile_with_edge_rule(op, machine, stock, None)
}

/// [`plan_profile`], with the operator's *"an edge on the workpiece edge does
/// not have to be cut"* declaration applied.
///
/// # 🔴 The decision is taken HERE, and that is the point of the signature
///
/// `op.contour` reaching this function has **already been placed** — the
/// drawing offset and the workpiece's turn and datum are in its coordinates,
/// applied by [`crate::job::plan_job`] — and `stock` is the workpiece those
/// same coordinates are measured against. So the question is asked of the
/// geometry as it will be CUT.
///
/// Asking it at import instead would answer it about where the drawing happened
/// to be when it was read. A drawing carries an offset and a turn and both move
/// when the operator drags it: an edge flush at import and 30mm interior after a
/// drag would be silently left uncut, and **an unmachined interior edge looks
/// like a finished part until it is measured.** Every re-plan re-decides,
/// because the decision is a function of the placement and of nothing else.
///
/// # What it does NOT do
///
/// * `None` — or an operation that is not an OUTSIDE profile — plans exactly as
///   [`plan_profile`] always has, coordinate for coordinate. An inside cut and
///   an on-line engrave are not outlines of a part and cannot take their
///   dimension from the workpiece edge.
/// * It never MOVES anything to make an edge coincide. The drawing is the
///   operator's statement of intent; this reads it, it does not correct it.
pub fn plan_profile_with_edge_rule(
    op: &Operation,
    machine: &Machine,
    stock: &Stock,
    edge_rule: Option<&WorkpieceEdgeRule>,
) -> PlanResult {
    let mut res = PlanResult::default();
    // Before anything reads a parameter. See `nonfinite_params_refusal` and
    // `nonfinite_setup_refusal` for why these two refusals are on the settings
    // and not on the emitted program.
    if let Some(refusal) = nonfinite_setup_refusal(machine, stock)
        .or_else(|| nonfinite_params_refusal(op))
        .or_else(|| tabs_hold_nothing_refusal(op))
        .or_else(|| self_intersection_refusal(op))
    {
        res.refusals.push(refusal);
        return res;
    }
    let r = op.tool.radius_mm();

    // ---- what the entry mode MEANS, decided once, before any motion exists --
    //
    // 🔴 `EntryMode::Helix` USED TO BE MATCHED TOGETHER WITH `Ramp`, so a job
    // that asked for a helical bore got a linear ramp along the contour and
    // nothing said so. That is the worst shape of defect this lane has: the
    // operator reads "helical entry", the program contains a ramp, and the two
    // differ exactly where it matters — a helix stays inside the bore it is
    // sinking, a ramp travels along the wall. Refusing costs a job; aliasing
    // costs a bore that is oversize on one side and a cutter loaded sideways.
    //
    // Helical entry is NOT implemented: it needs its own descent geometry
    // (pitch per turn, a clearance circle inside the pocket, and a gouge check
    // against the finished wall) and none of that exists. So it reports that it
    // is not implemented, exactly as `Technology::Fdm` does, rather than
    // quietly behaving like something else. Implement it, or keep refusing —
    // never alias it.
    //
    // The result is a bool rather than a second match further down: two places
    // deciding what a mode means is how the alias survived in the first place.
    let plunging = match op.params.entry {
        EntryMode::Plunge => true,
        EntryMode::Ramp => false,
        EntryMode::Helix => {
            res.refusals.push(Refusal {
                what: op.name.clone(),
                why: "helical entry is NOT IMPLEMENTED — it is refused rather than silently \
                      cut as a linear ramp, because a ramp travels along the wall and a helix \
                      does not. Use Ramp (the default) or Plunge"
                    .into(),
            });
            return res;
        }
    };

    // Tool-radius compensation, host-side — grblHAL has no G41/G42.
    //
    // 🔴 THE SIGN IS NOT A FUNCTION OF `CutSide` — it is a function of WINDING,
    // and conflating the two cut 12mm rings around every 6mm hole in the plate
    // job. `Contour::offset` is defined as "positive = MORE material", so:
    //
    //   * outside cut — the tool centre goes outward, into the waste  => +r
    //   * inside cut  — the tool centre goes inward,  into the waste  => +r
    //
    // Both are +r. In both cases the tool centre moves AWAY from the material
    // being kept, and it is the winding (CCW = material, CW = hole) that says
    // which direction that is. Taking the sign from `CutSide` instead applies
    // the hole rule to a contour that may be wound either way, and an outward
    // offset on a hole is a bore of three times the intended diameter that
    // looks perfectly reasonable in the G-code.
    //
    // The winding is normalised here rather than trusted, because a caller
    // building a contour by hand has no reason to know this convention.
    let mut c = op.contour.clone();

    // ---- degenerate input, decided BEFORE any geometry is asked of it ------
    //
    // 🔴 A REPEATED VERTEX IS DROPPED; A CONTOUR THAT IS ONLY REPEATED VERTICES
    // IS REFUSED. Those are different facts and this is where they are told
    // apart.
    //
    // DROPPING is safe, and the argument is physical rather than convenient: a
    // repeated vertex describes a segment of ZERO LENGTH, which removes no
    // material at any tool radius, at any depth, in any direction. Removing it
    // therefore cannot change one coordinate of what the machine cuts — the test
    // `a_closing_duplicate_vertex_does_not_put_a_non_finite_word_in_the_program`
    // plans the same rectangle written both ways and requires an identical
    // program. There is no intent to lose. And it is not an exotic input: a
    // closed `LWPOLYLINE` whose last vertex repeats its first is how many DXF
    // writers close a loop, `hardware/cad`'s own exporter included, so refusing
    // it would refuse our own upstream generator's ordinary output.
    //
    // Left in, it is the worst defect this lane has had. `cavalier_contours`
    // offsets a segment by normalising its direction — `1.0 / length()` — so a
    // zero-length segment yields `0.0 * inf` = NaN, the offset loop comes back
    // with NaN vertices, and the program contains `G1 XNaN YNaN` while the
    // summary reads ok=true.
    //
    // REFUSING is the other half: a contour with fewer than two DISTINCT points
    // is a point, not a path. Falling through would reach the "narrower than the
    // cutter" refusal below, which is a true sentence about the wrong problem —
    // it sends a person to change tools over a broken drawing.
    if c.distinct_vertex_count() < 2 {
        res.refusals.push(Refusal {
            what: op.name.clone(),
            why: format!(
                "this feature is a single point ({} vertices, all at the same place) — it is not \
                 a contour and there is nothing to cut. The drawing entity is degenerate; fix it \
                 upstream rather than choosing a different tool",
                c.verts.len()
            ),
        });
        return res;
    }
    let dropped = c.dedupe_positions();
    if dropped > 0 {
        res.notes.push(format!(
            "{}: {dropped} repeated vertex/vertices dropped — each described a zero-length \
             segment, which removes no material, so the cut is unchanged",
            op.name
        ));
    }

    match op.params.side {
        CutSide::Outside => c.normalise_winding(true),
        CutSide::Inside => c.normalise_winding(false),
        CutSide::OnLine => {}
    }
    let delta = match op.params.side {
        CutSide::OnLine => 0.0,
        _ => r + op.params.finish_allowance_mm,
    };

    // ---- edges that lie on the workpiece edge, decided on the PLACED outline --
    //
    // Determined after the winding has been normalised, so `keep[i]` describes
    // the segment leaving vertex `i` in the same direction the offset is about
    // to be taken. Deciding it before the normalisation would number the edges
    // round one way and cut them round the other.
    let mut keep: Vec<bool> = Vec::new();
    let mut skipped: Vec<SkippedEdge> = Vec::new();
    let rule = edge_rule.filter(|_| op.params.side == CutSide::Outside && c.closed);
    if let Some(rule) = rule {
        let n = c.verts.len();
        keep = vec![true; n];
        for i in 0..n {
            let a = c.verts[i];
            let b = c.verts[(i + 1) % n];
            // An arc is never "on" a straight workpiece edge; a bulge here means
            // the segment curves away from whatever line its ends sit on.
            if a.bulge.abs() > 1e-12 {
                continue;
            }
            let (p0, p1) = ((a.x, a.y), (b.x, b.y));
            let len = (p1.0 - p0.0).hypot(p1.1 - p0.1);
            let Some((edge, inside_mm)) =
                edge_on_workpiece(stock, rule.tolerance_mm, p0, p1)
            else {
                continue;
            };
            keep[i] = false;
            skipped.push(SkippedEdge {
                number: i + 1,
                edge,
                inside_mm,
                length_mm: len,
                from: p0,
                to: p1,
            });
        }
        let total = n;
        let cut = total - skipped.len();

        // 🔴 EVERY edge on the workpiece edge means the part is never separated
        // from the workpiece at all. That is a refusal, not a program with no
        // cuts in it: an operation that emits nothing reads in every report
        // exactly like an operation that had nothing to do.
        if cut == 0 {
            res.refusals.push(Refusal {
                what: op.name.clone(),
                why: format!(
                    "all {total} edges of this outline lie on the workpiece edge within the \
                     declared {:.3}mm tolerance, so with 'use the workpiece edge' on there is \
                     nothing left to cut and the part would never be separated from the \
                     workpiece. Either the outline is the workpiece — in which case no profile \
                     is wanted at all — or the tolerance is larger than the clearance you \
                     actually have",
                    rule.tolerance_mm
                ),
            });
            return res;
        }

        // 🔴 A RAMP ENTRY ON AN OPEN PROFILE IS REFUSED, AND THE MEASUREMENT IS
        // WHY. A ramped pass descends along the contour and then runs a SECOND
        // lap at constant depth to cut away what it passed over while
        // descending. On a loop that works because the ramp lap ends where it
        // began. On an open path it ends at the FAR END, and the finishing lap
        // restarts at the beginning — so the program carries a straight
        // full-depth feed from one end of the part to the other.
        //
        // Measured, on the emitted program for a 200x120 part with two edges
        // skipped, before this refusal existed:
        //
        //     G1 X0.000            <- ramp lap ends here, Z-18.000
        //     G1 X203.000 Y2.000   <- finishing lap restarts, STILL AT Z-18.000
        //
        // That is a 234mm chord through the finished part at cutting feed. It is
        // the same defect the ramp code's own header records ("it never restarts
        // at index 0, which is the defect that cut a full-depth chord across a
        // finished part") arriving through a door that did not exist when that
        // was written.
        //
        // ⚠ **AND IT IS REFUSED RATHER THAN QUIETLY RAMPED LESS**, because there
        // is no correct ramp here to fall back to: with only forward travel and
        // no plunge, a path cannot reach depth AT ITS OWN START — the material
        // there is uncut by construction, so every ramp leaves a wedge at the
        // beginning of the channel. The two real answers are a zig-zag ramp
        // (descend forward over the ramp length, clean it travelling back, then
        // cut forward) or a straight ramp extension into the air BEYOND the
        // workpiece edge — which the skipped edge guarantees is air, but only
        // when the first retained segment leaves the boundary, which has to be
        // checked and is not. **Neither is written.** `EntryMode::Plunge` is
        // correct on an open path today and is measured to be: each entry is one
        // depth step into material the previous pass already opened, at a point
        // where half the cutter hangs off the workpiece.
        if !skipped.is_empty() && op.params.entry == EntryMode::Ramp {
            res.refusals.push(Refusal {
                what: op.name.clone(),
                why: format!(
                    "'use the workpiece edge' leaves {} edge(s) uncut, which makes this profile \
                     an OPEN path with two ends — and a ramp entry on an open path is not \
                     implemented. A ramped pass finishes what it cut on the way down with a \
                     second lap from the start, and on an open path that second lap begins at \
                     the far end from where the first one stopped: the program would carry a \
                     full-depth feed straight across the finished part. Use Plunge entry, which \
                     is correct here (each entry is one depth-per-pass step, at a point where \
                     half the cutter is off the workpiece), or turn 'use the workpiece edge' off \
                     for this operation",
                    skipped.len()
                ),
            });
            return res;
        }

        // 🔴 CORNER RELIEF AND A SKIPPED EDGE ARE REFUSED TOGETHER rather than
        // approximated. A relief is placed at a corner of the FULL outline, and
        // a corner where one of the two edges is not machined is not a corner
        // this program cuts — the bore would relieve a corner that does not
        // exist, at the workpiece boundary, half of it in air. Working out which
        // reliefs survive is a real piece of geometry and it is not written, so
        // this says so instead of guessing.
        if !skipped.is_empty() && !relief_centres(op, r).is_empty() {
            res.refusals.push(Refusal {
                what: op.name.clone(),
                why: format!(
                    "corner relief and 'use the workpiece edge' are not implemented together: \
                     {} edge(s) of this outline are not being cut, and a relief is placed at a \
                     corner of the whole outline — so a relief next to an uncut edge would bore \
                     a corner this program never machines. Turn one of the two off",
                    skipped.len()
                ),
            });
            return res;
        }

        // The summary, on every job carrying the rule — including when nothing
        // was skipped. "The rule ran and found nothing" and "the rule was off"
        // are different facts, and the tolerance that decided it is printed
        // either way, because a tolerance nobody can see is a constant.
        res.notes.push(format!(
            "{}: {cut} of {total} outline edges cut; {} skipped because they lie on the \
             workpiece edge within the declared {:.3}mm tolerance. On a skipped edge the part's \
             dimension is the material supplier's, not the drawing's, and the datum on that side \
             is wherever the workpiece actually is rather than where it was probed",
            op.name,
            skipped.len(),
            rule.tolerance_mm,
        ));
        for s in &skipped {
            res.notes.push(format!("{}: {}", op.name, s.describe(total)));
        }

        // 🔴 A LEAD IS NOT APPLIED TO AN OPEN PROFILE, and it is SAID — the same
        // shape of answer as the inside-cut lead below, for a different reason.
        // A lead exists to put the witness mark in the waste; on a closed loop
        // the start point is somewhere on the wall and the arc has a proven
        // side. An open profile has two real ENDS, both of them on the workpiece
        // boundary, so the lead would have to run OFF the workpiece over
        // whatever is under it — which nothing here has measured — and the
        // geometry that proves a lead arc clears the wall at an end is not the
        // geometry that proves it on a loop. Neither is written, so the lead is
        // skipped rather than approximated.
        if !skipped.is_empty() && op.params.lead_mm > 1e-9 {
            res.notes.push(format!(
                "{}: the {:.1}mm lead was NOT applied — {} edge(s) are not cut, so this profile \
                 is an open path with two ends rather than a loop, and a lead at an end would \
                 run off the workpiece. The entry mark therefore lands at the end of the \
                 finished edge",
                op.name,
                op.params.lead_mm,
                skipped.len()
            ));
        }
    }

    // Traversal direction. 🔴 `Direction` was a config field read by NOTHING —
    // exposed in the UI, stored, and consumed nowhere, which is the same defect
    // class as a Z-datum setting that changes no coordinate.
    //
    // Climb vs conventional is a real difference in edge quality on ply veneer:
    // the cutter either pulls into the work or pushes away from it, and which
    // one a given traversal produces depends on the spindle's rotation. For a
    // right-hand (M3) spindle, travelling so the material is on the tool's RIGHT
    // is climb. Reversing the contour reverses that relationship, so
    // conventional is the reversed traversal of climb.
    // 🔴 REVERSE AFTER OFFSETTING, NEVER BEFORE. The offset direction is a
    // function of winding, so reversing first flips the winding and sends the
    // offset the other way: the conventional-direction path came out INSIDE the
    // part (53..167 against 47..173), i.e. cut undersize by a full tool
    // diameter, and the only visible difference in the G-code is coordinates
    // that look plausible. Offset in the normalised winding, then reverse the
    // RESULT — which changes the order of travel and nothing else.
    //
    // 🔴 WHEN EDGES ARE SKIPPED THE PROFILE BECOMES AN OPEN PATH, and the offset
    // of the retained chain is taken by the SAME offsetter in the SAME
    // direction. `cavalier_contours` offsets an open polyline to the left of
    // travel exactly as it does a closed one, and this module's `offset` flips
    // that sign once, so a chain that inherits the normalised (material on the
    // left) traversal offsets outward on its own. The result lands exactly on
    // the corresponding run of the closed offset — corner arcs included, and
    // with the chain's ends at the PERPENDICULAR offset of the outline's own
    // corners, which is where the tool centre has to reach for the wall to be
    // finished all the way to the workpiece edge.
    //
    // That equality is asserted rather than argued: see
    // `an_open_chains_offset_is_the_closed_offset_with_the_skipped_run_removed`.
    let mut loops = if !skipped.is_empty() {
        let chains = retained_chains(&c, &keep);
        if delta == 0.0 {
            chains
        } else {
            chains.iter().flat_map(|ch| ch.offset(delta)).collect()
        }
    } else if delta == 0.0 {
        vec![c.clone()]
    } else {
        c.offset(delta)
    };
    if op.params.direction == Direction::Conventional {
        for lp in &mut loops {
            lp.reverse();
        }
    }
    let loops = loops;

    if loops.is_empty() {
        // 🔴 Never silent. An offset that eliminates the geometry means the
        // feature cannot be cut with this tool, which is a fact the operator
        // needs BEFORE the workpiece is on the machine.
        //
        // ⚠ Two different facts, said apart. With edges skipped the geometry
        // handed to the offsetter is not the outline any more, so "narrower than
        // the cutter" would be a true sentence about the wrong problem — the
        // kind that sends a person to change tools over something else entirely.
        res.refusals.push(Refusal {
            what: op.name.clone(),
            why: if skipped.is_empty() {
                format!(
                    "the {:.2}mm tool eliminates this feature when offset {:.3}mm — \
                     it is narrower than the cutter and must be drilled or \
                     interpolated, not contoured",
                    op.tool.diameter_mm, delta
                )
            } else {
                format!(
                    "with {} outline edge(s) left uncut on the workpiece edge, the remaining \
                     open path offsets to nothing at {:.3}mm — there is no tool-centre path for \
                     the {:.2}mm cutter to follow along what is left of this outline",
                    skipped.len(),
                    delta,
                    op.tool.diameter_mm
                )
            },
        });
        return res;
    }
    if loops.len() > 1 {
        // Two different causes, and only one of them is a surprise. A pinched
        // shape splitting under the offset is a fact about the DRAWING; several
        // open chains is the direct arithmetic of which edges the operator chose
        // not to cut, and calling that "a pinched shape" would send them looking
        // for a defect in a part that has none.
        res.notes.push(if skipped.is_empty() {
            format!(
                "{}: offset split the contour into {} loops (a pinched shape) — all are cut",
                op.name,
                loops.len()
            )
        } else {
            format!(
                "{}: the {} uncut edge(s) leave {} separate open path(s) — all are cut, each \
                 entered, tabbed and retracted on its own",
                op.name,
                skipped.len(),
                loops.len()
            )
        });
    }

    let feed = if op.params.feed_mm_min > 0.0 {
        op.params.feed_mm_min
    } else {
        feed_from_chipload(&op.tool, op.params.rpm)
    };

    let depth = op.params.depth_total_mm.min(stock.thickness_mm + 0.3);
    if op.params.depth_total_mm > stock.thickness_mm + 0.3 {
        res.notes.push(format!(
            "{}: depth clamped from {:.2} to {:.2}mm — deeper is the spoilboard",
            op.name, op.params.depth_total_mm, depth
        ));
    }

    let mut mv = vec![Move::comment(op_banner(&op.name, &op.tool.name))];

    // 🔴 THE SKIPPED EDGES GO INTO THE PROGRAM, not only into the report.
    // Whoever stands at the machine reads the file; a fact that lives only in a
    // panel they closed an hour ago is a fact that did not reach them. Per edge,
    // with the tolerance that decided it, in machine coordinates — the same
    // frame as every other number in the file.
    if let Some(rule) = rule {
        let total = keep.len();
        mv.push(Move::comment(format!(
            "workpiece edge: {} of {total} outline edges cut, {} skipped within {:.3}mm — a \
             skipped edge takes its dimension and its datum from the workpiece, not the drawing",
            total - skipped.len(),
            skipped.len(),
            rule.tolerance_mm
        )));
        for s in &skipped {
            mv.push(Move::comment(format!("workpiece edge: {}", s.describe(total))));
        }
    }

    for lp in &loops {
        let segs = segments(lp);
        if segs.is_empty() {
            continue;
        }
        let perim = lp.path_length();
        // 🔴 AN OPEN PROFILE STILL NEEDS ITS TABS, AND THE OPPOSITE WAS BELIEVED
        // FIRST. The plausible argument — *"a skipped edge leaves the part
        // joined to the stock there, so it needs no tab"* — is **false, and it
        // is false in the direction that throws a part.** A skipped edge lies on
        // the workpiece's OUTER BOUNDARY: there is no stock on the far side of
        // it to hold anything. Cutting the outline's remaining edges therefore
        // separates the part exactly as a full profile would, and dropping the
        // tabs would leave it separated with nothing holding it at all.
        //
        // Measured rather than reasoned, on the 200x120 part drawn into the
        // corner of a 600x900 workpiece with two edges skipped: with tabs
        // suppressed, `check_hold_down` read the emitted program and reported
        // **two free pieces of 11748mm² and 10143mm², each with its centroid
        // outside the polygon of clamp contacts.** That is the finding the
        // "gain" would have hidden, and it is what
        // `a_skipped_edge_does_not_hold_the_part_and_the_tabs_are_still_needed`
        // in `job.rs` now pins, negative control first.
        //
        // ⚠ SCOPED to the paths this change creates, for the same reason as
        // `lap_end` below: open contours already existed here (`engrave.rs`
        // cuts text on-line) and already took no tabs. That is harmless where it
        // is — a marking stroke is a shallow score, not a through-cut, and
        // `marking_ops` disables tabs explicitly — but widening the condition
        // would make a toggle that is OFF change the emitted program.
        let tabs = if lp.closed || !skipped.is_empty() {
            // 🔴 TABS THAT CANNOT FIT THE PERIMETER (TODO #155, 2026-08-30).
            //
            // `operations_for_part` gives every INTERIOR feature the outer
            // profile's `TabSpec`. On a 6mm hole — about 19mm of circumference —
            // four 8mm tabs cover the whole path, so the hole was cut to the tab
            // height and no further: **every hole in this repo's own fixtures
            // was BLIND by exactly 3mm**, measured on the shipped `multi-tool`
            // job as `hole1..hole4: deepest Z-15.000 against a requested 18`.
            //
            // What to do about it depends on WHAT THE CUT IS, which is why this
            // needed `OpRole` (#146) before it could be fixed at all:
            //
            //   Interior  — the slug is not the part. Dropping the tabs frees the
            //               slug and the hole goes THROUGH, which is what a hole
            //               is for. Safe, and the note says it happened.
            //   Releasing — dropping the tabs would cut the PART free with
            //               nothing holding it. That is #156's hazard and this
            //               must never do it: the outline stays un-severed and
            //               `tabs_never_sever_note` says so on the way out.
            //
            // The threshold is half the perimeter: tabs are discrete bridges
            // with path to cut between them, and a spec whose total width takes
            // half the path is not a tab arrangement.
            let spec = &op.params.tabs;
            let effective = if spec.count > 0 {
                spec.count as f64
            } else {
                ((perim / spec.min_spacing_mm).ceil()).max(2.0)
            };
            let covers_the_path = spec.enabled && effective * spec.width_mm >= perim * 0.5;
            if covers_the_path && op.role == OpRole::Interior {
                Vec::new()
            } else {
                auto_tabs(perim, &op.params.tabs)
            }
        } else {
            Vec::new()
        };
        let start = (lp.verts[0].x, lp.verts[0].y);
        // 🔴 WHERE THE PASS ENDS, WHICH IS NOT WHERE IT STARTED once the path is
        // open. The retract at the bottom of the pass is written at `start`,
        // which on a loop is a pure Z lift — the tool is already there. On an
        // OPEN path it is a **diagonal `G0 X Y Z` from cutting depth back across
        // the work**: the post writes all three axes in one block and the
        // controller moves them together, so the cutter is dragged sideways at
        // rapid feed for as long as it takes the Z term to clear the surface.
        //
        // ✅ **UNCONDITIONAL SINCE 2026-08-11, which is what the note below used
        // to promise.** It read *"scoped to the paths this change creates"* and
        // named the rest as a pre-existing defect in engraving, deliberately
        // left because correcting it would make a toggle that is OFF change the
        // emitted program — which was the right call for the change that wrote
        // it and the wrong state to leave standing.
        //
        // The defect it named, measured on `job plate` at `4e9bb8c758`:
        //
        // ```text
        // ( op: plate-mark1 [End Mill - Down-cut 3.175mm 2F] )
        // G0 X141.000 Y68.000 Z5.000
        // G1 Z-0.400 F300.0
        // G1 Y70.000 F1800.0
        // G1 Y76.000            <- the stroke ENDS here, 0.400mm under the surface
        // G0 Y68.000 Z5.000     <- and rapids 8mm back to the START while lifting
        // ```
        //
        // The post writes all three words in one block and the controller
        // interpolates them together, so the cutter is dragged sideways at rapid
        // feed for as long as the Z term takes to clear — on a 5.400mm total lift
        // that is the first ~0.6mm of the 8mm move, on **all sixteen** marking
        // strokes. A retract that is a pure Z lift on a loop is a diagonal cut on
        // an open path, and `engrave.rs` only ever produces open paths.
        //
        // 🔴 This DOES change emitted output with the workpiece-edge toggle off,
        // which is why it is its own change with its own byte-diff rather than a
        // tidy-up folded into someone else's. `lp.closed` is the only condition
        // that survives, because on a closed loop the last vertex IS `start` and
        // the retract is the pure Z lift it always was.
        let lap_end = if lp.closed {
            start
        } else {
            let v = lp.verts[lp.verts.len() - 1];
            (v.x, v.y)
        };

        for z in depth_passes(depth, op.params.depth_per_pass_mm) {
            // 🔴 THE RETRACT HEIGHT IS `machine.safe_z_mm` AND NOTHING ELSE —
            // it does NOT account for the declared clamps, and a reader who
            // assumes it does is making the mistake this comment exists to
            // stop. `Fixturing::clearance_z` computes the height that WOULD
            // clear the tallest clamp; it is a refusal threshold read inside
            // `Fixturing::check` and it has no consumer here, so a 42mm toggle
            // clamp on an 18mm workpiece is crossed at 5mm by default.
            //
            // That is deliberate rather than unfinished. This planner is handed
            // `&Machine` and `&Stock` and is told nothing about the bed, and
            // the work-holding module's own first rule is that the CAM never
            // chooses a hold-down. The job is REFUSED with `RapidBelowClamp`
            // instead — since 2026-08-10 that check walks the whole rapid
            // rather than its endpoint, so a link move that crosses a clamp is
            // now actually seen. If a lift is ever wanted, it has to land HERE,
            // at the other four `safe_z_mm` sites in this file, AND at the
            // post's own `G0 Z` retracts — otherwise the plan and the emitted
            // program disagree about how high the machine flies.
            mv.push(Move::rapid(Vec3::new(start.0, start.1, machine.safe_z_mm)));

            // Entry depth. A vertical plunge is only acceptable when explicitly
            // asked for; ramping is the default because plunging in ply burns
            // both the bit and the work — the end of a router flute is not a
            // drill point, so the whole axial load lands on the corner of the
            // flute and either snaps it or lifts the workpiece off the spoilboard.
            //
            // 🔴 WHEN RAMPING, THE ENTRY STOPS AT THE WORKPIECE TOP (Z0). Descending
            // into the material is the ramp's job and it is done WITH XY motion.
            // The MOVE that carries the tool below Z0 is what a controller
            // executes; a plan that says "ramp" and a program whose first cut is
            // a full-depth vertical descent are not the same fact, and only the
            // second one reaches the spindle.
            //
            // Ramping proper happens in `emit_lap` below: it descends along the
            // contour over `ramp_len` and then CONTINUES from where the ramp
            // ended — it never restarts at index 0, which is the defect that cut
            // a full-depth chord across a finished part.
            let entry_z = if plunging { z } else { 0.0 };
            let ramping = !plunging;
            // 🔴 The ramp must fit the contour. A 20mm ramp on a 12mm ring
            // never reaches depth, and the pass leaves material everywhere the
            // ramp was still descending — 1,827 uncut cells in the middle of a
            // pocket whose G-code looked complete. Half the perimeter is the
            // most that can be spent descending and still leave a lap to cut.
            let ramp_len = op.params.ramp_length_mm.max(1e-6).min(perim * 0.5);

            // Per-segment arc length, computed once and shared by both laps.
            let mut seg_len = Vec::with_capacity(segs.len());
            {
                let mut c = start;
                for s in &segs {
                    let l = match s.arc {
                        None => ((s.to_x - c.0).powi(2) + (s.to_y - c.1).powi(2)).sqrt(),
                        Some((cx, cy, _)) => {
                            let r0 = ((c.0 - cx).powi(2) + (c.1 - cy).powi(2)).sqrt();
                            let a0 = (c.1 - cy).atan2(c.0 - cx);
                            let a1 = (s.to_y - cy).atan2(s.to_x - cx);
                            let mut d = (a1 - a0).abs();
                            if d > std::f64::consts::PI {
                                d = std::f64::consts::TAU - d;
                            }
                            r0 * d
                        }
                    };
                    seg_len.push(l);
                    c = (s.to_x, s.to_y);
                }
            }

            // 🔴 THE TAB RULE LIVES IN ONE PLACE AND BOTH LAPS USE IT.
            //
            // The ramp lap and the finishing lap traverse the same contour. When
            // only the ramp lap knew about tabs, the finishing lap re-cut the
            // whole contour at full depth and machined every tab away — the
            // program still LOOKED tabbed (the ramp lap's lifts were in it) and
            // the part came out completely free. Measured 0 tabs against an
            // expected 5 on the plate job, with tabs nominally enabled.
            //
            // Tab Z is measured from the bottom of the cut: `z + height`, capped
            // at 0 so a tab taller than the remaining workpiece does not become a
            // move above the surface.
            // A tab is SHORTER than a segment, so a segment must be SPLIT at the
            // tab boundaries — not merely flagged as touching one.
            //
            // 🔴 Flagging was the first attempt and it failed in the most
            // expensive direction: a 200mm edge overlaps several 8mm tab
            // windows, so every segment tested "in a tab" and the entire
            // contour rose to tab height. The part is then never cut out at
            // all, and the program looks tabbed because the Z values differ.
            // The deepest cut measured -15mm on an 18mm through-profile.
            let in_tab = |d: f64| {
                tabs.iter().any(|t| {
                    d > t.distance_mm - t.width_mm * 0.5 && d < t.distance_mm + t.width_mm * 0.5
                })
            };
            let tab_height = op.params.tabs.height_mm;

            // Point at a fraction along a segment. A line lerps; an arc rotates
            // about its centre, because lerping an arc's endpoints cuts the
            // chord and leaves the material the arc was there to remove.
            let point_at = |s: &Seg, from: (f64, f64), f: f64| -> (f64, f64) {
                match s.arc {
                    None => (from.0 + (s.to_x - from.0) * f, from.1 + (s.to_y - from.1) * f),
                    Some((cx, cy, cw)) => {
                        let r = ((from.0 - cx).powi(2) + (from.1 - cy).powi(2)).sqrt();
                        let a0 = (from.1 - cy).atan2(from.0 - cx);
                        let a1 = (s.to_y - cy).atan2(s.to_x - cx);
                        let mut sweep = a1 - a0;
                        if cw {
                            while sweep > 0.0 {
                                sweep -= std::f64::consts::TAU;
                            }
                        } else {
                            while sweep < 0.0 {
                                sweep += std::f64::consts::TAU;
                            }
                        }
                        let a = a0 + sweep * f;
                        (cx + r * a.cos(), cy + r * a.sin())
                    }
                }
            };

            let emit_lap = |ramp: bool, mv: &mut Vec<Move>| {
                let mut travelled = 0.0;
                let mut from = start;
                for (i, s) in segs.iter().enumerate() {
                    let l = seg_len[i];
                    if l < 1e-9 {
                        continue;
                    }
                    // Sample the segment finely enough to resolve a tab edge,
                    // and merge adjacent samples that share a Z so a straight
                    // run does not become a thousand blocks (gate G10).
                    let n = ((l / (op.params.tabs.width_mm.max(1.0) * 0.25)).ceil() as usize)
                        .clamp(1, 512);
                    let mut prev_z: Option<f64> = None;
                    for k in 1..=n {
                        let f = k as f64 / n as f64;
                        let d = travelled + l * f;
                        let z_ramp = if ramp && d < ramp_len { z * d / ramp_len } else { z };
                        let z_use =
                            if in_tab(d) { (z + tab_height).min(0.0) } else { z_ramp };
                        let is_last = k == n;
                        // Emit only where Z changes or at the segment end —
                        // this is what keeps a plain edge one move.
                        if prev_z.map(|p| (p - z_use).abs() > 1e-9).unwrap_or(true) || is_last {
                            let (px, py) = point_at(s, from, f);
                            match s.arc {
                                None => mv.push(Move::feed_to(Vec3::new(px, py, z_use), feed)),
                                Some((cx, cy, cw)) => mv.push(Move::arc(
                                    cw,
                                    Vec3::new(px, py, z_use),
                                    Vec2::new(cx, cy),
                                    feed,
                                )),
                            }
                            prev_z = Some(z_use);
                        }
                    }
                    travelled += l;
                    from = (s.to_x, s.to_y);
                }
            };

            // ---- tangential lead-in --------------------------------------
            //
            // Arriving at the wall ALONG the wall leaves a witness mark where
            // the tool changed from approaching to cutting: the cutter deflects
            // slightly under first contact and the recovery shows as a dwell
            // dimple. A tangential arc puts full engagement on before the tool
            // reaches the finished edge, so the mark lands in the waste.
            //
            // The lead is placed on the WASTE side. For the normalised winding
            // (material is left of travel) the waste is to the RIGHT, so the
            // arc centre steps off in that direction. Putting it on the wrong
            // side would drive the lead through the part.
            // 🔴 LEADS ARE FOR OUTSIDE AND ON-LINE CUTS ONLY.
            //
            // On an INSIDE cut the tool centre already runs exactly one radius
            // from the wall, so a lead arc of that radius pushes the centre ONTO
            // the wall — and if the start point is at a corner, the approach
            // point lands in the material with nowhere to go. Measured: a 4mm
            // lead on a 40mm socket put the tool centre at x=99 against a wall
            // at x=100, i.e. 3mm of cutter through the finished face, and 35
            // gouged cells in the simulation.
            //
            // Doing it properly means choosing a start point away from the
            // corners and proving the arc clears every wall. Until that exists,
            // the lead is SKIPPED and SAID, because a lead-in that silently
            // cuts the part is worse than no lead-in.
            let lead_r = if op.params.side == CutSide::Inside { 0.0 } else { op.params.lead_mm };
            if op.params.lead_mm > 1e-9 && op.params.side == CutSide::Inside {
                res.notes.push(format!(
                    "{}: the {:.1}mm lead was NOT applied — an inside cut has only the tool \
                     radius of clearance, so the lead would cut into the wall",
                    op.name, op.params.lead_mm
                ));
            }
            let lead = if lead_r > 1e-9 && lp.closed && segs.len() > 1 {
                let p0 = start;
                let p1 = (segs[0].to_x, segs[0].to_y);
                let (dx, dy) = (p1.0 - p0.0, p1.1 - p0.1);
                let l = (dx * dx + dy * dy).sqrt();
                if l < 1e-9 {
                    None
                } else {
                    let t = (dx / l, dy / l);
                    // 🔴 WHICH SIDE IS THE WASTE DEPENDS ON THE LOOP, not on a
                    // fixed hand. For an OUTER profile (CCW tool-centre loop)
                    // the waste is to the right of travel. For a HOLE or socket
                    // (CW loop) the waste is the enclosed region, which is to
                    // the LEFT. Using "right" for both put the lead arc of a
                    // relieved socket 1.6mm INTO the plate — 35 gouged cells,
                    // found by watching the simulation panel while changing the
                    // lead in the UI, not by a test.
                    // RIGHT of travel, for both cut sides. Measured rather
                    // than reasoned: for a CCW outer loop the material is on the
                    // left, so the waste is right; for a CW hole loop the
                    // enclosed region IS the hole, which is also on the right.
                    // One hand serves both. (A "fix" that flipped the sign for
                    // holes was tried first and drove the lead straight into the
                    // plate — the winding argument for it was simply wrong, and
                    // dumping the actual offset loop settled it in one run.)
                    let n = (t.1, -t.0);
                    let c = (p0.0 + n.0 * lead_r, p0.1 + n.1 * lead_r);
                    let a = (c.0 - t.0 * lead_r, c.1 - t.1 * lead_r);
                    // Sense of the quarter arc from `a` to `p0` about `c`.
                    let cross = (a.0 - c.0) * (p0.1 - c.1) - (a.1 - c.1) * (p0.0 - c.0);
                    Some((a, c, cross < 0.0))
                }
            } else {
                None
            };

            // 🔴 THE ENTRY DESCENT IS EMITTED HERE, ONCE, AND AT WHICHEVER POINT
            // THE TOOL ACTUALLY ENTERS. Previously it was emitted at `start`
            // before the lead was known, so a job with a lead descended TWICE:
            // once at `start` — a stab straight into the finished edge, which
            // the program then rapided away from without cutting — and again at
            // the lead point. With a ramp entry the first of those two reached
            // Z0 and the second reached FULL PASS DEPTH vertically, so the
            // default entry mode still put a full-depth plunge in the program
            // and the ramp that followed cut air on the way back up.
            match lead {
                None => {
                    mv.push(Move::feed_to(
                        Vec3::new(start.0, start.1, entry_z),
                        op.params.plunge_mm_min,
                    ));
                }
                Some((a, c, cw)) => {
                    mv.push(Move::rapid(Vec3::new(a.0, a.1, machine.safe_z_mm)));
                    mv.push(Move::feed_to(Vec3::new(a.0, a.1, entry_z), op.params.plunge_mm_min));
                    mv.push(Move::arc(
                        cw,
                        Vec3::new(start.0, start.1, entry_z),
                        Vec2::new(c.0, c.1),
                        feed,
                    ));
                }
            }

            emit_lap(ramping, &mut mv);

            // A ramped pass has not cut the whole contour at depth — everything
            // the tool passed over while descending was cut shallow. The
            // finishing lap completes it, with the same tabs.
            if ramping {
                emit_lap(false, &mut mv);
            }

            // ---- tangential lead-out -------------------------------------
            // Leaving along the wall marks the finished edge just as arriving
            // along it does, so the exit is an arc away into the waste too.
            if let Some((a, c, cw)) = lead {
                mv.push(Move::arc(!cw, Vec3::new(a.0, a.1, z), Vec2::new(c.0, c.1), feed));
            }

            mv.push(Move::rapid(Vec3::new(lap_end.0, lap_end.1, machine.safe_z_mm)));
        }
    }

    // ---- corner relief -----------------------------------------------------
    //
    // 🔴 Reliefs used to be COMPUTED AND REPORTED BUT NEVER CUT. The summary
    // said "4 corner reliefs" and the G-code contained none, so a socket came
    // off the machine with round corners and a square tenon would not seat. A
    // count that describes the plan rather than the program is not a check, it
    // is a caption.
    //
    // The relief bore has the radius of the tool, so it IS a plunge at the
    // relief centre — no contour to follow. It is cut at final depth after the
    // wall, when the corner it relieves already exists.
    if op.params.dogbone != DogboneStyle::None {
        // 🔴 `relief_centres`, not a second `dogbone_centres` call — the refusal
        // that will not combine a relief with an uncut edge asks the same
        // function, so the set it guards is the set that gets emitted.
        let centres = relief_centres(op, r);
        if !centres.is_empty() {
            mv.push(Move::comment(format!("{} corner relief(s)", centres.len())));
            for (cx, cy) in centres {
                mv.push(Move::rapid(Vec3::new(cx, cy, machine.safe_z_mm)));
                let mut d = Move::drill(
                    Vec3::new(cx, cy, -depth),
                    op.params.peck_depth_mm,
                    op.params.plunge_mm_min,
                );
                // Tagged so the reported relief count can be derived from the
                // EMITTED PATH rather than from the plan. A count taken from the
                // plan is a caption: it said 4 while the program contained none.
                d.text = "relief".into();
                mv.push(d);
            }
        }
    }

    let mut path = Toolpath { moves: mv, tool: op.tool.clone(), ..Default::default() };
    path.recompute_bounds();
    // The plan is not the program: read the MOVES back before handing them on.
    if let Some(r) = nonfinite_refusal(&op.name, &path) {
        res.refusals.push(r);
        res.path = Toolpath::default();
        return res;
    }
    if let Some(n) = tabs_never_sever_note(op, &path) {
        res.notes.push(n);
    }
    // Said on the OPERATION, not on the emitted moves, and deliberately: the
    // feature that is missing left no moves to read. See the header.
    if let Some(n) = unreachable_feature_note(op, op.tool.radius_mm()) {
        res.notes.push(n);
    }
    res.path = path;
    res
}

/// Plan a drilled hole: one plunge at the centre, pecked.
///
/// 🔴 A bore the size of the cutter has NO contour to follow — the tool-centre
/// path is a point. Contouring it produces either nothing or, if the offset
/// sign is wrong, a ring of three times the diameter. Drilling is not an
/// optimisation here, it is the only correct answer.
pub fn plan_drill(op: &Operation, machine: &Machine, stock: &Stock) -> PlanResult {
    let mut res = PlanResult::default();
    // Before anything reads a parameter. See `nonfinite_params_refusal` and
    // `nonfinite_setup_refusal`.
    if let Some(refusal) = nonfinite_setup_refusal(machine, stock).or_else(|| nonfinite_params_refusal(op)) {
        res.refusals.push(refusal);
        return res;
    }
    let Some((cx, cy, hole_r)) = op.contour.as_circle() else {
        res.refusals.push(Refusal {
            what: op.name.clone(),
            why: "a drilled feature must be a circle".into(),
        });
        return res;
    };

    let tool_r = op.tool.radius_mm();
    if tool_r > hole_r + 1e-6 {
        res.refusals.push(Refusal {
            what: op.name.clone(),
            why: format!(
                "a {:.2}mm cutter cannot make a {:.2}mm hole — the hole would be the \
                 diameter of the tool, not the drawing",
                op.tool.diameter_mm,
                hole_r * 2.0
            ),
        });
        return res;
    }
    if hole_r - tool_r > 0.05 {
        // The hole is bigger than the tool: it must be interpolated (a helical
        // or circular contour), not plunged. Saying so is the point — plunging
        // here would leave a hole of the TOOL's diameter and look successful.
        res.refusals.push(Refusal {
            what: op.name.clone(),
            why: format!(
                "a {:.2}mm hole is larger than the {:.2}mm tool — it must be interpolated, \
                 and plunging would produce a {:.2}mm hole",
                hole_r * 2.0,
                op.tool.diameter_mm,
                op.tool.diameter_mm
            ),
        });
        return res;
    }

    let feed = if op.params.feed_mm_min > 0.0 {
        op.params.feed_mm_min
    } else {
        op.params.plunge_mm_min
    };
    let depth = op.params.depth_total_mm.min(stock.thickness_mm + 0.3);

    let mut mv = vec![Move::comment(drill_banner(&op.name, &op.tool.name))];
    mv.push(Move::rapid(Vec3::new(cx, cy, machine.safe_z_mm)));
    mv.push(Move::drill(Vec3::new(cx, cy, -depth), op.params.peck_depth_mm, feed));

    let mut path = Toolpath { moves: mv, tool: op.tool.clone(), ..Default::default() };
    path.recompute_bounds();
    if let Some(r) = nonfinite_refusal(&op.name, &path) {
        res.refusals.push(r);
        res.path = Toolpath::default();
        return res;
    }
    res.path = path;
    res
}

/// Route an operation to the right planner. The op type is decided by whoever
/// built the operation; this only dispatches.
pub fn plan_operation(op: &Operation, machine: &Machine, stock: &Stock) -> PlanResult {
    plan_operation_with_edge_rule(op, machine, stock, None)
}

/// [`plan_operation`], carrying the workpiece-edge rule to the one planner that
/// can act on it.
///
/// A drill has no outline and no edges, so the rule cannot reach
/// [`plan_drill`] — not by a check inside it, but because there is no path from
/// here to there that carries one.
pub fn plan_operation_with_edge_rule(
    op: &Operation,
    machine: &Machine,
    stock: &Stock,
    edge_rule: Option<&WorkpieceEdgeRule>,
) -> PlanResult {
    match op.params.op_type {
        OpType::Drill => plan_drill(op, machine, stock),
        _ => plan_profile_with_edge_rule(op, machine, stock, edge_rule),
    }
}

/// Order operations for a part: **every interior feature before the outer
/// profile**, because once the outline is cut the part is loose and any
/// subsequent cut moves it under the bit.
///
/// Within the interior features, deepest last so shallow work happens while the
/// workpiece is at its most rigid.
///
/// # 🔴 `total_cmp`, not `partial_cmp().unwrap()` — and why the fix is here
/// rather than a check in this function (2026-08-28)
///
/// This sorted on `partial_cmp(...).unwrap()`, which **panics** on a NaN
/// `depth_total_mm`. Nothing upstream validates `OperationParams` for
/// finiteness, so a NaN depth crashed the process here — and `order_operations`
/// runs *before* any planner, so it crashed **ahead of the refusal that already
/// exists for exactly this**: [`nonfinite_refusal`] catches a non-finite
/// coordinate in the emitted moves, names the move, and emits zero bytes.
///
/// A panic and a refusal are not the same outcome and only one of them is this
/// lane's contract. A panic gives the operator a stack trace with no statement
/// about the program, and in the browser host it poisons the wasm instance —
/// whereas the refusal says which operation, which move and which coordinate,
/// and produces no G-code at all.
///
/// So this uses [`f64::total_cmp`], a total order that cannot panic (NaN sorts
/// last), and the operation is then carried into the planner **so the existing
/// refusal can fire on the emitted program**. ⚠ That ordering is arbitrary for a
/// NaN and deliberately so: this function must not become the place that judges
/// a depth. Assert on the emitted program, never on the setting that was
/// supposed to produce it — the standing rule this lane has been bitten by five
/// times now.
pub fn order_operations(mut ops: Vec<Operation>, outer_name: &str) -> Vec<Operation> {
    ops.sort_by(|a, b| {
        let a_outer = a.name == outer_name;
        let b_outer = b.name == outer_name;
        a_outer
            .cmp(&b_outer)
            .then(a.params.depth_total_mm.total_cmp(&b.params.depth_total_mm))
    });
    ops
}

/// Group operations by tool so a job with N tools needs exactly N-1 changes.
///
/// Order within a tool group is preserved, so `order_operations` still governs
/// inner-before-outer inside each group.
///
/// # 🔴 The GROUP order is first appearance, and first appearance is an accident
///
/// The first operation carrying a tool starts that tool's group, so **which
/// group runs first is decided by how the caller built the vector** — not by
/// anything here and not by anything this function can see. That was the defect
/// behind TODO #33: the same operations, the same two tools and the same single
/// tool change produced a safe program or a part cut loose before its holes,
/// depending only on input order.
///
/// This function is NOT where that is fixed, and the old comment here — *"a
/// tool change between two features of the same part means the part must not
/// have been released yet — which is why the outer profile is last in the
/// ordering and last again here"* — asserted a guarantee it does not make. It
/// is true *within* a group and says nothing across one.
///
/// [`crate::optimise::optimise_route`] is what makes the group order safe: it
/// topologically sorts the tool groups on "interior work before the tool that
/// releases the part" and hands back a vector already in that order, so first
/// appearance here **preserves** a chosen order rather than inventing one. A
/// caller that groups without routing first gets no such guarantee — and gets
/// no refusal either, because the check that would refuse lives in
/// `optimise_route`.
/// Group operations by tool, preserving inner-before-outer ordering.
///
/// 🔴 Decision #33: never regroup across the inner-before-outer boundary.
/// The input is already sorted with inner features before their outer profile
/// (by `order_operations`). When a tool group would contain both inner and
/// outer operations for the same part, the group is SPLIT so the inner
/// operations complete before the outer profile begins. This costs more tool
/// changes but keeps every part held down until its last feature is cut.
///
/// The split is per-part: if part A's inner and part B's outer share a tool,
/// they stay in the same group (no precedence between different parts).
pub fn group_by_tool(ops: Vec<Operation>) -> Vec<(Tool, Vec<Operation>)> {
    // First pass: group by tool in first-appearance order (the original behavior).
    let mut raw_groups: Vec<(Tool, Vec<Operation>)> = Vec::new();
    for op in ops {
        if let Some(g) = raw_groups.iter_mut().find(|(t, _)| t.name == op.tool.name) {
            g.1.push(op);
        } else {
            raw_groups.push((op.tool.clone(), vec![op]));
        }
    }

    // Second pass: split groups that would reorder inner-before-outer for the
    // same part. A group containing both "partX-hole1" and "partX" (the outer
    // profile) must be split so all holes come before the profile.
    let mut result: Vec<(Tool, Vec<Operation>)> = Vec::new();
    for (tool, ops) in raw_groups {
        // 🔴 READ OFF THE OPERATION, NOT OFF ITS NAME (TODO #146). Every line
        // below used to be a substring match — `-hole` / `-inner` for the role,
        // `rsplit_once("-hole")` for the owning part — against names built from
        // the drawing's FILENAME. See `OpRole` for the measured failure.
        //
        // The parts in THIS group that have both an interior operation and the
        // cut that releases them. Only those force a split.
        let releasing: std::collections::HashSet<&str> = ops
            .iter()
            .filter(|op| op.role == OpRole::Releasing)
            .map(|op| op.part.as_str())
            .collect();
        let split_parts: std::collections::HashSet<String> = ops
            .iter()
            .filter(|op| op.role == OpRole::Interior && releasing.contains(op.part.as_str()))
            .map(|op| op.part.clone())
            .collect();

        if split_parts.is_empty() {
            // No interior-before-releasing conflict in this group.
            result.push((tool, ops));
        } else {
            // Split: the interior work of those parts first, everything else after.
            let mut interior: Vec<Operation> = Vec::new();
            let mut rest: Vec<Operation> = Vec::new();
            for op in ops.into_iter() {
                if op.role == OpRole::Interior && split_parts.contains(&op.part) {
                    interior.push(op);
                } else {
                    rest.push(op);
                }
            }
            if !interior.is_empty() {
                result.push((tool.clone(), interior));
            }
            if !rest.is_empty() {
                result.push((tool, rest));
            }
        }
    }
    result
}

/// Build the parts of a plate: outer profile plus one operation per hole.
pub fn operations_for_part(
    part: &Part,
    tool: &Tool,
    params: &OperationParams,
) -> Vec<Operation> {
    let mut ops = Vec::new();
    for (i, h) in part.inners.iter().enumerate() {
        // A round hole no larger than the cutter is DRILLED. Anything else is
        // contoured. Choosing this per feature, rather than making the caller
        // declare it, is what stops a 6mm hole being sent to a contour planner
        // that has no path to follow.
        let drillable = h
            .as_circle()
            .map(|(_, _, r)| (r - tool.radius_mm()).abs() <= 0.05)
            .unwrap_or(false);
        ops.push(Operation {
            name: format!("{}-hole{}", part.name, i + 1),
            // Stated here, where it is KNOWN, rather than left for a downstream
            // reader to recover from the name it is about to be given.
            part: part.name.clone(),
            role: OpRole::Interior,
            contour: h.clone(),
            tool: tool.clone(),
            params: OperationParams {
                side: CutSide::Inside,
                op_type: if drillable { OpType::Drill } else { OpType::Profile },
                ..params.clone()
            },
        });
    }
    ops.push(Operation {
        name: part.name.clone(),
        part: part.name.clone(),
        role: OpRole::Releasing,
        contour: part.outer.clone(),
        tool: tool.clone(),
        params: OperationParams { side: CutSide::Outside, ..params.clone() },
    });
    order_operations(ops, &part.name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geometry::{Contour, Vertex};

    fn tool6() -> Tool {
        Tool { name: "6mm 2F".into(), diameter_mm: 6.0, flutes: 2, chipload_mm: 0.1, ..Tool::default() }
    }

    fn op(name: &str, c: Contour, side: CutSide) -> Operation {
        let (part, role) = test_part_and_role(name);
        Operation {
            name: name.into(),
            part,
            role,
            contour: c,
            tool: tool6(),
            params: OperationParams { side, depth_total_mm: 18.0, ..OperationParams::default() },
        }
    }

    #[test]
    fn a_nonfinite_machine_or_workpiece_is_refused_by_field_name_before_anything_is_planned() {
        // 🔴 MEASURED BEFORE THE FIX, one 40x40 outside profile, everything else
        // default:
        //
        //   stock.thickness_mm = NaN  ->  289 moves, cut to Z-18.000, ZERO refusals
        //   stock.size_x_mm    = NaN  ->  289 moves,                  ZERO refusals
        //   machine.safe_z_mm  = NaN  ->    0 moves, refused (it reaches a move)
        //
        // `thickness_mm` is the SPOILBOARD CLAMP — `depth.min(thickness + 0.3)`,
        // and `f64::min` returns the non-NaN operand, so a NaN REMOVES the clamp
        // rather than tightening it. The "depth clamped, deeper is the
        // spoilboard" note stayed silent too, because `NaN > x` is false.
        // `size_x_mm` is what every off-material comparison is made against, and
        // a comparison with NaN is always false — the check does not fail, it
        // stops being able to fire.
        let mut sq = Contour::default();
        for (x, y) in [(0.0, 0.0), (40.0, 0.0), (40.0, 40.0), (0.0, 40.0)] {
            sq.verts.push(Vertex::line(x, y));
        }
        sq.closed = true;
        let profile = op("p", sq.clone(), CutSide::Outside);
        let mut drill = op("h", Contour::circle(20.0, 20.0, 3.0), CutSide::Inside);
        drill.params.op_type = OpType::Drill;

        let cases: [(&str, Machine, Stock); 4] = [
            ("stock.thickness_mm", Machine::default(), Stock { thickness_mm: f64::NAN, ..Stock::default() }),
            ("stock.size_x_mm", Machine::default(), Stock { size_x_mm: f64::INFINITY, ..Stock::default() }),
            ("machine.safe_z_mm", Machine { safe_z_mm: f64::NAN, ..Machine::default() }, Stock::default()),
            ("machine.spindle_max_rpm", Machine { spindle_max_rpm: f64::NAN, ..Machine::default() }, Stock::default()),
        ];

        for (field, machine, stock) in cases {
            // BOTH planner doors — a drill takes the same setup through a
            // different function, and one door guarded is not the door guarded.
            for (door, o) in [("profile", &profile), ("drill", &drill)] {
                let res = plan_operation(o, &machine, &stock);
                assert!(
                    !res.refusals.is_empty(),
                    "{door} door: {field} was not finite and {} move(s) were planned anyway",
                    res.path.moves.len()
                );
                assert!(
                    res.refusals[0].why.contains(field),
                    "{door} door: the refusal must NAME {field} — there is no move to name, which \
                     is the whole defect: {:?}",
                    res.refusals[0].why
                );
                assert!(
                    res.path.moves.is_empty(),
                    "{door} door: a refusal must leave no moves behind, got {}",
                    res.path.moves.len()
                );
            }
        }

        // Specificity: an ordinary setup must NOT be refused. A door that
        // refuses everything agrees with nothing.
        let ok = plan_operation(&profile, &Machine::default(), &Stock::default());
        assert!(
            ok.refusals.is_empty() && !ok.path.moves.is_empty(),
            "a finite setup was refused: {:?}",
            ok.refusals
        );
    }

    // -----------------------------------------------------------------------
    //  Inner-before-outer survives a hostile FILENAME (TODO #146)
    // -----------------------------------------------------------------------

    #[test]
    fn the_release_split_is_decided_by_role_and_not_by_what_the_drawing_is_called() {
        // 🔴 THE CASE NO FIXTURE COULD REACH. `group_by_tool` used to classify
        // by substring: `-hole`/`-inner` meant interior, anything else meant the
        // outer profile. Operation names are built from `part.name`, which comes
        // from the DRAWING'S FILENAME — so `sensor-hole-jig.dxf` produced an
        // outer profile called `sensor-hole-jig`, which contains `-hole`, was
        // read as interior, and decision #33's split silently did not happen.
        //
        // Measured before the fix, same tool and geometry:
        //   part "plate"           -> [("A", ["plate-hole1"]), ("A", ["plate"])]   SPLIT
        //   part "sensor-hole-jig" -> [("A", ["sensor-hole-jig-hole1",
        //                                     "sensor-hole-jig"])]                 NOT SPLIT
        //
        // Gate REL guards this failure and drives fixture parts whose names
        // contain neither needle — a control tested only where right and wrong
        // agree. This is the disagreeing case, and it is a UNIT test because the
        // fixtures cannot be renamed without moving every gate that hashes them.
        let mut sq = Contour::default();
        for (x, y) in [(0.0, 0.0), (40.0, 0.0), (40.0, 40.0), (0.0, 40.0)] {
            sq.verts.push(Vertex::line(x, y));
        }
        sq.closed = true;

        let one_tool = Tool { name: "A".into(), ..tool6() };
        let mk = |name: &str, part: &str, role: OpRole| Operation {
            name: name.into(),
            part: part.into(),
            role,
            contour: sq.clone(),
            tool: one_tool.clone(),
            params: OperationParams { depth_total_mm: 18.0, ..OperationParams::default() },
        };

        // Every name here contains BOTH needles the old heuristic looked for,
        // in the part name itself — the worst case, not a marginal one.
        for part in ["sensor-hole-jig", "inner-frame", "left-hole-plate"] {
            let groups = group_by_tool(vec![
                mk(&format!("{part}-hole1"), part, OpRole::Interior),
                mk(part, part, OpRole::Releasing),
            ]);
            assert_eq!(
                groups.len(),
                2,
                "part {part:?}: interior work and the releasing cut share a tool and were NOT \
                 split into two groups — decision #33's guarantee is void for this part. Groups: \
                 {:?}",
                groups.iter().map(|(_, o)| o.iter().map(|x| x.name.as_str()).collect::<Vec<_>>()).collect::<Vec<_>>()
            );
            assert!(
                groups[0].1.iter().all(|o| o.role == OpRole::Interior),
                "part {part:?}: the FIRST group must be the interior work — a releasing cut in it \
                 means the part is loose while the rest of the group runs"
            );
            assert!(
                groups[1].1.iter().any(|o| o.role == OpRole::Releasing),
                "part {part:?}: the releasing cut is not in the second group"
            );
        }

        // Specificity: a benign name must behave exactly as it always did, and a
        // part with no releasing cut in the group must NOT be split — a splitter
        // that splits everything buys tool changes and proves nothing.
        let benign = group_by_tool(vec![
            mk("plate-hole1", "plate", OpRole::Interior),
            mk("plate", "plate", OpRole::Releasing),
        ]);
        assert_eq!(benign.len(), 2, "the benign case regressed");

        let no_release = group_by_tool(vec![
            mk("plate-hole1", "plate", OpRole::Interior),
            mk("plate-hole2", "plate", OpRole::Interior),
        ]);
        assert_eq!(
            no_release.len(),
            1,
            "interior work alone must stay in ONE group — nothing releases the part, so there is \
             no boundary to enforce and the extra tool change is pure cost"
        );
    }

    fn poly(pts: &[(f64, f64)]) -> Contour {
        let mut c = Contour::default();
        for (x, y) in pts {
            c.verts.push(Vertex::line(*x, *y));
        }
        c.closed = true;
        c
    }

    #[test]
    fn the_offset_goes_the_same_way_whichever_way_the_outline_is_wound() {
        // ⚠ CLEAN PROBE, KEPT AS A TEST. Winding is the classic offset hazard:
        // if a clockwise outline is assumed counter-clockwise, `Outside` offsets
        // INWARD and every part comes out undersize by twice the tool radius —
        // a perfectly smooth, perfectly wrong part. Probed 2026-08-30 and the
        // offset is winding-independent:
        //
        //   CCW Outside  X[-3.000, 63.000]      CW Outside  X[-3.000, 63.000]
        //   CCW Inside   X[ 3.000, 57.000]      CW Inside   X[ 3.000, 57.000]
        //
        // (outline 0..60, tool radius 3). Written down because a DXF's winding
        // is whatever the CAD wrote and this repo's fixtures carry one direction
        // only, so nothing else would notice it regressing.
        let ccw = [(0.0, 0.0), (60.0, 0.0), (60.0, 60.0), (0.0, 60.0)];
        let mut cw = ccw.to_vec();
        cw.reverse();
        let machine = Machine::default();
        let stock = Stock::default();
        let extent = |pts: &[(f64, f64)], side: CutSide| -> (f64, f64) {
            let mut c = Contour::default();
            for (x, y) in pts {
                c.verts.push(Vertex::line(*x, *y));
            }
            c.closed = true;
            let r = plan_operation(&op("p", c, side), &machine, &stock);
            let xs: Vec<f64> = r
                .path
                .moves
                .iter()
                .filter(|m| m.kind == MoveKind::Feed)
                .map(|m| m.to.x)
                .collect();
            assert!(!xs.is_empty(), "no cutting moves for {side:?}: {:?}", r.refusals);
            (
                xs.iter().cloned().fold(f64::INFINITY, f64::min),
                xs.iter().cloned().fold(f64::NEG_INFINITY, f64::max),
            )
        };
        for side in [CutSide::Outside, CutSide::Inside] {
            let a = extent(&ccw, side);
            let b = extent(&cw, side);
            assert!(
                (a.0 - b.0).abs() < 1e-9 && (a.1 - b.1).abs() < 1e-9,
                "{side:?}: a counter-clockwise outline cut X[{:.3},{:.3}] and the SAME outline \
                 wound clockwise cut X[{:.3},{:.3}]. The offset is following the winding, so half \
                 the drawings in the world come out wrong by twice the tool radius — smooth, \
                 complete, and the wrong size",
                a.0, a.1, b.0, b.1
            );
        }
        // And the direction is right, not merely consistent: outside must be
        // OUTSIDE. Two windings that agree on the wrong answer are still wrong.
        let out = extent(&ccw, CutSide::Outside);
        let ins = extent(&ccw, CutSide::Inside);
        assert!(out.0 < 0.0 && out.1 > 60.0, "Outside did not go outside: {out:?}");
        assert!(ins.0 > 0.0 && ins.1 < 60.0, "Inside did not go inside: {ins:?}");
    }

    #[test]
    fn a_feature_the_cutter_cannot_enter_is_NAMED_not_silently_closed() {
        // 🔴 MEASURED before the fix: a 60x60 square with a 2mm wide, 55mm deep
        // notch, cut Outside with a 6mm cutter, produced ZERO cutting moves
        // anywhere in the notch corridor and ZERO notes. The part comes out
        // SOLID where the drawing shows a slot, and nothing downstream can
        // notice because every coordinate is a real coordinate of a real part.
        let machine = Machine::default();
        let stock = Stock::default();
        let notched = poly(&[
            (0.0, 0.0), (60.0, 0.0), (60.0, 60.0),
            (31.0, 60.0), (31.0, 5.0), (29.0, 5.0), (29.0, 60.0), (0.0, 60.0),
        ]);
        let r = plan_operation(&op("p", notched, CutSide::Outside), &machine, &stock);
        assert!(
            r.notes.iter().any(|n| n.contains("CANNOT BE PRODUCED")),
            "the 2mm notch was closed by the offset without a word: {:?}",
            r.notes
        );
        let said = r.notes.iter().find(|n| n.contains("CANNOT BE PRODUCED")).unwrap();
        assert!(
            said.contains("109") || said.contains("110"),
            "the note must quantify what is missing — the notch is 2 x 55 = 110mm²: {said}"
        );

        // 🔴 SPECIFICITY, and it is the half that decides whether anyone leaves
        // this switched on. A ROUNDED INSIDE CORNER is normal, unavoidable with
        // a round tool, and must never be reported: the round-trip residue for
        // one is (4-PI)/4 * r^2 = 1.93mm² at r=3, which is why the allowance is
        // that model per concave corner rather than a tuned constant.
        for (what, c) in [
            ("plain square", poly(&[(0.0, 0.0), (60.0, 0.0), (60.0, 60.0), (0.0, 60.0)])),
            ("concave L", poly(&[(0.0, 0.0), (60.0, 0.0), (60.0, 20.0), (20.0, 20.0), (20.0, 60.0), (0.0, 60.0)])),
            // A notch the tool DOES fit into: 10mm wide against a 6mm cutter.
            ("10mm notch the tool fits", poly(&[
                (0.0, 0.0), (60.0, 0.0), (60.0, 60.0),
                (35.0, 60.0), (35.0, 5.0), (25.0, 5.0), (25.0, 60.0), (0.0, 60.0),
            ])),
        ] {
            let rr = plan_operation(&op(what, c, CutSide::Outside), &machine, &stock);
            assert!(
                !rr.notes.iter().any(|n| n.contains("CANNOT BE PRODUCED")),
                "{what} was reported as unproducible — a check that fires on ordinary corner \
                 rounding is one people switch off: {:?}",
                rr.notes
            );
        }
    }

    #[test]
    fn an_outline_that_crosses_itself_is_refused_by_name() {
        // 🔴 MEASURED before the fix, on an ASYMMETRIC bowtie — six vertices,
        // one crossing, net area clearly non-zero:
        //
        //   ok: true · 5,991 bytes of runnable G-code · nothing about crossing
        //
        // The only finding on that job was `Undeclared`, the no-clamps warning,
        // unrelated. Offsetting a crossing outline for a tool radius is
        // meaningless where it crosses: the offset inverts and the cutter passes
        // on the wrong side.
        //
        // ⚠ A SYMMETRIC bowtie was already refused and that is why this went
        // unseen: its lobes cancel, `signed_area()` is ~0, and `to_parts`'
        // `area > 1e-9` filter drops it — refused by luck, for the wrong reason,
        // exactly like #151's polyface mesh that happened to fall outside the
        // travel. Unequal lobes walk straight through that filter.
        let bowtie = poly(&[
            (50.0, 50.0), (250.0, 50.0), (250.0, 150.0),
            (60.0, 60.0), (50.0, 150.0), (150.0, 250.0),
        ]);
        let r = plan_operation(&op("bowtie", bowtie, CutSide::Outside), &Machine::default(), &Stock::default());
        assert!(
            !r.refusals.is_empty(),
            "a self-intersecting outline planned {} move(s) — a real program for a shape that is \
             not in the drawing",
            r.path.moves.len()
        );
        assert!(
            r.refusals[0].why.contains("CROSSES ITSELF") && r.refusals[0].why.contains("segment"),
            "the refusal must name the crossing segments so it can be found in the CAD: {:?}",
            r.refusals[0].why
        );
        assert!(r.path.moves.is_empty(), "a refusal must leave no moves behind");
    }

    #[test]
    fn ordinary_outlines_are_not_mistaken_for_self_intersecting_ones() {
        // Specificity, and it matters more than usual here: a geometric check
        // that refuses real parts is one people learn to switch off. Adjacent
        // segments share an endpoint by construction and the closing segment
        // shares one with the first — neither is a crossing.
        let machine = Machine::default();
        let stock = Stock::default();
        for (what, c) in [
            ("square", poly(&[(0.0, 0.0), (60.0, 0.0), (60.0, 60.0), (0.0, 60.0)])),
            ("concave L", poly(&[(0.0, 0.0), (60.0, 0.0), (60.0, 20.0), (20.0, 20.0), (20.0, 60.0), (0.0, 60.0)])),
            // A deep notch: two segments run close and parallel without crossing.
            ("narrow notch", poly(&[
                (0.0, 0.0), (60.0, 0.0), (60.0, 60.0), (31.0, 60.0),
                (31.0, 5.0), (29.0, 5.0), (29.0, 60.0), (0.0, 60.0),
            ])),
            ("triangle", poly(&[(0.0, 0.0), (60.0, 0.0), (30.0, 50.0)])),
        ] {
            let r = plan_operation(&op(what, c, CutSide::Outside), &machine, &stock);
            assert!(
                !r.refusals.iter().any(|x| x.why.contains("CROSSES ITSELF")),
                "{what} was wrongly refused as self-intersecting: {:?}",
                r.refusals
            );
        }
    }

    #[test]
    fn a_hole_whose_tabs_cannot_fit_its_perimeter_is_cut_THROUGH_and_the_part_is_not() {
        // 🔴 THE DEFECT (#155): `operations_for_part` gives every interior
        // feature the OUTER profile's TabSpec. On a 6mm hole — ~19mm of
        // circumference — four 8mm tabs cover the whole path, so the hole was cut
        // to the tab height and no further. Measured on the shipped `multi-tool`
        // job before this fix:
        //
        //   hole1..hole4: deepest Z-15.000 against a requested 18.000
        //
        // Every hole in this repo's own fixtures was BLIND by exactly 3mm — the
        // tab height — and had been since the fixtures were written.
        //
        // The fix needed `OpRole` (#146) to exist, because what to do depends on
        // WHAT THE CUT IS: on a hole the slug is not the part, so dropping the
        // tabs frees the slug and the hole goes through; on the outer profile
        // dropping them would cut the PART free with nothing holding it, which
        // is #156's hazard and must never happen.
        let machine = Machine::default();
        let stock = Stock::default();
        // A 16mm hole: ~50mm of circumference, so four 8mm tabs (32mm) take
        // well over half the path and cannot be discrete bridges. Radius 8 also
        // leaves room for the 6mm cutter to run inside it — a hole the size of
        // the tool is refused for a different reason and would prove nothing.
        let mut hole = Contour::default();
        for i in 0..64 {
            let a = std::f64::consts::TAU * f64::from(i) / 64.0;
            hole.verts.push(Vertex::line(60.0 + 8.0 * a.cos(), 60.0 + 8.0 * a.sin()));
        }
        hole.closed = true;
        // ⚠ Wide enough to cover BOTH perimeters, and that detail is the point:
        // an INSIDE cut offsets inward (radius 8 -> 5, ~31mm of path) and an
        // OUTSIDE cut offsets outward (radius 8 -> 11, ~69mm), so a spec that
        // swamps the hole can still fit comfortably around the outside. Testing
        // the two roles against ONE spec means picking one that covers the larger
        // path too, or the comparison is between two different situations.
        let covering = TabSpec { enabled: true, height_mm: 2.5, width_mm: 12.0, count: 4, min_spacing_mm: 150.0 };
        // ⚠ Tab height 2.5, NOT 3.0, and that is deliberate: the default depth
        // per pass is 3mm, so a 3mm tab sits at Z-15.000 — exactly a pass depth.
        // Counting moves at the tab height would then count an ordinary pass and
        // report tabs on a path that has none. Cost one iteration to notice.

        let mut inner = op("plate-hole1", hole.clone(), CutSide::Inside);
        inner.role = OpRole::Interior;
        inner.params.tabs = covering.clone();
        let r = plan_operation(&inner, &machine, &stock);
        let deepest = r
            .path
            .moves
            .iter()
            .filter(|m| matches!(m.kind, MoveKind::Feed | MoveKind::ArcCW | MoveKind::ArcCCW))
            .map(|m| m.to.z)
            .fold(f64::INFINITY, f64::min);
        assert!(
            (deepest + inner.params.depth_total_mm).abs() < 1e-6,
            "the hole bottomed at {deepest:.3} instead of {:.3} — tabs that cannot fit its \
             perimeter left it BLIND, and a hole that does not go through is found at assembly",
            -inner.params.depth_total_mm
        );

        // 🔴 SPECIFICITY, AND IT IS THE SAFETY HALF: the SAME impossible spec on
        // a RELEASING cut must NOT drop the tabs. Cutting the part free with
        // nothing holding it is worse than leaving it attached.
        //
        // ⚠ The property is TABS PRESENT, not "never severed" — and getting that
        // wrong cost two iterations here. Tabs covering half a path still leave
        // the other half to cut through, so the outline is severed BETWEEN them
        // and reaching full depth proves nothing either way. What distinguishes
        // the two roles is whether any cut rides at tab height at all.
        let tab_height_moves = |r: &PlanResult, depth: f64, tab: f64| -> usize {
            r.path
                .moves
                .iter()
                .filter(|m| matches!(m.kind, MoveKind::Feed | MoveKind::ArcCW | MoveKind::ArcCCW))
                .filter(|m| (m.to.z - (-depth + tab)).abs() < 1e-6)
                .count()
        };
        let depth = inner.params.depth_total_mm;
        assert_eq!(
            tab_height_moves(&r, depth, 2.5),
            0,
            "the HOLE kept tabs it has no room for — that is what left every fixture hole blind"
        );

        let mut outer = op("plate", hole, CutSide::Outside);
        outer.role = OpRole::Releasing;
        outer.params.tabs = covering;
        let ro = plan_operation(&outer, &machine, &stock);
        assert!(
            tab_height_moves(&ro, depth, 2.5) > 0,
            "a RELEASING cut lost its tabs to the same rule that frees a hole's slug — that cuts \
             the PART free with nothing holding it, which is the failure tabs exist to prevent"
        );
    }

    #[test]
    fn tabs_that_hold_nothing_are_refused_rather_than_planned_as_a_free_part() {
        // 🔴 MEASURED: `TabSpec { enabled: true, height_mm: 0.0, width_mm: 8.0,
        // count: 4 }` planned a program BYTE-IDENTICAL to `enabled: false` —
        // compared move for move, kind and coordinates:
        //
        //   normal 4x8mm   moves=361   same-as-tabs-off = false
        //   height = 0     moves=265   same-as-tabs-off = TRUE
        //
        // The operator declares four tabs and the part comes out fully released,
        // held by nothing, `refusals: 0`, no note. That is gate P1's physical
        // failure arriving through a SETTING instead of a missing tab — which is
        // why P1 could not see it: P1 checks tabs are emitted for a job that asks
        // for them, and this job asks and gets none.
        let mut sq = Contour::default();
        for (x, y) in [(0.0, 0.0), (60.0, 0.0), (60.0, 60.0), (0.0, 60.0)] {
            sq.verts.push(Vertex::line(x, y));
        }
        sq.closed = true;
        let machine = Machine::default();
        let stock = Stock::default();
        let plan = |t: TabSpec| {
            let mut o = op("p", sq.clone(), CutSide::Outside);
            o.params.tabs = t;
            plan_operation(&o, &machine, &stock)
        };
        let sig = |r: &PlanResult| {
            r.path
                .moves
                .iter()
                .map(|m| format!("{:?} {:.3} {:.3} {:.3}", m.kind, m.to.x, m.to.y, m.to.z))
                .collect::<Vec<_>>()
        };

        for (field, t) in [
            ("height_mm", TabSpec { enabled: true, height_mm: 0.0, width_mm: 8.0, count: 4, min_spacing_mm: 150.0 }),
            ("height_mm", TabSpec { enabled: true, height_mm: -1.0, width_mm: 8.0, count: 4, min_spacing_mm: 150.0 }),
            ("width_mm", TabSpec { enabled: true, height_mm: 3.0, width_mm: 0.0, count: 4, min_spacing_mm: 150.0 }),
        ] {
            let shown = if field == "width_mm" { t.width_mm } else { t.height_mm };
            let r = plan(t);
            assert!(
                !r.refusals.is_empty(),
                "tabs enabled with {field} = {shown} planned {} move(s) instead of refusing — a \
                 part cut free while the setup says it is tabbed is loose under a turning cutter",
                r.path.moves.len()
            );
            assert!(
                r.refusals[0].why.contains(field) && r.refusals[0].why.contains("tabs are ENABLED"),
                "the refusal must name the field and the contradiction: {:?}",
                r.refusals[0].why
            );
            assert!(r.path.moves.is_empty(), "a refusal must leave no moves behind");
        }

        // The measurement that made this a refusal rather than a note: a
        // zero-height tab is not merely weak, it is INDISTINGUISHABLE from off.
        let off = plan(TabSpec { enabled: false, ..TabSpec::default() });
        let real = plan(TabSpec { enabled: true, height_mm: 3.0, width_mm: 8.0, count: 4, min_spacing_mm: 150.0 });
        assert!(sig(&real) != sig(&off), "a real tab must change the program");
        assert!(off.refusals.is_empty(), "tabs OFF is a declaration, not a fault");
    }

    // Capitalised on purpose: this suite spells the load-bearing word of a test
    // name in capitals so it survives being skimmed in a 700-line result list.
    // 🔴 ABOVE `#[test]`, NOT BETWEEN IT AND `fn` — gate SPEC reads the line
    // directly above a cited function to decide whether it is a test at all.
    #[allow(non_snake_case)]
    #[test]
    fn tabs_that_cover_the_whole_path_are_NAMED_even_though_the_program_still_emits() {
        // ⚠ A NOTE, NOT A REFUSAL, and the reason is recorded in
        // `tabs_never_sever_note`: written as a refusal it refused four
        // reference fixtures. `multi-tool`'s hole1..hole4 reach Z-15.000 of a
        // requested 18 and always have — every hole in this repo's own fixtures
        // is blind by exactly the tab height, because `operations_for_part`
        // gives interior features the outer profile's TabSpec and four 8mm tabs
        // cover a 6mm hole's ~19mm circumference. That is TODO #155, upstream of
        // here, and not something to settle by taking the gate suite down.
        let mut sq = Contour::default();
        for (x, y) in [(0.0, 0.0), (60.0, 0.0), (60.0, 60.0), (0.0, 60.0)] {
            sq.verts.push(Vertex::line(x, y));
        }
        sq.closed = true;
        let mut o = op("p", sq, CutSide::Outside);
        o.params.tabs = TabSpec { enabled: true, height_mm: 3.0, width_mm: 500.0, count: 4, min_spacing_mm: 150.0 };
        let r = plan_operation(&o, &Machine::default(), &Stock::default());
        assert!(r.refusals.is_empty(), "this must still plan: {:?}", r.refusals);
        assert!(
            r.notes.iter().any(|n| n.contains("NO cut reaches its full depth") && n.contains("-15.000")),
            "the operator must be told the outline is never severed, with the depth actually \
             reached: {:?}",
            r.notes
        );
    }

    // -----------------------------------------------------------------------
    //  A NaN depth REFUSES; it does not crash the process
    // -----------------------------------------------------------------------

    #[test]
    fn a_nan_depth_orders_without_panicking_and_is_refused_by_field_name_at_both_planner_doors() {
        // 🔴 Before 2026-08-28 the FIRST of these two lines panicked:
        // `order_operations` sorted on `partial_cmp(...).unwrap()`. It runs
        // ahead of every planner, so a NaN depth crashed the process BEFORE the
        // refusal that already existed for it could ever fire.
        let mut square = Contour::default();
        for (x, y) in [(0.0, 0.0), (40.0, 0.0), (40.0, 40.0), (0.0, 40.0)] {
            square.verts.push(Vertex::line(x, y));
        }
        square.closed = true;

        let mut bad = op("nan-depth", square.clone(), CutSide::Outside);
        bad.params.depth_total_mm = f64::NAN;
        let shallow = op("shallow", square.clone(), CutSide::Inside);

        // 1. ordering survives it — a total order, not a partial one.
        let ordered = order_operations(vec![bad.clone(), shallow], "nan-depth");
        assert_eq!(ordered.len(), 2, "ordering must not lose an operation");

        // 2. and the operation is then REFUSED by name on the emitted program,
        //    with no moves left behind — which is the outcome the panic was
        //    standing in front of.
        let machine = Machine::default();
        let stock = Stock::default();
        let res = plan_operation(&bad, &machine, &stock);
        assert!(
            !res.refusals.is_empty(),
            "a NaN depth must be REFUSED, not planned: {} move(s)",
            res.path.moves.len()
        );
        assert!(
            res.refusals[0].why.contains("depth_total_mm"),
            "the refusal must NAME the field — there is no move to name, which is the defect: {:?}",
            res.refusals[0].why
        );
        assert!(
            res.path.moves.is_empty(),
            "a refusal must leave no moves behind, got {}",
            res.path.moves.len()
        );

        // 🔴 THE MEASUREMENT THAT MADE THIS A SEPARATE CHECK. Before the field
        // refusal existed, this same operation planned 289 moves: both planners
        // clamp with `depth_total_mm.min(stock.thickness_mm + 0.3)` and
        // `f64::min` RETURNS THE NON-NaN OPERAND, so the NaN quietly became the
        // stock thickness. The "clamped, deeper is the spoilboard" note beside
        // it stayed silent too, because `NaN > x` is false. A complete,
        // plausible, runnable full-depth program with no signal anywhere — which
        // is why `nonfinite_refusal` on the emitted moves could never see it.
        assert!(
            f64::NAN.min(18.3).is_finite(),
            "if `f64::min` ever stops swallowing NaN, the reason this refusal is on the FIELD \
             rather than on the emitted program has changed and this comment is stale"
        );

        // Every planner door, not just the one: a drill takes the same param
        // through a second `min` at a different call site.
        let mut circle = Contour::default();
        for i in 0..32 {
            let a = std::f64::consts::TAU * f64::from(i) / 32.0;
            circle.verts.push(Vertex::line(20.0 + 4.0 * a.cos(), 20.0 + 4.0 * a.sin()));
        }
        circle.closed = true;
        let mut bad_drill = op("nan-drill", circle, CutSide::Inside);
        bad_drill.params.op_type = OpType::Drill;
        bad_drill.params.depth_total_mm = f64::NAN;
        let drilled = plan_operation(&bad_drill, &machine, &stock);
        assert!(
            !drilled.refusals.is_empty() && drilled.path.moves.is_empty(),
            "the drill door must refuse the same field: {} refusal(s), {} move(s)",
            drilled.refusals.len(),
            drilled.path.moves.len()
        );
    }

    // -----------------------------------------------------------------------
    //  Per-move attribution
    // -----------------------------------------------------------------------

    #[test]
    fn a_banner_round_trips_through_its_own_reader() {
        // The plain case, and then the two that break a naive parser: an
        // operation name that itself contains brackets (a real filename —
        // `bracket [v2].dxf`), and a tool name containing a space and a digit.
        for (name, tool) in [
            ("pocket-1", "6mm 2F"),
            ("bracket [v2]", "3.175mm 1F O-flute"),
            ("plate", "6mm"),
        ] {
            for made in [op_banner(name, tool), drill_banner(name, tool)] {
                let (n, t) = parse_banner(&made)
                    .unwrap_or_else(|| panic!("the reader did not recognise its own banner: {made}"));
                assert_eq!((n, t), (name, tool), "round trip changed the banner {made:?}");
            }
        }
    }

    #[test]
    fn a_comment_that_is_not_a_banner_attributes_nothing() {
        // 🔴 These are all REAL comments this crate writes. A reader that
        // accepted any of them would attribute the moves that follow to an
        // operation called `3 corner relief(s)`, and the hover panel would name
        // it with a straight face.
        for text in [
            "job: plate",                       // job.rs, first move of every program
            "3 corner relief(s)",               // this file, after the relief bores
            "profile: plate",                   // rect_profile.rs, the fixture generator
            "comments carry no coordinate",     // placement.rs test scaffolding
            "op: ",                             // a banner with no name at all
            "op: plate [unterminated",          // truncated
            "op: [6mm]",                        // brackets, no operation name
        ] {
            assert!(parse_banner(text).is_none(), "{text:?} was read as a banner");
        }
    }

    #[test]
    fn every_move_of_a_planned_operation_names_its_operation_and_its_cutter() {
        let r = plan_profile(
            &op("plate", Contour::rect(50.0, 50.0, 120.0, 80.0), CutSide::Outside),
            &Machine::default(),
            &Stock::default(),
        );
        let origins = attribute_moves(&r.path);
        assert_eq!(
            origins.len(),
            r.path.moves.len(),
            "the attribution is indexed by move, so it must be the same length as the moves"
        );
        assert!(!origins.is_empty(), "the plan produced no moves to attribute");
        for (i, o) in origins.iter().enumerate() {
            assert_eq!(
                (o.op.as_deref(), o.tool.as_deref()),
                (Some("plate"), Some("6mm 2F")),
                "move {i} ({:?}) belongs to no operation",
                r.path.moves[i].kind
            );
        }
    }

    #[test]
    fn a_tool_change_takes_the_operation_with_it_and_names_the_new_cutter() {
        // The shape `job.rs` assembles: an operation, a change, another
        // operation. The change belongs to NEITHER — the next one has not been
        // announced yet — and saying so beats picking one.
        let path = Toolpath {
            moves: vec![
                Move::comment("job: plate"),
                Move::comment(op_banner("outer", "6mm 2F")),
                Move::feed_to(Vec3::new(1.0, 0.0, -1.0), 1200.0),
                Move::tool_change("3mm 1F".to_string()),
                Move::comment(drill_banner("holes", "3mm 1F")),
                Move::drill(Vec3::new(2.0, 2.0, -18.0), 3.0, 300.0),
            ],
            ..Default::default()
        };
        let o = attribute_moves(&path);

        assert_eq!(o[0], MoveOrigin::default(), "the `job:` line belongs to no operation");
        assert_eq!(o[1].op.as_deref(), Some("outer"));
        assert_eq!(o[2].op.as_deref(), Some("outer"));
        assert_eq!(o[2].tool.as_deref(), Some("6mm 2F"));

        // 🔴 The tool change: the new cutter is known, the operation is not.
        assert_eq!(o[3].tool.as_deref(), Some("3mm 1F"), "the change did not name the new cutter");
        assert!(
            o[3].op.is_none(),
            "the tool change was still attributed to {:?} — the operation it FOLLOWS, which \
             is finished, and whose cutter is no longer in the spindle",
            o[3].op
        );

        assert_eq!(o[5].op.as_deref(), Some("holes"));
        assert_eq!(o[5].tool.as_deref(), Some("3mm 1F"));
    }

    #[test]
    fn a_path_with_no_banner_reports_absence_rather_than_the_paths_own_tool() {
        // 🔴 The tempting fallback, refused: `Toolpath::tool` is ONE tool and a
        // program uses several, so filling an absent tool in from it labels
        // every move after the first change with a cutter that is not in the
        // spindle. Absent is the honest answer and a host can render it.
        let path = Toolpath {
            moves: vec![Move::feed_to(Vec3::new(1.0, 0.0, -1.0), 1200.0)],
            tool: tool6(),
            ..Default::default()
        };
        assert_eq!(attribute_moves(&path)[0], MoveOrigin::default());
    }

    #[test]
    fn arc_centre_is_recovered_from_a_bulge() {
        // Quarter circle from (10,0) to (0,10) about the origin, CCW.
        let b = (std::f64::consts::FRAC_PI_8).tan();
        let (cx, cy, cw) = arc_of((10.0, 0.0), (0.0, 10.0), b).unwrap();
        assert!(cx.abs() < 1e-9 && cy.abs() < 1e-9, "centre ({cx},{cy}) should be the origin");
        assert!(!cw, "positive bulge is counter-clockwise");
    }

    #[test]
    fn arc_direction_follows_the_bulge_sign() {
        let b = (std::f64::consts::FRAC_PI_8).tan();
        let (_, _, cw) = arc_of((10.0, 0.0), (0.0, 10.0), -b).unwrap();
        assert!(cw, "negative bulge must be clockwise");
    }

    #[test]
    fn profile_emits_arcs_for_a_rounded_part() {
        let c = Contour::rounded_rect(50.0, 50.0, 120.0, 80.0, 10.0);
        let r = plan_profile(&op("plate", c, CutSide::Outside), &Machine::default(), &Stock::default());
        let arcs = r.path.moves.iter().filter(|m| matches!(m.kind, MoveKind::ArcCW | MoveKind::ArcCCW)).count();
        assert!(arcs >= 4, "rounded profile produced {arcs} arcs — curves were polylined");
        assert!(r.refusals.is_empty(), "{:?}", r.refusals);
    }

    #[test]
    fn a_hole_smaller_than_the_tool_is_refused_not_dropped() {
        // 🔴 P5/G8 class: the offset eliminates it, and silence here means a
        // part ships with a missing hole that nobody notices until assembly.
        let small = Contour::circle(100.0, 100.0, 2.0); // 4mm hole, 6mm tool
        let r = plan_profile(&op("pilot", small, CutSide::Inside), &Machine::default(), &Stock::default());
        assert!(r.path.moves.is_empty() || r.path.moves.len() <= 1);
        assert_eq!(r.refusals.len(), 1, "the uncuttable hole was not reported");
        assert!(r.refusals[0].why.contains("narrower than the cutter"));
    }

    #[test]
    fn depth_is_clamped_to_the_stock_and_says_so() {
        let c = Contour::rect(50.0, 50.0, 100.0, 60.0);
        let mut o = op("deep", c, CutSide::Outside);
        o.params.depth_total_mm = 30.0;
        let r = plan_profile(&o, &Machine::default(), &Stock::default());
        let deepest = r.path.min_z;
        assert!(deepest >= -18.3 - 1e-9, "cut {deepest}mm, past the workpiece");
        assert!(r.notes.iter().any(|n| n.contains("clamped")), "clamping was silent");
    }

    #[test]
    fn every_closed_profile_gets_at_least_two_tabs() {
        // One tab lets the part pivot; that is worse than none.
        let spec = TabSpec::default();
        assert!(auto_tabs(200.0, &spec).len() >= 2);
        assert!(auto_tabs(2000.0, &spec).len() >= 2);
    }

    #[test]
    fn tabs_disabled_means_zero_but_count_zero_means_derive() {
        let derive = TabSpec { count: 0, ..TabSpec::default() };
        assert!(!auto_tabs(400.0, &derive).is_empty(), "count=0 must DERIVE, not disable");
        let off = TabSpec { enabled: false, ..TabSpec::default() };
        assert!(auto_tabs(400.0, &off).is_empty());
    }

    #[test]
    fn tabs_raise_the_tool_on_the_last_pass() {
        let c = Contour::rect(50.0, 50.0, 200.0, 150.0);
        let r = plan_profile(&op("tabbed", c, CutSide::Outside), &Machine::default(), &Stock::default());
        // Somewhere in the deepest pass there must be cutting moves ABOVE the
        // full depth — that is the tab.
        let zs: Vec<f64> = r.path.moves.iter().filter(|m| m.kind == MoveKind::Feed).map(|m| m.to.z).collect();
        let deepest = zs.iter().cloned().fold(f64::INFINITY, f64::min);
        assert!(deepest < -17.0, "never reached depth: {deepest}");
        let lifted = zs.iter().filter(|z| **z > deepest + 1.0 && **z < 0.0).count();
        assert!(lifted > 0, "no tab found — every move was at full depth");
    }

    /// 🔴 A RETRACT THAT IS A PURE Z LIFT ON A LOOP IS A DIAGONAL CUT ON AN OPEN
    /// PATH — and every path `engrave.rs` produces is open.
    ///
    /// The end-of-pass retract used to be written at the loop's `start`. On a
    /// closed contour the tool is already there, so the block carries Z only. On
    /// an open one the tool is at the far end, so the post writes `G0 X.. Y..
    /// Z..` in a single block, the controller interpolates all three together,
    /// and the cutter is dragged sideways at rapid feed until the Z term clears
    /// the surface.
    ///
    /// Measured on `job plate` at `4e9bb8c758`: sixteen marking strokes, each
    /// ending 0.400mm under the surface and followed by an 8mm lateral rapid —
    /// the first ~0.6mm of it still in the material. The whole reference set
    /// carried **20** such rapids; four of those are `G98 G83` returns that only
    /// look like one to a modal reader, and after this change plate carries
    /// exactly those four.
    ///
    /// ⚠ ASSERTED ON THE EMITTED PROGRAM. The plan's `Move::rapid` carries the
    /// same three coordinates whether or not they are safe; what decides it is
    /// whether the block the controller reads changes X or Y while Z is still
    /// below the surface.
    #[test]
    fn an_open_path_lifts_where_it_finished_and_never_rapids_out_of_the_cut() {
        use crate::post_grblhal::{post_grblhal, PostOptions};

        // A single open stroke: three vertices, not closed. The tool finishes at
        // the far end, 0.4mm down.
        let mut c = Contour::default();
        c.verts = vec![Vertex::line(10.0, 10.0), Vertex::line(10.0, 16.0), Vertex::line(10.0, 22.0)];
        c.closed = false;
        let o = Operation {
            name: "stroke".into(),
            part: "stroke".into(),
            role: OpRole::Interior,
            contour: c,
            tool: tool6(),
            params: OperationParams {
                op_type: OpType::Engrave,
                side: CutSide::OnLine,
                depth_total_mm: 0.4,
                depth_per_pass_mm: 0.4,
                entry: EntryMode::Plunge,
                tabs: TabSpec { enabled: false, ..TabSpec::default() },
                ..OperationParams::default()
            },
        };
        let machine = Machine { collet_mm: 6.0, ..Machine::default() };
        let stock = Stock { thickness_mm: 18.0, ..Stock::default() };
        let r = plan_operation(&o, &machine, &stock);
        let g = post_grblhal(&r.path, &machine, &stock, &OperationParams::default(), &PostOptions::default())
            .gcode;

        // Walk the emitted blocks modally and find any G0 that moves in XY while
        // the tool is below Z0.
        let (mut x, mut y, mut z) = (f64::NAN, f64::NAN, f64::NAN);
        let mut diagonal_out_of_the_cut = Vec::new();
        for line in g.lines() {
            let bare = line.split('(').next().unwrap_or("").trim();
            if bare.is_empty() {
                continue;
            }
            let rapid = bare.starts_with("G0 ") || bare == "G0";
            let (mut nx, mut ny, mut nz) = (x, y, z);
            for tok in bare.split_whitespace() {
                let Some(v) = tok.get(1..).and_then(|r| r.parse::<f64>().ok()) else { continue };
                match tok.as_bytes()[0] {
                    b'X' => nx = v,
                    b'Y' => ny = v,
                    b'Z' => nz = v,
                    _ => {}
                }
            }
            if rapid && z < -1e-9 && ((nx - x).abs() > 1e-9 || (ny - y).abs() > 1e-9) {
                diagonal_out_of_the_cut.push(bare.to_string());
            }
            x = nx;
            y = ny;
            z = nz;
        }
        assert!(
            diagonal_out_of_the_cut.is_empty(),
            "the program rapids laterally from cutting depth: {diagonal_out_of_the_cut:?}\n{g}"
        );

        // ...and the retract that IS emitted is the pure lift, at the far end.
        assert!(
            g.contains("G1 Y22.000") && g.lines().any(|l| l.trim() == "G0 Z5.000"),
            "the stroke did not finish where it was cut and lift straight up:\n{g}"
        );
    }

    /// The negative control: a CLOSED contour must be untouched by the change
    /// above. Its last vertex is its first, so the retract was already a pure Z
    /// lift and there was nothing to fix — a fix that "helps" here would have
    /// moved every profile in the repository.
    #[test]
    fn a_closed_contour_still_retracts_exactly_where_it_started() {
        let o = op("square", Contour::rect(0.0, 0.0, 40.0, 40.0), CutSide::Outside);
        let machine = Machine { collet_mm: 6.0, ..Machine::default() };
        let stock = Stock { thickness_mm: 18.0, ..Stock::default() };
        let r = plan_operation(&o, &machine, &stock);
        // Every rapid to safe Z lands on the same XY the pass began at, which on
        // a loop is the loop's own start point.
        let lifts: Vec<&Move> = r
            .path
            .moves
            .iter()
            .filter(|m| m.kind == MoveKind::Rapid && (m.to.z - machine.safe_z_mm).abs() < 1e-9)
            .collect();
        assert!(!lifts.is_empty(), "a closed profile emitted no retract at all");
        for m in &lifts {
            assert!(
                (m.to.x - r.path.moves[0].to.x).abs() < 1e-6
                    || (m.to.y - r.path.moves[0].to.y).abs() < 1e-6,
                "a closed profile's retract moved off the loop start: {:?}",
                m.to
            );
        }
    }

    #[test]
    fn inner_features_are_cut_before_the_outer_profile() {
        let part = Part::new("plate", Contour::rect(0.0, 0.0, 200.0, 100.0))
            .with_hole(Contour::circle(50.0, 50.0, 10.0))
            .with_hole(Contour::circle(150.0, 50.0, 10.0));
        let ops = operations_for_part(&part, &tool6(), &OperationParams::default());
        assert_eq!(ops.len(), 3);
        assert_eq!(ops.last().unwrap().name, "plate", "the outer profile must be LAST");
    }

    #[test]
    fn grouping_by_tool_costs_n_minus_one_changes() {
        let t1 = tool6();
        let t2 = Tool { name: "3mm 1F".into(), diameter_mm: 3.0, ..Tool::default() };
        let ops = vec![
            op("a", Contour::rect(0.0, 0.0, 50.0, 50.0), CutSide::Outside),
            Operation { tool: t2.clone(), ..op("b", Contour::rect(0.0, 0.0, 50.0, 50.0), CutSide::Outside) },
            Operation { tool: t1.clone(), ..op("c", Contour::rect(0.0, 0.0, 50.0, 50.0), CutSide::Outside) },
        ];
        let groups = group_by_tool(ops);
        assert_eq!(groups.len(), 2, "interleaved tools were not grouped: {} groups", groups.len());
        assert_eq!(groups[0].1.len(), 2, "the two 6mm ops should share one group");
    }

    #[test]
    fn dogbone_relief_is_placed_only_at_concave_corners() {
        // A square socket (a hole) has four corners that a round tool cannot
        // reach into. A plain outside square has none.
        let mut socket = Contour::rect(0.0, 0.0, 40.0, 40.0);
        socket.normalise_winding(false); // hole winding
        let relief = dogbone_centres(&socket, 3.0, DogboneStyle::Corner);
        assert_eq!(relief.len(), 4, "expected 4 corner reliefs, got {}", relief.len());
        // 🔴 The relief bores OUTSIDE the nominal socket, into the surrounding
        // material — that is what gives a square tenon somewhere to sit. An
        // earlier version of this test asserted the opposite (inside the
        // socket), which would have described a bore that relieves nothing.
        let want_d = 3.0 * std::f64::consts::SQRT_2;
        for (x, y) in &relief {
            let outside = *x < 1e-9 || *x > 40.0 - 1e-9 || *y < 1e-9 || *y > 40.0 - 1e-9;
            assert!(outside, "relief at ({x},{y}) sits inside the socket and relieves nothing");
            // ...and at exactly the tool-diagonal distance from its corner.
            let d = [(0.0, 0.0), (40.0, 0.0), (40.0, 40.0), (0.0, 40.0)]
                .iter()
                .map(|(cx, cy): &(f64, f64)| ((x - cx).powi(2) + (y - cy).powi(2)).sqrt())
                .fold(f64::INFINITY, f64::min);
            assert!((d - want_d).abs() < 1e-6, "relief {d:.4}mm from its corner, want {want_d:.4}");
        }
    }

    // Capitalised on purpose: this suite spells the load-bearing word of a test
    // name in capitals so it survives being skimmed in a 700-line result list.
    // The lint is silenced rather than the name changed. 🔴 IT GOES ABOVE
    // `#[test]`, NOT BETWEEN IT AND `fn` — gate SPEC reads the line directly
    // above a cited function to decide whether it is a test at all, and
    // splitting the pair made a live citation dangle.
    #[allow(non_snake_case)]
    #[test]
    fn corner_relief_is_actually_CUT_not_merely_counted() {
        // 🔴 The defect this test exists for: reliefs were computed, reported in
        // the summary, and never emitted. A socket came off the machine with
        // round corners while the UI said four reliefs had been cut.
        let mut socket = Contour::rect(100.0, 100.0, 40.0, 40.0);
        socket.normalise_winding(false);
        let mut o = op("socket", socket, CutSide::Inside);
        o.params.dogbone = DogboneStyle::Corner;
        let r = plan_profile(&o, &Machine::default(), &Stock::default());
        let bores = r.path.moves.iter().filter(|m| m.kind == MoveKind::DrillCycle).count();
        assert_eq!(bores, 4, "the reliefs were reported but never cut");

        // Negative control: with relief off, no bore is emitted.
        let mut socket2 = Contour::rect(100.0, 100.0, 40.0, 40.0);
        socket2.normalise_winding(false);
        let mut o2 = op("socket", socket2, CutSide::Inside);
        o2.params.dogbone = DogboneStyle::None;
        let r2 = plan_profile(&o2, &Machine::default(), &Stock::default());
        assert_eq!(
            r2.path.moves.iter().filter(|m| m.kind == MoveKind::DrillCycle).count(),
            0,
            "reliefs were cut with relief disabled"
        );
    }

    #[test]
    fn climb_and_conventional_traverse_in_opposite_directions() {
        // 🔴 `Direction` was stored and read by nothing. A setting consumed by
        // nowhere reads as configured and changes no coordinate.
        let c = Contour::rect(50.0, 50.0, 120.0, 80.0);
        let mut climb = op("p", c.clone(), CutSide::Outside);
        climb.params.direction = Direction::Climb;
        let mut conv = op("p", c, CutSide::Outside);
        conv.params.direction = Direction::Conventional;

        let a = plan_profile(&climb, &Machine::default(), &Stock::default());
        let b = plan_profile(&conv, &Machine::default(), &Stock::default());

        let xy = |r: &PlanResult| -> Vec<(u64, u64)> {
            r.path
                .moves
                .iter()
                .filter(|m| m.kind == MoveKind::Feed)
                .map(|m| ((m.to.x * 1000.0) as u64, (m.to.y * 1000.0) as u64))
                .collect()
        };
        let (va, vb) = (xy(&a), xy(&b));
        assert!(!va.is_empty() && !vb.is_empty());
        assert_ne!(va, vb, "climb and conventional produced the identical path");

        // The property that DEFINES direction is the sense of travel, so that
        // is what is asserted: the signed area swept by the emitted polyline
        // must have opposite signs.
        //
        // ⚠ The point SETS are deliberately NOT compared. A first version did,
        // and failed — correctly, because reversing the traversal moves where
        // the ramp descends and where the tabs fall, so individual points
        // legitimately differ. What must not change is the envelope.
        let signed = |v: &Vec<(u64, u64)>| -> f64 {
            let p: Vec<(f64, f64)> =
                v.iter().map(|(x, y)| (*x as f64 / 1000.0, *y as f64 / 1000.0)).collect();
            let mut s = 0.0;
            for i in 0..p.len() {
                let j = (i + 1) % p.len();
                s += p[i].0 * p[j].1 - p[j].0 * p[i].1;
            }
            s * 0.5
        };
        let (sa, sb) = (signed(&va), signed(&vb));
        assert!(
            sa * sb < 0.0,
            "climb and conventional travelled the same way round (areas {sa:.1} and {sb:.1})"
        );

        let bounds = |r: &PlanResult| {
            (
                (r.path.min_x * 1000.0).round(),
                (r.path.min_y * 1000.0).round(),
                (r.path.max_x * 1000.0).round(),
                (r.path.max_y * 1000.0).round(),
            )
        };
        assert_eq!(
            bounds(&a),
            bounds(&b),
            "the direction changed the cut ENVELOPE — the offset went the wrong way"
        );
    }

    #[test]
    fn a_lead_enters_and_leaves_on_an_arc_off_the_finished_edge() {
        let c = Contour::rect(50.0, 50.0, 120.0, 80.0);
        let mut o = op("p", c, CutSide::Outside);
        o.params.entry = EntryMode::Plunge;
        o.params.lead_mm = 0.0;
        let none = plan_profile(&o, &Machine::default(), &Stock::default());
        o.params.lead_mm = 4.0;
        let led = plan_profile(&o, &Machine::default(), &Stock::default());

        let arcs = |r: &PlanResult| {
            r.path
                .moves
                .iter()
                .filter(|m| matches!(m.kind, MoveKind::ArcCW | MoveKind::ArcCCW))
                .count()
        };
        // ⚠ NOT "no arcs without a lead". The outside offset of a sharp corner
        // IS an arc of the tool radius — the cutter physically sweeps it — so a
        // square part already emits arcs at its four corners on every pass. The
        // first version of this test asserted zero and measured 48, which was
        // the geometry being right rather than the lead being wrong.
        assert!(arcs(&none) > 0, "corner arcs vanished from the offset");
        assert!(
            arcs(&led) >= arcs(&none) + 2,
            "the lead added {} arcs, expected at least 2 (in and out)",
            arcs(&led) - arcs(&none)
        );

        // 🔴 The lead must sit in the WASTE. On an outside profile the tool
        // centre already runs outside the part, so a lead placed on the wrong
        // side drives an arc straight through the finished edge.
        let (x0, y0, x1, y1) = (50.0, 50.0, 170.0, 130.0);
        for m in led.path.moves.iter().filter(|m| m.kind == MoveKind::Feed) {
            let inside = m.to.x > x0 + 1e-6 && m.to.x < x1 - 1e-6 && m.to.y > y0 + 1e-6
                && m.to.y < y1 - 1e-6;
            assert!(!inside, "a lead move at ({}, {}) is inside the part", m.to.x, m.to.y);
        }
    }

    #[test]
    fn a_lead_on_an_inside_cut_is_refused_and_said_rather_than_cut() {
        // 🔴 An inside cut has only the tool radius of clearance, so there is no
        // room for a lead arc of that radius. Cutting it anyway put the tool
        // centre 1mm past the wall — 3mm of cutter through the finished face.
        let mut socket = Contour::rect(100.0, 100.0, 40.0, 40.0);
        socket.normalise_winding(false);
        let mut o = op("socket", socket, CutSide::Inside);
        o.params.entry = EntryMode::Plunge;
        o.params.lead_mm = 4.0;
        let r = plan_profile(&o, &Machine::default(), &Stock::default());
        assert!(
            r.notes.iter().any(|n| n.contains("lead was NOT applied")),
            "the lead was skipped silently: {:?}",
            r.notes
        );
        // ...and nothing reaches past the wall.
        for m in r.path.moves.iter().filter(|m| {
            matches!(m.kind, MoveKind::Feed | MoveKind::ArcCW | MoveKind::ArcCCW)
        }) {
            assert!(
                m.to.x >= 100.0 - 1e-6 && m.to.x <= 140.0 + 1e-6
                    && m.to.y >= 100.0 - 1e-6 && m.to.y <= 140.0 + 1e-6,
                "a lead move at ({}, {}) is outside the socket, in the part",
                m.to.x,
                m.to.y
            );
        }
    }

    #[test]
    fn a_closing_duplicate_vertex_does_not_put_a_non_finite_word_in_the_program() {
        // 🔴 THE DEFECT THIS FILE EXISTS TO STOP, in its worst observed form: the
        // hive_box_prototype drawing planned to 1588 lines containing 144
        // `G1 XNaN YNaN` blocks, reported ok=true and cut=NaNmm, and every check
        // agreed — because the bounding box those checks read had swallowed the
        // NaN through `f64::min`/`f64::max`.
        //
        // 🔴 ASSERTED ON THE EMITTED MOVES, not on the contour that was handed
        // in. The plan is not the program.
        let clean = Contour::rect(0.0, 0.0, 200.0, 120.0);
        let dup = Contour::closed(vec![
            Vertex::line(0.0, 0.0),
            Vertex::line(200.0, 0.0),
            Vertex::line(200.0, 120.0),
            Vertex::line(0.0, 120.0),
            Vertex::line(0.0, 0.0), // the closing vertex a DXF writer adds
        ]);

        let a = plan_profile(&op("plate", clean, CutSide::Outside), &Machine::default(), &Stock::default());
        let b = plan_profile(&op("plate", dup, CutSide::Outside), &Machine::default(), &Stock::default());

        assert!(b.refusals.is_empty(), "a redundant closing vertex was refused: {:?}", b.refusals);
        let bad: Vec<String> = b
            .path
            .moves
            .iter()
            .enumerate()
            .filter(|(_, m)| !(m.to.x.is_finite() && m.to.y.is_finite() && m.to.z.is_finite()))
            .map(|(i, m)| format!("#{i} {:?} ({}, {}, {})", m.kind, m.to.x, m.to.y, m.to.z))
            .collect();
        assert!(bad.is_empty(), "{} non-finite move(s) planned: {:?}", bad.len(), bad);

        // ...and the cut is the SAME cut. A zero-length segment removes no
        // material at any tool radius, so dropping it may not change a
        // coordinate. Equal move counts and an equal envelope is the cheapest
        // statement of that.
        assert_eq!(
            a.path.moves.len(),
            b.path.moves.len(),
            "the redundant vertex changed the program length"
        );
        assert!(
            (a.path.min_x - b.path.min_x).abs() < 1e-9
                && (a.path.max_x - b.path.max_x).abs() < 1e-9
                && (a.path.min_y - b.path.min_y).abs() < 1e-9
                && (a.path.max_y - b.path.max_y).abs() < 1e-9,
            "the redundant vertex changed the cut envelope: {:?} vs {:?}",
            (a.path.min_x, a.path.max_x, a.path.min_y, a.path.max_y),
            (b.path.min_x, b.path.max_x, b.path.min_y, b.path.max_y),
        );
    }

    #[test]
    fn a_contour_that_is_only_a_point_is_refused_by_what_it_actually_is() {
        // Dropping zero-length segments is only safe because they carry no
        // intent. A contour that is NOTHING BUT zero-length segments carries the
        // opposite: it is a feature that does not exist, and it must be named as
        // that rather than fall through to the "narrower than the cutter"
        // refusal, which sends a person to change tools over a broken drawing.
        let point = Contour::closed(vec![
            Vertex::line(60.0, 60.0),
            Vertex::line(60.0, 60.0),
            Vertex::line(60.0, 60.0),
        ]);
        let r = plan_profile(&op("ghost", point, CutSide::Outside), &Machine::default(), &Stock::default());
        assert_eq!(r.refusals.len(), 1, "a degenerate contour was not refused: {:?}", r.refusals);
        assert!(
            r.refusals[0].why.contains("single point"),
            "the refusal does not say what is wrong: {}",
            r.refusals[0].why
        );
        assert!(
            r.path.moves.is_empty(),
            "a refused degenerate contour still planned {} moves",
            r.path.moves.len()
        );
    }

    #[test]
    fn a_planned_path_carrying_a_non_finite_move_is_refused_by_name() {
        // 🔴 The plan-side arm of the refusal, exercised DIRECTLY because the
        // geometry fix means no input can reach it any more. That is exactly why
        // it has to be tested here: a guard whose only trigger has been removed
        // upstream is a guard nobody can prove still works, and this one exists
        // for the NEXT divide-by-zero rather than for the one already fixed.
        //
        // Making `JobResult::is_runnable()` false is what stops the program
        // being written at all — the post's own refusal is the layer below.
        let mut path = Toolpath {
            moves: vec![
                Move::rapid(Vec3::new(10.0, 10.0, 5.0)),
                Move::feed_to(Vec3::new(f64::NAN, 20.0, -3.0), 1200.0),
            ],
            ..Default::default()
        };
        path.recompute_bounds();
        let r = nonfinite_refusal("plate", &path).expect("a NaN destination was not refused");
        assert_eq!(r.what, "plate", "the refusal does not name the operation");
        assert!(r.why.contains("move 1"), "the refusal does not name the move: {}", r.why);
        assert!(r.why.contains("non-finite"), "{}", r.why);

        // Negative control: an ordinary path is not refused, and an infinity is
        // caught as well as a NaN — `is_finite()` covers both, and only testing
        // NaN would leave the overflow case to chance.
        let mut clean = Toolpath {
            moves: vec![
                Move::rapid(Vec3::new(10.0, 10.0, 5.0)),
                Move::feed_to(Vec3::new(30.0, 20.0, -3.0), 1200.0),
            ],
            ..Default::default()
        };
        clean.recompute_bounds();
        assert!(nonfinite_refusal("plate", &clean).is_none(), "a clean path was refused");

        let mut inf = clean.clone();
        inf.moves.push(Move::feed_to(Vec3::new(40.0, f64::INFINITY, -3.0), 1200.0));
        inf.recompute_bounds();
        assert!(nonfinite_refusal("plate", &inf).is_some(), "an infinite coordinate was accepted");

        // A comment carries no destination and must never be read as one.
        let mut commented = clean.clone();
        commented.moves.insert(0, Move::comment("no coordinate"));
        commented.recompute_bounds();
        assert!(nonfinite_refusal("plate", &commented).is_none(), "a comment was refused");
    }

    #[test]
    fn dogbone_none_produces_nothing() {
        let mut socket = Contour::rect(0.0, 0.0, 40.0, 40.0);
        socket.normalise_winding(false);
        assert!(dogbone_centres(&socket, 3.0, DogboneStyle::None).is_empty());
    }

    // =======================================================================
    //  An edge that lies on the workpiece edge does not have to be cut
    //
    //  🔴 The GEOMETRY lives here. Everything about what reaches the emitted
    //  program, and about when the decision is taken, is asserted in
    //  `job::workpiece_edge_tests` against posted G-code — because a control
    //  that reads the plan is green about the plan.
    // =======================================================================

    /// 🔴 **THE CORRECTNESS ARGUMENT FOR THE WHOLE FEATURE, MEASURED.**
    ///
    /// Skipping an edge turns a closed profile into an open path, and the tool
    /// centre for that open path has to be the *same curve* the closed offset
    /// would have followed over the edges that are still cut — the same corner
    /// arcs, at the same radius, in the same direction. If it were merely
    /// *similar*, the part would come off the machine a fraction under or over
    /// on the edges nobody chose to change.
    ///
    /// So this asserts the strong form: the open chain's offset is a
    /// **contiguous run of the closed offset's own vertices**, bulges included,
    /// and its two ends are the PERPENDICULAR offsets of the outline's corners —
    /// which is exactly where the tool centre must reach for the wall to be
    /// finished all the way out to the workpiece edge.
    #[test]
    fn an_open_chains_offset_is_the_closed_offset_with_the_skipped_run_removed() {
        let mut rect = Contour::rect(0.0, 0.0, 100.0, 60.0);
        rect.normalise_winding(true);
        // Segment 0 is (0,0) -> (100,0), the y-min edge. Drop it.
        let keep = vec![false, true, true, true];

        let chains = retained_chains(&rect, &keep);
        assert_eq!(chains.len(), 1, "three consecutive kept edges are ONE chain: {chains:?}");
        let chain = &chains[0];
        assert!(!chain.closed, "a chain with an edge missing is not a loop");
        assert_eq!(
            chain.verts.iter().map(|v| (v.x, v.y)).collect::<Vec<_>>(),
            vec![(100.0, 0.0), (100.0, 60.0), (0.0, 60.0), (0.0, 0.0)],
            "the chain did not start immediately after the dropped edge, or lost the wrap"
        );

        let open = chain.offset(3.0);
        assert_eq!(open.len(), 1, "the chain offset to {} paths", open.len());
        let open = &open[0];
        let closed = rect.offset(3.0);
        assert_eq!(closed.len(), 1);
        let closed = &closed[0];

        // Where the run starts in the closed loop.
        let at = closed
            .verts
            .iter()
            .position(|v| (v.x - open.verts[0].x).abs() < 1e-9 && (v.y - open.verts[0].y).abs() < 1e-9)
            .unwrap_or_else(|| {
                panic!(
                    "the open offset starts at ({:.3}, {:.3}), which is not a vertex of the \
                     closed offset {:?} — the two are different curves",
                    open.verts[0].x, open.verts[0].y, closed.verts
                )
            });
        for (k, v) in open.verts.iter().enumerate() {
            let c = closed.verts[(at + k) % closed.verts.len()];
            assert!(
                (v.x - c.x).abs() < 1e-9 && (v.y - c.y).abs() < 1e-9,
                "open vertex {k} ({:.6}, {:.6}) does not sit on the closed offset ({:.6}, {:.6})",
                v.x,
                v.y,
                c.x,
                c.y
            );
            // The last vertex ENDS the chain and owns no segment, so its bulge
            // is deliberately cleared; every other one must carry the closed
            // loop's own arc — that is what keeps the corner radii right.
            if k + 1 < open.verts.len() {
                assert!(
                    (v.bulge - c.bulge).abs() < 1e-9,
                    "open vertex {k} lost its arc: bulge {:.6} against {:.6}",
                    v.bulge,
                    c.bulge
                );
            }
        }

        // The ends: perpendicular offsets of (100,0) and (0,0), both ON the
        // workpiece edge the skipped edge lies on.
        let first = open.verts[0];
        let last = open.verts[open.verts.len() - 1];
        assert!(
            (first.x - 103.0).abs() < 1e-9 && first.y.abs() < 1e-9,
            "the chain starts at ({:.3}, {:.3}), not at the perpendicular offset (103.000, 0.000) \
             — a short start leaves material standing at the corner",
            first.x,
            first.y
        );
        assert!(
            (last.x + 3.0).abs() < 1e-9 && last.y.abs() < 1e-9,
            "the chain ends at ({:.3}, {:.3}), not at (-3.000, 0.000)",
            last.x,
            last.y
        );
    }

    #[test]
    fn two_skipped_edges_on_opposite_sides_leave_two_chains_and_a_wrap_leaves_one() {
        let mut rect = Contour::rect(0.0, 0.0, 100.0, 60.0);
        rect.normalise_winding(true);

        // Opposite edges (y-min = 0, y-max = 2): two separate chains.
        let two = retained_chains(&rect, &[false, true, false, true]);
        assert_eq!(two.len(), 2, "opposite skipped edges must leave two open paths: {two:?}");
        for ch in &two {
            assert_eq!(ch.verts.len(), 2, "each chain is one edge here: {ch:?}");
            assert!(!ch.closed);
        }

        // Adjacent through the WRAP (segments 3 and 0): the surviving run spans
        // index 0 and must not be cut in half by it.
        let wrapped = retained_chains(&rect, &[false, true, true, false]);
        assert_eq!(wrapped.len(), 1, "a run split across the wrap became {} chains", wrapped.len());
        assert_eq!(
            wrapped[0].verts.iter().map(|v| (v.x, v.y)).collect::<Vec<_>>(),
            vec![(100.0, 0.0), (100.0, 60.0), (0.0, 60.0)]
        );

        // The degenerate ends: all kept and none kept both mean "there is no
        // open chain here", and the caller has already decided what to do about
        // each. Returning a chain for either would be a third answer.
        assert!(retained_chains(&rect, &[true; 4]).is_empty());
        assert!(retained_chains(&rect, &[false; 4]).is_empty());
    }

    /// 🔴 **THE NEAR-MISS IS THE DANGEROUS CASE**, and this is the plant for it.
    /// An outline 0.2mm inside the workpiece, skipped, leaves a 0.2mm ribbon of
    /// material holding the part — worse than either cutting it or leaving it
    /// properly. So the tolerance decides, and it decides both ways.
    #[test]
    fn a_near_miss_is_cut_unless_the_declared_tolerance_says_otherwise() {
        let stock = Stock::default(); // 600 x 900 at the datum
        let flush = ((0.0, 0.0), (200.0, 0.0));
        let inside_02 = ((0.0, 0.2), (200.0, 0.2));

        // Flush, at a tolerance that is not generous: skipped, and it names the
        // edge and says it is 0.000mm inside.
        let (edge, inside) =
            edge_on_workpiece(&stock, 0.1, flush.0, flush.1).expect("a flush edge was not matched");
        assert_eq!(edge, WorkpieceEdge::YMin);
        assert!(inside.abs() < 1e-9, "a flush edge reported {inside}mm inside");

        // 🔴 0.2mm inside, tolerance 0.1mm: NOT matched. This is the ribbon.
        assert!(
            edge_on_workpiece(&stock, 0.1, inside_02.0, inside_02.1).is_none(),
            "an edge 0.2mm inside the workpiece was treated as coincident at a 0.1mm tolerance — \
             skipping it leaves a 0.2mm ribbon of material holding the part"
        );

        // ...and the tolerance is what decides it, not the geometry: declare
        // 0.3mm and the same edge is skipped, reported at its true depth.
        let (_, inside) = edge_on_workpiece(&stock, 0.3, inside_02.0, inside_02.1)
            .expect("the declared tolerance did not reach the predicate");
        assert!((inside - 0.2).abs() < 1e-9, "reported {inside}mm inside, want 0.200");

        // 🔴 ONE END ON THE EDGE IS NOT AN EDGE ON THE EDGE. A segment leaving
        // the workpiece boundary would take a wedge of material with it.
        assert!(
            edge_on_workpiece(&stock, 0.1, (0.0, 0.0), (200.0, 40.0)).is_none(),
            "a segment with one end flush and the other 40mm inside was matched"
        );

        // ⚠ And collinear is not coincident: 800mm past the end of a 600mm-wide
        // workpiece, exactly on the y-min edge's own line, touching nothing.
        assert!(
            edge_on_workpiece(&stock, 0.1, (800.0, 0.0), (900.0, 0.0)).is_none(),
            "a segment clear of the workpiece was matched against the line its edge lies on"
        );

        // Every side is reachable, so a part flush on the far edges is not
        // silently a part flush on nothing.
        for (p0, p1, want) in [
            ((0.0, 0.0), (0.0, 200.0), WorkpieceEdge::XMin),
            ((600.0, 0.0), (600.0, 200.0), WorkpieceEdge::XMax),
            ((0.0, 900.0), (200.0, 900.0), WorkpieceEdge::YMax),
        ] {
            let (e, _) = edge_on_workpiece(&stock, 0.1, p0, p1)
                .unwrap_or_else(|| panic!("{want:?} was never matched"));
            assert_eq!(e, want);
        }
    }

    #[test]
    fn a_turned_workpiece_takes_its_edges_with_it() {
        // 🔴 The predicate reads `Stock::place`, so the workpiece's turn and
        // datum are already in the answer — an edge flush on a square workpiece
        // is still flush when the workpiece is laid a quarter turn, and an edge
        // that stays put while the workpiece turns is NOT.
        let square = Stock { size_x_mm: 400.0, size_y_mm: 400.0, ..Stock::default() };
        let turned = Stock { rotation_deg: 90.0, ..square.clone() };

        // On the un-turned workpiece the y-min edge runs (0,0) -> (200,0).
        assert!(edge_on_workpiece(&square, 0.1, (0.0, 0.0), (200.0, 0.0)).is_some());

        // Turned a quarter turn the workpiece still covers 0..400 in both axes
        // (it is square), so the same machine-coordinate line is still an edge —
        // it is just a DIFFERENT edge of the material, and it is named as one.
        let (e, _) = edge_on_workpiece(&turned, 0.1, (0.0, 0.0), (200.0, 0.0))
            .expect("the turned workpiece lost the edge under that line");
        assert_eq!(
            e,
            WorkpieceEdge::XMin,
            "the quarter turn did not carry the edge names round with the material"
        );

        // And a datum shift moves the whole question with the workpiece: the same
        // outline line is now 40mm inside.
        let shifted = Stock { origin_y_mm: -40.0, ..square };
        assert!(
            edge_on_workpiece(&shifted, 0.1, (0.0, 0.0), (200.0, 0.0)).is_none(),
            "the datum moved the workpiece and the edge test did not move with it"
        );
    }

    // -----------------------------------------------------------------------
    //  Off the material — the question `use_workpiece_edge` does NOT answer
    // -----------------------------------------------------------------------

    #[test]
    fn outside_is_measured_against_the_workpieces_four_edges_and_not_its_box() {
        // 🔴 THE IN-TEST NEGATIVE CONTROL IS THE OLD ALGORITHM. `job.rs` used to
        // compare the program's bounding box against the WORKPIECE's bounding
        // box, and on a workpiece laid at a free angle those are different
        // shapes: the box contains four triangles of nothing. A point in one of
        // them is off the material and inside the box, and the old arithmetic
        // reported it as fine. Run both here so the claim "this fires at least
        // as often as it used to" is measured rather than asserted.
        let turned = Stock { size_x_mm: 400.0, size_y_mm: 200.0, rotation_deg: 30.0, ..Stock::default() };
        let corners = [
            turned.place(0.0, 0.0),
            turned.place(400.0, 0.0),
            turned.place(0.0, 200.0),
            turned.place(400.0, 200.0),
        ];
        let bx0 = corners.iter().map(|p| p.0).fold(f64::INFINITY, f64::min);
        let by0 = corners.iter().map(|p| p.1).fold(f64::INFINITY, f64::min);
        // The bounding box's own lower-left corner. It is INSIDE the box by
        // construction and, on a 30-degree lay, well outside the material.
        let p = (bx0 + 0.5, by0 + 0.5);
        let old_box_answer = [bx0 - p.0, p.0 - bx0, by0 - p.1, p.1 - by0]
            .into_iter()
            .fold(0.0_f64, f64::max);
        assert!(
            old_box_answer <= 0.5 + 1e-9,
            "the control is not exercising the difference: the box already objects"
        );
        assert!(
            outside_workpiece_mm(&turned, p) > 50.0,
            "a point in the corner of the bounding box read as ON the turned material: {:.3}mm",
            outside_workpiece_mm(&turned, p)
        );

        // ...and the positive control in the other direction: dead centre of the
        // same turned workpiece is inside, so this is not a function that answers
        // "outside" to everything.
        assert_eq!(outside_workpiece_mm(&turned, turned.place(200.0, 100.0)), 0.0);
        // On the boundary is ON the material, not off it. A part whose edge IS
        // the workpiece edge is a legal placement; what is not legal is the
        // CUTTER going past it, and that is the thing this measures.
        assert_eq!(outside_workpiece_mm(&turned, turned.place(0.0, 100.0)), 0.0);
    }

    #[test]
    fn a_rapid_over_the_edge_is_not_a_strike_and_a_feed_over_it_is() {
        // 🔴 THE SPECIFICITY CONTROL, and it is the half a plant cannot give.
        // Making the check fire proves it is sensitive; this proves it is not
        // simply always on. A rapid crossing the boundary at clearance height is
        // air — it is counted and reported, and it must NOT produce the sentence
        // about a cutter over bare spoilboard, or that sentence stops being read.
        let stock = Stock::default(); // 600 x 900 at the datum
        let mut rapid_only = Toolpath::default();
        rapid_only.moves.push(Move::rapid(Vec3::new(-25.0, 400.0, 5.0)));
        rapid_only.moves.push(Move::feed_to(Vec3::new(300.0, 400.0, -3.0), 1000.0));
        let r = off_material(&rapid_only, &stock);
        assert_eq!((r.rapid_moves, r.cutting_moves), (1, 0), "{r:?}");
        assert!((r.worst_out_mm - 25.0).abs() < 1e-9, "{r:?}");
        assert!(r.strike_note().is_none(), "a rapid in the air produced a cutting strike");
        assert!(r.program_comment().is_none(), "a rapid in the air wrote itself into the program");

        // The same geometry as a FEED is the hazard, and it names where.
        let mut feeding = Toolpath::default();
        feeding.moves.push(Move::rapid(Vec3::new(300.0, 400.0, 5.0)));
        feeding.moves.push(Move::feed_to(Vec3::new(-25.0, 400.0, -18.0), 1000.0));
        let f = off_material(&feeding, &stock);
        assert_eq!((f.rapid_moves, f.cutting_moves), (0, 1), "{f:?}");
        let note = f.strike_note().expect("a feed 25mm off the workpiece said nothing");
        assert!(
            note.contains("BARE SPOILBOARD") && note.contains("frame"),
            "the strike names the geometry and not what is under the cutter: {note}"
        );
        assert!(
            f.program_comment().expect("nothing for the program").contains("X-25.000"),
            "the program comment does not say where"
        );
    }

    #[test]
    fn a_program_that_stays_on_the_workpiece_says_nothing_at_all() {
        // The other specificity control: the ordinary case must be silent, or
        // the sentence above is noise on every job.
        let stock = Stock::default();
        let mut inside = Toolpath::default();
        inside.moves.push(Move::rapid(Vec3::new(10.0, 10.0, 5.0)));
        inside.moves.push(Move::feed_to(Vec3::new(590.0, 890.0, -18.0), 1000.0));
        // Exactly ON the boundary too — a flush placement is not itself the
        // defect, the cutter leaving the material is.
        inside.moves.push(Move::feed_to(Vec3::new(600.0, 900.0, -18.0), 1000.0));
        let r = off_material(&inside, &stock);
        assert_eq!(r, OffMaterial::default(), "an on-workpiece program was reported off it: {r:?}");
        assert!(r.strike_note().is_none());
    }

    #[test]
    fn an_arcs_bulge_off_the_workpiece_is_seen_and_not_only_its_ends() {
        // Both ENDS of this arc are on the material; the arc swings 20mm past
        // the workpiece edge in between. Measuring destinations alone — which is
        // exact for straight moves, because the workpiece is convex — would call
        // it clean, so the arc extent is used and this is what pins it.
        let stock = Stock::default();
        let mut p = Toolpath::default();
        p.moves.push(Move::rapid(Vec3::new(280.0, 10.0, 5.0)));
        p.moves.push(Move::arc(
            false,
            Vec3::new(320.0, 10.0, -3.0),
            Vec2::new(300.0, 10.0),
            1000.0,
        ));
        let r = off_material(&p, &stock);
        assert_eq!(r.cutting_moves, 1, "the arc's bulge past Y0 was not seen: {r:?}");
        assert!(r.cutting_out_mm > 9.0, "the bulge was measured at {:.2}mm", r.cutting_out_mm);
        // Its two ENDS are both on the material — a destination-only fold reads
        // this program as clean, which is the point of the assertion above.
        assert_eq!(outside_workpiece_mm(&stock, (280.0, 10.0)), 0.0);
        assert_eq!(outside_workpiece_mm(&stock, (320.0, 10.0)), 0.0);
    }

    #[test]
    fn an_arc_is_never_read_as_lying_on_a_straight_workpiece_edge() {
        // A half-circle whose two ENDS both sit on the workpiece edge. Its ends
        // pass the distance test and the segment does not: the arc bulges 30mm
        // into the material and cutting it is the whole job.
        let stock = Stock::default();
        let mut c = Contour::closed(vec![
            Vertex::arc(0.0, 0.0, 1.0),
            Vertex::line(60.0, 0.0),
        ]);
        c.normalise_winding(true);
        let mut o = op("bump", c, CutSide::Outside);
        o.params.entry = EntryMode::Plunge;
        let r = plan_profile_with_edge_rule(
            &o,
            &Machine::default(),
            &stock,
            Some(&WorkpieceEdgeRule { tolerance_mm: 0.1 }),
        );
        assert!(r.refusals.is_empty(), "{:?}", r.refusals);
        let summary = r
            .notes
            .iter()
            .find(|n| n.contains("outline edges cut"))
            .unwrap_or_else(|| panic!("no summary line: {:?}", r.notes));
        assert!(
            summary.contains("1 of 2 outline edges cut; 1 skipped"),
            "the arc was counted with the straight edge: {summary}"
        );
        // ...and the bulge itself is still in the program.
        assert!(
            r.path.moves.iter().any(|m| matches!(m.kind, MoveKind::ArcCW | MoveKind::ArcCCW)),
            "the arc was dropped along with the flat edge"
        );
    }

    #[test]
    fn the_rule_does_nothing_to_an_inside_cut_or_an_on_line_engrave() {
        // 🔴 The rule is about the OUTLINE OF A PART taking its dimension from
        // the workpiece. A bore and an engraved stroke are neither, so the rule
        // must be inert on them — including the summary line, which would
        // otherwise report "0 of 2 edges skipped" on every hole in the job and
        // teach an operator to skip the paragraph.
        let stock = Stock::default();
        let rule = WorkpieceEdgeRule { tolerance_mm: 0.1 };
        let machine = Machine::default();

        // A socket drawn hard against the workpiece corner — its edges genuinely
        // do lie on the workpiece edge.
        let mut socket = Contour::rect(0.0, 0.0, 60.0, 60.0);
        socket.normalise_winding(false);
        let mut inside = op("socket", socket, CutSide::Inside);
        inside.params.entry = EntryMode::Plunge;
        let a = plan_profile(&inside, &machine, &stock);
        let b = plan_profile_with_edge_rule(&inside, &machine, &stock, Some(&rule));
        assert_eq!(a.notes, b.notes, "the rule spoke about an inside cut");
        assert_eq!(
            a.path.moves.len(),
            b.path.moves.len(),
            "the rule changed an inside cut's program"
        );

        let mut stroke = op(
            "mark",
            Contour::open(vec![Vertex::line(0.0, 0.0), Vertex::line(80.0, 0.0)]),
            CutSide::OnLine,
        );
        stroke.params.entry = EntryMode::Plunge;
        let a = plan_profile(&stroke, &machine, &stock);
        let b = plan_profile_with_edge_rule(&stroke, &machine, &stock, Some(&rule));
        assert_eq!(a.notes, b.notes, "the rule spoke about an on-line engrave");
        assert_eq!(a.path.moves.len(), b.path.moves.len());
    }

    #[test]
    fn corner_relief_and_a_skipped_edge_are_refused_together_rather_than_guessed() {
        // 🔴 A relief is placed at a corner of the WHOLE outline. A corner where
        // one of its two edges is not machined is not a corner this program
        // cuts, so the bore would relieve something that does not exist. That is
        // a piece of geometry nobody has written, and it is said rather than
        // approximated.
        //
        // A notch cut into the outline from the workpiece edge: the notch's
        // walls give the concave corners a relief fires on, and the outline's
        // bottom edge lies on the workpiece.
        let outline = Contour::closed(vec![
            Vertex::line(0.0, 0.0),
            Vertex::line(200.0, 0.0),
            Vertex::line(200.0, 120.0),
            Vertex::line(120.0, 120.0),
            Vertex::line(120.0, 60.0),
            Vertex::line(80.0, 60.0),
            Vertex::line(80.0, 120.0),
            Vertex::line(0.0, 120.0),
        ]);
        let mut o = op("notched", outline, CutSide::Outside);
        o.params.dogbone = DogboneStyle::Corner;
        o.params.entry = EntryMode::Plunge;

        // The positive control FIRST: without the rule this plans, and it plans
        // reliefs — otherwise the refusal below would be guarding nothing.
        let plain = plan_profile(&o, &Machine::default(), &Stock::default());
        assert!(plain.refusals.is_empty(), "{:?}", plain.refusals);
        assert!(
            plain.path.moves.iter().any(|m| m.kind == MoveKind::DrillCycle),
            "this drawing cuts no reliefs, so the refusal below proves nothing"
        );

        let r = plan_profile_with_edge_rule(
            &o,
            &Machine::default(),
            &Stock::default(),
            Some(&WorkpieceEdgeRule { tolerance_mm: 0.1 }),
        );
        assert_eq!(r.refusals.len(), 1, "{:?}", r.refusals);
        assert!(
            r.refusals[0].why.contains("corner relief") && r.refusals[0].why.contains("Turn one"),
            "the refusal does not say what to do: {}",
            r.refusals[0].why
        );
        assert!(r.path.moves.is_empty(), "a refused operation still planned moves");
    }

    #[test]
    fn an_outline_that_is_entirely_the_workpiece_edge_is_refused_not_planned_as_silence() {
        // 🔴 An operation that emits nothing reads in every report exactly like
        // an operation that had nothing to do. Four skipped edges means the part
        // is never separated from the workpiece at all, and that is a fact, not a
        // quiet program.
        let stock = Stock { size_x_mm: 200.0, size_y_mm: 120.0, ..Stock::default() };
        let mut o = op("blank", Contour::rect(0.0, 0.0, 200.0, 120.0), CutSide::Outside);
        // Plunge, because a ramp on an open path is refused by name and this
        // test is about a DIFFERENT refusal. A test that passes on the wrong
        // refusal is a test that stops guarding its own subject.
        o.params.entry = EntryMode::Plunge;
        let r = plan_profile_with_edge_rule(
            &o,
            &Machine::default(),
            &stock,
            Some(&WorkpieceEdgeRule { tolerance_mm: 0.1 }),
        );
        assert_eq!(r.refusals.len(), 1, "{:?}", r.refusals);
        assert!(r.refusals[0].why.contains("all 4 edges"), "{}", r.refusals[0].why);
        assert!(r.path.moves.is_empty());

        // Negative control: the same outline on a workpiece it does not touch
        // plans as it always did.
        let clear = plan_profile_with_edge_rule(
            &o,
            &Machine::default(),
            &Stock::default(),
            Some(&WorkpieceEdgeRule { tolerance_mm: 0.1 }),
        );
        assert!(clear.refusals.is_empty(), "{:?}", clear.refusals);
    }
}

/// Operations that mark a part with its own name.
///
/// Cut ON-LINE (the tool centre follows the stroke) at a shallow depth, with a
/// small cutter. 🔴 Marking runs BEFORE the outer profile for the same reason
/// every other interior feature does: once the outline is cut the part is loose,
/// and marking a loose part pushes it out from under the tool.
pub fn marking_ops(
    part: &Part,
    tool: &Tool,
    text_height_mm: f64,
    depth_mm: f64,
    base: &OperationParams,
) -> (Vec<Operation>, Vec<char>) {
    let unmappable = crate::engrave::unsupported_chars(&part.name);
    let Some((x0, y0, x1, y1)) = part.bounds() else {
        return (Vec::new(), unmappable);
    };
    let label: String = part.name.to_uppercase();
    let w = crate::engrave::text_width(&label, text_height_mm);
    // Centred horizontally, one text-height up from the bottom edge. If the mark
    // will not fit inside the part it is NOT placed: a mark that overruns the
    // outline is cut into the waste and lost with it.
    if w > (x1 - x0) * 0.9 || text_height_mm * 3.0 > (y1 - y0) {
        return (Vec::new(), unmappable);
    }
    let x = x0 + ((x1 - x0) - w) * 0.5;
    let y = y0 + text_height_mm;

    let ops = crate::engrave::text_contours(&label, x, y, text_height_mm)
        .into_iter()
        .enumerate()
        .map(|(i, c)| Operation {
            name: format!("{}-mark{}", part.name, i + 1),
            part: part.name.clone(),
            // 🔴 A MARK IS INTERIOR, and under the old name heuristic it was
            // not: `plate-mark1` contains neither `-hole` nor `-inner`, so every
            // engraved character was classified as an OUTER PROFILE — a
            // releasing cut. An engraved character removes a few tenths of a
            // millimetre and frees nothing.
            role: OpRole::Interior,
            contour: c,
            tool: tool.clone(),
            params: OperationParams {
                op_type: OpType::Engrave,
                side: CutSide::OnLine,
                depth_total_mm: depth_mm,
                depth_per_pass_mm: depth_mm,
                entry: EntryMode::Plunge,
                dogbone: DogboneStyle::None,
                tabs: TabSpec { enabled: false, ..TabSpec::default() },
                ..base.clone()
            },
        })
        .collect();
    (ops, unmappable)
}
