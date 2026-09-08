# The spoilboard declaration versus the machine it is declared on

**An audit. Nothing in this pass changed a line of code.** Every number below was produced by
running the shipped code, not by reading a type and reasoning about it.

---

## 0. What I measured, and when — because this tree moved under me

The spoilboard work is live. `core/src/types.rs` was last written at **22:06** while I was reading
it; `web/src/App.tsx` at **22:10**. Half-way through this audit the thickness fix landed in the
working tree, which changed the answer to section 6 from *"the model cannot express the question"*
to *"the model expresses it and nothing reads the answer yet"*. A measurement that does not name its
artefact is worthless here, so:

| Artefact | Identity |
|---|---|
| git HEAD | `f7ea9459e8` |
| Snapshot taken | `2026-08-10T22:07:14+10:00` (working tree, **uncommitted changes included**) |
| `core/src/types.rs` | sha256 `8af0e2812ce9f5c66135b8a8f3276d167b275412c56a640eeadbb101428ea2d5` |
| `core/src/spoilboards.rs` | sha256 `228e029f2bd5640f7afa1b1dc8f12aae4f078e9a643103589f095ecb0e708f39` |
| `core/src/sim.rs` | sha256 `b1b67c2e48a555489a435cbaaaeeefac410e6e2dacf3bd60ae3f503270d8c010` |
| `core/src/fixtures.rs` | sha256 `63796a10a653a498830f48168827b5cca49d0ccb438788dbfb06079736374b80` |
| `web/src/App.tsx` | sha256 `b93880281387fd791283dd9d03b932ecaac7d921773c1c296bd202886a5224a4` |
| `web/src/store.ts` | sha256 `cde31141cd3909efc435cde0e6f2503f1ca5317e1da3ca96ab3ca580262042fa` |
| `web/src/Viewport.tsx` | sha256 `9481333b7eebd37ed0f97d1e80de3f85288b61da034eb4f5d5c58d4f011eb0df` |

**All `core/`, `cli/` line numbers below are line numbers in that snapshot**, which I copied to the
scratchpad and built with its own `CARGO_TARGET_DIR` so nothing raced the lane's `target/`.
`web/` line numbers are from the files as hashed above and **will have moved** — every one is quoted
so it can be found by text.

Two hosts were used, deliberately:

* **the CLI**, `2bee-slice report|job <fixture> --config <file>`, built from the pinned snapshot;
* **the browser's own wasm** — `web/src/wasm/twobee_cam_wasm.js` imported into `node` and driven
  through `plan()`, the same entry point `web/src/cam.ts` calls.

Where a question touches what the operator sees, I ran it through both. **They agreed on every
case I put to both of them**, digit for digit — including the two arithmetic defects below, so
neither is a CLI-only artefact.

Everything the browser does that has no wasm behind it — the machine picker, the auto-fit, the
provenance flag — was read at the source and is reported as a code finding with the code quoted,
because there is no headless way to click a React picker and I did not want to report a
Playwright transcript as a measurement.

---

## Findings, ranked by what they do at the machine

| # | Finding | Verdict | Direction when it fails |
|---|---|---|---|
| 1 | A board survives a machine change with its corner, its provenance and its coverage verdict intact | **UNCHECKED** | 🔴 over-declares — reaches the machine |
| 2 | The position limb says CHECKED / 0 when not one cell was tested against the board | **UNCHECKED** | 🔴 over-declares — a green nobody earned |
| 3 | Nothing anywhere compares the declared board to the travel envelope | **UNCHECKED** | 🔴 both; a corner typo is caught by nothing |
| 4 | A measured board cannot declare a thickness, so the new depth limb is dead for it | **UNCHECKED** | ✅ under-declares — loud PENDING |
| 5 | The catalogue's thickness is nominal, and nominal runs thick | **UNCHECKED** | 🔴 over-declares — the depth limb fires late |
| 6 | `bare_reach` reports strips longer than the axis they are on | **WRONG** | ✅ over-states bare — cosmetic false red |
| 7 | Zero travel makes `bare_reach` say "covers the whole reach" | **WRONG** | 🔴 over-declares — but barely reachable |
| 8 | Two doc comments state the Z residual's direction backwards | **WRONG** | ✅ over-warns |
| 9 | A browser refresh drops the board and says nothing | **UNCHECKED** | ✅ under-declares — silent |
| 10 | Auto-fit never places a board worse than it has to | **CORRECT** | — |
| 11 | The catalogue fit verdict is what it says it is, and UNKNOWN is unreachable-to-green | **CORRECT** | — |
| 12 | Both declaration forms refuse correctly, and a refusal draws and counts as no board | **CORRECT** | — |
| 13 | Absent / zero / undeclared survive the wasm boundary intact | **CORRECT** | — |
| 14 | `travel_z_mm` has no relationship to the board, and must not | **CORRECT** | — |

---

## 1. A board fitted to one machine follows you to the next one — UNCHECKED

**This is the one that puts a cutter in a frame.** The corner is in machine coordinates. Changing
the machine changes what those coordinates mean. The app lets you change the machine and does not
revalidate, refit, drop, or even mention the board.

### The code

`web/src/App.tsx`, the machine picker's `onChange`, preset branch:

```tsx
if (parsed.kind === 'preset') {
  const m = MACHINE_PRESETS.find((x) => x.name === parsed.name);
  if (!m) return;
  setTravelX(m.travel_x_mm);
  setTravelY(m.travel_y_mm);
  setTravelZ(m.travel_z_mm);
  return;
}
```

