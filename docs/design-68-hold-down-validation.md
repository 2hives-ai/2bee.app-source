# Design — TODO #68: does the work holding actually HOLD the piece during the job?

Founder, 2026-08-10: *"validation: during the job the work holding holds down the
required peaces? is there a risk the workpeace will not be down correctly?"*

**This is a design memo. It changes no code, arms no gate and marks nothing ✅.**
Every claim about current behaviour below is cited to `file:line` and was read at
the source. **Nothing here was executed** — a gate run was likely in flight while
this was written and `cargo` and the gate share one `target/` lock — so where a
claim would need a run to confirm, the memo says so and states the one-line test
that would confirm it. A design memo that quietly asserts a measurement it did not
take is the same defect as a check that reads the plan instead of the program.

⚠ **EVERY `file:line` BELOW IS A 2026-08-10 READING AND MOST OF THEM NO LONGER
RESOLVE** (added 2026-08-27). `core/src/fixture.rs` was **~800 lines** when this
memo was written and is **4,124** today, so a citation here lands tens or hundreds
of lines from what it names — §1's *"all in `core/src/fixture.rs:154-181`"*, for
one, now points inside `Clamp`; the `FixtureFinding` enum it means starts at
`:374`. **Cite by SYMBOL when re-checking this memo, never by the numbers in it.**
Only the citations inside a dated ⚠/🔴 correction box were re-measured on
2026-08-27; the rest are left as written, because rewriting a memo's numbers in
place would erase the record of what was read at the time.

---

## 0. Read this first: the one thing that is already broken

> 🔴 **CORRECTED 2026-08-27 — THE HEADLINE SAFETY CLAIM IN THIS SECTION IS CLOSED,
> AND IT IS THE MOST EXPENSIVE STALE LINE IN THIS TREE TO LEAVE STANDING.** Read
> the correction before the section, because everything under it was written while
> the defect was live and is preserved as the record of a fixed defect, not as a
> description of the code.
>
> **What this section said:** *"the keepout check that exists today is blind to a
> cutter or a gantry that merely PASSES OVER a clamp. It only ever tests move END
> POINTS."* — and, in the boxed *Net effect*, that *"the machine will drive a Ø6
> cutter through a steel toggle clamp … and gate **P7** will pass"*.
>
> **What is true now:** `Fixturing::check` (`core/src/fixture.rs:489`) keeps a
> `cur: Option<Vec3>` cursor — the same shape `sim::simulate` uses — and asks each
> clamp about the **whole swept move**, not its destination. Straight moves go to
> [`Clamp::segment_span`] (`core/src/fixture.rs:186`), which clips the segment
> against the rotated rectangle by the slab method; arcs go to [`Clamp::arc_hit`]
> (`core/src/fixture.rs:242`), which tests the arc rather than its chord — the case
> where a 180° `G2` misses its own chord by the full radius. Both **clip rather than
> sample**, so the bound does not move with how finely the path happened to be
> emitted. The module header states the same thing at `core/src/fixture.rs:10-17`.
>
> **The direction of the staleness: UNDERSTATED COVERAGE.** This section denied a
> control that exists, in a *"Read this first"* block, about a cutter and a steel
> clamp. Nobody re-tests a blocker that names a reason, and a stale 🔴 is harder to
> find than a stale ✅ for exactly that reason.
>
> **How it was verified (2026-08-27, read at the source, nothing run):**
> `core/src/fixture.rs:489-620` for the cursor and the per-`MoveKind` dispatch;
> `:186` and `:242` for the two swept primitives; and the **15 tests** in
> `mod swept_segment_tests` (`core/src/fixture.rs:790`+), each of which **asserts
> its own vacuity first** — both endpoints clear of the clamp — so the suite cannot
> quietly decay back into an endpoint test. The one this section asked for by name
> is `a_cut_between_two_clear_endpoints_that_passes_through_a_clamp_is_found`; the
> arc case is `an_arc_that_bulges_into_a_clamp_is_found_where_its_chord_would_have_missed`;
> the paired negatives that stop a refuse-everything "fix" passing are
> `a_cut_that_passes_beside_a_clamp_is_not_flagged` and
> `a_rapid_that_clears_the_clamp_is_not_flagged_even_though_it_crosses_it`.
>
> **What is still NOT covered, and is not fixed by any of the above:** the cursor is
> `None` before the first positioning move, so a move with **no known origin** is
> still checked as a POINT, not as a segment. `core/src/fixture.rs:484-488` names
> this rather than papering over it — the first move of a program is a rapid to safe
> Z and the tool is wherever the last job left it. That one narrow case is the
> genuine residue of this section.
>
> **The `clearance_z` paragraph below is STILL TRUE** — see the second correction
> box, which fixes its line numbers and retires the claim it makes about a comment.

Before any of the four new checks: **the keepout check that exists today is blind
to a cutter or a gantry that merely PASSES OVER a clamp.** It only ever tests move
END POINTS.

```rust
// core/src/fixture.rs:231
for m in &path.moves {
    match m.kind {
        MoveKind::Feed | MoveKind::ArcCW | MoveKind::ArcCCW | MoveKind::DrillCycle => {
            for c in &self.clamps {
                if c.contains(m.to.x, m.to.y, tool_r) {          // fixture.rs:235
        MoveKind::Rapid => {
            for c in &self.clamps {
                if c.contains(m.to.x, m.to.y, tool_r) && m.to.z < clear_z {   // fixture.rs:246
```

