# Touch-plate ownership (#40, SHIPPED) and the thickness default (#43, OPEN)

Comparative research against seven senders/controllers and two CAM packages, **read
2026-08-09**, building on `docs/touchplate-research.md` (13 products, 10 sourced,
read 2026-08-08). Every claim carries the URL it came from and the date it was read.

---

## 🔴 Status first, so nobody reads this as an open decision it is not

| TODO | State | What this document does |
|---|---|---|
| **#40** — the plate belongs to the SETUP, not only the machine | ✅ **SHIPPED** in `a447e25fa` | **VERIFIES** the shipped model against the industry survey. It does not re-derive it. |
| **#43** — `touch_plate_mm` is unsourced and means two quantities | 🔴 **OPEN** — `core/src/types.rs:445` still reads `touch_plate_mm: 1.6` | **RECOMMENDS ONE DEFAULT**, with its failure direction named. |

The two-quantities half of #43 (a corner-plate thickness vs a tool-setter standing
height) is **partly** closed by the same commit: `TouchPlate::top_mm` on the setup is
now a different field from `Machine::touch_plate_mm`, and both doc comments say so.
What is **not** closed is that the machine field still carries an **unsourced,
non-zero, always-present number** — so the machine half of the split is a field that
cannot say "nobody has told me".

> ### The answer, in one line
>
> **`pub touch_plate_mm: Option<f64>`, defaulting to `None`, and `None` is REFUSED.**
> Not a sourced number — **there is no number to source**, and the two vendor-neutral
> tools that ship one both ship an arbitrary one. **It fails LOUD and BEFORE ANY
> MOTION**: an operator who has not measured cannot export a probing program. Exact
> field text, refusal wording and the two call sites are in §3; **the migration is a
> separate decision and must not ride along — §5.**

---

## 1. How the comparable tools model it, by SCOPE

The question asked of every tool: **where is the plate/probe configuration stored, and
what does it belong to?** Not the UI — the data model.

| Tool | Plate/probe config lives | Scope | Plate chosen from a catalogue? | Fixed tool setter stored as | Default thickness shipped |
|---|---|---|---|---|---|
| **gSender** (Sienci) | `workspace.probeProfile` in the app store — **sibling of `workspace.machineProfile`, not inside it** | **App/shop** (one install = one shop), with a **per-plate-type** sub-map | ✅ **YES** — `touchplateType` selects one of 5 named products; `zThickness` is a map keyed by them | not a plate: `workspace.toolChangePosition {x,y,z}` + ATC macros | ✅ non-zero, **per type**: 15 / 5 / 15 / 0 / 13 / 15.5; `xyThickness: 10` once for all |
| **UGS** — classic `ProbeModule` | `NbPreferences.forModule(ProbeTopComponent.class)` — NetBeans user preferences | **App/user** — no machine profile, no job | ❌ no plate concept at all; only per-routine **offsets** | — | **0** for every offset (`XYZ_Z_OFFSET`, `Z_OFFSET`, `XYZ_X/Y_OFFSET`) |
| **UGS** — new `ugs-fx` | `Preferences.userNodeForPackage(ProbeSettings.class)`, key `probe.z.plateThickness` | **App/user** | ❌ | — | 🔴 **20 mm**, unsourced — **larger than every plate in our 13-product survey** |
| **bCNC** | `[Probe]` section of `bCNC.ini` | **App/installation** (one bCNC = one machine) | ❌ | ✅ **explicitly and separately**: `toolprobex/y/z`, `tooldistance`, `toolheight`, `toolmz` — **machine coordinates** | 🔴 **no plate-thickness field exists**; `grep -i thick ProbePage.py` → 0 hits |
| **LinuxCNC** | `[TOOLSENSOR] X / Y / Z / MAXPROBE / PROBEFEED` in the **machine INI file** | **MACHINE**, unambiguously | ❌ | ✅ that *is* the model — a **position in machine coordinates**, never a thickness | no plate thickness anywhere; per-setup touch-off is an operator act, per-tool offsets live in `tool.tbl` |
| **Carbide Motion** (Carbide 3D) | per-machine JSON in `AppData/Local/Carbide 3D/CarbideMotion6/<machine>` — `"bitZeroType": 2` | **MACHINE** | ✅ **YES, and it is an ENUM not a dimension** — the geometry is compiled into the app, indexed by the integer | ✅ **BitSetter**: `bitSetterX` / `bitSetterY` in the same file. Its **height is never stored** — a setter measures a *difference* between two touch-offs | no thickness field exists at all; the baked-in V2 value is ~13 mm, **inferred by a user from measured Z error, never published** |
| **OpenBuilds CONTROL** | browser `localStorage` (Electron): `probeType`, `z0platethickness`, `customProbe` | **App/shop** | ✅ **YES — and with a first-class `Custom` entry** carrying its own X/Y/Z offsets | — | ✅ **20 mm** (`index.html:1686`), matching their own Z Touchplate's `zoffset: 20` |
| **Mach4** (Newfangled) | `[ToffParams] ToffPlate` in the **machine profile ini**, written on focus-loss | **MACHINE profile** | ❌ free numeric entry; only validation is `math.abs()` | separate `Z Only → Tool Length (TLO)` mode | ✅ **`.2500`** (machine native units, undeclared) — 🔴 **and the UI text box falls back to `0.2` while the arithmetic falls back to `.2500`** |
| **Mach3** | a literal inside a **VBScript button macro** the user edits in-app (`code "G92Z0.2500"`) | **neither — it is source code** | ❌ | ❌ | none: the stock button ships `Message (Not Yet Implemented)` |
| **Candle** (Denvi) | `touchCommand` in `settings.ini` beside the executable | **App-global** | ❌ | ❌ | 🔴 **no touch-plate concept exists.** The shipped probe command probes and *does nothing*; zeroing is a separate `G92Z0` **at the plate top**, thickness silently unaccounted |
| **Vectric VCarve/Aspire** (CAM) | Job Setup: **XY Datum Position** + **Z Zero** | **JOB / material** | n/a | n/a | n/a — the datum is *"relative to your design"* |
| **Autodesk Fusion** (CAM) | Setup → WCS Origin (`Stock box point` / `Model box point` / selected point) | **SETUP** | n/a | n/a | n/a |

