# Decision #64 — several workpieces on one bed

**This document changes nothing.** No code was edited to write it. It is a measurement
of the existing core plus one recommendation; the change is the founder's to authorise.

**Every line number below was read at `6e72d40607`.** `core/`, `web/` and `gates/` were
being edited by another agent while this was written, so the numbers will drift. **The
symbol names are the durable reference** — if a citation does not land, `grep` the
function name rather than assuming the code changed.

**Nothing here was run.** No `cargo build`, no gate run (a run was likely in flight and
they collide on port 4173). Gate facts below are read from
`gates/slicer_gate_check.mjs`; the gates DECLARED in its `GATES` table (**48 when this was written, 62 on 2026-09-07** — read it from `--list`, not from here)
(`gates/slicer_gate_check.mjs:75-133`) — *declared*, not *passing*, because this session
did not run them.

**No machining numbers are invented here.** Every millimetre quoted is either read out
of the code or is a worked example whose inputs are named.

---

## 0. The ask, and the one sentence that decides it

Founder, 2026-08-10, twice: *"able to add multiple workpeaces (when I right click on the
workpeace in the 3d canvas able to delete/clone the workpeace)"* and *"Able to add
multiple work peaces"* (`TODO.md:1734`, `TODO.md:1988`).

The decision turns on one property of the core, and everything in §1–§3 is its
consequence:

🔴 **`Stock::thickness_mm` is ONE number doing TWO jobs.**

1. **How far the datum is from the bed** — `limit = -(stock.thickness_mm + allowance_mm)`
   (`core/src/post_grblhal.rs:206`), `floor = -(stock_thickness_mm + spoilboard_allowance_mm)`
   (`core/src/sim.rs:494`), `clamp_above_stock = (tallest - stock_thickness).max(0.0)`
   (`core/src/fixture.rs:199`).
2. **How much material there is to cut** — `depth_total_mm: job.stock.thickness_mm`
   (`core/src/fixtures.rs:3679`), `depth = op.params.depth_total_mm.min(stock.thickness_mm + 0.3)`
   (`core/src/toolpath.rs:410`, `:797`), `Feature::from_part` depth
   (`core/src/recommend.rs:287`, `:293`).

For ONE sheet these are the same number, because the sheet rests on the bed and Z0 is its
top. **For two sheets of different thickness resting on the same bed they are different
numbers for at least one of the sheets**, and there is one field. Whatever you put in it,
one of the two roles is wrong for one sheet — and §2 shows that both directions of wrong
have a physical consequence that no existing check can see.

---

## 1. The blast radius, measured

**Counting rule, stated so nobody has to guess:** every non-test mention of the tokens
`thickness_mm` / `stock_thickness` in `core/src/`, `cli/src/` and `wasm/src/`, with
`#[cfg(test)]` modules excluded by brace-matching (not by "first `#[cfg(test)]` in the
file" — `core/src/fixtures.rs` has an inner test module at line 1105 with ~2,600 lines of
production code after it, so the naive heuristic under-counts by most of the file).

**Measured: 35 sites**, not 30. `TODO.md:1747` and `TODO.md:1990` both say *"30
places"* — that number is close and it is **low**, and the five it misses are not
decorative: `cli/src/main.rs:1096` (the Z-datum shift), `core/src/recommend.rs:287`/`:293`
(the recommender's per-feature depth) and `core/src/fixtures.rs:2897` (what the simulation
is told the slab is) are all in the load-bearing group.

Of the 35, **8 are declaration/default/plumbing and 27 are reads that consume the value.**

🔴 **ZERO of the 35 touch X or Y.** There is no site at which thickness participates in
plan-view geometry. Every one is a Z-axis quantity or a label. This is the single most
useful fact in the audit: it is why "several sheets at one thickness" is genuinely cheap,
and why "several sheets at mixed thickness" is not a layout problem at all.

### 1a. Classified

| # | Class | Sites | What breaks if the value is wrong for a sheet |
|---|---|---|---|
| **A** | **DEPTH OF CUT** — thickness decides how deep the cutter goes | 9 | the part is not cut through, or the cutter goes past the bed |
| **B** | **BED / SPOILBOARD FLOOR** — thickness decides where the machine thinks the bed is | 7 | the spoilboard check and the simulation judge a slab nobody is cutting |
| **C** | **DATUM CONVERSION + CLEARANCE** — thickness converts bed-referenced heights to stock-top-referenced ones | 6 | rapids fly at the wrong height over clamps; every emitted Z word shifts |
| **D** | **ADVICE / ECHO / PICTURE** — reported, never cut | 5 | the operator is told a number about the wrong sheet |
| **E** | **DECLARATION / DEFAULT / PLUMBING** | 8 | — |

**A — DEPTH OF CUT (9)**

| site | what it does |
|---|---|
| `core/src/toolpath.rs:410` | `depth = op.params.depth_total_mm.min(stock.thickness_mm + 0.3)` — profile |
| `core/src/toolpath.rs:411` | the "depth clamped … deeper is the spoilboard" note's condition |
| `core/src/toolpath.rs:797` | the same clamp, drill path |
| `core/src/fixtures.rs:3679` | `depth_total_mm: job.stock.thickness_mm` — **every imported drawing is cut through by construction** |
| `cli/src/main.rs:1038` | same, fixture path |
| `cli/src/main.rs:1649` | same, `job --drawing` path |
| `core/src/recommend.rs:287` | `Feature::from_part` — the outer profile's depth IS the thickness |
| `core/src/recommend.rs:293` | same, for every inner feature |
| `core/src/rect_profile.rs:157` | `depth_total = job.stock.thickness_mm + 7.0` — gate G4's plant |