`Move` carries **`to` and no `from`** (`core/src/types.rs:835-848`), and
`Clamp::contains` is called from exactly two places in the whole crate — those two
lines. Nothing walks the segment between two moves. So:

* a **feed** move along a 260 mm edge whose two endpoints are the part's corners,
  with a 40 × 40 cam clamp standing at the middle of that edge, produces
  **no `CutsClamp`**;
* a **rapid** linking two operations is a single move at `machine.safe_z_mm`
  (emitted at `core/src/toolpath.rs:430, 664, 691, 719, 800`), so a rapid that
  crosses over a 42 mm toggle clamp and lands clear of it produces
  **no `RapidBelowClamp`**.

Compare `core/src/sim.rs:189-224`, which does it correctly for material removal: it
keeps a `cur: Option<Vec3>` cursor and stamps along the segment at
`stamp_step_mm(cell_mm)`. **The simulation is segment-aware and the safety keepout
is not.**

Compounding it: **`Fixturing::clearance_z` has no consumer in the planner.** It is
called at `core/src/fixture.rs:229` (inside `check`, as the threshold `check`
compares against) and in tests at `:373, :381, :462-463, :734` — and nowhere else in
the repo. Every rapid is emitted at the bare `machine.safe_z_mm`, default **5 mm**
(`core/src/types.rs:474`). So the doc comment at `core/src/fixture.rs:165` —
*"`clearance_z` takes the TALLEST clamp and lifts every rapid above it"* — describes
something the code does not do, and `TODO.md:1897` repeats the same false sentence
in #65's clone warning. **A comment explaining why a control is right is the
least-audited thing in the repo**, and this one has now been copied.

> ⚠ **CORRECTED 2026-08-27 — the paragraph above is HALF right, and the two halves
> ran in opposite directions. Do not quote it without this box.**
>
> **STILL TRUE — `clearance_z` lifts nothing and has no consumer in the planner.**
> Re-verified 2026-08-27: the function is defined at `core/src/fixture.rs:456`, and
> its only callers in the whole crate are `Fixturing::check` at `:511` (as the
> comparison threshold) and this module's own tests (`:741`, `:751`, `:901`,
> `:1027`, `:1122-1123`, `:1394`). Nothing outside `core/src/fixture.rs` calls it —
> `core/src/toolpath.rs:1350` only *names* it, in a comment saying it has no
> consumer there. Every rapid the planner emits is still at bare
> `machine.safe_z_mm`, default **5.0** — and the line number moved: it is
> `core/src/types.rs:1169`, not `:474`.
>
> **NO LONGER TRUE — the doc comment is not false any more, and neither is its
> neighbour.** ⚠ **The line number `core/src/fixture.rs:165` no longer points at the
> comment this paragraph quotes**, and following it today lands on `Clamp::contains`.
> The two doc comments that carried *"lifts every rapid above it"* were both
> corrected on 2026-08-10, and both now carry their own retraction in place:
> `core/src/fixture.rs:412-428` (on `clearance_z`) opens *"🔴 **IT LIFTS NOTHING,
> AND UNTIL 2026-08-10 THIS FILE SAID IT DID**"*, and `:388-398` (on
> `FixtureFinding::ClampHeightUndeclared`) says *"REFUSES a rapid below it"* with an
> explicit ⚠ noting it read *"lifts every rapid above it"* until that date. So the
> follow-on claim here — *"the doc comment … describes something the code does not
> do"* — **is itself stale, and in the OVERSTATED direction**: it reports a live
> defect in `core/` that was closed seventeen days ago.
>
> **What is still NOT corrected, and is outside this document's lane to fix:** the
> false sentence really did propagate, exactly as the paragraph warns, and **two
> copies are still live** — `TODO.md:2033` (the line number in the paragraph above
> is also stale: it is `:2033`, not `:1897`) and `docs/bed-scan-contract.md:31`,
> which reads *"`Fixturing::clearance_z()` takes the tallest declared clamp and lifts
> every rapid"*. Both were re-measured 2026-08-27. Neither is edited here: `TODO.md`
> is held by another session and `bed-scan-contract.md` is a separate document with
> its own owner. **The three copies `web/src/workholding.ts` carried were fixed** —
> that file now opens with a measured correction at `:32-64` and carries the
> retraction into the operator-facing strings at `:364`, `:399` and `:643`.

> **Net effect, stated plainly:** with clamps correctly declared, correctly turned
> and correctly measured, the machine will drive a Ø6 cutter through a steel toggle
> clamp, or a gantry over it at 5 mm, and gate **P7** will pass — provided the move
> that does it starts and finishes somewhere else. This is not a hold-down question;
> it is the keepout gate being narrower than its own name.

**The one-line test that would prove it** (a unit test in `fixture.rs`, not run
here):

```rust
let f = Fixturing { clamps: vec![Clamp::new("cam", 120.0, 40.0, 40.0, 40.0, 35.0)], confirmed_clear: false };
let p = path_of(vec![Move::feed_to(Vec3::new(0.0, 60.0, -5.0), 1000.0),
                     Move::feed_to(Vec3::new(260.0, 60.0, -5.0), 1000.0)]);
assert!(!f.check(&p, 3.0, 18.0, &Machine::default()).is_empty()); // expected to FAIL today
```

