# Design #87 — Z0 at the workpiece bottom (the spoilboard's top face)

**Founder ruling, 2026-08-11, verbatim: *"0Z should be on the bottom of the workpiece, top of the
spoilboard"*.**

**Status: DESIGN ONLY. No code in this change.** Every file it reaches is held by another agent, and
that constraint is doing real work here: this is not a sign flip, and writing the reach down before
anyone edits is the only way to find out that the capability already half exists, that one of its two
halves is wired to a control the browser cannot reach, and that the single most dangerous consumer
fails **silently in the direction that says a loose part is held**.

---

## 0. What this document is, and what it deliberately does not do

It **enumerates** the reach, **names one function** that must own the answer, **sequences** the work
so that no intermediate state can emit a half-framed program, and **specifies the gate** with its
negative control.

It does **not** choose the probing story. That is one founder decision and §3 states the options with
their costs rather than picking quietly. Everything downstream of §3 is written so that both answers
fit the same structure — the decision changes one number in one emitter, not the design.

---

## 1. Three corrections to #87 as filed

The ticket says it was written from a grep and one reading. Three of its claims do not survive
measurement, and one of them changes the shape of the work.

### 1a. 🔴 The capability is NOT missing

**The finding, in full: it exists, it is asserted by a gate, and the browser cannot reach it.**

#87 says *"every emitted program is still Z0-at-top"*. That is true of the browser and false of the
CLI. `cli/src/main.rs:1121` reads a `--spoilboard-zero` flag and sets
`PostOptions::z_offset_mm = stock.thickness_mm`; `core/src/post_grblhal.rs:20` adds that number to
every emitted Z word. Measured just now, at the emitted program, on the shipped binary:

```
$ ./target/release/2bee-slice fixture rect-profile
G0 Z5.000
G1 Z0.000 F300.0
G1 X67.000 Z-3.000 F3600.0
… deepest Z-18.000

$ ./target/release/2bee-slice fixture rect-profile --spoilboard-zero
G0 Z23.000
G1 Z18.000 F300.0
G1 X67.000 Z15.000 F3600.0
… deepest Z0.000
```

**The through-cut lands at exactly `Z0.000`** — which is the entire benefit the founder is asking
for, already emitted, today. And gate **`G11`** (`gates/slicer_gate_check.mjs:768-786`) already
asserts it *on the emitted text*: every Z word in the two programs must differ by exactly one stock
thickness. `FUNCTIONAL-SPEC.md:204` row **B3** carries a ✅ for it.

⇒ So the work is **not** "build a Z frame". It is: **two halves were built apart and never joined.**

| Half | Where | Reaches the program? |
|---|---|---|
| `Stock::z_zero_at_top: bool` (`core/src/types.rs:1063`, default `true` at `:1084`) | browser sends it, `StockCfg` carries it (`core/src/fixtures.rs:1389`, applied at `:1616`) | 🔴 **No.** Its only reader is `core/src/fixture.rs:2534`, a warning that says it has no readers. |
| `PostOptions::z_offset_mm` | CLI `--spoilboard-zero`, `fixture` subcommand only | ✅ **Yes**, and G11 proves it. |

⚠ **And the ✅ on spec row B3 is misleading in the way that matters.** An operator reading it
believes the app's setting bites. It bites **only** through the `fixture` subcommand, which is not a
route the browser or the `report`/`job` paths have. `wasm/src/lib.rs` exposes no `PostOptions` at
all; `JobConfig` (`core/src/fixtures.rs:1129-1181`) has **no `post` section**, so no config file can
reach one; and `Job::post` is `PostOptions::default()` (`core/src/job.rs:124`), which every other
emitter takes — `run_job` builds `PostOptions { program_name, ..default() }` and never reads the
flag. That row should read: *the
CLI's flag bites; the setting does not.*

**This is a worse state than #87 describes, not a better one.** A setting that does nothing is
gate `G11`'s class. Two controls answering the same question, only one of which works, is the class
above it — because the day someone wires the dead one, there are two live answers and nothing
reconciles them. §4.1 kills that structurally rather than by discipline.

### 1b. #85 has LANDED. It is not a blocker.

#87 says the probe emitter *"must land first"*. It did — commit `74685f688a`, *"the Z probe now
seeks a distance, because that is what the number is"*. Verified at the emitter, not at the report:
`core/src/post_grblhal.rs:641-653` now opens `G91`, issues both `G38.2 Z-…` seeks and the
intermediate `G0 Z` inside it, closes `G90`, and then writes `G10 L20 P1 Z<top_mm>` **outside** the
`G91` — because `G10 L20` takes a coordinate, not a distance. The comment at `:621-639` records the
reasoning and the failure it removed.

⇒ Nothing in this design waits on #85. What #85 *did* change is the shape of §3's question: the seeks
are now travels and correctly carry no datum, so **`G10 L20 P1 Z<top_mm>` is the only line in the
probe block that states where Z0 is.** One line. That is the whole probing decision, and it is why
§3 can be answered without touching anything #85 fixed.

### 1c. `Spoilboard::top_face_z_mm()` should NOT change, and #87 pre-decided a fork it should not have.

#87 says *"under this instruction that function's answer becomes `0`"*. That is true **only if the
core's planning and simulation frames move with the datum** — which is one of two designs, and it is
the wrong one (§4.2). Under the design recommended here, `top_face_z_mm()` keeps returning
`-stock_thickness_mm` and keeps being true, because the plan frame stays workpiece-top-local and only
the **post** translates.

The function's own doc block (`core/src/types.rs:583-600`) states its frame explicitly — *"in the
frame every simulated Z is in — `z = 0` at the workpiece top"* — so it is not a statement about the
G54 datum at all. It states where the board sits **relative to the work**, and that relationship does
not move when the operator moves the datum. #87 is right that it is *the one place the stack's height
is stated*; it is wrong that this ruling changes its answer.

### 1d. Line numbers, and one that is volatile

`core/src/types.rs:1017 / :1038` in #87 are now `:1063 / :1084`. `core/src/fixture.rs:2534` and
`core/src/fixtures.rs:1389/1616` are correct as filed. The `web/src/App.tsx` citation named a
dependency array rather than the send.

⚠ **`web/src/App.tsx` grew ~220 lines while this document was being written.** Any line number into
`web/src/` in this document would be stale before it is read. Web citations below are by **symbol or
`data-testid`**, deliberately.

