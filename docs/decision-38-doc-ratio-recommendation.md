# Decision #38 — `max_doc_ratio`: a recommendation, with numbers

**Read date for every external source in this file: 2026-08-09.** Internal repo facts are
cited to file and line and were read the same day.

**This document edited no code.** No value in `core/src/tools.rs` was touched here — but under
the founder's standing rule (*"always go with the recommendation from a research"*) **§A below
is written to be implemented as literally typed.** So it is split on purpose:

- **§A — APPLY NOW.** Every change is a **reduction**. Nothing in §A permits a cut that is not
  already permitted today, so a wrong number there costs time, not material.
- **§B — 🔴 DO NOT APPLY WITHOUT A COUPON CUT.** Everything that makes a cut *more* aggressive,
  or rests on a constant I constructed rather than sourced. **These need `ops` and a machine
  and must not be swept into the §A implementation.**

Changing a feed or a depth of cut is a physical decision. The split is what keeps the
implementable half implementable and the unproven half unimplemented.

**Builds on** [`materials-research.md`](materials-research.md) (2026-08-08), which established
what the *tooling manufacturers* publish. That document named its own gap in item 9 of its
"could not be sourced" list:

> *"Any machine-class qualifier on the published 1 × D depth rule — no manufacturer chart
> found states what spindle power or gantry rigidity its figures assume."*

This document researches the missing half — what **prosumer routers** publish — and adds the
one thing neither document had: **what our machine actually is.**

---

## §A — APPLY NOW (safe to implement without cutting anything)

**Everything in this section moves a number in the SAFE DIRECTION — every change is a
REDUCTION.** No value here permits a cut that is not already permitted today. A wrong number
in this section costs **shop time and nothing else**, and is reversible in one line. The
reasoning is Parts 1–8; the confidence column says how hard each number would be to defend.

### A1 · `Material::max_doc_ratio()` — `core/src/tools.rs:572`

Replace the returned values with exactly these:

```rust
Self::Plywood  => 0.50,   // was 1.00
Self::Mdf      => 0.50,   // was 1.00
Self::Softwood => 0.50,   // was 1.00
Self::Hardwood => 0.50,   // was 0.75
Self::Acrylic  => 0.50,   // UNCHANGED
Self::Aluminium=> 0.15,   // UNCHANGED
```

| Value | Confidence | Basis |
|---|---|---|
| Plywood 0.50 | **HIGH** | Four independent readings in our machine class cluster at 0.24–0.51, one of them a review of **our own C-Beam/ACME architecture** (0.51). Plus the only published slotting-specific rule (0.50). |
| Softwood 0.50 | **HIGH** | Same cluster; the slotting rule is explicitly *"regardless of material"*. |
| MDF 0.50 | **MEDIUM-HIGH** | Same cluster, but MDF is the **lowest-force** sheet material and one secondary source allows up to 2×D for it. **This is the value most likely to be raised at A1's review point** — and it is a reduction either way. |
| Hardwood 0.50 | **HIGH** | It is the **only** machine-vendor starter setting found for hardwood (UT Austin / ShopBot, on a far heavier machine). Our current 0.75 is *above* it. |
| Acrylic 0.50 unchanged | **HIGH** | Already at or below every source; the sources that differ (ShopBot 1.04×D) point the *permissive* way. |
| Aluminium 0.15 unchanged | **HIGH** | Inside the published router band, upper half; nothing found moves it. |

⚠ **Two implementation notes, both easy to get wrong:**
- The current arm is `Self::Plywood | Self::Mdf | Self::Softwood => 1.0` — **split it into one
  arm per material.** They agree on 0.50 by *coincidence of evidence*, not by design, and the
  MDF row above is the one most likely to move first. A collapsed arm makes that a refactor
  instead of a one-line edit.
- **Do not "simplify" the whole function to a constant.** Aluminium is genuinely different in
  mechanism (chip rewelding, not deflection), so the per-material shape is load-bearing.
- The two existing assertions in `mod material_tests` still hold: `0.0 < ratio <= 1.0`
  (0.50 ✓) and `Aluminium < Plywood` (0.15 < 0.50 ✓). **Neither would have caught this defect,
  and neither will catch the next one** — they assert an ordering, not a value.

### A2 · `Material::chipload_factor()` — `core/src/tools.rs:560`

```rust
Self::Acrylic  => 0.75,   // was 1.15
Self::Mdf      => 1.00,   // was 1.10
Self::Softwood => 1.10,   // was 1.20
Self::Plywood  => 1.00,   // UNCHANGED (the reference)
Self::Hardwood => 0.80,   // UNCHANGED (inside its band)
Self::Aluminium=> 0.35,   // UNCHANGED (conservative)
```

| Value | Confidence | Basis |
|---|---|---|
| Acrylic 0.75 | **HIGH** | Published band 0.63–1.00 across four sources, incl. a **same-series** Onsrud ratio of 0.71 measured today. Onsrud's own sentence explains why 1.15 was wrong. 0.75 is the band's middle. |
| MDF 1.00 | **HIGH** | Published band 0.78–1.00 across six readings; **no chart puts MDF above plywood.** 1.00 is the top of the band, so this is the smallest defensible change. |
| Softwood 1.10 | **MEDIUM-HIGH** | Onsrud's own softwood/plywood ratios run 1.06–1.17; 1.10 sits inside. Techno puts them equal (1.00), so the true value may be lower — again, a reduction either way. |

🔴 **The doc-comment above this function must change in the SAME edit.**
`core/src/tools.rs:556–559` currently reads *"Acrylic is ABOVE 1.0 on purpose … the fix for a
melted edge is usually MORE feed, not less."* With acrylic at 0.75 that comment **describes a
value that no longer exists**, and it is the single most persuasive sentence in the file — it
is what made `1.15` survive unexamined. Replace it with what Onsrud actually says: the remedy
for chip rewelding in plastic is **"increase feedrate or go to a single edge tool"** — both of
which raise the *chip*, neither of which raises the *per-tooth chipload of a 2-flute cutter*,
which is what this multiplier controls. **Leaving the old comment beside a new number is worse
than leaving the old number**, because the next reader will trust the prose and re-raise the
constant to match it.

### A3 · Compression-tool warning (Part 3b / R3) — behaviour, not a constant