> ⚠ **CORRECTED 2026-08-27 — the comment on the last line is the stale part.** That
> test was written and it PASSES. It landed as
> `a_cut_between_two_clear_endpoints_that_passes_through_a_clamp_is_found`
> (`core/src/fixture.rs`, `mod swept_segment_tests` at `:790`+), with the two
> endpoints asserted clear of the clamp first so the plant cannot become vacuous —
> the thing the sketch above does not do. Read the landed test, not this sketch.

**Fix shape** (core work — this memo does not own the edit, and a live agent holds
`core/**`): give `check` the same cursor `sim::simulate` has, and test the SEGMENT
against the rotated rectangle — either analytically or by sampling at
`stamp_step_mm`, which keeps one stated precision instead of two. Then either make
the planner consume `clearance_z`, or correct the two comments that say it does.
**Both need their own TODO entry; this memo is the only record until they get one.**

> ⚠ **CORRECTED 2026-08-27 — two of the three items in this "Fix shape" are DONE,
> and it matters which.** (1) The cursor and the segment test landed, and they went
> **further than this memo proposed**: `Clamp::segment_span` and `Clamp::arc_hit`
> **clip** rather than sample at `stamp_step_mm`, so the safety bound does not
> inherit the emitted path's block rate — a stronger property than the one asked for
> here. (2) The two comments that said `clearance_z` lifts a rapid **were
> corrected** (see the box above). (3) **The planner still does NOT consume
> `clearance_z`, and that is the live item** — deliberately, per
> `core/src/toolpath.rs:1350-1364`, which says a lift would have to land at all five
> `safe_z_mm` sites in that file **and** at the post's own `G0 Z` retracts or the
> plan and the emitted program would disagree about how high the machine flies.

Everything below assumes that fix. **A restraint check written on endpoints
inherits the identical blindness**, and it would inherit it in the direction that
reads as *held*.

> ⚠ **2026-08-27:** the assumption in the sentence above is now satisfied for the
> keepout — but the warning it carries has not expired, and is the reason this
> paragraph is kept rather than deleted. **The four restraint checks this memo
> designs are still unbuilt**, and any of them written on move endpoints would
> reintroduce the identical blindness, in the direction that reads as *held*.
> `Fixturing::check` being segment-aware buys a restraint check nothing.

---

## 1. What exists today, measured

Four findings, all in `core/src/fixture.rs:154-181`:

| finding | line | what it answers |
|---|---|---|
| `CutsClamp` | `:157` | the cutter goes THROUGH a clamp (endpoint only — §0) |
| `RapidBelowClamp` | `:159` | a rapid ends BELOW a clamp's top (endpoint only — §0) |
| `Undeclared` | `:161` | nobody declared any work holding at all |
| `ClampHeightUndeclared` | `:180` | nobody measured a clamp's height |

Every one asks *"does the toolpath hit the clamp?"* The restraint rules that exist
are elsewhere and are about the **part**, never the **sheet**:

* `auto_tabs` (`core/src/toolpath.rs:110-124`) — ≥2 tabs on every closed profile,
  *"one tab lets the part pivot"*; gate **P1**.
* `verify_interior_before_outer` (`core/src/optimise.rs:1038-1076`) — a part worked
  on after the operation that released it is a **refusal**; gate **REL**
  (`gates/slicer_gate_check.mjs:115, 2086+`).

And the model itself has no restraint vocabulary:

* `Clamp` is `{name, x, y, w, h, height_mm, rotation_deg}`
  (`core/src/fixture.rs:15-58`) — geometry to avoid, nothing else.
* `ClampCfg` (`core/src/fixtures.rs:1265-1290`) mirrors exactly those fields, under
  `#[serde(deny_unknown_fields)]` at `:1266`.
* `web/src/workholding.ts:73` already carries `resists: ('lift' | 'lateral')[]` per
  catalogue entry, and its own header at `:39-46` says **the field is consumed by
  nothing**. `docs/workholding-research.md:468-477` calls this *"the single most
  important gap this research found"*: `Fixturing` cannot tell a fence from a toggle
  clamp, so it will bless a side-pressure setup whose finishing pass is a full-depth
  profile with an upcut cutter.

⇒ The founder is asking the question the fixture module does not ask, and the
research pass had already written down that it does not ask it.

### 1.1 The headline that already reads as "it will hold"

`JobResult::is_runnable` (`core/src/job.rs:491-497`) treats every fixture finding as
fatal **except `Undeclared`**. The browser filters `Undeclared` out of the
"This program will not be produced" list (`web/src/App.tsx:4358-4361`) and renders
`Status: runnable` in the `ok` class. The warning is not silent — it appears in
*Notes and warnings* (`web/src/App.tsx:4419-4423`) — but it appears as one line
among every other note, under a green badge.

So **today, a job with zero declared work holding posts G-code and reads
`runnable`.** That is the `colony_health_band` shape (a constant rendered as a
measurement) already present, before #68 adds anything. Whatever #68 builds must
not add a second, more convincing one.

---

## 2. The line between computable and invented

**Computable, from geometry and program order:** where the clamps are, what
material is gone and when, what is still joined to what, and which regions carry a
clamp. All four checks below live entirely inside that.

