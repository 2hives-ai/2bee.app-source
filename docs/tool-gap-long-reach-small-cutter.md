# The "no tool in this library" window on `hive-super-end.stl` — measured

**Session:** `2bee_app` · **Date:** 2026-08-10 · **Status:** investigated, **no purchase recommended**

A blocked part was reported: `recommend` on the super-end sample refuses eight features with
`TOOL: NONE`, and the 51 rejections squeeze from two opposite directions — small enough to fit
but too short to reach, long enough to reach but too fat to fit. This document records what was
measured, and why the squeeze **is not a missing cutter**.

🔴 **Headline: the 18 mm depth is the section's assumption, not the part.** The eight features
are **Ø4.5 mm blind pilot holes, 12.0 mm deep**, and both a drill and an end mill that can cut
them are **already in the library**. Nothing needs buying.

---

## 1. The refusal, reproduced

```
$ ./target/release/2bee-slice recommend web/src/samples/hive-super-end.stl --json
exit 1
```

| field | value |
|---|---|
| `parts` | 1 |
| `features` | 32 |
| `library_size` | 51 |
| `stock_thickness_mm` | 18.0 |
| `material` | Plywood |
| `machine.collet_mm` | **0.0 — undeclared** |
| `unsatisfied` | `part1/inner-24` … `part1/inner-31` (8) |

Each of the eight reports:

```
kind      : pocket
depth_mm  : 18.0
geometry  : { sharp_internal_corners: 16, min_internal_radius_mm: null }
reason    : NO TOOL IN THIS LIBRARY CAN CUT THIS POCKET. 51 tool(s) were considered
            and every one broke a rule
```

### The 51 rejections, grouped (`part1/inner-24`)

| count | rule broken | tools |
|---:|---|---|
| 4 | **too short to reach** — *"N mm of cutting length cannot cut 18mm deep; the shank would be in the cut"* | Down-cut 3.175 (12 mm), Down-cut 4 (17 mm), Ball Nose 3 (12 mm), Surfacing 25 (8 mm) |
| 6 | **will not fit** — *"Dmm does not fit inside this loop; offsetting the loop in by the tool radius leaves nothing to cut"* | 6 mm ×3, 8 mm, 12 mm, Ball Nose 6 |
| 29 | *"a Drill cannot do this: its cutting geometry is on the point, not the flank"* | every drill in the library |
| 12 | *"its cutting width changes with depth, so it cannot hold a vertical wall"* | 6 countersinks, 4 V-bits, 1 chamfer, 1 engraver |

The flat/ball cutters in the library (`core/src/tools.rs:259–270`), diameter → cutting length:

```
3.175 -> 12    4 -> 17    6 -> 25    8 -> 32    12 -> 42
ball 3 -> 12   ball 6 -> 25   surfacing 25 -> 8
```

So the squeeze is exact: **4 mm fits and is 1 mm short of reach; 6 mm reaches and does not fit.**

---

## 2. The window, if the 18 mm were real

Taken at face value, the window is:

> **diameter ≤ 4.41 mm with cutting length ≥ 18 mm**

- **Upper bound on diameter.** The loop is a 16-sided polygon of circumradius **2.2500 mm**
  (measured directly off the mesh section, below). Its largest inscribed circle is
  `2 × 2.25 × cos(π/16) = 4.4135 mm`. The tool's own verdicts bracket this correctly — 4 mm
  fits, 6 mm does not.
- **Lower bound on cutting length.** 18.0 mm, which is `--thickness` (CLI default 18,
  `cli/src/main.rs:73`) applied as a through cut.

**No tool in the 51-tool library is inside that window,** and the miss is by 1 mm of flute.

⚠ **But the window is an artefact. Do not source against it.** §3 and §4 say why.

---

## 3. Are they through-features? No — they stop at 12 mm

`recommend`'s own `cannot_tell_you` says every feature is *"priced as a THROUGH cut at the stock
thickness"*. That is testable: section the same mesh at other Z and see whether the features
survive. With no `--z`, `recommend` sections at the mesh **mid-height** (`core/src/fixtures.rs:3138`),
which for this file is **z = −9.5 mm** of a solid spanning **z = −19.000 … 0.000 mm**.

```
$ ./target/release/2bee-slice recommend web/src/samples/hive-super-end.stl \
      --format stl --z <Z> --json
```

| `--z` | parts | features | unsatisfied |
|---:|---:|---:|---:|
| −1 | 1 | 42 | **16** |
| −2, −4, −6, −8, −8.5 | 1 | 40 | **16** |
| −9 | 31 | 31 | 0 *(degenerate: 58 triangles lie in the plane)* |
| −9.2, −9.5, −11, −11.5 | 1 | 32 | **8** |
| −12 | 32 | 32 | 0 *(degenerate)* |
| **−12.2, −12.5, −12.8, −13, −15, −17, −18** | 1 | 24–25 | **0 — complete** |

**The blocked features do not exist below z ≈ −12.** Sectioning the mesh independently and
measuring the loops narrows it: **8 present at z = −11.9, 0 present at z = −12.1.**

⇒ They are **blind, 12.0 mm deep from the z = 0 face** — not through a 18/19 mm panel.

Re-running with the true depth clears the part outright:

```
$ ./target/release/2bee-slice recommend web/src/samples/hive-super-end.stl \
      --format stl --z -9.5 --thickness 12 --json
complete = true, unsatisfied = 0
part1/inner-24 -> End Mill - Down-cut 4mm 2F   depth 12.0
   "nothing in this feature caps the cutter radius, so 4mm is the largest usable
    cutter in the library; 17mm of cutting length …"
```

---

## 4. What the features actually are — and why "16 sharp corners" is a lie the mesh tells