### 1a. The three findings that matter

**(i) Nobody stores a plate POSITION relative to the work. Nobody.** Every stored
position found in seven tools is a **machine coordinate** — bCNC's `toolprobex/y/z`,
LinuxCNC's `[TOOLSENSOR] X/Y/Z`, gSender's `toolChangePosition` — and every one of them
is a *fixed* device. The workpiece-referenced plate is **re-presented every setup** and
its position is never persisted at all. The reason is structural and it is why the
survey cannot simply be copied: **a sender has no workpiece model**, so the question
"does the plate move with the sheet?" cannot arise for it. There is no stock, no
rotation, no placed rectangle — only a human who puts the plate where they put it.

⇒ **The #40 defect is a CAM defect, not a sender defect, and it must be judged against
CAM.** And CAM answers it the same way we did: Vectric's datum *"can be set at any
corner, or the middle of the job … relative to your design"*; Fusion's WCS origin is a
**Stock box point** chosen inside the **Setup**. Both put the datum on the job/stock,
not on the machine.

**(ii) The plate-as-purchased-object hypothesis is CONFIRMED, by three independent
tools.**

- **gSender** — `touchplateType` selects over five *product names*
  (`Standard Block`/`AutoZero`/`Z Probe`/`3D Probe`/`BitZero`), `zThickness` is a **map
  keyed by product**, the settings UI **hides every field that does not belong to the
  selected product**, and `getProbeCode()` **dispatches to a different routine per
  product**. Identity → dimensions → capabilities → routine.
- **Carbide Motion** — the purest form: the machine JSON stores **`"bitZeroType": 2`**,
  an **integer identity with no dimension anywhere in the config.** The geometry is
  compiled into the application and indexed by that integer.
- **OpenBuilds CONTROL** — named plate objects carrying their own offsets
  (`xoffset`/`yoffset`/`zoffset`), selected from a dropdown, **plus a first-class
  `Custom` entry** with its own editor.

Three tools, three implementations, one shape. **This is not a hypothesis any more.**