Three setters. No `setSpoilboardX`, no `setSpoilboardY`, no `setSpoilboardPos`. The three
`Num label="Travel X|Y|Z"` inputs beneath the picker are the same story — the operator can retype
the travel by hand and the board does not move or complain.

The row's own properties panel enumerates what a preset does **not** carry:

> `'What choosing it sets'` → *"Travel X, Y and Z — and nothing else. Collet, spindle max, touch
> plate and arc support stay as they are."*

The spoilboard is not in that sentence. It is the one item on the list whose *meaning* — not merely
its value — is bound to the machine that was set when it was typed.

### What it does, measured

A `MDF sheet 2400 x 1200 x 16mm` selected on a **Bellwether Lead 1250x670**. Selecting a board is
when it gets fitted (`App.tsx`, the picker `onChange`: *"AND SELECTING IS WHEN IT GETS FITTED"*),
and with no program loaded `fitSpoilboard` centres it in the travel envelope. Transcribing that
function's own `clamp`/`centreOn` into node:

```
fit 2400x1200 on Bellwether 1250x670 = [ -575, -265 ]
```

Now click **MakerSpace 6090** in the same picker. Travel becomes 600x900; the board declaration is
untouched. Through the **browser wasm**, `plan('plate', '', config, 0.6, 0)`:

```
A: board fitted for Bellwether, machine now 6090 ->
{"travel":[600,900,100],
 "sb":{"catalogue_id":null,"name":"MDF sheet 2400 x 1200 x 16mm (AU standard)",
       "x_mm":-575,"y_mm":-265,"size_x_mm":2400,"size_y_mm":1200},
 "bare":[0,0,0,0],"checked":true,"past":0,"below":0,"strike":false}

C: same declaration on the Bellwether it was fitted to ->
{"travel":[1250,670,100], ... "bare":[0,0,0,0],"checked":true,"past":0,"below":0,"strike":false}
```

`bare: [0,0,0,0]` on the 6090. The panel renders that string as, verbatim:

```tsx
: bare.every((v) => v === 0)
  ? 'none — the board covers the whole reach'
```

So a board whose corner is this app's arithmetic for a **different machine** reports, on the 6090,
that it covers every XY the cutter can reach. Nothing in `notes`, nothing in `refusals`, no change
of colour. The honest declaration for that 6090 — a real half-width board — is a loud red on the
same job:

```
B: the 6090 board honestly declared (250x900 @0,0) ->
{"bare":[0,350,0,0],"checked":true,"past":2204,"below":2204,"strike":true}
```

**2204 cells of "past the board's edge" become 0 with one click on a machine preset**, and the only
difference is a board declaration the app carried across a machine change without looking at it.

### The provenance flag does not save you

`spoilboardPos` (`'assumed' | 'entered'`) is the app's honesty mechanism: an assumed corner paints
the past-the-edge counter `warnval` rather than green, with the suffix `' (ASSUMED board)'`. It is
good, and it is not enough here, for two reasons:

1. **The dangerous permutation is `entered`.** An operator who measured the corner on machine A with
   a tape gets `entered`, which is exactly what happens when someone does the right thing. That flag
   survives the preset click untouched — `setSpoilboardPos` appears in the board picker, the two size
   fields, the two corner fields and the Re-fit button, and **nowhere in the machine picker**. So the
   counter renders plain green `0` for a corner a human measured on a machine that is no longer
   selected. The flag says "a person looked"; nothing records *what they looked at*.
2. **The ASSUMED banner starts describing a fit that is not in the fields.** `fit` is recomputed on
   every render against `report.travel`:

   ```tsx
   const fit = Number.isFinite(sizeX) && Number.isFinite(sizeY)
     ? fitSpoilboard(report?.render ?? [], sizeX, sizeY, mTravelX, mTravelY)
     : null;
   ```

   After the preset click, `fit` is the fit for the **new** machine while `spoilboardX`/`spoilboardY`
   still hold the corner from the **old** one. The banner then reads *"Position ASSUMED — this app
   fitted it… Rule used: centred in the travel envelope"* — a sentence describing an arithmetic that
   did not produce the two numbers above it.

### The guard exists. It has no caller.

`web/src/store.ts` implements precisely the right control, with the right reasoning, at `readSpoilboard`
(line 1168 in the hashed file):

> *"So the record carries the TRAVELS of the machine it was measured on, and `readSpoilboard` DROPS
> THE POSITION BY NAME when they differ… The failure is not an error message: it is a program that
> passes the spoilboard check because the board it was checked against is not where the board is."*

```
$ grep -rn "readSpoilboard" web/ --include=*.ts --include=*.tsx | grep -v node_modules
web/src/store.ts:1110:  * {@link readSpoilboard} DROPS THE POSITION BY NAME when they differ. The board
web/src/store.ts:1168: export function readSpoilboard(
web/tests/cad-record.test.ts:422:  const elsewhere = store.readSpoilboard(rec, [600, 900, 80], 5);
web/tests/cad-record.test.ts:431:  const sameMachine = store.readSpoilboard(rec, [1250, 670, 100], 5);
web/tests/cad-record.test.ts:439:  const noFingerprint = store.readSpoilboard({ ...rec, machine_travels_mm: undefined }, ...);
web/tests/cad-record.test.ts:445:  const noPosition = store.readSpoilboard({ ...rec, x: '', y: '' }, [600, 900, 80], 5);
```

**A definition, four test call sites, zero production callers.** The `spoilboards` IndexedDB
collection it reads is the same: `'spoilboards'` appears in `web/src/store.ts` at lines 33 and 57
(the store-name union and the store list) and **nowhere else in `web/src/`**. Nothing writes a
saved spoilboard and nothing loads one, so the fingerprint check has never run outside its test.

