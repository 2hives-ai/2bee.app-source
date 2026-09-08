# Materials research — what we assert vs what is published

**Two passes are recorded in this file and they are labelled separately.**

| Pass | Date | What it covered | Read date on its sources |
|---|---|---|---|
| 1 | 2026-08-08 | The six materials' eighteen constants; sheet sizes, thicknesses, grades | 2026-08-08 |
| **2 (this one)** | **2026-08-10** | **Re-read of every feed/depth source at the primary document; the machine-class problem; EVERY number that reaches an emitted program** | **2026-08-10** |

**No prices.** Sourcing and purchasing are `bom`'s lane and are deliberately absent.

**This document changes no code.** It is an audit. Where it recommends a change it says so as a
recommendation and names who owns the decision.

---

## 🔴 SUMMARY — read this before trusting any number in this lane

**1. The eighteen numbers everybody was looking at are now sourced. The ~170 numbers nobody was
looking at are not.** Decision #38 §A fixed `chipload_factor` and `max_doc_ratio`, and this pass
re-derived every one of those ratios from the primary manufacturer PDFs — **all six chipload
multipliers now sit inside a published same-series band** (§1). But those eighteen are a small
minority of the numbers that reach an emitted program. Counting the shipped tool library, the
machine defaults and the operation defaults:

> 🔴 **A LARGE FRACTION OF THE TABLE CANNOT BE SOURCED.** Of the numbers this tool puts into a
> G-code file, **18 now carry a citation — and only 6 of those 18 are a published figure for the
> quantity they control (§3.1) — while roughly 170 carry nothing at all.** The unsourced ones
> include every
> chipload in the 51-tool library except the ⌀6 end mill, every drill speed and feed, the plunge
> rate, the peck depth, the pocket stepover, the tab geometry, the rapid rate and the machine's
> own feed ceiling. **The unsourced fraction did not shrink when #38 landed — it moved.** #38
> audited the multipliers; nothing has ever audited the numbers they multiply.

**2. The worst defect is no longer a value, it is a MISSING TERM.** `Material::max_doc_ratio()` is
keyed on the material. **The physical limit it stands for is a property of the machine and the
engagement, not of the material.** The app ships three machine presets — a 1250×670 C-Beam/ACME
gantry, a 600×900, and a Desktop 3018 — and **measured 2026-08-10: two different machine presets
produce a byte-identical program** (§2). There is no machine term anywhere in the cutting
parameters, so "sourced to a machine we do not have" is not one bad row; it is the shape of the
whole function.

**3. Three numbers are sourced to the wrong TOOL class, which is the same defect one level down.**
`max_rpm() == 24,000` for wood is correctly sourced — to Techno's *"general operating RPM for Techno
CNC **Tooling**"*, i.e. router cutters. `recommend` then selects it for a **brad-point drill**.
Measured emission for a ⌀6 brad point in 18 mm plywood: **`G98 G83 … Q4.000 F5760.0` at `M3 S24000`**.
LMT Onsrud's own *Drill Cutting Data Recommendations* rates wood drills in **inches per revolution
against surface speed**, not chip-per-tooth against a router ceiling, and the only spindle speed it
prints for wood drilling is **4,500 rpm** (§3.3). **We publish no drill speed figure here and
recommend the tool stop publishing one either.**

**4. A feed ceiling that is declared and not enforced is worse than one that is absent, and the
honest fix is not "clamp".** Measured 2026-08-10: the ⌀12 end mill emits **`F6000.0` at `S24000`**
— the core's own default `max_feed_mm_min` clamped it — which makes the delivered chipload
**0.125 mm/tooth against that tool's own declared minimum of 0.15 mm**. The program is out of the
cutter's rated window, in the emitted text, at default settings, with nothing said. `chipload_in_window()`
exists, is exported, and **has no caller** (§4.1).

**5. `rapid_mm_min = 3000` has no provenance, no host declares it, and it cannot be measured yet.**
The machine was ordered 2026-07-22 with an estimated delivery of **2026-09-30**. The real number is
grblHAL `$110/$111/$112` on hardware that does not exist in the shop. **The recommendation is to
refuse the number, not to improve it** (§4.2).

**6. Nothing here has met a cut.** No output of this tool has run on a controller. A published
chart is not a coupon — including every chart quoted below.

---

## Part 0 — Provenance: where our numbers came from

*(Pass 1, 2026-08-08. Re-checked 2026-08-10 and still true of the origin commit.)*

The three material functions — `Material::chipload_factor()`, `Material::max_doc_ratio()`
and `Material::max_rpm()` — were **all introduced in one commit** and **carried no
citation anywhere in the repository** until this document was written.

```
$ git log --oneline -S 'chipload_factor' -- software/2bee.app/
15540a20a  slicer: the pickers open in the middle of the screen, ...   (UI move, values unchanged)
a0f2949eb  slicer: materials, datum, units, part marking, leads, user tools — 29/29 gates

$ git log --oneline -S 'max_doc_ratio' -- software/2bee.app/
15540a20a · 658b0e78e · a0f2949eb

$ git log --oneline -S 'max_rpm' -- software/2bee.app/
a044679e4 · 15540a20a · 658b0e78e · a0f2949eb · ad96471ef · 5d95f194c
```

`a0f2949eb` is the origin commit for all three. Its body explains the **reasoning** in
detail — acrylic melts if the chip is too thin, aluminium cannot clear chips at 24,000
rpm, an unrecognised material must report rather than fall back to plywood — and it is
good reasoning. **It cited no manufacturer, no chart and no standard.**

✅ **Closed as of 2026-08-10.** `core/src/tools.rs` now carries per-arm citations, and a `grep` for
the manufacturers returns matches in the code for the first time. The finding stands as history:
**eighteen numbers steered every emitted program for months with nothing behind them but a good
argument**, and the correction came from an audit, not from a check.

⚠ **And the same sentence is still true of the tool library.** `default_library()`'s docstring
claims its chiploads are *"the published windows for hardwood/ply in the diameter class"*. That
claim is **still uncited and still false as written** — see §3.2.

---

## Part 1 — The six-material audit, re-derived at the primary sources (2026-08-10)

### What changed since pass 1, stated as a correction and not as a fresh measurement

🔴 **Pass 1's table showed the PRE-#38 values as "ours". They are no longer the values in the code.**
Decision #38 §A landed between the two passes. Nothing is deleted below; the old value is printed
beside the new one so a reader can tell a correction from a measurement.

| Constant | Pass-1 value (2026-08-08) | Value today (2026-08-10) | What changed the answer |
|---|---|---|---|
| `chipload_factor(MDF)` | 1.10 🟠 above every source | **1.00** ✅ | #38 §A2 — moved to the top of the published band |
| `chipload_factor(Softwood)` | 1.20 🟠 above the band | **1.10** ✅ | #38 §A2 — moved inside Onsrud's 1.06–1.17 |
| `chipload_factor(Acrylic)` | 1.15 🔴 above every source | **0.75** ✅ | #38 §A2 + Onsrud's *"increase feedrate **or go to a single edge tool**"* — the remedy was a flute count, not a multiplier |
| `max_doc_ratio(Plywood/MDF/Softwood)` | 1.00 🟠 | **0.50** | #38 §A1 — prosumer machine-class cluster |
| `max_doc_ratio(Hardwood)` | 0.75 ✅ *(pass 1 called this the best-matched row)* | **0.50** | #38 §A1 — pass 1 compared it only against tooling charts and missed that 0.75 is **above** the one machine-vendor starter setting found |
| `max_doc_ratio(Acrylic/Aluminium)` | 0.50 / 0.15 | **unchanged** | — |
| `max_rpm` (all six) | 24,000 / 16,000 / 12,000 | **unchanged** | #38 §B4 flagged it and proposed no change |

⚠ **One paragraph of pass 1 was wrong in the reassuring direction and is already corrected in place**
below (the *"partially offsets the aggressive multipliers"* sentence). It is kept because a
reassuring error is the kind nobody re-audits.

### Method, stated so the comparison can be attacked

`chipload_factor()` is a **ratio**, not an absolute chipload, so it must be audited as a ratio:
read one manufacturer's chart for **the same tool series at the same cutting diameter** in two
materials, and divide. Comparing our multiplier against an absolute inches-per-tooth figure would
be comparing different things.

**Pass 2 improved the method in one way that matters:** pass 1 read the PDFs through a summariser.
Pass 2 downloaded each PDF and extracted the table with `pdftotext -layout`, then **mapped every
value to its diameter column by character offset** rather than by eye. That is why one figure in
the downstream decision document turned out to be off by one column (§1.4).

All ratios are at **1/4" (6.35 mm)**, the diameter class of our workhorse ⌀6 cutter.

### 1.1 The published ratio data, re-read 2026-08-10 (plywood = 1.00 in every row)

