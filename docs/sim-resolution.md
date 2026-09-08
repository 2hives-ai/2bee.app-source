# What the material-removal simulation gets wrong, measured

Measured 2026-08-09 against the **analytic** swept region — not against another
run of the same code. Every figure here is produced by an assertion in
`core/src/sim.rs::precision_tests` or
`core/src/fixtures.rs::stock_surface_tests`, so a number that stops being true
fails a test rather than sitting in a document.

This exists because TODO #46 found the on-screen note describing only *one* of
the simulation's errors, in a way that read as if it had covered the rest.

---

## The short version

| where | direction | how much |
|---|---|---|
| the raw height map, at its own cell | **never over-reports** — it is a point sample, an INNER approximation | a 6.00mm cutter's slot reads **5.4–6.0mm** at the default 0.6mm cell |
| the raw height map, at its own cell | can MISS removal, but only at the extreme edge of a cut | **≤ 0.0038mm** inside the band at 0.6mm cells; **≤ 0.20mm** at 3mm cells |
| the DRAWN surface, after reduction to the display cell | **never under-reports** — a strict dilation | a 6.00mm hole draws **9.0mm** (**+50%**) at the shipping 3.0mm display cell |

🔴 **The premise of TODO #46 is half right, and the half it gets wrong is the
one that matters.** The oversize, square-cornered surface is real — but it is
made by `fixtures::stock_surface_of`, **not** by the height map. The height map
itself errs the other way, and that is the direction that can hide material.

---

## 1. The raw map is an inner approximation, not an outer one

`HeightMap::stamp` lowers a sample only when the tool centre passed within
`radius` of **that exact point**. The sample is a point, not a square, so the
set of lowered samples is a *point sample* of the true swept region.

Swept over 192 straight cuts — cells 0.3 / 0.6 / 1.0 / 3.0mm, cutter radii 1.5
and 3.0mm, headings 0° and 30°, and every sub-cell offset of the cut relative to
the grid — against `dist(sample, segment) <= r`:

```
false positives (map says removed, the tool never reached it):   0   in every case
false negatives (the tool reached it, map says untouched):     present, and bounded
```

`the_map_never_marks_material_the_tool_did_not_reach` asserts the first line
over **207,645** lowered samples, with a floor on the sample count so a vacuous
pass cannot look like a green.

**Consequence for the width an operator would measure.** Counting removed
samples across a slot cut by a Ø6.00mm cutter at the default 0.6mm cell, over
every sub-cell offset:

```
narrowest 5.4mm   widest 6.0mm    (never wider than the cutter)
```

The 5.4mm case is a sweep exactly tangent to a row of samples, dropped by the
`<= r*r` comparison in floating point — a real **10% narrow** reading at the
shipping default. Pinned by
`the_raw_map_draws_a_slot_no_wider_than_the_cutter_and_sometimes_narrower`.

⚠ **Do not turn this into an area claim.** Counting removed samples and
multiplying by `cell²` is a quadrature whose error is O(perimeter × cell) and
goes in **both** directions: on an 80mm cut with a Ø6mm cutter at the 0.6mm
cell it came out **9.3% BELOW** the true swept area (460.8 vs 508.3 mm²) at the
worst offset. Sample count × cell² is not a bound on anything and no assertion
here rests on it.

## 2. The miss is bounded, which is why it cannot hide a gouge

The sweep is stamped at points `stamp_step_mm(cell) = cell/2` apart, so the
union of stamped discs scallops between them. A sample at perpendicular
distance `p` has its nearest stamp within `step/2` along the path, so the
deepest a missed sample can lie inside the band is

```
edge_miss_mm(r, cell) = r - sqrt(r² - (step/2)²),   step = max(cell/2, 0.05)
```

| cutter r | cell | bound | worst miss measured |
|---|---|---|---|
| 3.0mm | 0.6mm | 0.0038mm | 0.0019mm |
| 1.5mm | 1.0mm | 0.021mm | 0.016mm |
| 1.5mm | 3.0mm | 0.201mm | 0.196mm |

