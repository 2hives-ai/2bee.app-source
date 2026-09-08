# Workholding research — what actually holds 18 mm ply on a small CNC router

**Read and written 2026-08-08. Extended the same day** (second pass: 14 entries → 19,
4 fully sourced → 6, plus a to-scale drawing of every entry). Source of
`web/src/workholding.ts` and `web/src/workholdingShape.tsx`.

> **Second pass, in one line each.** The **Mitee-Bite Pitbull** — named here as the
> canonical low-profile machinable clamp with both its pages 403ing — **was sourced from a
> distributor mirror and is now in the catalogue with a published clamp height, force and
> throw.** A **T-slot hold-down with a published standing height** was found, closing the
> "nobody publishes the one number P7 needs" gap for one product (and showing the previous
> stand-in was **low**). A **25 mm vacuum block** joins the 50 mm pod. The **bench dog** that
> goes in the dog-hole grid is now its own entry. **Hot glue** is in, with a clean negative:
> nothing numeric about it is published anywhere. **RAPTOR nail lengths** were sourced on
> retry. Still open: the DESTACO base footprint, 3M 410M's thickness, and — newly named —
> **a holding force for any vacuum pod, which no vendor publishes at all.**

## Why this document exists

`web/src/App.tsx` shipped three workholding presets — pressure bar, cam clamps,
screws — that were **invented in this lane**. They have plausible numbers and no
provenance. A preset with a 35 mm height and no source is a claim about a real
object that nobody made: it looks like knowledge and behaves like a guess, and
gate **P7** is only as good as the geometry it is handed.

So every entry below carries **the URL it came from and the date it was read**,
and every entry whose CAM-critical numbers are *not* all published says so.

**Sourcing rules applied here, without exception:**

- No model number appears unless it was read on a page cited below.
- No dimension is written from memory. Where a manufacturer does not publish a
  number the CAM needs, the gap is listed in *What could not be sourced*, and
  the catalogue entry is flagged `generic` rather than quietly filled in.
- **No prices, anywhere.** Purchasing is `bom`'s lane. Where research surfaced
  something a shop would have to buy, it is listed under *For `bom`* at the end.

## The properties a CAM system needs — and the one the research added

The brief named four. The reading added a fifth, and it is the one most likely
to produce a confidently wrong number.

1. **Height above the bed.** Decides rapid clearance. This is what P7 protects.
2. **Footprint.** A keepout is an area, not a point. `Clamp.contains()` widens it
   by the cutter radius, so the *declared* footprint is the hardware, not the
   safety margin.
3. **Whether it obstructs at all.** Vacuum declares no keepout — and that is not
   "no obstruction", it is "the obstruction is the *sheet* and the hold is
   invisible". Gate E5 keeps those apart; a catalogue entry must not flatten
   them. See the three-state problem below, which is worse than E5's two states.
4. **What force it resists** — lift, lateral, or both. **The app has no field for
   this at all today**, which is the single most important gap this research
   found (see *What this app gets wrong*).