**NOT computable, and it must be said rather than guessed:** whether the clamping
force is enough. That needs clamp preload, the friction coefficient of the pair,
cutting force from engagement × feed × material, and vibration. **None of them is
in this tool and none may be invented.**

This is not a hypothetical risk in this lane:

* `max_doc_ratio` was once sourced to the wrong machine (`TODO.md`, #38 /
  `docs/decision-38-doc-ratio-recommendation.md`) — and that was only a multiplier.
* `docs/workholding-research.md:517` records that **no vacuum vendor publishes a
  holding force at all**, at any vacuum level — *"Every mechanical clamp in this
  catalogue has a force figure and no vacuum entry has one"*. So even the sourced
  half of the catalogue cannot be completed for the most common shop hold-down.
* `docs/workholding-research.md` (the "could not be sourced" table) further records
  **no published shear/lift figures for tape or tape+CA on plywood**, either pass.

A fabricated hold-down force is a safety number with no source at all, and it would
be the first number in this tool that a person would stand next to a spindle
because of.

### 2.1 The reporting rule, which matters more than the checks

The report type carries the refusal as **data**, in the shape
`optimise::TravelBasis` already uses (`core/src/optimise.rs:126-152`: fields that
are *always* `false`/`true` and say why):

```rust
pub struct HoldDownBasis {
    /// Always false. This tool has no clamp preload, no friction coefficient,
    /// no cutting-force model and no vibration model. It never will until
    /// somebody measures them; see docs/workholding-research.md.
    pub force_checked: bool,
    /// Always false. Contact area is taken as the DECLARED FOOTPRINT. No
    /// catalogue entry publishes a bearing-pad dimension (web/src/workholding.ts
    /// has `footprintMm`, and nothing smaller), so the held area is an
    /// over-estimate of the truth by an unknown amount.
    pub contact_area_measured: bool,
    /// Checks that could not run on this job, each naming why. A check that
    /// cannot run reports PENDING, never PASS.
    pub pending: Vec<String>,
}
```

Three hard rules for whoever writes the surface:

1. **Never render "no hold-down problem found".** The true sentence is *"the
   geometry and ordering checks passed; HOLDING FORCE IS UNCHECKED"*, and both
   halves ship together or neither does.
2. **`force_checked: false` prints on every job, including a clean one.** A caveat
   that appears only when something else is wrong is a caveat nobody sees on the day
   it matters.
3. 🔴 **Zero declared clamps must make all four checks PENDING, not clean.** Every
   algorithm below is trivially satisfiable by an empty clamp list — "no clamp
   stands on removed material" is *true* when there are no clamps. This is
   `Undeclared` / `E5` one level along, and it is the single most likely way this
   feature ships a false green. The guard belongs at the top of the entry point,
   not in each check.

---

## 3. The shared machinery all four checks need

Nothing below needs a new geometry engine. It needs one thing the core does not
have today: **material state indexed by program position.**

### 3.1 The severance map

`sim::HeightMap` (`core/src/sim.rs:60-88`) already models removal correctly, is
already anchored to the placed sheet (`core/src/fixtures.rs:2878-2891`, using
`Job::place` so the operator's drag is included — the defect its header records at
`sim.rs:73-88`), and already walks segments (`sim.rs:189-224`). `HeightMap::stamp`
(`sim.rs:104`) only ever **lowers** a cell — *"material does not come back"*.

That monotonicity is the whole design: **one forward pass produces the answer for
every program position.** Walk the moves once, and for each cell record the
**operation index at which it first went through-depth**:

```
severed_at[cell] : Option<usize>     // op index, None = still standing
through-depth    : z <= -(stock.thickness_mm)  (toolpath.rs:410 caps cut depth at
                                                thickness + 0.3, so a through cut
                                                really does reach it)
```

No O(n²) replay, no second simulator, no second copy of a safety check. The
operation boundaries are already known — the emitted program marks them
(`gates/slicer_gate_check.mjs:2124-2128` parses `( op: NAME [TOOL] )` headers), and
the planner knows them directly.

### 3.2 🔴 The error direction is the OPPOSITE of `sim::check`'s

`core/src/sim.rs:24-27` states the table this lane learned the hard way:

| error | `Gouge` | `Uncut` |
|---|---|---|
| over-report removal | false alarm — safe | island reads as cleared — **MISSED** |
| under-report removal | gouge reads as untouched — **MISSED** | false alarm — safe |

Add the restraint column, because it is a third question and it does not share an
answer with either:

| error | **restraint** |
|---|---|
| over-report removal | material reads as gone ⇒ restraint reads as LOST — false alarm, **safe** |
| under-report removal | material reads as standing ⇒ restraint reads as PRESENT — **MISSED** |

The sim as built is an **inner** approximation: it can miss removal in a sliver at
the very edge of a cut, bounded by `edge_miss_mm` (`sim.rs:259`) — 0.0038 mm at the
default 0.6 mm cell. **That is the unsafe direction for restraint.** And
`sim::check` **shrinks** its regions by one cell (`sim.rs:453`) — correct for its
question, wrong for this one.

⇒ The restraint pass must **dilate the severed set by one cell** before asking any
connectivity question, and must assert that it does. State the consequence in the
same breath: a surviving bridge of material narrower than ~2 cells then reads as
severed (1.2 mm at the default cell), which is a **false red** — cheaper than the
alternative, and it is bounded, printed, and it errs toward refusing.