Emit a note on any job that runs a **`Flute::Compression`** tool in **more than one pass**:
the tool will not reach its down-shear section at this pass depth and the top veneer will
tear. **Confidence: HIGH that the warning is needed; the exact up-cut length is unknown**
(secondary sources disagree 2.6×), which is why this is a *warning keyed on pass count*, not a
numeric exemption. Adds a note; changes no coordinate; cannot make a cut more aggressive.

⚠ **A1 without A3 ships a silent defect:** capping the compression bit at 0.5×D turns it into
an up-cut and tears the ply face while every gate stays green. **If only one of the two can
land in a commit, land A3 in the same one.**

---

## §B — 🔴 DO NOT APPLY WITHOUT A COUPON CUT

**Nothing in this section may be swept into the A-section implementation.** Each item either
makes a cut **more aggressive**, or rests on a number **I constructed rather than sourced**.
These need `ops`, a machine, and the foam/MDF → real-ply rungs — which this lane cannot
self-certify.

### B1 · 🔴 Raising `max_doc_ratio` back to 0.75 — REQUIRES A COUPON
The pre-agreed raise path, recorded so it is not re-argued: after the foam/MDF coupon **and**
the real-ply rung, **if walls are square within FR3's 0.1 mm at 0.50×D**, raise the four woods
to 0.75 and re-cut the same coupon. **Do not apply on the strength of this document.**

### B2 · 🔴 Raising the base chiploads in `default_library()` — REQUIRES A COUPON, AND IS ORDER-DEPENDENT
Our ⌀6 nominal 0.10 mm is 2.5–3× under Onsrud's published 0.15–0.20 mm. Raising it is
defensible **only paired with A1's halved depth** (constant chip area, thicker chip, less
rubbing) and **only after a coupon**. 🔴 **Applied alone at today's 1.0×D it multiplies
straight into the 380,000 mm³/min case in Part 6.** **Depth first, chipload never alone.**

### B3 · 🟠 The chip-area cap (1.0 mm²) — a SOUND SHAPE with an UNSOURCED CONSTANT
Part 4 shows chip area grows as **D²**, so a ratio cannot see it: the ⌀12 at 1.0×D in softwood
asks for **3.35×** Onsrud's industrial 1/4" chip. Under A1 the ⌀12 is already pulled to
1.80 mm², so **A1 substantially defuses this on its own.** The cap is the right *shape* of
rule, but **1.0 mm² is my construction — no source publishes a chip-area cap.**
**Confidence: HIGH on the finding, LOW on the constant.** Approve the shape if you like it;
set the number from the coupon, not from here.

### B4 · `max_rpm = 24,000` for wood — FLAGGED, NO CHANGE PROPOSED
Not unsafe per tooth, but it is why Part 6's feed comparison lands where it does, and
`recommend` selects it deliberately. Recorded so nobody quietly changes it as a throughput fix.

---

### Which way I have erred, and why it is the right way

**I have erred conservative, deliberately, on every number in §A.** Each is a reduction; the
aggressive half of the analysis is quarantined in §B behind a physical test.

The reason is not caution as a temperament, it is **asymmetry of the recovery path**:

- **Too conservative** ⇒ pass count doubles on an 18 mm through-cut (3 → 6), cut time roughly
  doubles. **No extra heat** (chip thickness is unchanged — burning comes from a *thin* chip,
  the opposite change). Recovery: **one line, after one coupon** (B1).
- **Too aggressive** ⇒ first a *silent* accuracy defect — deflection taper of tens of microns
  against FR3's 100 µm budget, which comes off the machine looking fine and gets blamed on the
  CAD; then a burnt glue line; then the part breaking free with the cutter buried 6 mm, which
  costs **a sheet of 18 mm structural ply** — the expensive consumable here is the material,
  not the cutter. Recovery: **there is none from a crashed sheet.**

**With zero cuts made to date, the first real cut this lane emits is the worst possible place
to discover the number was too high.** The evidence path runs upward from 0.50 and does not
run back down from a crash.

⚠ **And do not over-sell the danger either.** Part 5 shows the spindle will not stall and the
cutter will not snap in steady state on this machine — `cad` measured ~50 N peak and the drives
are closed-loop. **Arguing for A1 on "the spindle will stall" would be a false red**, and a
false red lies exactly like a false green. The defensible argument is joint accuracy against
FR3, chip evacuation, and not being 6 mm deep when a part lets go.

---

## Part 0 — The fact that reframes the whole question: we know the machine

`materials-research.md` said "a 2.2 kW spindle on a grblHAL SKR Pro gantry". That is true and
it is not the important part. The machine is specified in `cad`'s own build spec,
`hardware/cad/2bee_cnc_table/cnc_e2e_requirements.md`:

| Property | Value | Line |
|---|---|---|
| Frame | **Bellwether Lead 1000×1500** — **C-Beam gantry, ACME lead screws**, ~90 mm Z | §3.1:46–47 |
| Motion | 4× **HBS57 closed-loop** drivers + NEMA23 **3.6 N·m** servo-steppers, dual-Y slaved | §3.2:53 |
| Spindle | **2.2 kW water-cooled, 24,000 rpm, ER20**, with 2.2 kW VFD | §3.3:75 |
| Control | grblHAL on SKR Pro → step/dir → HBS57; PWM/0-10 V → VFD | §3.5, §4.2 |
| Work area | ~670 × 1250 mm | FR-section:34 |
| Accuracy requirement | **FR3 — ≤ 0.1 mm over the joint features (finger/dogbone fit)** | :35 |

Three consequences, and each one moves the decision:

1. **It is an OpenBuilds LEAD-class machine** — extruded-aluminium C-Beam gantry on ACME lead
   screws. That is *lighter* than every machine behind the 1 × D rule (ShopBot, Techno, any
   Onsrud customer), and it is in the same architectural family as the machines whose
   published numbers are in Part 1. We are not guessing at our class any more.
2. **The motors are CLOSED-LOOP.** The usual hobby-router failure — silent step loss on an
   open-loop stepper — **is not our failure mode.** An HBS57 with a 1000-line encoder
   *alarms*. That is a ruined part and a safe stop, not a mystery.
3. **`cad` has already computed the cutting force** and it agrees with Part 5 below:
   *"Routing 18 mm ply with a ⌀6 bit is ~50 N peak"* (§3.2, 2026-07-22) — used there to show
   both motor options have 15–25× margin. **The drive train is not the constraint. Neither is
   the spindle.** Part 5 shows what is.

