# UI honesty audit — what the browser asserts that the core does not

**Scope:** `web/src/**` and `web/e2e/**`, 2026-08-10. Read-only audit; nothing outside this
file was changed.

**The standing rule being audited** (`AGENTS.md`, `web/src/cam.ts:3-6`, `App.tsx:3515-3521`):
the core answers machining questions and the UI passes the answer through verbatim.
*"Describing a tool here would be the third time this app re-derived a machining fact in
TypeScript."* The collet check was computed in the UI once and was wrong; the sheet-fit rule
was computed in the UI once and was orientation-blind.

## What was run, and what could not be

| | |
|---|---|
| ✅ ran | `2bee-slice recommend … --material <m> --json` — six materials, real feeds |
| ✅ ran | `2bee-slice report plate --config <json>` with `z_zero_at_top` true vs false, diffed |
| ✅ read | every `.ts`/`.tsx` under `web/src/`, both e2e spec files, the core modules each finding touches |
| 🔴 **could not run** | **the browser suite.** Chromium cannot create a WebGL context on this box (`GL_VENDOR = Disabled`), so **every claim below about `web/e2e/**` is read from the source, never observed.** Where a test is cited as passing or failing, that is a reading of its assertions, not a run. |

Findings are ranked by whether a wrong number could reach a decision about a cut.

---

## The three most likely to mislead an operator standing at the machine

### 1. 🔴 The Z-zero datum control is inert on the browser path

**The finding, in full: the Z-zero datum control is inert on the browser path — and the gate
that exists for exactly this defect tests a different mechanism.**

**A setting that changes where the machine thinks the top of the world is, written by the
browser, persisted, restored, named in the restore banner, asserted by a browser test — and
read by no planner and no post.**

| | |
|---|---|
| control | `web/src/App.tsx:2819-2827` — `Z zero on stock top (else spoilboard)`, no note attached |
| second surface | `web/src/App.tsx:2694` — a saved workpiece renders `Z zero: stock top` / `spoilboard` as one of its properties |
| third surface | `web/src/touchplates.ts:659-691` — catalogue entry `bed-datum-no-plate`, *"No plate — zero Z on the spoilboard … it is this repo's own `Stock::z_zero_at_top = false`, listed in the picker so it sits beside the plates rather than hiding in a checkbox"* |
| sent | `web/src/App.tsx:1145` — `stock: { z_zero_at_top: zZeroTop }` |
| persisted | `web/src/store.ts:272`, `web/src/store.ts:377` |
| received | `core/src/fixtures.rs:1259`, `core/src/fixtures.rs:1472` (`set!(d.z_zero_at_top, st.z_zero_at_top)`) → `core/src/types.rs:532` |
| **read by** | **nothing.** `grep -rn z_zero_at_top core/ wasm/ cli/` returns the declaration, the default (`core/src/types.rs:553`), the config field and the setter. No planner, no toolpath, no post, no simulation reads it. |

**Measured, not inferred** (this box, 2026-08-10):

```
2bee-slice report plate --config '{"stock":{"z_zero_at_top":true}}'   -> 523-line program
2bee-slice report plate --config '{"stock":{"z_zero_at_top":false}}'  -> byte-identical
```

The Z shift exists **only** as a CLI flag: `cli/src/main.rs:1092` sets
`PostOptions.z_offset_mm = stock.thickness_mm` when `--spoilboard-zero` is passed. The
browser's path never constructs that field — `core/src/fixtures.rs:2708` posts with
`PostOptions { program_name, ..Default::default() }`, and `z_offset_mm` defaults to `0.0`
(`core/src/post_grblhal.rs:34`). `grep -rn "PostOptions\|z_offset" wasm/src/lib.rs` is empty.

**Why the gate does not catch it.** `SLICER-GATES.md:97` / `gates/slicer_gate_check.mjs:87`
declare **G11 — "Z-ZERO SETTING BITES", HARD, *"a setting consumed by nothing reads as
configured"***. The gate body (`gates/slicer_gate_check.mjs:368-386`) runs
`fixture rect-profile` against `fixture rect-profile --spoilboard-zero` and asserts every Z
word shifted by 18.0mm. **It exercises the CLI flag, which works. It never sends
`stock.z_zero_at_top` through the config path, which is the only path the browser has.** The
sibling gate that *does* drive the config path — `B2B4`, `gates/slicer_gate_check.mjs:1532-1573`
— covers `origin_x_mm`, `origin_y_mm` and `material`, and not this field. So the one gate
named for this defect is green, and the defect is live one mechanism to the left.

**The browser suite reinforces it rather than catching it.** `web/e2e/persistence.spec.ts:101`
unchecks `z-zero-top` and `:142` asserts it came back — a round trip through the *input box*.
The same file's next test (`:163-195`) is titled *"a restored setting reaches the EMITTED
PROGRAM, not just the input box"* and uses **`rpm` only**, because rpm lands as a single `S`
word. Z-zero is in the first test's list and not the second's.

**The physical failure.** An operator unchecks the box, zeroes Z on the spoilboard the way the
touch-plate entry tells them to, and runs a program whose every Z word is still measured from
the stock top. On 18mm ply a through cut at `Z-18.3` is executed 18mm lower than intended:
straight through the sheet, the spoilboard and into the table, at full depth on the first pass.
There is no note anywhere in the report — `grep` for a core note about the Z datum returns
nothing.

