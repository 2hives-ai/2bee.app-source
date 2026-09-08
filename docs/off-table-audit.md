# A drawing straight from CAD lands off the table — what was measured

TODO #28, audited 2026-08-09 at the artefact. Every number below came out of
`./target/release/2bee-slice` run against the files themselves, not from the
ticket text.

Machine throughout: the default, `generic-grblhal`, **600.0 x 900.0mm of
travel**. Tool throughout: the default `End Mill - Down-cut 6mm 2F`, so the
**tool radius is 3.000mm** and an outside profile puts the tool centre 3mm
further out on every side.

---

## 1. The three shipped samples, measured

`2bee-slice fit web/src/samples/<file>.dxf`

| Sample | Drawing extent (mm) | Needed with the cutter | Verdict | By how much it misses |
|---|---|---|---|---|
| `hive-super-end.dxf` | X `0.000 .. 243.000`, Y `-0.500 .. 406.500` | X `-3.000 .. 246.000` (249.0 wide), Y `-3.500 .. 409.500` (413.0 tall) | **SHIFT DATUM** `X +3.000 Y +3.500` | 3.000mm off the −X limit, 3.500mm off the −Y limit |
| `metal-nest-a1.dxf` | X `-60.000 .. 60.000`, Y `-20.350 .. 20.350` | X `-63.000 .. 63.000` (126.0 wide), Y `-23.350 .. 23.350` (46.7 tall) | **SHIFT DATUM** `X +63.000 Y +23.350` | 63.000mm off the −X limit, 23.350mm off the −Y limit |
| `hive-box-prototype.dxf` | X `0.000 .. 1522.000`, Y `0.000 .. 1091.000` | 1528.000 x 1097.000 | **WILL NOT FIT** | X over by **928.000mm** (600.000 available), Y over by **197.000mm** (900.000 available) |

Two of the three miss **only** because CAD did not put the part corner on the
machine origin, and one of those two (`metal-nest-a1`) is drawn centred on the
origin, so half of it is at negative coordinates by construction. Neither is a
drawing defect. The third is a different animal — see §4.

Each sample was checked at its `cad` source as well as at the vendored copy;
`super_end.dxf` is byte-identical to
`hardware/cad/2bee_hive/cnc_nest/super_end.dxf` and all three sources produce
the same verdicts.

## 2. What the operator is told today

`fit` was already good: it prints the drawn extent, the tool radius **and where
it came from**, the shift, the exact fields to add it to
(`Stock::origin_x_mm` / `origin_y_mm`), and four things it cannot tell you. The
`import` path is better still — `core/src/job.rs` measures the **planned path**
and pushes both a note and an `OfferedFix`.

Applying the offered shift works:

```
$ 2bee-slice import web/src/samples/hive-super-end.dxf \
    --config '{"stock":{"origin_x_mm":3.0,"origin_y_mm":3.5}}'
import: ok=true cut=26821mm deepest=-18.00mm gouge=0 tabs=85
```

## 3. 🔴 The defect this audit found: the offered shift was 2mm short, and the
sentence carrying it claimed otherwise

Same drawing, same shift, with a **5mm lead** on the profile:

```
$ 2bee-slice fit web/src/samples/hive-super-end.dxf
SHIFT DATUM — move the datum by X +3.000 Y +3.500 and the whole program fits …   ← before the fix

$ 2bee-slice import web/src/samples/hive-super-end.dxf \
    --config '{"stock":{"origin_x_mm":3.0,"origin_y_mm":3.5},"op":{"lead_mm":5.0}}'
note: … move the datum by Y +2.000 and the whole program fits …
error: move outside Y travel: -2 (allowed 0 .. 900)
```

The operator is told `+3.500`, moves the workpiece relative to the clamps by
exactly that, and is refused again. The real requirement was `+5.500`. **Two
physical moves for one fit**, and the second one is the dangerous kind: the
datum is the part's position relative to the clamps, and P7's failure is a
toolpath through a clamp.

The same defect has a worse form. A drawing sitting inside travel *on its
outline* answers **ALREADY INSIDE** while the planned job is refused for
travel — a false green on the check that keeps the gantry out of its own frame.