**B — BED / SPOILBOARD FLOOR (7)**

| site | what it does |
|---|---|
| `core/src/post_grblhal.rs:206` | `check_stock_depth`'s limit — **the only "you are in the bed" refusal** |
| `core/src/post_grblhal.rs:211`, `:213` | the numbers inside that refusal's text |
| `core/src/sim.rs:447` | `check`'s `stock_thickness_mm` parameter |
| `core/src/sim.rs:494` | the simulated floor |
| `core/src/sim.rs:502` | `SimFinding::Spoilboard { past_mm }` |
| `core/src/fixtures.rs:2897` | the one call site that tells the simulation how thick the slab is |

**C — DATUM CONVERSION + CLEARANCE (6)**

| site | what it does |
|---|---|
| `core/src/fixture.rs:193` | `clearance_z(&self, machine, stock_thickness)` |
| `core/src/fixture.rs:199` | `clamp_above_stock = (tallest - stock_thickness).max(0.0)` — **bed datum → stock-top datum, and the file says so in as many words** |
| `core/src/fixture.rs:211` | `check`'s parameter |
| `core/src/fixture.rs:229` | `let clear_z = self.clearance_z(machine, stock_thickness)` |
| `core/src/job.rs:1285` | `job.fixturing.check(&path, biggest_r, job.stock.thickness_mm, &job.machine)` — the one call site |
| `cli/src/main.rs:1096` | `--spoilboard-zero` sets `PostOptions::z_offset_mm = stock.thickness_mm`, which **shifts every emitted Z word** (`core/src/post_grblhal.rs:997`, `:1020`, `:1066`, `:1119`, `:1140`) |

**D — ADVICE / ECHO / PICTURE (5)**: `core/src/recommend.rs:867`/`:870` (the
deeper-than-stock note), `core/src/fixtures.rs:2794` (`render.stock[2]`, which is what the
viewport draws the slab from — `web/src/Viewport.tsx:1672`, `web/src/cam.ts:458`),
`cli/src/main.rs:1462` and `:1492` (JSON + human echo).

**E — PLUMBING (8)**: `core/src/types.rs:510` (field), `:547` (default `18.0`),
`core/src/fixtures.rs:1252` (`StockCfg::thickness_mm`), `:1468` (cfg → stock),
`:3331`–`:3332` (`intake_stock`), `:541` (the fixture stock literal), `cli/src/main.rs:455`
(`--thickness`).

### 1b. Two structural facts the count does not show

🔴 **The whole planner takes ONE `&Stock` and there is no per-operation stock.**
`plan_operation(op, &job.machine, &job.stock)` (`core/src/job.rs:1207`) is inside the
group loop, so **every operation in a program is planned against the same sheet, by
construction.** Any per-sheet thickness therefore requires either a per-operation stock
(a signature change through `plan_operation` → `plan_profile` / `plan_drill`) or N jobs.
There is no third shape.

🔴 **`Report` is ONE program.** `pub gcode: String` (`core/src/fixtures.rs:2322`), one
`ok`, one summary, one `sim`. A program-per-sheet model changes the host contract, not
just the core — the browser downloads one file, `wasm::plan_import_many`
(`wasm/src/lib.rs:872`) returns one `Report`, and every gate drives one program.

---

## 2. The physical trap, stated precisely

**The physical setup is fixed and it is what makes this tractable: every sheet lies on the
same bed.** So the sheets' *undersides* are coplanar and their *tops* are not. The core
has no "bed Z" field — the bed is *implied* at `Z = -thickness_mm` by
`core/src/post_grblhal.rs:206` and `core/src/sim.rs:494`. And Z0 is set once, physically,
on one surface: `G10 L20 P1 Z<top_mm>` (`core/src/post_grblhal.rs:563`) writes the work Z
zero from whatever the probe touched.

Take Ta > Tb — a thick sheet and a thin one, Δ = Ta − Tb. Worked with Ta = 18, Tb = 12,
Δ = 6 (the TODO's own example), and `safe_z_mm = 5.0` (`core/src/types.rs:474`).

### Case A — Z0 on the THICK sheet's top; `thickness_mm = Ta` (= 18)

- **Class C (datum) is correct for both sheets**: the bed really is at Z = −18.
- **Class A (depth)**: the program cuts to Z = −18 everywhere. The thin sheet spans
  Z = −6 … −18, so −18 is *exactly through it too*. **The cut-out SHAPE is right on both
  sheets.**
- **What is actually wrong:** the ramp. `entry_z = if plunging { z } else { 0.0 }`
  (`core/src/toolpath.rs:449`) starts the ramp at Z0 — which over the thin sheet is 6 mm
  of **air**. The ramp's XY allowance (bounded by half the perimeter,
  `core/src/toolpath.rs:451-454`) is partly spent before the cutter touches anything, so
  the cutter engages part-way down a ramp that is now effectively steeper. That is
  precisely the failure gate **ENT** exists for (`gates/slicer_gate_check.mjs:113`:
  *"a cutter dropped straight to depth loads the ends of the flutes"*), arriving through a
  route ENT cannot see, because ENT reads the emitted program against **one** declared
  stock top.