5. 🔴 **Which datum the published height is measured from.** Manufacturers
   publish *height above the material* (IDC Woodcraft: "0.22″ above the
   material") or *clearance under the clamp arm* (DESTACO: "height under clamp
   arm 0.65″"). `core/src/fixture.rs` wants **height above the BED**. For 18 mm
   ply those differ by 18 mm — which is more than the whole standing height of a
   low-profile clamp. `Fixturing::clearance_z()` already converts bed-datum to
   stock-top-datum correctly and says so in a comment; **the error this research
   found is one step upstream, at data entry**, where nothing converts and
   nothing warns. Every derived number in the catalogue states its arithmetic.

---

## Findings by method

### 1. Toggle clamps (vertical hold-down)

**DESTACO 210-U** — <https://www.destaco.com/210-U>, read 2026-08-08.
Published: overall length **5.54 in (140.7 mm)**, arm length **3.63 in
(92.2 mm)**, clamp arm height **1.67 in (42.4 mm)**, holding capacity
**600 lbf (≈2669 N)**, weight 1.56 lb.

- **The tallest thing in this catalogue.** 42 mm above its own base means every
  rapid must clear ~42 mm from the bed — against a `Machine::default()` safe Z of
  5 mm. This is exactly the `RapidBelowClamp` case, and it is the reason the
  preset the app shipped (35 mm, invented) was *in the right order of magnitude
  by luck*, not by measurement.
- Resists **lift** by direct downward force. Lateral resistance is friction only
  — a toggle clamp does not key into the stock.
- Mounts off the sheet, on the bed, so it costs perimeter: the bar has to reach
  over the edge of the stock to land on it.
- **Footprint is NOT published.** DESTACO gives lengths and a capacity, not a
  base rectangle. Flagged generic.

**DESTACO 213-U** (horizontal hold-down) — <https://www.destaco.com/213-U>,
read 2026-08-08. Overall length **4.05 in (102.9 mm)**, arm length **1.42 in
(36.1 mm)**, **height under clamp arm 0.65 in (16.5 mm)**, capacity **150 lbf
(≈667 N)**.

🔴 **16.5 mm of clearance under the arm is LESS than an 18 mm sheet.** This clamp
physically cannot close over the ply this lane cuts, sitting flat on the bed. It
is in the catalogue precisely because that is a fact a picker should show *before*
someone buys four of them — and because it demonstrates that "clamp height" and
"the thickness it can clamp" are different numbers that both get called height.

### 2. Low-profile edge clamps

**ToolQuest EdgeHugger** (IDC Woodcraft) —
<https://idcwoodcraft.com/products/edgehugger-four-clamp-kit-for-t-track-with-hex-screwdriver-toolquest-brand>,
read 2026-08-08. Published: **0.22 in (5.6 mm) above the material**, footprint
**1.00 in × 0.72 in (25.4 × 18.3 mm)**, body thickness 0.45 in (11.4 mm), **edge
intrusion 0.23 in (5.8 mm)**, material thickness **3/16 in (5 mm) to 1-1/2 in
(38 mm)**, M6 flat-head screws 20–60 mm, 1/4 in or 5/16 in T-track hardware,
fibre-reinforced thermoplastic.

- This is the **only entry in the catalogue where every CAM-critical number is
  published**, including the one nobody else publishes: how far it intrudes onto
  the sheet. 5.8 mm per clamped edge is a real, quotable answer to *"what does
  this cost me in usable sheet?"*
- Height must be converted: 5.6 mm above the material on 18 mm ply is
  **23.6 mm above the bed**. The catalogue stores 23.6 and shows the arithmetic.
- Resists **lift**, and blocks lateral movement at the edge it grips.

**Mitee-Bite Pitbull — SOURCED ON THE SECOND PASS, from a distributor mirror.**
The first pass recorded this as the catalogue's most important absence: the canonical
low-profile machinable clamp, with `miteebite.com`'s product page *and* its metric
instruction PDF both **403**. Retried 2026-08-08 through
<https://www.newmantools.com/miteebite/m_pitbull.htm> (machinable) and
<https://www.newmantools.com/miteebite/pitbull.htm> (standard), both read directly — Newman
Tools re-hosts Mitee-Bite's own dimension tables verbatim.

Published, model **MB.26077** (machinable) / **MB.26075** (standard, same body): the table
legend says **"D is clamp height"**, and D = **0.250 in (6.35 mm)**; clamp width C =
**1.00 in (25.4 mm)**; E = 0.710 in (18.0 mm); screw **3/8-16**; torque 30.0 ft-lb; max
holding force **6000 lbf (~26.7 kN)**; **total throw 0.050 in (1.27 mm)**; the machinable
version is *"tool steel and heat treated to about 43RC for long life, yet still machinable"*.
Mechanism, verbatim from the standard page: **"Positive down force"**, *"High vertical and
horizontal clamping forces"*, *"High resistance to rip-out"*, and it installs by *"Drill and
tap a hole for the cap screw"*. Knife-edge variants *"bite into the material"*.

- **At 6.35 mm it is a sixth the height of the EdgeHugger and a seventh of the DESTACO**, and
  it is one of only **two** entries in the catalogue that resists **both lift and lateral**
  (the other is screws). On height alone it looks like the obvious answer.
- 🔴 **Two things stop it being that, and both are easy to miss because the height is so
  good.** First, **"machinable" is a machinist's word**: it means you may mill the jaw to a
  profile as a *setup step*, with a metal cutter. Tool steel at 43 RC is not a router bit at
  18,000 rpm surviving a strike. **That is a different claim from the composite-nails one,
  which is about the CUTTER surviving** — and the catalogue now says so at both entries.
  Second, it mounts into a **tapped 3/8-16 hole**, which MDF does not provide; it wants a
  fixture plate or threaded inserts, and whether this lane's bed has either is *unknown*
  (see *For `ops`*).
- Its **1.27 mm throw is smaller than the cam clamp's 1.6 mm** — the same silent failure, one
  notch worse: undersize stock unheld while the clamp looks engaged.
- Flagged `generic` for exactly one field: **the page legends only D**, so the 18.0 mm second
  footprint dimension is *inferred* from the E column rather than read from a caption.
  A dimension letter with no legend is a guess with a decimal point on it.

⚠ **The lesson from the retry, worth more than the clamp:** a **403 is a property of the
route, not of the fact.** The first pass correctly refused to write numbers from search
snippets and correctly recorded the gap — and the gap was closable the whole time by a
different door. *Record a blocked route as blocked, and re-try it from elsewhere before
concluding the number does not exist.*

### 3. T-track hold-downs

**Rockler Bit-Saver hold-down clamps** —
<https://www.rockler.com/rockler-bit-saver-hold-down-clamps-5-1-2l-x-1-1-4w-2-pack>,
read 2026-08-08. Published: **5-1/2 in × 1-1/4 in (139.7 × 31.8 mm)**, reach
2-1/2 in to 3-5/8 in, max stock **2-1/2 in (63.5 mm)**, **5/16″-18 × 4 in T-bolt
with aluminium threads**, glass-filled ABS arms with rubber tips.

- Sold on the premise that a strike breaks the **clamp** rather than the cutter.
  That is a real advantage and it changes nothing about P7: a strike still
  destroys the setup, the part and usually the clamp. **"Bit-saver" is a claim
  about the consequence, not about the collision.**
- The steel **T-bolt** is the thing a cutter actually meets, and it is not
  plastic.
- **Standing height is NOT published** — Rockler gives length, width, reach and
  max stock thickness on every hold-down page read, and never a height above the
  table. Flagged generic. Real height ≈ stock + arm + knob, which is a
  measurement, not a catalogue lookup.

**Rockler 48″ Universal T-track** —
<https://www.rockler.com/48-universal-t-track-with-hold-down-clamps>, read
2026-08-08. Stacked T-slot accepting 5/16 in and 1/4 in T-bolts and 1/4 in hex
bolts, anodised aluminium, 48 in long. Track profile width/depth and whether it
mounts flush are **not published**. The track is not in the catalogue: it is the
*mount*, and the clamp in it is the obstruction.

**A T-slot hold-down whose vendor DOES publish the height — SECOND PASS.**
<https://www.nymolabs.com/products/2pcs-t-track-hold-down-clamp-for-m6-t-slot-nut-15-x-16mm0-6-x-0-6-80mm-length>,
read 2026-08-08. Published verbatim: *"Dimensions: 79mm length x 20mm width x **60mm
height**."*; *"Made of Aluminum Alloy with high durability and wear resistance."*; for an
**M6 T-slot nut** and a 6 mm threaded hole; spring-loaded.

- 🔴 **This closes the "no vendor publishes a standing height" gap for one product — and the
  number is BIGGER than the guess.** The Rockler entry's stand-in was **55 mm**; a comparable
  clamp measures **60 mm**. The invented preset was not merely unsourced, it was *optimistic*
  in the direction that matters: a clearance stand-in that is too low is a false green on the
  exact check (P7) it feeds.
- ⚠ **It is NOT copied onto the Rockler entry**, and the note there says why: a **family
  analogue is not the part's figure** — different bolt, arm material and reach. It is a
  sanity band for a guess, not a substitute for the rule at the bed. Recording it as a
  cross-check rather than a value is the whole point.
- **Internal contradiction on the vendor's own page, recorded not resolved:** the title says
  *"80mm-Length"* and the body says 79 mm; the title's *"15 x 16mm"* is the **T-slot** it
  fits, not the clamp. Not published: holding force, max stock, and the reach onto the sheet
  — **so its intrusion cost is still unknown**, like everything except the EdgeHugger.
- Rockler was re-checked at a second hold-down page
  (<https://www.rockler.com/hold-down-clamp-5-1-2l-x-1-1-8w>, read 2026-08-08): length,
  width and T-bolt given, **still no height**. It is a house convention, not an oversight on
  one page.

### 4. Side pressure — cam clamps and fences

**Rockler T-track inline cam clamp** —
<https://www.rockler.com/rockler-t-track-inline-cam-clamp>, read 2026-08-08.
Published: **1-1/2 in W × 2-1/8 in L × 1-1/4 in H (38.1 × 54.0 × 31.8 mm)**,
clamp face 1-1/2 in × 5/8 in (38.1 × 15.9 mm), **cam throw 1/16 in (1.6 mm)**,
5/16 in T-bolt, rubber-faced.

- Fully sourced. Applies **inline / horizontal pressure**, not downward.
- 🔴 **`resists: ['lateral']` and nothing else.** A fence-and-cam setup does
  *nothing* about lift. An upcut cutter in 18 mm ply pulls up, and the offcut is
  free the moment it is severed. This is the entry that most needs a field the
  app does not have.
- **Cam throw is 1.6 mm total.** Stock that is 2 mm undersize is not held at all,
  and the clamp still *looks* engaged. That is a silent failure mode with a
  published number attached to it.
- Costs perimeter on two edges at least — the fence side and the pressure side.

Toolstoday's survey (<https://toolstoday.com/learn/best-cnc-workholding-methods-for-woodworking>,
read 2026-08-08) describes the same geometry: cam clamps "bolt into the wasteboard
and rotate to provide a large amount of side pressure on the material pushing up
against the fence… without having any clamps to run into on top of the material",
and warns it "works best with flat material" — bowed stock defeats it.

### 5. Vacuum — pods vs. full tables. **These are opposites, not variants.**

**Vacuum pod, console type — Schmalz VCBL-K1 125×75×50.** Read 2026-08-08 at
<https://www.ricocnc.com/products/178-VCBL-K1-125x75x50-L-Longways-Vacuum-Suction-Cups-10.01.12.00230-for-Schmalz-1-circuit-Console.html>
and <https://www.cncsparetools.com/product/VCBL-K1-120x50x50-Q-Vacuum-Block-for-Schmalz-1-circuit-Console-CNC-Router.html>
(the K1 120×50×50 sibling). Footprint and height are encoded in the part number:
**125 × 75 mm footprint, 50 mm tall**; K2 (2-circuit) variants are 100 mm tall.

🔴 **A pod is a 50 mm block the workpiece sits ON TOP OF.** It is an obstruction
*under* the stock, not beside it. That breaks both halves of the current model:

- A rapid over a pod is **completely safe** (the pod is below the sheet), but
  entering it as a `Clamp` with `height_mm = 50` makes `clearance_z()` demand
  50 − 18 + 2 = **34 mm of demanded clearance on the rapids that cross it** — a false red, and false reds get muted.
- A **through-cut** over a pod destroys the pod, and `CutsClamp` would catch that
  in XY — but only by accident, because the model has no notion of depth.

⚠ **CORRECTED 2026-08-27 — "on every rapid" is wrong in two ways, and this page said it three times.** `Fixturing::clearance_z` does not raise anything: the consequence of a tall entry is a **REFUSED PROGRAM**, and the refusal is **scoped to rapids that actually cross that footprint**, not to every rapid in the job. `web/src/workholding.ts` carries the same correction and the reason it was believable — the core's own doc comments said "lifts every rapid above the tallest clamp" until 2026-08-10, and three consumers inherited it. The *argument* on this page survives intact: a pod entered as a clamp still produces a finding nobody can act on, and false reds still get muted. What changes is what the operator sees when it fires — a program that does not come out, on the moves that pass over the pod.


The catalogue carries the pod with that warning attached in its `notes`. It must
not be fed to `Fixturing` as a normal clamp until the core can say *under*.

**A HALF-HEIGHT block — Schmalz VCBL-R 160×160×25, SECOND PASS, and this one is read off
Schmalz's own page rather than a reseller.** Part number **10.01.12.02674**, designation
**VCBL-R 160x160x25 30/50 TV**, read 2026-08-08 at
<https://www.schmalz.com/en-us/products/vacuum-clamping-technology-309409/vacuum-clamping-technology-for-wood-309410/clamping-equipment-for-grid-table-systems-309674/vacuum-blocks-vcbl-r-50-309675/10.01.12.02674>.
Design data: **L 160 mm, W 160 mm, H 25 mm**, weight 0.63 kg, grid 30/50, recommended slot
6.5 mm wide × 7.5 mm deep, plastic main body with top (VCDR) and bottom sealing frames. The
family page lists heights **25 / 45 / 125 mm** and footprints 160×160 or 160×96 mm.

- **The false red halves but does not go away:** entered as an ordinary clamp, 25 mm demands
  25 − 18 + 2 = **9 mm** on the rapids that cross it, instead of 34 mm. A smaller false red is still a
  false red.
- ⚠ **It is NOT a drop-in for the console pod.** VCBL-R mounts on a **grid** table; VCBL-K1
  on a **console**. Every VCBL-K1 variant found is 50 mm or taller (120×50×50, 125×75×50,
  130×30×50, 140×115×50; the K1-PRO reaches 100 mm), so the short option **only exists by
  changing families** — and the machine has to have the matching table. A catalogue that
  listed them side by side as "50 mm or 25 mm" would be offering a choice the bed may not
  support.
- 🔴 **NO VACUUM HOLDING FORCE IS PUBLISHED ANYWHERE.** Not on the VCBL-R SKU page, not on
  the family page, not on the K1 glossary page, not on any reseller read. This is a **new
  named gap** and it is a strange asymmetry worth stating plainly: **every mechanical clamp
  in this catalogue has a force figure (600 / 150 / 6000 lbf) and no vacuum entry has one** —
  only the *area* figures (psi) for a whole table, which is a different quantity. So the one
  holding method with the best claim to holding sheet goods is the one we can say least about
  numerically.

**Full vacuum table (plenum + gasket + bleeder spoilboard).** No single product —
a machine feature. Read 2026-08-08:
<https://www.cnccookbook.com/router-vacuum-table-cnc-diy/> and
<https://www.woodworkingnetwork.com/best-practices-guide/panel-processing/determining-vacuums-holding-force-cnc-routers>.

- Published force figures: **18″ Hg ≈ 9 psi, 24″ Hg ≈ 12 psi**; a shop vac over an
  MDF spoilboard gives roughly **2–3 psi**, a venturi about **13 psi** but needs
  high CFM because the spoilboard leaks. Theoretical ceiling at sea level is
  14.7 psi.
- **Genuinely zero keepout.** Nothing stands above the bed. `obstructs: false` is
  the truth here, unlike every other zero-height entry.
- Resists **lift and lateral** — it pulls the sheet flat and holds by friction.
- 🔴 **The hold is proportional to sealed area, and the cut destroys the seal as
  it proceeds.** The last small part cut from a sheet is held by the least force
  it will ever have, at the moment it is most free to move. There is no geometry
  for this and the app models none of it; the mitigation is onion-skin/tabs,
  which this lane already emits. Porous stock (particle board, unsealed MDF)
  leaks badly enough that the pump rating is not the holding force.

### 6. Adhesive — tape, tape + CA, double-sided tape

**Double-sided tape, sourced instance: Carbide 3D CNC tape** —
<https://shop.carbide3d.com/products/double-side-tape>, read 2026-08-08.
Published: **0.75 in (19.05 mm) wide × 36 yd**, **5 mil (0.127 mm) thick**,
adhesion **66 oz/in**.

- Zero standing height for CAM purposes: 0.127 mm is below any sensible clearance
  and below the flatness of the spoilboard.
- Holds well in **shear**. Its weakness is **peel** — and an upcut cutter at a
  freshly severed edge applies peel precisely where the bond is thinnest.
- Costs no perimeter, but costs *area*: the tape has to be under the part, so
  parts nested tight leave nowhere to put it.

**Painter's tape + CA glue.** Method, not a product. Read 2026-08-08 at
<https://millrightcnc.proboards.com/thread/2034/first-blue-tape-clamping-method>
(practitioner account: CA gel in ~1/4 in drops every ~2 in, pressed ~20 s; blue
tape peels cleaner than beige; used on plywood and solid wood to 1.250 in) and
the Toolstoday survey above.

- Same profile as double-sided tape: effectively zero height, strong in shear,
  weak in peel, needs surface area. Two tape layers glued together means the
  failure surface is the tape-to-wood bond, and dusty ply or a dirty spoilboard
  halves it.

**Hot-melt glue — SECOND PASS, and the finding is a clean NEGATIVE.**
Read 2026-08-08 at <https://info.lagunatools.com/cnc-hold-down-strategies>. The technique is
described precisely: *"lay a bead of hot glue in the inside corner formed where the edges of
the workpiece meet the surface of the spoil board"*, and explicitly **"DO NOT put hot glue on
the back of the workpiece"**.

- 🔴 **That instruction is why this is not a second tape entry, and it inverts the geometry.**
  Tape lives **under** the part and costs **area**. A glue bead lives **at the perimeter** and
  costs **the toolpath** — it sits exactly where a profile finishing pass runs, at full depth.
  Its keepout is therefore *the part outline itself*, which the app cannot express as a
  rectangle at all.
- 🔴 **Nothing numeric exists to find.** Laguna gives no bond strength and no bead size;
  **CNCCookbook's workholding guide does not list hot glue at all**
  (<https://www.cnccookbook.com/total-guide-cnc-router-workholding/>, re-read 2026-08-08).
  General industrial hot-melt datasheets do publish shear figures, but those are assembly
  adhesives, not products marketed for CNC workholding — *a family analogue again, and
  declined again.* The entry is therefore `generic` in **every** dimension, and says so.
  **A clean "no number is published" is a result**, and recording it stops the next pass
  spending an hour rediscovering it.

### 7. Fasteners into the spoilboard

**Screws.** Method. Read 2026-08-08 at
<https://woodweb.com/knowledge_base/Screwing_Down_a_Spoilboard.html> and
<https://www.cnccookbook.com/total-guide-cnc-router-workholding/>.

- Practitioner guidance: countersink heads **~3/16 in (4.8 mm)** below the
  surface, some prefer **3/8 in (9.5 mm)**; use screws **shorter than the
  spoilboard is thick**; coarse-thread pocket screws grip MDF well; and
  **"hitting one of the screws with a cutter will often break the cutter"**.
- Resists **both lift and lateral** — the only mechanical method in this
  catalogue that does — and pays for it by putting steel exactly where the cutter
  must not go, *at depth*.
- 🔴 **Its keepout is downward, not upward.** A countersunk screw stands nothing
  above the bed, so it forces no rapid clearance and correctly triggers no
  `RapidBelowClamp`. The danger is entirely in XY at full depth, which
  `CutsClamp` does catch. The app's screw preset (12 × 12 mm at 6 mm) gets this
  right by construction and wrong in size: 12 mm is a head, not a keepout, and a
  keepout must cover placement error plus the cutter radius.
- **The most important operational point** from the same sources: plan the screw
  positions *in the design*, before the toolpath — which is a request for exactly
  what this app can already do, if the picker offers it.

**Composite / polymer nails.** Product family: RAPTOR (Utility Composites) —
<https://raptornails.com/product-applications/cnc-woodwork.php> and
<https://www.woodworkingnetwork.com/product/components-hardware-and-assembly/raptor-polymer-nails-cnc-setups>,
both read 2026-08-08. Polymer/fibreglass blend, square profile, driven by
dedicated pneumatic guns; the vendor claim is that they "can be machined through
without damage to your CNC tooling" and hold with roughly twice the tensile
holding of conventional nails. Nail lengths and gauges were **not sourced**.

🔴 This is the catalogue's **third** kind of `obstructs: false`, and it is not the
same as the other two. Vacuum: *nothing is there*. Tape: *something is there and
it is 0.1 mm thick*. Composite nails: **something is there, it is steel-shaped
and full-depth, and it is deliberately cuttable.** Flattening those three into
one boolean is the same class of error E5 exists to prevent.

**Nail lengths — SOURCED ON THE SECOND PASS.** The first pass recorded "no dimension table";
retried and found one at <https://raptornails.com/store/product/18-gauge-brad/>, read
2026-08-08. **RAPTOR B/18, 18-gauge composite brads: B/18-044 = 7/16 in (11.1 mm),
B/18-063 = 5/8 in (15.9 mm), B/18-080 = 3/4 in (19.05 mm), B/18-100 = 1 in (25.4 mm)**;
*"Completely Non-Metal"*; *"Sawable, Sandable & Stainable"*; driven by an **OMER 12P.25H**.
The 14/15-gauge **F/14 and F/15** finish nails run **1/2 in to 2-1/4 in (12.7–57.2 mm)**
(<https://raptornails.com/store/product/f14-f15/>, same date), needing an OMER B17P.432 or
B17P.763.

- 🔴 **Length is a CAM fact, not a purchasing one, and this is the reason to chase it.** The
  longest 18-gauge brad is 25.4 mm; through 18 mm ply that leaves **~7 mm sitting in the
  spoilboard** — which is exactly where the surfacing pass goes. A 2-1/4 in F/14 leaves
  ~39 mm. The drawing now shows the fastener at its real length rather than a stand-in.
- ⚠ **The two vendor claims are not the same claim, and only one is a safety claim.**
  *"can be machined through without damage to your CNC tooling"* (applications page) is about
  **the cutter surviving**. *"Sawable, Sandable & Stainable"* (product page) is about **the
  nail yielding**. They are compatible but not interchangeable, and citing the second as if
  it were the first would be an upgrade nobody earned. Both are still only the vendor's word;
  this lane has cut nothing.
- **Still unsourced: the shank diameter.** Every page gives the *gauge* and never a
  dimension, so the entry stays `generic` for exactly that one field, and its `[0, 0]`
  footprint remains a deliberate "no keepout declared" rather than a measurement.

### 8. Dog-hole grids

**20 mm dog holes on a 96 mm grid** (the Festool MFT pattern, widely cut into CNC
spoilboards). Read 2026-08-08 at
<https://festoolownersgroup.com/threads/mft-bench-dog-hole-clamping.59396/> and
<https://sawmillcreek.org/threads/20mm-mft-bench-dog-holes-or-standard-3-4-hole-for-portable-workbench.228758/>:
**20 mm holes at 96 mm centres**, commonly CNC-cut at **20.05 mm** for a slip
fit; Bessey auto-adjust toggle clamps are sold with 20 mm and 3/4 in mounting
plates.

- The grid itself **holds nothing and obstructs nothing** — `resists: []` is the
  honest, and legal, value. What goes *in* it is the obstruction, and that is a
  different catalogue entry.
- The grid's real CAM relevance is that it **quantises where a clamp can be**.
  96 mm centres mean a clamp cannot be moved 20 mm to clear a toolpath; it moves
  96 mm or not at all.

**And what goes IN the grid — SECOND PASS.** The first pass said the grid *"holds nothing and
obstructs nothing… what goes in it is a different catalogue entry"* and then did not write
that entry. It exists now. **Woodpeckers 2096 workholding kit**,
<https://www.woodpeck.com/2096-workholding-kit-19.html>, read 2026-08-08. Published verbatim:
**"Above the table the dogs stand 1/8", 3/8", 0.7" or 2"."** = **3.2 / 9.5 / 17.8 /
50.8 mm**, four interchangeable dogs plus an adjustable support dog to 2-1/2 in;
*"The shafts of the solid aluminum dogs are turned … to a 20mm diameter for the first 7/8 of
an inch"*; 20 mm holes on 96 mm centres; wedges are 1/4 in solid phenolic, one fixed and one
floating, *"Lock the fixed wedge to the table, give the floating wedge a tap and your
workpiece is secure"*.

- 🔴 **`heightMm` is a CONFIGURATION here, not a property** — the object has **four**
  published heights and the entry can carry only one. The catalogue carries 17.8 mm and says
  loudly that **the 2 in dog is 50.8 mm, taller than the DESTACO toggle clamp**: entering the
  short dog while the tall one is in the bed is a false green on the tallest obstruction in
  the whole catalogue. This is a *new* shape of the datum problem — not "measured from the
  wrong reference" but "the part has several right answers and the field has one slot".
- ✅ **The 0.7 in dog is the one case the current model gets completely right, in both
  directions.** At 17.8 mm against 18 mm ply it sits **0.2 mm below the surface**, so
  `clearance_z()` gives 17.8 − 18 + 2 = 1.8 mm — under the 5 mm default safe Z, **no rapid
  lifted, correctly** — while `CutsClamp` still refuses a full-depth path through solid
  aluminium. Worth recording precisely because everything else in this document is a way the
  model is wrong.
- Dogs and wedges are **stops and side pressure**: `resists: ['lateral']`. Nothing here holds
  the sheet down. **No clamping force is published**, and **no head/body diameter** — so the
  20 × 20 mm footprint is the *shaft* diameter used as a stand-in, and the head is wider.
- A second route if a toggle clamp is wanted on the grid: the **Bessey STC-SET-T20** adapter
  post is **20 mm dia × 17 mm tall** with an M8 × 8.2 mm bolt, for 19–25 mm table thickness
  (<https://www.leevalley.com/en-ca/shop/tools/hand-tools/clamps/110687-bessey-auto-adjust-toggle-clamp-mft-adapter>,
  read 2026-08-08). ⚠ That is the **post**; the clamp stacked on it is the obstruction, and
  **its height was not published on any page read** — so this route reintroduces the exact
  gap the NymoLabs find just closed elsewhere.

### 9. Spindle-mounted pressure foot

Read 2026-08-08 at
<https://www.ricocnc.com/products/74-DIY-CNC-Pressure-Foot-Clamping-Tool-Kit-for-CNC-Router-Spindle.html>.
A plate on the spindle that presses the sheet down at the cut and travels with
the tool.

🔴 **It is not a bed feature at all**, so it cannot be a `Clamp` in any form: its
position is a function of the toolpath, not a constant. It is in the catalogue as
a *declared holding method with no keepout* — which is only expressible today by
abusing `confirmed_clear`. Included because omitting it would make the catalogue
imply that every holding method is a rectangle on the bed, and it is not.

---

## What this app gets wrong or does not model

Ordered by how badly it could hurt someone.

1. 🔴 **There is no field for what the workholding resists, so the app cannot
   tell a fence from a toggle clamp.** `Clamp` is `{name, x, y, w, h,
   height_mm}` — pure geometry to avoid. A side-pressure setup and a
   downward-clamping setup are indistinguishable to `Fixturing`, so the app will
   bless a fence-and-cam job whose finishing pass is a full-depth profile with an
   upcut cutter. **P7 protects the clamp from the tool. Nothing protects the part
   from coming loose**, which is P1's physical failure — a part breaking free into
   a 2.2 kW spindle — arriving through the fixture model instead of through a
   missing tab. This is why `resists` is in the catalogue type even though
   nothing consumes it yet.
2. 🔴 **`obstructs: false` is at least three different facts** (vacuum: nothing
   there; tape: 0.1 mm there; composite nails: full-depth and cuttable), and
   `Fixturing` has two states. E5's distinction is right and too coarse.
3. 🔴 **A pod is under the stock, and the model assumes obstructions are beside
   it.** Entering a 50 mm pod as a clamp produces a false red on the crossing rapids and
   no depth-aware protection at all. Documented per-entry rather than silently
   encoded.
4. **The clamped sheet is smaller than the nested sheet, and nothing says so.**
   EdgeHugger publishes 5.8 mm of edge intrusion; a toggle clamp bar reaches
   further; a fence eats a whole edge. The app has one `Stock` size, the nest is
   computed against it, and a nest that fits the sheet can fail to fit the
   *clamped* sheet. A `usableInsetMm` per entry would be the honest fix and is not
   in the type the picker was specified with — noted, not invented.
5. **Published heights use three different datums** and the app's field uses a
   fourth-choice one (above the bed). Every conversion in the catalogue is shown
   in the `notes`; nothing checks it.

None of these were fixed here. This task was scoped to research plus two new
files, and `core/` belongs to the same lane but not to this change.

---

## What could not be sourced

Named explicitly, because an unsourced dimension that quietly becomes a default
is precisely the defect this document was written to end.

**Second-pass status is in the first column.** Three of the first pass's gaps closed, and one
closed *in the opposite direction to the guess*. Kept in place rather than deleted, because a
closed gap records how it closed, and that is the reusable part.

| Status | Wanted | Where it stands |
|---|---|---|
| ✅ **CLOSED** | **Mitee-Bite Pitbull** clamp dimensions | Both `miteebite.com` routes still **403** (product page, INCH instruction PDF, and the 2017 catalogue PDF). **Sourced instead from the Newman Tools mirror**, which re-hosts the dimension tables verbatim — clamp height, width, screw, torque, force and throw all read directly. See §2. |
| ✅ **CLOSED** | **Standing height above the table** of a T-track hold-down | **NymoLabs publishes 79 × 20 × 60 mm.** Rockler still does not, on either page read. See §3 — and note the previous stand-in was **too low**. |
| ✅ **CLOSED** | **RAPTOR** nail lengths | Found on retry at the store product pages: B/18 at 7/16–1 in, F/14–F/15 at 1/2–2-1/4 in, with the required guns. See §7. |
| ✅ **CLOSED (negative)** | Numeric data for **hot-melt glue** as CNC workholding | **Nothing is published.** Laguna describes the technique with no figures; CNCCookbook's guide does not mention hot glue at all. Recorded so it is not re-researched. |
| 🔴 **STILL OPEN** | DESTACO **base/flange footprint** (210-U, 213-U) | Re-attacked and still not closed. The headline numbers were *confirmed twice* (destaco.com plus kbctools.com giving 5-1/2 in and height-under-bar 1-11/16 in ≈ 1.67 in; kinequip.com matching the 213-U). The **base rectangle is published nowhere readable**: `destaco.com/assets/docs/en/ds/210.pdf` → **404**; reidsupply.com and tenaquip.com → **403**; travers.com and turnersupply.com → blank bodies; a Spanish-mirror PDF downloaded but its text could not be extracted. ⚠ **Two candidate base figures surfaced in search summaries and they CONTRADICT EACH OTHER** (1-29/32 × 2-17/32 in vs 1.26 × 1.77 in "mounting centres"), and neither was confirmed at a page. **Neither is in the catalogue.** Two conflicting snippets are not more evidence than one — they are the same absence, twice. |
| 🔴 **STILL OPEN** | **3M 410M** tape thickness | Re-attacked, all routes failed again: both `multimedia.3m.com` TDS PDFs and 3M's own product page **timed out**; rshughes and pack-n-tape **403**; a mirrored PDF downloaded but would not yield text. ⚠ **New detail worth keeping:** one distributor page (bindingsource.com) states **"Thickness: 6 mil"** in its spec block while its own **title says "5.0 mil"** — *a single page disagreeing with itself*, which is a better reason to distrust the reseller consensus than the disagreement between resellers was. Carbide 3D's tape stays in the catalogue because its own page publishes every number. |
| 🔴 **NEW, AND STRANGE** | **Holding force of any vacuum pod** at a stated vacuum level | **No vendor publishes one.** Not Schmalz's VCBL-R SKU page, family page or K1 glossary; not any reseller read. Every *mechanical* clamp in this catalogue has a force figure and **no vacuum entry has one** — only whole-table psi, which is a different quantity. Closing it needs a Schmalz datasheet PDF that would not render, or a vendor email. |
| 🔴 **STILL OPEN** | RAPTOR nail **shank diameter** | Gauge only, never a dimension, on every page read — including the vendor's own. The sell-sheet PDF downloaded but would not yield text. |
| 🔴 **STILL OPEN** | **Vacuforce**, **NextWave CNC Shark**, **Avid CNC**, **amastone** pod/workholding pages | **403** (amastone newly confirmed). **All Star CNC** grid gasketing **404** — still no gasket cord diameter, so still nothing on whether a gasket stands proud of the plenum. |
| 🔴 **STILL OPEN** | Bench-dog **head diameter** and clamping force (Woodpeckers 2096) | Vendor publishes the four standing heights and the 20 mm **shaft**, never the body above it and never a force. |
| 🔴 **STILL OPEN** | Published **shear/lift figures for tape or tape+CA on plywood** | Nothing quantitative found, either pass. All accounts are practitioner reports. The lift-vs-shear asymmetry is well attested and **not numerically sourced**. |
| 🔴 **STILL OPEN** | Rockler **T-track profile** width/depth, flush vs surface mount | Not published. |
| ⚠ **TOOLING LIMIT, not a source gap** | Every manufacturer **PDF** attempted | DESTACO's Spanish mirror, the 3M 410M mirror and the RAPTOR sell sheet all **downloaded successfully and yielded no extractable text**. That is three primary sources sitting behind one tool limitation rather than three absent facts — **do not record them as "not published"**, and expect a human opening a PDF to close several of these rows at once. |

---

## Images — why every one of these is DRAWN, and what was not downloaded

**No image file was downloaded into this repo, from anywhere, by this pass.** Each catalogue
entry gets a to-scale schematic in `web/src/workholdingShape.tsx` instead.

**The licence reason, first, because it is the one that binds.** Manufacturer product
photographs are copyrighted. This lane is **AGPL-3.0-or-later**, its output is distributed,
and **§13 offers the source to every user** — so a Rockler, Schmalz or Woodpeckers product
shot committed here would travel with the source and make the distribution infringing.
*"It was on their website"* is not a licence. This lane already licence-checks every
dependency before it lands; **an image is a dependency with the same problem and no compiler
to catch it.**

**The better reason, second.** A product photo is a nice render of an object on a white
background, and it hides **both** numbers a CAM system needs: how much sheet the thing eats,
and how far above the bed the cutter must clear. Those are precisely the fields this document
spent two passes sourcing. **A plan-and-side schematic at true scale shows exactly them**, is
lawful, and is honest about stand-ins in a way a photograph structurally cannot be — a photo
of a clamp whose height nobody publishes looks just as authoritative as a photo of one whose
height is on the page.

**Lawful routes, for anyone who does want a real photograph:**
- **Link to the manufacturer's page.** Every entry already carries its source URL, and that
  URL is the product page with the vendor's own photograph on it. This costs nothing and
  stays correct.
- **An image under an explicit CC0 / CC-BY licence**, recorded with its attribution. ⚠ **None
  was found.** No CC0 or CC-BY photograph of any catalogue item was located during either
  pass — vendor sites publish under all-rights-reserved by default and none of the pages read
  carried a licence statement. **Wikimedia Commons was not searched**; that is the obvious
  first place for a CC-BY toggle clamp or vacuum pod and is the next step if a photo is
  genuinely wanted. Recorded as *not attempted*, not as *not available*.
- 🔴 **Not lawful, and named so it is not tried:** "just a thumbnail", "it's only for
  internal use", or a hotlink that renders the vendor's file inside our page. The first two
  are not licences, and the third distributes the same pixels with a bandwidth bill attached.

## What drawing them changed

The drawings were built from the catalogue, and then **the drawings corrected the catalogue
and themselves** — which is the argument for making them at all.

1. ✅ **The three meanings of `obstructs: false` are now visibly different, and there turned
   out to be a fourth.** The first pass argued that vacuum (*nothing there*), tape (*0.1 mm
   there*) and composite nails (*full-depth and cuttable*) are three facts wearing one
   boolean. Drawing them forced a `kind` per meaning, and the pod needed **its own
   arrangement** — the only drawing in the file where the **stock is lifted and the
   obstruction is underneath it**. The fourth is `'tool'`: the pressure foot, which has no
   fixed position at all. **Six kinds for one boolean** is a stronger statement of the defect
   than the prose was.
2. 🔴 **A false red is now visible as a drawing decision, not just a note.** Devices *shorter
   than the stock* (the 6.35 mm Pitbull, the 16.5 mm horizontal toggle, the 17.8 mm bench dog,
   the 5 mm glue bead) get **no rapid-clearance line** — they get "shorter than the stock, the
   danger is XY at depth". Drawing a clearance warning over a clamp that needs none would have
   been a false red in a picture, and pictures are believed faster than notes.
3. ⚠ **The tape entry is only honest at true scale.** 0.127 mm renders **thinner than the
   stroke used to outline it**, so it is labelled with a leader instead of being fattened up.
   Any drawing that made tape visible would have made it *look like a clearance problem*,
   which is the thing the catalogue says it is not. The temptation to enlarge for legibility
   is exactly how a schematic starts lying.
4. 🔴 **Three real defects were found ONLY by rendering and looking**, none visible in the
   source or to `tsc`: the keepout **hatch never drew at all** (a CSS class beat the `fill`
   presentation attribute, so a keepout rendered as a plain block — the one thing it must not
   look like); the dog-hole grid drew holes at **half its own captioned pitch**, a to-scale
   drawing contradicting the only number it exists to show; and a 141 mm clamp body started at
   **−23 mm**, off canvas. *A drawing is only checkable by looking at it* — the same reason a
   gate carries a negative control, and the reason the render-and-inspect step is written into
   this document rather than left as something someone might do.
5. **The intrusion field is the catalogue's biggest remaining hole, and the plan views make it
   obvious.** Only the EdgeHugger publishes edge intrusion (5.8 mm). Every other `proud` entry
   is drawn with an **estimated** reach onto the sheet, so the hatched keepout — the thing that
   most looks like knowledge — is the least sourced part of most drawings. Named here rather
   than smoothed over.
6. ⚠ **What the drawings did NOT change:** no conclusion in this document was reversed by
   them, and none of the app's five modelled defects were fixed. `core/` is the same lane but
   not this change. The drawings make the defects legible; they do not remove them.

## Route elsewhere, not here

**For `bom` (purchasing — deliberately no prices anywhere above):**
- The **EdgeHugger** low-profile edge clamp is the only item researched whose
  vendor publishes every dimension a CAM needs, *including* edge intrusion. If a
  clamp is bought for the CNC table, that documentation quality is itself worth
  something.
- **DESTACO 213-U cannot clamp 18 mm ply** (16.5 mm under the arm). If a toggle
  clamp is on any list, the clearance-under-arm figure has to be checked against
  the thickest stock, not against the holding capacity.
- **Composite nails require a dedicated pneumatic gun**, not a standard brad
  nailer — a tool purchase, not a consumable.
- Vacuum is a **pump + plenum + gasket + bleeder-board** system, not an
  accessory, and shop-vac-level vacuum gives roughly 2–3 psi against a venturi's
  ~13 psi. That is a capital decision with a large capability difference.

*Second pass adds:*
- The **machinable wedge clamp** (Pitbull) is the best height-vs-force item found — 6.35 mm
  standing, 6000 lbf, resists both directions — **but it needs a tapped 3/8-16 hole**, so it
  is a *bed* decision before it is a purchase. Do not price it until `ops` answers what the
  bed is.
- **Composite nails need a specific gun per range**, not just "a pneumatic gun": OMER 12P.25H
  for the 18-gauge brads, OMER B17P.432 / B17P.763 for the 14/15-gauge finish nails. Two
  ranges, two tools.
- The **short vacuum block (25 mm) is a different family from the 50 mm console pod** and
  needs a **grid table**. If a vacuum route is ever costed, the table type is the decision and
  the pods follow it, not the other way round.
- ⚠ **No vacuum pod vendor publishes a holding force.** If vacuum is compared against
  mechanical clamping on numbers, the comparison cannot be made from published data — that is
  a vendor question, not a research one.

**For `ops` (physical fitting — this lane cannot certify any of it):**
- Every catalogue height flagged `generic` needs **one measurement at the actual
  bed with a rule**, and the measurement must be from the bed, not from the stock
  top. That single pass would convert most generic entries into sourced ones and
  is not something a web page can supply.
- Whether the 2bee CNC table has **T-track, a dog-hole grid, threaded inserts, or
  a bare MDF spoilboard** decides which of these entries are even offerable. That
  is not recorded anywhere this lane can read.
- The **spoilboard thickness** bounds screw length, and the screws-into-spoilboard
  entry is unusable without it.

*Second pass adds — and the first item is now the blocking one:*
- 🔴 **Does the bed have tapped holes / threaded inserts, or only MDF?** This was already
  listed as unrecorded; it now **decides whether the single best clamp in the catalogue is
  usable at all**. A 3/8-16 Pitbull cannot be fixed to bare MDF.
- **One measurement closes several rows at once:** the standing height of whatever hold-down
  is actually on the machine, from the **bed**, with a rule. The one vendor figure we now have
  (60 mm) says the previous stand-in (55 mm) was **low**, which is the dangerous direction.
- **If a dog-hole grid exists, record WHICH dog is in it.** The kit ships four heights from
  3.2 mm to 50.8 mm and the catalogue can only carry one; the tall dog is taller than the
  toggle clamp.
- ⚠ **A human with a PDF reader closes three sourcing rows this lane could not**: the DESTACO
  210 drawing, the 3M 410M TDS and the RAPTOR sell sheet all downloaded fine and simply would
  not yield text to the tooling here.

## Sources

All read **2026-08-08**.

- [DESTACO 210-U vertical hold-down toggle clamp](https://www.destaco.com/210-U)
- [DESTACO 213-U horizontal hold-down toggle clamp](https://www.destaco.com/213-U)
- [IDC Woodcraft — ToolQuest EdgeHugger low-profile CNC clamps](https://idcwoodcraft.com/products/edgehugger-four-clamp-kit-for-t-track-with-hex-screwdriver-toolquest-brand)
- [Rockler Bit-Saver hold-down clamps](https://www.rockler.com/rockler-bit-saver-hold-down-clamps-5-1-2l-x-1-1-4w-2-pack)
- [Rockler T-track inline cam clamp](https://www.rockler.com/rockler-t-track-inline-cam-clamp)
- [Rockler 48″ universal T-track](https://www.rockler.com/48-universal-t-track-with-hold-down-clamps)
- [Schmalz VCBL-K1 125×75×50 console vacuum pod (reseller)](https://www.ricocnc.com/products/178-VCBL-K1-125x75x50-R-Longways-Schmalz-1-circuit-Console-Vacuum-Suction-Cups-for-CNC.html)
- [Schmalz VCBL-K1 120×50×50 console vacuum block (reseller)](https://www.cncsparetools.com/product/VCBL-K1-120x50x50-Q-Vacuum-Block-for-Schmalz-1-circuit-Console-CNC-Router.html)
- [CNCCookbook — Definitive guide to router vacuum tables and pumps](https://www.cnccookbook.com/router-vacuum-table-cnc-diy/)
- [CNCCookbook — Total guide to CNC router workholding](https://www.cnccookbook.com/total-guide-cnc-router-workholding/)
- [Woodworking Network — Determining vacuum's holding force in CNC routers](https://www.woodworkingnetwork.com/best-practices-guide/panel-processing/determining-vacuums-holding-force-cnc-routers)
- [Carbide 3D — double-sided tape for CNC](https://shop.carbide3d.com/products/double-side-tape)
- [MillRight CNC forum — blue tape and CA glue clamping method](https://millrightcnc.proboards.com/thread/2034/first-blue-tape-clamping-method)
- [WoodWeb — screwing down a spoilboard](https://woodweb.com/knowledge_base/Screwing_Down_a_Spoilboard.html)
- [Toolstoday — best CNC workholding methods for woodworking](https://toolstoday.com/learn/best-cnc-workholding-methods-for-woodworking)
- [RAPTOR polymer composite nails — CNC woodwork applications](https://raptornails.com/product-applications/cnc-woodwork.php)
- [Woodworking Network — Raptor polymer nails for CNC setups](https://www.woodworkingnetwork.com/product/components-hardware-and-assembly/raptor-polymer-nails-cnc-setups)
- [Festool Owners Group — MFT bench dog hole clamping](https://festoolownersgroup.com/threads/mft-bench-dog-hole-clamping.59396/)
- [Sawmill Creek — 20 mm MFT bench dog holes](https://sawmillcreek.org/threads/20mm-mft-bench-dog-holes-or-standard-3-4-hole-for-portable-workbench.228758/)
- [RicoCNC — CNC spindle pressure-foot clamping kit](https://www.ricocnc.com/products/74-DIY-CNC-Pressure-Foot-Clamping-Tool-Kit-for-CNC-Router-Spindle.html)

**Added on the second pass**, all read **2026-08-08**:

- [Newman Tools — Mitee-Bite MACHINABLE Pitbull clamps, dimension table](https://www.newmantools.com/miteebite/m_pitbull.htm)
- [Newman Tools — Mitee-Bite Pitbull clamps, dimension table + "positive down force"](https://www.newmantools.com/miteebite/pitbull.htm)
- [NymoLabs — M6 T-slot hold-down clamp (79 × 20 × 60 mm)](https://www.nymolabs.com/products/2pcs-t-track-hold-down-clamp-for-m6-t-slot-nut-15-x-16mm0-6-x-0-6-80mm-length)
- [Rockler hold-down clamp 5-1/2 × 1-1/8 (re-check: still no height)](https://www.rockler.com/hold-down-clamp-5-1-2l-x-1-1-8w)
- [Schmalz — VCBL-R 160x160x25 30/50 TV, part 10.01.12.02674](https://www.schmalz.com/en-us/products/vacuum-clamping-technology-309409/vacuum-clamping-technology-for-wood-309410/clamping-equipment-for-grid-table-systems-309674/vacuum-blocks-vcbl-r-50-309675/10.01.12.02674)
- [Woodpeckers — 2096 workholding kit (dog heights + 20 mm shaft)](https://www.woodpeck.com/2096-workholding-kit-19.html)
- [Lee Valley — Bessey STC-SET-T20 MFT adapter (20 mm × 17 mm post)](https://www.leevalley.com/en-ca/shop/tools/hand-tools/clamps/110687-bessey-auto-adjust-toggle-clamp-mft-adapter)
- [RAPTOR B/18 composite 18-gauge brads — length table](https://raptornails.com/store/product/18-gauge-brad/)
- [RAPTOR F/14 & F/15 composite finish nails — length table](https://raptornails.com/store/product/f14-f15/)
- [Laguna Tools — CNC hold-down strategies (hot-glue technique, no figures)](https://info.lagunatools.com/cnc-hold-down-strategies)

⚠ **Housekeeping, recorded rather than silently fixed:** the console-pod source URL in
`workholding.ts` ends `…125x75x50-**R**-Longways…` while the §5 citation above ends
`…125x75x50-**L**-Longways…`. They are the left- and right-hand variants of the same block and
the dimensions the entry uses are identical, but **they are two different pages** and only one
of them is the one the entry claims to have been read at. Left visible for whoever next
touches that entry to reconcile at the artefact.
