# The vocabulary — and it is the sidebar's

**Founder ruling, 2026-08-10, verbatim: *"Axes: The sheet is TURNED … use terminologies from the
left sidebar on all messages (there is no sheet!)"*.**

Every refusal, warning, note and label in this app exists to be **acted on at a machine**. An
operator standing at a running spindle has no attention spare for translating our word into the
panel's word. So there is one vocabulary, and it is the one already on their screen: the left
sidebar.

```
Machine · Spoilboard · Workpiece · Drawing · Work holding · Tooling · Operation · Verification
```

*(That is also the panel order, per the founder's 2026-08-10 ruling —
`Machine → Workpiece → Drawing → Work holding → Tooling → Operation → Verification → Import/Export`,
with `Spoilboard` between Machine and Workpiece. The order is `web/src/App.tsx`'s to change,
not this document's.)*

---

## 0. What this document binds, and what it deliberately does not

🔴 **IT BINDS PROSE. IT DOES NOT BIND IDENTIFIERS.**

| Binds | Does not bind |
|---|---|
| Refusal and warning text | Type names (`Stock`, `BelowSheet`, `Fixturing`) |
| `note` / `caveat` strings that reach a host | Struct fields and serde keys (`stock`, `sheet_id`) |
| Panel labels, tooltips, picker detail lines | `data-testid` values (`panel-stock`, `workpiece-picker-opt-sheet:…`) |
| Doc comments and code comments (they seed the next sweep) | Gate ids, fixture ids, catalogue ids (`sheet:ply-au-2700x1200`) |
| CLI human-readable output | CLI flag names (`--sheet-x`), summary keys (`below_sheet=`) |
| | Test function names |

**Why the split is absolute, not stylistic:** a serde key is a wire contract with the wasm boundary
and with every session an operator has already saved; a `data-testid` is a contract with e2e tests;
a summary key like `below_sheet=` is parsed by scripts. Renaming any of them to improve a *word*
silently breaks a *thing*. The panel labelled **Workpiece** is `testid="panel-stock"` today, and
that is correct on both counts at once.

⚠ **Corollary for a future sweep:** finding `Stock`, `sheet_id` or `below_sheet` in this tree is
**not** a finding. Finding *"the sheet is turned"* in a message is.

---

## 1. Machine

**What it is.** The physical router, and — as the only thing this crate models about it — **its
reach**: `travel_x_mm` / `travel_y_mm` / `travel_z_mm`, exposed as one named object,
`TravelEnvelope`. Also on it: the fitted collet and the spares in the drawer, the manual
tool-change time, the touch-plate thickness, and **which spoilboard is bolted to it**.

**What it is NOT.**

- 🔴 **It is not a surface.** Nothing sits on the travel envelope and nothing is cut into it.
  `TravelEnvelope` carries no origin fields and has no material.
- It is not the workpiece. A 600×900 workpiece on a 1250×670 machine is a question, not a
  contradiction — turned a quarter turn it fits.
- It is not the spoilboard. See §2 and §9.

**Older terms now wrong.**

| Retired | Say instead | Why |
|---|---|---|
| `table` | **Machine** (for the thing) / **travel** (for the reach) / **Spoilboard** (for the surface) | founder 2026-08-10 |
| `bed` | same | *"bed"* names a **surface**, and it was attached to the **reach** — two physical things wearing one name, and the name belonged to neither |
| `bed size`, `table size` | **travel** | a size that is not a size of any object |

⚠ When the machine's own structure is meant — the thing a cutter destroys itself against — say
**the frame** or **the rails**, never "the table".

---

## 2. Spoilboard

**What it is.** 🔴 **The one rectangle in this model that is made of MATERIAL.** A sacrificial
board bolted to the machine, declared as **size AND position AND thickness** in machine
coordinates. Its top face is taken to be the workpiece's underside; its underside follows from the
thickness.

**What it is NOT.**

- 🔴 **It is not the travel envelope**, and it is smaller than it and need not start at the datum.
  See §9 — this is the load-bearing one.
- It is not the workpiece, even though both are sheets of material. The spoilboard is what the
  cutter is *allowed* to go into.
- It is not assumed. `None` means **nobody declared one**, reported as **UNCHECKED**. There is
  deliberately no default board, and an absent thickness means **UNKNOWN**, never "thick enough" —
  the depth check reports **PENDING**.

**Older terms now wrong.**

| Retired | Say instead |
|---|---|
| `the sacrificial sheet` | **the spoilboard** |
| `the bed` / `the table` (when the surface under the work is meant) | **the spoilboard** |
| `waste board`, `sacrificial board` | **spoilboard** (one word, as the panel spells it) |

✅ **Kept on purpose:** `core/src/spoilboards.rs` catalogue labels such as *"MDF sheet 2400 × 1200 ×
16mm (AU standard)"*, and the phrases **sheet goods** and **full-sheet size**. Those name a
**purchasable panel product at a supplier**, not an object in the job. Rewriting a Bunnings product
line as "MDF workpiece" would make the catalogue wrong about the world. See §10.

---

## 3. Workpiece

**What it is.** **The material being cut** — thickness, size, where its corner sits on the machine,
how it is turned, what material it is made of, and whether a touch plate is hooked over one of its
corners. The panel also carries the **Material** choice, because the material caps rpm, bounds the
depth of cut and scales the chipload, so it changes the numbers every later control is expressed in.

**What it is NOT.**

- It is not the drawing. The drawing is placed **on** the workpiece; dragging a drawing moves
  geometry across the material, moving the workpiece moves the material under the geometry, and
  **only the second one takes the touch plate with it.**
- It is not the spoilboard, and it is not the travel envelope.
- It is not necessarily a sheet at all — the model is a rectangular prism of material, and the word
  "sheet" imports an assumption (that it has a fence-able edge and negligible thickness) that
  nothing in the code holds.

🔴 **`sheet` is the banned term here, in every inflection.** This is the founder's own example:
*"The sheet is TURNED"* must read *"The workpiece is turned"*.

| Retired | Say instead |
|---|---|
| `sheet`, `sheets`, `the sheet's`, `SHEET` | **workpiece**, **workpieces**, **the workpiece's**, **WORKPIECE** |
| `sheet-local`, `sheet millimetres`, `sheet datum`, `on the sheet` | **workpiece-local**, **workpiece millimetres**, **workpiece datum**, **on the workpiece** |
| `below the sheet`, `below-the-sheet cells` | **below the workpiece**, **below-the-workpiece cells** |
| `stock` (in prose) | **workpiece** — `Stock` stays as the type name |
| `the board` (when the material being cut is meant) | **workpiece** — "board" reads as the spoilboard |
| `blank`, `panel`, `material` (as a countable noun) | **workpiece** |

⚠ **`material` is still correct as a *property*** — "the material caps rpm" is right; "place the
material on the machine" is not.

---

## 4. Drawing

**What it is.** The imported geometry — a DXF, an SVG, or **one section at one Z** through an STL —
together with **where the operator put it on the workpiece**. Several drawings can sit on one
workpiece, each with its own placement, and each may appear more than once (a second copy is a
distinct row).

**What it is NOT.**

- 🔴 **A drawing is not a part.** One drawing yields **N parts** — the closed regions cut out of it
  — and the pair-clearance check compares **parts**, not drawings. Collapsing the two makes a
  two-part drawing look like one object with one keepout.
- It is not the workpiece it sits on.
- For an STL it is **a section, not the solid**. The loaded mesh is the **input**; the drawing is
  one flat outline through it at a stated Z. This distinction is safety-bearing — see §9.

**Older terms now wrong.**

| Retired | Say instead |
|---|---|
| `import`, `the import`, `imported file` (as a noun for the thing on the workpiece) | **drawing** |
| `sample`, `the sample` | **drawing** (the shipped samples are real DXF files taking the real importer path) |
| `model` / `the solid` (when the thing being cut is meant) | **drawing** — reserve *solid* for the STL **input** |
| `geometry` (as a countable noun) | **drawing** |

✅ **`part` is not retired** — it is a different, narrower word, and it must stay different.

---

## 5. Work holding

**What it is.** Everything that stops the workpiece and its offcuts from moving: clamps, cam
clamps, pressure bars, screws, tape, a vacuum table. Declared with a footprint and a height, so a
toolpath can be checked against it.

**What it is NOT.**

- 🔴 **A keepout check is not a hold-down check.** "The cutter will not hit the clamp" and "the
  clamps hold the work" are **different facts**, and only the second is about restraint. A vacuum
  table passes the first trivially and says nothing about the second. Safety-bearing — see §9.
- It is not part of the workpiece. Work holding is bolted to the machine and **does not move when
  the workpiece moves** — which is precisely why this tool reports a datum shift and refuses to
  apply one.
- Undeclared work holding is **not** "no clamps in the way". It is **unchecked**, and it warns on
  every export.

**Older terms now wrong.**

| Retired | Say instead |
|---|---|
| `fixture` / `fixturing` (in prose) | **work holding** — `Fixturing` stays as the type name |
| `workholding` (one word) | **work holding**, as the panel spells it |
| `clamps` (as the name of the whole category) | **work holding** — a clamp is one kind of it |

---

## 6. Tooling

**What it is.** The cutters available and the one assigned to each operation — diameter, flute
count and geometry, shank, length, and the collets the shop owns. Also the **tool change** cost,
which belongs to the machine and its operator rather than to a cutter.

**What it is NOT.**

- It is not the operation. The same cutter runs different operations; the same operation can be
  refused for want of a cutter.
- 🔴 **An undeclared collet is not "any shank fits".** Absent is unchecked.

**Older terms now wrong.**

| Retired | Say instead |
|---|---|
| `tools` (as the panel/category) | **Tooling** |
| `bit` | **cutter** (or **tool**, for the assigned one) |

✅ **`cutter` is deliberately kept** for the individual object. "Tooling" is the category; a cutter
is a thing you can snap.

---

## 7. Operation

**What it is.** One pass of one cutter with one intent — profile, pocket, drill, engrave — with its
depth per pass, spindle speed, feed, entry mode, tabs and offsets. A **job** is the ordered set of
operations posted as one program.

**What it is NOT.**

- It is not the job, and it is not the toolpath. The operation is the *intent*; the toolpath is
  what was *emitted*. 🔴 **Assert on the emitted program, never on the setting that was supposed to
  produce it** — this lane has been bitten by that four times.
- It is not the tool.

**Older terms now wrong.**

| Retired | Say instead |
|---|---|
| `cut` (as a countable noun for the unit of work) | **operation** |
| `pass` (when the whole operation is meant) | **operation** — a pass is one depth step within one |
| `job` (when one operation is meant) | **operation** |

🔴 **THE BANNER IS EXEMPT AND FROZEN.** `core/src/toolpath.rs` emits
`op: <name> [<tool>]` / `drill: <name> [<tool>]` via `op_banner()` / `drill_banner()`, and that
string is now **machine-readable by three consumers** — `parse_banner()`, the hold-down check and
the post's block attribution. **Its shape is not a vocabulary question and must not be changed by a
terminology sweep.** If a word inside it should change, that is a sequenced change with its readers,
raised as a ticket — never a sweep.

---

## 8. Verification

**What it is.** The checks run against **the emitted program**: the height-map simulation, the
travel-limit check, the pair-clearance check, the work-holding keepout and hold-down checks, the
spoilboard depth and coverage checks.

**What it is NOT.**

- 🔴 **Verification is not the simulation.** The simulation is **one check among several**, and it
  is a height map: *a gouge smaller than one cell is below its resolution*. Saying "the simulation
  passed" where "verification passed" is meant promotes one instrument's silence into a verdict.
- 🔴 **It is not a preview.** A picture that agrees with a program is not a check of it.
- 🔴 **PENDING is not PASS, and UNCHECKED is not CLEAN.** A check that could not run says so. An
  unchecked workpiece is not a clear workpiece.

**Older terms now wrong.**

| Retired | Say instead |
|---|---|
| `sim` / `simulation` (when the whole check set is meant) | **verification** |
| `preview` | **verification** (for the checks) / **viewport** (for the picture) |
| `clean` (as a verdict) | **clear** (checked and nothing found) or **UNCHECKED** — never blurred |

---

## 9. 🔴 The safety-bearing distinctions

**These are not style. Collapsing one of them produces a program that reads correct and destroys
something.** A future sweep, gate or refactor that merges any pair below is a defect, however
tidy the diff looks.

| # | Distinction | What collapsing it does |
|---|---|---|
| **S1** | **Travel is REACH. The spoilboard is MATERIAL. The workpiece is MATERIAL. Three different rectangles.** | The spoilboard is smaller than the travel and need not start at the datum. *"Inside the travel"* and *"over the spoilboard"* are different questions with different answers, and **only one of them is about material.** Conflating them made an intended through-cut and **a cutter descending into the machine's own frame report identically.** This is the distinction the retired word *"bed"* destroyed, and it is the one that must never be re-collapsed. |
| **S2** | **A keepout check is not a hold-down check.** | *"The cutter will not hit the clamp"* says nothing about *"what holds the work"*. A vacuum table passes the first and is invisible to the second. |
| **S3** | **Absent ≠ safe.** `None` spoilboard = UNCHECKED, not "covers everything". Absent thickness = UNKNOWN, not "thick enough". Undeclared collet = unchecked, not "any shank". Undeclared work holding = unchecked, not "nothing in the way". | Every one of these defaults in the direction that **reaches the machine**. Under-declaring costs a false red; over-declaring costs the frame. |
| **S4** | **A drawing is not a part.** | The pair-clearance check compares parts. A two-part drawing treated as one object is one keepout where two were needed — and the offcut is loose under a running spindle. |
| **S5** | **An STL section is not the solid.** | The operator expects the shape they modelled and receives one flat outline through it — which posts, simulates, gates green, and cuts **a plausible-looking wrong part.** |
| **S6** | **Moving the workpiece is not dragging the drawing.** | Both change coordinates. Only moving the workpiece takes the touch plate hooked over its corner with it; only dragging the drawing moves geometry across the material it is cut from. |
| **S7** | **Work holding does not move with the workpiece.** | Which is why a datum shift is *reported* and never *applied*, and why nothing here relocates a part to resolve an interference. |
| **S8** | **The intent is not the emitted program.** | `EntryMode` read `Ramp` while the engine emitted a vertical full-depth plunge. A control that reads the intent is green about the intent. |
| **S9** | **PENDING ≠ PASS; UNCHECKED ≠ CLEAR.** | A check that cannot run and a check that found nothing are the same colour to anyone not reading carefully. |

---

## 10. The exceptions, and why each earns one

**Rule: if a sidebar word makes a sentence worse, the sentence wins.** An exception is listed here
with its reason, so a later sweep can tell an exception from an escape.

| # | Kept as-is | Reason |
|---|---|---|
| **X1** | **`sheet goods`**, **`sheet size`**, **`full-sheet size`**, **`MDF sheet 2400 × 1200 × 16mm (AU standard)`**, **`Aluminium sheet 3000 × 1500 (AU)`** — the catalogue labels and notes in `core/src/spoilboards.rs` and `web/src/materials.ts` (`SHEET_SIZES`) | These name a **product line at a supplier**, quoted from the page they were read on with the date. The catalogue's whole discipline is that no dimension is written from memory and no label drifts from its source. "MDF workpiece 2400 × 1200" would be a claim the source does not make. |
| **X2** | **`sheet basis`** (the contested 2700×1200 / 600×900 / 2400×1200 question) | A **cross-lane term** naming a material-supply question owned by **bom + ops**, used under that name in `AGENTS.md`. It is not this lane's to rename, and renaming it here would break the link to the lanes that must answer it. Where the sentence is about **the object in the job**, say workpiece; where it is about **which panel size we buy**, `sheet basis` stands. |
| **X3** | **`sheet`** inside the retired-terms tables of *this document* | A prohibition has to quote the wrong form in order to ban it. |
| **X4** | `Stock`, `BelowSheet`, `ClampBearsOnNoSheet`, `sheet_id`, `ONE_SHEET`, `in_sheet`, `below_sheet_counts`, `--sheet-x`, `panel-stock`, `sheet:…` catalogue ids, `plan_on_a_thin_sheet` and every test function name | §0. Identifiers, wire contracts and test contracts. A rename here breaks the wasm boundary, saved sessions, e2e tests or gates — none of which an operator ever reads. |
| **X5** | **`the frame`**, **`the rails`** | The correct names for the machine's own structure. "Machine" is right for the object; when a cutter is about to go *into* it, the frame is the honest word. |
| **X6** | **`part`**, **`cutter`**, **`pass`**, **`job`**, **`toolpath`**, **`material`** (as a property) | Narrower words that name real distinctions the sidebar word would erase — S4, §6, §7, §3. |

### 10a. The rule X1 and X2 are instances of, and the one open question

**The dividing line: `sheet` may modify a SIZE or a PRODUCT. It may never name the OBJECT IN THE
JOB.** *"A researched sheet size"* is a fact about a supplier's range; *"the sheet is turned"* is a
sentence about the thing under the cutter, and that one is the founder's own example of the defect.

⚠ **This is not a carve-out invented by this document — the app already draws it, explicitly.** The
**Workpiece** picker lists both shipped catalogue rows and the user's saved setups, and
`web/src/App.tsx` states the distinction per row in its own words:

> *"A SHEET AND A WORKPIECE ARE DIFFERENT OBJECTS AND THE LIST SAYS SO PER ROW … A sheet is a
> PUBLISHED STOCK SIZE and sets two numbers; a saved workpiece is the whole setup — size,
> thickness, material, datum and turn."*

🔴 **Open, and deliberately not settled here:** the founder's ruling was *"there is no sheet!"*, said
of the axes note. Read at its widest it would also retire the picker's *"a researched sheet size"*
rows and the `SHEET_SIZES` catalogue — which would cost the app a distinction it currently makes
correctly and would put catalogue labels out of step with the supplier pages they were read from.
**This document applies the ruling to the object and leaves the product term standing**, and says so
rather than choosing silently. If the founder wants the wider reading, it is a `web/src/materials.ts`
+ `App.tsx` change owned by the lane, not a sweep.

---

## 11. How a gate could check this

Written to be mechanised, not to be admired. A future `TERM` gate would need all four legs; **any
one of them alone produces a green that means nothing.**

1. **Scope by artefact class, not by file.** Scan **string literals, `///` doc comments and `//`
   comments** in `core/`, `cli/`, `wasm/` and `web/src/`. Identifiers are out of scope by
   construction — the check must parse enough to tell `"the sheet is turned"` from `sheet_id`, or
   it will report the contracts in §0/X4 as defects and be turned off within a week.

2. **One needle per retired term, widest inflection.** For `sheet`: `sheet`, `sheets`, `sheet's`,
   `sheet-`, `SHEET`, `Sheet` — as **whole words or hyphen-joined**, so `spreadsheet` and
   `sheet_id` do not match. A term sweep cannot catch a claim that avoids the term, so the needle
   list is a floor, not a ceiling.

3. **Exceptions by explicit allowlist, keyed to the reason.** §10's rows, each scoped to the
   narrowest path + pattern that earns it — never a whole file, never a whole rule. An exception
   granted to a *name* leaks to everything that name covers; scope it to the property.

4. 🔴 **A negative control, or it is not a gate.** `--plant terminology` must insert
   *"the sheet is turned"* into a refusal message and the gate must go **RED**, asserting on the
   **VERDICT** line rather than on its own wording. A green nobody has watched go red is not a
   green. ⚠ And a plant proves **sensitivity only** — pair it with a case that must stay green
   (an X1 catalogue label, an X4 identifier) or the gate will be "fixed" by banning the exceptions.

⚠ **What such a gate would still not catch, stated rather than left to be discovered:** a message
that uses the right word about the wrong object. *"The workpiece is 18mm"* said of the spoilboard
passes every needle above. **S1 is not a vocabulary property and no term scan can reach it** —
that one is held by the type system (`Spoilboard` vs `Stock` vs `TravelEnvelope` are three types)
and by the checks in `core/src/sim.rs`, not by this document.

### 11a. One now exists, and it is deliberately narrow (2026-08-11)

**`web/tests/terminology.test.ts`**, in `npm run test:node`. It has all four legs — span
classification (STRING + JSXTEXT only), whole-word needles, a reason-keyed allowlist, and **three
negative controls plus two positive ones**. Each plant was *run and watched go red*, one failing
assertion each, green restored on revert.

🔴 **Its scope is set by the 2026-08-11 audit's hand-measured precision, not by ambition:**

| Needle | precision | in the gate? |
|---|---:|---|
| `sheet` + `bed` | **57%** | ✅ — gateable behind the allowlist |
| `table` | **37.5%** | 🔴 no |
| `stock`, `board`, `fixture`, `bit`, `blank` | **20%** | 🔴 no — four false positives per real defect |

*"A gate that fires four times per real defect gets switched off"* — so `table`, `board` and `stock`
in the swept files were adjudicated **by hand** in the same pass and are **not** guarded. That is a
standing gap, not a finished job.

⚠ **What it deliberately cannot see, stated so nobody has to discover it:** ① the right word about
the wrong rectangle (§11's own limit — the worst live instance was `Viewport.tsx`'s *"a hole through
a **board** that keeps 12mm"*, where `board` meant the **workpiece**, and no needle could have said
so); ② a claim that avoids the term; ③ **comments** — §0 binds them and they are out of the gate's
scope, so the swept files still carry retired terms in comments; ④ **every file outside the eight
that pass swept** — `web/src/cad/**`, `cam.ts`, `jobMaterial.ts`, `materials.ts`,
`samples/index.ts` hold adjudicated findings and are unguarded; ⑤ its allowlist is **line-granular**,
so a retired term added to a line that already earns an exception is invisible.

It also guards two things a term scan could not: **the corrected exemption in §13d below** (a wrong
exemption is the one error that compounds), and the `store.ts` `case 'drawings'` comment-vs-code
contradiction.

---

## 12. Provenance

| Claim here | Read at |
|---|---|
| The eight sidebar words and their order | `web/src/App.tsx` — the `title=` of each `<Section>` |
| `Workpiece` is `testid="panel-stock"` | `web/src/App.tsx` |
| Travel is reach, not a surface; "bed"/"table" retired | `core/src/types.rs` — `TravelEnvelope` doc block, founder 2026-08-10 |
| Spoilboard is size + position + thickness; absent = UNKNOWN | `core/src/types.rs` — `Spoilboard`; `core/src/sim.rs` — `SpoilboardDepth` |
| Over-declaring reaches the machine; no default board | `core/src/spoilboards.rs` module header |
| A drawing yields N parts; pairs are checked | `core/src/fixtures.rs` — `plan_nest`; `wasm/src/lib.rs` |
| An STL import is one section at one Z | `AGENTS.md` — Scope; `core/src/mesh.rs` |
| Keepout ≠ hold-down | `core/src/fixture.rs` — `HoldDownFinding` |
| Work holding does not move with the workpiece | `core/src/placement.rs`; `AGENTS.md` — Tooling |
| Intent ≠ emitted program | `AGENTS.md` — Standing rules, gate `ENT` |
| The banner is machine-readable | `core/src/toolpath.rs` — `op_banner` / `parse_banner` |
| Simulation is a height map, one check among several | `web/src/App.tsx` — Verification panel note; `core/src/sim.rs` |
| `sheet basis` is contested and owned by bom + ops | `AGENTS.md` — Lane boundaries |

---

## 13. Pass 2 — `bed`, `table`, `stock` (2026-08-11)

The first pass (`94d00671bd`) moved `sheet` → `workpiece` in seven core files and wrote this
document. This pass applied its cross-file list and then did the harder half.

🔴 **`bed` and `table` are NOT a rename, and treating them as one re-creates the defect the split
was made to end.** They were retired because they were ambiguous between two rectangles, so every
occurrence had to be read and assigned. Three destinations, not one:

| The sentence means | Say | Example moved this pass |
|---|---|---|
| the machine's REACH | **travel** | `"it is larger than the table in X"` → `"larger than the travel in X"` (`core/src/placement.rs`) |
| the SURFACE the work rests on / a height measured up from it | **spoilboard** | `"How far the clamp stands above the BED"` → `"above the SPOILBOARD"` (`core/src/fixture.rs:37`) — the arithmetic proves it: `clearance_z` computes `tallest − stock_thickness`, so the datum is the workpiece's underside, which is the board's top face |
| the OBJECT / where a thing is bolted / the coordinate frame | **the machine** | `"the clamps are bolted to the table"` → `"bolted to the machine"` (everywhere) |
| the machine's own STRUCTURE, the thing a cutter descends into | **the frame** | `"sacrificial material where there is a table"` → `"where there is bare frame"` (`core/src/types.rs:476`) |

⚠ **The two directions are not symmetric.** Mapping a `bed` to `spoilboard` where the sentence
meant the machine asserts **sacrificial material where there is bare frame** — the S1 collapse, in
the reassuring direction. Mapping it to `machine` where the spoilboard was meant costs a false red.
When in doubt this pass chose `machine`.

⚠ **A sentence can need BOTH.** Work holding is *bolted to the machine* and *stands above the
spoilboard*; both are true and they are different facts. `core/src/fixture.rs` now says each in the
place that means it.

### 13a. What moved, by surface

- **Operator-facing CLI output** — `fit`'s caveats, `layout`'s placement line
  (`"sheet on the table"` → `"workpiece inside travel"`), `layout`'s overlap refusal, `--plant list`,
  `recommend`'s caveats and header, the `usage` block.
- **Core refusals and notes** — `placement.rs`, `job.rs` (`OfferedFix` reasons, the quarter-turn
  refusal), `layout.rs`, `sim.rs`, `post_grblhal.rs`, `fixture.rs` hold-down findings.
- **Wasm doc comments and refusal constants** — including `SHEET_FIT_IS_A_DIFFERENT_QUESTION`,
  whose **name is a contract and did not move** while its body was rewritten to name **both**
  questions (workpiece fit = is the panel you bought big enough; travel fit = can the machine reach).
- **Gate titles and descriptions** — they print in `--list` and in every report, so they are
  reviewer-facing prose. **Gate ids did not move.** `MOVE` is now *"DRAGGING THE PART ON THE
  WORKPIECE"*, `MULTI` *"SEVERAL DRAWINGS ON ONE WORKPIECE"*.
- **`SLICER-GATES.md`** rows and prose, kept in step with the runner.

### 13b. New exceptions, each with the reason that earns it

| # | Kept as-is | Reason |
|---|---|---|
| **X7** | *"the simulated **stock** surface"* in `wasm/src/lib.rs` and `core/src/fixtures.rs` | It names the serde field `simulated_stock_surface` and the type `StockSurface`. §0 — the prose is naming the wire contract, and the doc's whole point is *"name it correctly downstream"*. |
| **X8** | `bed-anchored-sim` (plant id) and `BED SCANNER` (`core/src/fixture.rs:364`) | A plant id is an id (X4), driven by name from `gates/` and cited in `SLICER-GATES.md`. The scanner is **ml's proposal, quoted** — renaming another lane's proposal misquotes it. |
| **X9** | *"a controller **board**"* (`core/src/post.rs:265`, `SLICER-GATES.md` CTRL rows) and *"tool **table**"* / *"M140 bed temperature"* (`core/src/tech.rs:87`) | Different words that happen to collide. A grbl controller board and an FDM heated bed are not this model's rectangles. |
| **X10** | `2bee CNC table` / `2bee-cnc-table-mdf-18` and *"there is no table to measure"* (`core/src/spoilboards.rs`) | The **product name of the machine** `cad` designs, and a quoted `cad` ruling. |
| **X11** | Founder quotes verbatim — *"why I can't move the loaded object in the board?"* (`gates/slicer_gate_check.mjs:921`), *"I put the Hive super end … into the table but it is out of the table"* (`SLICER-GATES.md:1664`) | A quotation is a record. Correcting it would misattribute. |
| **X12** | Recorded **FAIL transcripts** in `SLICER-GATES.md` (lines ~748, ~1003–1004, ~1095) | They are evidence of what a gate actually printed on the day it went red. A transcript gets a note, never a rewrite — rewriting destroys the only record of the observed red. ⚠ **Known consequence:** `SLICER-GATES.md:1095` still reads `square to the bed` while the live message now reads `square to the machine's axes`. That divergence is deliberate and is recorded here rather than reconciled. |

### 13c. Renames that were NOT a sidebar word

Two ambiguities were removed rather than mapped, because the sidebar word would have been wrong:

- **`stock library` → `built-in library`** (`cli/src/main.rs`, `core/src/tools.rs`,
  `core/src/recommend.rs`, `core/src/fixtures.rs`). Here `stock` meant *"off the shelf"*, not the
  workpiece — but in a tool that has a `Stock` type it reads as *"a library of workpieces"*.
  ⚠ **`docs/tool-gap-long-reach-small-cutter.md:212` quotes the old CLI caveat verbatim
  (`"this core's STOCK LIBRARY"`) and is now stale. That file was outside this pass's boundary.**
- **`"a drill is on the table for it"` → `"a drill is an option for it"`** (`core/src/job.rs:1697`,
  `core/src/recommend.rs:266`). An English idiom that reads as a machine surface in this tool.
- **`"a clean sheet"` → `"a clear answer"`** (`cli/src/main.rs:404`). Both halves were retired: §8
  retires `clean` as a verdict, §3 retires `sheet`.

### 13d. 🔴 Carry-forward — `web/**` is NOT done, and this is the list

`web/**` was out of this pass's boundary (another agent was live in `App.tsx`). Measured
2026-08-11 over `web/src/**/*.ts{,x}`, excluding identifiers, `data-testid`s, `SHEET_SIZES` and the
X1 catalogue labels: **707 lines carry a retired term, 296 of them outside comments.**

| File | lines | of those, non-comment |
|---|---|---|
| `web/src/Viewport.tsx` | 214 | 36 |
| `web/src/App.tsx` | 124 | 75 |
| `web/src/workholdingShape.tsx` | 88 | 53 |
| `web/src/workholding.ts` | 56 | 50 |
| `web/src/cam.ts` | 48 | 3 |
| `web/src/touchplateShape.tsx` | 47 | 24 |
| `web/src/materials.ts` | 37 | 25 — **mostly X1, supplier product lines; check each** |
| `web/src/touchplates.ts` | 27 | 18 |
| `web/src/store.ts` | 24 | 4 |
| `web/src/run/protocol.ts` | 13 | 4 |
| `web/src/jobMaterial.ts` | 10 | 2 |
| remainder (9 files) | 19 | 6 |

🔴 **Start here — it is the founder's own example, on screen, in the axes note:**

- `web/src/Viewport.tsx:1406` — ``Axes — the sheet is TURNED: its X runs along ${sx}…``
  ⇒ **`the workpiece is TURNED`**. This is verbatim the sentence the 2026-08-10 ruling was about.
- `web/src/Viewport.tsx:1400` — `'Axes — the sheet is laid square…'` ⇒ workpiece.
- `web/src/Viewport.tsx:1415` — `'Axes — the sheet is turned to an angle that is not a quarter turn…'` ⇒ workpiece.
- `web/src/Viewport.tsx:1400/1406` also say *"measured on the board"* ⇒ **on the workpiece**.

Then, in priority order (operator-facing text before comments):

- `web/src/Viewport.tsx` — `2402` `title: 'Sheet'` ⇒ `'Workpiece'` (the label; the scene-object
  name `'stock'` at `2395`/`2640`/`3504` is an **identifier — do not move**: it is compared by
  `o.name === 'stock'` in five places and never rendered.
  🔴 **CORRECTED 2026-08-11 — this row also exempted `publishSnap('sheet', …)` as "the snap key …
  an identifier", and that exemption was WRONG.** `publishSnap`'s first argument is **display
  text**: it is interpolated into ``` `${what} snapped: …` ``` and pushed to the UI through
  `setSnapNote`, and the only other call site passes the human phrase `` `clamp ${name}` ``. It
  should have read: **`publishSnap('sheet', …)` is a LABEL and §3 binds it ⇒ `'workpiece'`** — and
  the same row should have carried the neighbouring `label: 'sheet'` in `neighboursFor`, which
  reaches the overlap **refusal** `🔴 OVERLAPS sheet — cutting one destroys the other`. Both are
  now `'workpiece'`. ⚠ **The lesson is not the two strings.** *Key-shaped* is not a property of a
  string, it is a property of what the callee does with it — so an exemption may only be granted
  after reading the **consumer**, never from the shape of the call. A wrong exemption in canon is
  worse than a missed finding: it survives every future sweep and is quoted back as authority.
  Left corrected in place rather than deleted, because a deleted exemption is indistinguishable
  from one that was never written and the next sweep would re-grant it);
  `726`, `997`, `2494` (`"a plausible sheet on a slant"`), `2028`
  (`"nothing on this sheet to measure it against"`), `5086`/`5111`/`5117`/`5118`/`5133`/`5143`
  (`bed` ⇒ machine / spoilboard — read each), `510`/`677`/`1244`/`2468`/`2488`/`2495`/`5024`
  (*"simulated stock surface"* ⇒ **X7, keep**).
- `web/src/App.tsx` — `4119`/`4120` (`"it does not follow the sheet"` ⇒ workpiece), `4155`,
  `4313` `label: 'Does it fit the machine TABLE?'` ⇒ **the machine's travel**, `4316`/`4318`
  (`"Measure your table"` ⇒ frame/rails — this one is about the physical structure), `4602`,
  `4655` (`"Below-the-sheet cells"` ⇒ below-the-workpiece), `4973`–`4975`, `4999`/`5007`
  (`title="Turn the sheet a quarter turn…"` ⇒ workpiece), `5019`/`4887` (`'stock top'` ⇒
  `'workpiece top'`), `5025`, `5069`, `5239`, `5268`, `5368`–`5382`, `5459`, `5567`–`5594`
  (`bed` ⇒ **spoilboard** for footprints and heights), `5686`/`5720`, `5742`/`5745`/`3646`/`3648`/
  `3567`/`7222` (`"I have checked the bed is clear"` ⇒ **the machine** — matches
  `Fixturing::confirmed_clear`'s core wording as moved this pass), `7097`/`7105`
  (`<span>Below the sheet</span>` ⇒ **Below the workpiece**), `7149`.
  ✅ **Do not move** `rowId('sheet', …)`, `parseRowId(…, ['sheet','saved'])`, `stock: {…}`,
  the catalogue-row wording at `4771`–`4818` (**X1/X2 and §10a — a sheet is a PUBLISHED STOCK
  SIZE; the app already draws this line correctly per row**).
- `web/src/workholding.ts` / `workholdingShape.tsx` — 103 lines, almost all `bed`. **These are the
  highest-risk file pair in the web tree**: they describe clamps standing on a surface and reaching
  over the work, so most `bed`s here are **spoilboard**, but the ones about where a clamp is bolted
  are **machine**. `workholding.ts:362` (*"the pod is below the sheet"*) ⇒ below the workpiece.
- `web/src/touchplates.ts:24` / `touchplateShape.tsx:643` — *"bolted to the table"* ⇒ **machine**
  (this pass moved the identical core sentence in `core/src/types.rs` and `post_grblhal.rs`).
  `touchplateShape.tsx:683`/`786` — *"nothing on the bed and nothing on the sheet"*, *"Z is zeroed
  on the bed"* ⇒ read each: the first is machine + workpiece, the second is **spoilboard**.
- `web/src/store.ts` — `808` (*"the sheet is empty"*), `1366`–`1367` (*"the sheet is …"*,
  *"the stock does not"*) ⇒ workpiece; `1200` (*"a different table of the same model"*) ⇒ machine.
- `web/src/cam.ts:1460`/`1471` — the doc block mirrors `wasm/src/lib.rs`, which moved this pass;
  bring it back into step (*"an empty sheet"* ⇒ empty workpiece, *"Where on the table"* ⇒ inside travel).
- `web/src/materials.ts` — **check each; most are X1.** `238` and `274` say *"longer than any AU
  table"* / *"exceeds most hobby-class table travel"* ⇒ **travel**, and those two are not X1.
- 🔴 **`web/src/wasm/twobee_cam_wasm.js` is GENERATED from `wasm/src/lib.rs` doc comments** and
  still carries the old wording (e.g. `:183` *"The program is on the table as it stands"*). It
  updates on the next `wasm-pack` build; do not hand-edit it.

### 13e. Verification of this pass

- `cargo test --workspace`: **524 core + 15 CLI + 0 wasm + 0 doc-tests, 0 failed** — identical to
  the baseline taken before the pass.
- **Two in-file assertions moved with their producer, neither weakened** —
  `core/src/placement.rs:867` (`"they do not move with the workpiece"`, paired with `:506`) and
  `core/src/placement.rs:726` (`"larger than the travel in X by 100.000mm"`, paired with `:525`).
  Both kept the full sentence; neither was shortened to a substring to make it pass.
- **One cross-file assertion moved in the same change**: `gates/slicer_gate_check.mjs:3423`
  expects the core's not-square refusal by substring, and it moved with
  `core/src/post_grblhal.rs:550` (`square to the bed` → `square to the machine's axes`). Its own
  in-file twin at `post_grblhal.rs:1727` moved too.
- The whole tree was grepped for assertions on every changed string — `gates/`, `web/e2e/`,
  `web/tests/`, `cli/`, `wasm/`, `tools/`. **Outside the files above: none.** The other hits are
  prose in `README.md`, `FUNCTIONAL-SPEC.md`, `TODO.md`, `docs/` and `web/src/`, none of which
  asserts anything.
- **Before/after measured against a PRISTINE BINARY**, built from `git archive HEAD` into its own
  `CARGO_TARGET_DIR`, never the lane's `target/`. **Every G-code surface is byte-identical** —
  all four fixtures and both `job` targets, 0 diff lines — and `report`, `job` and `import` print
  identically. Only human-readable prose moved.