- **Tabs survive.** `(z + tab_height).min(0.0)` (`core/src/toolpath.rs:554`) measures the
  tab up from the pass depth, and the pass depth bottoms out at the shared bed — so the
  tab leaves `tab_height` of material on both sheets. This is worth stating because it is
  the one thing that does *not* break here.
- **The simulation is answering about a sheet nobody is cutting.**
  `core/src/fixtures.rs:2897` hands `sim::check` one thickness, and `core/src/sim.rs:494`
  builds one floor. Over the thin sheet's footprint the model contains 6 mm of material
  that is not there. `Gouge` / `Uncut` / `Spoilboard` are all computed against that
  surface. **This is DINV's class** (`gates/slicer_gate_check.mjs:104`: *"a verdict that
  changes when the sheet is moved is an answer about a part nobody is cutting"*) with the
  sheet's *thickness* substituted for its *position*.

⇒ **Verdict: WRONG CHECKS, right part.** No crash, no scrap — and every Z-axis control in
the tool silently stops describing half the bed.

### Case B — Z0 on the THICK sheet; `thickness_mm = Tb` (= 12)

- **Class A**: `depth_total_mm = 12` (`core/src/fixtures.rs:3679`), clamped to 12.3
  (`core/src/toolpath.rs:410`). The program cuts to Z = −12.
- The **thick** sheet is 18 mm: **6 mm of material left all the way round the profile.
  The part is not cut out.** Tabs are decorative.
- The **thin** sheet spans −6 … −18: cutting to −12 removes 6 of its 12 mm. **Also not cut
  out.**
- **Class B**: `limit = −(12 + 0.3)`; the program's `min_z` is −12. **`check_stock_depth`
  passes.** Gate G4 passes. Nothing fires.

⇒ **Verdict: WRONG PART, silently, on BOTH sheets, with every gate green.** This is the
cheapest mistake for an operator to make (declare the thinner sheet, "to be safe") and it
is the one with no detector.

### Case C — Z0 on the THIN sheet's top; `thickness_mm = Ta` (= 18) 🔴 **THE CRASH**

The operator zeroes on whichever sheet is convenient. If that is the thin one, Z0 is now
**6 mm below the thick sheet's top**, and the bed is at Z = −12 from this datum.

- **The program still cuts to Z = −18.** That is **6 mm into the spoilboard, over the
  entire program, on both sheets.**
- **`check_stock_depth` cannot see it.** It compares `path.min_z` (−18) against
  `−(thickness + allowance)` = −18.3 (`core/src/post_grblhal.rs:206`) and passes. The
  check is against the **declared** thickness, never against the **probed** datum, and
  those are different facts the moment there is more than one candidate surface.
- 🔴 **And the worse half, which is not about depth at all: `safe_z_mm = 5.0`.** Every
  rapid is emitted at Z = +5 (`core/src/toolpath.rs:430`, `core/src/post_grblhal.rs:781`).
  The thick sheet's top is at Z = +6. **`G0 Z5` is 1 mm INSIDE the thick sheet, at rapid
  rate.** Nothing checks a rapid against a *sheet*: `check_machine_limits` checks travel,
  `check_stock_depth` checks depth, `Fixturing::check` checks **clamps**
  (`core/src/fixture.rs:207-258`). There is no keepout for "a workpiece the gantry does
  not know about", because with one sheet its top is Z0 **by definition** and a positive
  Z is air by definition.

⇒ **Verdict: CRASH.** A rapid traverse through 18 mm ply and a full-program 6 mm gouge
into the spoilboard, both with a green gate table.

### Case D — the re-probe. 🔴 **The datum can change MID-PROGRAM and no sheet is named**

`probe_after_toolchange` defaults **true** (`core/src/job.rs:119`), and a `Move::probe()`
is emitted after every tool change (`core/src/job.rs:1190-1191`). The probe runs at a
**single fixed machine XY** — `station: (machine.probe_x, machine.probe_y)`
(`core/src/post_grblhal.rs:366-367`, emitted at `:545-547`) — and then rewrites the work
zero: `G10 L20 P1 Z<top_mm>` (`core/src/post_grblhal.rs:563`).

`probe_x` / `probe_y` live on **`Machine`** (`core/src/types.rs:461-462`). With N sheets
on the bed, that one point sits over exactly one of: sheet A, sheet B, or **bare bed**.

- Station over the thick sheet, datum originally set on the thin one ⇒ the program starts
  in Case C and **switches to Case A at the first tool change**, or vice versa. Half a
  program cut on one datum and half on another, from a file that renders, posts and
  passes every gate.
- **Station in the gap between sheets ⇒ the probe touches the BED.** Z0 becomes the
  spoilboard, and every subsequent cut is one full sheet thickness too deep.

Gate **RPRB** (`gates/slicer_gate_check.mjs:105`) guards the *presence* of the re-probe —
it proves a new tool gets a new Z reference. It says nothing about **which surface** that
reference lands on, and with one sheet there was no other surface for it to mean.