⚠ This is the lane's own recorded failure shape — *a guard built in the callee but never armed by
the caller reads as protected*. Reading `store.ts` gives a strong and entirely accurate impression
that carrying a board across machines is handled. It is handled in the one path nobody takes.

### What IS guarded, so the fix knows where not to go

Loading a **saved machine** (the `'saved'` branch of the same `onChange`) restores the board
*together with* that machine's travels:

```tsx
setTravelX(m.travelX); setTravelY(m.travelY); setTravelZ(m.travelZ);
…
setSpoilboardId(m.spoilboardId ?? '');
setSpoilboardX(m.spoilboardX ?? '');
setSpoilboardY(m.spoilboardY ?? '');
…
setSpoilboardPos(m.spoilboardPos === 'entered' ? 'entered' : 'assumed');
```

That is coherent — the board and the frame its corner is expressed in arrive as one record, and
`?? ''` correctly restores a pre-field machine as *no board declared* rather than inventing one.
**The hole is the preset row and the three travel inputs, not the saved-machine row.**

### Direction — a restored board on a different machine

🔴 **Over-declaring.** The persisted rectangle asserts *"there is sacrificial material here"* about a
machine it was never measured on. Whether that is true is uncorrelated with anything the app knows,
and the measured case above turns 2204 frame-strike cells into a silent zero.

**File/line:** `web/src/App.tsx:3268–3275` (preset branch), `:3271–3273` (travel setters),
`:1083` (`spoilboardPos` state), `web/src/store.ts:1168` (`readSpoilboard`, uncalled).

---

## 2. The position limb reports CHECKED and `0` when it tested nothing — UNCHECKED

Two limbs live in `core/src/sim.rs` and only one of them requires having compared something.

```rust
// core/src/sim.rs:652 — the POSITION limb
pub fn ran(&self) -> bool {
    self.declared
}

// core/src/sim.rs:834 — the DEPTH limb
pub fn ran(&self) -> bool {
    self.underside_z_mm.is_some() && self.cells_tested > 0
}
```

The depth limb's own doc says why the second form is the right one:

> *"It requires BOTH a floor and a cell that was tested against it — the `UncutCoverage` rule, not
> the `SpoilboardCoverage` rule, because a perfectly declared board the sheet does not overlap tests
> nothing and would otherwise report a clean zero."*

That sentence describes the position limb's behaviour, in the position limb's own file, and the
position limb still does it.

### Measured, one config, both limbs

`{"machine":{"travel_x_mm":600,"travel_y_mm":900,"spoilboard":{"catalogue_id":"mdf-1200x600-12","x_mm":2000,"y_mm":2000}}}`
— a real catalogue board declared at a corner 2000mm away from a 600×900 sheet at the origin. This
is what a mistyped corner, or a board carried from another machine (finding 1), looks like.

```
$ 2bee-slice job plate --config away.json
sim: cell=0.6mm gouge=0 uncut=0 spoilboard=0 below_sheet=over-spoilboard:0 past-spoilboard-edge:0 spoilboard-undeclared:0
sim board: board_depth=board-depth-unknown through_board=0 tested=0 thickness=12mm deepest_past=0.000mm
sim board: THROUGH-THE-BOARD NOT CHECKED ON THIS JOB — the spoilboard is declared with a thickness,
but NOT ONE SIMULATED CELL lies over it — the sheet's footprint and the board do not overlap in the
simulated area, so the check compared nothing. A depth limb with a floor and no cell to test against
it is the datum defect arriving from the other side: 0 cell(s) tested. Check the board's corner and
the sheet's origin are in the same frame.

$ 2bee-slice report plate --config away.json | jq -c '{bare, checked, past, pending, spoilnotes}'
{"bare":[600.0,0.0,900.0,0.0],"checked":true,"past":0,"pending":null,"notes":[]}
```

The depth limb catches the frame mismatch and names it in a sentence that tells the operator exactly
where to look. On the identical declaration the position limb reports
`spoilboard_position_checked: true`, `past_spoilboard_edge: 0`, `spoilboard_pending_reason: null`,
**and not one note**. The browser paints that as:

```tsx
report.sim.spoilboard_position_checked !== true ? 'pending'
  : (report.sim.past_spoilboard_edge ?? 0) > 0 ? 'bad'
  : spoilboardPos === 'assumed' ? 'warnval' : 'ok'
```

— i.e. **green `0`** on an `entered` corner. The panel's own comment beside that ternary says
*"`0` and `0` are the same three glyphs whether nobody asked or nothing reached the frame, and the
flag is the only thing that tells them apart."* The flag is `declared`, and `declared` cannot tell
them apart.

⚠ The `bare` field *is* loud here (`[600, 0, 900, 0]` — the whole reach bare on both minus axes,
rendered `warnval`). So the panel contains a contradiction: one row says the entire reach is bare
and the row that alarms says a clean checked zero. Nothing reconciles them.

### Direction — a limb that compared nothing

🔴 **Over-declaring.** A green from a limb that compared nothing is indistinguishable, on screen,
from a green from a limb that compared 1.5 million cells. This is the same defect the whole
`SpoilboardCoverage` type was built to fix, surviving in the coverage struct itself.

**File/line:** `core/src/sim.rs:652` (`SpoilboardCoverage::ran`), against `core/src/sim.rs:834`
(`SpoilboardDepth::ran`) in the same file. Rendered at `web/src/App.tsx` `data-testid="sim-past-spoil"`.

---

## 3. Nothing compares the board to the travel envelope — UNCHECKED