Sectioning the STL directly at z = −9.5 gives 32 loops. The eight blocked ones are:

```
centre (180.500,  32.000)  bbox 4.5000 × 4.5000  32 verts   radii { 2.2216, 2.2500 }
centre (180.500, 114.000)  …  and 136, 218, 292, 374
centre (102.500, 236.500)  …  and 273.500
```

Every vertex sits at radius **2.2500** or on the chord between two such vertices. This is a
**Ø4.5 mm circle tessellated as a 16-gon**. Its interior angle is 157.5°, and
`internal_geometry()` (`core/src/recommend.rs:176–190`) counts **any** right turn as a sharp
internal corner with no angle threshold — hence *"16 sharp internal corners"*.

**There are no sharp corners in this part. There are sixteen facets of a round hole.**

At shallower Z a second column appears (16 loops at z = −4: the same Ø4.5 at x = 225.5), which
is why the shallow sections report 16 unsatisfied instead of 8.

### The upstream source confirms it

`hardware/cad/2bee_hive/2bee_hive_super_panel_wcnc.scad` calls `autoframe_mount_pilots()` from
`hardware/cad/2bee_hive/2bee_hive_joinery.scad:227–240`:

```scad
module autoframe_mount_pilots(d = 406, w = 19, afn = 7, afp = 52, kz = 203, pd = 4.5, …) {
    // BLIND self-tap pilots: ~12mm into the ~19mm front panel, never through
    // (founder 2026-07-08: no drill-through — wood holds the ear self-tappers).
    …  translate([-1, …]) rotate([0, 90, 0]) cylinder(d = pd, h = 13, $fn = 16);
```

- `pd = 4.5` → the Ø4.5 measured. ✅
- `$fn = 16` → the 16 facets counted as "sharp corners". ✅
- `h = 13` from `x = −1` → **12 mm into the panel**, matching the −11.9/−12.1 boundary. ✅
- The pilot centres derive from `kz = 203 ± mot_dz 22.5` → 180.5 / 225.5, and
  `ctl_dz = [22.5, −100.5]` → 225.5 / 102.5 — **exactly the three columns measured.** ✅

They are **blind self-tap pilot holes for the autoframe motor and controller mounting ears**,
and the founder's 2026-07-08 rule is that they are *never* drilled through.

---

## 5. Why the drill was refused, and why that is structural

`Feature::classify` (`core/src/recommend.rs:269–275`) calls `Contour::as_circle`
(`core/src/geometry.rs:322–334`), which returns `Some` **only** for a contour of exactly two
vertices with `|bulge| = 1` — an arc-based circle. A mesh section emits straight segments and
nothing else.

⇒ **A round hole in an STL section can never be classified as a `Hole`. It is always a
`Pocket`, and every drill in the library is then refused by kind.** This is a property of the
mesh path, not of this part, and it applies to every bore in every STL anyone imports.

⚠ The DXF sample is **not** a counter-example, in either direction:

```
$ ./target/release/2bee-slice recommend web/src/samples/hive-super-end.dxf --json
exit 0 — 22 features, complete = true, unsatisfied = []
```

It clears — but it clears because it is **stale**, not because the DXF path is better. It has
**536 `LINE` entities and 0 `CIRCLE` entities**, and the smallest cutter it selects is the 8 mm:
the Ø4.5 pilots are **not in it at all**. Its file mtime is 2026-06-28, and the panel refactor
that carries these pilots landed 2026-07-01 (`98bb8c39a6`).

*(Open question for this lane, stated as a hypothesis and not asserted: if OpenSCAD's DXF export
emits circles as line segments too, then no OpenSCAD-derived drawing will ever select a drill.
That is a `2bee_app` investigation, not a sourcing question.)*

---

## 6. Conclusion

| claim | verdict |
|---|---|
| "There is a tool gap: we need a long-reach small end mill." | 🔴 **No.** |
| "These are sharp-cornered pockets a drill cannot make." | 🔴 **No** — they are Ø4.5 round holes, faceted by the mesh. |
| "They are 18 mm deep." | 🔴 **No** — 12.0 mm, blind, measured. |
| "Nothing in the 51-tool library can cut them." | 🔴 **No** — `Drill - Brad Point 4.5mm 2F` is the intended tool, and `End Mill - Down-cut 4mm 2F` also reaches 12 mm. |
| "The window `≤ 4.41 mm diameter, ≥ 18 mm flute` is unfilled by the library." | ✅ **True, and irrelevant here** — it is the window of a feature that does not exist. |

### Residuals worth someone's attention (not purchases)

1. **`--thickness` default 18 vs a 19 mm panel.** The SCAD models this panel at `w = 19`
   (`super_panel(… w = 19 …)`), and the joinery header says so; the mesh spans 19.000 mm.
   `recommend` priced every through feature at **18.0 mm**. A through cut planned 1 mm shallow
   leaves the part attached. → **`cad` + `ops`**, not `bom`.
2. **`machine.collet_mm = 0.0`.** `cannot_tell_you` is explicit: *"an UNDECLARED collet is
   unchecked, not passed."* Nothing here has verified that any recommended cutter's shank can be
   held. → needs `--collet` from **ops**.
3. **The library is not the drawer.** *"the candidates are this core's STOCK LIBRARY, not the
   contents of your drawer."* Whether a Ø4.5 brad-point actually exists in the shop is a `bom`
   fact this lane cannot read — that, and only that, is what was routed to `bom`.
4. **If a genuinely 18 mm-through feature under Ø4.4 ever appears**, the library gap in §2 is
   real and the purchase conversation restarts. Nothing on this part triggers it.

**Ticket filed:** `handover/bom/2026-08-10-2bee_app-blocked-4p5mm-pilots-no-cutter-purchase.md`