⚠ Note the contrast, because it is the design precedent this decision should follow:
**`Stock::corner_plate` is already per-sheet** — *"A touch plate hooked over a corner of
THIS sheet … it is here, on the SETUP, because it moves with the sheet"*
(`core/src/types.rs:534-541`). The XY datum hardware is already owned by the sheet. The Z
datum station is not, and that asymmetry is exactly the hole Case D falls through.

### 2a. Two findings about the trap's own statement

🔴 **`Stock::z_zero_at_top` HAS NO CONSUMER. `TODO.md:1754` — *"`zZeroTop` means Z=0 is
the top of the stock"* — describes an intent the core does not implement.**

Complete census of the token across `core/`, `cli/`, `wasm/`, `web/src/`:

| site | what it does |
|---|---|
| `core/src/types.rs:532`, `:553` | field declaration and default `true` |
| `core/src/fixtures.rs:1259`, `:1472` | `StockCfg` field, and `set!(d.z_zero_at_top, st.z_zero_at_top)` |
| `web/src/App.tsx:1145` | the browser **sends** it on every plan |
| `web/src/store.ts:272`, `:377` | it is **persisted** per session |
| `web/src/App.tsx:1594` | it is part of a **saved workpiece** |

**It is written from two hosts, stored, restored, and read by nothing.** No planner, no
post, no check. Z0 is the stock top only because `core/src/toolpath.rs` emits negative Z
and `core/src/post_grblhal.rs` adds `z_offset_mm`, which is 0 unless the **CLI** flag
`--spoilboard-zero` sets it (`cli/src/main.rs:1092-1096`).

⚠ **Gate G11 does not cover this field.** G11 — *"Z-ZERO SETTING BITES: a setting consumed
by nothing reads as configured"* (`gates/slicer_gate_check.mjs:87`) — drives
`fixture rect-profile --spoilboard-zero` and asserts every Z word shifts by 18.0
(`gates/slicer_gate_check.mjs:368-384`). It exercises the **`PostOptions::z_offset_mm`
mechanism**. `Stock::z_zero_at_top` is a *different field* one struct away, and it is
sitting in exactly the state G11 was written to prevent. Gate **B2B4**
(`gates/slicer_gate_check.mjs:1533-1578`) also does not reach it — its "datum" limb drives
`stock.origin_x_mm` / `origin_y_mm`, the **XY** datum.