`SpoilboardCfg::resolve` (`core/src/fixtures.rs:1267`) takes no machine argument and cannot: it is
called from `JobConfig::apply` at `core/src/fixtures.rs:1583`, in the same pass that sets
`travel_x_mm`, and it validates the rectangle against **itself only** —
`Spoilboard::faults` (`core/src/types.rs:709`) checks non-finite and zero area, and stops.

Probed, `travel 600 x 900`, `report plate`:

| Board | `spoilboard_bare_reach` | `spoilboard_position_checked` | notes | `ok` |
|---|---|---|---|---|
| `x 500, 600x900` (half outside +X) | `[500, 0, 0, 0]` | `true` | none | `true` |
| `x 2000, 600x900` (wholly outside +X) | `[600, 0, 0, 0]` | `true` | none | `true` |
| `x -5000, 100x900` (wholly outside −X) | `[0, 5500, 0, 0]` | `true` | none | `true` |
| `x -100, 900x400` (bigger in X, smaller in Y) | `[0, 0, 0, 500]` | `true` | none | `true` |
| `x -250 y -250, 600x900` (negative corner) | `[0, 250, 0, 250]` | `true` | none | `true` |
| `x -1e12 y -1e12, 1e13 x 1e13` | `[0, 0, 0, 0]` | `true` | none | `true` |

Raw, for the two that matter:

```
B_wholly_outside_positive
{"ok":true,"bare":[600.0,0.0,0.0,0.0],"sim":{"spoilboard":0,"past":0,"checked":true,"pending":null},
 "sb":{"x":2000.0,"y":0.0,"sx":600.0,"sy":900.0},"sbnotes":[]}
C_wholly_outside_negative
{"ok":true,"bare":[0.0,5500.0,0.0,0.0],"sim":{"spoilboard":0,"past":0,"checked":true,"pending":null},
 "sb":{"x":-5000.0,"y":0.0,"sx":100.0,"sy":900.0},"sbnotes":[]}
```

**Nothing is refused, nothing is warned, and no note is emitted in any of these.** A board declared
entirely off the machine, and a 10-kilometre board, both resolve, install, and report
`spoilboard_position_checked: true`.

Two things follow.

* A **corner typo** — `2000` for `200`, a sign dropped, millimetres for centimetres — has no
  detector anywhere in this stack. The only symptom is the `bare_reach` row, which is advisory and
  which finding 2 shows is contradicted by the alarming row on the same panel.