### 3.3 Kerf resolution — where the check must say PENDING

Connectivity over cells cannot see a cut narrower than a cell: two regions
separated by such a kerf read as **still joined**, which is a false green on
findings 1 and 3. The narrowest kerf in a job is `2 × min(tool_r)`, and each move
carries its own radius (`Move::tool_r_mm`, `types.rs:847-855`).

⇒ If `2 × min_tool_r < 3 × cell_mm`, the connectivity result is **UNRESOLVED**, not
"connected". It goes in `HoldDownBasis::pending` naming both numbers. The fix
available to the operator is a finer cell, and the report should say so — an
unrunnable check that names its own remedy is the difference between PENDING and a
dead row.

### 3.4 Clamp contact cells — and a sign flip that matters

The contact set of a clamp is the map cells whose centre satisfies
`Clamp::contains(px, py, 0.0)` (`core/src/fixture.rs:127-133`).

🔴 **Margin `0.0`, never `tool_r`.** `check` passes `tool_r` at `:235` and `:246`
because widening a keepout is conservative *for avoidance*. Widening it here would
**overstate the held area** — the unsafe direction. And the honest margin would be
*negative*: a toggle clamp bears on a pad smaller than its outline, and no
catalogue entry publishes that pad (`web/src/workholding.ts` has `footprintMm` and
nothing finer). A negative margin nobody sourced is exactly the invented number §2
forbids, so the assumption is declared in `HoldDownBasis::contact_area_measured =
false` and left visible instead.

`contains` takes the point into the clamp's own frame, so a **rotated** clamp costs
no accuracy (`fixture.rs:118-133`) — see §7.

### 3.5 Part attribution, reused not rebuilt

`optimise::attribute` (`core/src/optimise.rs:362-436`) already answers "which
operation belongs to which part", keyed on `CutSide::Outside` rather than on a
naming convention, and already emits it as a `route-parts:` line
(`optimise.rs:777-792`). Finding 2 consumes that line. It also inherits its
**named** blind spot (`optimise.rs:349-361`): a small part freed by a *larger*
part's hole is released by a `CutSide::Inside` cut and is invisible to the
classifier. Finding 3, which is pure connectivity and knows nothing about parts, is
the check that can still see that one — which is the argument for building both
rather than either.

---

## 4. The four checks

Common shape: each names the physical failure, the algorithm, the data it needs
that the core does not have, the finding it emits, its severity, and the negative
control that would prove it. Severity is split deliberately — **a check that goes
red on every real job gets muted within a week** (`fixture.rs:326-336` already says
so about its own negative control).

### #1 — A clamp standing on material a LATER operation removes

**Physical failure.** The clamp is declared, measured, correctly placed and
correctly turned. Operation 7 cuts the region it bears on. From operation 8 the
clamp holds an offcut or nothing, and the operator has no way to know: the setup
sheet, the picture and the keepout check all still show a clamp holding the work.
**Nothing checks this today** — `Fixturing::check` has no notion of program order at
all; it is handed the whole assembled path at once (`core/src/job.rs:1281-1285`).

**Algorithm.**

```
for each clamp C:
    contact = { cells under C }                      (§3.4)
    if contact ∩ sheet == ∅:  note "C bears on no sheet cell" ; continue
    for each operation boundary k, in PROGRAM ORDER:
        live   = { c ∈ contact : severed_at[c] is None or >= k }   (dilated, §3.2)
        if live == ∅                      -> LOST ENTIRELY at k
        else if |live| < |contact|        -> PARTIAL at k, report the fraction
        comp(C,k) = connected components (of not-yet-severed cells) touching `live`
    for each part P worked on after k:
        if comp(P,k) ∩ comp(C,k) == ∅     -> C no longer holds P at k
```

**Data it needs that the core does not have.** The severance map (§3.1) and the
operation boundary indices. Both derive from things that already exist; neither is a
new input from the user.

**Findings.**

* `ClampContactLost { clamp, at_operation }` — no live contact cell remains.
  **Refusal.** After that operation the declared restraint is a fiction, and
  `is_runnable()` must be false (`job.rs:491-497`).
* `ClampHoldsDetachedMaterial { clamp, at_operation, part }` — contact survives but
  is no longer in the same connected region as a part still being worked.
  **Refusal**, same reasoning.
* `ClampContactReduced { clamp, at_operation, fraction_remaining }` — **note, not a
  refusal.** A pressure bar spanning the sheet legitimately loses contact area over
  a cut-out and still holds. Refusing this would be the false red that gets the
  whole family muted, and there is no sourced threshold at which partial becomes
  fatal — so the fraction is reported and not graded.

**Negative control.** New `JobPlant::ClampOnOffcut` (`core/src/fixtures.rs:28+`).
🔴 It must place the clamp on material a later profile removes **while staying clear
of every toolpath**, or `CutsClamp` fires first and the new finding is never the
thing being observed. Following `GroupOrder`'s pattern (`optimise.rs:517-541`), the
plant must also **state whether it changed anything on this job** — the
`PLANT_DIFFERENCE_KEY: YES/NO` idiom — because a plant driven on a job whose clamps
happen to sit on material nothing removes runs clean and reads as a passing control.
The gate limb asserts the **VERDICT** line
(`gates/slicer_gate_check.mjs:4026`), not the finding's own message.