**The irony worth recording:** `core/src/job.rs:1049-1051`, in the commit that made *material*
and *datum* bite, says — *"Both of these were fields nothing read. A setting that is stored,
displayed, and consumed nowhere reads as configured and changes no coordinate — **the same
defect as a Z-datum option that moved no Z**."* The comparison it reaches for is still true.

---

### 2. 🔴 The tool row's feed is the *material-blind* formula, up to **4.3×** out

**The finding, in full: the tool row's feed is the *material-blind* formula the core
deliberately superseded — measured at up to **4.3×** the number the program carries.**

This is the one arithmetic the app already admits to (`App.tsx:3678-3683`, `:3769`, `:3788-3793`).
**The disclosure names the source and not the omission**, and the omission is the whole
machining content of the number.

```
App.tsx:3771   {Math.round(rpm * t.flutes * t.chipload_mm)} mm/min
App.tsx:3769   <span>Feed at {rpm} rpm, computed here</span>
App.tsx:3791   "…this panel's arithmetic over three of them (rpm × flutes × chipload)"
```

The core has **two** feed functions and the UI copied the wrong one:

| | |
|---|---|
| `core/src/feeds.rs:13` | `feed_from_chipload(t, rpm)` = `rpm × flutes × chipload` — material-blind, used by the fixture generator (`core/src/rect_profile.rs:163`) |
| `core/src/tools.rs:689-691` | **`feed_for(t, rpm, material)` = `rpm × flutes × chipload × material.chipload_factor()`** — what the real planner uses (`core/src/job.rs:1057`, `:1083`) and what `recommend` uses, further clamped by `machine.max_feed_mm_min` (`core/src/recommend.rs:540`) |

And before the feed is computed, `core/src/job.rs:1074-1083` **caps the rpm** at
`material.max_rpm()` and recomputes the feed from the capped value. The panel keeps showing the
operator's typed rpm in its own label.

**Measured on this box** — `2bee-slice recommend web/src/samples/hive-super-end.dxf --material <m> --collet 6 --json`,
feature `part1/outer`, against what the tool row would print for the 6mm 2-flute at 0.10 mm/tooth
with the app's default 18000 rpm typed in the Spindle box:

| material | core `feed_mm_min` | core `rpm` | UI tool row | UI over/under |
|---|---|---|---|---|
| Plywood *(the app's default)* | 4800 | 24000 | 3600 | agrees in spirit; the panel is not even reading the same rpm |
| Softwood | 5280 | 24000 | 3600 | **understates 0.68×** |
| Hardwood | 3840 | 24000 | 3600 | −6% |
| Acrylic | 2400 | 16000 | 3600 | **overstates 1.5×** |
| **Aluminium** | **840** | **12000** | **3600** | **overstates 4.29×** |

The default material is `Plywood` (`App.tsx:586`, factor 1.0), which is why nobody has noticed:
**the panel is only ever checked in the one material where the missing factor is 1.**

**Nothing would go red if this number were wrong.** `gates/slicer_gate_check.mjs:388-397` (G12)
asserts the emitted `F` word equals 3600 for the plywood fixture — correct, and blind to the
factor because the factor is 1 there. The browser suite asserts the *panel's own product* in
three places and never compares it to an `F` word anywhere:

- `web/e2e/slicer.spec.ts:260-268` — test titled *"feed is derived from the tool, not typed in"*,
  asserts `3600 mm/min` then `2400 mm/min` after changing rpm. Both are the UI's multiplication.
- `web/e2e/slicer.spec.ts:1590` and `:1639` — the same string asserted as a stability check.

`grep` for `F3600`, `F2400` or any `F`-word assertion across `web/e2e/` returns nothing. So the
suite **defends** the defect: correcting the row to the material-aware number turns three
browser tests red.

**The physical failure.** The tool row is where an operator sanity-checks a feed against their
own tables before pressing cycle-start. In aluminium it reads 3600 while the program runs 840 —
and an operator who "corrects" the machine's feed override up to what the panel says is feeding
a 6mm cutter into aluminium at 4.3× the rate the core refused to allow.

**The right fix is not a better comment.** `core/src/lib.rs:44` already re-exports
`feed_for`; it is not on the wasm boundary. Export it, or export the planned feed per tool on the
report, and delete the multiplication — the same move that killed the sheet-fit copy
(`App.tsx:2828-2835`) and the clearance copy (`cam.ts:867-881`).

---

### 3. 🔴 `uncut ≤ 20` renders **green**, on a threshold invented in TypeScript

```
App.tsx:4417   <b data-testid="sim-gouge"  className={report.sim.gouge     ? 'bad' : 'ok'}>
App.tsx:4421   <b data-testid="sim-uncut"  className={report.sim.uncut > 20 ? 'bad' : 'ok'}>
App.tsx:4425   <b data-testid="sim-spoil"  className={report.sim.spoilboard ? 'bad' : 'ok'}>
```

Gouge and spoilboard go red at 1. **Uncut gets a tolerance of 20 cells, and the 20 comes from
nowhere.** `SimCounts` (`cam.ts:167-173`) carries `cell_mm, gouge, uncut, spoilboard, first`
and no threshold; the core exports no acceptable-uncut figure anywhere.

The core has **already** applied the honest tolerance, one layer down. `core/src/sim.rs:453-476`
shrinks both region sets by one cell before testing, precisely because *"On a clean plate job
that was 2,696 'gouges' and 25 'uncut' cells — a check firing on every correct program, which is
a check that gets muted in a week."* After that fix a clean job reports **0**. The UI's `> 20`
is a second tolerance stacked on a tolerance that already exists — and it looks very much like
it was sized against the pre-fix `25`.

`core/src/sim.rs:362-366` is explicit about which direction is dangerous:
*"over-reporting removal is the SAFE error for a gouge and the **UNSAFE** one for an uncut
island; there is no single conservative direction here."* The UI gave the unsafe direction a
20-cell green band and the safe direction none.

**The physical failure.** Up to 20 cells of material the program did not remove — at the default
0.6mm cell, a contiguous strip roughly 12mm long — renders in the same green as a clean job,
with no note. On a profile cut that is an uncut web still joining the part to the sheet; the
operator lifts a part that is still attached, or the vacuum/tab release calculation is wrong.
`web/e2e/slicer.spec.ts:344-356` arms the *gouge* counter with a plant and asserts `> 100`;
**no test, plant or gate exercises the uncut counter at all**, so nobody has watched this band
go red.

---

## Full findings by dimension

### 1. Machining arithmetic in TypeScript

Complete inventory of every number `web/src/**` calculates rather than receives. "Core exports
it?" answers whether the value already exists on the other side of the wasm boundary.

| # | Where | What is computed | Core exports it? | Verdict |
|---|---|---|---|---|
| 1.1 | `App.tsx:3771` | **feed = rpm × flutes × chipload** | `feed_for()` exists (`tools.rs:689`), **not on the wasm boundary** | 🔴 **Finding 2** — wrong formula, up to 4.3× |
| 1.2 | `App.tsx:3718` | **collet fit** = `Math.abs(shank − collet) > 0.1` | ✅ **yes** — `ToolRow.fit`/`fit_why`/`selectable`, computed by `shank_fit()` (`tools.rs:888-915`) and already on this very row | 🔴 **Finding 4** below |
| 1.3 | `App.tsx:4421` | **uncut tolerance = 20 cells** | no threshold exists in the core | 🔴 **Finding 3** |
| 1.4 | `App.tsx:2564` | `Math.round((m.max_doc_ratio ?? 0) * 100)` → *"depth ≤ N% of the cutter"* | the ratio is the core's; the **`?? 0` is not** | 🟡 a material row missing the field renders *"depth ≤ 0% of the cutter"* — a fabricated machining limit in place of an absence. Elsewhere this app is rigorous that absent ≠ zero (`cam.ts:596-604`, `store.ts:365-370`) |
| 1.5 | ~~`App.tsx:112`~~ | ~~`TOOL_CHANGE_SECONDS = 60`~~ | ✅ `core/src/job.rs:299` — **now on the wire** | ✅ **CLOSED 2026-08-11 (`#90`) — the constant is DELETED.** See the correction under this table |
| 1.6 | `App.tsx:1774-1813` | playback timeline: `sec = distance / (feed / 60)` | the core's own estimate uses the same arithmetic on the emitted text | ✅ **sanctioned** — `cam.ts:66-71` writes this formula out deliberately; untimed moves are counted and printed (`App.tsx:4297-4306`) rather than charged a guessed rate |
| 1.7 | `App.tsx:4460` | `report.gcode.split('\n').length - 1` | no | 🟢 cosmetic; off by one on a program with no trailing newline |
| 1.8 | `App.tsx:1470`, `:1495` | bytes → kB | no | 🟢 not a machining number |
| 1.9 | `Viewport.tsx:1404-1412` | **`clearGap()`** — clear distance between two footprints | ✅ **yes** — `Clearance`/`clearanceFor`/`checkLayout` (`cam.ts:876-1110`), whose doc says in as many words *"`required_mm` is the CORE's number. Do not compute it."* | 🟡 **dead today** — gated on `cfg.required !== null`, and no caller passes `clearance` to the viewport (verified: no `clearance=` prop at `App.tsx:3958-4126`). It is a live TS clearance rule the day someone wires the prop, and it measures **bounding rectangles**, not boundaries |
| 1.10 | `Viewport.tsx:673-692` | bulge → arc tessellation (`4·atan(t)`, chord, radius, sagitta step) | the identity is published for this purpose in `cam.ts:105-110` | ✅ sanctioned; tolerance is stated on screen (`Viewport.tsx:4034`) |
| 1.11 | `Viewport.tsx:953` | `TOOL_FACET_SCALE = 1/cos(π/12)` | no | ✅ correct direction and says so — the drawn envelope is **oversize**, never undersize, and the percentage is printed in the hover (`Viewport.tsx:2120`) |
| 1.12 | `Viewport.tsx:961`, `:968`, `:975` | `TOOL_SHANK_DISPLAY_MM = 25`, `unstatedFlute = max(2·dia, 10)`, refusal cage `14×40` | no — overall length is not in the tool record | ✅ display lengths, drawn with a torn end and labelled as never a measurement |
| 1.13 | `toolShape.tsx:190-245` | **category → tip geometry**; cone height `= r / tan(θ/2)` | the core exports the angles and `is_angular()`; **it exports no tip model** | 🟡 a machining shape derived in TS. It is cross-checked against the core's `is_angular` *subtractively* (`Viewport.tsx:1029-1033` — the check can only remove a claim, never add one), which is the right shape of guard. But the drawn envelope is what `Viewport.tsx:2120` invites the operator to judge clearance by eye from, and nothing gates it |
| 1.14 | `Viewport.tsx:1338-1341`, `:1449-1454` | drag quantisation to 0.1mm / grid, biased away from a neighbour | no | ✅ documented, and the **snapped** value is what reaches the field — no tidy display over an untidy datum |

> ✅ **CORRECTION 2026-08-11 — row 1.5 was stale, and it was stale in the direction that costs most.**
> This audit is a dated measurement, not a standing fact, and a 🟡 that has been fixed reads exactly like
> a 🟡 that has not: nobody re-reads a row that already admits it is uncovered.
>
> **What the row said, and why each half is now wrong.** *"Named, disclosed, and the drift is printed on
> screen. **Verified still equal today.**"* — `App.tsx` held `const TOOL_CHANGE_SECONDS = 60`, a hand-copy
> of a core constant, and the two agreed on the day this was written.
>
> 🔴 **They had stopped agreeing before the row was actioned.** The core moved to a declared
> `Machine::tool_change_seconds` defaulting to **120**; the browser still charged **60**, so the playback
> clock under-read by a minute per tool change against the estimate printed beside it — and the bar's
> *"difference between the playback clock and the estimate"* line rendered that gap under the label for
> the `G4` dwell and the `G38.2` probe. **A real drift wearing an expected one's name**, which is worse
> than an undisclosed one.
>
> **What closed it: the DELETION, not a re-sync.** The row's own remedy — *"a `Report` field would end
> it"* — is what happened: `Report.tool_change_seconds` and `Report.tool_change_rate_declared` are on the
> wire, `App.tsx` reads the rate off the report, and **absence is `?? 0`, never a fallback number.** The
> comment left where the constant stood argues against putting a plausible literal back, and
> `tests/config-wiring.test.ts` fails if one is declared again.
>
> ⚠ **The general lesson this row is the instance of:** *"verified still equal today"* is a claim with an
> expiry date and no mechanism to enforce it. Two numbers that must agree either share one source or
> drift; a comment noting that they currently match is not a control, and the audit row that recorded the
> match is the thing that made the drift look supervised.

**One structural note.** `web/src/cam.ts` itself is clean: it loads, forwards and types, and
every doc comment on it is a correct description of the core's behaviour. Nothing in this
finding class lives in the bridge; it all lives in the panels.

### 2. Controls that are accepted and ignored

Every field the browser puts in `JobConfig` (`App.tsx:1121-1192`) was traced to a core consumer.
`core/src/fixtures.rs` uses `#[serde(deny_unknown_fields)]` on every config struct, so a
misspelled key errors rather than vanishing — the failure mode here can only be a key the core
accepts and then does not read.

| field | core consumer | |
|---|---|---|
| `travel_x/y/z_mm`, `safe_z_mm` | `post_grblhal.rs:177`, limit checks | ✅ |
| `collet_mm` | `tools.rs:888` | ✅ |
| `spindle_max_rpm` | `recommend.rs:527`, `post_grblhal.rs:888` | ✅ |
| `probe_enabled`, `touch_plate_mm` | `post_grblhal.rs:800-815` | ✅ |
| `supports_arcs` | `post_grblhal.rs:1034` | ✅ |
| `size_x/y_mm`, `thickness_mm`, `origin_x/y_mm`, `rotation_deg` | placement, sim, limit check | ✅ |
| **`z_zero_at_top`** | **none** | 🔴 **Finding 1** |
| `material` | `job.rs:1053-1083` | ✅ |
| `clamps`, `confirmed_clear` | fixture check | ✅ |
| `tool_id` / `tool_ids`, `extra_tools` | `job.rs`, `recommend.rs` | ✅ |
| `probe_after_toolchange` | `job.rs:1190` | ✅ |
| `depth_per_pass_mm`, `rpm` | `job.rs:1056-1083` (both **capped** by material, with a note) | ✅ |
| `entry` | `toolpath.rs:263-276` | ✅ (see 2.2) |
| `direction` | `toolpath.rs:374` | ✅ |
| `dogbone` | `toolpath.rs`, `types.rs:732` | ✅ |
| `finish_allowance_mm` | `pocket.rs:109`, `toolpath.rs:353` | ✅ |
| `lead_mm` | `toolpath.rs:603` | ✅ |
| `tabs_enabled`, `tab_height_mm`, `tab_width_mm`, `tab_min_spacing_mm` | `fixtures.rs:1678-1682` → `toolpath.rs:507`, `:546` | ✅ |
| `drawing_offset` (fixtures only) | `Job::place` | ✅ |

**2.1 — `z_zero_at_top` is the only one.** Enumeration complete: 29 of 30 config fields reach a
core reader.

**2.2 — `Entry: Helix` is offered as a peer of two modes that work** (`App.tsx:3822-3826`).
Selecting it always produces a refusal and zero G-code (`toolpath.rs:266-275` — a *good*
refusal, it names Ramp and Plunge as the cure). But the select gives it no marker, while this
app's own tool picker disables an unusable row and attaches the core's reason
(`App.tsx:3551-3552`). The operator discovers it by losing their program.

**2.3 — `showRapids`** (`App.tsx:672`) is `useState(true)` with no setter and is still passed to
the viewport. Documented at `App.tsx:4181-4184` as deliberate (deleting the state would turn
rapids on permanently). Not a control; no finding.

**2.4 — viewport layer toggles** (`Viewport.tsx:1564-1569`) are drawing-only and say so on the
canvas whenever anything is hidden (`Viewport.tsx:4247-4263`), with a dedicated louder line for
hidden clamps (`:4225-4241`). ✅ this is the pattern the rest of the app should be measured
against.

### 3. Labels that overstate

**3.1 🟡 `t.fit_why || 'fits the collet in the spindle'`** — `App.tsx:3561` (picker properties)
and `App.tsx:3768` (tool row). The `||` cannot distinguish two different facts. `ShankFit::why()`
(`core/src/tools.rs:875-885`) returns **an empty string for `Fitted`**, so the fallback is
*correct while the field is present*. `ToolRow.fit_why` is **optional** in the TS interface
(`cam.ts:529`) precisely because an older core may not emit it — and in that case every tool in
the library renders the sentence *"fits the collet in the spindle"* about a check that never
ran. The neighbouring field states this app's own rule for exactly this case
(`cam.ts:540-545`, on `flute_type`): *"absent means not stated, which anything drawing a cutter
must render as unstated rather than as straight."*

**3.2 🟡 `Status: runnable`, in green** (`App.tsx:4390-4391`). `report.ok` is the core's
`is_runnable()` (`core/src/job.rs:491-497`), which **excludes `FixtureFinding::Undeclared` from
blocking** — so a job with no work holding declared and nobody having confirmed the bed reads
`runnable` in the `ok` class at the top of the Summary. The qualifier is real but lives in a
different panel (`App.tsx:4439-4441`) and only when the Notes section is open. The word is the
core's; **the green is the UI's**, and the core exports no colour.

**3.3 🟡 `gapStatus` warn-branch text** (`Viewport.tsx:1547-1551`): *"…measured here between
bounding footprints while you drag. **The verdict is the core's** — it measures the real
boundaries, arcs included."* Two claims in one sentence about two different numbers: the number
on screen is `clearGap()`'s bounding-rectangle arithmetic (1.9 above), the verdict is the core's
at plan time. Dead today because no caller passes `clearance`; it becomes live and misleading
the moment the prop is wired. The `!clearance` branch (`:1532-1538`) is exemplary by contrast —
it names precisely which of two things it is waiting on.

**3.4 ✅ The labels the lane is careful about are genuinely careful.** Verified against the
data on every surface that draws them: the simulated surface is never *"the part"*
(`Viewport.tsx:4146-4151`, `cam.ts:175-194`); a decimated mesh says so on the canvas, not in a
hover (`Viewport.tsx:4100-4106`); the loaded solid is labelled the **input** with its section Z
in bold and `CHOSEN FOR YOU` in the warn colour when nobody picked it
(`App.tsx:3277-3295`); the walls layer says *"what the DRAWING asks for … square inside corners
no cutter can make"* (`Viewport.tsx:4123-4131`); the two empty states are two facts with two
different cures and neither reads as reassurance (`App.tsx:4330-4364`); the restore banner
refuses to say the setup is ready (`App.tsx:2066-2073`) and says *"Check them before you cut"*
(`App.tsx:2120`). **No instance of "safe", "verified", "OK to run" or "complete" was found
anywhere in `web/src/`.**

**3.5 🟢 Unmounted, so it misleads nobody today**, but recorded because it will be mounted:
`web/src/cad/preview.tsx:500` renders the verdict **`MESH AUDITED — watertight`** over a BSP
kernel whose own banner lists coplanar faces and near-degenerate geometry as known failure modes
(`web/src/cad/CadTab.tsx:64`). "Audited" and "watertight" are strong words for a closure check
on a kernel that is not a robust solid modeller. See §7.

### 4. Refusals the operator cannot act on

**4.1 🔴 The collet warning names a cure that may not exist, and contradicts the row above it.**

```
App.tsx:3718   const colletMismatch = Math.abs(t.shank_mm - colletMm) > 0.1;
App.tsx:3779   {colletMismatch && (
App.tsx:3781     {t.shank_mm} mm shank does not match the fitted {colletMm} mm collet.
App.tsx:3782     A collet change is needed before this tool can be run.
```

The core answers this in **four** states (`core/src/tools.rs:854-915`), and the UI collapses
them to a boolean against the *fitted* collet alone, ignoring the spares it passed in one call
earlier (`App.tsx:906`, `SPARE_COLLETS_MM` at `App.tsx:74`):

| core verdict | core `fit_why` (rendered two lines above, `App.tsx:3768`) | what the UI warning says |
|---|---|---|
| `Fitted` | `""` | no warning ✅ |
| `NeedsCollet { collet_mm }` | *"needs the 8mm collet fitted"* — **names which one** | *"a collet change is needed"* — drops the one fact that makes it actionable |
| `None { why }` | *"12mm shank; the shop's collets are 6mm, 8mm"* | 🔴 ***"A collet change is needed before this tool can be run"* — there is no collet to change to.** The cure does not exist |
| `Undeclared` | *"the machine has not declared a collet, so this is UNCHECKED"* | 🔴 with `colletMm` unset, `abs(shank − 0) > 0.1` is true for every tool → **unchecked renders as a definite mismatch on the whole library** |

The `None` row is normally unreachable because the picker disables it
(`App.tsx:3551`, `selectable === false`) — but only when the core emits `selectable`, and a row
restored or imported through `extraTools` is not filtered the same way. The two sentences sit
two lines apart in the same card, disagreeing.

**4.2 🟡 *"must be drilled or interpolated"* — interpolation is not implemented.**
`web/src/samples/index.ts:61-63` describes the `Metal nest A1` sample: *"The planner refuses
them by name and says they must be drilled or interpolated."* This is **UI-authored copy**, and
it repeats the core's own refusal (`core/src/toolpath.rs:776-789`, `core/src/fixtures.rs:929`).
There is no interpolation anywhere in the engine — `core/src/recommend.rs:587` says *"it cannot
interpolate a bore"* and `core/src/recommend.rs:688` *"interpolation: no helix, full width of
cut, all of it on the tool tip"*. Half the cure is real (fit a drill, or a smaller cutter); half
names a capability the tool does not have and is not getting. The core-side wording is the root
and belongs in a core ticket; **the UI copy is this lane's own and repeats it without the
caveat.** Contrast `core/src/toolpath.rs:269-272`, which is the model: *"Use Ramp (the default)
or Plunge"* — a cure the tool actually offers.

**4.3 ✅ The rest of the refusal surface is good.** `App.tsx:3696-3714` names a selected tool the
library does not hold rather than dropping the row; `App.tsx:3639-3646` and `:4333-4351` refuse to
plan without a cutter **and say the refusal is browser-only and the core still substitutes**;
`Viewport.tsx:1013-1018` and `:1045-1048` refuse a tool tip in the picture's own terms rather
than a shared fragment that reads as gibberish in one of them.

### 5. State that survives when it should not

**5.1 ✅ Nothing that means "a human verified this" has crept into the persisted set.**
`store.ts:154-174` lists five deliberate exclusions with a reason each — `confirmedClear`
(the attestation), `plant`, `job`, `sectionZ`, `extraTools` — and the code matches: `RULES`
(`store.ts:357-415`) has no key for any of them, `App.tsx:637` initialises `confirmedClear` to
`false` unconditionally, and `web/e2e/persistence.spec.ts:122` / `:156` arm the negative
(tick it, reload, assert it is off). The banner repeats it every time (`App.tsx:2151-2156`).

**5.2 🟡 The one residual, already reasoned and worth restating.** `clamps` and `workholdingId`
**do** persist (`store.ts:288-289`, `:407-408`). Clamp rectangles are gate P7's keepout — a
claim about where steel is bolted to a physical bed — and after a restore the Work-holding panel
is indistinguishable from one declared in this session. The store's own argument is sound
(*"The clamp geometry comes back so it does not have to be retyped; the statement that a human
looked does not"*) and the asymmetry is defensible, because a stale clamp produces a **false
red** (a refusal) and not a false green. Recorded, not raised.

**5.3 🟡 One persisted setting is inert** — `zZeroTop` (Finding 1). It is counted in the
`N settings restored` line (`App.tsx:2113-2121`) and listed under *What came back*
(`App.tsx:2144-2147`), so the banner asserts a datum convention came back that never went
anywhere.

**5.4 ✅ Version discipline.** `SESSION_VERSION = 2` with a bump that restores **nothing**
(`store.ts:190-202`), and the residual — that nothing enforces the bump — is named at
`store.ts:180-189` rather than papered over.

### 6. Accessibility where it carries meaning

**6.1 🔴 The scrubber has no accessible name.** `App.tsx:4160-4168` — a bare
`<input type="range">` with `data-testid="scrubber"` and no `<label>`, `aria-label` or
`aria-labelledby`. It is announced as an unnamed slider with a value between 0 and 1. It is the
control that decides which part of the program is on screen, sitting between a play button that
*does* carry a name (`App.tsx:4208`, `.sr`) and a speed group that carries one
(`App.tsx:4210`). Every other numeric control in the app is correctly named through the `Num`
wrapper's implicit label (`App.tsx:229-232`).

**6.2 🟡 `aria-hidden` on the program map, which carries the only summary of program
composition.** `App.tsx:4145-4150` — the coloured run map is `aria-hidden="true"` **and** carries
a `title` explaining that width is move count and not time. Both the summary and its one
important caveat are unreachable to assistive tech. The 2bee pattern for this is right next door
in `ObjectPicker.tsx:1155-1160`: *"No `aria-hidden`: on this panel the shape is a primary
description of the object, so it keeps the `role="img"` and `aria-label`."*

**6.3 ✅ `pointerEvents` audit of the viewport overlay — clean, and armed.** Every interactive
element in the overlay column was checked individually:

| element | `pointerEvents` | |
|---|---|---|
| overlay column (`Viewport.tsx:3961-3973`) | `'none'` | ✅ load-bearing; the note at `:3943-3960` records the 15.35px→−36.4px regression that produced the rule |
| `move-classes` row (`:3975-3987`) | `'auto'` on the row | ⚠ a full-width shield over a strip of canvas its ~250px of buttons never occupy — named as a residual at `:3910-3916`, and the reason `chip` puts it on the button instead |
| every chip: `kind-*`, `kinds-all-on/off`, `snap-grid-*`, `snap-edges` (`:3925`) | `'auto'` via `chip` | ✅ |
| `snap-controls` row (`:4158-4161`) | inherits `'none'` | ✅ **correct** — this is the row that shipped broken (`:3899-3908`: rendered, styled enabled, reported `aria-pressed`, `elementFromPoint` returned the canvas) and the fix is on the chips |
| `gap-status`, `snap-readout`, `loaded-*`, `walls-*`, `result-*` spans | inherits `'none'` | ✅ text |
| `clamps-hidden`, `hidden-indicator` (`:4225`, `:4247`) | inherits `'none'` | ✅ non-interactive |
| `hover-panel` (`:4266-4284`) | `'none'` | ✅ with the reason (a panel that eats its own hover flickers) |

The residual named at `Viewport.tsx:3918-3924` is real and unclosed: **a control is a shield over
its own box**, this column grows, and the only thing that would catch the next collision is the
`elementFromPoint`-before-drag assertion in one e2e test — which cannot run on this box.

**6.4 🟢 Vacuous predicate.** `Viewport.tsx:4023` — `disabled={!liveLayers.includes(k)}` inside
`liveLayers.map((k) => …)` is always `false`; likewise the ternaries at `:4050-4051`. Dead, not
wrong.

**6.5 🟡 Pointer-only surface.** The 3D hover readout (`Viewport.tsx:4266-4301`) — which reports
the object under the pointer, including the tool marker's own account of what it does and does
not assert — has no keyboard equivalent. Every *mutating* 3D affordance does have one (sheet
rotate → `App.tsx:2789-2818`; sheet datum → `origin-x/y`; part placement → `part-x/y`; clamps →
`clamp-N-x/y`), so nothing is unreachable — but the explanatory surface is mouse-only.

### 7. `web/e2e/**` — audited by nobody else, so: findings

🔴 **None of this was run.** Chromium cannot create a WebGL context here. Everything below is
read from the assertions.

**7.1 🔴 Three tests pin the UI's feed arithmetic; none pins an `F` word.**
`slicer.spec.ts:260-268` (*"feed is derived from the tool, not typed in"*), `:1590`, `:1639`.
The suite would go red on a correction and stays green on the defect. See Finding 2.

**7.2 🔴 `dev-server.spec.ts:39-41`'s positive control no longer selects the control it
describes.** The comment says *"a control that only exists once the core has answered"*, and the
locator is `page.locator('select').first()`. The Job selector — which *was* that control — is now
behind `?fixtures=1` (`App.tsx:1991`), and this test opens the bare URL. The first `<select>` on
the default page is `stock-rotation` (`App.tsx:2789`): **four hardcoded options that render
whether or not the core ever answered.** The load-failure path is still caught (a rejected
`loadCam()` sets `loadError` and renders only the fatal screen, `App.tsx:1961-1969`), but a
**hung** load — no rejection, no timeout anywhere in `App.tsx:889-934` — leaves `ready === false`,
`loadError === null`, the full UI painted and this test green. This is the one test in the
directory whose entire purpose is to catch a dead core in dev.

**7.3 🟡 `dev-server.spec.ts:19` hardcodes `http://127.0.0.1:5179`.** The founder's dev server is
on **5178**. This fails loudly rather than silently, so it is a note, not a defect — but the
port is a literal in a file whose subject is "the server a developer actually opens".

**7.4 🟡 Test titles are written as the defect they refute**, e.g. *"a tool no collet in the
shop can hold **is committed anyway**, and the spindle is handed a cutter it cannot grip"*
(`:1581`), *"the list **cannot be** driven from the keyboard"* (`:1642`), *"the coloured bar
**claims a program when there is none**"* (`:1926`). The bodies assert the opposite. Anyone
reading a CI summary or a `--list` of test names reads a list of live defects. The gate table
(`gates/slicer_gate_check.mjs:99-124`) has the same convention and gets away with it because the
third column is explicitly *what this guards*; the test titles have no such column.

**7.5 ✅ What the suite does well, and it is a lot.** `:1609-1615` forces a click through
`aria-disabled` **because Playwright's actionability would otherwise wait instead of clicking and
the test would pass having exercised nothing** — a negative control that knows how it could be
vacuous. `:1595-1598` uses the ARIA attribute rather than `toBeDisabled()`, naming the matcher's
trap. `:1508-1518` refuses to pin the library size and pins the *rule* across two states, with
both non-zero preconditions asserted first. `:322-328` asserts the state rather than the
element's text so a disappearing panel cannot read as a stuck warning. `:3990-3994` (cited from
`App.tsx`) asserts `elementFromPoint` at the rotate handle **before** dragging, so a covered
handle cannot masquerade as broken rotation arithmetic again.

### 8. Not a UI-honesty finding, but found on the way

**8.1 `web/src/cad/` — 4,124 lines with no importer.** `CadTab.tsx` (314), `scad.ts` (1661),
`mesh.ts` (1580), `preview.tsx` (569): an OpenSCAD-subset parser, a BSP boolean kernel with a
closure audit, and a three.js preview. `grep -rn CadTab web/src web/e2e` returns only its own
definition and default export. `main.tsx` renders `App`, and `App.tsx` never mentions it. It is
unreachable from the running app, untested by either spec file, and invisible to `cargo test` and
to every gate. `TODO.md:31` marks #12 *"⬜ open, multi-month"* and `TODO.md:192` marks #11
(the tabs) *"⬜ open"* — so the row is not *wrong*, but "built and unreachable" is neither open
nor done, and `AGENTS.md`'s own rule applies: **a stale 🔴 is as expensive as a stale ✅.** Its
`NOT_BUILT` banner (`CadTab.tsx:63-70`) is honest and thorough; §3.5 above is the one line in it
worth re-reading before it is mounted.

**8.2 `core/src/fixtures.rs:1656-1657`** — an unrecognised `direction` string falls through to
`Climb` rather than erroring, and the same shape appears for the other enums. The browser cannot
produce one (`store.ts:397-399` bounds all three to what the selects offer, and
`deny_unknown_fields` covers the key), so this is reachable only from a hand-written config on
the CLI. Core ticket, not a UI finding.

**8.3 The header still reads `2bee.slicer`** (`App.tsx:1986`) and the AGPL §13 source link points
at `github.com/2bee-farm/2bee.slicer` (`App.tsx:4480`), in a directory renamed to `2bee.app` on
2026-08-09. Naming, not honesty; noted because the §13 offer must resolve.

---

### Summary table

| # | Finding | File | Class | Rank |
|---|---|---|---|---|
| 1 | Z-zero datum setting reaches no Z word; gate G11 tests the CLI flag instead | `App.tsx:2819`, `:1145`, `store.ts:377`, `gates/slicer_gate_check.mjs:368` | ignored control | 🔴 1 |
| 2 | Tool-row feed uses the material-blind formula and the uncapped rpm — measured 4.29× in aluminium | `App.tsx:3771` | TS arithmetic | 🔴 2 |
| 3 | `uncut ≤ 20` renders green on a threshold invented in the UI | `App.tsx:4421` | TS arithmetic | 🔴 3 |
| 4 | Collet fit re-derived in TS; names a cure that may not exist; "unchecked" renders as "mismatch" | `App.tsx:3718`, `:3779` | TS arithmetic + refusal | 🔴 4 |
| 5 | `fit_why \|\| 'fits the collet in the spindle'` — an absent field reads as a pass | `App.tsx:3561`, `:3768` | overstating label | 🟡 |
| 6 | Sample copy names *interpolation* as a cure; nothing in the engine interpolates | `samples/index.ts:61` | refusal | 🟡 |
| 7 | Scrubber has no accessible name | `App.tsx:4160` | a11y | 🟡 |
| 8 | Program map `aria-hidden` with its caveat in an unreachable `title` | `App.tsx:4145` | a11y | 🟡 |
| 9 | `dev-server` positive control is satisfied by a static select | `e2e/dev-server.spec.ts:39` | e2e | 🟡 |
| 10 | Three e2e tests pin the UI's feed arithmetic; none pins an `F` word | `e2e/slicer.spec.ts:260`, `:1590`, `:1639` | e2e | 🟡 |
| 11 | `clearGap()` — a TS clearance rule, dead only because no caller wires the prop | `Viewport.tsx:1404` | TS arithmetic | 🟡 |
| 12 | `gapStatus` warn text claims the core's verdict over the UI's rectangle measure | `Viewport.tsx:1549` | overstating label | 🟡 |
| 13 | `Status: runnable` in green with work holding undeclared | `App.tsx:4390` | overstating label | 🟡 |
| 14 | `max_doc_ratio ?? 0` prints *"depth ≤ 0% of the cutter"* for a missing field | `App.tsx:2564` | TS arithmetic | 🟡 |
| 15 | `Entry: Helix` offered as a peer of two working modes; always refuses | `App.tsx:3824` | ignored control | 🟡 |
| 16 | `web/src/cad/` — 4,124 lines, no importer, no test, no gate | `web/src/cad/**` | unreachable | 🟢 |

**Verdict.** The bridge (`cam.ts`) is clean and the discipline is real: layer toggles, the
restore banner, the two empty states, the mesh section note, the tool-marker refusals and the
`pointerEvents` handling are all better than the standard they are held to. **Every one of the
four red findings is a place where the copy of a core answer was made *before* the core exported
it, and nobody went back when it did** — the same shape as the stale `Clearance` comment at
`Viewport.tsx:1496-1509`, which was caught only because someone re-measured a 🔴 they had no
reason to doubt.