⇒ **#64 must not build a per-sheet Z datum on this field.** It is a stored setting that
changes no coordinate — this lane's most-repeated defect, which
`Job::plant_ignores_drawing_offset` exists to reproduce on demand
(`core/src/job.rs:96-108`, *"it restores the state this lane has shipped four times
already"*). Either wire it or delete it, in a change of its own, before it is generalised
to N sheets and shipped four more times.

🔴 **SVG intake is flipped against `stock.size_y_mm`, at read time, before any sheet is
known.** `intake_one(data, format, z_section_mm, stock)` (`core/src/fixtures.rs:3121`)
calls `parse_svg(text, stock.size_y_mm, IMPORT_TOL_MM)` (`:3203`) and
`parse_bytes(data, stock.size_y_mm, …)` (`:3183`), using the one `intake_stock(cfg)`
(`:3391`). SVG's Y axis runs downward, so the sheet height is the flip term.

⚠ **This is a thickness-free consequence of multiplying sheets, and it lands in step 1 of
the plan path while placement happens in step 2** (`core/src/fixtures.rs:3489`,
`:3496-3529`). Several sheets of different **size** — which every option below permits,
since only thickness is constrained — means an SVG destined for sheet B is currently
flipped against sheet A's height, and the error is a **pure Y translation of the whole
drawing**: it looks like a correctly-shaped part in the wrong place, which is exactly the
class this lane calls a plausible-looking wrong part. ⇒ **A part's sheet must be resolved
BEFORE intake, not after.** That is an ordering constraint on the implementation, and it
is invisible from the thickness census.

### 2b. Summary — which failures are which

| case | operator declares | what happens | class | does anything catch it? |
|---|---|---|---|---|
| A | thick sheet's thickness, Z0 on thick sheet | right shape; ramp partly in air; sim + spoilboard check describe the wrong slab | **checks go blind** | no |
| B | thin sheet's thickness, Z0 on thick sheet | **neither** part cut through | **wrong part** | no — G4 passes |
| C | thick sheet's thickness, Z0 on **thin** sheet | full-program spoilboard gouge **and a rapid inside the thick sheet** | **crash** | no — G4 passes |
| D | anything, ≥2 tools | datum silently changes at a tool change, or is set on bare bed | **crash** | no — RPRB checks presence, not surface |

**There is no configuration of the existing model in which two thicknesses are safe.**
That is the finding, and it is stronger than the TODO's framing: the TODO names A and B;
C and D are the ones that reach the spindle.

---

## 3. The three options, costed

### Option 1 — several sheets, ONE thickness; refuse a mismatch, naming both

**Core changes.**

- `Job` gains `sheets: Vec<Sheet>` where `Sheet` carries the per-sheet fields that are
  already per-sheet in `Stock`: `size_x/size_y`, `origin_x/origin_y`, `rotation_deg`,
  `corner_plate`, plus a stable `id`. `thickness_mm` stays **on the job**, not on the
  sheet, because the invariant is that there is one of it.
- **One new refusal**, raised at the door of `plan_report_import_many`
  (`core/src/fixtures.rs:3421`) alongside the duplicate-id refusal (`:3520-3528`) and
  **before** any operation exists — the same position and the same reason as the overlap
  refusal (`:3645-3670`): *a rejected program that still prints G-code gets run anyway*
  (gate G13).
- `ImportSource` (`core/src/fixtures.rs:3042`) gains a **required** `sheet: String`. See §5.
- The interference check must be **scoped per sheet** — see §5, this is the one real trap.
- `intake_one` must take the drawing's own sheet, per §2a's SVG finding.
- **Not touched:** all 27 reads in §1a. `plan_operation` keeps its single `&Stock`
  signature; `Report` stays one program; the sim, the spoilboard check, `clearance_z` and
  the depth clamp are all still correct, because with one thickness the tops are coplanar
  and every Case in §2 collapses to the single-sheet case.

**What the operator sees.** Add a second workpiece; the thickness field is the job's and
applies to all of them. Declaring a different thickness is **refused by name**: both sheet
ids, both thicknesses, and the reason. A refusal an operator can act on in ten seconds —
put a different board on, or run it as a second job.

**What breaks.** Nothing that works today. The genuine costs are: (a) the false-red risk
in the scoped overlap check if it is *not* scoped (§5); (b) mixed-thickness work is simply
not expressible, which is the point.

**The gate.** New HARD gate **SHEET**, with **both limbs**, because MULTI's own row says a
refusal test with no positive beside it *"is indistinguishable from a working check until
the day somebody needs two parts on a sheet"* (`gates/slicer_gate_check.mjs:102`):

- *negative* — two sheets, different thickness ⇒ `ok == false`, `gcode` **empty (0 bytes)**,
  a refusal naming both ids and both numbers;
- *positive* — two sheets, same thickness ⇒ a program emits, and a part on sheet 2 appears
  in it at sheet-2 coordinates;
- *plant* — `--plant mixed-thickness-unchecked`, inverted polarity exactly like MULTI's
  `overlap-unchecked` (`core/src/fixtures.rs:3421`, `:3634-3644`; gate limbs at `gates/slicer_gate_check.mjs:965-1055`): the plant
  **skips the check** rather than faking a clean result, because skipping is the defect
  being restored.

**Cost: about a day**, and it is the day the TODO already estimates.

### Option 2 — a program per sheet, each with its own Z zero

**Core changes.** Large, and they are host-facing.

- `Job` stops being one program. Either `plan_job` returns `Vec<PlannedProgram>` or the
  host loops one `Job` per sheet. `Report` (`core/src/fixtures.rs:2319-2336`) carries one
  `gcode`, one `ok`, one `sim`, one summary — all of those become per-sheet or the report
  becomes a list.
- `wasm::plan_import_many` (`wasm/src/lib.rs:872`) and `web/src/cam.ts:823` change shape;
  the browser's single "download G-code" becomes N downloads.
- Every gate that reads "the program" reads *a* program; `I1`/`K3` browser-vs-CLI parity
  has to pick which one, or compare all of them.

**What the operator sees.** N files. **And a new obligation that does not exist today:
re-zero Z between files.**

🔴 **This option CREATES a physical failure class this tool does not currently have.** Two
files, one machine, one G54. Run sheet B's file with sheet A's zero still in force and you
are in **Case C** — the crash — with each file individually correct. The tool would be
shipping the loaded gun and calling it correctness.

⇒ If this is ever built, it is only honest with: a **per-file datum declaration in the
program header** naming the sheet and its thickness; a **refusal to emit a combined
download**; and the acceptance that **the re-zero between files cannot be gated from this
box** — it is an operator procedure, which under this lane's rules belongs on the `ops`
rung, not in a green gate here.

**The gate.** **DATUM-PER-FILE**: N sheets ⇒ N programs; each program's own header states
its sheet id and thickness; each program's `min_z` is bounded by **its own** sheet; and no
single artefact contains two sheets' motion. Assertable on the emitted text — which is the
bar this lane holds (`AGENTS.md:190`).

**Cost: multiple days, and it is mostly host work, not core work.**

### Option 3 — several sheets, mixed thickness, one program

🔴 **MUST NOT BUILD.** Recorded here so the next reader finds the reason and not just the
prohibition.

There is no Z zero that is true for two sheets of different thickness on one bed, because
Z0 is a single machine state (`G10 L20 P1`, `core/src/post_grblhal.rs:563`) and the tops
are not coplanar. Section 2 shows all four ways it fails and that **not one of them is
caught by an existing check** — G4 passes in Cases B and C, RPRB passes in Case D. A
"warning" here would be a runnable file with a note above it, which is the shape gate G13
exists to forbid.

⚠ **And the shape to watch for is not someone proposing it head-on.** It is a per-sheet
`thickness` field added to the UI and the persistence "for later", while the core still
reads `job.stock.thickness_mm` — a displayed number that changes no coordinate. That is
Option 3 arriving as a cosmetic change, and it is the fifth repetition of the defect
`plant_ignores_drawing_offset` was built to reproduce (`core/src/job.rs:96-108`).

---

## 4. Recommendation

**Build Option 1. Structure it so Option 2 is an addition rather than a rewrite. Refuse
Option 3 permanently, and refuse it in the data model rather than in prose.**

**The reason I would defend:** the founder asked for *multiple workpieces*, and the
overwhelmingly common shop case — several boards of the same 18 mm ply — is fully served
by Option 1 at one day's cost, with **all 27 consuming reads left untouched and correct**,
because with one thickness the sheet tops are coplanar and every failure in §2 collapses
back to the single-sheet case that is already gated. Option 2 buys mixed thickness at the
price of a multi-file, multi-datum workflow whose **only** new failure mode is one this
box cannot gate — an operator forgetting to re-zero — and this lane's rule is to refuse
rather than approximate. Paying that price before anyone has asked for two thicknesses on
one bed would be buying a new class of physical failure with a feature nobody requested.

**What makes it "structured for Option 2" rather than merely cheap:** `thickness_mm`
lives on the **job** with the invariant *all sheets equal, or refused*, while every other
per-sheet fact — size, datum, rotation, corner plate, material — moves onto `Sheet` now.
Option 2 then becomes *relax one invariant and emit per sheet*, not *re-model the domain*.
A `Sheet` that carries its own thickness from day one is Option 3's data model with a
validator bolted on, and validators get relaxed; a job-level thickness cannot express the
unsafe state at all. **Make the dangerous state unrepresentable, not merely rejected.**

**What I would refuse, explicitly:**

1. **Mixed thickness under one program, in any form**, including "with a warning",
   including "advanced mode", including a per-sheet thickness that is stored and displayed
   while the core reads one.
2. **Inferring a part's sheet from geometry or overlap.** See §5 — it is the
   drag-changes-sheets defect and it is silent.
3. **Building a per-sheet Z datum on `Stock::z_zero_at_top`** until that field has a
   consumer and a gate (§2a).
4. **Auto-splitting a drawing across sheets, or moving a part to the "other" sheet to
   resolve an interference.** Same rule as `fit` and `layout`: the clamps do not move with
   the parts (`core/src/job.rs:83-92`, `core/src/layout.rs:48-52`).
5. **Shipping Option 1 without the scoped-overlap gate.** Un-scoped, it refuses every
   legal two-sheet job — a false red so total the feature looks broken; scoped wrongly, it
   clears two parts genuinely stacked on one sheet. Both limbs or neither.

**Sequencing, because §2a's SVG finding constrains it:** the sheet assignment must land in
`ImportSource` and be resolved **before** `intake_one` runs, in the same change that adds
`Sheet`. Adding the sheet concept "after intake" is the version that silently mis-flips
SVGs onto the wrong Y.

---

## 5. Interaction with #31 — what its data model must carry

#31 landed on 2026-08-10 (`TODO.md:640-687`): N drawings, each with an offset and a
rotation, plus an overlap refusal before any operation exists.

**What #31 has today:**

- `ImportSource { id, data, format, z_section_mm, offset_mm, rotation_deg }`
  (`core/src/fixtures.rs:3042-3060`).
- `DrawingRef { instance, origin, name, offset_mm, rotation_deg }`
  (`web/src/store.ts:214-255`).
- `PlacedDrawing { id, parts, drawn, x_mm, y_mm, rotation_deg }`
  (`core/src/layout.rs:347-363`).

### 5a. The one field #64 needs, and it must be added to #31 *now*

🔴 **`sheet: String` on `ImportSource`, on `DrawingRef`, and on `PlacedDrawing` —
REQUIRED, never inferred, never defaulted to "the first sheet".**

`TODO.md:1772` puts it correctly: *"a part whose sheet is implied by overlap is a part that
changes sheets when someone drags it."* Concretely: with an inferred sheet, dragging a part
2 mm across a sheet boundary re-assigns it, which under Option 1 changes nothing visible
(one thickness) — and under any later Option 2 changes **which program file it is cut in**
and **which datum it is cut against**. A part that silently emigrates between programs when
someone nudges it is Case C waiting for a slow day.

**Required, not optional-with-a-default.** `ImportSource` already models this distinction
well: `z_section_mm: Option<f64>` where *"`None` = nobody chose one; the core sections at
mid-height and SAYS SO. It never silently becomes 0"* (`core/src/fixtures.rs:3053-3055`).
A sheet id has no equivalent honest fallback — "the first sheet" is a guess about where a
person put a physical board, and it is the guess that reads as a choice.

### 5b. The trap #64 sets for #31's overlap check — and it is a FALSE RED

`check_interference(parts, clearance)` (`core/src/layout.rs:655-690`) is a flat O(n²)
pairwise scan over `Vec<LaidOutPart>`, and `Layout::laid_out()`
(`core/src/layout.rs:548-560`) returns parts in **sheet coordinates** — `PlacedDrawing::frame()`
builds a `Stock` purely as a transform (`core/src/layout.rs:413-422`) and the *sheet's own*
placement on the bed is applied later, by `Job::place` (`core/src/job.rs:156-159`).

⇒ **Two parts at the same sheet-local coordinates on two DIFFERENT sheets are, to this
check, in the same place.** Two copies of `hive-super-end` — one on each of two boards, the
most obvious thing an operator will do the hour this ships — come back as a 100 % overlap
and the job is refused with **zero bytes emitted**.

**So the check must be scoped by sheet.** Group `laid_out` by `sheet`, run
`check_interference` within each group, and **never across groups**. Two limbs in the gate,
because each without the other is worthless:

- same sheet-local coordinates, **different** sheets ⇒ **emits** (no false red);
- same sheet-local coordinates, **same** sheet ⇒ **refused**, `gcode` empty (MULTI's
  guarantee intact).

⚠ Do **not** "fix" this by placing parts into bed coordinates before the check. That
composes the sheet's own datum and rotation into the comparison, and the result is a check
that changes verdict when a *sheet* is dragged — which is gate **DINV**'s exact failure
(`gates/slicer_gate_check.mjs:104`) one object along.

### 5c. Two smaller consequences

- **`PlacedDrawing::frame()` returns `Stock::default()` with the size/origin/rotation
  overwritten** (`core/src/layout.rs:413-421`) — so it carries `thickness_mm: 18.0`
  (`core/src/types.rs:547`) that nothing reads. Harmless today. **The moment a sheet
  carries a thickness, that default becomes a live wrong number in a struct whose whole
  purpose is to be a transform.** If `Sheet` is introduced, `frame()` should return a
  narrow transform type, or its thickness must be asserted-unread.
- **`Layout::extent()`** (`core/src/layout.rs:573-575`) unions **every** part on **every**
  drawing. With N sheets that union spans sheets, so the sheet-fit question it feeds
  (`TODO.md:675-679`, already recorded as *not asked by the planning path*) becomes
  meaningless rather than merely unasked. Scope it per sheet at the same time as the
  interference check, or state in the row that it is now unscoped.

---

## 6. What a clone must copy

The founder's ask is right-click **delete / clone** on the workpiece
(`TODO.md:1734-1735`).

🔴 **The declaration already exists as a type, and #64 should clone THAT, not the mesh.**
`SavedWorkpiece` (`web/src/App.tsx:411-419`) and `currentWorkpiece()`
(`web/src/App.tsx:1585-1596`) already bundle:

```
stockX · stockY · thickness · material · originX · originY · rotation · zZeroTop
```

with its own comment stating the rule: *"Placement is part of it: a sheet restored WITHOUT
its placement is a different setup wearing the same name"* (`web/src/App.tsx:1583-1584`).
**That is the clone payload.** Cloning anything narrower re-opens a defect this lane has
already closed once for saved workpieces.

| field | copy? | why |
|---|---|---|
| `thickness` | **must** | Under Option 1 it is the job's, so a clone cannot diverge — which is the invariant doing its job. Under any Option 2, a clone that drops it lands in Case B or C. |
| `material` | **must** | See below. |
| datum (`originX`/`originY`) | **must — but it must then be CHANGED** | See below. |
| `rotation` | **must** | `Stock::rotation_deg` *"rotates the PROGRAM, not the picture"* and decides whether a job is refused for travel (`core/src/types.rs:521-528`). A clone that drops it is a differently-shaped program wearing the original's name. |
| `size_x`/`size_y` | **must** | It is the same board. Also the SVG flip term (§2a). |
| `zZeroTop` | copy for consistency | It changes nothing today (§2a) — copy it so the clone is field-equal, and do not build on it. |
| `corner_plate` (`core/src/types.rs:541`) | **must**, when it exists | It is *"hooked over a corner of THIS sheet"* and moves with it. ⚠ Measured: the browser **never sends it** — no `corner_plate` key exists anywhere in `web/src/` outside comments (`web/src/touchplates.ts:7`, `:165`) — so today a clone cannot lose it because nothing can set it. That will change. |
| **the parts on it** | **NO — and this is a decision, not an omission** | See below. |
| **the sheet id** | **must be NEW and distinct** | See below. |

🔴 **Material: the brief's warning is right about the consequence and the field is
somewhere else, which makes it worse.** *"A clone copying the box but not the material
silently re-derives every feed from a different chipload"* — the mechanism is
`feed_for(t, rpm, m) = rpm * flutes * chipload_mm * m.chipload_factor()`
(`core/src/tools.rs:689-690`), applied once per job at `core/src/job.rs:1053-1057`, along
with `max_doc_ratio()` bounding depth per pass (`core/src/job.rs:1061-1072`) and
`max_rpm()` bounding the spindle (`:1073`). Aluminium's chipload factor is 0.35 against
plywood's 1.0 (`core/src/tools.rs:794-799`).

**But `material` is a field of `Job`, not of `Stock`** (`core/src/job.rs:33`,
`JobConfig.material` at `core/src/fixtures.rs:1556-1566`). So today **two sheets of
different material cannot be expressed at all** — ply and MDF on the same bed would both be
fed at whichever one is declared. Under Option 1 this is coherent (one material, like one
thickness) **provided it is refused rather than silently shared**; the moment material
moves onto `Sheet`, `job.rs:1053`'s single-material loop has to become per-operation, which
is the same signature change §1b describes for thickness. ⇒ **Keep material on the job in
Option 1, and refuse a second material by name**, exactly like thickness. Do not let it
onto `Sheet` as a display field.

🔴 **The clone's DATUM must not equal the original's, and the clone must not choose the new
one.** Two sheets at the same `origin_x/origin_y` are two boards in the same place — which
is #31's overlap failure at the sheet level, and a clone is the single easiest way to
produce it. **This tool does not move things to be convenient**: `fit` reports a datum shift
and refuses to apply it, `layout` grades a placement a human chose, and #65's copy lands on
top of the original and is then **refused**, deliberately (`TODO.md:1807-1815`). The clone
should follow that precedent exactly — **land coincident, refuse, and say "MOVE ONE OF THEM"**
— rather than inventing an offset. Consistency here is not tidiness: a clone that auto-offsets
while a drawing-copy refuses teaches the operator that the software sometimes moves things,
which is the belief that makes every other refusal negotiable.

🔴 **The parts do NOT come with the clone, and the reason is that a part is an INSTANCE.**
#65's finding is the whole argument (`TODO.md:1780-1805`): a part is keyed by its instance,
never by the drawing it points at, and *"anything keyed on `origin:name` collapses them into
one."* A clone that carried its parts would have to mint new instance ids for them —
inventing N objects from one gesture, each of which the operator must now find and place.
⇒ **Clone the sheet empty**, and let the operator add drawings to it (or use the existing
`⧉` drawing-copy control, `TODO.md:1817-1820`, then set the copy's `sheet` to the new one).
**One gesture, one object.**

🔴 **A distinct id, for the same reason clone-a-clamp needs one** (`TODO.md:1901-1903`):
every refusal this decision adds names its sheet — the mixed-thickness refusal names both,
the scoped overlap check names which sheet a pair is on, and a per-file datum header (Option
2) names one. **Two sheets called `sheet-1` make every one of those refusals ambiguous
precisely when the operator is trying to act on it.**

**The gate.** Assert on the **emitted program**, never on the state object
(`AGENTS.md:190-198`): clone a sheet, put an identical drawing on each at identical
sheet-local coordinates, and assert the two parts appear in the G-code **at different bed
coordinates differing by exactly the datum delta** — and that a clone left coincident is
**refused with zero bytes**. A test that compares two JavaScript objects field-by-field
proves the copy function copies; it proves nothing about what the machine does.

---

## 7. UNKNOWN — what I could not determine, and what would settle it

1. **UNKNOWN: whether the 48 declared gates currently pass.** Not run — a gate run was
   likely in flight and collides on port 4173. *To find out:* `node gates/slicer_gate_check.mjs`
   on a quiet box. Everything above is read from source, so no claim here depends on it.
2. **UNKNOWN: the real count of `thickness_mm` reads in `web/src/`.** The census in §1 covers
   `core/`, `cli/` and `wasm/` only. `web/` has its own uses (`web/src/Viewport.tsx:1672`,
   `web/src/App.tsx:1303`, the materials catalogue at `web/src/materials.ts:62`) which are
   presentation, but I did not enumerate them to the same standard and will not assert a
   number. *To find out:* the same brace-matched census over `web/src/`, minus `*.spec.ts`.
3. **UNKNOWN: whether the probe station falls on a sheet TODAY, with one sheet.** Case D's
   "probe touches bare bed" hazard is not created by #64 — `machine.probe_x/probe_y`
   (`core/src/types.rs:461-462`) is a machine coordinate and nothing checks it against the
   sheet footprint. N sheets makes it far more likely and adds the mid-program-datum-change
   variant. *To find out:* whether any existing check compares `(probe_x, probe_y)` against
   `Stock::place`d sheet corners — I found none, but an absence claim over a 26k-line core
   deserves a second reader. **This is worth its own TODO item regardless of #64.**
4. **UNKNOWN: what the founder means by "workpiece" in the right-click ask** — the sheet, or
   the part on it. §6 assumes the **sheet**, because `panel-stock` is titled "Workpiece"
   (`web/src/App.tsx:3054`) and `SavedWorkpiece` is the sheet declaration. If he means the
   part, #64's UI half is already served by #31/#65 and only the model half of this memo
   applies. *To find out:* ask, in one line, before building the menu.
5. **NOT DETERMINED HERE: the right-click / camera-pan conflict.** `TODO.md:1741-1743` and
   `:1889-1890` both flag that right-click currently pans, and #65 requires the **same**
   context-menu mechanism. That is a UI decision, it is not the model decision this memo was
   asked for, and building the menu twice is the failure mode both items already name.

---

## 8. One-line summary for the TODO row

> **#64 model decision: Option 1 — N sheets, ONE thickness, mismatch refused by name.**
> `thickness_mm` stays on the `Job` (making mixed thickness unrepresentable, not merely
> rejected); every other per-sheet fact moves onto a new `Sheet`; `sheet` becomes a
> **required** field on `ImportSource` / `DrawingRef` / `PlacedDrawing`; the #31 overlap
> check is **scoped per sheet** with both limbs gated; the clone copies the declaration,
> lands coincident and is **refused**, and brings no parts. Option 2 (program per sheet)
> stays open as a strict addition. **Option 3 must not be built** — §2 shows all four
> mixed-thickness failure modes and that G4 and RPRB pass through every one of them.
