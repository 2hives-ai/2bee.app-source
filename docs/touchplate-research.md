# Touch plate research — what a small-shop grblHAL router actually zeroes against

Agent research, **read 2026-08-08**, for `web/src/touchplates.ts` and
`web/src/touchplateShape.tsx`. Every claim below carries the URL it came from
and the date it was read. No prices — purchasing is `bom`'s lane.

---

## Why this document exists

`core/src/types.rs` models a touch plate with six fields on `Machine`:
`probe_plate`, `probe_corner`, `touch_plate_mm` (the **top** thickness, feeding
Z), `touch_plate_wall_mm` (the **wall** thickness, feeding X and Y),
`probe_xy_depth_mm`, and a `probe_x`/`probe_y` position. The types file already
says the dangerous thing out loud: an X or Y probe touches with the **side** of
the cutter, so the offset carries the **tool radius**; a Z probe touches with the
tip and does not. That is why top and wall are two numbers and not one.

Two questions were open, and the research was run to settle them at real
products rather than by reasoning:

1. **TODO #40** — is a touch plate a property of the **machine** or of the
   **setup**? The code puts all six fields on `Machine`, and `ProbeCorner`'s own
   doc says the plate is *"hooked over the corner of the workpiece"*. Those two
   statements cannot both be right.
2. **Is the wall thickness publishable at all?** The app refuses an XYZ probe
   with `touch_plate_wall_mm == 0.0`. If no vendor publishes the number, that
   refusal is not a corner case — it is the default state of every plate a shop
   can buy.

Both were answered, and neither answer was the expected one.

---

## Headline findings

### 1. The workpiece/machine split does NOT follow the Z-only/XYZ split

This was the assumption going in and it is wrong. **A Z-only plate laid on top of
the stock is workpiece-referenced**, exactly as much as an XYZ corner plate is:
its datum is the top face of *this* sheet, and it moves when the sheet moves. A
machine-referenced device is one that is **bolted at a fixed spot and never
touches the work** — a tool setter.

So the property that decides the answer is **"is it fastened to the table?"**,
not **"how many axes does it do?"** Two devices in this catalogue are Z-only and
workpiece-referenced; two are Z-only and machine-referenced; every XYZ device
found is workpiece-referenced. **No XYZ device that references the machine
exists in this survey** — and that is a fact about the world, not a gap in the
search: an XYZ datum is a property of a *part*, and a machine has no part.

⇒ **The fix for #40 is a field on BOTH, and they are different fields.** See
"What this means for #40" below.

### 2. The wall thickness is published only in **software**, never by a vendor

*(Heading corrected 2026-08-09: it read "published **once**". It is now **twice**
— and the pattern is stronger for it, not weaker.)*

Of the thirteen entries, **two** carry a wall figure and **both come out of a
shipped application's defaults**:

- the **Sienci Standard Block**, at **10 mm**, read out of **gSender's shipped
  default state** — not off any Sienci drawing or product page. Sienci's own
  touch plate pages, read twice, publish no dimension at all.