`a_missed_sample_lies_only_at_the_very_edge_of_the_cut` asserts every miss is
inside the bound. **The interior of a cut is never missed**, which is the
property that keeps a real gouge visible — a gouge worth the name penetrates a
keep region by far more than 0.0038mm, and `check()` already shrinks keep
regions by a full cell before testing them.

`the_stated_bound_is_the_step_the_sweep_actually_uses` pins `edge_miss_mm` to
the step `simulate` actually walks with, because the bound is a fiction the
moment the two disagree.

## 3. The oversize surface is made by the display reduction

`fixtures::stock_surface_of` reduces each `k × k` block of simulation samples to
its **deepest** member, `k = round(display_cell / sim_cell)`. Taking the deepest
is a strict dilation: the output can never be shallower and the drawn footprint
can never be smaller. **This is the one place "never under-reports" is true.**

A Ø6.00mm hole, simulated at 0.6mm and reduced:

| display cell | k | drawn width | error |
|---|---|---|---|
| 0.6mm | 1 | 6.0mm | exact |
| 1.2mm | 2 | 7.2mm | +20% |
| **3.0mm (what the app ships)** | 5 | **9.0mm** | **+50%** |

Asserted by `a_coarse_display_cell_draws_a_hole_oversize_and_never_smaller`,
which reproduces the TODO #46 table from the code rather than from the ticket.
The general bound is `2 × (display_cell − sim_cell)` — **4.8mm** at the shipping
pair — carried as `Precision::display_widening_mm`.

**And the corners are the cell grid, not the cutter.** A round hole spanning 3
display cells cannot be round; it is drawn as 3 squares.

## 4. Why a through hole can be seen through

A height map is **single-valued**. It holds one surface per cell and can express
*"removed down to here"* but not *"no material here"*. A through cut therefore
appears as a **pit whose floor is coplanar with the underside of the sheet** —
on `plate.dxf` the deepest value is exactly −18.0mm with nothing below it — seen
through a workpiece drawn translucent on purpose. Nothing is wrong; the drawing
is showing what the data says, and the data cannot say "hole".

## 5. There is no single safe direction

The two finding classes want **opposite** errors:

| error | `Gouge` | `Uncut` |
|---|---|---|
| over-report removal | false alarm — **safe** | the island reads as cleared — **MISSED** |
| under-report removal | the gouge reads as untouched — **MISSED** | false alarm — **safe** |

🔴 `sim::simulate`'s doc comment asserted the opposite for its whole life:
*"Over-reporting removal means a missed island is still caught and a false gouge
is possible — the safe direction for a check whose job is to refuse."* It is
backwards. `check()` fires `Uncut` on material **still standing**; over-reported
removal is material reported **gone**, so over-reporting is exactly what hides
an island. The sentence was attached to a genuinely conservative modelling
choice — every cutter is simulated as a flat cylinder, so a ball nose or V-bit
over-reports — and that choice is conservative **for gouges only**. Corrected in
the same change that added this file.

## 6. Open, and named rather than left to be found

- **The `Sim cell` control has a minimum of 0.2mm and NO MAXIMUM**
  (`web/src/App.tsx`). At a 3mm sim cell the slot cut by a Ø6mm cutter drew
  between 3.0mm and 6.0mm depending on where it fell on the grid — **as little
  as half the true width** — and the edge miss grows to 0.20mm. Nothing refuses
  a sim cell coarser than the smallest cutter in the job, and at that point the
  counts stop meaning much. **PENDING** a decision on whether to cap it, refuse
  it, or warn — this note is not a fix.
- **The display cell is fixed at 3.0mm** (`SURFACE_CELL_MM`, `web/src/App.tsx`),
  which is the +50% row above. TODO #46 suggests making it a control.
- **Nothing has been cut.** Every figure here is geometry against geometry. No
  output of this program has been run on a machine.