⚠ **This also corrects a framing in TODO #38.** It says *"the one prosumer-router source
halves the ratio specifically for slotting."* Having gone looking: the prosumer field is
**split, not unanimous**, and the source that halves it (ToolGrit) **does not state its
machine class either** — verified by re-reading it today; it contains no spindle-power or
rigidity qualifier. It is not "the prosumer figure"; it is the only source that addresses
**slotting as a distinct case**. That is a different and better reason to weight it.

---

## Part 1 — The prosumer-router DOC evidence

All figures normalised to **depth of cut as a multiple of cutter diameter (×D)** at 1/4"
(6.35 mm) unless the source used another size, in which case the source's own diameter is
given. Machine class is stated where the source states it, and marked **UNSTATED** where it
does not — because that silence is the entire defect being audited.

| Source | Machine class (as stated by the source) | Softwood | Plywood | MDF | Hardwood | Acrylic | Slotting rule? |
|---|---|---|---|---|---|---|---|
| **Carbide 3D — Carbide Create shipped default, #201 1/4" 2F** | Shapeoko, trim router (~1 hp) | **0.24×D** (0.060", 75 ipm @ 18k) | — | — | — | — | no |
| **Shapeoko community consensus, 1/4" 2F** | Shapeoko 3/XXL, incl. one on a 1.5 kW Chinese spindle | — | **0.50×D** (0.125" @ 100 ipm / 22–24k) | — | 0.5×D ("DOC = 1/2 of bit diameter") | — | no |
| **MellowPine, OpenBuilds LEAD 1515 review** | **C-Beam gantry, 8 mm ACME lead screws, 1 hp RoutER11 — our architecture** | — | **0.51×D** (⌀3 mm bit, 0.060" DOC, 118 ipm) | — | — | — | no |
| **Onefinity community, 1/4" 2F** | Onefinity (heavier than ours) | — | conservative **0.50×D** @ 100 ipm; aggressive **1.00×D** @ **80 ipm** | — | 0.5–0.63×D ("3–4 mm in hardwood") | — | no |
| **ToolGrit** | **UNSTATED** | 1.00×D | — | — | 0.50×D | — | ✅ **"for slotting (full-width cuts), reduce DOC to 0.5×D regardless of material"** |
| **workshopcalc** | **"hobby to mid-grade CNC router (Shapeoko, X-Carve, Avid, Onefinity) with standard spindle"** + *"reduce all values by 25 % for less rigid machines"* | 1.00×D | 1.00×D ("to full depth for compression bits") | 1.0–2.0×D | 0.50–0.75×D | 0.25–1.0×D | no |
| **UT Austin Digital Fabrication Lab — ShopBot starter settings** | ShopBot (institutional gantry) | — | **1.04×D** (0.26" pass, 1/4" **compression**, 18k, 150–192 ipm) | 1.04×D | **0.50×D** (0.125", 1/4" upcut, 72 ipm) | 1.04×D | no |
| **ShopBot Tools official *Feeds and Speeds Charts*** (values "taken from Onsrud's recommendations") | ShopBot | **1×D** | *n/a — Onsrud lists no value for the 1/4" up/down-cut in soft plywood* | **1×D** | **1×D** | — | no |
| **Onsrud / Techno / Amana** *(from `materials-research.md`, re-confirmed today on the Hard Plastic sheet)* | **UNSTATED — industrial** | 1×D baseline, 2×D at −25 % chipload, 3×D at −50 % | same | same | same | 1×D | no |

### What the table actually says

- **Every machine whose class is stated as light lands at 0.24–0.51×D.** The three sources
  closest to our machine — Carbide 3D's own shipped default, the Shapeoko community running a
  1.5 kW spindle, and a review of the **LEAD C-Beam/ACME architecture we bought** — give
  **0.24, 0.50 and 0.51×D**. That is a tight cluster and it is the strongest evidence here.
- **Every 1×D figure is either industrial, or a hobby chart that then tells you to derate.**
  workshopcalc says 1×D *and* "reduce all values by 25 % for less rigid machines" — applied to
  us that is **0.75×D**, not 1.0.
- **Onsrud does not publish a plywood value for the 1/4" up-cut or down-cut at all.** The
  ShopBot chart's Soft Plywood page reads `n/a` for SB#13528 (Onsrud 52-910) and SB#13507
  (57-910). Our `Plywood = 1.0` is therefore not even inherited from a chart entry for the
  tool class we use — it is inherited from the *header rule* on a sheet that has no row for it.
- **Only one source in the whole corpus distinguishes slotting**, and it halves the number.

### The one strongest source

**MellowPine's OpenBuilds LEAD 1515 review** — *"speed of 118 ipm with a depth of cut of
0.06″"* in plywood with a 3 mm bit, on a machine described as *"lead screw-driven with 8 mm
acme lead screws"*, *"dual XL gantries"*, C-Beam construction, 1 hp RoutER11.
**0.060" / 0.118" = 0.51×D.** It is the only published figure found on our machine's actual
architecture. It is a review, not a vendor spec — so it is not authority, it is *evidence from
the right machine*, which is the thing every other source lacks.

### Sources, all read 2026-08-09

- ShopBot Tools, *Feeds and Speeds Charts* (July 2016) — <https://shopbottools.com/wp-content/uploads/2024/01/FeedsandSpeeds.pdf> (per-material charts pp. 9–12; the "Cut" column is the depth-of-cut multiple)
- UT Austin Digital Fabrication Lab, *Starter ShopBot CNC Settings for 2D Cuts* — <https://sites.utexas.edu/digifablab/files/2022/06/Starter-CNC-Settings-for-2D-Cuts.pdf>
- ToolGrit, *CNC Router Speeds & Feeds Guide* — <https://www.toolgrit.com/guides/cnc-wood-speeds-feeds-guide>
- workshopcalc, *CNC Feeds and Speeds Chart* — <https://workshopcalc.com/reference/cnc-feeds-speeds-chart>
- Carbide 3D community, *Speeds/Feeds/Depths* (the #201 shipped default) — <https://community.carbide3d.com/t/speeds-feeds-depths/64479>
- Carbide 3D community, *Best Depth of Cut for Plywood* — <https://community.carbide3d.com/t/best-depth-of-cut-for-plywood/16301>
- Onefinity forum, *Rough pass feed and speed and depth for a 1/4 EM* — <https://forum.onefinitycnc.com/t/rough-pass-feed-and-speed-and-depth-for-a-1-4-em/6887>
- MellowPine, *OpenBuilds LEAD 1515 CNC Review* — <https://mellowpine.com/openbuilds-lead-1515-cnc-review/>
- LMT Onsrud, *Hard Plastic Cutting Data Recommendations* — <https://onsrud.com/images/Hard%20Plastic.pdf>
- Vectric, *Tool Database* (V12) — <https://docs.vectric.com/docs/V12.0/VCarvePro/ENU/Help/form/Tool%20Database/>
- Woodsmith / CNC Basecamp Ep. 1, *How to Get Smooth CNC Cuts in Plywood* (compression first-pass depth) — <https://www.woodsmith.com/article/episode-001-smooth-cuts-in-plywood/>
- Roctech, *CNC Router Tooling Basics for Woodworkers: Compression Bits* — <https://roctechcncrouter.wordpress.com/2017/06/06/cnc-router-tooling-basics-for-woodworkers-compression-bits/>

⚠ **Negative results, recorded so nobody repeats them.** **Vectric ships no default pass
depth to compare against** — the V12 Tool Database documentation defines Pass Depth as *"the
maximum depth of cut the tool can cut"* and says only that *"this value can be defined per
machine / material depending on the machine's rigidity and the material's hardness"*. No
number, no rule of thumb. **Estlcam publishes no documented default either** — searching
returns community examples, not a manual figure. **Avid CNC publishes no per-material DOC
chart** that could be found. Three of the seven sources the brief asked for **do not exist as
citable figures**, and that is itself worth knowing: the CAM vendors decline to answer this
question, which is why every CAM tool inherits it from a tooling chart written for someone
else's machine — exactly what we did.

---

## Part 2 — Slotting vs profiling: published, and missing from our code

**Is there a published distinction?** Yes, but thinly, and only one source in the router world
states it as a rule: ToolGrit's *"for slotting (full-width cuts), reduce DOC to 0.5x diameter
regardless of material."* The metalworking literature is much clearer that full-width
engagement is its own case — full-slot engagement is conventionally given a **35–40 % feed
reduction** against side-cutting, and axial depth is reduced when radial engagement is 100 %
(Harvey Performance / *In The Loupe*, *Diving Into the Depth of Cut* —
<https://www.harveyperformance.com/in-the-loupe/depth-of-cut/>). The mechanism is
material-independent: a full slot has **180° of tool wrap, no exit for chips sideways, and no
unloaded portion of each revolution.**

**Our through-profile is always a slot.** There is no reduced-engagement case in a
through-cut.

🔴 **And our code has no such distinction at all.** `Material::max_doc_ratio()` is applied
identically to every operation:

- `core/src/job.rs:869` — `let max_doc = op.tool.diameter_mm * m.max_doc_ratio();` applied to
  **every op in the job**, clamping whatever the caller asked for.
- `core/src/recommend.rs:532` — `let doc = (spec.tool.diameter_mm * material.max_doc_ratio()).min(depth_mm…)`.

⚠ **Note the second one carefully: `recommend` does not clamp to the ceiling, it *chooses*
the ceiling.** The same constant is a *limit* on one path and a *default* on the other. A
number that is only ever a guard is far less consequential than a number the tool actively
tells the operator to use, and this one is both. **That is the single most important thing
about `max_doc_ratio` that neither the code nor `materials-research.md` says.**

The consequence of having one constant for both cases: it is **simultaneously too permissive
for the slot** (100 % radial engagement) **and too restrictive for a pocket clearing pass**
(40 % stepover, where 1×D is genuinely fine). Any recommendation that sets a single number is
choosing the slot, because the slot is what can hurt you.

---

## Part 3 — Flute count and flute type: one real conflict, and it is ours

**Does flute type change the answer for sheet goods?** Yes, in two documented ways, and the
second one directly conflicts with any DOC ceiling.

**(a) Down-cut is derated in the published chart — by the manufacturer, not by folklore.**
On ShopBot's Onsrud-derived chart at 1/4":

| Material | 1/4" **up-cut** (52-910) | 1/4" **down-cut** (57-910) |
|---|---|---|
| Soft wood | .007–.009" | .007–.009" (same) |
| **Hard wood** | .006–.008" | **.005–.007"** (≈ −15 %) |
| MDF | .006–.008" | .006–.008" (same) |
| Soft plywood | *n/a* | *n/a* |

So the published derate is on **chipload in hardwood**, not on depth, and it is small. The
physical argument for capping a *down-cut* in a deep slot is chip evacuation — a down-cut
drives chips **into** a closed-bottom slot with nowhere to go, which is heat, a burnt glue
line, and a packed flute. This is real and it is the mechanism behind burning, but **no
source found states a numeric down-cut DOC derate.** Recorded as reasoning, not as a figure.

🔴 **Directly relevant: the FIRST 6 mm entry in `default_library()` is a down-cut**
(`core/src/tools.rs:261`), so the library's most-likely-picked 6 mm tool is the one with the
worst chip evacuation in exactly the operation this tool emits most.

**(b) The compression bit breaks any DOC ceiling, and this is a genuine conflict.**
A compression spiral only compresses when the **up-cut section passes completely through the
material** — the first pass must be *deeper* than the up-cut portion. Published figures for
the up-cut section on a 1/4" compression bit: *"the bottom .250″ or so"* (Roctech) and *"your
first pass needs to be slightly deeper than the upcut section of the bit, say .260″"*
(Woodsmith). **That is ≈ 1.0×D as a minimum first pass, on the very tool a 0.5×D ceiling
would cap at 0.5×D.**

🔴 **We ship `End Mill - Compression 6mm 2F` (`core/src/tools.rs:263`).** Under **any**
ceiling below ~1.0×D, that tool is silently reduced to behaving as a plain up-cut — and an
up-cut in ply **tears the top veneer**, which is the exact defect the operator bought the
compression bit to avoid. The program will run, the gate will be green, and the part will come
off the machine with a chipped top face.

⇒ **This must be handled explicitly, not by exemption.** Recommendation R3 below.

---

## Part 4 — Does the answer depend on cutter diameter? Yes — and it bites at the TOP

The brief asks whether a ratio hides the diameter. It does, but **not in the direction the
question implies.** The quantity that sets cutting force is the **chip area per tooth**:

```
chip area  =  chipload  ×  depth of cut  =  (chipload) × (ratio × D)
```

and in our library **chipload itself scales with D**, so chip area scales as **D²** (steeper,
in fact — our chipload goes 0.10 mm at ⌀6 to 0.30 mm at ⌀12, a 3× rise for a 2× diameter).
At `max_doc_ratio = 1.0`, plywood:

| Tool | chipload (nominal) | DOC at 1.0×D | **chip area** | vs Onsrud's 1/4" figure (1.29 mm²) |
|---|---|---|---|---|
| ⌀3.175 2F | 0.05 mm | 3.18 mm | **0.16 mm²** | 0.12× |
| ⌀6 2F | 0.10 mm | 6.0 mm | **0.60 mm²** | 0.47× |
| ⌀8 2F | 0.21 mm | 8.0 mm | **1.68 mm²** | 1.30× |
| ⌀12 2F | 0.30 mm | 12.0 mm | **3.60 mm²** | **2.79×** |
| ⌀12 2F in **softwood** (×1.20) | 0.36 mm | 12.0 mm | **4.32 mm²** | **3.35×** |

**The 12 mm tool at 1.0×D in softwood asks our C-Beam gantry for 3.35× the chip that Onsrud
specifies for an industrial router at 1/4".** That is the worst number our current constants
permit, and it is invisible in a ratio.

Against that, the small tools are *fine*: tool stiffness scales as D⁴ while our stickout
(`cutting_length_mm`) scales roughly 3.8–4×D, so the ⌀3.175 and ⌀6 come out at comparable tip
deflection per cut (Part 5). **The ratio form is defensible for the small end of the library
and indefensible at the large end** — and the large end is where a ratio-only rule gives no
warning at all.

⚠ **Practical narrowing:** a through-cut in 18 mm ply needs more than 18 mm of flute. Our
⌀3.175 (12 mm) and ⌀4 (17 mm) **cannot do it**. The slotting case is ⌀6, ⌀8, ⌀12 — i.e. the
half of the library where the D² problem lives.

---

## Part 5 — What actually fails first on a 2.2 kW C-Beam gantry

🔴 **Not the spindle.** The arithmetic is not close.

At today's recommended plywood cut (⌀6, 1.0×D, 24,000 rpm — see Part 6): MRR = 6 × 6 × 4,800 =
**172,800 mm³/min = 2.88 cm³/s**. Spindle power is linear in MRR (`P = K × MRR`). Wood's
specific cutting energy **K could not be sourced to a primary text** — marked **GENERIC** —
but across the entire plausible range **20–100 J/cm³** the answer is:

| K (J/cm³) | Power at today's cut | % of a 2.2 kW spindle |
|---|---|---|
| 20 | 58 W | 2.6 % |
| 60 | 173 W | 7.9 % |
| 100 | 288 W | 13 % |

**The conclusion is invariant across a 5× swing in the one number we could not source.** And
there is an independent empirical check that needs no K at all: MellowPine's LEAD 1515 test
cut plywood on a **1 hp (746 W)** router at 13.7 cm³/min. If that machine were power-limited,
K would have to be ~3,270 J/cm³ — absurd for wood by two orders of magnitude. **Light routers
are not stopped by power.** Ours has 2.9× that machine's spindle and the same gantry family.

🔴 **Not step loss, and not the motors.** `cad` computed this already
(`cnc_e2e_requirements.md` §3.2, 2026-07-22): *"Routing 18 mm ply with a ⌀6 bit is ~50 N peak,
which through the ACME lead screw (8 mm lead, η≈0.4) demands only ~0.16 N·m at the motor —
under 7 % of the SMALLER 2.45 N·m option."* And the drives are **closed-loop**, so a stall is
an **alarm**, not a silent position error. My independent estimate agrees with cad's: tangential
force `Fc = P / v_c` with `v_c = π × 6 mm × 24,000 rpm = 7.54 m/s` gives **8–38 N** steady, and
peaks of ~50 N on a glue line or a knot are consistent.

🔴 **Not the cutter, in steady state.** A ⌀6 two-flute carbide with a ~60 % core has a section
modulus of ≈4.6 mm³; even at a pessimistic 1,000 MPa effective bending strength that is a
breaking force of ~180 N at 25 mm stickout. Against 8–38 N steady that is a **5–20× margin**.
*(Both the core ratio and the strength are **GENERIC** — unsourced. The margin is large enough
that the conclusion survives being wrong by 3×.)* **Cutters break on transients** — a part
breaking free, a plunge into a packed slot, a climb-cut grab in a ply void — not on the
steady-state load.

✅ **What DOES bind, in order:**

1. **Deflection → out-of-tolerance joints.** Tool-tip deflection alone, `δ = F·L³/(3EI)`, for
   the ⌀6 at 25 mm stickout is **≈1.05 µm/N** ⇒ **8–40 µm at today's numbers** — *before any
   gantry deflection*, on a machine whose own **FR3 requires ≤ 0.1 mm on finger/dogbone fit**.
   The deflection is a **taper** (the wall closes up with depth) and it **changes with pass
   depth**, so the same part cut at 1.0×D and 0.5×D has different wall geometry. This is the
   binding constraint, and it is a constraint on **whether the joints fit**, not on whether
   something breaks.
2. **Chip evacuation and burning** in a full-depth slot — worst with the down-cut, which is
   our library's first ⌀6 entry (Part 3a).
3. **Workholding.** A full-depth slot releases the part with 100 % of the cutter buried. This
   is the escalation path from "wrong" to "dangerous": everything above is a scrapped part;
   this one throws it.

⇒ **The honest answer to "what fails first" is: the part is wrong, then it burns, then it
comes loose — and only then does anything break.** Any argument for cutting the ratio that
rests on "the spindle will stall" or "the cutter will snap" is **not supported by our own
machine's numbers** and should not be used. The argument that *is* supported is joint accuracy
against FR3, plus chip evacuation, plus not being buried 6 mm deep when a part lets go.

---

## Part 6 — The net-feed analysis, and a correction to the existing one

🔴 **This is the crux, and `materials-research.md` gets it half wrong — in the reassuring
direction.**

It says our base chiploads are *"2.5–3× below"* published and that this *"partially offsets
the aggressive multipliers in absolute feed terms."* The chipload comparison is correct. **The
offset conclusion is not**, because chipload is not the feed:

```
feed = rpm × flutes × chipload × material factor
```

and **our `max_rpm` for wood is 24,000 — the top of the published band — while every feed
table quoted against us is stated at 18,000 rpm.** `recommend.rs:530` then picks
`rpm = cap`, i.e. **the ceiling, deliberately**. A 33 % rpm advantage eats most of the
chipload conservatism before the depth is even considered.

### What the tool actually emits today (⌀6 2F, nominal chipload 0.10 mm)

| Material | rpm chosen | factor | **feed** | DOC at current ratio | **MRR** |
|---|---|---|---|---|---|
| Plywood | 24,000 (`recommend`) | 1.00 | 4,800 mm/min (189 ipm) | 6.0 mm | **172,800 mm³/min** |
| Plywood | 18,000 (default job) | 1.00 | 3,600 mm/min (142 ipm) | 6.0 mm | 129,600 |
| MDF | 24,000 | 1.10 | 5,280 (208 ipm) | 6.0 mm | 190,080 |
| Softwood | 24,000 | 1.20 | 5,760 (227 ipm) | 6.0 mm | 207,360 |
| Hardwood | 24,000 | 0.80 | 3,840 (151 ipm) | 4.5 mm | 103,680 |
| Acrylic | 16,000 | 1.15 | 3,680 (145 ipm) | 3.0 mm | 66,240 |
| Aluminium | 12,000 | 0.35 | 840 (33 ipm) | 0.9 mm | 4,536 |

### Against the published record, in plywood, full slot

| Basis | DOC | feed | **MRR (mm³/min)** | vs us |
|---|---|---|---|---|
| Carbide 3D #201 shipped default (softwood) | 1.52 mm | 1,905 | 18,400 | **0.11×** |
| Shapeoko community consensus | 3.18 mm | 2,540 | 51,200 | **0.30×** |
| ToolGrit **slotting** rule @ 120 ipm | 3.18 mm | 3,048 | 61,500 | **0.36×** |
| workshopcalc hobby/mid-grade, **their own −25 % rigidity derate** | 4.76 mm | 3,048 | 92,100 | **0.53×** |
| **US — `recommend` path, plywood** | **6.0 mm** | **4,800** | **172,800** | **1.00×** |
| ShopBot / Onsrud, 1/4" 2F, 1×D, .007–.009" | 6.35 mm | 6,400–7,315 | 258,000–294,900 | 1.5–1.7× |

**Chip area per tooth**, the force-relevant quantity, tells the same story more compactly:

| Basis | chip area |
|---|---|
| Carbide 3D shipped default | 0.08 mm² |
| Shapeoko community consensus | 0.17 mm² |
| ToolGrit slotting | 0.28 mm² |
| **Us, ⌀6 plywood today** | **0.60 mm²** |
| Onsrud 1/4" industrial | 1.29 mm² |

### The answer to "is the DOC question independent of the feed question?"

🔴 **No. They multiply, and today they multiply the wrong way.**

- We have **three inputs that each look conservative in isolation** — a chipload 2.5–3× under
  published, a hardwood factor at the bottom of its band, an aluminium ratio well inside the
  router range —
- **and one output that is not:** at **2.8–3.6× every prosumer figure** and **~60 % of the
  full industrial figure**, on a C-Beam gantry.

The reason is that `max_rpm` is at the ceiling, `recommend` picks the ceiling, and
`max_doc_ratio` is *also* the ceiling — three ceilings in a row. **"Our chiploads are
conservative" is true and it is not a safety statement.**

⚠ **And there is a worse case the constants permit today.** `feed_for` uses the *nominal*
chipload, but the ⌀6 tool declares `chipload_max_mm = 0.20`
(`core/src/tools.rs:261`), and the user can edit the library. At the tool's own declared max,
in MDF, at the rpm ceiling and the depth ceiling: 24,000 × 2 × 0.20 × 1.10 = **10,560 mm/min
at 6 mm deep = 380,000 mm³/min**, i.e. **1.3× the full industrial number, on our machine.**
That combination is inside every current limit and nothing reports it.

🔴 **`core/src/feeds.rs:26` has exactly the check that would catch it —
`chipload_in_window()` — and it has NO CALLER.** It is exported from `lib.rs:44` and used
nowhere in `core/`, `cli/` or `gates/`. A dormant control reads as coverage. *(Related, and
noted for the lane rather than as part of this recommendation: there are **two feed formulas**
— `feeds::feed_from_chipload` (material-blind, used by `toolpath.rs:331` and
`rect_profile.rs:163`) and `tools::feed_for` (material-aware, used by `job.rs` and
`recommend.rs`). Which one sets a given op's feed depends on whether the material pass ran
first.)*

⚠ **One more provenance note.** `feeds.rs:36–38` says the five base chipload pairings *"were
measured against PUBLISHED manufacturer tables after a home-grown scaling rule was found
over-feeding 2.1× at 19 mm."* **That is a source claim with no source named** — the same
defect `materials-research.md` found in the acrylic comment, in the file that owns the
formula. It should either name the table or say it cannot.

---

## Part 7 — 🔴 THE RECOMMENDATION, with its reasoning

**The literal values to type are in §A at the top of this document; §B is what must not be
applied without a coupon.** This part is the *reasoning* behind them. Mapping:
**R1 → A1 · R4 → A2 · R3 → A3 · R1a → B1 · R5 → B2 · R2 → B3.**
Where this part and §A could ever disagree, **§A is the instruction** and this part is the
argument for it.

### R1 — the number to approve or reject *(implemented as A1)*

**Set `Material::max_doc_ratio()` to `0.50` for Plywood, MDF, Softwood and Hardwood.
Leave Acrylic at `0.50`. Leave Aluminium at `0.15`.**

```
Plywood    1.00  →  0.50
MDF        1.00  →  0.50
Softwood   1.00  →  0.50
Hardwood   0.75  →  0.50
Acrylic    0.50  →  0.50   (unchanged)
Aluminium  0.15  →  0.15   (unchanged)
```

**Why 0.50 and not 0.75, and not 1.00:**

1. **It is where every machine in our class lands.** 0.24 (Carbide 3D shipped), 0.50 (Shapeoko
   community on a 1.5 kW spindle), **0.51 (a review of our own C-Beam/ACME architecture)**,
   0.50 (Onefinity's *conservative* figure on a heavier machine). Four independent readings,
   one cluster.
2. **It is the only published rule written for the case we are actually in** — ToolGrit's
   *"for slotting, 0.5×D regardless of material"* — and every through-profile is a slot.
3. **It lands the emitted cut at the prosumer figure instead of above it.** Chip area goes
   0.60 → **0.30 mm²**, sitting just above ToolGrit's slotting figure (0.28) and just below
   half of Onsrud's industrial one. MRR goes 172,800 → **86,400 mm³/min**, which is
   workshopcalc's own hobby-class-derated number. **That is the whole point: the recommendation
   is not "be cautious", it is "stop emitting an industrial cut."**
4. **It halves the deflection**, from ~8–40 µm of tool-tip bend to ~4–20 µm, against an FR3
   budget of 100 µm that also has to absorb gantry deflection, backlash and lead-screw error.
5. **Hardwood comes down too, and that is not an oversight.** Our 0.75 is *above* the only
   machine-vendor starter setting found for hardwood (UT Austin / ShopBot: **0.50×D**, on a
   machine much heavier than ours). `materials-research.md` marked hardwood ✅ because it
   compared only against tooling charts and ToolGrit. It is the row where our number is worst
   relative to a real machine's published starting point.

**Why one number for all four woods, rather than a per-material split:** because the evidence
does not support a split *in the slotting case*. The only slotting rule found says
*"regardless of material"*, and the per-material differences the tooling charts do publish are
differences in **chipload**, which is where `chipload_factor()` already lives. Inventing a
0.6-for-MDF would be precisely the defect this audit exists to correct — a number with a
plausible story and no source. **DOC is a machine-and-engagement property; material belongs in
the chipload.** After this change `max_doc_ratio()` is a two-valued function (0.50 everywhere
except aluminium at 0.15), and that is an accurate description of what we can actually
defend — aluminium being the one material where the mechanism genuinely differs (chip
rewelding, not deflection).

### R1a — the pre-agreed raise, so this is a starting point and not a verdict *(= B1: COUPON-GATED)*

**0.50 is where to start, not where to end.** The raise path, agreed now so it does not have to
be argued later:

> **After the foam/MDF coupon and the real-ply rung are climbed (a JOINT run with `ops`), and
> if the coupon shows square walls within FR3's 0.1 mm at 0.50×D, raise the four wood
> materials to 0.75 and re-cut the same coupon.** If 0.75 also holds, that is the number.
> **The evidence path from 0.50 upward exists; there is no evidence path back down from a
> crashed sheet.**

That asymmetry — not caution for its own sake — is the reason to start low.

### R2 — the rule shape Part 4 says is missing *(= B3)*

*In full: the shape of the rule that Part 4 says is actually missing — **= B3: shape sound,
constant unsourced**.*

A ratio cannot see the D² growth in chip area. **Provisionally cap effective chip area
(`chipload × material factor × depth_per_pass`) at 1.0 mm²** — ≈78 % of Onsrud's 1/4"
industrial figure. Under R1 this binds nothing at ⌀6 (0.30) or ⌀8 (0.84) and **does** bind the
⌀12 (1.80 → forces its pass depth to ~3.3 mm).

🔴 **This number is mine, not published.** No source found expresses a chip-area cap. It is
offered because Part 4's finding is real and a ratio cannot express it — **the shape of the
rule is well founded; the constant is not, and should be set from the coupon, not from this
document.** Approve the shape, hold the number.

### R3 — the compression bit must be handled, not exempted *(implemented as A3)*

Under R1 the shipped `End Mill - Compression 6mm 2F` is capped at 3 mm/pass, which is **below
its up-cut section** (~6 mm on a 1/4"-class compression bit) — so it never reaches the
down-shear and **tears the top veneer while every gate stays green.**

**Recommended: warn, do not exempt.** Emit a note on any job that runs a `Flute::Compression`
tool in **more than one pass**, saying in plain words that the tool will not compress at this
pass depth and the top face will tear. This is implementable with what already exists
(`Flute::Compression` + the pass count) and it follows the lane's own doctrine — *"refuse
rather than approximate"*, and *"'no clamps declared' and 'clamps checked' are different
facts."* **A silent exemption for compression would reintroduce full-depth slotting through
the back door on the exact tool people reach for in ply.**

### R4 — the other three numbers, for the same approval *(implemented as A2)*

Confirming and slightly sharpening `materials-research.md` (see Part 8):

```
Acrylic  chipload_factor   1.15  →  0.75
MDF      chipload_factor   1.10  →  1.00
Softwood chipload_factor   1.20  →  1.10
```

### R5 — one thing NOT to approve on its own *(= B2: COUPON-GATED)*

**Do not raise the base chiploads without R1.** Raising the ⌀6 nominal from 0.10 toward
Onsrud's published 0.15–0.20 mm is defensible *paired with* a halved depth (constant chip
area, thicker chip, less rubbing, better tool life — the trade is roughly time-neutral because
feed rises as pass count does). **Raising it alone, at the current 1.0×D, multiplies straight
into the 380,000 mm³/min case in Part 6.** Order matters: **depth first, chipload only after a
coupon.**

---

## Part 8 — The other flagged numbers, sanity-checked at primary sources

### Acrylic `chipload_factor = 1.15` — the existing reading is CONFIRMED, with a better citation

`materials-research.md` argued the 1.15 folds an O-flute remedy into a per-tooth multiplier.
**Onsrud's own Hard Plastic sheet states the remedy verbatim, and it is the sentence that
settles it:**

> **"NOTE: When chip rewelding occurs while cutting plastic, increase feedrate or go to a
> single edge tool."**
> — LMT Onsrud, *Hard Plastic Cutting Data Recommendations*, read 2026-08-09

Both remedies raise the **chip**; neither raises the **per-tooth chipload of a 2-flute
cutter**. And the sheet shows exactly why the confusion arises — the high per-tooth numbers
belong to the O-flute series:

| Onsrud series (Hard Plastic) | chip load at 1/4" |
|---|---|
| 52-200B/BL | **.004–.006"** |
| 56-000 / 56-000P | .004–.006" |
| 60-000 | .004–.006" |
| 37-00/37-20 | .004–.006" |
| 62-700 / 62-800 / 63-700 / 63-800 / 64-000 / 65-000 (**O-flute**) | **.008–.010"** |

**A new same-series cross-material ratio, which is the cleanest comparison available:**
Onsrud **52-200B/BL** is `.004–.006"` in Hard Plastic and `.006–.008"` in Soft Plywood ⇒
**acrylic / plywood = 0.71**. That sits with Techno's 0.74 and Amana's 0.63, and the published
band stays **0.63–1.00**. **Our 1.15 is above all of it.** ⇒ **`1.15 → 0.75`** (the middle of
the band, and within 6 % of the same-series 0.71).

### MDF `1.10` and Softwood `1.20`

Unchanged from `materials-research.md`'s finding and nothing found today moves them: MDF's
published band is **0.78–1.00** (no chart puts MDF above plywood), softwood's is **1.00–1.17**.
⇒ **MDF `1.10 → 1.00`** (the top of its band, so the change is minimal and defensible) and
**Softwood `1.20 → 1.10`** (inside Onsrud's own 1.06–1.17).

### `max_rpm = 24,000` for wood — flagged, no change recommended

Not unsafe on its own (higher rpm at a fixed chipload is more feed, not more force per tooth),
but it is the reason the feed comparison in Part 6 came out where it did, and `recommend`
selects it deliberately. **If R1 is approved and throughput becomes the complaint, the honest
lever is chipload paired with depth (R5), not rpm** — rpm buys feed by thinning nothing and
raises the rubbing/burning risk in ply. Recorded so it is not quietly changed as a
throughput fix.

---

## Part 9 — What happens if this recommendation is wrong, in each direction

### Too conservative (0.50 when the machine would have taken 1.00)

- **Pass count doubles on a through-cut.** 18 mm ply: 3 passes → 6. On a full 2400 × 1200 nest
  that is real shop time.
- **Total cut time roughly doubles** *at unchanged feed* — and only ~doubles, not more,
  because the extra cost is per-pass lead-ins, plunges and corner decelerations, not cutting.
- **Not more heat.** A common worry, and it is wrong: chip thickness is unchanged, so the
  thermal load per tooth is unchanged. More passes at the same chipload is more *time*, not
  more *burning*. (Burning comes from a **thin** chip, which is the opposite change.)
- **More opportunities to lose the part late**, since the final pass is one of six rather than
  one of three — a minor negative that partly offsets the workholding benefit.
- **Recovery is cheap and evidenced:** raise to 0.75, re-cut the coupon (R1a). One line, one
  coupon.

### Too aggressive (keeping 1.00 when the machine will not take it)

- **First and most likely: the joints do not fit.** Deflection taper of the order of tens of
  microns on a finger/dogbone budget of 100 µm. **This does not look like a failure** — the
  part comes off intact and the joint is tight or loose, and the operator blames the CAD. That
  is the expensive kind of wrong, because it is *diagnostically silent* and recurs every job.
- **Second: a burnt glue line and a packed flute**, especially with the down-cut ⌀6, which is
  the library's default 6 mm tool. Cost: a dulled cutter (~$15–40) and a scrapped part.
- **Third, and the one that costs real money: the part breaks free** with the cutter buried
  6 mm. Cost is **a sheet of 18 mm structural ply**, plus the cutter, plus whatever the part
  hits. A ply sheet is worth many cutters — the expensive consumable in this failure is **the
  material, not the tool**.
- **A snapped cutter or a stalled spindle is NOT the expected failure** (Part 5) and should not
  be used to argue for this change. Overstating the danger here would be its own defect.
- **Recovery is not cheap:** there is no evidence path back from a crashed sheet, and the
  first real cut this lane ever makes is the worst possible place to discover the number was
  wrong.

**Asymmetry, stated plainly:** too conservative costs **shop time, recoverable in one line
after one coupon**. Too aggressive costs **a silent accuracy defect on every job, plus a
material-cost crash, with no cheap path back.** With **zero cuts made to date**, that
asymmetry is the decision.

---

## Part 10 — What could NOT be established

Named, so nothing here wears a number it did not earn.

1. **Any vendor-published DOC figure for the Bellwether Lead 1000×1500.** The closest is a
   *review* of the OpenBuilds LEAD 1515 — same architecture, not the same product, and a
   review is not a spec.
2. **A machine-class qualifier on ToolGrit's slotting rule.** Re-checked today: it contains
   none. TODO #38 describes it as "the one prosumer-router source"; it is better described as
   the one **slotting-specific** source. That distinction matters and I could not close it.
3. **Vectric, Estlcam and Avid CNC default pass depths.** Vectric documents the *field* and
   explicitly declines to give a number; Estlcam publishes no documented default; no Avid
   per-material DOC chart was found. Three of the seven sources the brief named **do not exist
   as citable figures.**
4. **The specific cutting energy (K) of plywood/MDF/softwood in J/cm³** from a primary text.
   Marked GENERIC. The spindle-headroom conclusion is invariant across 20–100 J/cm³ and is
   separately corroborated empirically, but the number itself is not sourced.
5. **Carbide tool effective core diameter and bending strength.** Both GENERIC. The
   cutter-fracture margin (5–20×) survives a 3× error in either, but is an estimate.
6. **Gantry stiffness of a C-Beam machine (N/µm).** Not found published in any form. **Only
   the tool-tip deflection in Part 5 is computed; the gantry's contribution is unquantified
   and is additive** — so the deflection figures given are a **floor, not a total.**
7. **A numeric DOC derate for down-cut vs up-cut.** The published derate is on *chipload in
   hardwood* (−15 %) only. The chip-evacuation argument for capping a down-cut in a deep slot
   is reasoning, not a citation.
8. **The exact up-cut section length of our ⌀6 compression tool.** The 1/4"-class figures
   (~0.25", ~3/32") come from two secondary sources that disagree with each other by 2.6×, and
   our library does not model the dimension at all. R3 is written to be correct without it.
9. **The diameter assumed by the widely-circulated "Shapeoko Feeds And Speeds Chart.xlsx"**
   (plywood 0.25", MDF 0.30", pine 0.40"). It states no cutter diameter, so it yields **no
   ratio**, and it is **deliberately excluded from Part 1** rather than assumed to be 1/4".
   *An unstated diameter is the same defect class as an unstated machine.*
10. **Everything physical.** Nothing here has met a cut. No output of this tool has run on a
    controller. The air-cut → foam/MDF coupon → real-ply rungs are unclimbed, they need `ops`
    and a machine, and **a published chart is not a coupon — including the ones in this
    document.**