**Cause.** `plan_datum_shift` is handed a *drawing* extent plus a radius; leads,
lead-outs and ramp entries are cut **outside** that outline and are not in it.
`plan_datum_shift_for_toolpath` is handed the planned path and everything is in
it. The two produce **different numbers for the same job**, and until now both
came back wearing the sentence *"and the whole program fits"*.

The CLI *did* carry a hand-written caveat about this in its own printout — but
prose in one host is not a property of the value. The browser asks the same
question through `wasm::plan_placement` → `Layout::plan_placement` and had no
such text at all.

**Fix (`core/src/placement.rs`).** Every `Placement` now carries an
`ExtentBasis`, on the `EstimateBasis` precedent already in this core:

* `ExtentBasis::Drawing { tool_radius_mm }` — subject *"the drawing's outline"*,
  and the answer says in its own words that it is a **FLOOR**, that lead-ins,
  lead-outs and ramp entries are not counted, and that the planned job can still
  be refused for travel.
* `ExtentBasis::PlannedPath` — subject *"the whole program"*, and it says the
  measurement is the **plan**, not the posted text.

The basis is decided by **which function was called**, never inferred from
`tool_radius_mm == 0.0` — one number answering two questions is exactly how a
drawing-basis answer would end up wearing a planned-path label.

The instruction a person acts on is unchanged: `move the datum by X +3.000
Y +3.500`, the `Stock::origin_*` fields, and *"check the clamps first"*.

## 4. 🔴 `hive_box_prototype.dxf` is not a cut file, and no machine size makes it one

Its own generator says so —
`hardware/cad/export/generate_hive_box_dxf.py`, first line of its docstring:

> *"Generate DXF drawing for EPS prototype hive box **quote**."*

It lays out **four views side by side** (`PLAN_OX,PLAN_OY = 0, EXT_H+300`;
`SIDE_OX = EXT_W+160`; `DET_OX = EXT_W+160+EXT_L+160`) on `OUTLINE`, `DIMS` and
text layers. Measured in the file: **12 `DIMENSION`, 21 `TEXT`, 5 `LWPOLYLINE`,
54 `LINE`**. The 1522 x 1091 extent is the *sheet layout of a drafting
drawing*, and `1091 = PLAN_OY(544) + EXT_L(547)` exactly.

So the WILL-NOT-FIT is correct, and **"the cheapest fix is a default machine
that fits them" would have been actively harmful here.** Measured:

```
$ 2bee-slice import web/src/samples/hive-box-prototype.dxf \
    --config '{"machine":{"travel_x_mm":2000,"travel_y_mm":1500},
               "stock":{"size_x_mm":1600,"size_y_mm":1200,
                        "origin_x_mm":3,"origin_y_mm":3}}'
import: ok=true cut=NaNmm deepest=-18.00mm gouge=0 tabs=24
→ 1588 lines of G-code, 5 sections, 4 "parts"
```

Those four "parts" are the four **view outline rectangles of a quotation
drawing**, and the program cuts them 18mm deep. Enlarging the machine converts
a correct refusal into a green program that cuts a drawing.

## 5. 🔴 And in that same program: 144 `G1 XNaN YNaN` blocks, reported `ok=true`

Reproduced minimally with `ezdxf` — one closed `LWPOLYLINE` whose **last vertex
repeats its first**:

| DXF | Result |
|---|---|
| `add_lwpolyline([(0,0),(455,0),(455,547),(0,547),(0,0)], closed=True)` | **36 `G1 XNaN YNaN`**, `ok=true cut=NaNmm`, **tabs=0** |
| `add_lwpolyline([(0,0),(455,0),(455,547),(0,547)], closed=True)` | 0 NaN, `cut=24422mm`, tabs=28 |

That first form is exactly what
`hardware/cad/export/generate_hive_box_dxf.py::rect()` writes — it appends the
start point **and** sets `closed=True`, so every rectangle it emits carries a
zero-length segment.