| Source | Series / basis | Plywood | MDF | Hardwood | Softwood | Acrylic | Aluminium |
|---|---|---|---|---|---|---|---|
| **Onsrud, per-material sheets** | **52-200/57-200 @ 1/4"** (2-flute spiral — the closest published analogue to our ⌀6 2F) | 1.00 (.006–.008") | **1.00** (.006–.008") | **0.86** (.005–.007") | **1.14** (.007–.009") | **0.71** (52-200B/BL, .004–.006") | **0.71** (52-200B/BL, .004–.006") |
| Onsrud | 56-200 @ 1/4" | 1.00 (.005–.007") | **1.00** (.005–.007") | **1.00** (.005–.007") | **1.17** (.006–.008") | — | — |
| Onsrud | 60-100MW @ 1/4" | 1.00 (.017–.019") | **0.78** (.013–.015") | **0.83** (.014–.016") | **1.06** (.018–.020") | — | — |
| Onsrud | 37-00/37-20 @ 1/4" | 1.00 (.004–.006") | — | — | — | **1.00** (.004–.006") | — |
| **Techno CNC chip-load chart** | @ 1/4" | 1.00 (.010–.013") | **1.00** (.010–.013") | **0.78** (.008–.010") | ⚠ **cannot answer** | **0.74** (.007–.010") | **0.52** (.005–.007") |
| Amana Tool | 1/4" 2-flute ball nose @ 18,000 rpm | 1.00 (wood/MDF .007–.009") | 1.00 | — | — | 0.63 (.004–.006") | 0.63 | 
| CNCCookbook | 1/2" carbide end mill, 1/4" DOC slot | 1.00 (.0143") | 0.92 (.0131") | 1.01 (.0145") | 1.06 (.0152") | — | — |

**Three corrections to pass 1's version of this table, none of them silent:**

1. 🔴 **The Techno softwood cell is not a 1.00 — it is an ABSENCE OF A DISTINCTION.** Techno's chart
   has a single column headed **"Softwood & Plywood"**. Pass 1 recorded that as *"Techno puts
   softwood and plywood in the same cell (1.00)"* and both this file and
   `decision-38-doc-ratio-recommendation.md` then counted it as a data point pulling the softwood
   ratio down toward 1.00. **A chart that does not separate two materials is not evidence that they
   are equal.** Struck as a data point; the softwood band is Onsrud's alone (1.06–1.17).
2. ✅ **Two new same-series ratios were obtained**, both from Onsrud's own sheets at 1/4":
   **acrylic/plywood = 0.71** and **aluminium/plywood = 0.71**, both from series 52-200B/BL. The
   aluminium one is new to this file and it **raises** the top of the published aluminium band from
   0.63 to 0.71.
3. ⚠ **The 37-00/37-20 acrylic parity is the WEAKEST of the acrylic readings, not the strongest.**
   It is 1.00 because that series reads .004–.006" in *both* sheets — but its plywood value is
   *below* the 52-200's plywood value (.006–.008"), i.e. it is a series that is slow in plywood, not
   a series that is fast in plastic. Pass 1 listed it first; it belongs last.

**Not re-verified in pass 2, and labelled as such:** the **CNCCookbook** row (secondary, a
calculator's output rather than a manufacturer chart) and the **Amana** row. The **Amana PDF
returned HTTP 403 again on 2026-08-10**, exactly as on 2026-08-08 — it has now failed twice and the
row remains **second-hand**. ✅ Neither row is load-bearing any more: the Onsrud same-series ratios
carry every conclusion below on their own.

**Sources read 2026-08-10** (downloaded and text-extracted locally; the diameter column of every
quoted value was resolved by character offset, not by eye):

- LMT Onsrud, *Cutting Data Recommendations* index — <https://onsrud.com/Forms/Cutting-Data-Recommendations.asp>
  - *Soft Plywood* — <https://onsrud.com/images/Soft%20Plywood.pdf>
  - *Hard Wood* — <https://onsrud.com/images/Hard%20Wood.pdf>
  - *Soft Wood* — <https://onsrud.com/images/Soft%20Wood.pdf>
  - *MDF* — <https://onsrud.com/images/MDF.pdf>
  - *Hard Plastic* — <https://onsrud.com/images/Hard%20Plastic.pdf>
  - *Aluminum* — <https://onsrud.com/images/Aluminum.pdf>
  - **NEW — *Drill Cutting Data Recommendations*** — <https://onsrud.com/images/Drill.pdf>
- Techno CNC, *Chip Load Chart* Rev 2.1 — <https://technocnc.com/wp-content/uploads/2023/03/Techno-CNC_Chip-Load-Data_Rev-2-1.pdf>
- ToolGrit, *CNC Router Speeds & Feeds Guide* — <https://www.toolgrit.com/guides/cnc-wood-speeds-feeds-guide>
- **NEW —** OpenBuilds, *Materials Speeds and Feeds Chart* (project resource, Mark Carew, released 2018-10-13, updated 2022-04-07, credited to Carbide 3D) — <https://builds.openbuilds.com/projectresources/materials-speeds-and-feeds-chart.303/>
- **NEW —** the chart itself, *Shapeoko Feeds And Speeds Chart.xlsx* as PDF — <https://community.carbide3d.com/uploads/default/original/2X/f/f3da60b5646c598f76f502ce98f81dcd4c64c6a3.pdf>
- Amana Tool chip-load chart — <https://www.amanatool.com/pub/media/custom/upload/File-1436543087.pdf> — 🔴 **HTTP 403, second attempt, second failure**

Read 2026-08-08 and **not** re-read in pass 2: CNCCookbook, the Onsrud acrylic article, Make It From
Metal, and everything in Part 5.

### 1.2 `chipload_factor()` — ours vs published, as the code stands today

| Material | **Ours (today)** | Published band, same-series where available | Verdict |
|---|---|---|---|
| Plywood | **1.00** | 1.00 by construction | ✅ the reference |
| MDF | **1.00** | **0.78 – 1.00** (Onsrud ×3, Techno) | ✅ **inside, at the top of the band.** Was 1.10 and above everything. |
| Hardwood | **0.80** | **0.78 – 1.00** (Techno 0.78; Onsrud 0.83 / 0.86 / 1.00) | ✅ inside, near the bottom |
| Softwood | **1.10** | **1.06 – 1.17** (Onsrud ×3; Techno cannot answer) | ✅ inside |
| Acrylic | **0.75** | **0.65 – 1.00** (Onsrud same-series **0.71**; Techno acrylic 0.74, hard plastic 0.65; 37-series 1.00) | ✅ inside, lower half — and within 6 % of the same-series figure |
| Aluminium | **0.35** | **0.52 – 0.71** (Techno 0.52; **Onsrud same-series 0.71**) | ✅ **below every published figure**, by a third against the lowest |

⇒ **All six are now inside or below a published band.** That is the first time this sentence has been
true, and it is the strongest thing this document says.

**On acrylic, the correction is worth keeping in full**, because the wrong version was persuasive.
The old comment defending `1.15` — *"a thin chip rubs, melts the polymer and re-welds it behind the
cutter, so the fix for a melted edge is usually MORE feed, not less"* — describes a **real and
published** phenomenon. Onsrud's Hard Plastic sheet prints the remedy verbatim:

> **"NOTE: When chip rewelding occurs while cutting plastic, increase feedrate or go to a single edge
> tool."** — read 2026-08-10

Both remedies raise the **chip**. The second does it by **halving the flute count**, and a material
multiplier cannot halve a flute count. The sheet shows the split directly at 1/4":

| Onsrud series (Hard Plastic, 1/4") | chip load per tooth |
|---|---|
| 52-200B/BL, 56-000P, 60-000, 37-00/37-20 (2-flute and insert series) | **.004–.006"** |
| 62-700 / 62-800 / 63-700 / 63-800 / 64-000 / 65-000 (**O-flute**) | **.010–.012"** |

**The physics was right and the place it was applied was wrong.** Our library has no O-flute, so the
fix landed on a 2-flute that was never entitled to it.

### 1.3 A correction to the chipload docstring, still open

`default_library()` says its chiploads are *"the published windows for hardwood/ply in the diameter
class"*. Our ⌀6 2F carries `chipload_mm = 0.10` (= .0039"). At 1/4":

| Source | Published chipload | Our 0.10 mm against it |
|---|---|---|
| Onsrud 52-200, **soft plywood** | .006–.008" = **0.152–0.203 mm** | **2.5–3× below** |
| Onsrud 52-200, **hard wood** | .005–.007" = **0.127–0.178 mm** | **1.3–1.8× below** |
| Techno, softwood & plywood | .010–.013" = **0.254–0.330 mm** | **2.5–3× below** |
| **ToolGrit, plywood, 1/4"** (prosumer) | **.003–.004" = 0.076–0.102 mm** | ⚠ **our nominal is at the TOP of this band** |

⇒ **The docstring is false as written** — 0.10 mm is below the hardwood window it names, not inside
it. And the new ToolGrit reading changes the shape of the answer: **our chipload is conservative
against industrial charts and at the ceiling of the one prosumer chart.** That is an argument
*against* raising the base chiploads, and it strengthens `decision-38` §B2's coupon gate rather than
weakening it.

> 🔴 **CORRECTED 2026-08-09, kept in place.** This paragraph used to end *"…which partially offsets
> the aggressive multipliers above in absolute feed terms."* That was WRONG, and wrong in the
> REASSURING direction — it argued that the values flagged 🔴 elsewhere in this document were already
> compensated, which is exactly the kind of claim nobody re-audits. Chipload is not the feed:
> `feed = rpm × flutes × chipload × material factor`, and `max_rpm` for wood is 24,000 while every
> feed table quoted here is stated at 16,000–18,000. `recommend` does not clamp rpm to that cap, it
> **selects** it. Three ceilings in a row.

### 1.4 `max_doc_ratio()` — ours vs published

Every tooling manufacturer checked prints the same depth rule on the face of the chart. **Verified
verbatim on all five Onsrud sheets and the Techno chart, 2026-08-10:**

> **DEPTH OF CUT: 1 x D** Use recommended chip load · **2 x D** Reduce chip load by 25 % ·
> **3 x D** Reduce chip load by 50 %

So **1 × D is the industrial *baseline*, not a ceiling.** Against that, the router-class evidence
(assembled in `decision-38-doc-ratio-recommendation.md` Part 1, **not re-verified here except
ToolGrit**) clusters at 0.24–0.51 × D, and the one slotting-specific rule halves it:

> ToolGrit, re-read 2026-08-10: *"DOC should not exceed 1x the bit diameter for softwoods and 0.5x
> the bit diameter for hardwoods"*, and **"For slotting (full-width cuts), reduce DOC to 0.5x
> diameter regardless of material."**

| Material | **Ours (today)** | Published | Verdict |
|---|---|---|---|
| Plywood / MDF / Softwood / Hardwood | **0.50** | Industrial 1×D baseline; router class 0.24–0.51×D; slotting rule 0.5×D | ✅ **at the router-class cluster and at the only slotting-specific rule.** Was 1.00 / 0.75. |
| Acrylic | **0.50** | Onsrud's acrylic table is quoted at 1×D | ✅ conservative |
| Aluminium | **0.15** | Onsrud 1×D (industrial, coolant); router guide 0.04–0.20×D for 1/4" | ✅ inside the router band, upper half |

🔴 **TWO NEW FINDINGS THAT WEAKEN AND THEN RESCUE THE 0.50, IN THAT ORDER. Both are recorded because
suppressing the first would make the second dishonest.**

**(a) Our strongest citation contradicts itself.** ToolGrit is the only source in the corpus that
addresses slotting as its own case, and it is the source `tools.rs` cites for *"regardless of
material"*. Its own plywood row, on the same page, read 2026-08-10, says:

> *"RPM: 16,000-18,000. Feed rate: 100-140 IPM. Chip load: 0.003-0.004 IPT. **DOC: up to full
> thickness for through-cuts.**"*

**A through-cut is a full-width cut.** The page therefore states the slotting rule and then exempts
the exact operation this tool emits most. Nobody had read that row before today.

**(b) A second counter-source, from our own machine's vendor community.** OpenBuilds publishes the
Carbide 3D chart as its own *Materials Speeds and Feeds Chart* project resource, described by the
host as being for *"hobby level routers"* using *"1/4" milling bits"*, with dial settings for a
DeWalt 611. The chart's wood rows, read at the artefact 2026-08-10:

| Material | DOC (chart) | Feed | Router dial → rpm |
|---|---|---|---|
| Plywood | **0.25" = 6.25 mm** | 100 ipm = 2,500 mm/min | 3 → 20,400 |
| MDF | **0.30" = 7.5 mm** | 80 ipm = 2,000 mm/min | 1 → 16,000 |
| Pine | **0.40" = 10 mm** | 75 ipm = 1,875 mm/min | 3.5 → ~21,500 |

If the host's 1/4" attribution is right, that is **1.0×D in plywood, 1.2×D in MDF and 1.6×D in pine,
on a 1.25 hp trim router** — i.e. a source pointing well ABOVE our 0.50 from the machine class we
claim to be sizing for. *(`decision-38` Part 10 item 9 excluded this chart because it states no
cutter diameter on its face. That is still true of the chart itself; the diameter comes from the
host's description, which is a secondary attribution and is flagged as one.)*

✅ **AND THEN THE TWO SOURCES RECONCILE — at chip area, which is the force-relevant quantity and
which a ratio cannot see.** The chart pairs its deep cuts with a very thin chip:

| Basis | depth × chipload | **chip area per tooth** |
|---|---|---|
| Chart, plywood (assuming the #201 3-flute) | 6.25 mm × 0.041 mm | **0.26 mm²** |
| Chart, pine | 10 mm × 0.029 mm | **0.29 mm²** |
| Chart, MDF | 7.5 mm × 0.042 mm | **0.31 mm²** |
| **US, ⌀6 2F plywood, as the code stands today** | **3.0 mm × 0.100 mm** | **0.30 mm²** |
| Chart re-read assuming a 2-flute instead | — | 0.38 – 0.47 mm² |
| Onsrud 1/4" industrial plywood at 1×D | 6.35 mm × 0.152–0.203 mm | **0.97 – 1.29 mm²** |

**All three wood rows of the hobby chart land at 0.26–0.31 mm², and our post-#38 plywood cut lands
at 0.30 mm².** The apparent contradiction between *"0.24×D"* and *"1.0×D"* is not a contradiction
at all — they are points on one chip-area curve, and #38's 0.50×D put us on it. **The conclusion
survives the flute-count uncertainty**: on the 2-flute reading the chart is *more* aggressive than
us, not less.

⚠ **This does not license raising the depth.** Reaching the chart's 1.0×D means also taking its
0.041 mm chipload — **less than half ours** — which is a *thinner* chip in a deeper slot: the
rubbing-and-burning regime, and the one thing this lane's own acrylic correction is about. **Depth
and chipload are one decision, and #38 §B1/§B2 already say so.**

✅ **A useful by-product for `decision-38` §B3.** That item proposed a chip-area cap and marked the
constant (1.0 mm²) as *"mine, not published — LOW confidence"*. It now has a **sourced band to be set
from**: 0.26–0.47 mm² is what a hobby-router chart implies for wood, 0.97–1.29 mm² is Onsrud's
industrial 1/4" figure. **The shape was right and the number now has anchors.** Setting it is still
`ops` + a coupon.

### 1.5 One figure in `decision-38` is off by one column — corrected here

`decision-38` Part 8 tabulates Onsrud's Hard Plastic O-flute series at **".008–.010""** at 1/4".
Re-read with column alignment: **.008–.010" is the 3/16" value; the 1/4" value is .010–.012".**
The 2-flute/O-flute gap is therefore **2.2×, not 1.8×** — the error is in the direction that
*strengthens* that document's argument, and it changes none of its conclusions. Recorded so the
number is not re-quoted from the summary.

### 1.6 `max_rpm()` — ours vs published

| Material | **Ours** | Published | Verdict |
|---|---|---|---|
| Plywood / MDF / Hardwood / Softwood | **24,000** | Techno: *"The general operating RPM for Techno CNC **Tooling** is between 12,000 – 24,000 RPM"* (verified verbatim 2026-08-10) | ✅ **exactly the published ceiling — FOR ROUTER CUTTERS.** 🔴 See §3.3: `recommend` also hands it to drills, and the sentence quoted says *tooling*, which on that page means router bits. |
| Acrylic | **16,000** | Onsrud's acrylic article states its feed table at 18,000 rpm | 🟡 conservative — and it refuses the manufacturer's own setpoint |
| Aluminium | **12,000** | Onsrud's Aluminum sheet footnotes **`* 16,000 RPM`** for series 40-000/57-000 (verified 2026-08-10) | ✅ conservative — below every source found |

The Aluminum sheet's own note, verbatim, corroborates the *mechanism* the code cites even though the
specific 12,000 is ours: *"When cutting soft aluminum a squirt of cutting fluid every now and then
will help to eliminate chip rewelding."*

⚠ **Techno prints one more caveat that nothing in our code models**, and it is the closest any chart
comes to naming its own scope: *"Chip loads are based on material thickness of average size for
cutting edge length of tool. **These recommendations do not apply to thicker material or Techno CNC
tools with long cutting-edge lengths.**"* We cut 18 mm plywood with a ⌀6 cutter of 25 mm cutting
length. **The qualifier is about the TOOL, and there is still no chart that qualifies itself by
MACHINE.**

---

## Part 2 — The machine we do not have

### 2.1 The machine we DO have, and its delivery date

| Property | Value | Source |
|---|---|---|
| Frame | **Bellwether Lead 1000×1500** — C-Beam gantry, ACME lead screws, ~90 mm Z | `hardware/cad/2bee_cnc_table/cnc_e2e_requirements.md` §3.1 |
| Motion | 4× HBS57 **closed-loop**, NEMA23 3.6 N·m, dual-Y slaved | ibid. §3.2 |
| Spindle | 2.2 kW water-cooled, 24,000 rpm, ER20 | ibid. §3.3 |
| Control | grblHAL on SKR Pro | ibid. §3.5 |
| Accuracy requirement | **FR3 — ≤ 0.1 mm over the joint features** | ibid. |
| **Status** | 🟢 **IN THE SHOP — arrived 2026-09-04**, 26 days ahead of the estimate. ⚠ The order record stays as a record: ordered 2026-07-22, *estimated* delivery 2026-09-30 — that estimate was true as an estimate and is not corrected, only overtaken. | `ceo` 2026-09-05, from `bom` and `pnp` recording the arrival independently at that date |

🔴 **CORRECTED 2026-09-05 — AND THIS WAS A STALE PREMISE, NOT A STALE FACT.** This paragraph read
*"The machine is not in the shop … not merely unmeasured but **unmeasurable today** … the honest form
is not a better number, a refusal."* ⚠ **It did not just state something false; it LICENSED a caveat
over every machine-dependent number below it**, so when the premise flipped, the scope of that
licence changed with it — and a reader trusting the caveat was being told to discount numbers that
could now be obtained.

⚠ **THE MACHINE IS IN THE SHOP. NOTHING HAS BEEN CUT.** Those are two different facts and only the
first one changed. The depth ratio, the rapid rate and the feed ceiling are **still unmeasured** —
but they are **no longer unmeasurable**, and that is the whole of the difference: *"nobody has run it
yet"* is an open task, where *"it cannot be run"* was a refusal. ⇒ **Rows below that were refusals
BECAUSE the machine was absent are now MEASUREMENTS OWED, and the reason for each has to be re-read
rather than assumed to still hold.**

🔴 **Do not read the arrival as validation of anything.** Air cut → foam/MDF coupon → real ply are
all still unclimbed, and no material-removal claim in this lane has ever been checked against a
physical part.

### 2.2 The finding: there is no machine term in any cutting parameter

`Material::max_doc_ratio()`, `Material::chipload_factor()` and `Material::max_rpm()` take one
argument: the material. The only machine properties that reach a cutting decision at all are
`spindle_max_rpm` (a `min` against the material cap), `collet_mm` (a refusal), the travel envelope
(a refusal) and `max_feed_mm_min` (§4.1, and only on one door).

**Measured 2026-08-10** — `./target/release/2bee-slice job plate` with a ⌀6 down-cut in plywood,
identical stock, changing only the machine:

```
machine A: travel 1250 x 670 x 100   (Bellwether Lead — C-Beam / ACME gantry)
machine B: travel  600 x 900 x 200   (the app's "MakerSpace 6090" preset)
  -> 11,617 bytes each, cmp: BYTE-IDENTICAL
  -> both: "depth per pass reduced from 6.00 to 3.00mm — Plywood will not take
            a deeper cut with a 6.00mm tool"
```

*(Binary built 2026-08-10 22:18 from a working tree that has been edited since; the values it
embodies were confirmed by reading `core/src/tools.rs` directly.)*

**The app ships three machine presets** (`web/src/App.tsx:103`): `Bellwether Lead 1250x670`,
`MakerSpace 6090`, `Desktop 3018`. **All three get the same depth of cut, the same chipload and the
same spindle ceiling.** A Desktop 3018 is a benchtop machine of roughly a tenth the mass; the
program it is handed authorises a **3 mm-deep full-width slot with a ⌀6 cutter** exactly as the
C-Beam gantry's does.

⇒ **This is the general form of "sourced to a machine we do not have".** It is not that one row
inherited an industrial figure. It is that **the depth constant is a property of the machine and the
engagement, and it is stored on the material**, so there is no place in the data model where the
answer could differ by machine even if we knew it. *(Same defect family as the one the lane already
names for touch plates: three physical owners collapsed into one field.)*

### 2.3 The honest form, per the brief's three options

| Number | Honest form | Why |
|---|---|---|
| `max_doc_ratio` = 0.50 for the woods | ✅ **A stated number WITH ITS MACHINE CLASS** — keep 0.50, and make the report say which class it is defended for | The value is well placed (§1.4); what is missing is the qualifier every chart also omits. Publishing it silently is how we inherited the defect in the first place. |
| `max_doc_ratio` on a preset outside that class (`Desktop 3018`) | 🔴 **REFUSE TO PUBLISH A NUMBER** | We have no evidence at that machine class and inventing one would be the acrylic defect again. The lane's own doctrine — *"'no clamps declared' and 'clamps checked' are different facts"* — applies unchanged. |
| Drill speeds and feeds | 🔴 **REFUSE TO PUBLISH A NUMBER** (§3.3) | The router-bit ceiling does not transfer; the published drill model is a different model. |
| `rapid_mm_min` | 🔴 **REFUSE TO PUBLISH A NUMBER** (§4.2) | Not measurable until the machine lands; the lane already has the right pattern for this in `tool_change_seconds`. |
| `chipload_factor` ×6 | ✅ **Numbers, as they stand** | All six are inside a published same-series band. |

**Recommended, not applied — the owner is the lane and the physical half is `ops`:** carry a
**rigidity class** on `Machine` (the one field that would let the depth constant differ by machine),
and until it exists, name the defended class in the note that already prints *"Plywood caps it at
24000rpm and 3mm per pass"*. That note is read by the operator and is the cheapest place a missing
qualifier can be added.

---

## Part 3 — Every number that reaches an emitted program

**Read from the code on 2026-08-10, not from this document's own previous pass.** Status key:
**SOURCED** = traced to a primary published figure · **WRONG CLASS** = sourced, but to a different
machine or tool class · **INVENTED** = no source found or claimed · **CONVENTION** = a value whose
job is to be a safe default rather than a measurement.

### 3.1 Per-material — `core/src/tools.rs`, 18 numbers

| Number | Value | Status |
|---|---|---|
| `chipload_factor()` × 6 | 1.00 / 1.00 / 0.80 / 1.10 / 0.75 / 0.35 | ✅ **SOURCED** (§1.2) |
| `max_doc_ratio()` × 6 | 0.50 ×5, 0.15 alu | 🟠 **WRONG CLASS by construction** — the value matches our machine class, the *function* has no machine term (§2.2) |
| `max_rpm()` × 6 | 24,000 / 16,000 / 12,000 | 🟠 24,000 **SOURCED for router cutters**, **WRONG CLASS for drills** (§3.3); the other two **conservative, specific value INVENTED** |

### 3.2 Per-tool — `default_library()`, 51 tools

| Group | Count | Chipload numbers | Status |
|---|---|---|---|
| End mills (⌀3.175 / 4 / 6 down / 6 up / 6 compression / 8 / 12) | 7 | (min, nom, max) each | 🟠 **PARTLY SOURCED.** Only the ⌀6 nominal (0.10 mm) has been compared to anything (§1.3), and the comparison shows the docstring's claim is false. The other six are **INVENTED**. |
| Ball nose, surfacing | 3 | — | 🔴 **INVENTED** |
| **Drills — brad point 15, twist 8, dowel 6** | **29** | generated by formula: `(d*0.02).clamp(0.05,0.25)`, `(d*0.015).clamp(0.03,0.20)`, flat `0.10` | 🔴 **INVENTED, and the wrong QUANTITY** — see §3.3 |
| Countersinks, V-bits, chamfer, engraving | 12 | — | 🔴 **INVENTED** |
| `rpm_min = 8_000`, `rpm_max = 24_000` | **all 51** | — | 🔴 **INVENTED and uniform.** Every tool in the library, from a ⌀1 twist drill to a ⌀25 surfacing cutter to a ⌀16 brad point, declares the same speed window. A 16 mm brad point cannot be run below 8,000 rpm by this library. |
| `cutting_length_mm` | 51 | — | ✅ the ⌀6 entry (25 mm) **matches the cutter actually ordered** — XCAN 6×25×50, `cnc_e2e_requirements.md` line 397. Geometry corroborated; chipload still not. |

🔴 **The tools we actually bought publish nothing.** `bom` records the purchased set as **⌀6
compression ×3 + ⌀6 straight ×2** from AliExpress (XCAN Official Store, ordered 2026-07-23) plus
⌀2.7 drills. **These are unbranded/low-cost carbide with no published chipload table of any kind.**
So the brief's *"manufacturer chipload tables for the actual cutters in our library"* **do not
exist**: every figure in §1 is a *substitution* from a named industrial series onto an unnamed
cutter of the same nominal geometry. That substitution is the best evidence available and it is
still a substitution — and it is the reason the honest ceiling on all of this is a coupon, not a
better PDF.

### 3.3 🔴 The drill path — the router ceiling applied to a tool it was never written for

**Measured 2026-08-10**, ⌀6 brad point through 18 mm plywood, `tool_ids` door, default machine:

```
M3 S24000
G98 G83 X230.000 Y90.000 Z-18.000 R5.000 Q4.000 F5760.0
```

and the note the operator reads:

> *"Plywood caps it at 24000rpm and 3mm per pass, so 6 pass(es) at 5760mm/min"*

**Against LMT Onsrud's *Drill Cutting Data Recommendations*, read 2026-08-10** — a sheet nobody in
this lane had opened before today:

| | Onsrud, wood drill series 72-000 | Ours |
|---|---|---|
| Rating quantity | **inches per REVOLUTION** (IPR) | chip per TOOTH × flutes |
| Speed derived from | **surface speed**: `RPM = (3.82 × SFM) / tool dia.` | the router-bit material ceiling |
| Value at **6 mm** | **.013–.015 in/rev = 0.33–0.38 mm/rev** | 5760 / 24000 = **0.24 mm/rev** |
| Only spindle speed printed for wood drilling | footnote: ***"Gang drills run at 4,500 RPM and 150 IPM"*** | **24,000 rpm** |

⇒ **Three distinct defects, and only the first is a number:**
1. Our feed per revolution is **35–45 % below** the published window at the same diameter.
2. Our spindle speed is **5.3× the only wood-drilling rpm the sheet prints.** A thin chip at a high
   surface speed is the burning regime — the exact mechanism this lane already corrected for in
   acrylic.
3. **The model is wrong, not just the value.** Onsrud rates drills by IPR against SFM; we rate them
   by chip-per-tooth against a router ceiling. `Material::max_rpm()`'s citation is Techno's sentence
   about *"Techno CNC **Tooling**"*, which is a router-bit page.

⚠ **I could not source a brad-point rpm figure**, and the deliberate outcome is: **no drill speed or
feed number is published in this document.** The nearest published thing is the Onsrud row above,
and it does not transfer, because it is a gang-drill/production-boring figure and our drill is in a
24,000 rpm router spindle. Naming a plausible number here would be the `touch_plate_mm` mistake in a
new field.

**Recommended, not applied:** the drill path should stop *selecting* `Material::max_rpm()` and
should report that a drill speed has not been declared — the same three-way shape the lane already
uses (`None` ≠ `Some(0.0)` ≠ a value). Owner: this lane for the shape, `ops` for the number.

### 3.4 Per-machine — `Machine::default()`, `core/src/types.rs:989`

| Field | Default | Reaches | Status |
|---|---|---|---|
| `rapid_mm_min` | **3,000** | the run-time **estimate** (`job.rs:762`); no `F` word (a `G0` has none) | 🔴 **INVENTED** — §4.2 |
| `max_feed_mm_min` | **6,000** | the emitted `F` word, **on one door only** | 🔴 **INVENTED, and partly unenforced** — §4.1 |
| `safe_z_mm` | 5.0 | every retract | 🟡 CONVENTION |
| `spindle_min_rpm` / `spindle_max_rpm` | 6,000 / 24,000 | the `S` word via `rpm_cap` | 🟡 24,000 matches the ordered spindle ✅; 6,000 INVENTED |
| `spindle_spinup_s` | 2.0 | `G4 P2.00` | 🟡 CONVENTION |
| `probe_seek_feed` / `probe_feed` | 200 / 25 | `G38.2 … F200.0` / `F25.0` | ⚠ **PROVENANCE CLAIM UNVERIFIED.** The field comment says *"these default rates are grblHAL's own"*. grblHAL exposes no `$` setting for a probe feed — the rate is commanded by the sender in the `G38.2` block — so the attribution needs a citation or a rewording. Recorded as an unsourced claim about a number, not as a wrong number. |
| `travel_*`, `collet_mm`, `spoilboard`, `touch_plate_mm`, `tool_change_seconds` | — | refusals / reports | ✅ already handled as declare-or-refuse |

### 3.5 Per-operation — `OperationParams::default()`, `core/src/types.rs:1304`, and elsewhere

| Field | Default | Status |
|---|---|---|
| `rpm` | 18,000 | 🟡 CONVENTION — and note it is **not** what `recommend` picks (24,000), so the same job emits a different `S` word by door |
| `depth_per_pass_mm` | 3.0 | 🟡 CONVENTION — and coincidentally **exactly** the ⌀6 plywood cap, which makes the clamp invisible on the commonest job |
| `plunge_mm_min` | **300** | 🔴 **INVENTED.** Reaches the program as `F300.0` on every ramp and entry move. No source in this lane or in any chart read. |
| `peck_depth_mm` | **4.0** | 🔴 **INVENTED.** Emitted as `Q4.000` in every `G83`. |
| `ramp_length_mm` | **20.0** | 🔴 **INVENTED** — it sets the ramp angle for a given pass depth, which is a real cutting parameter |
| `tabs`: `height 3.0`, `width 8.0`, `min_spacing 150.0` | | 🔴 **INVENTED** — and tab geometry is what holds the part at the end of the program |
| `finish_allowance_mm` 0.0, `lead_mm` 0.0 | | ✅ zero = off, a declared choice |
| **pocket stepover** `diameter × 0.45` | hard-coded, `core/src/fixtures.rs:669` | 🔴 **INVENTED, and not exposed.** 45 % radial engagement is a cutting decision the operator cannot see or change. |

### 3.6 Two feed formulas, and which one runs depends on the route

- `feeds::feed_from_chipload(tool, rpm)` — **material-blind**; used by `toolpath.rs:539` and
  `rect_profile.rs:163` when `feed_mm_min <= 0`.
- `tools::feed_for(tool, rpm, material)` — **material-aware**; used by `job.rs:1194/1220` and
  `recommend.rs:600`.

On the planned path the material pass runs first, so the material-aware one wins. **Anything that
builds a toolpath without going through `plan_job` gets the material-blind feed** — which is to say,
a plywood feed, in whatever material.

---

## Part 4 — The two questions the brief asked to settle

### 4.1 `machine.max_feed_mm_min` — declared, unevenly enforced, and "clamp" is not the whole answer

**The brief's premise is now half stale, and the correction matters.** `feeds.rs`'s header still says
the formula is *"Deliberately NOT clamped to the machine here"* — true of `feeds.rs` — but a clamp
**does** exist at `core/src/recommend.rs:600`:

```rust
let feed = feed_for(&spec.tool, rpm, material).min(machine.max_feed_mm_min);
```

**Measured 2026-08-10** (`job plate`, ⌀6 down-cut, plywood, `max_feed_mm_min: 900` declared):

| Door | Config key | Emitted `F` words |
|---|---|---|
| `job.rs` | `"tool_id"` | **F3600.0** — the declared 900 ignored entirely |
| `recommend` | `"tool_ids"` | **F900.0** for the profile … **and F1800.0 for the marking ops** |

⇒ **Three findings, one of them new:**
1. **Which door you enter decides whether a machine limit exists.** In the browser that is not a
   developer choice — `web/src/App.tsx:2211` sends `tool_ids` when more than one tool is selected
   and `tool_id` otherwise. **Selecting a second cutter turns the feed ceiling on.**
2. 🔴 **NEW: even the clamped door leaks.** `recommend` clamps only the operations it *assigns*.
   The part-marking ops kept their own ⌀3.175 cutter, derived their feed through `job.rs`, and
   emitted **F1800 against a declared 900 mm/min ceiling.** The CLI's own doc block says the limit
   reaches the program *"on exactly ONE of three routes"*; the measurement above narrows that
   further — **on that one route, only for the ops it reassigned.**
3. ✅ The CLI **reports** this (`unenforced_feed_limit`, `cli/src/main.rs:1251`) and changes no
   coordinate, which is the right call for a host. **The browser has no equivalent**, so the
   product surface most people use is silent about it.

🔴 **And now the part that decides the answer. CLAMPING ALONE PRODUCES AN OUT-OF-WINDOW PROGRAM,
and it does so at default settings with a shipped tool.** Measured 2026-08-10, ⌀12 2F end mill in
plywood through the `tool_ids` door, **no feed limit declared by the caller** (so the core's own
6,000 default applies):

```
M3 S24000
G1 X62.000 Z-0.600 F6000.0
```

- Uncapped feed would be `24,000 × 2 × 0.30 × 1.00` = **14,400 mm/min**.
- Clamped to the default ceiling: **6,000 mm/min**.
- Delivered chipload: `6000 / (24000 × 2)` = **0.125 mm/tooth**.
- That tool's own declared window: **`chipload_min_mm = 0.15`**, max 0.50.

**The emitted program runs the cutter below its own rated minimum chip, and nothing says so.** A
thin chip rubs instead of cutting: heat, a burnt glue line, a packed flute and a dulled cutter —
the exact mechanism this document already documents for acrylic, arriving through the *safety*
control.

🔴 **`core/src/feeds.rs:27` contains the check that would catch it — `chipload_in_window()` — and it
has NO CALLER.** Verified 2026-08-10: exported at `lib.rs:45`, referenced only by its own unit
tests. A dormant control reads as coverage.

**Recommended behaviour — clamp AND hold the chipload, refuse when you cannot** *(this lane's
decision; the physical half belongs to `ops`)*:

1. **Clamp in the CORE**, in `plan_job`'s per-operation loop that already caps depth and rpm — not
   in a host. A limit enforced in the CLI and not in the core is the same defect wearing a hat: the
   browser runs the same core.
2. **Then hold the chip, not the speed.** A clamped feed at unchanged rpm *thins the chip*. The
   honest correction is to reduce rpm to `F_max / (flutes × chipload × factor)` so the chip
   thickness is preserved and only the throughput falls. For the ⌀12 above that is
   `6000 / (2 × 0.30)` = **10,000 rpm** — inside the tool's window (min 8,000) and the machine's
   (min 6,000). **The fix exists and is reachable at default settings.**
3. **Refuse when the rpm floor blocks it** — if the required rpm is below `max(tool.rpm_min,
   machine.spindle_min_rpm)`, there is no speed that is both runnable and in-window, which is
   exactly the shape `rpm_rejection()` already uses for the material cap.
4. **Give `chipload_in_window()` its caller** on the emitted result, and say so in a note either
   way. A clamp that is silent about what it did to the chip is a green about the wrong thing.
5. **Never clamp a feed the caller pinned** — a typed `feed_mm_min` is a declaration and should be
   *refused* against the ceiling, not quietly reduced.

⚠ **Warn-only is not enough here and refuse-only is disproportionate.** The failure is a burnt edge
and a dead cutter, not a crash — but it is **invisible**, and this lane's rule is that an invisible
wrong number is worse than a loud refusal. Clamp + hold-the-chip + say so is the proportionate one.

### 4.2 `rapid_mm_min = 3000` — what is needed, from whom, and why the answer is a refusal

**What it does today:** it is used in exactly one place, `core/src/job.rs:762`, to charge every `G0`
in the run-time estimate. **It reaches no coordinate and no `F` word** — a `G0` carries no feed. So
this is a *wrong number*, never a *wrong cut*.

**Who declares it:** nobody. `MachineCfg` accepts `rapid_mm_min`, and **no host sends it** —
verified 2026-08-10 across `web/src/` and `wasm/src/`: the browser's `config.machine` object
(`App.tsx:1945`) sends travel, safe-Z, collet, spindle max, probe and spoilboard, and **no feed or
rapid field at all**. The browser then reads `report.rapid_mm_min` back to colour rapid moves and
price them. ⇒ **Every browser plan in existence has been estimated at a generic 3,000 mm/min.**

**Why 3,000 is not merely unsourced but unanchored:**

| Anchor | Value |
|---|---|
| grbl / grblHAL firmware default `$110` (`DEFAULT_X_MAX_RATE`) | **500 mm/min** |
| **Ours** | **3,000 mm/min** — 6× the firmware default |
| The real number | `$110` / `$111` / `$112` as configured on **our** SKR Pro, which depends on the ACME lead, microstepping and the HBS57 step rate |

**And it cannot be measured yet.** The Bellwether was ordered 2026-07-22 with an estimated delivery
of **2026-09-30** (§2.1). There is no `$110` anywhere in the repo — `grep` across
`hardware/`, `software/` and `docs/` returns no grblHAL max-rate setting for the CNC, and
`hardware/cad/2bee_cnc_table/cnc-skr-pro-config.md` covers the VFD parameter set and the pin map,
not the motion settings.

🔴 **Recommended: refuse the number rather than improve it — `Option<f64>`, exactly like
`tool_change_seconds`.** The precedent is three fields away in the same struct and its doc block
already argues this case: a value that decides *"only what a number in a report says"* gets a
**fallback that announces itself on the report** (`EstimateBasis::tool_change_rate_declared`),
while a value that decides where the cutter goes gets a **refusal**. `rapid_mm_min` is squarely in
the first category, and it is currently the one member of that category with a silent default.
⚠ **Do not make it a refusal** — refusing a physically sound program over a reporting rate would be
out of proportion, and this lane has already ruled that way once.

⚠ **And a correct `$110` would still not make the estimate right.** The report already says the
estimate *"does NOT model acceleration or deceleration"* and therefore under-reads — worst on the
many-short-segments programs this tool emits (86 of 311 motion blocks ≤ 2 mm on the `plate`
fixture). **A sourced rapid rate fixes the rate and not the model.** Both halves belong in the
basis line.

**What is needed, and from whom — `pcb` owns the controller** (`AGENTS.md`: *"grblHAL capability
facts … come from here — verify, don't assume"*):

| Ask | Setting | Why it is needed |
|---|---|---|
| Max rate, per axis | **`$110`, `$111`, `$112`** (mm/min) | The rapid rate is **per axis**, and a diagonal `G0` runs at the slowest axis's limit. **One scalar cannot express it** — recording that is part of the ask, not a detail. |
| Acceleration, per axis | **`$120`, `$121`, `$122`** (mm/s²) | Without it the estimate under-reads by an unknown amount; with it the estimate could stop being a floor. |
| Provenance | which machine the `$$` dump was taken from, the grblHAL version, and the date | An id is not a location: *"read from the controller"* is not an answer unless it names which controller. |
| Timing | **not before the frame is commissioned** | ⚠ A value typed from a spec sheet before the machine exists is exactly the plausible-number-that-runs this lane refuses elsewhere. |

*(Recorded here rather than filed: this task's write scope is this file only. The ticket to `pcb`
is the lane owner's to send.)*

---

## Part 5 — Standard sheet sizes, as the market sells them

> ⚠ **PASS 1 CONTENT, UNCHANGED AND NOT RE-VERIFIED ON 2026-08-10.** Every source below carries a
> read date of **2026-08-08**. This pass covered the numbers that drive the cutter; the sheet-stock
> research was not re-opened. **Do not read its figures as freshly confirmed.**

🔴 **This section does NOT settle our contested sheet basis, and must not be read as doing
so.** The repo holds three live numbers — `cnc_nest/README.md` says **2700 × 1200**, `ops`
says **600 × 900**, `bom`'s 2026-07-18 correction says **2400 × 1200**. **Which one WE buy
is `bom` + `ops`'s question, not this lane's.** What follows is only *what the market
offers*; the finding that more than one of the three is genuinely stocked is an argument
for keeping all three offered, not for picking one. The UI offers all three and defaults
to none, deliberately.

### Plywood — Australia

| Size (mm) | Status | Note | Source (read 2026-08-08) |
|---|---|---|---|
| **2400 × 1200** | **SOURCED** | The dominant AU/NZ standard, confirmed independently at three suppliers | <https://www.bunnings.com.au/structaply-2400-x-1200mm-19mm-plywood-structural-cd-grade_p0340167> · <https://plyco.com.au/products/cd-structural-plywood> |
| **2700 × 1200** | **SOURCED** | A **real second standard length**, not a fringe size. The Ecoply specification guide §1.2 states lengths of *"2400mm and 2700mm with a standard nominal width of 1200mm"*. Softwood CD structural. | <https://chhply.co.nz/assets/Uploads/EcoplySpecificationInstallationGuideCurrent.pdf> (p.4) |
| **2440 × 1220** | **SOURCED** | The metric-4×8ft **import** size — marine and imported hardwood lines, sold in AU alongside the 2400 × 1200 local-mill size. Distinct product streams at the same retailer. | <https://www.bunnings.com.au/2440-x-1220mm-12mm-plywood-hardwood-marine-aa-grade-12mm_p0320024> · <https://blog.plyco.com.au/marine-plywood-dimensions> |
| **1800 × 1200** | **SOURCED** | Stocked (ArmourPly hardwood structural, SpecRite formply) | <https://www.blackwoods.com.au/hardware-building-construction-materials/building-essentials/timber-plywood/big-river-group-armourply-hardwood-plywood-structural-f27-dd-2400-x-1200-x-18mm/p/04311136> |
| **1525 × 1525**, **1525 × 3050** | **SOURCED** | Baltic/birch mill sizes, imported into AU | <https://www.plyonline.com.au/collections/birch-plywood> · <https://www.plyonline.com.au/products/oversize-baltic-birch-plywood-bb-bb-ext-1525x3050-mm-region-id-888999> |
| **1200 × 900** and **600 × 900** "handy panel" | 🟠 **GENERIC as stated** | Precut panels of roughly this size are genuinely sold, but the AU precut range clusters on **1200 × 896 / 897** and **897 / 896 × 600** — *not* on a round 900. **Do not hard-code 1200 × 900 or 600 × 900 as literal stocked SKUs.** Directly relevant: `ops`' "600 × 900" is very likely this family, and its real dimension is probably not 900. | <https://www.bunnings.com.au/products/building-hardware/timber/timber-boards/plywood> |

### Plywood thickness — where "18 mm" is not 18 mm

This is the finding with the most direct bearing on a through-cut.

- **The AU structural nominal ladder has no 18 mm rung.** Ecoply's own specification guide
  lists CD structural (AS/NZS 2269) nominal thicknesses as **7, 9, 12, 15, 17, 19, 21,
  25 mm** — it jumps **15 → 17 → 19**. **SOURCED:**
  <https://chhply.co.nz/assets/Uploads/EcoplySpecificationInstallationGuideCurrent.pdf> (p.4, §1.2 Table 1).
- **And yet "18 mm" ply is sold in AU/NZ.** CHH Ply's own technical note on the CMPC 18 mm
  CD product states it is *"suitable for specification … where 17mm (or less) Ecoply has
  been specified"* — the supplier itself treats its **18 mm** product as the substitute for
  the **17 mm** nominal one. **SOURCED:**
  <https://chhply.co.nz/assets/Uploads/18mm-CMPC-Plywood-Technical-Note-Current.pdf>.
  ⇒ **"18 mm ply" in Australia is a label spanning at least two different real
  thicknesses.** A through-cut depth taken from the label is a guess.
- **The numeric tolerance could not be sourced.** Both supplier documents defer to
  *"thickness tolerances stated in AS/NZS 2269"* without quoting the table, and the standard
  is paywalled. **GENERIC — we do not have the ± mm figure.**
- **EN 315** (the European ply thickness-tolerance standard, applicable to birch/Baltic) —
  a band of **+0.74 / −0.94 mm** is widely repeated but could not be opened at a primary
  text. **GENERIC.**
- **US 3/4″ = 19.05 mm nominal**, but US panels are trimmed under nominal — commonly
  **1219 × 2438 mm** rather than a true 1219.2 × 2438.4, and sanded under nominal in
  thickness. **Consistent across trade sources, not a mill spec sheet — treat as
  GENERIC-leaning.** <https://smartcutlist.com/glossary/4x8-sheet>

⇒ **Practical consequence for this lane:** nominal thickness is a **label**, not a
measurement. Any through-cut depth derived from a user-typed nominal carries a real risk of
either leaving an uncut skin or driving the cutter into the spoilboard. This is evidence
for a *measured-thickness* input and a stated over-travel, **not** for hard-coding a
tolerance number we could not source.

### Ply grades and bond classes for outdoor hive parts

⚠ **Correction to a common assumption, verified both ways:** **AS/NZS 2272 is the MARINE
plywood standard; AS/NZS 2271 is EXTERIOR (non-structural).** They are frequently
transposed.

| Standard | Covers | Source (read 2026-08-08) |
|---|---|---|
| **AS/NZS 2269** | **Structural** plywood — veneer/bond quality, lay-up, tolerances, F-grades | <https://chhply.co.nz/assets/Uploads/EcoplySpecificationInstallationGuideCurrent.pdf> |
| **AS/NZS 2271** | **Exterior** plywood and blockboard — appearance-grade, A-bond, non-structural | <https://store.standards.org.au/product/as-nzs-2271-2004> |
| **AS/NZS 2272** | **Marine** plywood — AA/OO faces, F14, Type A phenolic bond per AS 2754.1 | <https://boatcraft.com.au/informationpages/marine_plywood_as2272.htm> |
| **AS/NZS 1604.3** | Preservative treatment. Ecoply's guide describes **H3.2 CCA / H3.1 LOSP** as suitable for *"outside, above ground, subject to periodic moderate wetting and leaching"* | <https://chhply.co.nz/assets/Uploads/EcoplySpecificationInstallationGuideCurrent.pdf> (§1.4, p.6) |

**Bond class is the weatherproofing property, not the face grade.** Type **A-bond**
(phenolic, PF) is the fully weatherproof bond and is used in **both** marine (2272) and
structural CD (2269) plywood; **C-bond** is interior-only and delaminates on repeated
wetting. Face grades A/B/C/D describe **appearance**, not durability. **SOURCED:** same
Ecoply guide, p.4–5 Table 2A.

⇒ For an outdoor hive box, the durability question is answered by **A-bond + an H3
treatment**, not by buying marine grade. Marine's extra requirement is face-veneer
appearance and defect limits. **That said, which grade we specify is `bom`'s call, not
this lane's** — recorded here only because it determines what the cutter meets.

**Baltic/birch:** EN 636-2/636-3 with Type A (WBP) glue is the European exterior
equivalent, imported into AU. **Partially sourced** — the class boundaries came from a
reseller summary, not the EN text. Treat the class detail as **GENERIC**.

### MDF — Australia

| Fact | Value | Status |
|---|---|---|
| Sheet sizes | **2400 × 1200** and **3600 × 1200** both confirmed stocked | **SOURCED** — <https://www.bunnings.com.au/16mm-mdf-panel-standard-2400-x-1200mm_p0590059> · <https://www.bunnings.com.au/3600-x-1200-x-32mm-mdf-standard-panel_p0590014> |
| Further sizes (2400 × 1800, 2700 × 900, 2700 × 1200, 3600 × 1800) | claimed as standard AU sizes | **GENERIC** — not independently confirmed at a supplier page |
| Thicknesses | 3 – 32 mm, corroborated across many individual SKUs (12/16/18/25/32 mm seen) | **SOURCED** |
| Standard | **AS/NZS 1859.2** (Fibreboard) — Standard, MR/HMR and treated grades | **SOURCED** — <https://www.standards.govt.nz/shop/asnzs-1859-22017> |
| Thickness tolerance (**±0.2 mm** claimed) | — | 🔴 **GENERIC.** The two candidate primary PDFs would not yield text. **"MDF is true to nominal" is plausible and unverified — do not encode it.** |

### Acrylic (PMMA)

| Fact | Value | Status |
|---|---|---|
| AU sheet sizes | **2440 × 1220** and **3050 × 2030** confirmed as stocked SKUs | **SOURCED** — <https://www.perspexonline.com.au/perspex-cut-to-size/> · <https://www.perspex.com.au/shop/item/1> |
| Further AU sizes (2500 × 1950, 3050 × 2050, 2490 × 1880, 1880 × 1270, 1830 × 1220, 3020 × 2020) | listed by suppliers | **GENERIC** — not individually confirmed |
| Thicknesses | 1.5, 2, 3, 4.5, 6, 8, 10, 12, 15, 20, 25, 30 mm | **GENERIC-leaning** |
| **Cast** thickness tolerance | Per ISO 7823-1, as published by Röhm/Evonik ACRYLITE: **3.0 → 2.3–3.7 mm · 6.0 → 5.0–7.0 mm · 12.0 → 10.4–13.6 mm · 18.0 → 15.8–20.2 mm · 24.0 → 21.2–26.8 mm** | ✅ **SOURCED — the best-sourced number in this document.** <https://www.acrylite.co/resources/knowledge-base/article/what-is-the-thickness-tolerance-of-acrylite-r-cast-gp-acrylic-sheet?category=product-properties> |
| **Extruded** thickness tolerance | ±10 % at ≤3 mm, ±5 % above, per ISO 7823 | **SOURCED** (supplier technical page citing the ISO) — <https://www.uvplastic.com/blog/extruded-vs-cast-acrylic-sheet.html> |

⇒ **Cast acrylic's real thickness spread is ±1 mm at 3 mm nominal and ±2 mm at 18 mm
nominal.** That is far wider than plywood's, and it makes any depth-of-cut derived from a
nominal thickness materially riskier on cast sheet than on ply. **Measure, do not assume**
— and this is a *sourced* basis for saying so, not an intuition.

### Aluminium sheet — Australia

| Fact | Value | Status |
|---|---|---|
| Sheet sizes | Widths **900 / 1200 / 1500 mm**; lengths **1800 / 2400 / 3000 / 3600 / 6000 mm** — so **1200 × 2400** and **1500 × 3000** are both real | **SOURCED** — <https://www.australwright.com.au/products/aluminium/aluminium-sheet-plate/> |
| Thicknesses (sheet) | 0.6 / 0.8 / 1 / 1.2 / 1.6 / 2 / 2.5 / 3 / 4 / 5 / 6 / 8 / 10 / 12 mm | **SOURCED**, same page |
| Thin-sheet alloys stocked AU | 5005-H34, 5052-H32, 5251-H32/H34, 5083-H116/H321, 1100-H25 | **SOURCED**, same page |
| 6061 | mostly stocked as **plate** (12 mm+) in AU, less common as thin sheet | **SOURCED** — <https://www.shapealuminium.net.au/index.php?route=product/category&path=216> |
| Machinability | **6061 "Good"; 5052 "Poor"** — 5xxx is gummy, builds up on the edge | **SOURCED** — <https://proleantech.com/5052-vs-6061-aluminum/> |
| Gauge → mm | 18 ga = 0.0403″ = **1.02 mm**; 20 ga = 0.0320″ = **0.81 mm** — never round metric | **SOURCED-leaning** — <https://sheetgauge.com/aluminum-sheet-gauge-to-mm-inches-chart/> |

⚠ **A finding worth passing to `bom`, not a data point:** the alloys AU merchants stock as
thin routable sheet (**5005 / 5052**) are the ones rated **worst** for clean routing, and
the alloy rated **best** (**6061**) is mostly stocked as thick plate. Anyone sizing an
aluminium job off "we can get aluminium sheet in AU" is likely sizing it on the harder
alloy to cut.

### International sheet-size differences

| Region | Size | Status |
|---|---|---|
| **AU/NZ** | **2400 × 1200** (local mill), **2700 × 1200** (second standard length) | **SOURCED** (above) |
| **AU (imports)** | **2440 × 1220** — genuinely sold in AU on marine/hardwood lines, *alongside* 2400 × 1200 at the same retailers | **SOURCED** |
| **US** | 4 × 8 ft = **1219.2 × 2438.4 mm** exact; mills round to **1220 × 2440**; trimmed panels commonly **~1219 × 2438** | **SOURCED-leaning** — <https://smartcutlist.com/glossary/4x8-sheet> |
| **EU** | **2440 × 1220** and **3050 × 1220** in common circulation; **2500 × 1250** cited as a European mill standard | 🟠 **GENERIC** — repeated across secondary sources, not confirmed at a EU standards body |
| **EU extended** | **1220 × 3050** (4 × 10 ft), **1220 × 2745** (4 × 9 ft) | **GENERIC** |

**The 40 mm that matters:** AU's 2400 × 1200 and the import 2440 × 1220 are **different
sheets sold side by side in the same shop**. A nest laid out for one overhangs or wastes on
the other. This is the strongest argument for the UI continuing to make the user pick, and
it is not an argument for any particular default.

---

## What could not be sourced — the explicit list

Named so that nothing here wears a number it did not earn. **Items 1–9 are pass 1's list, updated;
10–17 are new in pass 2.**

1. ~~**Any citation for our own six materials' eighteen values**~~ — ✅ **CLOSED.** All six
   `chipload_factor` values now sit inside a published same-series band (§1.2), and `tools.rs`
   carries the citations. The `max_doc_ratio` and `max_rpm` rows have citations but see items 11–12.
2. **AS/NZS 2269 plywood thickness tolerance (± mm per nominal)** — standard is paywalled.
3. **EN 315 tolerance band** (the widely-repeated +0.74 / −0.94 mm) — never opened at a primary text.
4. **MDF thickness tolerance (±0.2 mm)** and MR-vs-Standard density figures.
5. **The "1200 × 900" and "600 × 900" handy-panel sizes as literal SKUs.**
6. **EU 2500 × 1250** as a standard, and the 4 × 9 / 4 × 10 ft extended panels.
7. **Acrylic and aluminium stocked-thickness ladders.**
8. **The Amana chip-load PDF** — **HTTP 403 on 2026-08-08 and again on 2026-08-10.** Two attempts,
   two failures. The row stays second-hand and is now load-bearing for nothing.
9. **Any machine-class qualifier on the published 1 × D depth rule** — re-checked on all five
   Onsrud sheets, the Techno chart and ToolGrit on 2026-08-10. **None of them states a spindle
   power, a machine mass or a rigidity assumption.** Techno states a *tool*-class qualifier
   (cutting-edge length), which is the closest anything comes. **That silence is the whole of §2.**
10. 🔴 **NEW — a published chipload for ANY cutter we actually own.** The purchased set is unbranded
    AliExpress carbide (§3.2). Every figure in §1 is an industrial series substituted onto a cutter
    of the same nominal geometry.
11. 🔴 **NEW — a drill speed or feed for a brad-point bit in a router spindle.** Onsrud's drill
    sheet rates wood drills in IPR against SFM and prints one rpm (4,500, for gang drills).
    **No number is published in this document, deliberately** (§3.3).
12. **NEW — the specific values 16,000 (acrylic) and 12,000 (aluminium) in `max_rpm()`.** Both are
    below every published figure, so the direction is safe; the exact numbers remain ours.
13. 🔴 **NEW — every non-material cutting constant**: plunge 300 mm/min, peck 4.0 mm, ramp length
    20 mm, tab 3 × 8 mm at 150 mm spacing, pocket stepover 0.45 × D, tool rpm window 8,000–24,000
    for all 51 tools, `max_feed_mm_min` 6,000, `rapid_mm_min` 3,000 (§3.4, §3.5).
14. **NEW — the provenance claim on the probe feeds** (`200` / `25` mm/min, attributed to grblHAL).
    The rates may well be right; the attribution is unsupported (§3.4).
15. 🔴 **NEW — `$110`/`$111`/`$112` and `$120`–`$122` for our controller.** Not in the repo, and
    **not obtainable before the machine is commissioned** (§4.2).
16. **NEW — the cutter diameter the Carbide 3D / OpenBuilds chart assumes.** The chart states none;
    the host says 1/4". Recorded as a secondary attribution, which is why §1.4(b) is a conflict to
    hold open rather than a data point to average in.
17. **NEW — the flute count of the #201 the chart was built around.** The chip-area convergence in
    §1.4 is computed both ways and the conclusion holds either way, which is the only reason it is
    quotable.
18. **Everything on the physical side.** Nothing in this document has been checked against a cut.
    No output of this tool has been run on a controller. The air-cut → foam/MDF coupon → real-ply
    rungs remain unclimbed, **and a published chart is not a coupon — including every chart above.**

---

## Corrections ledger — pass 2

**Nothing was deleted. Every figure that moved is printed with what it was, what it is, and what
changed the answer.**

| # | What it said | What it says now | What changed the answer |
|---|---|---|---|
| 1 | "Ours" = the pre-#38 values (MDF 1.10, softwood 1.20, acrylic 1.15, ply/MDF/soft DOC 1.00, hardwood DOC 0.75) | The values in the code today (1.00 / 1.10 / 0.75, DOC 0.50 across the woods) | Decision #38 §A landed between the passes. **A stale audit reads exactly like a current one.** |
| 2 | Techno gives softwood/plywood = 1.00 | **Techno cannot answer** — one merged "Softwood & Plywood" column | Re-read at the artefact. An undistinguished column is not a measured equality. |
| 3 | Aluminium published band 0.52–0.63 | **0.52–0.71** | New same-series Onsrud ratio (52-200B/BL, plywood vs aluminum sheets, both at 1/4"). Our 0.35 is further below the band than pass 1 thought. |
| 4 | Acrylic band 0.63–1.00, with the 37-series parity listed first | **0.65–1.00**, with the 37-series listed **last** and its weakness stated | The 37-series' plywood value is itself low; the parity is between a slow series and itself. |
| 5 | Hardwood `max_doc_ratio` 0.75 ✅ "the best-matched of the six" | 0.50, and pass 1's ✅ is retracted | #38 §A1 — 0.75 was **above** the only machine-vendor hardwood starter setting found. Pass 1 compared against tooling charts only. |
| 6 | Our chiploads are "2.5–3× below published" | True against Onsrud and Techno; **at the TOP of ToolGrit's prosumer band** | First reading of ToolGrit's actual plywood row (.003–.004" IPT). |
| 7 | ToolGrit is a clean slotting authority | It states the slotting rule **and** *"DOC: up to full thickness for through-cuts"* for plywood on the same page | Re-read at the artefact. Our strongest citation contradicts itself and nobody had looked. |
| 8 | *(in `decision-38` Part 8)* Onsrud O-flute at 1/4" = .008–.010" | **.010–.012"** at 1/4" (.008–.010" is the 3/16" column) | Column-offset alignment instead of eyeballing. Direction: strengthens that document's conclusion. |
| 9 | "the worst one is sourced to a machine we do not have" (one bad row) | **The function has no machine term at all**, and two presets emit a byte-identical program | Measured, 2026-08-10. |
| 10 | *(brief's premise)* `max_feed_mm_min` is inert on every emitting path | Enforced at `recommend.rs:600`; **not** on the `job.rs` door; **and not even for every op on the clamped door** | Measured on both doors, plus the marking-op leak, which is new. |

---

*Pass 2 written 2026-08-10. Every external source in Parts 0–4 was opened on that date; Part 5's
sources were opened on 2026-08-08 and are labelled as such. Code facts were read from the working
tree on 2026-08-10 and every behavioural claim in Part 4 was measured at the emitted program, not
inferred from the settings that were supposed to produce it.*