**What it cannot see.** Material removed by anything that is not a cutting move
(the part lifting, a wedge dropping out and taking the bearing surface with it), and
any clamp whose declared footprint is not where the hardware actually is.

---

### #2 — A part freed before the program ends

**Physical failure.** P1 proves tabs *exist* (`toolpath.rs:110-124`, gate P1). REL
proves a part is not worked on after its own release *within the emitted order*
(`optimise.rs:1038-1076`, gate REL). Neither asks the founder's question, which is
about the **whole remaining program**: a part hanging on nothing while the spindle
runs for another twenty minutes and rapids cross over it.

**The refinement that makes this a different check from REL.** REL's release event
is *"the outer profile was cut"* (`optimise.rs:1051-1057`, keyed on
`CutSide::Outside`). With tabs on, cutting the outline does **not** free the part —
the tabs are left standing and are removed by hand afterwards. The real release
event is *"the last material joining this part to a restrained region was severed"*,
and the severance map gives that for free: **a tab is simply a bridge of un-severed
cells**, because `toolpath.rs:502-554` raises Z inside a tab window
(`(z + tab_height).min(0.0)`) so those cells never reach through-depth. **No new tab
bookkeeping is required** — which is the reason to build this on the map rather than
on `TabAt` (`toolpath.rs:105-108`), whose placed positions are computed inside the
generator loop (`toolpath.rs:426`) and never stored.

**Algorithm.**

```
freed_at(P) = min k such that comp(P, k) contains no clamp contact cell
              and is not connected to any region that does
ops_after   = last_op_index - freed_at(P)
later_cuts  = cutting moves after freed_at(P) whose swept region ∩ comp(P) ≠ ∅
later_rapids= rapid moves after freed_at(P) crossing over comp(P)   (needs §0's fix)
```

**Data it needs.** The severance map, the operation boundaries, and the part map
already on the `route-parts:` line (`optimise.rs:777-792`). The rapid limb
additionally needs the **segment-aware** move walk from §0 — until that lands, the
rapid limb reports PENDING rather than zero. *Zero rapids over a freed part,
computed by an endpoint test, is a number with no meaning.*

**Findings.**

* `PartMachinedAfterRelease { part, freed_at, operation }` — a later cut enters an
  unrestrained region. **Refusal.** This is P1's physical failure arriving through
  ordering, the same sentence gate REL's row already uses
  (`gates/slicer_gate_check.mjs:115`).
* `PartFreeWhileProgramContinues { part, freed_at, ops_remaining, rapids_over }` —
  **note with numbers.** A tab-free drop-out is a legitimate thing to do; `job.rs`
  already names it (`:1244`). What the operator can act on is *"part 3 of 6 is free
  after operation 4 of 19, and 7 rapids cross over it"*, so that is what is printed.
  Grading it would need a threshold nobody sourced.

**Negative control.** The existing `JobPlant::NoTabs` (`core/src/fixtures.rs:30-31`)
already frees a part immediately. 🔴 The gate limb must assert that operations
**remain** after the release on the chosen fixture, and that the clean run of the
same fixture reports *no* release — otherwise it is a control for "tabs are off",
which P1 already owns. Per gate **PLANT**'s row
(`gates/slicer_gate_check.mjs:105`), a plant consumed by no gate, or inert on its
target, is decoration.