**Why nothing caught it.** `Toolpath::recompute_bounds` accumulates with
`f64::min` / `f64::max`, and those return the *other* operand for `NaN`. A NaN
move therefore never widens the bounding box, the box stays perfectly finite,
and the travel-limit check — the whole subject of this ticket — is blind to the
one move that cannot be machined. `is_runnable()` stays true and the summary
reports `cut=NaNmm` beside `ok=true`. `tabs=0` says the part is not held at all
and P1 did not fire either.

**What was done here, and what was not.** `Extent::from_toolpath` and
`Extent::from_points` now refuse a non-finite input rather than returning a
confident extent of everything except it — an extent is a claim to have bounded
what it was given. ⚠ **That stops this module vouching for the program; it does
not fix the program.** `plan_datum_shift_for_toolpath`'s callers treat `None`
as *"nothing to say"*, so the effect at `core/src/job.rs` is silence rather than
a refusal. The real defect is upstream of this file and needs its owners:

* whatever turns a zero-length segment into `NaN` coordinates (offset /
  `toolpath.rs`) — it should refuse the degenerate segment by name;
* `Toolpath::recompute_bounds` (`types.rs`) — a `NaN` must not be silently
  dropped from a bounding box;
* the post / `is_runnable()` — a program containing a non-finite word must not
  be emitted, and `cut=NaN` must not sit beside `ok=true`.

## 6. Upstream, for `cad`

1. **`generate_hive_box_dxf.py::rect()` writes a duplicate closing vertex on a
   `closed=True` polyline** (§5). Every rectangle in that file carries a
   zero-length segment. `closed=True` already closes the loop; the repeated
   point is redundant and is what our engine turns into `NaN`. Our engine is
   also wrong to produce `NaN` — this is a defect on both sides.
2. **`hive_box_prototype.dxf` is a quotation drawing, not a CAM file** (§4) —
   four views, dimensions and text. It is a fine sample *for demonstrating that
   annotation is named and not cut*, which is what `web/src/samples/index.ts`
   says it is for; it is not evidence about what the CAM chain does to a cut
   file, and no ticket should treat its refusal as a fit problem.
3. **NOT a defect:** the origins of `super_end.dxf` (X `0 ..`, Y `-0.5 ..`) and
   `metal_nest/out/A1.dxf` (centred on the origin). CAD is right not to put a
   part corner on the machine origin, and the −3 / −3.5 on `super_end` is
   entirely the tool radius. Nothing upstream should be changed to make our
   travel check happier.
4. Noted, not raised: `hive_box_prototype.dxf` also reports **6 contours that
   did not close** on import. In a drafting sheet that is expected (they are
   detail leaders and section marks). In a `*_wcnc.scad` cut file it would not
   be.

## 7. What this audit did NOT do

* It did not enlarge the default machine, and §4 is the measured reason.
* It did not apply a datum shift anywhere. `fit` reports and `layout` grades;
  the clamps do not move with the parts.
* It did not add a rotation limb to `WillNotFit`. A quarter turn of the sheet
  is a different question (`Stock::rotation_deg`), and none of the three samples
  would be helped by one — `hive-box-prototype` needs 1528 x 1097 either way.
* It did not fix the `NaN` program (§5) — those files belong to other lanes and
  were being edited concurrently.
* Nothing here has been run on a controller or cut anything.

---

### Reproducing

```bash
cargo build --release
./target/release/2bee-slice fit web/src/samples/hive-super-end.dxf
./target/release/2bee-slice fit web/src/samples/hive-box-prototype.dxf
./target/release/2bee-slice fit web/src/samples/metal-nest-a1.dxf

# §3 — the shift that was 2mm short
./target/release/2bee-slice import web/src/samples/hive-super-end.dxf \
  --config <(echo '{"stock":{"origin_x_mm":3.0,"origin_y_mm":3.5},"op":{"lead_mm":5.0}}')

# §4/§5 — the bigger machine, and what it buys
./target/release/2bee-slice import web/src/samples/hive-box-prototype.dxf \
  --config <(echo '{"machine":{"travel_x_mm":2000,"travel_y_mm":1500},
                    "stock":{"size_x_mm":1600,"size_y_mm":1200,
                             "origin_x_mm":3,"origin_y_mm":3}}') | grep -c NaN
```