* A **board larger than the whole travel envelope** is accepted with no comment. That is a designed-for
  case (`mdf-3600x1200-32`'s catalogue note says overhang is *"a useful, true answer"*), so it should
  not refuse — but there is no plausibility bound at all, and the direction a bound would protect is
  the one that matters: a board declared bigger than reality says "material here" about rail.

### Direction — an unbounded declared size

🔴 **Both, and unguarded in both.** Under-declaring costs a `bare_reach` strip nobody has to act on;
over-declaring is silent all the way to the spindle. The absence of any refusal means the operator's
only defence is reading four numbers on a panel.

**File/line:** `core/src/fixtures.rs:1267` (`resolve`, no machine parameter),
`core/src/fixtures.rs:1583` (`apply`, has the machine and does not use it),
`core/src/types.rs:709` (`faults`, rectangle-only).

---

## 4. A measured board cannot declare a thickness, so the new depth limb is dead for it — UNCHECKED

The depth limb landed during this audit and is good work: three named states, a `why_not()` that
runs even when the program went nowhere near the board, no invented floor. It needs
`Spoilboard::thickness_mm`, and there are exactly two ways a `Spoilboard` is ever constructed:

* `SpoilboardSpec::install_at` (`core/src/spoilboards.rs:129`) — carries the catalogue's thickness;
* `Spoilboard::new` (`core/src/types.rs:553`) — `thickness_mm: None`, deliberately.

`SpoilboardCfg` (`core/src/fixtures.rs:1247`) has six fields and none of them is a thickness, and
the struct is `#[serde(deny_unknown_fields)]`:

```
$ 2bee-slice job plate --config '{"stock":{"thickness_mm":17.8},"machine":{"spoilboard":
    {"name":"my board","x_mm":-100,"y_mm":-100,"size_x_mm":1080,"size_y_mm":1560,"thickness_mm":18}}}'
error: configuration … rejected: unknown field `thickness_mm`, expected one of
`catalogue_id`, `name`, `x_mm`, `y_mm`, `size_x_mm`, `size_y_mm` at line 1 column 146
```

So the two declaration forms are no longer equivalent:

```
=== catalogue board (2bee-cnc-table-mdf-18) ===
sim board: board_depth=inside-board through_board=0 tested=1502501 thickness=18mm deepest_past=0.000mm

=== the same rectangle declared as measured ===
sim board: board_depth=board-depth-unknown through_board=0 tested=0 thickness=undeclared deepest_past=0.000mm
sim board: THROUGH-THE-BOARD NOT CHECKED ON THIS JOB — 🔴 THE DECLARED SPOILBOARD CARRIES NO
THICKNESS, so this check has no floor and did NOT run…
```

The app's own picker row for the measured form says *"The catalogue only holds boards whose numbers
were read off a supplier page or a model in this repo. **Yours almost certainly is not one of
them**"*. So the declaration form the tool expects most operators to use is the one for which the
new check can never run, through any host.

**Direction: ✅ under-declaring.** It reports UNKNOWN, loudly, with the best-written sentence in the
file. Nobody is misled. But the check is structurally unreachable for the common case, and a limb
that is always PENDING is a limb that stops being read — the lane has written that sentence about
`uncut` already.

⚠ **In-flight, stated as such rather than filed as a defect:** at the snapshot time the depth limb's
answer reaches `cli/src/main.rs` (the `sim board:` lines above) and **does not reach `Report`/`SimCounts`
at all**, so the browser cannot see it. `report plate --config …` returns a `sim` object with
`uncut_checked`, `past_spoilboard_edge`, `spoilboard_position_checked`, `spoilboard_pending_reason`
— and no board-depth field. `Report.spoilboard` likewise echoes no thickness. That is almost
certainly the next hour of the same change and I am recording it as an observation, not a finding.

**File/line:** `core/src/fixtures.rs:1247` (`SpoilboardCfg`, no thickness),
`core/src/types.rs:553` (`new`, `None`), `core/src/spoilboards.rs:129` (`install_at`, the only source
of a thickness), `core/src/sim.rs:825–930` (the limb).

---

## 5. The catalogue's thickness is nominal, and nominal runs thick — UNCHECKED

`SpoilboardSpec::thickness_mm`'s own doc:

> *"⚠ **Nominal.** `docs/materials-research.md` records that sheet goods are routinely under their
> nominal thickness and that MDF's claimed ±0.2mm tolerance is **GENERIC and unverified**…"*

and the 2bee entry's note:

> *"…this is the board as DESIGNED — a spoilboard is resurfaced in service and gets smaller and
> thinner, and nothing here tracks that."*

Both are true and both are honest. Now trace what that number does, at
`core/src/types.rs:611`:

```rust
pub fn underside_z_mm(&self, stock_thickness_mm: f64) -> Option<f64> {
    let t = self.usable_thickness_mm()?;
    …
    Some(self.top_face_z_mm(stock_thickness_mm) - t)
}
```

The floor is `-(stock_thickness) - declared_thickness`. **Declared thickness larger than real
thickness puts the modelled underside deeper than the real one**, so `through-board` fires *late* —
the cut is already in the table while the check still says `inside-board`. Both named effects push
the same way: sheet goods run under nominal, and resurfacing only removes material. There is no
mechanism that makes a board thicker than its catalogue figure.

`through_note` says this to the operator, correctly, **but only on a run that already went red**:

> *"⚠ The thickness this was judged against is what was DECLARED, and a spoilboard is dressed in
> service and gets thinner — if yours has been resurfaced, the real underside is nearer than this."*

Nothing says it on the run that comes back `inside-board`, which is the run where a green is being
issued against a number that is systematically generous.

⚠ **And on any ordinary planned job the limb cannot go red at all.** `core/src/toolpath` clamps
every through-cut to `stock_thickness + SPOILBOARD_ALLOWANCE_MM` (`0.3`, `core/src/post_grblhal.rs:294`),
and the thinnest catalogue board is 12mm, so `z < underside` is unreachable without a plant or a
hand-written deep operation. `inside-board` on a real job is therefore a green by construction —
`tested=1502501` counts every map cell over the board whether it was cut or not
(`core/src/sim.rs:1106`, incremented before the depth test, gated only on `OverSpoilboard`). It
agrees with `ran()`'s documented contract, so I am not calling it wrong; I am recording that the
number beside the green does not mean what a reader will take it to mean.

**Direction: 🔴 over-declaring.** Nominal thickness is the generous direction and it feeds the one
comparison that decides whether a cut reached the table.

---

## 6. `bare_reach` reports strips longer than the axis they sit on — WRONG

`core/src/types.rs:742`:

```rust
BareReach {
    minus_x_mm: (self.x_mm.min(t.size_x_mm) - 0.0).max(0.0),
    plus_x_mm:  (t.size_x_mm - (self.x_mm + self.size_x_mm)).max(0.0),
    minus_y_mm: (self.y_mm.min(t.size_y_mm) - 0.0).max(0.0),
    plus_y_mm:  (t.size_y_mm - (self.y_mm + self.size_y_mm)).max(0.0),
}
```

The `minus` terms are clamped to the travel with `.min(t.size_*)`. The `plus` terms have no
equivalent clamp. `BareReach`'s own doc calls these *"the four edge strips"* of *"the reachable area
a declared `Spoilboard` does **not** cover"* — a strip of the reachable area cannot be longer than
the reach.

Measured, `travel 600 x 900`, board `x -5000, size 100 x 900` (identical through the CLI and the
browser wasm):

```
{"bare":[0.0,5500.0,0.0,0.0]}
```

**5500mm of bare X on a 600mm axis.** The correct answer is 600 — the whole reach is bare.

Consequence in the viewport, `web/src/Viewport.tsx`, the bare-strip builder:

```tsx
[Math.max(0, tx - pxr), 0, pxr, ty],
```

With `tx = 600` and `pxr = 5500` that is a strip starting at `x = 0` and **5500mm wide** — a
translucent quad extending 4900mm beyond the travel outline it is supposed to hatch.

**Direction: ✅ under-declaring / false red.** It over-states bare area, which is the safe way to be
wrong, and `bare_reach` feeds only display — `Report.spoilboard_bare_reach` and the viewport
shading. It is not in any decision path:

```
$ grep -rn "bare_reach" core/ cli/ wasm/ | grep -v core/src/types.rs
core/src/fixtures.rs:2650:    pub spoilboard_bare_reach: Option<[f64; 4]>,
core/src/fixtures.rs:3158:        spoilboard_bare_reach: built.job.machine.spoilboard.as_ref().map(|b| {
… (the rest are tests)
```

Ranked low for that reason. It is still a number presented to an operator as a measurement of their
machine that is not a measurement of anything.

---

## 7. Zero travel makes `bare_reach` say "covers the whole reach" — WRONG

Same function, the early return:

```rust
let t = machine.travel_envelope();
if !self.faults().is_empty() || !(t.size_x_mm > 0.0) || !(t.size_y_mm > 0.0) {
    return BareReach::default();
}
```

`BareReach::default()` is all four zero, and `BareReach`'s doc states what all-four-zero means:

> *"All four zero ⇒ the board covers everywhere the cutter can go, which is the only case in which
> 'inside the travel' and 'over the spoilboard' are the same question."*

Measured — travel `0 x 0`, board `100,100` sized `50 x 50`, i.e. a board that covers nothing:

```
zero_travel {"ok":false,"travel":[0,0,100],
 "sb":{"name":"board","x_mm":100,"y_mm":100,"size_x_mm":50,"size_y_mm":50},
 "bare":[0,0,0,0],"checked":true,"past":0}
```

The browser turns `[0,0,0,0]` into the string `'none — the board covers the whole reach'` with class
`ok` (green) — `web/src/App.tsx`, `data-testid="spoilboard-bare"`. `Spoilboard::covers_travel`
(`core/src/types.rs:756`) returns `true` for the same input, because it is `faults().is_empty() &&
!bare_reach().any()`.

Mitigating: the job is refused for other reasons (`ok: false`), a zero travel is an odd state to
reach, and `covers_travel` has **no production caller** —

```
$ grep -rn "covers_travel" core/ cli/ wasm/
core/src/types.rs:1796:  assert!(!b.covers_travel(&m));
core/src/types.rs:1811:  assert!(b.covers_travel(&m));
```

— two tests and nothing else. A dormant predicate whose only reader is its own test; worth knowing
before someone wires it to a gate.

**Direction: 🔴 over-declaring.** A degenerate input produces the exact sentence that means "this
machine has nothing exposed".

---

## 8. Two doc comments state the Z residual's direction backwards — WRONG

`core/src/types.rs:583` (`top_face_z_mm`) and `core/src/sim.rs:~761` (`SpoilboardDepth`'s header)
both name the residual and both give its direction:

> *"⚠ Anything between the sheet and the board — packers, a sub-board, a vacuum jig, double-sided
> tape — moves the real top face **up** and this crate cannot see it. Every such error is in the
> direction that puts the underside nearer the cutter than modelled."*

> *"Anything between the sheet and the board — packers, a sub-board, a vacuum jig — moves the real
> underside **up**, toward the cutter."*

Derive it in the frame the functions use — `z = 0` at the stock top, stock thickness `t`, board
thickness `T`:

| | modelled | real, with a 10mm packer between sheet and board |
|---|---|---|
| stock underside | `-t` | `-t` (it *defines* the frame) |
| board top face | `-t` | `-t - 10` |
| board underside | `-t - T` | `-t - 10 - T` |

The real underside is **10mm deeper**, i.e. *further* from the cutter, not nearer. The modelled floor
is shallower than reality, so `through-board` fires ~10mm **early** — a false red. For the
mechanisms these two comments enumerate, the stated direction is inverted.

The genuinely unsafe Z direction is finding 5 — a declared thickness larger than the real board —
and it is named in `through_note` (which only appears on a red) but not in either of these two
comments, which are where a reader goes to learn what the assumption costs.

**Direction: ✅ over-warns.** A reader is told a safe residual is dangerous, which is the cheap way
to be wrong. I am reporting it because the lane's own canon is that *a comment explaining why a
control is right is the least audited thing in the repo*, and because the sentence that is wrong is
the one carrying the safety argument.

---

## 9. A browser refresh drops the board and travel keeps its value — UNCHECKED

`SessionValues` (`web/src/store.ts`) lists 30-odd fields and **no spoilboard field**:

```ts
export interface SessionValues {
  travelX: number; travelY: number; travelZ: number; safeZ: number;
  colletMm: number; spindleMax: number; probeEnabled: boolean;
  touchPlateMm: string; touchPlateId: string; supportsArcs: boolean;
  … clamps, workholdingId, dark, simCell, material, toolIds, drawings, extraToolsCount
}
```

and `App.tsx`'s write effect assembles exactly that list. So after a refresh the travel comes back
and the board does not: the app opens with `spoilboardId = ''`, which the core reports as UNCHECKED
with its full sentence.

That is the **safe** direction and I am not asking for it to be changed lightly — the board is a
statement about a physical setup and there is a real argument for making the operator re-declare it.
But it is not *decided*, it is *absent*: the section header enumerates four fields that are
deliberately not stored (`confirmedClear`, `plant`, `job`, `sectionZ`) with a reason each, and the
spoilboard is not among them. And because it is not in the schema, it is not a *dropped* field
either — `readSession`'s `dropped: DroppedField[]` banner names what did not survive, and a field
that was never written has nothing to name. **The board disappears with no line in the banner**,
under a founder rule that says *"When I refresh the browser all config should stay!"*.

**Direction: ✅ under-declaring, silently.** A false red, unannounced.

Related, same shape, smaller: the exception-path report built in `App.tsx`'s `catch` has no `travel`,
no `spoilboard`, no `spoilboard_bare_reach` and `notes: []`. If a plan throws while a board is
declared, the panel shows neither the board nor the pending sentence — the spoilboard section goes
quiet rather than going PENDING.

---

## 10. Auto-fit — CORRECT

`fitSpoilboard` (`web/src/App.tsx`, quoted here from the hashed file):

```tsx
const clamp = (v: number, size: number, travel: number) =>
  Math.round(size <= travel ? Math.min(Math.max(v, 0), travel - size)
                            : Math.min(Math.max(v, travel - size), 0));
```

Read the two branches as ranges of the corner it can emit:

* **board smaller than the reach** — corner clamped to `[0, travel - size]`, so the board is always
  **wholly inside** the travel envelope. It cannot place it partly outside.
* **board bigger than the reach** — corner clamped to `[travel - size, 0]`, i.e. deliberately
  negative: exactly the range in which the board still spans the whole reach, and no further. It
  cannot place a big board somewhere it stops covering the machine.

Both rules run through the same clamp, so rule 1 ("contains the work") cannot escape the range rule
2 uses. I probed the arithmetic for the mixed case the brief asks about — bigger in one axis,
smaller in the other — by transcribing `clamp`/`centreOn` and running them:

```
fit 2400x1200 on Bellwether 1250x670 = [ -575, -265 ]   (bigger on both -> negative corner, spans both)
fit 1200x600  on Desktop 3018 300x180 = [ -450, -210 ]   (bigger on both)
```

and by construction a `1200 x 400` board on a `600 x 900` reach yields `x ∈ [-600, 0]`,
`y ∈ [0, 500]` — negative on the axis it overhangs, inside on the axis it does not. That is the
right answer on each axis independently, which is what the per-axis comment in `centreOn` claims.

The "board smaller than the job" case refuses rule 1 explicitly and reports the refusal rather than
shuffling the board to hide the overhang — I read the branch and it returns
`rule: 'centred in the travel envelope'` with a `why` naming both spans. Good.

**The one caveat is finding 1**, not a defect in this function: every call site passes
`mTravelX = report?.travel?.[0] ?? travelX`, so immediately after a travel change and before the
replan lands, "Re-fit" fits to the previous machine.

---

## 11. The catalogue fit verdict — CORRECT

`spoilboardReachVerdict(sizeX, sizeY, travelX, travelY)` takes four numbers, subtracts, and reports
`covers` / `short` / `overhang`. It reads no position, no table, no rotation. Its doc names its own
predicate — *"Can this board be positioned to cover everything the cutter can reach?"* — and states
that a turned panel reads as a false red *"which is the direction to be wrong in"*. The
implementation matches the doc exactly; there is nothing in it but `travelX - sizeX`.

The table verdict is a **string constant**, not a computation:

```tsx
{
  label: 'Does it fit the machine TABLE?',
  value: 'UNKNOWN — and it is not a question this tool can answer. `Machine` carries travel limits '
       + 'and NO table, frame or rail dimension at all, so a verdict here would be a number '
       + 'invented to make a list tidier. Measure your table.',
}
```

There is no branch, no data source and no fallback — it cannot become a green because there is no
code path that would produce one. I checked that `Machine` really carries no table dimension:
`grep -n "table" core/src/types.rs` finds only prose. UNKNOWN is genuinely unreachable-to-green.

---

## 12. Both declaration forms — CORRECT, having probed nine configs

**I found no defect in the both-forms refusal.** Every case refuses, every refusal names what was
typed, and in every case the report echoes `spoilboard: null`, `spoilboard_bare_reach: null`,
`spoilboard_position_checked: false` — so a refused declaration **draws as no board** (the viewport
draws nothing when `props.spoilboard == null`) and **counts as no board** (the position limb reports
PENDING with its full sentence). Exactly what the brief asked to confirm.

| config | outcome |
|---|---|
| `catalogue_id` + both sizes | `SPOILBOARD NOT INSTALLED — spoilboard declares BOTH a catalogue id (Some("mdf-1200x600-12")) and an explicit size…` |
| `catalogue_id` + `size_y_mm` only | same refusal — `has_size` is `size_x.is_some() \|\| size_y.is_some()`, so one axis is enough to trip it |
| neither id nor sizes, position given | `…declares neither a catalogue id nor BOTH size_x_mm and size_y_mm. One axis of a rectangle is not a rectangle…` |
| `"spoilboard": {}` | `…declares no position (x_mm, y_mm) on the machine… 0,0 is not a safe default…` |
| unknown id `mdf-9999` | `…is not in the catalogue. It was NOT replaced with a nearby board… Known ids: 2bee-cnc-table-mdf-18, mdf-1200x600-12, mdf-2400x1200-16, mdf-3600x1200-32` |
| size `0 x 0` | `spoilboard 'typo' is declared 0x0mm, which has no area…` |
| size `-600 x 900` | `spoilboard 'neg' is declared -600x900mm, which has no area…` |
| catalogue id, no position | position refusal |
| catalogue id, `x_mm` only | position refusal (the `let (Some(x), Some(y))` needs both) |

Each is followed by the pending note, in full:

```
SPOILBOARD POSITION NOT CHECKED ON THIS JOB — no spoilboard is declared on this machine, so nothing
on this program went below the underside of the sheet, so nothing needed judging today — but the
same program on a sheet laid past the board's edge would not have been judged either. An absent
spoilboard is not a spoilboard covering the whole travel envelope — those are different facts and
only one of them is safe…
```

Two boundary notes, neither a defect:

* A **non-finite** corner or size cannot be reached through a config file at all — `serde_json`
  rejects `1e400` before `resolve` sees it (`error: configuration … rejected: number out of range at
  line 1 column 87`), and the browser's `typedMm` returns `undefined` for anything `Number.isFinite`
  refuses, which omits the key. So `faults()`'s non-finite branch is defensive and unreachable from
  either host. That is fine; it is the right branch to have.
* The report's echo always has `catalogue_id: null` and carries the size instead, even for a board
  installed by id. Round-tripping the echo back in is safe (it is a valid measured-board
  declaration), but nothing downstream of the core can tell which catalogue row was chosen.

---

## 13. Absent, zero, and the wasm boundary — CORRECT

The three-way distinction (*no board* / *a faulted declaration* / *a board*) survives every path I
could put it through.

* **No board declared** — `Machine::spoilboard = None`, `sim::check` classes every below-the-floor
  cell `BelowSheet::SpoilboardUndeclared`, `SpoilboardCoverage::ran() == false`, the report carries
  `spoilboard: null` **and** `spoilboard_bare_reach: null` (distinct from `[0,0,0,0]`), the panel
  prints `'not measured — no board'`, and the viewport draws nothing — `props.spoilboard == null`
  draws *"not a faint plane, not a dashed hint"*.
* **A faulted declaration** — treated as absent by `sim::check`
  (`let board = spoilboard.filter(|b| b.faults().is_empty())`) so it cannot false-red an entire job,
  **and** reported separately as `SPOILBOARD NOT INSTALLED` so it is not silently identical to
  absence. Both halves verified above.
* **The UI's config builder** — `spoilboardCfg` returns `undefined` when no board is chosen, so the
  key is absent rather than null; a partly-filled declaration **is** sent so the core can name what
  is missing (*"Withholding it here would turn 'you told me half a fact' into 'you told me
  nothing'"*); and the custom branch omits `catalogue_id` entirely, so the two forms cannot collide
  by construction.
* **The wasm boundary** — I ran the same six configs through `cam.plan()` in node and through the
  CLI. Every field matched digit for digit, including `[0, 5500, 0, 0]` and the zero-travel
  `[0,0,0,0]`. `cam.spoilboards()` returns `default_id = null`, so the picker cannot preselect.

A machine config that declares **no travel at all** falls back to the reference machine's
`600 x 900 x 100` and the board is measured against that — `{"machine":{"spoilboard":{…100,100,50x50}}}`
gave `travel: [600,900,100]`, `bare: [100, 450, 100, 750]`. That is a default, not an absence, and
it is the pre-existing `Machine::default()`; I note it only because it means "travel not declared"
and "travel is 600x900" are the same fact to the spoilboard checks.

---

## 14. `travel_z_mm` and the board — CORRECT

There is no relationship between `machine.travel_z_mm` and the board, and after tracing it I do not
think there should be one.

* `travel_z_mm` is used in exactly one place — `core/src/post_grblhal.rs:249`,
  `if -path.min_z > machine.travel_z_mm` — a motion bound measured from the same `z = 0` the model
  uses (the stock top). It answers "can the axis get there", not "what is there".
* The board's Z is now defined, in one place, by `Spoilboard::top_face_z_mm`
  (`core/src/types.rs:598`), which returns `-stock_thickness_mm` and **ignores `self`** — the sheet
  rests on the board, so the board's top face *is* the stock's underside. Making that a function
  rather than an assumption scattered across comments is the right shape; before it existed the
  relationship was, in the doc's own words, *"nowhere — not in a field, not in a comment"*.
* `--spoilboard-zero` / `z_offset_mm` does **not** move the model. It is applied at post time only
  (`post_grblhal.rs` adds it to emitted Z words; `job.rs:2159`: *"`z_offset_mm` shifts every emitted
  Z word — the plan's `min_z` does not"*). So zeroing on the board changes the G-code and leaves the
  simulation's frame intact, and the board's top face stays coherent with it. I looked for a
  double-count here specifically and there is none.

What remains genuinely **unknowable** in Z is not `travel_z`: it is anything between the sheet and
the board (findings 8) and the difference between a declared thickness and the board on the machine
(finding 5). Neither is expressible and both are named in the code.

---

## Things I probed and found nothing wrong with, stated so the absence is a result

* **The both-forms refusal** — nine configs, section 12. No defect.
* **The catalogue's no-default rule** — `catalogue_default_id()` returns `None`, the JSON payload
  carries an explicit `"default_id":null` rather than omitting the key, and `cam.spoilboards()`
  through the browser wasm returns `null`. No host can preselect a board by accident.
* **Unknown-id substitution** — `by_id` returns `None`, `resolve` refuses and lists the known ids.
  It does not fall back to a nearby board. The tool-substitution defect this was modelled on is not
  reproduced here.
* **`covers()`'s inclusive boundary** — a cell exactly on the edge counts as over the board. That is
  the forgiving direction on a dressed sheet edge, it is documented as such, and I agree with it.
* **The position limb classing cells from the board rectangle and not from travel** —
  `core/src/sim.rs`, the class is decided at the cell from `b.covers(x, y)`, with an explicit comment
  refusing to use travel. I checked there is no path where travel leaks into the material question.
  There is not.
* **Double counting between the two limbs** — cells past the board's edge are excluded from the depth
  limb (`if below == BelowSheet::OverSpoilboard`), so one hazard is never rendered as two.
* **CLI/browser parity** — six configs run through both hosts, identical output.

---

## What I would do first, if it were mine to do (it is not)

1. **Finding 1.** Arm the guard that already exists. `readSpoilboard`'s travel fingerprint is the
   right control, correctly reasoned and tested; it needs a caller on the preset row and the three
   travel inputs, and `spoilboardPos` needs to leave `entered` when the frame its corner was measured
   in stops being the current one.
2. **Finding 2.** Give `SpoilboardCoverage::ran()` the same predicate its sibling in the same file
   already has — a floor *and* something tested against it. The sentence explaining why is already
   written, thirty lines below, about this exact defect.
3. **Findings 3 and 5** are the two that decide whether a rectangle and a thickness mean anything,
   and neither has a detector today.

Everything else on the list is display, dormant, or in flight.