**What it cannot see.** A part released by a hand operation between phases (#42), a
part restrained by friction alone against a fence (`resists: ['lateral']`, which the
core cannot represent — §5), and any part whose attribution `optimise::attribute`
could not make (`optimise.rs:426-431` returns `None`, which pins the operation and
must here mean **PENDING**, never "held").

---

### #3 — A sheet region separated by a through-cut, with no clamp and no tabs

**Physical failure.** Loose material beside a spinning cutter. Not a part — a
sheet offcut, a waste centre, a drop from a cut-out — free to slide, be caught by
the cutter, and be thrown. This is the one finding that is not about parts at all,
and it is the one that can catch what `CutSide::Outside` cannot (§3.5).

**Algorithm.** A connectivity question over the map, evaluated at each operation
boundary:

```
at boundary k:
    standing = { cells not severed at k }              (dilated, §3.2)
    comps    = connected components of `standing`      (4-connectivity)
    for each comp R:
        held      = R contains ≥1 clamp contact cell
        anchored  = R touches the sheet edge under a clamp that reaches over it
        worked    = a cutting move after k enters R
        if !held && !anchored && worked  -> REFUSAL
        if !held && !anchored && !worked -> NOTE (area, bbox, when it separated)
```

4-connectivity, not 8: a diagonal cell contact is not a bridge of material, and
counting it as one reads as *held*.

**Data it needs.** The severance map, the clamp contact sets, and the sheet
footprint — `Stock::place` of the four corners, as `simulate_and_check` already
computes at `core/src/fixtures.rs:2882-2890` (both opposite corners, because a
quarter turn changes which corner is lowest).

**Findings.**

* `UnrestrainedRegionMachined { at_operation, area_mm2, bbox }` — **refusal.** You
  are machining a piece nothing is holding.
* `UnrestrainedRegion { at_operation, area_mm2, bbox }` — **note.** It may be a
  deliberate drop-out. The note names the area and when it separated so an operator
  can decide; the tool does not decide for them.

**Negative control.** New `JobPlant::LooseOffcut` — a drawing whose first operation
severs a large region carrying no clamp, with cutting work scheduled afterwards. The
clean control is the same drawing with the clamp set that does hold it: **both arms
required**, because a check that reports every offcut is indistinguishable from a
working one until the day somebody cuts two parts from one sheet
(gate MULTI's row makes the identical argument,
`gates/slicer_gate_check.mjs:102`).

**What it cannot see.** Anything at or below the cell resolution (§3.3 — it says
PENDING there rather than "connected"), material held by tape or vacuum under the
region (`obstructs: false` is at least three different facts,
`web/src/workholding.ts:31-37` and `docs/workholding-research.md:478-481`), and
whether a region that *is* free will actually move.

---

### #4 — Clamps all along one edge

**Physical failure.** The sheet pivots or lifts about the clamped edge. This is a
statement an operator can act on in ten seconds, which is why it is worth computing
even though it grades nothing.

**Algorithm — geometric facts only, no thresholds.**

```
contacts   = union of clamp contact cells (or the four Clamp::corners of each clamp)
hull       = convex hull of `contacts`
collinear  = hull area < (perimeter × cell_mm)      // degenerate: contacts on a line
for each standing region R at each boundary k:
    centroid_inside = area centroid of R ∈ hull
span per sheet edge = length of that edge covered by a clamp footprint
```

Every one of those is a geometric predicate. **No percentage, no "clamps within 20%
of an edge", no rule of thumb** — the moment a threshold appears, it is an invented
number wearing an engineering face.

**Findings — all notes, never refusals.**

* `ClampContactsCollinear { axis, span_mm }` — *"all 4 clamp contacts lie on one
  line along the X edge, over a 540 mm span; the sheet is unrestrained against
  rotation about it."*
* `RegionCentroidOutsideClampHull { region, at_operation }` — *"after operation 6
  the area centroid of the 380 × 210 mm region lies outside the polygon of clamp
  contacts."*
* `EdgeRestraintSpan { edge, covered_mm, total_mm }` per sheet edge, always printed.

🔴 **Say what these are not.** "Centroid inside the support polygon" is a *geometric*
statement. It is not a stability calculation: it assumes nothing about cutting
force, friction, or vibration, and a job can pass it and still throw a part. The
finding text must carry that clause, because it is exactly the sentence a reader
will otherwise promote to a verdict.

**Negative control.** Two jobs from the same drawing: clamps on one edge (assert the
collinearity finding present) and clamps on two opposing edges (assert it absent).
A report's control asserts the text **appeared and disappeared** — the same
liveness argument the `presentKinds` work used in #68's sibling item
(`TODO.md:2062-2072`): "no finding" and "the check did not run" are different states
and only one of them is clean.

---

## 5. What the model still cannot express, and what it would take

Named here rather than absorbed, because an omission that is not written down
becomes a capability claim by default.

| missing | what it costs | what would close it |
|---|---|---|
| **`resists: lift \| lateral`** on the core `Clamp` | A fence and a toggle clamp are the same object to `Fixturing`. All four checks above will happily treat a side-pressure cam as restraint against LIFT, which is the failure mode of a full-depth pass with an upcut cutter. The field already exists in the catalogue (`web/src/workholding.ts:73`) and is consumed by nothing (`:39-46`). | Carry it through `ClampCfg` (`fixtures.rs:1265-1290`, note `deny_unknown_fields` at `:1266` — the catalogue's value cannot even be *passed* today) into `Clamp`, and make every finding above state which direction it is talking about. **This is the prerequisite the research pass already identified** (`docs/workholding-research.md:468-477`). |
| **Holding force** | §2. Unclosable from published data for vacuum at all. | Not this lane's to close. `force_checked: false`, permanently, until measured. |
| **Bearing pad vs footprint** | §3.4 — the held area is over-estimated by an unknown amount. | A `padMm` per catalogue entry, sourced. Several vendors publish none. |
| **Vacuum, tape, dog-holes** | Restraint with **no footprint at all**: `footprintMm: [0, 0]`, `obstructs: false`. A vacuum table holds everything and contributes zero contact cells, so #1/#3/#4 would report the whole sheet unrestrained — a **false red on the most common shop setup**. | A restraint that is an AREA rather than an obstruction: a `holds` region distinct from the keepout. Until then, a job whose fixturing declares zero-footprint restraint must put all four checks in `pending`, not run them. 🔴 **This is not optional; it is the difference between a useful check and one muted in week one.** |
| **Usable inset** | `docs/workholding-research.md:485-490` — the clamped sheet is smaller than the nested sheet and nothing says so. | `usableInsetMm` per entry. Noted there, not invented. |

---

## 6. Interaction with #42 — a work-holding change as a program PHASE

`TODO.md:1030-1077`. #42 splits the program into phases with a declared, ordered
sequence of clamp STATES (founder refinement, `TODO.md:1061-1074`): phase 0 holds
{A,B,C}, phase 1 holds {A,B,D}.

**A phase split gives restraint a TIME AXIS, and #68 is the predicate that axis
needs.** #42 states the requirement as prose — *"a sequence that ever drops below
the required restraint is refused"* — and **there is no definition of "the required
restraint" anywhere in the tool.** The four checks above are that definition. So:

* **#42 is blocked on #68**, not the other way round. Without a restraint predicate,
  a declared clamping sequence is a comment; with one, "does phase b hold?" is a
  function call.
* The severance map is already indexed by operation, so a phase boundary is just a
  distinguished operation index. `Fixturing` becomes per-phase, and every check runs
  **three times per boundary**, which is exactly the property #42 says must hold:
  * **before** the move — with clamp set `S_b`, over the material state at `b`;
  * **during** — with `S_b ∩ S_{b+1}`, which is the machine-checkable form of *"new
    clamp on before old clamp off"*. If that intersection fails the restraint
    predicate, the sequence is refused rather than described in a comment nobody has
    to read;
  * **after** — with `S_{b+1}`, over the same material state.
* 🔴 **The "during" evaluation is the one that cannot be skipped, and it is the one a
  naive implementation will skip**, because before-and-after both look fine on a
  swap that is momentarily empty. `TODO.md:1051-1055` already says why WHEN matters
  most: the part is progressively less attached as the program runs, so a clamp
  released near the end may be holding a part that by then hangs on tabs only —
  which is precisely `freed_at(P)` from check #2.
* Out of #68's scope and staying there: the **datum** going unknown across an `M0`
  (`TODO.md:1046-1048`), and the operator procedure, which needs **ops** and cannot
  be self-certified in this lane (`TODO.md:1076-1077`).

---

## 7. Interaction with #57 / #65 — a clamp footprint is a rotated polygon

`Clamp::rotation_deg` landed (`core/src/fixture.rs:57`); `corners()` at `:108-114`
is the single source both `contains()` (`:127`) and `contour()` (`:140`) come from,
and gate **P7R** (`gates/slicer_gate_check.mjs:98`) proves the picture and the check
are one number. #65 (`TODO.md:1871+`) adds the operator's way to set it.

Consequences for everything above, in one line: **no check may touch `(x, y, w, h)`
as an axis-aligned box.**

* Contact cells come from `Clamp::contains(px, py, 0.0)` (§3.4), which takes the
  point into the clamp's own frame — a free angle costs no accuracy
  (`fixture.rs:118-126`).
* The convex hull in check #4 is built from `Clamp::corners()`, not from bounding
  boxes. Using bboxes would **overstate** the hull, i.e. report a support polygon
  larger than the clamps provide — the unsafe direction, and the same
  bounding-box-instead-of-clamp trap `fixture.rs:575-609` already plants a test
  against (the first version of which was **vacuous** and only found so by planting).
* Any new negative control must therefore include a **turned** clamp case whose
  answer differs from its axis-aligned box, on the pattern of
  `a_cut_that_clears_the_axis_aligned_box_but_hits_the_rotated_clamp_is_found`
  (`fixture.rs:540-558`) **and** its mirror at `:575-609`. One direction alone
  passes with a bbox keepout.
* #65's clone hazard (`TODO.md:1893-1900`) is *not* a restraint hazard: a clone that
  drops `height_mm` still declares a correct footprint, so checks #1/#3/#4 are
  unaffected and `ClampHeightUndeclared` still fires for the rapid-clearance
  question. Worth saying out loud so nobody "fixes" restraint by keying it on
  height.

---

## 8. Build order, and what "done" would mean

1. **§0 first, as its own item.** Segment-aware `Fixturing::check`, and either a
   consumer for `clearance_z` or a correction to the two comments claiming it has
   one. Building restraint on top of an endpoint test would reproduce the same
   blindness in the direction that reads as *held*. **This needs a TODO entry it
   does not have.**
2. **`resists` through to the core `Clamp`** (§5, row 1), plus the zero-footprint
   restraint case (§5, row 5). Without the second, the checks are a false red on
   every vacuum table.
3. The severance map (§3.1) with its dilation assertion (§3.2) and its kerf PENDING
   rule (§3.3). Assert the direction with a test that would go red if somebody
   "tidied" the dilation away — the shape of
   `a_zero_height_clamp_buys_no_clearance_at_all` (`fixture.rs:452-472`), which pins
   the arithmetic so the finding cannot be deleted and the maths left behind.
4. Checks in order **#1, #3, #2, #4** — sharpest first, and #3 shares all of #1's
   machinery.
5. One gate, proposed id **`HOLD`**, one row in `GATES` (`slicer_gate_check.mjs:75+`)
   naming the physical failure, with a limb per finding, each asserting the
   **VERDICT** line and each driven by a plant that states whether it changed
   anything.
6. `HoldDownBasis` (§2.1) rendered on every job, clean or not.

**"Done" is not "the checks pass."** Done is: the four findings exist, each has been
**watched going red** under its own plant, the force line reads UNCHECKED on every
job including the clean ones, and a job with no declared work holding reports
PENDING rather than clean. And even then, the honest status is *"the geometry and
the ordering were checked"* — because **nothing this lane has emitted has ever cut
anything** (`AGENTS.md:73-77`), the air-cut / coupon / ply rungs are unclimbed, and
no hold-down claim survives contact with a real bed until **ops** has run one.

*The standing test: would you stand next to the machine while this program runs?
For hold-down the answer is not yes and not no — it is "the tool checked the four
things it can check, and did not check the force." Anything that renders as a
single green badge is lying about which of those it means.*