**(iii) The wall is published only ever in SOFTWARE — and it is now TWO products, not
one.** `docs/touchplate-research.md` recorded one wall figure in thirteen entries
(Sienci Standard Block, 10 mm, out of gSender's defaults). **OpenBuilds CONTROL supplies
a second, from the same class of source:**

> ```js
> var xyzprobeplate = { xoffset: 10, yoffset: 10, zoffset: 9, name: "OpenBuilds XYZ Probe Plus", xyzmode: true }
> var zprobeplate   = { xoffset: 0,  yoffset: 0,  zoffset: 20, name: "OpenBuilds Z Touchplate",  xyzmode: false }
> ```
> — `app/wizards/probe/probev2.js:1–23`, <https://github.com/OpenBuilds/OpenBuilds-CONTROL>

🔴 **This fills two rows that `docs/touchplate-research.md` has as OPEN** — that document
records "Top (Z) thickness for OpenBuilds … Absent" and nulls both figures, having found
only the **12 mm overall block height** on a reseller page and correctly refusing to use
it. The vendor's own software declares **top 9 mm and wall 10 mm** for the XYZ Probe
Plus. **The refusal to use the 12 mm was right** — 9 ≠ 12, so reading the overall height
as the top thickness would have been 3 mm out. *(Routed, not applied: that file is not
this document's to edit.)*

**And the pattern holds, harder.** Two wall figures now exist in the world, **both are
10 mm**, **both come out of a shipped application's defaults**, and **neither appears on
any vendor drawing or product page.** Re-measured in gSender: `xyThickness` is *stored*
once for all five plate types but *read by one* — `SettingsMenu.ts` hides the field
unless `touchplateType === 'Standard Block'`, `Probing.ts:140` forces it to `0` for the
3D probe, and the AutoZero and BitZero routines never reference it. **A number that four
of five products ignore, and that no manufacturer prints, is not a product dimension.**

**(iv) A CLOSED catalogue breeds deliberate misdeclaration — and one vendor already
solved it.** Carbide Motion's catalogue has no custom entry, so Carbide's own staff
recommend lying to it: *"you can lie to the software about which probe you have and then
probe as for a v1 along an axis but actually use a v2"* (William Adams, Carbide 3D,
2021-12-27, <https://community.carbide3d.com/t/a-3rd-bit-zero-option/38321>). OpenBuilds
CONTROL ships `Custom XYZ Touchplate` as a **first-class catalogue entry with its own
X/Y/Z offset editor**, so users get vendor-correct defaults *and* an escape hatch.

⇒ **`web/src/touchplates.ts` already has the escape hatch** — the `generic: true`
unbranded-block entry with every dimension `null` and `MEASURE_YOUR_PLATE` beside it.
That is the OpenBuilds answer, arrived at independently, and it is the entry the founder's
own two plates land in. **Do not "complete" it with numbers.**

---

## 2. Verdict on the shipped #40 model — it matches, and where it does not, it is ahead

Read at `core/src/types.rs` (lines 210–296, 360–416, 456–505) and
`gates/slicer_gate_check.mjs` (gate `PROBE`).

| Owner | Shipped fields | Industry precedent |
|---|---|---|
| **MACHINE** — fastened to the table | `probe_enabled`, `probe_plate`, `touch_plate_mm`, `probe_x`/`probe_y`, `probe_seek_feed`, `probe_feed`, `probe_max_mm`, `probe_retract_mm` | ✅ **LinuxCNC `[TOOLSENSOR]`** puts exactly this class in the machine INI. bCNC keeps `toolprobex/y/z` + `toolheight` in the same place; **Carbide Motion** keeps `bitSetterX`/`bitSetterY` in the per-machine JSON; **Mach4** keeps `[ToffParams]` in the machine profile ini. |
| **SETUP** — `Stock` | `corner_plate: Option<CornerPlate>` = `{ plate, corner, xy_depth_mm }`, `z_zero_at_top`; **position never stored**, derived by `corner_placement()` | ✅ **Vectric Job Setup** and **Fusion Setup** put the datum on the job. gSender's corner (`widgets.probe.direction`, default `0` = bottom-left) is a **probe-time** choice, not a machine property — same scope, weaker binding. |
| **PLATE** — the purchased object | `TouchPlate { top_mm, wall: PlateWall }` + `web/src/touchplates.ts` catalogue | ✅ **gSender** (`touchplateType` + per-type `zThickness`), **Carbide Motion** (`bitZeroType` as a bare identity) and **OpenBuilds CONTROL** (named plate objects + a `Custom` entry) all do this. Three of nine. |

**Verdict: the three-way split is correct and is confirmed by three independent lines of
evidence** — CAM packages (Vectric, Fusion) for the setup half; LinuxCNC, bCNC, Carbide
and Mach4 for the machine half; gSender, Carbide and OpenBuilds for the catalogue half.
**Do not change it.**

Three places where the shipped model is **ahead of every tool surveyed**, recorded so
nobody "corrects" it back:

1. **The corner plate's bed position is derived, never stored.** No surveyed tool does
   this because none of them has a stock model. Gate `PROBE` asserts it in both
   directions — a moved sheet carries its datum and its station, a quarter turn carries
   it with the stand-off reversed, and **a fixed plate does not move** (the limb that
   stops a post from moving both).
2. **`PlateWall` is a three-state enum, not an `f64`.** `Undeclared` / `NotPresent` /
   `Mm(v)`, with **two different refusals**. gSender expresses "this plate has no wall"
   by *hiding the field* — the value 10 is still sitting in the store, and
   `Probing.ts:140` has to special-case the 3D probe to `0` at the point of use.
   Ours is a fact in the type; theirs is a fact in the UI and a special case in the
   emitter.
3. **An unrecognised plate string leaves the field alone** (`core/src/fixtures.rs:634`)
   rather than falling back. gSender does the opposite and it is the clearest migration
   warning in this document — see §5.

**Acceptance criteria checked, both pass:**

- **Plate with NO wall** → `PlateWall::NotPresent`, refused for corner probing with a
  message distinct from `Undeclared`. Verified against the two real products: the
  BitZero probes a **15 mm bore** (`BITZERO_BORE_DIAMETER = 15`) where the radius
  cancels, and the AutoZero's `get3AxisAutoRoutine` takes **no tool diameter and no
  `xyThickness`**, using fixed `22.5 / 22.5` offsets off a chamfer. Neither has a wall
  to declare, and the model can say so without lying.
- **Tool setter vs corner plate** → different owners, different fields, and the gate has
  a limb asserting the fixed one *stays put* when the sheet moves. LinuxCNC's
  `[TOOLSENSOR] Z = 10` is a machine coordinate; our `TouchPlate::top_mm` is a
  thickness. The two quantities are now in two structs.

---

## 3. 🔴 RECOMMENDED DEFAULT for `touch_plate_mm`: **refuse until declared**, never a number

### The answer, exactly — someone is going to type this

**`core/src/types.rs:400`**

```rust
    /// 🔴 `None` = NOBODY HAS DECLARED IT, and it is REFUSED — never defaulted.
    /// There is no typical value: the published Z figures across the 13 surveyed
    /// products are 5, 13, 15, 15.4 and 15.5 mm, a 3x spread, and the two plates
    /// this shop owns publish nothing at all. A plausible number here RUNS.
    ///
    /// `Some(0.0)` is LEGAL BUT ONLY IF TYPED: it declares "no plate — the tool
    /// tip zeroes on the surface it touches". Reachable by choice, never by
    /// omission. `Some(v)` with `v < 0.0` is refused.
    pub touch_plate_mm: Option<f64>,
```

**`core/src/types.rs:445`**

```rust
            touch_plate_mm: None,
```

**Why `Option<f64>` and not a new enum: the config surface already has this shape.**
`core/src/fixtures.rs:484` **already** declares `pub touch_plate_mm: Option<f64>`, and
line 627's `set!` is the only thing that collapses an absent value into `1.6`. So the
change is to stop collapsing it — the `--config` route, the fixture diff and the machine
struct then all carry the same three-way fact (absent / declared / declared-as-zero) with
no new type to thread through the WASM boundary, the CLI or the golden files. A
four-variant `ZDatum` is the *right long-term shape* and it is **P2 below**, not this
change; it needs a founder ruling that this one does not.

**Two consequential sites, and only two:**

1. `core/src/post_grblhal.rs:248` `fixed_z_probe(machine) -> ZProbe` becomes fallible —
   `None` produces a refusal in the same list as the other seven, not a `ZProbe`.
2. `core/src/fixtures.rs:627` `set!(d.touch_plate_mm, m.touch_plate_mm)` becomes a
   straight copy instead of a collapse.

**The refusal text the operator sees** — written to the same standard as the seven
already in `probe_geometry()`, which name the setting because "probe refused" without the
field is a support call:

> `a Z probe sets the datum every coordinate is measured from, and`
> `machine.touch_plate_mm is not declared — the thickness between your plate's top`
> `face and the workpiece top is a number only you can measure, and nothing near a`
> `typical value exists (real plates run 5mm to 15.5mm). Measure yours with calipers`
> `and enter it. If you are probing the workpiece directly with no plate, enter 0.`

### Why refuse rather than ship a sourced number — the failure directions, derived and then confirmed

Both the post and every tool surveyed emit `G10 L20 P1 Z<value>` at the moment of
contact (`core/src/post_grblhal.rs:425`; gSender `G10 L20 P0 Z[Z_THICKNESS]`; UGS-fx
`setWorkPosition(Axis.Z, plateThickness)`). At contact the tip stands the plate's true
thickness `T` above the work. Setting `Z = value` puts work-zero at `T − value` above
the work top. Therefore:

| Declared value | Work zero lands | The machine then cuts | Danger |
|---|---|---|---|
| `value < T` (**under**-declared) | **above** the work top by `T − value` | **shallower** — in the limit, entirely in the air | scrapped part, no crash |
| `value = T` | at the work top | as programmed | — |
| `value > T` (**over**-declared) | **below** the work top by `value − T` | **deeper** — and the safe-Z retract is displaced down with it, so a 3000 mm/min rapid runs at a height the operator believes is clear | **spoilboard, clamps, cutter** |

Confirmed at a primary source rather than left as arithmetic. The Carbide 3D community
thread on the BitZero V2 being 13.1 mm while the software assumes 13.0 mm states the
direction of an **under**-declaration explicitly: *"This puts the reference zero surface
0.1mm above the actual surface the probe was sitting on"* and *"the virtual zero surface
is now above the actual surface"* — i.e. **too shallow / the tool too high**
(<https://community.carbide3d.com/t/configuration-for-the-bitprobe-v2-thickness/45548>,
read 2026-08-09).

**That inverts the argument the naive fix rests on.** The present `1.6` under-declares
against every plate in the survey (5 … 15.5 mm), so it fails in the **shallow** direction
— bad, but not the crash direction. **A *sourced* catalogue default is worse than the
unsourced one**, because 15 mm — the most-published figure — **over**-declares by 10 mm
for anyone holding an AutoZero, and over-declaration is the direction that reaches the
table. Sourcing the number does not fix the defect; it moves it into the dangerous
direction for a subset of users we cannot enumerate.

**The failure direction of the recommendation, stated plainly:** refuse-until-declared
fails **loud, early, and before any motion**. An operator who has not measured cannot
export a probing program. The cost is one setup field and a caliper. It cannot produce a
plausible wrong part and it cannot produce a deep cut. **The accepted downside is real
and is named:** a shop that only wants a quick Z touch-off on bare stock is stopped by a
field it thinks it does not need — which is exactly why `Some(0.0)` must remain legal as
an *explicit typed choice* rather than being reachable by leaving a box empty. The whole
recommendation rests on that distinction: **`None` and `Some(0.0)` are different facts,
and only one of them is safe to run.** It is the same three-way shape `PlateWall` already
uses for the other axis, and that one is already armed by gate `PROBE` with two distinct
refusals.

### 🔴 The counter-evidence, stated before the argument that survives it

**Not one of the nine programs surveyed forces entry or ships blank.** Every tool that
has the field at all ships a number: gSender 15/5/15/0/13/15.5, OpenBuilds 20, Mach4
`.2500`, UGS-fx 20, Carbide ~13 baked into the binary. **The recommendation above is
without precedent in this survey, and that is a real cost, not a detail to bury.**

Two reasons it is still right:

**(1) Every shipped default in the survey has a documented failure attached to it.**
Carbide's baked-in 13 mm is 0.1 mm wrong against the physical object and the vendor would
not confirm the constant when asked. Mach4 ships **two different fallbacks for the same
key** — `.2500` in the probe arithmetic (`mcTouchOff.lua:37`), `0.2` in the text box that
displays it (line 1165) — so on a never-touched profile the operator reads one number
while the machine uses another, 1.27 mm apart. OpenBuilds' 20 mm silently reverted over
users' entered values for long enough to become issue #132, whose own words are *"anywhere
from inconvenient to minorly disastrous, depending on how much attention the user is
paying"*. Mach3's stock button ships **not implemented**. Candle's shipped probe command
**probes and then does nothing**, and its separate zero button sets Z0 at the plate top
with the thickness unaccounted. **Five programs, five defects, all in the same field.**

**(2) The structural difference that makes the precedent inapplicable: every one of
those nine is a SENDER or a CONTROLLER, with a human standing at the machine.** They
probe *interactively*: the operator clicks probe, watches the tool touch, reads the DRO,
and can jog to the surface to check before anything cuts. A wrong default is caught by a
person in the loop, which is why shipping one is survivable there.

**We are CAM.** We emit a file. It is run later, possibly by someone else, possibly on
another day, and **the datum is baked into the program before anyone is standing
anywhere.** The feedback loop those defaults rely on does not exist on our side of the
bracket. That is also why this lane's rule is *refuse rather than approximate*, and why
the two CAM packages in the survey have no plate-thickness default to get wrong: they put
the datum on the job and leave the number to the machine.

### The rule the survey does support

> **A tool may ship a plate-thickness default only if it also ships the plate.**

- **gSender** (Sienci sells the machine, the Standard Block and the AutoZero),
  **Carbide Motion** (Carbide 3D sells the BitZero and the BitSetter) and **OpenBuilds
  CONTROL** (whose 20 mm default *is* the OpenBuilds Z Touchplate's own `zoffset`) all
  ship a default **that names their own product**. Three for three.
- **Every vendor-neutral tool either has no field or gets the number wrong.** bCNC,
  LinuxCNC and Candle have **no plate-thickness field at all**. UGS classic ships **0**
  for every offset — the neutral value, correct for the bare-work case. **UGS-fx ships
  20 mm and Mach4 ships 0.25″ (6.35 mm), both unsourced**; the 20 mm exceeds every plate
  in our 13-product survey, so it **over**-declares for every real user — the plunge
  direction — and 6.35 mm over-declares against a 5 mm AutoZero and under-declares
  against everything else. **Both vendor-neutral tools that ship a number ship an
  arbitrary one.**

**We are vendor-neutral in the strongest sense**: the plates this shop owns are two
unbranded marketplace blocks with no published dimension of any kind
(`docs/touchplate-research.md`, "The unbranded aluminium block"). There is no number to
inherit. **We are UGS's situation, not gSender's, and UGS-fx shows what happens when you
guess anyway.**

### Scope note — why this does NOT reopen #40

A **thickness** does not move when the sheet moves; only a **position** does. That is
why gSender can keep its plate dimensions at app scope with no ill effect, and why
leaving a Z-only plate's thickness on `Machine` is tolerable even though the plate is
workpiece-referenced. The #40 defect was **the stored position and the stored corner**,
and those have moved. Do not read this recommendation as pulling anything back onto the
machine.

### Priority

| | Change | Why now |
|---|---|---|
| **P0** | `Machine::touch_plate_mm` → `Option<f64>`, default `None`, refused — exactly as spelled out above | the only live defect; a wrong value RUNS today. Self-contained, and the config surface already has the shape. |
| **P1** | Gate `PROBE` gains a limb: probe enabled + `touch_plate_mm: None` ⇒ **refused, no `G38` emitted** — with a `--plant` that makes it go red | the lane's own rule: a gate nobody has watched go red is not a gate. P0 without P1 is an unwatched refusal. |
| **P2** | Split the two quantities into variants — `Machine::z_datum: ZDatum { Undeclared, PlateTop(f64), ToolSetter { standing_height_mm, over_travel_mm } }` | closes the *other* half of #43 structurally, so a 90 mm standing height cannot be typed into a thickness. 🔴 **Needs a founder ruling first** on which surface Z is wanted at for a setter — `types.rs:393` says `z_zero_at_top` is adjacent but is not that ruling. **Do not bundle with P0.** |
| **P3** | Model the workpiece-referenced **Z-only plate laid on the stock** as `Stock::z_plate: Option<TouchPlate>` | removes the *reason* anyone types a plate thickness into a machine field. Not urgent: P0 alone is safe, per the scope note above. |
| **P4** | Check the retract/plate coupling: after the Z touch, does the emitted retract clear the plate's top before any lateral move? | **two independent instances in the survey** — the maintained Mach3 script warns `intZRetractHeight` *"MUST be greater than … intTouchPlateThickness or the tool will crash into the touchplate"*, and OpenBuilds shipped `v1.0.215: "Fixed bug with Z Plate retract where plate is thicker than 10mm"`. Our `probe_retract_mm` defaults to `2.0` and the plate is 15. **Not established here — flagged as a question, not a finding.** |

---

## 4. What must happen when the workpiece moves or turns

**In the shipped model this is automatic, and it is the part that is already armed.**

`Stock::corner_plate` stores the plate's **corner of the sheet**, never its position on
the bed. `Stock::corner_placement()` derives the bed coordinates and the stand-off signs
from the **placed rectangle** every time they are asked for — so a dragged origin or a
quarter turn cannot leave a stale datum behind, because there is no stored datum to go
stale. `CornerPlacement`'s doc is explicit that its signs are **not**
`ProbeCorner::x_sign()`: one answers "which side of the sheet", the other "which side of
the placed rectangle", and a quarter turn makes those different answers.

Gate `PROBE` asserts all three limbs — the datum and the station follow a sheet moved to
(137,42), a quarter turn carries them with the stand-off reversed, and **a fixed plate's
station does not move**. Each has a negative control.

**Two rules the model does not make automatic and that still have to be held by hand:**

1. **`Machine::probe_x` / `probe_y` must never be used for a corner plate.** The doc
   comment says so in red; nothing *type-checks* it, because both are plain `f64` on the
   machine. It is enforced only by `fixed_z_probe()` being the sole reader. Making the
   fixed station part of the `ToolSetter` variant (P2 above) would close it structurally.
2. **A plate can be re-hooked without the sheet moving.** An operator who moves the plate
   from the front-left to the back-right corner mid-setup changes `corner` and nothing
   detects the difference between "not changed" and "not noticed" — the same class as
   `PlateWall::Undeclared` vs `0.0`. This is a UI/confirmation problem, not a model
   problem, and it is out of scope here; recorded so it is not assumed solved.

---

## 5. 🔴 MUST NOT BE AUTO-APPLIED — the migration is a separate founder decision

**P0 changes what an already-saved machine config DOES.** Ship the type change and the
refusal; **do not ship a data migration in the same commit**, and do not let one be
inferred.

Three things must not happen, in descending order of how quietly they would go wrong:

1. 🔴 **Never fill a `None` from the catalogue.** Not from "the most common value", not
   from a selected plate's `topMm`, not from the last machine that had one. The whole
   point of `None` is that nobody has said; a catalogue value inserted on load is a
   declaration the operator never made, and it is **exactly the failure gSender ships**
   — `storeUpdate.ts` coerces any unrecognised `touchplateType` to `Standard Block`, so a
   user whose plate is not on the list **silently acquires a 15 mm plate**, and the only
   symptom is a Z datum wrong by the difference. The comment says it exists so a dropdown
   would not "appear blank": a **cosmetic** problem fixed with a **datum-changing**
   default. `Probing.ts:922` does it again one layer down —
   `zThickness.bitZero || BITZERO_INSET_THICKNESS` — so a stored `0` falls back to `13`
   rather than refusing. **Both are the "0 does not refuse" defect that #43 is about,
   shipping in the tool whose arithmetic we copied.**
2. 🔴 **Never silently reinterpret a stored number as declared.** A saved
   `touch_plate_mm: 1.6` and a human who typed `1.6` are **byte-identical on disk**, and
   1.6 is the value nobody chose. Carrying it forward as `Some(1.6)` promotes the old
   default into a declaration — and every coordinate in a program built from that config
   inherits it.
3. 🔴 **Never regenerate the golden fixtures as a side effect.** `MachineCfg` carries
   **only** `probe_enabled` and `touch_plate_mm` on the `--config` route
   (`post_grblhal.rs:1062`), so this change moves that surface. Per `SLICER-GATES.md`, the
   commit that regenerates them pastes the **red** run that proved the new gate. A golden
   file that changed quietly is the same defect wearing a different hat.

**The recommended migration, for the founder to accept or refuse as its own decision:**

- `touch_plate_mm == 1.6` (byte-equal to the old default) → **`None`**. It was never
  declared; refusing is the truth. **This direction is safe because it is LOUD** — the
  config stops rather than cuts, and the cost is one refusal and one caliper reading,
  even for the shop that genuinely owns a 1.6 mm shim.
- any other value `v` → **`Some(v)` plus a one-time warning naming the value and its
  provenance**: "carried over from a machine file — confirm it against your plate". A
  silent carry-over launders an unverified number into a declared one.
- **a config file that enables probing and OMITS the field** currently gets `1.6` and
  runs; after P0 it **refuses**. This is the intended behaviour and it is also the part
  that will surprise someone. It must be announced, not discovered.

**The three populations, so the blast radius is a count and not a worry:**

1. **`probe_enabled: false` (the default) with any `touch_plate_mm`.** Nothing changes;
   the field is never read. This is almost every saved config.
2. **A config carrying `stock.corner_plate` (post-`a447e25fa`).** Already in the new
   shape, and it reads `TouchPlate::top_mm` — **not** the machine field. Untouched by P0.
   `corner_plate` defaults to `None`, so nothing acquires a plate it does not have.
3. 🔴 **`probe_enabled: true`, `ProbePlate::ZOnly`, with a numeric `touch_plate_mm`.**
   The only affected population, and the whole migration.

**Sources for the anti-patterns above:**
<https://raw.githubusercontent.com/Sienci-Labs/gsender/master/src/app/src/lib/storeUpdate.ts>,
<https://raw.githubusercontent.com/Sienci-Labs/gsender/master/src/app/src/lib/Probing.ts>,
both read 2026-08-09.

**The other half of the migration is the fixtures.** `core/src/fixtures.rs:484` carries
`touch_plate_mm: Option<f64>` and line 627 copies it into the machine, and
`post_grblhal.rs:1062` notes that `MachineCfg` — the `--config` route the settings gates
drive — carries **only** `probe_enabled` and `touch_plate_mm`. Changing the type changes
that surface, so the golden fixtures must be regenerated **deliberately**, and the
commit that does it must paste the **red** gate run per `SLICER-GATES.md`. A golden file
that changed quietly is the same defect wearing a different hat.

---

## 6. One thing to check in the code, routed rather than edited

Three places state the failure direction of an under-declared top thickness, and by the
derivation in §3 — confirmed at a primary source — **all three appear to have it
inverted**:

- `core/src/post_grblhal.rs` (the `top_mm <= 0.0` refusal): *"every cut in the program
  then runs one plate thickness **deep**"*
- `core/src/types.rs` (the `touch_plate_mm` doc block): *"runs one plate thickness
  **deep**"* (same wording)
- `web/src/touchplates.ts` (the generic-block entry): *"it **plunges roughly 13 mm
  deeper** than intended on a real plate"*

Under-declaring puts work-zero **above** the work top, so the machine cuts **shallower**
— *"the virtual zero surface is now above the actual surface"*
(Carbide 3D community, read 2026-08-09).

🔴 **The refusals themselves are correct and must not be relaxed** — a `0.0` top is
refused either way, and this changes nothing about which programs are allowed. What is
wrong is the **reason given**, and the reason is what an operator uses to decide how
urgently to care. It also matters for #43 specifically: it makes the current `1.6`
default look like a crash risk when it is a scrap risk, and it hides the real crash risk,
which is **over**-declaration and therefore any catalogue default. **`core/**` is being
edited by another agent in this session, so this is reported, not touched.**

---

## 7. What could NOT be established

| Status | Wanted | Where it stands |
|---|---|---|
| 🔴 **OPEN** | **Carbide 3D's actual baked-in thickness constants** per `bitZeroType` | Carbide publishes none, and staff declined to give one when asked directly (*"Please contact us at support@carbide3d.com and we'll work out how this should be handled"*, WillAdams 2022-05-17). The ~13 mm is a **user's inference from measured Z error**, not a spec. Also unknown: whether `bitZeroType` has values beyond 1 and 2. |
| 🔴 **OPEN** | **Mach3** — which file ultimately persists an edited button script; whether user DROs survive a restart | `HiddenScript.m1s` is named in the save prompt; the durable store is unestablished. **Assume DROs do not persist.** What *is* established: the thickness is a literal in source, not a config field. |
| ⚠ **PROVENANCE** | **Mach4** `mcTouchOff.lua` | Read from a third-party mirror (`cdedwards/Mach4Industrial`), not machsupport.com. It carries the **Newfangled Solutions** copyright header and every `[ToffParams]` key maps 1:1 onto the official vendor PDF's documented fields, which is what upgrades it from "some Lua file" to "the module the PDF documents" — but it is a mirror. The **units** of `ToffPlate` are also undeclared: the module applies no conversion and the UI does not label it. |
| ⚠ **PARTIAL** | **OpenBuilds CONTROL** on-disk `localStorage` location | Chromium `Local Storage/leveldb` under the Electron userData dir is the obvious inference. **Not verified, so not asserted** — the *scope* claim (app-global, not machine profile, not per job) stands on the source. |
| ⚠ **PARTIAL** | **Fusion** WCS-origin option names | Autodesk's own help returned **503**; the option names (`Stock box point`, `Model box point`) come from **vendor and community guides**, not from Autodesk. The *scope* claim (origin + stock belong to the Setup) is safe; the exact option strings are second-hand. |
| ⚠ **NOTED** | gSender's `widgets.probe.touchPlateHeight: 10` | A **second** thickness field in the same app: read into component state and written back (`features/Probe/index.tsx:127,452,612`) but **not** fed into the emitted routine, which takes `zThickness`/`xyThickness` from `workspace.probeProfile` (lines 477–529). Read as **vestigial**; a full-repo negative proof was not run. Recorded because it is the exact hazard of the same quantity living in two scopes — in the reference implementation. |
| ⚠ **METHOD** | GitHub code search | `gh search code` returned **empty** for every query in this pass — the tool `docs/touchplate-research.md` recommended on 2026-08-08 did not work on 2026-08-09. What worked: `gh api repos/<owner>/<repo>/git/trees/master?recursive=1 --jq '.tree[].path'` to list the tree, then `curl` on `raw.githubusercontent.com`. **A tooling note in canon goes stale like any other measurement.** |

---

## 8. Sources

All read **2026-08-09** unless stated.

**gSender (Sienci Labs)** — GPL-3.0, source read directly:
- <https://raw.githubusercontent.com/Sienci-Labs/gsender/master/src/app/src/store/defaultState/index.ts> — `workspace.probeProfile` (sibling of `workspace.machineProfile`), `widgets.probe`
- <https://raw.githubusercontent.com/Sienci-Labs/gsender/master/src/app/src/features/Probe/definitions.ts> — the `ProbeProfile` interface
- <https://raw.githubusercontent.com/Sienci-Labs/gsender/master/src/app/src/features/Config/assets/SettingsMenu.ts> — per-type field visibility keyed on `touchplateType`
- <https://raw.githubusercontent.com/Sienci-Labs/gsender/master/src/app/src/lib/Probing.ts> — `-(toolRadius) - xyThickness`, `G10 L20 P0 Z[Z_THICKNESS]`, `BITZERO_BORE_DIAMETER = 15`, `BITZERO_INSET_THICKNESS = 13`, `BITZERO_PROBE_THICKNESS = 15.5`, `determineAutoPlateOffsetValues` (fixed 22.5)
- <https://raw.githubusercontent.com/Sienci-Labs/gsender/master/src/app/src/lib/storeUpdate.ts> — the silent coercion to `Standard Block`
- <https://raw.githubusercontent.com/Sienci-Labs/gsender/master/src/app/src/features/Config/assets/MachineDefaults/defaultMachineProfiles.ts> — machine profiles carry **no** probe fields
- <https://raw.githubusercontent.com/Sienci-Labs/gsender/master/src/app/src/features/Probe/index.tsx> — where the emitted options are assembled

**UGS (Universal Gcode Sender)** — GPL-3.0:
- <https://raw.githubusercontent.com/winder/Universal-G-Code-Sender/master/ugs-platform/ProbeModule/src/main/java/com/willwinder/ugs/platform/probe/ProbeSettings.java> — `NbPreferences`, all offsets default `0`
- <https://raw.githubusercontent.com/winder/Universal-G-Code-Sender/master/ugs-fx/src/main/java/com/willwinder/universalgcodesender/fx/settings/ProbeSettings.java> — `probe.z.plateThickness`, default **20**
- <https://raw.githubusercontent.com/winder/Universal-G-Code-Sender/master/ugs-fx/src/main/java/com/willwinder/universalgcodesender/fx/service/probe/ProbeService.java> — `setWorkPosition(Axis.Z, plateThickness)`

**bCNC** — GPL-2.0:
- <https://raw.githubusercontent.com/vlachoudis/bCNC/master/bCNC/bCNC.ini> — `[Probe]` section
- <https://raw.githubusercontent.com/vlachoudis/bCNC/master/bCNC/ProbePage.py> — `toolprobex/y/z`, `toolheight`, `toolmz`; **no** thickness field

**LinuxCNC** — GPL-2.0:
- <https://raw.githubusercontent.com/LinuxCNC/linuxcnc/master/configs/sim/axis/remap/manual-toolchange-with-tool-length-switch/manualtoolchange.ini> — `[TOOLSENSOR] X/Y/Z/MAXPROBE/PROBEFEED`, `[CHANGE_POSITION]`
- <https://linuxcnc.org/docs/html/config/ini-config.html> — the INI reference (no `[TOOLSENSOR]` in the *core* reference; it is a config-level convention, which is itself the finding: **the machine's INI is where it lives**)

**CAM packages:**
- <https://docs.vectric.com/docs/V11.0/VCarveDesktop/ENU/Help/form/Job%20Setup%20Single/index.html> — *"This datum can be set at any corner, or the middle of the job. This represents the location, relative to your design…"*; *"Indicates whether the tip of the tool is set off the surface of the material … or off the bed / table of the machine for Z = 0.0."*
- Fusion Setup / WCS origin — <https://help.autodesk.com/view/fusion360/ENU/?guid=MFG-SETUP> returned **503**; scope corroborated only by third-party guides (see §7).

**Carbide Motion / Carbide 3D:**
- <https://community.carbide3d.com/t/setting-bitsetter-location-via-json/74349> — the per-machine JSON: `"bitSetterEnabled"`, `"bitSetterX"`, `"bitSetterY"`, `"bitZeroType": 2`
- <https://community.carbide3d.com/t/cant-configure-bitsetter-location-in-settings/65588> — *"I had to modify the json to change from bitzero v2 to bitzero v1"*
- <https://my.carbide3d.com/pdf/BitZero_V2_Nomad3_Setup_and_User_Guide__03-08-2021_v1.pdf> — *"Select BitZero V2 for the probe type"*; the plate is placed on the stock corner and re-probed each setup. ⚠ `guides.carbide3d.com` 403s (as `docs/touchplate-research.md` records) but **`my.carbide3d.com/pdf/...` serves the same documents**
- <https://my.carbide3d.com/pdf/bitsetter-v2.pdf> — BitSetter position set by jogging + "Use Current X/Y"; **no height is stored**
- <https://community.carbide3d.com/t/a-3rd-bit-zero-option/38321> — the closed-catalogue workaround, from Carbide staff
- <https://community.carbide3d.com/t/bitzero-v1-support-in-the-latest-carbide-motion/38004> — *"Probe type is remembered after first selection. If a change is needed, go to Settings->Options"*

**Mach3 / Mach4:**
- <https://download.intelitek.com/Manuals/CNC/Routers/BenchRouter/Touch%20off%20Plate%20Setup.pdf> — OEM procedure: *"Delete the line `Message (Not Yet Implemented)`"*; *"Replace the Z0.2500 with the thickness of your plate"*
- <https://github.com/JamesDStallard/Mach3AutoToolZero/blob/master/AutoToolZero.vbs> — `intTouchPlateThickness`, and the retract-must-exceed-thickness warning
- <https://www.machsupport.com/wp-content/uploads/2014/05/TouchOffHelp.pdf> — Mach4 Touch Off module, vendor doc: *"Touch Plate Height is a variable for the thickness of the touch plate…"*
- <https://raw.githubusercontent.com/cdedwards/Mach4Industrial/master/Modules/mcTouchOff.lua> — `[ToffParams] ToffPlate`, fallback `.2500` at line 37 vs `0.2` at line 1165 (mirror; see §7)

**Candle (Denvi)** — GPL-3.0, source read locally:
- `src/frmmain.cpp:88,426,543,2376`, `src/frmsettings.cpp:641`, `src/frmsettings.ui:440` — `touchCommand` in `settings.ini` beside the executable; default `G21G91G38.2Z-30F100; G0Z1; G38.2Z-2F10`
- <https://raw.githubusercontent.com/Denvi/Candle/master/help/en/scripting/examples/zprobe.md> — *"In this sample the offset is assumed to be zero."*

**OpenBuilds CONTROL** — <https://github.com/OpenBuilds/OpenBuilds-CONTROL>:
- `app/wizards/probe/probev2.js:1–23` (the plate catalogue), `:67,72,389,735` (localStorage keys); `app/index.html:1686` (`value="20"`), `:1779–1781` (the dropdown), `:1801–1803` (custom offsets)
- issue #132 (2020-05-19) — the thickness reverting to 20 mm; `CHANGELOG.txt:215` — `v1.0.251: "Fixed Custom Z Plate thickness Bug"`; `v1.0.215: "Fixed bug with Z Plate retract where plate is thicker than 10mm"`

**Direction-of-error confirmation:**
- <https://community.carbide3d.com/t/configuration-for-the-bitprobe-v2-thickness/45548> — *"This puts the reference zero surface 0.1mm above the actual surface the probe was sitting on"*, *"the virtual zero surface is now above the actual surface"*
- <https://forum.onefinitycnc.com/t/touch-probe-settings/4949> — checked for the same claim; **nobody in that thread states a direction**, recorded so it is not cited as if they did.

**In-repo, read at the artefact:** `core/src/types.rs`, `core/src/post_grblhal.rs`,
`core/src/fixtures.rs`, `gates/slicer_gate_check.mjs`, `web/src/touchplates.ts`,
`docs/touchplate-research.md`, `TODO.md` §#40 §#43.