---

## 2. Why the shop wants it, and the exact condition under which it is delivered

Zeroing on the spoilboard's top face makes a through-cut target **`Z0` exactly**, so the depth of the
final pass stops depending on the workpiece's real thickness. Nominal 18 mm ply runs 17.2–18.4, and
with Z0 at the top that whole spread lands directly on *"didn't cut through"* or *"cut into the
board"*. Measured above: with `--spoilboard-zero` the deepest cutting Z is `0.000`, not `-18.000`.
The benefit is real and the arithmetic already works.

🔴 **The benefit exists only if the datum is ESTABLISHED AGAINST THE BOARD.** If the operator probes
the workpiece top and the app subtracts a *declared* thickness to reach the bottom, the thickness
error is back in full — with the added hazard that the operator now believes it is gone, and will
stop compensating for it. A datum that is arithmetically at the bottom and physically referenced to
the top is **strictly worse than doing nothing**, because it converts a known problem into an
invisible one.

That is the whole of §3.

---

## 3. 🔴 THE FOUNDER DECISION — where does the touch plate go?

Today the probe emits one line that states the datum:

```rust
// core/src/post_grblhal.rs:654
g.push_str(&format!("G10 L20 P1 Z{}\n", fmt(z.top_mm, d)));
```

`z.top_mm` is *"the thickness between your plate's top face and the workpiece top"*
(`core/src/types.rs:885-901`, `Machine::touch_plate_mm`). It says: **at the moment of contact, the
tool tip is at work-Z = `top_mm`.** With Z0 at the workpiece top and the plate resting on the
workpiece top, that is correct and thickness never enters.

Under a **bottom** datum the correct value depends entirely on **what the plate is resting on**, and
**nothing in the model records that today.**

| | Plate rests on | Correct `G10 L20 P1 Z` | Does the declared thickness enter the datum? |
|---|---|---|---|
| **P1** | the **spoilboard**, beside the workpiece | `top_mm` (unchanged) | **No** — full benefit |
| **P2** | the **workpiece top** | `stock.thickness_mm + top_mm` | **Yes** — benefit is zero, and hidden |
| **P3** | the **bare spoilboard**, no plate (`touch_plate_mm = Some(0.0)`) | `0.0` | **No** — full benefit |

### The costs, stated plainly

**P1 — the plate goes on the board.** Delivers the ruling. Costs:
- A clear patch of spoilboard beside the workpiece, inside travel, where the plate can sit.
- A **probe station** that must be **over the board and NOT over the workpiece**. The core can
  already answer this — `Spoilboard::covers(x, y)` exists — but nothing asks it, and a station that
  lands on the workpiece silently probes the wrong surface and is off by exactly one thickness. This
  needs a new refusal.