- the **OpenBuilds XYZ Probe Plus**, at **10 mm** (`xoffset: 10, yoffset: 10`),
  read out of **OpenBuilds CONTROL's plate catalogue**
  (`app/wizards/probe/probev2.js:1–23`,
  <https://github.com/OpenBuilds/OpenBuilds-CONTROL>, read 2026-08-09) — not off
  any OpenBuilds drawing or product page either.

⇒ **Two figures, both 10 mm, both from software, neither on any vendor
drawing.** A second independent program agreeing is what turns this from an
anecdote into the pattern §2 claims.

Worse for the general case: gSender stores **one** `xyThickness: 10` for **all
five** of its touch plate types (`Standard Block`, `AutoZero`, `Z Probe`,
`3D Probe`, `BitZero`), while it stores a **per-type** `zThickness`. The software
that drives more of these plates than anything else treats the top thickness as a
property of the plate and the wall thickness as a property of the *shop*.

> ```ts
> probeProfile: {
>     xyThickness: 10,
>     zThickness: {
>         standardBlock: 15,
>         autoZero: 5,
>         zProbe: 15,
>         probe3D: 0,
>         bitZero: 13,
>         bitZeroZOnly: 15.5,
>     },
>     plateWidth: 50,
>     plateLength: 50,
> ```
> — `src/app/src/store/defaultState/index.ts`,
> <https://raw.githubusercontent.com/Sienci-Labs/gsender/master/src/app/src/store/defaultState/index.ts>, read 2026-08-08

**Six Z numbers, one XY number.** That asymmetry is the finding, and it is not
sloppiness: it is what happens when only one of the two numbers is ever printed
on anything.

### 3. Two shipping products have **no wall at all**, and our model cannot express either

- **Carbide 3D BitZero V2** probes X and Y **inside a bore**, not against a wall.
  Carbide's own copy: *"Uses a bore to probe in the X/Y directions so tool
  diameter doesn't matter."* gSender hard-codes the bore at **15 mm**
  (`BITZERO_BORE_DIAMETER = 15`). The cutter enters the bore and finds its
  **centre** from four touches, so the radius terms cancel instead of adding.
- **Sienci AutoZero** has a **170-degree chamfer** at the bottom of the plate and
  an `Auto` mode that **measures the tool diameter itself** — gSender's
  `get3AxisAutoRoutine` takes no `toolDiameter` argument at all, and the XY
  offsets are the fixed literals `X_OFF = 22.5` / `Y_OFF = 22.5` mm. It never
  reads `xyThickness`.

`touch_plate_wall_mm` describes **neither**. Setting it to a number for a BitZero
would be a plausible value that produces a wrong program — the exact failure the
types file warns about, arriving through the field meant to prevent it.

### 4. gSender's arithmetic is the same as ours, which is the best confirmation available

```ts
// Alter thickness for X and Y by tool diameter
const toolRadius = (diameter as number) / 2;
const toolCompensatedXY = Number((-1 * toolRadius - xyThickness).toFixed(3));
```
— `src/app/src/lib/Probing.ts`,
<https://raw.githubusercontent.com/Sienci-Labs/gsender/master/src/app/src/lib/Probing.ts>, read 2026-08-08

The offset is `-(radius) - wall`, and the standoff is `wall + retract + radius`.
That is exactly what `ProbePlate::Xyz` says it needs, arrived at independently by
the sender this lane's output is going to be fed to. **The header comment in the
same file spells out the trap in capitals:** `XY_THICKNESS - Probe plate XY
thickness - PRE COMPENSATE FOR TOOL THICKNESS`.

### 5. Triquetra's design makes the radius dependency visible in the worst way

The Triquetra FAQ tells the user to generate **a separate g-code file per bit
diameter**:

> *"the only g-code files you need to create are files for each bit diameter.
> Bit diameter refers to the maximum diameter of your bit."*
> — <https://triquetra-cnc.com/wp-content/uploads/2017/07/Triquetra%20FAQ.pdf>, read 2026-08-08

A file generated for a 1/8" bit and run with a 1/4" bit sets an origin **1.6 mm**
out on both X and Y, with nothing on screen to say so. The same FAQ gives two
more numbers we model: the search travel is capped at **1 inch (25.4 mm)** in any
direction (`probe_max_mm`), and the stock version *"will work with material as
thin as 0.22 inches"* — **5.6 mm**, which is a bound on `probe_xy_depth_mm`,
because the wall has to be engaged somewhere below the plate's top face and above
the bed.

### 6. A conductive workpiece is a hazard, not a requirement — the brief had this backwards

The question "must the workpiece be conductive?" has no useful answer for these
devices. **The TOOL must be conductive** (Sienci: *"If your tool is
non-conductive, it would not work with the AutoZero"*). The workpiece being
conductive is the **problem** case: an aluminium sheet under a bare metal plate
shorts the circuit and the probe triggers before it touches. Carbide's V2 fixes
it with hardware, not with a warning — *"uses a plastic base to insulate it from
the workpiece so it's now possible to probe conductive materials"*. So the
catalogue field is `conductiveStock: 'ok' | 'shorts' | 'unstated'`, and
`'unstated'` is the honest majority.

---

## Findings by product

### Sienci Standard Block — the only complete entry

| | |
|---|---|
| References | **workpiece** — hooked over the corner |
| Axes | X, Y and Z |
| Top (Z) | **15 mm** |
| Wall (X/Y) | **10 mm** |
| Footprint | **50 × 50 mm** |
| Tool radius | enters the offset, `-(r) - wall` |
| Continuity | banana plug into the plate, **magnet at the collet nut** |

Sources: gSender `defaultState` (above) for all four numbers; the same figures in
imperial from a user's gSender screen — *"Z thickness .59", XY Thickness .393",
Length/Width 1.968""* —
<https://forum.sienci.com/t/setting-the-z-zero-using-gsender-and-the-sienci-touch-plate/5959>, read 2026-08-08.
0.59 in = 14.99 mm, 0.393 in = 9.98 mm, 1.968 in = 49.99 mm: the same 15/10/50 mm
plate rendered through an inch conversion. The two sources agree.
The magnet/plug connection is from
<https://resources.sienci.com/view/lmk2-touch-plate/>, read 2026-08-08 — which
publishes **no dimension of any kind**.

⚠ **Datum note.** The 15 mm is the material between the plate's top face and the
**workpiece top face** — the Z term — and the 10 mm is the material between the
plate's outer reference face and the **workpiece edge**. Both are what
`core/src/types.rs` means. Neither is the plate's overall size, and no source
read publishes an overall height for this plate at all.

### Sienci AutoZero — a plate designed to remove the radius term

Top (Z) **5 mm** (`zThickness.autoZero: 5`). **No wall figure exists**: the
routine uses fixed 22.5 mm centre offsets and ignores `xyThickness` entirely.
**170-degree chamfer at the bottom of the plate** so v-bits, tapered bits and
ball noses can be used. Two probe modes: `Auto` (the plate measures the tool) and
`Diameter` (the user declares it).

The blog gives **no production footprint** — the 60×60×20 mm and 80×80×20 mm
figures in it are **design concepts**, explicitly, and are not carried into the
catalogue.
<https://sienci.com/2022/03/16/everything-you-need-to-know-about-the-autozero-touchplate/>, read 2026-08-08.

### Carbide 3D BitZero V2 — two Z numbers for one plate, and a 0.1 mm known error

`bitZero: 13` (the inset used for XYZ probing) and `bitZeroZOnly: 15.5` (the
overall thickness used when probing Z alone). gSender names them
`BITZERO_INSET_THICKNESS` and `BITZERO_PROBE_THICKNESS`. **One physical object
with two legitimate "plate thickness" values depending on which routine runs** —
our single `touch_plate_mm` cannot hold that.

Carbide 3D publishes none of it. Users measured **13.10 mm** and **15.5–15.6 mm**
and concluded *"the CM probing process assumes that the V2 probe is 13mm thick,
where as it is actually 13.1mm thick"* — a **0.1 mm** Z error baked into the
vendor's own software. Carbide staff in that thread redirected to support rather
than give a number.
<https://community.carbide3d.com/t/configuration-for-the-bitprobe-v2-thickness/45548>, read 2026-08-08.

Vendor claims, verbatim, from
<https://shop.carbide3d.com/products/bitzero-v2>, read 2026-08-08: *"Lower
profile so it's easier to probe taller projects"*, *"a magnetic ground connection
rather than an alligator clip"*, *"a bore to probe in the X/Y directions so tool
diameter doesn't matter"*, *"a plastic base to insulate it from the workpiece so
it's now possible to probe conductive materials"*, *"1/4" reference pin to
eliminate tool flutes as a source of accuracy problems"*.

### Carbide 3D BitZero V1 — known only by what V2 fixed

No dimension published anywhere read. Every V2 improvement above is a statement
about V1 read backwards: V1 is **taller**, uses an **alligator clip**, probes
**edges** (so the tool diameter *does* matter), and has **no insulating base** (so
a conductive workpiece shorts it). Recorded because a shop that owns a V1 and
reads a V2 number gets a wrong program — the two are not interchangeable and only
the second sentence of the vendor's copy says so.

### OpenBuilds XYZ Touch Probe Plus — a published size that is the wrong number

*"Size: 54mmx54mmx12mm (not including connector)"*, *"Material: Aluminum"*,
*"Machined to 0.1mm tolerance, coating thickness 2um"*, magnet for tool contact,
LEDs to indicate contact.
<https://www.makertechstore.com/products/xyz-touch-probe-plus>, read 2026-08-08,
confirmed at <https://www.3dware.ch/en/accessories/electronics/openbuilds-01900341-4-openbuilds-xyz-touch-probe-plus>, read 2026-08-08.

🔴 **The 12 mm is the OVERALL height of the block. It is NOT `touch_plate_mm`.**
Reading it as the top thickness would be the same class of error the workholding
research found in clamp heights: a real published number, measured from a datum
the code does not use. OpenBuilds' own documentation page publishes **no
dimensions at all** —
<https://docs.openbuilds.com/doku.php?id=docs:xyzprobe:start>, read 2026-08-08.

✅ **BOTH NUMBERS FOUND 2026-08-09, and not on any page — in OpenBuilds' own
software.** OpenBuilds CONTROL ships a plate catalogue whose entry for this
product is:

> ```js
> var xyzprobeplate = { xoffset: 10, yoffset: 10, zoffset: 9, name: "OpenBuilds XYZ Probe Plus", xyzmode: true }
> ```
> — `app/wizards/probe/probev2.js:1–23`,
> <https://github.com/OpenBuilds/OpenBuilds-CONTROL>, read 2026-08-09

⇒ **top 9 mm, wall 10 mm**, from the vendor's own application.
🔴 **This CONFIRMS the refusal above rather than reversing it: 9 ≠ 12.** Reading
the reseller's 12 mm overall height as the top thickness would have put the datum
**3 mm** out on every program — the exact datum error the paragraph above refuses
to make. *This document previously carried the 54 × 54 footprint and **nulls** for
top and wall; that was the correct state of knowledge on 2026-08-08 and is
superseded, not corrected.*

### Triquetra 3-axis / Onefinity 3-Axis XYZ Touch Probe

Onefinity's probe is made by Triquetra. Neither publishes a top or wall
thickness. What exists:

- **63.5 × 63.5 × 19 mm** — a **user measurement** (Tuvix72, 2023-06-26) made
  while designing a 3D-printed holder.
  <https://forum.onefinitycnc.com/t/dimensions-of-onefinity-3-axis-xyz-touch-probe/21219>, read 2026-08-08.
- Onefinity's software carries a probe height of **15.4 mm**; a user measured the
  probe at **15 mm** and was told the setting *"should match"*.
  <https://forum.onefinitycnc.com/t/touch-probe-settings/4949>, read 2026-08-08.
  **A second vendor whose shipped software disagrees with its own hardware**, at
  0.4 mm this time rather than 0.1 mm.
- Triquetra uses the **front-left corner** — *"The touch plate will still be used
  at the front left corner as always"* — which is a default in a product, not a
  law: `ProbeCorner` stays a required setting.
- Z-only use puts the plate **upside down at any location you prefer**. The same
  object is a workpiece-referenced XYZ plate in one mode and a
  put-it-anywhere Z plate in the other. **Reference is a property of the
  SETUP, not only of the device.**

### Fixed tool setters — the machine-referenced class

These are the devices that genuinely belong on `Machine`. They bolt to the table,
never touch the work, and their whole point is that they do not move when the
sheet does.

**ATO 90 mm** — *"Height 90mm"*, *"Contact Surface Diameter 20mm"*, *"Tool
Setting Travel 5.0mm"*, *"Accuracy 0.001mm"*, *"Parallelism 0.005/10mm"*,
*"Weight 1kg"*, NC (4-wire) or NO (6-wire), *"DC 10-30V, 10-20mA"*.
<https://www.ato.com/tool-setter-90mm>, read 2026-08-08.

**ATO 72 mm** — same family, *"Height 72mm"*, plus *"IP67"*, contact force
*"2.5N"*, contact material *"Tungsten steel alloy"*, cable *"1.5m"*, tool speed
*"50-200mm/min"*. <https://www.ato.com/tool-setter-72mm>, read 2026-08-08.

**NymoLabs wireless Z probe** — *"0.95 mm"* plunger travel, *"0.02 mm"*
repeatability, *"SUS304 stainless steel"* contact, CR2032 for *"Approx.3000"*
cycles, 20 m range; the transmitter has *"pre-drilled screw holes for direct
mounting on the machine"*. **Overall height and footprint are not published.**
<https://www.nymolabs.com/products/nymolabs-wireless-probe>, read 2026-08-08.

🔴 **`touch_plate_mm` means something ELSE on a tool setter.** On a corner plate
it is a thickness you subtract to reach the workpiece top. On a setter it is a
**standing height in machine coordinates** — the Z at which the setter's face
sits above the table, which is what converts a tool-length measurement into a
work offset. The same field name, two incompatible meanings, and nothing in the
model distinguishes them.

### The bed as the datum — no plate at all

For a through cut, the honest answer to *"can the touch plate go under the
workpiece?"* is **no** — the cutter cannot reach it without going through the
sheet — and the equivalent already exists in this repo as
`Stock::z_zero_at_top = false`, which zeroes Z on the **spoilboard**. This is
machine-referenced, costs nothing, and is immune to the sheet-thickness variation
`docs/materials-research.md` documents for nominal 18 mm ply. It is in the
catalogue as an entry so the picker can offer it beside the plates.

---

## The unbranded aluminium block — the plate this shop actually owns

The founder owns two generic 3-axis plates bought as marketplace listings. This
class is deliberately in the catalogue with **every dimension null** and a
`generic: true` flag, and it is the most useful entry in the file.

**Nothing is published for this class, and that is verifiable rather than
assumed.** The same physical product sold by a named vendor with a real product
page — BulkMan3D's *"Plug and Play precise XYZ Touch Probe"* — publishes
*"Manufactured from Aluminium with a premium conductive anodised coating"*, a
spring clip, compatibility with *"end mills up to 10mm"*, and a weight of
*"0.08 kg"*, and **no dimension whatsoever**.
<https://bulkman3d.com/product/xyz-touch-probe/>, read 2026-08-08.

⇒ Scraping a number off a listing would attach a figure to a batch that may not
be the batch in the drawer. **The entry asks for a caliper instead**, and the
drawing renders `MEASURE` in the warning colour where a number would go, so the
absence is visible rather than blank.

### On-screen text for the generic class — the measuring order

This is the wording that belongs beside the fields, exported from
`web/src/touchplates.ts` as `MEASURE_YOUR_PLATE` so the doc and the UI cannot
drift:

> **Measure your own plate. Two numbers, in this order.**
>
> 1. **Sit the plate on a flat offcut and hook it over the edge, the way you use
>    it.** Measure both numbers in that position, not with the plate loose in
>    your hand — the numbers are about how it registers, not about the block.
> 2. **TOP thickness → Z.** From the plate's top face down to the face resting on
>    the workpiece. This is the only number a Z-only probe uses.
> 3. **WALL thickness → X and Y.** From the outer face the cutter will touch, in
>    to the face that registers against the workpiece edge. **It is a different
>    number from the top and it is usually the larger of the two.**
> 4. **Check they are different.** If you measured the same figure twice you
>    almost certainly measured the top twice. A wall entered as the top
>    displaces every X and Y coordinate in the program, and the toolpath on
>    screen still looks right.
> 5. **Then set the XY probe depth** — how far below the plate's top face the
>    cutter drops before it moves sideways. It must clear the top leg and still
>    be on the wall.
>
> Nothing here is guessed for you. A plausible default would make the probe
> **run** using dimensions nobody measured, and the resulting error is invisible
> in the preview.

---

## What this means for #40 — the answer the catalogue produces

The split, counted over thirteen entries:

| | Workpiece-referenced | Machine-referenced |
|---|---|---|
| **XYZ** | 8 | **0** |
| **Z only** | 1 | 4 |

**The fix is a field on both, and they are not the same field.**

1. **The XYZ corner plate belongs to the SETUP.** Every XYZ device found hooks
   over a corner of the work. `probe_corner`, `probe_x`, `probe_y`,
   `touch_plate_wall_mm` and `probe_xy_depth_mm` describe *this sheet in this
   position*, and they must move when the stock moves or rotates. Saving a
   machine preset with a corner in it saves a datum that will be wrong the next
   time the sheet is laid down differently.
2. **The fixed tool setter belongs to the MACHINE**, and needs its own fields —
   a standing height in machine coordinates and a plunger travel — **not** a
   reuse of `touch_plate_mm`, which means a different physical quantity there.
3. **The plate ITSELF — the object — belongs to neither.** Its top thickness,
   wall thickness, footprint and bore are properties of a purchased item, which
   is exactly what a catalogue entry is. That is the third thing the current
   model conflates, and splitting it out is what lets a shop pick "Sienci
   Standard Block" once and have both the machine and the setup take what they
   need from it.

⇒ **Three owners, not two:** the **plate** (catalogue), the **setup** (which
corner, where, how deep), and the **machine** (whether a fixed setter is fitted
and how tall it stands). The current code has all three on `Machine`.

**And one consequence that falls straight out of Triquetra's Z-only mode:** the
same object can be workpiece-referenced or machine-referenced depending on how it
is used that day. So `references` cannot be a property of the catalogue entry
alone — the entry records what the device is **designed for**, and the setup
records what it is being **used as**. The catalogue field is the default, not the
verdict.

---

## What this app gets wrong or does not model

1. **`touch_plate_mm` defaults to `1.6`** in `Machine::default()`. Nothing in
   this survey supports 1.6 mm. The closest real Z figures are 5, 13, 15, 15.4
   and 15.5 mm. **1.6 mm is an unsourced default that will silently under-shoot
   Z by roughly 13 mm on a real plate** — and unlike the wall, it does not refuse,
   because it is non-zero. It should probably default to `0.0` and refuse, which
   is what the three XYZ fields already do and what the comment beside them
   argues for.
2. **One `touch_plate_mm` cannot hold the BitZero's two thicknesses** (13 for
   XYZ, 15.5 for Z-only), which are properties of the *routine*, not the plate.
3. **No bore model.** A bore-probing plate is not "an XYZ plate with a small
   wall"; the radius **cancels** instead of adding, and there is no wall to
   declare. Entering one as `Xyz` would demand a wall the object does not have.
4. **No "the plate measures the tool" mode.** AutoZero's `Auto` mode removes the
   radius term entirely. We always require a known radius.
5. **No plunger travel / over-travel.** Every tool setter publishes one (5.0 mm,
   0.95 mm). It is the distance the device survives being driven past trigger —
   the difference between a stopped probe and a crushed one — and we model
   nothing like it.
6. **`probe_max_mm` defaults to 30 mm.** Triquetra caps its search at 25.4 mm
   deliberately, *"to prevent it from continuing to search until it crashes into
   your limits"*. The default is in the right range; the **reason** is worth
   carrying into the UI text.
7. **No standing height for a plate, anywhere.** `Clamp` has `height_mm` and gate
   P7 uses it. A plate sitting on the stock is an obstruction of the same class —
   TODO #37 says so — and no entry in this catalogue could supply that number
   even if the field existed, because **no XYZ plate vendor publishes an overall
   height**. The one published overall height, OpenBuilds' 12 mm, is for a block
   that sits differently.

---

## What could not be sourced

| Status | Wanted | Where it stands |
|---|---|---|
| ⚠ **PARTIAL** *(was 🔴 OPEN — filled 2026-08-09)* | **Wall (X/Y) thickness** for 11 of 13 entries | Still not published by any **vendor** read. **A second figure now exists**: OpenBuilds CONTROL declares `xoffset: 10, yoffset: 10` for the *OpenBuilds XYZ Probe Plus* (`app/wizards/probe/probev2.js:1–23`, <https://github.com/OpenBuilds/OpenBuilds-CONTROL>, read 2026-08-09). ⇒ **Two wall figures exist in the world, both are 10 mm, both come out of a shipped application's defaults, and neither appears on any vendor drawing or product page.** The conclusion is unchanged and now rests on two independent programs instead of one: the wall is recorded as a *shop setting*, not a *product dimension*. **This is the finding, not a gap to paper over.** |
| ⚠ **PARTIAL** *(was 🔴 OPEN — OpenBuilds filled 2026-08-09)* | **Top (Z) thickness** for Triquetra, BitZero V1, and both generic classes | **OpenBuilds is now sourced: 9 mm**, from the vendor's own software — `zoffset: 9` on `xyzprobeplate` in OpenBuilds CONTROL (`app/wizards/probe/probev2.js:1–23`, read 2026-08-09). 🔴 **And this VINDICATES the refusal recorded above rather than overturning it:** the 12 mm reseller figure is the block's **overall** height, and **9 ≠ 12** — recording the 12 mm as the top thickness would have been **3 mm out**, exactly the datum error the workholding research catalogued for clamps. The remaining entries are still absent. |
| 🔴 **OPEN** | **XY probe depth** for every product | Not published anywhere, by anyone. gSender does not expose it as a setting either — the descent is baked into each routine. The only bound found is Triquetra's *"material as thin as 0.22 inches"* (5.6 mm). |
| 🔴 **OPEN** | **Standing height above the bed** for any XYZ plate | Not published. Only the fixed setters publish a height, and theirs is a machine-Z datum, not an obstruction height. |
| 🔴 **OPEN** | Carbide 3D **BitZero V1 and V2** official dimensions | Carbide publishes none. Both the V2 Shapeoko guide PDF (`guides.carbide3d.com`) and the Carbide Hub course page were **403 / content-free**. The only numbers in existence are user calipers and gSender's constants. |
| 🔴 **OPEN** | **Avid CNC** Auto Z & Corner Finding Touch Plate | `avidcnc.com` **403** on both the live and archived instruction pages. A search summary reports a *"nominal height of 1 inch"*; **not confirmed at a page, so it is not in the catalogue.** One unconfirmed snippet is not a source. |
| ⚠ **TOOLING** | Triquetra PDFs | Both downloaded and **did yield text** via `pdftotext` after WebFetch reported them unreadable — the FAQ's behavioural facts came from there. Worth knowing: a WebFetch "cannot parse PDF" is a tool limit, not an absent source. |
| ⚠ **TOOLING** | GitHub code search | `github.com/.../search?q=` and the REST search API both returned nothing/401. **`gh search code` worked immediately** and is what found gSender's defaults. The single most valuable source in this document was behind the tool nobody tried first. |

---

## Images — why every one of these is DRAWN

Same rule as the tool and workholding catalogues, and it now has a second reason.

**Legal:** a manufacturer's or a marketplace seller's product photograph is
copyrighted. This lane is AGPL-3.0-or-later and its §13 source offer sends the
source to every user, so a downloaded photo would travel with it. "It was on the
listing" is not a licence. **No image was downloaded.**

**And a photo cannot carry the load.** The entire subject of this research is the
difference between **two thicknesses on one object**. A photograph of an
anodised block shows a block. It does not show which face sets Z, which face sets
X and Y, that they are different numbers, or that one of them is multiplied by
nothing while the other is added to a tool radius. `web/src/touchplateShape.tsx`
draws both dimensions to scale, on the same drawing, labelled with the axis each
one feeds — which is the one thing that had to be visible.

⚠ **The clean route to a real photograph exists and is the founder's:** he owns
the plates, so he owns the photograph and can licence it in. That is separately
the better artefact, because the caliper reading and the picture can be taken in
the same minute.

---

## Route elsewhere, not here

- **bom** — if a plate is to be bought rather than measured, the **Sienci
  Standard Block is the only product in this survey whose four required numbers
  are all knowable before purchase**, and even those come out of gSender rather
  than a datasheet. That is a purchasing fact, and purchasing is bom's lane.
- **ops** — the physical rung. None of this has been checked against a plate on
  the actual machine, and the first air cut with probing enabled is where a wrong
  wall thickness announces itself.
- **pcb** — grblHAL's probe input, whether it is wired, and whether the
  controller has a **separate tool-setter pin** from the probe pin. grblHAL
  discussion #328 exists on exactly this question and it decides whether a fixed
  setter and a corner plate can both be fitted at once. Verify at the board, do
  not assume.

---

## Sources

All read **2026-08-08**.

- <https://raw.githubusercontent.com/Sienci-Labs/gsender/master/src/app/src/store/defaultState/index.ts>
- <https://raw.githubusercontent.com/Sienci-Labs/gsender/master/src/app/src/lib/Probing.ts>
- <https://raw.githubusercontent.com/Sienci-Labs/gsender/master/src/app/src/lib/constants.ts>
- <https://forum.sienci.com/t/setting-the-z-zero-using-gsender-and-the-sienci-touch-plate/5959>
- <https://resources.sienci.com/view/lmk2-touch-plate/>
- <https://sienci.com/2022/03/16/everything-you-need-to-know-about-the-autozero-touchplate/>
- <https://shop.carbide3d.com/products/bitzero-v2>
- <https://community.carbide3d.com/t/configuration-for-the-bitprobe-v2-thickness/45548>
- <https://www.makertechstore.com/products/xyz-touch-probe-plus>
- <https://www.3dware.ch/en/accessories/electronics/openbuilds-01900341-4-openbuilds-xyz-touch-probe-plus>
- <https://docs.openbuilds.com/doku.php?id=docs:xyzprobe:start>
- <https://triquetra-cnc.com/wp-content/uploads/2017/07/Triquetra%20FAQ.pdf>
- <https://forum.onefinitycnc.com/t/dimensions-of-onefinity-3-axis-xyz-touch-probe/21219>
- <https://forum.onefinitycnc.com/t/touch-probe-settings/4949>
- <https://www.ato.com/tool-setter-90mm>
- <https://www.ato.com/tool-setter-72mm>
- <https://www.nymolabs.com/products/nymolabs-wireless-probe>
- <https://bulkman3d.com/product/xyz-touch-probe/>

Refused or unreadable, recorded so they are not re-attempted blind:
`guides.carbide3d.com` (403), `us.openbuilds.com` (403), `avidcnc.com` live and
archived (403), `carbide3d.com/hub/...` (no content), `makerparts.ca` (402),
`github.com/.../search` (0 results — use `gh search code`).