- 🔴 **It breaks the XYZ corner plate.** `Stock::corner_plate` exists precisely because a corner plate
  is hooked over the **workpiece** and moves with it (`core/src/types.rs:1064-1072`; the whole of
  decision #40, and terminology §9 **S6**). A plate sitting on the spoilboard is not hooked over a
  workpiece corner, so it cannot set X and Y from the workpiece edge. **One device cannot do both
  under this ruling.**

**P2 — probe the workpiece top, subtract the declared thickness.** Costs nothing at setup. Delivers
none of the benefit. Should exist only as a **typed** answer that warns on every export naming the
thickness it subtracted — never as a fallback, and never as the default. (Terminology §9 **S3**:
absent is not safe; an unstated reference surface must refuse, not assume.)

**P3 — no plate, touch off the bare board.** Delivers the ruling with no plate. Costs: MDF is not
conductive, so there is no continuity for a `G38.2` against a bare MDF board. The touch-off is a
manual jog against paper or a feeler. ⇒ **the honest emission is no probe at all** plus a refusal
saying the datum is the operator's to set at the board. That is a legitimate answer and should be
sayable.

### What is actually being asked

> 🔴 **The founder decision is: does the Z reference surface move to the spoilboard (P1/P3), or does
> the datum move while the reference surface stays on the workpiece (P2)?**
>
> And, if P1: **is the XYZ corner plate retained for X/Y with a separate Z touch on the board (two
> probe events, two devices), or is X/Y set mechanically and only Z probed?**

**Recommendation, for what it is worth, with the reasoning exposed:** **P1 or P3 for Z.** P2 should be
implementable and offered, because a shop without board access will want it — but it must be a
declared answer that warns, not a silent path. Choosing P2 as the default would satisfy the ruling's
letter and defeat its purpose, and the founder's stated reason (*"top of the spoilboard"*) is a
statement about a **surface**, not about arithmetic.

### What this decision does and does not close

✅ It supplies **half** of decision **#43 P2**. `core/src/types.rs:903-914` says the four-variant
`ZDatum` split needs *"a device type on the machine **and** a ruling on which surface Z is wanted
at; `z_zero_at_top` is adjacent but is not that ruling."* The founder has now given the **surface**
ruling.

🔴 It does **not** close the **device** half. `touch_plate_mm` still means two different physical
quantities — a plate thickness on the work versus a standing height of a bolted tool setter — and
that is still open, still #43 P2, and still needs its own ruling. **Do not read this design as
closing #43.**

---

## 4. The design

### 4.1 The single named function — where Z0 is

🔴 **The two datums must never both be live.** The way to guarantee that is not a convention: it is
to make the second answer **impossible to express**.

**Lives in `core/src/types.rs`, beside `Stock`**, because it is a property of the setup, not of the
machine and not of the post.

```rust
/// WHERE Z0 IS, and the only thing in this crate that answers it.
///
/// 🔴 Every Z word this crate emits, and every reader of an emitted Z word,
/// asks this type. Nothing else may compute a datum offset — a second answer is
/// a program half-planned in one frame and half in the other, which is a cutter
/// driven one full workpiece thickness wrong.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ZDatum {
    /// The usual router convention: work zero on the workpiece TOP face.
    WorkpieceTop,
    /// Founder ruling 2026-08-11: work zero on the SPOILBOARD's top face,
    /// which is the workpiece's underside.
    SpoilboardTop,
}

impl ZDatum {
    /// The number added to a PLAN Z to get the Z word that is EMITTED.
    /// Plan Z is always workpiece-top-local (§4.2); this is the only translation
    /// between the two frames that exists.
    pub fn emit_offset_mm(self, stock: &Stock) -> f64;

    /// The emitted Z word for one plan Z. Every `Z` the post writes goes here.
    pub fn emit_z(self, plan_z_mm: f64, stock: &Stock) -> f64;

    /// The emitted Z at which the cutter is level with the workpiece UNDERSIDE
    /// — the number every reader of the EMITTED TEXT must compare against.
    /// `-thickness` under `WorkpieceTop`, `0.0` under `SpoilboardTop`.
    pub fn through_z_mm(self, stock: &Stock) -> f64;

    /// The emitted Z of the workpiece TOP face. `0.0` / `+thickness`.
    pub fn surface_z_mm(self, stock: &Stock) -> f64;
}
```

**And `Stock` carries the enum, not the bool:**

```rust
pub struct Stock {
    …
    pub z_datum: ZDatum,   // replaces `z_zero_at_top: bool`
    …
}
```

🔴 **Why replace the field rather than add an accessor beside it.** An accessor leaves
`!stock.z_zero_at_top` compiling everywhere, so the single-answer rule becomes a habit — and *a habit
is a promise made by whoever is least able to keep it*. Replacing the field makes every present and
future second answer a **compile error**. That is the difference between a lesson re-derived and a
lesson enforced.

⚠ **`StockCfg::z_zero_at_top: Option<bool>` does NOT change.** It is a wire contract with the wasm
boundary, with every saved session, and with `web/e2e/slicer.spec.ts` — exactly the split
`docs/terminology.md` §0 draws between prose and identifiers, and X4 lists this family by name. The
mapping happens once, in `fixtures.rs`'s `apply`. **The serde key stays `z_zero_at_top`; the domain
model stops having a boolean.**

🔴 **`PostOptions::z_offset_mm` is DELETED.** It is the second place the same question is answered,
and it can be set to a value that disagrees with the declared datum — which is the exact hazard this
section exists to remove. Its one purpose is stated in its own doc (`post_grblhal.rs:18-19`): *"Used
when Z is zeroed on the spoilboard rather than on the workpiece top."* The post already receives
`&stock`; it takes the datum from there. `--spoilboard-zero` becomes a **`Stock` mutation**, which is
also what it always meant.

⚠ **The test that dies with it must be inverted, not deleted.**
`core/src/job.rs:2334` — `a_z_offset_moves_the_reported_depth_because_it_moves_every_z_word` — uses
`post.z_offset_mm = 7.0` to prove `JobSummary` reads the **emitted program** and not the plan. That
property is the single most load-bearing thing in this change: it is what makes a datum error
visible in the summary at all. Re-express it through `ZDatum::SpoilboardTop` with a stock of known
thickness. **Deleting it would remove the only assertion that the summary is not plan-derived.**

### 4.2 The frame decision — translate at the post, do not re-datum the core

Two designs are possible. They are not close.

| | **A — translate at the post (recommended)** | **B — plan in the emitted frame** |
|---|---|---|
| Plan Z (`depth_passes`, entry, safe-Z) | workpiece-top-local, unchanged | `+thickness` down to `0` |
| Simulation height map | `0.0` = uncut top, `stamp` lowers — unchanged | starts at `+thickness`, floor at `-allowance` |
| `Spoilboard::top_face_z_mm` | `-thickness`, unchanged and still true | `0` |
| `check_stock_depth`, `check_machine_limits`, `Fixturing::check`, `clearance_z` | unchanged | all change at once |
| Sites that change | **the post's Z writers, and the emitted-text readers** | **everything** |
| Frames live at once | two, separated by **one named function at one seam** | one |

🔴 **Option A is right, and the reason is not "less work".** It is that Option B rewrites every
safety check in the crate simultaneously — `sim.rs`'s floor, `check_stock_depth`'s limit,
`clearance_z`'s clamp conversion, the hold-down severance test — at the one moment when nobody can
tell a translation error from a logic error. And Option B does not even remove the translation: the
top datum is the usual router convention and stays supported, so the shift has to exist anyway, just
pointing the other way.

Option A's honest cost is that two frames exist. **The mitigation is the boundary, not the count**:
every value on the plan side is workpiece-top-local, every value on the emitted side goes through
`ZDatum::emit_z`, and the gate (§8, limb L4) asserts that **no Z word bypasses the seam**.

⚠ **`clearance_z` already names this exact conversion and gets it right today.**
`core/src/fixture.rs:419-427`: *"Clamp heights are measured from the SPOILBOARD; toolpath Z is
measured from the WORKPIECE TOP. Converting between the two is exactly the sort of mixed datum that
produces a confident, wrong number, so it is done here once and named."* Under Option A that
comment stays true and the code stays unchanged, which is a useful sanity check on the design: **the
one place in the crate that already thinks about mixed datums does not have to move.**

### 4.3 The probe (consumes §3's answer)

Three changes, and only the first depends on the founder:

1. **A declared reference surface.** The plate's resting surface becomes a **declared, refusable**
   property — absent is UNKNOWN and is **refused** when the datum is `SpoilboardTop`, exactly as
   `touch_plate_mm`'s `None` is refused today (`core/src/post_grblhal.rs:410-422`). Same three-way
   shape, same reason: absent ≠ safe. Under `WorkpieceTop` it is irrelevant and must not be demanded
   — an existing setup does not acquire a refusal it cannot answer.

2. **`G10 L20 P1 Z` is computed from the datum and the reference surface**, per §3's table. This is
   the one line that decides whether the ruling is delivered.

3. 🔴 **`side_z_mm` must be computed in the EMITTED frame, and today it is not.**
   `ProbeGeometry::side_z_mm` is `top_mm - xy_depth_mm` (`post_grblhal.rs:380-383`) — an **absolute
   work Z** — and it is emitted with `+ opts.z_offset_mm` added at the site
   (`post_grblhal.rs:701`) while `top_mm` itself carries no offset. So under `--spoilboard-zero`
   the descent for the side passes is `1.6 - xy_depth + 18` against a datum set at `1.6`: the tool
   descends **one full thickness too high**, the side seeks sweep air for their whole `reach`, and
   the program ends in `ALARM:5` with the datum half-set.

   ⚠ **This is a live inconsistency in the code today. It is unreachable only by accident**: the
   `fixture` subcommand honours `--spoilboard-zero` but has no way to declare a plate (it refuses
   `--config` by name), and `report` reads `--config` but constructs `PostOptions::default()`. **Two
   CLI wiring gaps are the only thing standing between the current tree and an ALARM:5 program.**
   That is not a control. It is the answer to `docs/design-76-run-tab.md` F2, which recorded the
   `G10` question as *"open, I could not derive it"* — it is derivable, and the answer is that the
   offset is applied inconsistently across the probe block.

### 4.4 The viewport, and the triad the founder noticed

The scene's `z = 0` plane is the **workpiece top**: `Viewport.tsx` builds the workpiece box at
`position.z = -sz/2`, the travel outline at `bedZ = -sz - 2`, the travel grid at `-sz - 1.5`,
clamps at `-sz + height/2` and the touch plate at `-sz + th/2`.

> ⚠ **PREMISE CORRECTED 2026-08-11 — the triad no longer has a fixed height, and `bedZ` no longer
> draws what this paragraph said it drew.** The conclusions below are **unchanged**, because none of
> them ever depended on either number; they depended on the scene frame being workpiece-top-local,
> which it still is. ⚠ **The paragraph above has been edited to match the code; the three bullets
> here are the audit trail, because a corrected sentence with no record reads as one that was always
> right — and this document was cited FROM in a commit and generated a ticket for a defect that had
> already been fixed.**
>
> - 🔴 **`aZ = 0.4` IS GONE** (`37bdb0bc6d`). It was a z-fight dodge for the flat X/Y arrows, and it
>   was **removed for a different reason than the one quoted at it three times**: measured against
>   this component's own camera it is ~2.8px at the tightest zoom the app allows and **0.23px at the
>   whole-workpiece view the founder was actually at** — so it cannot have been what he saw, and
>   removing it changes nothing on screen. It also only ever did half the job it was credited with:
>   the arrowheads are cones of radius `len * 0.05`, so at a 0.4mm lift their lower halves were still
>   inside the workpiece. The z-fight is now a **depth-buffer bias on the workpiece**
>   (`POLYGON_OFFSET_FILL`, which WebGL exposes for fills and not for a `THREE.Line`) — **no vertex
>   moves**, which is the property that matters for an instrument whose whole claim is where the
>   origin is.
> - **The triad's root is now a function, not a constant**: `axesRootZMm(datum, thicknessMm)`
>   (`Viewport.tsx`) returns `0` at a top datum and `-thickness` at `spoilboard-top`. See the ✅ on
>   the third bullet below — this is that recommendation, landed.
> - ⚠ **And `bedZ = -sz - 2` is no longer the spoilboard's plane** — see the corrected observation
>   after the recommendation. It is the **travel outline's** plane, which is why it is named that way
>   above.

**Recommendation — a lane decision, not a founder one, and stated so it can be overruled:**

- **The scene frame stays workpiece-top-local.** It draws *material*, and the relationship between
  workpiece, board and clamps does not move when the operator moves the G54 datum. Re-basing the
  scene would move every one of the offsets above for a change that is not about geometry.
- 🔴 **Every NUMBER shown to the operator is emitted-frame and carries the datum.** `Deepest Z`
  (`data-testid="deepest"`, fed by `JobSummary::deepest_z_mm`, which reads the emitted text) reads
  `-18.00 mm` today and `0.00 mm` under a bottom datum **for exactly the same correct through-cut**.
  A `0.00` beside the words "Deepest Z" reads as *it did not cut*. The label must state the datum:
  *"Deepest Z (from spoilboard top)"*, and the panel should show the depth below the surface beside
  it.
- ✅ **DONE `61a2919a55` — The Z arrow gets a stated origin.** The triad is the one instrument whose
  whole job is to say which frame you are looking at, and its own comment says an unlabelled triad
  *"would assert the opposite"*. Under this ruling it must say **where Z0 is**, in the same sentence
  that `frameNote` already uses for X and Y. Drawing the Z arrow from the declared datum rather than
  from a fixed height in the picture is the obvious move and is probably right — **but it is a
  picture change and it should follow the numbers, not lead them.**

  🔴 **DO NOT RE-OPEN THIS. It was right, it was followed, and it is closed.** The sequencing it
  asked for is what actually happened, and the record is worth keeping because a recommendation that
  was obeyed reads exactly like one that was ignored once the code has moved on:
  - `37bdb0bc6d` **declined to move the picture** — `App` held the declaration as `zZeroTop` and did
    not pass it, so the component could not draw the datum, and *"rooting the triad at an invented
    datum would be worse than the ambiguity"*. Its on-screen note said so out loud rather than
    guessing: *"this picture's zero, not the job's declared Z zero."*
  - `61a2919a55` **passed the number, then moved the picture** — `Viewport` gained a **required**
    `zDatum` prop (required, not optional, so an unwired prop cannot land on the founder's datum
    through truthiness), the root became `axesRootZMm`, and **the disclaimer was deleted in the same
    commit as the fix.** That is the part that would otherwise rot: a sentence still reading *"not
    the job's declared Z zero"* over arrows now drawn AT the declared Z zero is a stale explanation
    of a fixed problem, which is worse than the ambiguity it used to describe.
  - ⚠ **What the recommendation did NOT ask for, and what was named rather than compensated for:**
    under a bottom datum the flat arrows drop to the workpiece **underside** and the Z arrow's first
    `sz` mm runs up through the material. `depthTest` was deliberately **not** disabled — that would
    draw the triad on top of the workpiece and reproduce the founder's original complaint inverted.

  ⚠ **The bullet above it is NOT done, and the two are easy to close together by mistake.** `Deepest
  Z` still renders as a bare `{report.deepest_z_mm.toFixed(2)} mm` under an unqualified *"Deepest Z"*
  label (`App.tsx`, `data-testid="deepest"`) — **no datum in the label and no depth-below-surface
  beside it.** The number is emitted-frame; the label does not say so.

⚠ **Observation, filed rather than fixed, because it becomes load-bearing under this ruling:**
the viewport draws the spoilboard at `bedZ = -sz - 2` — **2 mm below** where `Spoilboard::top_face_z_mm`
says its top face is. No comment in that block explains the `2`; it reads as a z-fight dodge. Today
that is cosmetic. Under a bottom datum the board's top face **is Z0**, and the picture would put its
Z0 plane 2 mm from the program's. Worth a ticket regardless of which way §3 goes.

> ✅ **RESOLVED — AND THIS OBSERVATION WAS ALREADY STALE WHEN IT WAS WRITTEN.** `91f40f5fe3` moved the
> board to exactly `top_face_z_mm` **thirty-four minutes after this paragraph recorded the 2 mm**, and
> a later agent then re-routed the finding **out of this document rather than re-measuring the code**
> — a ticket generated by a doc about a defect that no longer existed. Retracted at the artefact in
> `61a2919a55`.
>
> **What the code says today:** the board slab sits at its own `top_face_z_mm`, coplanar with the
> workpiece underside, and the two coplanar faces are separated by a **`polygonOffset` depth bias
> rather than by a coordinate** — the same idiom, and the same reason, as the triad correction above.
> `bedZ = -sz - 2` survives and is **not** the board: it is the **travel outline**, a limit with no
> true Z and nothing sitting on it, plus the bare-reach hatch, which marks reach where there is **no
> board under it** and therefore has no top face to sit on.
>
> ⚠ **The reasoning is kept, not deleted, because it is still the rule:** under a bottom datum the
> board's top face **is** Z0, so any coordinate in this scene that disagrees with the core about where
> that face is becomes a picture of a different program. That is exactly why the fix had to be a depth
> bias and not a nudge.

---

## 5. Every consumer of the Z frame

Verified by reading each site. **Frame today** is what the code assumes; **under Option A** is what
this design does to it.

### 5a. Plan side — workpiece-top-local, and **unchanged**

| Consumer | Site | Note |
|---|---|---|
| Depth passes | `toolpath.rs:345-359` — `depth_passes` returns `-cur` | unchanged |
| Profile / pocket depth clamp | `toolpath.rs:542-548`, `:947` — `min(thickness + 0.3)` | unchanged |
| Ramp entry stops at the surface | `toolpath.rs:599` — `entry_z = 0.0` when ramping | unchanged; `0.0` is the surface **in the plan frame** |
| Safe-Z retracts | `toolpath.rs:580` and four sibling sites — `machine.safe_z_mm` | unchanged; the post shifts them |
| Travel-limit check | `post_grblhal.rs:249-251` — `-path.min_z > travel_z_mm` | unchanged — **but see §9 item 6, it asks an incomplete question** |
| Stock-depth check | `post_grblhal.rs:263-289` — `limit = -(thickness + allowance)` | unchanged |
| Simulation height map | `sim.rs:86-91` — `z: vec![0.0]`, `stamp` only lowers | unchanged; `0.0` = uncut surface |
| Simulation floor | `sim.rs:1023`, `:1138-1142` | unchanged |
| `Spoilboard::top_face_z_mm` | `types.rs:598-600` → `-stock_thickness_mm` | 🔴 **unchanged — contradicts #87, see §1c** |
| `Spoilboard::underside_z_mm` | `types.rs:611-617` | unchanged |
| Work-holding keepout | `fixture.rs:456-575` — walks `Toolpath` moves | unchanged (plan) |
| Clamp clearance conversion | `fixture.rs:419-427` — `clearance_z` | unchanged, and its comment stays true |

### 5b. Emitted side — every one of these must ask `ZDatum`

| # | Consumer | Site | What it must become |
|---|---|---|---|
| E1 | Every Z word the post writes — cutting, rapid, plunge, peck retract, tool-change lift, program open/close | `post_grblhal.rs` — **16 sites read `opts.z_offset_mm` directly** (`:591 :701 :871 :1061 :1116 :1146 :1166 :1206 :1234 :1235 :1244 :1245 :1266 :1274 :1277 :1311`), plus `:613` and `:726` which consume the already-offset `safe_z` from `:591` | all route through `ZDatum::emit_z` |
| E2 | Probe seeks | `post_grblhal.rs:641-652` | **unchanged** — post-#85 these are `G91` travels and correctly carry no datum |
| E3 | 🔴 Probe datum | `post_grblhal.rs:654` — `G10 L20 P1 Z<top_mm>` | §3 / §4.3 — **the line that decides the ruling** |
| E4 | 🔴 Probe side descent | `post_grblhal.rs:380-383` + `:701` — `side_z_mm` | computed in the emitted frame; **inconsistent today** (§4.3 item 3) |
| E5 | 🔴🔴 Hold-down severance test | `fixture.rs:2720` — `through_z = -stock.thickness_mm + 1e-6`, applied to moves parsed out of the **emitted G-code** by `read_program` (`:1869`, `:2503`) | `stock.z_datum.through_z_mm(&stock)`. **Ranked #1 in §9.** |
| E6 | The `z_zero_at_top` PENDING guard | `fixture.rs:2534-2542` | deleted **in the same commit** as E5, never before |
| E7 | `JobSummary::deepest_z_mm` | `job.rs:281`, computed by reading the emitted text (`job.rs:588` states this deliberately) | stays correct; **its label and its UI presentation change** (§4.4) |
| E8 | Browser summary | `App.tsx`, `data-testid="deepest"` | label states the datum |
| E9 | Gate G11 | `gate:768-786` | the `18.0` literal becomes the report's stock thickness |
| E10 | Gate PROBE, Z-datum limb | `gate:3395` — `datum(fl.gcode,'Z') === 1.6` | 🔴 **the best single assertion of §3's answer** — `1.6` under P1/P3, `1.6 + thickness` under P2 |
| E11 | Gate ENT through-cut detector | `gate:2769` — `s.deepest <= -0.5 * thicknessMm`; plunge test `tz < -1e-6` at `:2782` | datum-aware surface Z |
| E12 | Gate P3 pocket floor | `gate:845-871` — `pocketFloorZ` takes `Math.min` and compares negatives | datum-aware |
| E13 | Gate per-pass bite | `gate:2365-2374` — `/^G1 Z(-?[\d.]+) F/`, *"from the surface down"* | datum-aware |
| E14 | e2e parity fixture | `web/e2e/slicer.spec.ts:1248` — `z_zero_at_top: true` | stays `true`; a second case added for `false` |

### 5c. Picture side

| Consumer | Site | Under Option A |
|---|---|---|
| Scene Z origin, workpiece box, travel outline, grid, clamps, plate | `Viewport.tsx` — `bedZ`, `-sz/2`, `-sz - 1.5`, `-sz + h/2`, `-sz + th/2` | unchanged (§4.4). ⚠ **`bedZ` is the TRAVEL OUTLINE, not the board** — the board slab is at `top_face_z_mm` and this row said "board plane" until 2026-08-11 |
| Axes triad | `Viewport.tsx` — ~~`aZ = 0.4`~~ → `axesRootZMm(props.zDatum, sz)`, `arrow(…AXIS_COLOR.z, 'Z')` | ✅ **DONE `61a2919a55`** — gained a stated Z0 origin. The `aZ = 0.4` lift was removed first (`37bdb0bc6d`); **do not follow it as a live coordinate** |
| Extruded wall height / `cutDepthMm` | `Viewport.tsx` — `wallHeight`, TODO #47 | unchanged (plan frame) |

---

## 6. Migration

Nothing in this tree is a checked-in golden program: `G1` is a three-run self-comparison
(`gate:141-150`) and the probe dump is regenerated into `target/probe-gate/` by a `cargo test`. So
there is **nothing to re-bless**. What has to migrate is different, and #87 under-states it:

🔴 **The reference *fixtures* are fine. The reference *assertions* are the work.** Every literal in
the gate file that encodes "cuts are negative" (E9–E13), and every core unit test that plans against
`Stock::default()`, sits on the old frame. *(Count the tests by running `cargo test`, not by reading
this line — `AGENTS.md`: count by running.)*

### 6a. `Stock::default()` — do NOT flip it in the same change

The founder has ruled which datum he wants. That ruling is recorded here and is not in question. But
the default is what every fixture, every unit test and every un-configured caller plans against, so
flipping it is not a setting change — it is a simultaneous re-baselining of the whole test corpus.

⇒ **The default flips in step 5 of §7, alone, after every reader is datum-aware.** Until then
`ZDatum::WorkpieceTop` remains the default and the change is provably byte-neutral (§7).

### 6b. Stored browser sessions

`web/src/store.ts` — `SESSION_KEY = '2bee.app.session'`, `SESSION_VERSION = 2`,
`zZeroTop: { t: 'bool' }`. The file's own rule 2 is *"THE BLOB IS VERSIONED AND A MISMATCH RESTORES
NOTHING"*, and `SESSION_VERSION`'s doc says *"Bump when a field is renamed, changes units, or changes
**MEANING**."*

The stored **value** does not change meaning — `true` meant "top" before and after. What changes is
that it now **does something**. Two options, and both have a cost:

| | Cost |
|---|---|
| **(a) Bump to 3** | Every operator loses their entire restored setup — forty-odd fields, clamps, drawings — on first load after deploy, for one boolean two of them touched. Blunt, honest, and the store's stated rule. |
| **(b) Keep 2, drop the one field** | A restored `zZeroTop === false` is **dropped and reported by name** in the existing `DroppedField` banner, with the reason: *this setting did nothing when you saved it and now sets where Z0 is — say it again.* Nobody else is disturbed. |

**Recommendation: (b).** It applies the store's **rule 1** ("nothing is restored that cannot be
validated … dropped, defaulted, and NAMED") to the one value whose consequence moved, instead of
rule 2 to all forty. A stored `false` is precisely the dangerous restore, and it is the one that gets
caught.

🔴 **And the harder half, whichever option is taken: absence.** `App.tsx` initialises
`useState(R.zZeroTop ?? true)`. If the default becomes `SpoilboardTop`, then **every operator who
never touched the toggle silently gets a new frame on their next job.** That cannot be handled by a
version bump, because there is nothing stored to version. ⇒ **The default change requires a one-shot
in-app announcement**, not only a commit message. This is the migration item most likely to be
missed, because it has no artefact.

### 6c. Saved workpieces

The Workpiece picker's saved rows already display `Z zero: stock top | spoilboard` and already say
*"What choosing it sets: the WHOLE workpiece — size, thickness, material, datum X/Y, the turn and
**where Z zero is**"*. The **display** is already honest; the **consequence** is what appears. A
saved workpiece carrying `zZeroTop: false` loads a datum it never had. Same treatment as 6b.

### 6d. Exported store files — a residual, named rather than papered over

`store.ts`'s export carries `version: DB_VERSION` (3) and its import raises a `versionNote` **only
when the file is NEWER than the build**. There is no mechanism for *"older file, field meaning
changed"*, and inventing one for this single case would be a control with one user. ⇒ **Stated as an
accepted gap:** a workpiece exported before this change imports afterwards with the new consequence
and no note. The mitigation is 6c's load-time notice, which fires on the row regardless of where it
came from.

---

## 7. Sequencing

🔴 **The property that makes this order safe: steps 1–3 change no emitted byte.**

| # | Step | Acceptance |
|---|---|---|
| **0** | *(#85 — already landed, `74685f688a`. Nothing waits on it.)* | — |
| **1** | `ZDatum` lands. `Stock::z_datum` replaces the bool. `StockCfg` unchanged. `PostOptions::z_offset_mm` deleted; `--spoilboard-zero` becomes a `Stock` mutation. Every post Z-writer routes through `emit_z`. `job.rs:2334` inverted, not deleted. | 🔴 **Byte-identical output on every fixture, both with and without `--spoilboard-zero`**, hash-compared against the pre-change binary. A refactor whose output is byte-identical is the only kind that can be reviewed for safety. |
| **2** | Emitted-text readers learn the frame: `check_hold_down::through_z` (E5), and the `z_zero_at_top` PENDING guard (E6) is deleted **in this same commit**. `JobSummary` labelling. | Byte-identical output; **verdict-identical** on every fixture, under **both** datums. Hold-down findings non-empty and equal across the two. |
| **3** | Gate readers E9–E14 become datum-aware; gate `ZDAT` lands with its plant (§8) and is **watched red**. | The plant goes red on L3; the top-datum control stays green. |
| **4** | 🔴 **The probe.** Reference-surface field, refusals, `side_z_mm` in the emitted frame (E3, E4). | **Blocked on §3.** Cannot start before the founder answers. |
| **5** | The default flips to the founder's ruling, with the 6b notice and the 6c announcement. | The announcement exists and fires. |
| **6** | Viewport numbers and the triad (§4.4). | — |

⚠ **The one ordering constraint that is not negotiable: step 2 must precede step 5.** If the default
flips while `through_z` is still `-thickness`, the hold-down check finds **zero** severed cells on
every job and reports *every part still held*. Today's `if !stock.z_zero_at_top { pending }` guard
(E6) is the only thing standing between those two states — which is why it may only be removed by the
commit that replaces it, and never as a tidy-up.

⚠ **Step 4 is not a prerequisite for step 5, and it should be.** A bottom datum with a top-referenced
probe is §3's P2 — arithmetically right, physically wrong, and it *looks solved*. If step 5 lands
before step 4, the app ships the failure mode this whole ruling exists to remove. **Do not flip the
default until the probe knows what surface it is referencing.**

---

## 8. The gate

**`ZDAT` — HARD. *"the emitted program is in the frame the operator declared, in every line that
states one"*.** Physical failure it guards: a cutter driven one full workpiece thickness wrong.

Everything below reads the **emitted G-code**. Nothing reads the setting. Every expected value is
derived from the **report's** stock thickness, never from a literal — a gate seeded with `18.0`
vouches for whatever the fixture happens to be.

| Limb | Assertion |
|---|---|
| **L1 — the surface** | On a fixture with a through-profile: deepest cutting Z `== datum.through_z_mm(stock)` (`-thickness` / `0.000`), and the highest rapid `== safe_z + offset`. |
| **L2 — the shift is exact and total** | Every Z word in the two programs differs by exactly one stock thickness. *(This is G11's existing property. Keep G11 separate rather than folding it in, so a regression names which half broke.)* |
| **L3 — 🔴 the probe agrees with the plan** | `G10 L20 P1 Z<v>`: under `SpoilboardTop`, `v == plate_top_mm` (P1/P3) or `plate_top_mm + thickness` (P2), per §3's answer — and the side descent `G0 Z<side> == v - xy_depth_mm`. **This limb catches the half-landing**, which is §9's failure #2. |
| **L4 — no Z word bypasses the seam** | The two programs must differ **at every Z index and nowhere else**: X, Y, F and every non-Z word byte-identical. A forgotten site is one index that did not move; a doubled site is one that moved 2×. |
| **L5 — the hold-down check still sees the severance** | The same fixture must produce the **same non-empty** `HoldDownFinding` set under both datums. 🔴 **Assert non-empty explicitly** — a `through_z` that did not learn the frame produces *zero* findings, and zero findings is PASS-shaped. |

### The negative control — part of the contract, not a follow-up

Registered in `core/src/fixtures.rs::PLANT_CONTRACTS` (gate `PLANT` fails on an orphan plant, and an
unregistered plant is a control nobody runs):

```rust
PlantContract {
    // Restores the half-landing exactly: the MOTION Z words take the datum
    // offset and `G10 L20 P1 Z` does not — which is what `PostOptions::z_offset_mm`
    // did on 2026-08-11, and what an ALARM:5 program looks like from the inside.
    name:   "datum-half-shifted",
    host:   "job",              // `report` always prints JSON; `job` is where a program is observable
    target: "plate",
    config: Some(r#"{"stock":{"z_zero_at_top":false},"machine":{"probe_enabled":true,"touch_plate_mm":1.6}}"#),
    effect: PlantEffect::ProgramDiffers,
    gate:   "ZDAT",
},
```

🔴 **Watched RED on L3 before the gate is believed.** The commit that lands `ZDAT` pastes the red run
into its body, per `SLICER-GATES.md`.

⚠ **A plant proves sensitivity only.** Two cases must stay **green**, or the gate gets "fixed" by
banning the datum it exists to support:
1. The same fixture under `WorkpieceTop` produces output byte-identical to the pre-change binary.
2. `--plant datum-half-shifted` is **inert** under `WorkpieceTop` (offset is `0`, so both halves
   agree) — so the plant's own contract must name `z_zero_at_top: false` in its `config`, exactly as
   `bed-anchored-sim` and `drawing-offset-ignored` do, for the same reason: *a plant that is vacuous
   on the default target reads as armed and runs clean forever.*

### What `ZDAT` cannot do, said in the row rather than discovered

**It proves the program is self-consistent. It cannot prove the plate is where the operator says it
is.** No check on emitted text can. That fact belongs in a refusal and on a printed setup sheet, and
the row must say so — otherwise a green here reads as *"the datum is right"* when it means *"the
program does not contradict itself"*.

### ⚠ And a live gap found on the way

**`G11` is a HARD gate with no entry in `PLANT_CONTRACTS`.** `AGENTS.md` duty 2: *"Every HARD gate
carries a negative control."* G11 has none — nobody has watched it go red. The `datum-half-shifted`
plant above does not cover it either (G11's property is the *shift*, L3's is the *agreement*). Either
`ZDAT` L2 subsumes G11 and G11 retires, or G11 gets its own plant. **It should not stay as it is.**

---

## 9. What could go wrong, and would be silent — ranked by what it does at the machine

**1. 🔴🔴 The hold-down check reports every part HELD, because nothing reads as severed.**
`fixture.rs:2720` tests `m.from.2 > through_z && m.to.2 > through_z` against `-thickness`. Under a
bottom datum no emitted Z ever goes below `0`, so **every move is skipped**, zero cells are marked
severed, and the report contains **no findings**. *No findings* and *checked and clear* are the same
colour to anyone not reading carefully — terminology §9 **S9**. At the machine: a part reported
restrained that is loose under a 2.2 kW spindle, which is gate `P1`'s failure arriving through a
different door. **This is the worst item on the list and it fails in the direction that reads safe.**
Mitigations: E5 + E6 in one commit, `ZDAT` L5 asserting findings **non-empty**, and step 2 before
step 5.

**2. 🔴 A program planned in one frame and datumed in the other — the cutter one full thickness out.**
Down (probe fixed, plan not): a through-cut targets `Z0` on a machine zeroed at the workpiece top ⇒
**18 mm of cutter below the board's underside**, through the sacrificial material and into the frame.
Up (plan fixed, probe not): the whole job cuts in the air — a scrapped part and nothing broken. **The
down direction is the more likely half-landing**, because the plan is one function and the probe is
five sites. Mitigation: `ZDAT` L3, and step 4 before step 5.

**3. 🔴 The XY side probe descends one thickness too high.** §4.3 item 3, and it is a real
inconsistency in the tree today held back only by two CLI wiring gaps. Best case `ALARM:5` with the
datum half-set; worse case the cutter contacts the workpiece edge instead of the plate wall at a
height nobody intended, and the X or Y datum is set from the wrong feature. Mitigation: `ZDAT` L3's
side-descent clause.

**4. ⚠ The `entry=Plunge` negative control stops planting, so gate `ENT` dies quietly.** `ENT`'s
plunge detector requires `tz < -1e-6` (`gate:2782`); under a bottom datum no cutting Z is negative, so
`fPlanted.plunges.length > 0` never holds. `ENT` *does* fail loudly on `fClean.sections >= 1` — so
this one goes **red, for the wrong reason**, and the tempting fix is to relax the section filter,
which would leave the plunge limb dead behind a green. **A control that looks alive and is not.**

**5. ⚠ `Deepest Z` reads `0.00 mm` on a correct through-cut.** Mitigation: §4.4's labelling. Cheap to
fix and easy to skip, and its failure mode is an operator re-running a job that already cut through.

**6. ⚠ The Z-travel check asks half the question, and the bottom datum makes the other half
reachable.** `post_grblhal.rs:249` tests only `-path.min_z > machine.travel_z_mm`. **`path.max_z` is
never tested at all.** Under a top datum the highest emitted Z is `safe_z` (5 mm), so nobody noticed.
Under a bottom datum it becomes `safe_z + thickness` — `G0 Z23` on the measured fixture, and on the
`Desktop 3018` preset (`travel_z_mm: 45`) a 40 mm workpiece puts the opening rapid at the machine's
positive Z limit. **This needs a new refusal, not a translation.** It is a finding about the current
code that this change makes reachable.

**7. ⚠ Two frames on one screen.** The scene draws Z0 at the workpiece top while every number on the
panel is measured from the board. §4.4 keeps them apart deliberately; the residual is that the
operator must know which is which, and the triad and the labels are the only things that say so.

**8. ✅ One thing gets safer, and it is worth recording** so nobody "fixes" it. `design-76-run-tab.md`
F3 notes that every program opens with an absolute `G0 Z<safe_z>` against whatever G54 the controller
happens to hold, which can be a rapid **downward** if the stored datum is stale. Under a bottom datum
that opening rapid is `safe_z + thickness` — one full thickness **further from the work**. It does not
remove the hazard (the Run tab still owes the refusal), but it moves in the right direction.

---

## 10. What this design does not settle

| Open | Owner |
|---|---|
| 🔴 Which surface the plate rests on — P1 / P2 / P3 (§3) | **founder** — blocks step 4 |
| 🔴 If P1: corner plate retained for X/Y with a separate board touch for Z, or X/Y set mechanically | **founder** |
| Whether P2 is offered at all (recommendation: yes, typed, warning on every export, never a default) | **founder** |
| Decision **#43 P2**'s **device** half — `touch_plate_mm` still means a plate thickness *and* a tool-setter standing height | **founder**, separately. §3 supplies the *surface* ruling and closes only that half. |
| Session-migration option (a) bump vs (b) targeted drop — §6b | lane, unless the founder wants the blunt one |
| Scene frame stays workpiece-local while the numbers are emitted-frame — §4.4 | lane |
| ~~`bedZ = -sz - 2` draws the board 2 mm from where the core says it is — §4.4~~ ✅ **CLOSED, and it was never open**: `91f40f5fe3` moved the board to `top_face_z_mm` 34 min after §4.4 recorded the 2 mm; retracted at the code in `61a2919a55`. **A stale row in an OPEN table is the worst place for one** — it is read as work outstanding and nobody re-measures a ticket that names a reason | — |
| `G11` is HARD with no negative control — §8 | lane |
| `check_machine_limits` never tests `path.max_z` — §9 item 6 | lane |

---

## 11. Provenance

Every claim in this document was read at the file, and the two behavioural ones were measured by
running the shipped binary rather than by reading the code that produces them.

| Claim | Read / measured at |
|---|---|
| `--spoilboard-zero` emits a bottom-datum program; through-cut lands at `Z0.000` | `./target/release/2bee-slice fixture rect-profile [--spoilboard-zero]`, run 2026-08-11 |
| The two paths cannot be combined (probe + shift) | `2bee-slice fixture … --config` refuses the flag by name (measured); `JobConfig` has no `post` section (`fixtures.rs:1129-1181`); `Job::post = PostOptions::default()` (`job.rs:124`) |
| `z_zero_at_top` has exactly one reader, and it is a warning | `rg z_zero_at_top` across `core/ cli/ wasm/ web/ gates/`; sole consumer `core/src/fixture.rs:2534` |
| #85 landed | `git log core/src/post_grblhal.rs` → `74685f688a`; verified at `post_grblhal.rs:641-653` |
| `top_face_z_mm` returns `-thickness` and states its own frame | `core/src/types.rs:583-600` |
| Height map starts at `0.0` and only lowers | `core/src/sim.rs:86-91`, `:102-104` |
| Hold-down reads the **emitted** program | `core/src/fixture.rs:2503` (`read_program(gcode, tools)`), `:1869`, `:2720` |
| `JobSummary` is read out of the emitted text by decision | `core/src/job.rs:588-600` |
| Gate literals encoding the frame | `gates/slicer_gate_check.mjs:772-784`, `:845-871`, `:2365-2374`, `:2769`, `:2782`, `:3395` |
| No checked-in golden programs | `gates/fixtures/` holds 4 DXF/SVG; `G1` is a 3-run hash self-comparison (`gate:578-588`); probe dump regenerated into `target/probe-gate/` |
| Session store rules and version | `web/src/store.ts` — `SESSION_VERSION = 2`, the three restore rules, `zZeroTop: { t: 'bool' }` |
| Scene Z origin and triad height | `web/src/Viewport.tsx` — `bedZ`, `-sz/2`, `aZ = 0.4` and its comment. ⚠ **`aZ = 0.4` no longer exists** (`37bdb0bc6d`); this row is the reading as taken on 2026-08-11 and is left as the record, **not** as a pointer to follow — see §4.4 |
| `G11` has no plant | `rg 'gate: "' core/src/fixtures.rs` — 20 contracts, none naming `G11` |
| F2 was recorded as unresolved and is now resolved | `docs/design-76-run-tab.md:144-159` |
