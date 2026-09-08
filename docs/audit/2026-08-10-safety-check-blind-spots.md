# Audit — safety checks that are NARROWER than the danger they name

**Date:** 2026-08-10 · **Tree:** `3023c585ad` · **Scope:** `software/2bee.app` core, CLI,
wasm, gates, web.

**One question, asked of every check in the tree:** *what is the SHAPE of the check, and
what is the SHAPE of the danger?* A check that samples points where the hazard is
continuous, reads a plan where the hazard is in the emitted text, trusts a declared
number where a wrong declaration crashes the machine, runs once where the hazard is
per-operation, or is satisfied by an empty list — is green about something narrower than
what it claims.

**This audit changes no code, arms no gate and marks nothing ✅.** Every finding below
was **executed**, not read: the evidence column names the command or probe that produced
it. Probes were built as a throwaway crate outside the repo (`Cargo.toml` with
`twobee-cam = { path = … }`) so nothing in this tree was edited. Baseline at the time of
writing: `cargo test --release` = **391 + 8 passing**, `gates/slicer_gate_check.mjs
--list` = **48 declared gates**.

> **Prior art, credited rather than re-discovered.** `docs/design-68-hold-down-validation.md`
> §0 already states findings **B1** and **B2** at the same `file:line`, and its §4 designs
> the ordering and restraint checks (**B9**, **B14**). That memo says of itself:
> *"Nothing here was executed."* **This audit executes them** — B1 is proven below at the
> emitted G-code, through the shipping import path — and then hunts the siblings, of which
> §§B3–B13 are not covered there.

---

## Ranked summary

Ranked by **reachability with the shipped defaults**, because a blind spot behind a
non-default config is a smaller number of real programs.

| # | Blind spot | Class | Reachable with defaults? | Physical failure |
|---|---|---|---|---|
| **B1** | `Fixturing::check` tests move END POINTS; a clamp between two endpoints is not seen | endpoint vs segment | ✅ **YES — proven at the emitted G-code** | 6 mm cutter at feed into a 40 mm steel cam clamp at full depth; clamp, cutter and part |
| **B2** | `clearance_z` has no consumer — every rapid is emitted at bare `safe_z_mm` (5 mm) | dead control | ✅ **YES** | gantry crosses a 42 mm toggle clamp 5 mm off the bed at 3000 mm/min |
| **B3** | Travel / spoilboard / sheet-edge / datum-shift all read an ENDPOINT bounding box; an arc bulges outside it | endpoint vs segment | ✅ **YES — proven: G3 green 1.0 mm past Y travel** | gantry into its own frame / hard stop; error grows with arc radius, unbounded |
| **B4** | `SimFinding::Uncut` cannot fire on any user job — the `remove` set is empty for every import | absent data | ✅ **YES — structurally, on 100 % of imports** | island left standing, snatched loose under the spindle (gate P2's own failure) |
| **B5** | Arc → straight-chord degradation is a **warning**; every geometric check ran on the ARC | plan vs emitted | ⚠ one config field (`supports_arcs:false`) | chord cuts up to one full arc radius inside the arc — a gouge nothing simulated |
| **B6** | `safe_z_mm ≤ 0` is accepted by the config; nothing checks a rapid is above the stock | absent guard | ⚠ config/API only (UI validates positive) | every traverse ploughs the sheet at rapid speed; cutter snaps |
| **B7** | The whole probe sequence is raw text, never in `path.moves` — invisible to the keepout AND the travel check | wrong artefact | ⚠ needs `probe_enabled` + a corner plate | cutter driven into a clamp at the datum corner; standoff outside soft limits |
| **B8** | Gate P7's own plant only exercises the ENDPOINT arm — no control can make B1 go red | negative control shaped to the check | ✅ YES (it is the shipped gate) | P7 reports PASS on a check that has never been watched fail its real case |
| **B9** | Release attribution is by BOUNDING BOX + one anchor point | shape precision | ⚠ needs a concave / interleaved nest | a part's outer profile cut before its own holes — REL's failure, reached around REL |
| **B10** | Declared-vs-actual: clamp height (any `> 0` accepted), stock thickness, plate thickness, collet | declared vs actual | ✅ YES | wrong declaration → spoilboard strike / clamp strike, with every check green |
| **B11** | Sim tolerances: gouges shallower than one cell (0.6 mm) discarded; keep regions shrunk one cell | resolution | ✅ YES (named in-file) | a ≤0.6 mm gouge, or any gouge on the finished edge band, is not counted |
| **B12** | The cutting-length reach check exists ONLY on the `recommend` path | path gap | ✅ YES | an 8 mm-flute cutter run 18.3 mm deep: shank rubs the wall, tool buried |
| **B13** | `check_stock_depth` / depth clamping trust `stock.thickness_mm` alone | declared vs actual | ✅ YES | board thinner than declared → full-depth pass into the spoilboard |
| **B14** | `Clamp` models a KEEPOUT, never a HOLD — `resists` is consumed by nothing | model narrower than danger | ✅ YES (declared in-tree) | side-pressure setup blessed for a full-depth up-cut profile; work lifts |

---

## B1 — the keepout samples points; the cutter travels a line

**Shape of the check:** one point per move. **Shape of the danger:** the whole swept
segment.

`Clamp::contains` is called from exactly two lines in the crate —
`core/src/fixture.rs:235` and `:246` — both on `m.to`. `Move` carries `to` and **no
`from`** (`core/src/types.rs:835-861`). Nothing walks the segment. Compare
`core/src/sim.rs:188-225`, which keeps a `cur: Option<Vec3>` cursor and stamps along the
move at `stamp_step_mm`. **The material-removal simulation is segment-aware and the safety
keepout is not**, in the same crate, ~150 lines apart.

**Re-verified, and then proven at the emitted program.** `design-68` states this from the
source; it had not been run. Executed through the shipping import path
(`2bee-slice import` → `fixtures::plan_import*` → `job::plan_job`, the same entry the
browser calls):

```
$ cat cfg3.json
{"tool_id":"End Mill - Down-cut 6mm 2F",
 "clamps":[{"name":"bar-mid","x":140.0,"y":30.0,"w":40.0,"h":30.0,"height_mm":40.0}]}

$ ./target/release/2bee-slice import gates/fixtures/plate.dxf --config cfg3.json --json
ok            = True
refusals      = []
fixture_findings = []
sim           = {cell_mm: 0.6, gouge: 0, uncut: 0, spoilboard: 0, first: null}
```

`plate.dxf` is a 50,50 → 250,170 rectangle; the outside profile puts the tool centre on
`Y = 47`, and the bottom edge is emitted as **one block**:

```
G1 X244.000 Z-18.000          ( from X120.000, Y47.000 — one move, 124 mm long )
```

The declared clamp occupies **X 140–180, Y 30–60, 40 mm tall**. `Y = 47` is inside it.
The block's two endpoints (`X120` and `X244`) are both clear of it, so **`CutsClamp` does
not fire**, the program is `ok: true`, and the G-code is emitted and downloadable. A 6 mm
cutter is driven through a 40 mm clamp at the full 18 mm depth of an 18 mm sheet.

Also confirmed at unit level, against the shipped `cam-clamps` preset
(`core/src/fixture.rs:273-281`, cam-1 at X −5…35, Y 225…265, 35 mm):

* a **feed** from (20,100) to (20,400) straight through cam-1 → `findings == []`;
* a **rapid** over the same line at Z5 → `findings == []`;
* end-to-end `plan_job` with a part whose left edge runs past cam-1 → `refusals: []`,
  `fixture_findings: []`, `is_runnable(): true`, while an independent 100-point sample of
  the same path finds **12 emitted segments physically inside the clamp**.

**Smallest test that would prove it** (a unit test in `fixture.rs`, ~10 lines):

```rust
let f = Fixturing { clamps: vec![Clamp::new("cam-1", -5.0, 225.0, 40.0, 40.0, 35.0)],
                    confirmed_clear: false };
let p = path_of(vec![Move::rapid(Vec3::new(20.0, 100.0, 5.0)),
                     Move::feed_to(Vec3::new(20.0, 100.0, -5.0), 300.0),
                     Move::feed_to(Vec3::new(20.0, 400.0, -5.0), 1000.0)]);
assert!(f.check(&p, 3.0, 18.0, &Machine::default())
         .iter().any(|x| matches!(x, FixtureFinding::CutsClamp { .. })),
        "a cut straight through a clamp, with both endpoints clear, was accepted");
```

It goes red today. **Do not "fix" it by densifying the toolpath** — the emission density
is a G10 block-rate concern, and making a safety bound depend on it is B3's defect
arriving here.

---

## B2 — `clearance_z` is a threshold that nothing lifts to

**Shape of the check:** a number computed inside `check` and compared against.
**Shape of the danger:** the height the machine actually flies at.

`Fixturing::clearance_z` (`core/src/fixture.rs:193-201`) is called from
`core/src/fixture.rs:229` — inside `check`, as its own comparison threshold — and from
tests at `:373, :381, :462-463, :734`. **Nowhere else in the repo.** Every rapid the
planner emits is at bare `machine.safe_z_mm` (`core/src/toolpath.rs:430, 664, 691, 719,
800`), default **5.0 mm** (`core/src/types.rs:474`). Confirmed by reading the plan back:
every `MoveKind::Rapid` in a planned job has `to.z == 5.0`.

So `clearance_z` never *raises* anything. It only decides whether to complain about a
rapid whose **endpoint** already landed in a clamp — and B1 means most crossings never
reach that comparison. Together, B1 + B2 are the whole of `RapidBelowClamp`'s real
coverage: *a rapid that stops directly over a clamp*.

**The claim has propagated into three more places and is false in all of them.**
`web/src/workholding.ts` tells the operator, in the catalogue the picker renders:

* `:325` — *"`height_mm = 50` makes `clearance_z()` demand `50 − 18 + 2 = 34mm` on EVERY rapid — a false red, and false reds get muted"*
* `:354` — *"at 25mm, `height_mm = 25` makes `clearance_z()` demand `25 − 18 + 2 = 9mm` on every rapid"*
* `:594` — *"`clearance_z()` gives `17.8 − 18 + 2 = 1.8mm`, under the 5mm default safe Z, so no rapid is lifted"*

The third is accidentally right *for the wrong reason* (no rapid is ever lifted). The
first two warn the user about a **false red that does not exist**, while the actual state
is a **false green**: the machine flies at 5 mm regardless. This is the exact shape of
[[a-comment-explaining-why-a-control-is-right-is-the-least-audited-thing-in-the-repo]],
now copied four times (`fixture.rs:165`, `TODO.md:1897` per design-68 §0, plus these
three).

**Smallest test:** plan any job with a 35 mm clamp declared and assert
`path.moves.iter().filter(|m| m.kind == Rapid).all(|m| m.to.z >= f.clearance_z(&machine, t))`.
Red today, on every job.

---

## B3 — the travel, spoilboard, sheet-edge and datum-shift checks all bound a program by its ENDPOINTS

**Shape of the check:** the min/max of move *destinations*. **Shape of the danger:**
where the tool actually goes, which for `G2`/`G3` leaves that box.

`Toolpath::recompute_bounds` (`core/src/types.rs:1017-1053`) folds `m.to.{x,y,z}` and
nothing else. `Extent::from_toolpath` (`core/src/placement.rs:194-211`) says so in its own
doc comment — *"an arc's `centre` is not part of the box this returns"* (`:192`) — and
that sentence is treated as a note rather than a finding. **Five checks are built on that
box:**

| Consumer | `file:line` | What it claims |
|---|---|---|
| `check_machine_limits` | `core/src/post_grblhal.rs:133-182`, called `:725` | gate **G3** — "a move past the table drives the gantry into its own frame" |
| `check_stock_depth` | `core/src/post_grblhal.rs:191-215`, called `:726` | gate **G4** — spoilboard |
| sheet-edge "NOT simulated" note | `core/src/job.rs:1247-1279` | which geometry the sim covered |
| `plan_datum_shift_for_toolpath` | `core/src/job.rs:1358` | the offered datum fix |
| `Extent::from_toolpath` | `core/src/placement.rs:194` | `fit` / `layout` verdicts |

Z is safe — Z varies linearly along every move kind, so the endpoint min IS the true min.
**X and Y are not.**

**Proven, on the planner path, with shipped defaults** (`Machine::default()`, 600 × 900
travel; `EntryMode::Plunge`, tabs off — the settings that leave an arc as one move per
segment):

```
job: one inside bore, Contour::circle(300.0, 892.0, 12.0), 6 mm cutter
emitted plan:  4 × ArcCW per pass, endpoints at (309,892) and (291,892)
               centre (300,892), r = 9.000  ->  true top of arc  Y = 901.000
path.min_y .. path.max_y   =   890.129 .. 893.871
check_machine_limits(&path, &machine)  =  []          <-- GREEN
refusals = []
```

The tool centre reaches **Y 901.0 on a machine with 900 mm of Y travel** and gate G3's
own function returns an empty error list. At unit level with a single 180° arc the miss is
the full radius: a semicircle of r = 30 centred at Y 890 reports `bounds y 890 .. 890`
while the tool reaches Y 920 — **30 mm past the limit, no error.**

⚠ **The miss is currently masked by an accident, and that is the more important half.**
With the *default* ramp entry and tabs enabled, `toolpath.rs`'s tab/ramp sampler
(`core/src/toolpath.rs:536-575`, `n = ceil(l / (tab_width·0.25))`, emitted wherever Z
changes) splits arcs into many sub-arcs, so the endpoint box tracks the curve to within
**0.44 mm** on the same bore. So the bound on a safety check's error is set by how finely
an unrelated Z-stepping loop happens to emit points. **That is not a safety parameter, and
nothing pins it.** Turn off tabs, or ask for a plunge entry, and the error returns to the
arc radius.

**Smallest test** (`placement.rs` or `post_grblhal.rs`, ~8 lines): build a path of two
180° arcs forming a circle whose centre sits `travel_y − 10` and whose radius is 30, and
assert `check_machine_limits` is non-empty. Red today.

**Note the direction:** this one fails toward the machine's frame, and `f64` bounds cannot
express "I did not measure this move". Widening `recompute_bounds` to include an arc's
extremal points is the arithmetic fix; `types.rs:994-1000` already warns that
*"the six numbers alone are no longer a complete answer"* for the NaN case — the arc case
is the same sentence with a different cause.

---

## B4 — `SimFinding::Uncut` is structurally unreachable on every user job

**Shape of the check:** compare the height map against a declared `remove` region set.
**Shape of the danger:** material left standing anywhere.

`sim::check` fires `Uncut` only under `if remove_depth_mm > 0.0 && inside(&remove_rings,…)`
(`core/src/sim.rs:515`). The `remove` set is populated in **exactly one place in the whole
repo** — `core/src/fixtures.rs:689-690`, the built-in `pocket` fixture. Every imported
drawing is built with:

```rust
// core/src/fixtures.rs:3697-3699
keep,
remove: Vec::new(),
remove_depth_mm: 0.0,
```

So for **100 % of real jobs** — every DXF, SVG or STL a user drops in, single-drawing or
nested — `Uncut` cannot fire, and the report shows `"uncut": 0`. Confirmed at the CLI:
`import gates/fixtures/plate.dxf … → sim {gouge: 0, uncut: 0, spoilboard: 0}`.

**Zero is not "nothing standing"; it is "nobody asked".** Gate P2's declared physical
failure ("an outlined pocket leaves an island standing") is proved against one built-in
fixture and is unchecked on the shipping path. `Gouge` and `Spoilboard` do run on imports
(`keep` is populated from every part outline at `fixtures.rs:3690`), so this is not a dead
simulation — it is one of its three findings that is switched off by an empty list.

**Smallest test:** plan `import` on any drawing and assert `built.remove.is_empty()`, then
assert the report's `uncut` field is reported as **`null`/PENDING** rather than `0`. Per
this lane's own duty 2, *a check that cannot run reports PENDING, never PASS* — and `0` in
a counter reads as PASS.

---

## B5 — an arc degraded to a chord is only a WARNING

**The finding, in full: plan vs emitted — an arc degraded to a chord is a WARNING, and every
geometric check ran on the arc.**

`core/src/post_grblhal.rs:1033-1052`: when `!machine.supports_arcs || !opts.emit_arcs`, the
post writes `G1` to the arc's endpoint and pushes
`"arc degraded to linear move (arcs disabled or unsupported)"` into **`warnings`**.
`PostResult::ok()` is `self.errors.is_empty()` (`:48-50`) — warnings do not block.

Everything that judged this program's geometry — `sim::simulate` (which walks the arc
correctly via `arc_points`, `sim.rs:126-150`), `Fixturing::check`, `check_machine_limits`,
`check_stock_depth`, the sheet-edge note — ran on the **arc**. The file contains the
**chord**. The chord's maximum deviation from the arc is `r·(1 − cos(θ/2))`, which for the
180° arcs this core emits for circles (`geometry.rs:72-77`) is **the whole radius**.

Measured, same drawing, same tool, one config field apart:

```
supports_arcs: true    ok=True  warnings=[]                       cut = 17179.1 mm
supports_arcs: false   ok=True  warnings=[ "arc degraded…" × n ]  cut = 17064.0 mm
sim in BOTH cases:  gouge 0, uncut 0, spoilboard 0
```

The 115 mm difference in cutting distance is the proof that the emitted program is a
different path from the one every check measured. On an inside feature the chord cuts
**into** the finished wall; on a hole it removes the hole entirely.

**Reachability:** `supports_arcs` is a `MachineCfg` field the UI exposes, and `--no-arcs`
is a CLI flag (`cli/src/main.rs:1091`). The default is `true`, so this is one deliberate
setting away.

**Smallest test:** post the same path twice, arcs on and off, and assert the two G-code
texts either agree or the arcs-off run is an **error**, not a warning. A defensible middle
answer is to refuse when the chord deviation exceeds a stated tolerance — but computing
that tolerance is geometry this core already has, so nothing here needs data it lacks.

---

## B6 — nothing checks that a traverse is above the material

`sim::simulate` deliberately does not stamp rapids (`core/src/sim.rs:192`), and its own
test explains why:

> `core/src/sim.rs:578-579` — *"A rapid at negative Z is a different defect, caught by the
> fixture and spoilboard checks, not by pretending it removes stock."*

**That sentence is not true.** `check_stock_depth` only fires below
`−(thickness + 0.3)` = −18.3 mm; `Fixturing::check` only fires inside a **declared** clamp
footprint. A rapid at Z −4 across the middle of the sheet is caught by neither.

`safe_z_mm` is copied straight out of the config with no validation —
`core/src/fixtures.rs:1419`, `set!(d.safe_z_mm, m.safe_z_mm)`. Measured:

```
machine.safe_z_mm = -4.0, one ordinary profile op, default everything else
rapid Zs      = [-4.0, -4.0, -4.0, -4.0, -4.0, -4.0, …]
refusals      = []          is_runnable = true
fixture       = [Undeclared]
check_machine_limits = []
post: ok = true, errors = [], warnings = []
```

Every traverse ploughs 4 mm into 18 mm ply at `rapid_mm_min` = 3000 mm/min with a 6 mm
cutter. Nothing in three hosts objects.

**Reachability:** the React UI validates `safeZ` as positive (`web/src/store.ts:361`,
`{ t: 'pos' }`), so this needs a hand-written config file, the `--config` flag, or a
direct `wasm::plan(config_json)` call. **The guard lives in one host, and the core is what
the other two share.**

**Smallest test:** `assert!(machine.safe_z_mm > 0.0)` as a refusal in `plan_job`, plus a
`post_grblhal` assertion that no `MoveKind::Rapid` has `to.z < 0.0`. Both red today with a
one-field config.

---

## B7 — the probe sequence is text, not moves, so two checks cannot see it

`emit_probe` (`core/src/post_grblhal.rs:511-655`) writes the entire probing sequence
straight into the G-code string. **None of it exists as a `Move`.** Consequences:

* **`Fixturing::check` never sees the probe station.** The Z station is the workpiece
  corner (`ProbeGeometry::z_probe`, `:320-325`, from `Stock::corner_placement`). The
  shipped `screws` preset puts `screw-bl` at exactly (5,5), 12 × 12 (`fixture.rs:285`).
  A clamp *at the datum corner* is the ordinary case, and the keepout is blind to the tool
  being driven there.
* **`check_machine_limits` never sees the standoff.** The XY passes stand off **outboard**
  by `wall + radius + probe_max` (`:597`, `let reach = …`) via incremental `G91` moves. On
  a `FrontLeft` corner at datum (0,0), `x_sign = −1`, so the standoff is at
  `X ≈ −(wall + r + 30)` — **negative X, outside the 0…600 travel** — and the travel check
  bounds `path.moves`, which contains none of it.

**Reachability:** `Machine::default()` has `probe_enabled: false` and
`probe_plate: ZOnly` (`types.rs:485-497`), and `Stock::default().corner_plate` is `None`,
so the XY half needs three deliberate settings. The Z-station half needs only
`probe_enabled` + a declared plate. **Ranked below B1–B6 for that reason, not because the
failure is smaller.**

**Smallest test:** post a job with an XYZ corner plate at datum (0,0) and assert that the
emitted text contains no coordinate outside `0..travel` — i.e. run the travel check over
the **emitted words**, which `audit_finite_words` (`post_grblhal.rs:98-131`) already walks
for finiteness and could answer for range at no extra cost.

---

## B8 — P7's negative control is shaped to the check, not to the danger

`core/src/fixtures.rs:821-831`, the `cut-clamp` plant:

```rust
// Placed over the hole at (90,90) AND across the outline at
// x=60, so both a drilled feature and a profile pass run into
// it. An earlier version sat at x100..160 where the toolpath
// never actually goes — the plant produced no finding and the
// check looked broken when it was simply right.
Clamp::new("bar-on-part", 50.0, 70.0, 60.0, 60.0, 40.0)
```

The plant is a 60 × 60 clamp placed so a **drill point** and a **profile vertex** land
inside it. Both are move *endpoints*. Gate P7 (`gates/slicer_gate_check.mjs:1327-1338`)
therefore proves only that the endpoint arm works — and **would still pass, unchanged, if
`Clamp::contains` were only ever endpoint-tested**, which is exactly what it is.

The comment records that an earlier plant *"produced no finding and the check looked
broken when it was simply right."* Read with B1 in hand, that earlier plant may have been
the honest one: a clamp the toolpath crosses but does not stop in is precisely the case
the check misses. The plant was moved to where the check looks.

This is [[plant-the-defect-a-green-nobody-has-seen-go-red]] in its subtler form: the plant
exists, it fires, the gate goes red on demand — **and the only failure it can express is
the one the check already handles.** A negative control chosen by reading the
implementation inherits the implementation's blind spot.

**Smallest test:** add a second plant (`CutClampCrossing`) that places the clamp at the
midpoint of the plate's long edge — X 140–180, Y 30–60, as in B1 — and require gate P7 to
go red on it. It will not, today, and that is the point of adding it.

---

## B9 — release ordering attributes a feature by BOUNDING BOX and one point

`core/src/optimise.rs:362-434`. A feature is attributed to the **smallest-area bounding
box** of an outer profile that contains its **anchor point** (the entry vertex),
`:404-407`, with ties → `None` → pinned barrier (the safe direction).

Two narrowings:

1. **Bounding box, not contour.** For an L- or C-shaped part A, a hole belonging to
   neighbour part B that sits in A's concavity is inside A's bbox. If A's bbox is the
   smaller of the two, the hole is attributed to **A**, and the precedence edge
   *hole → B's outer profile* is **never created**. B's profile can then be scheduled
   before B's own holes — the part is released and then drilled while held by its tabs
   alone. That is gate REL's stated physical failure, reached through the attribution
   rather than through the ordering.
2. **One point, not the feature's extent.** A hole whose entry vertex falls a hair outside
   a part's bbox is attributed to nothing. `ATTRIBUTION_SLACK_MM = 1e-6` (`:99`) is sized
   for arc-extent float noise, not for geometry.

`verify_interior_before_outer` re-checks the OUTPUT rather than the intent (good), but it
re-checks it **through the same attribution**, so a mis-attribution is invisible to both.

**Reachability:** needs a concave part nested around another part's features — a real nest
shape, not a contrived one, but not the default fixtures. Ranked accordingly.

**Smallest test:** two parts, A an L-shape whose bbox encloses B, B carrying one hole;
assert the route report's precedence edges include `B.hole → B.outer`.

---

## B10 / B13 — every physical dimension the checks rest on is DECLARED

**The finding, in full: every physical dimension the checks rest on is DECLARED, and a wrong
declaration is not a refusal.**

| Declared value | Where it is trusted | What a wrong value does | Any check? |
|---|---|---|---|
| `Clamp.height_mm` | `fixture.rs:194` | too low → no lift demanded, gantry into the clamp | only `≤ 0` (`ClampHeightUndeclared`, `fixture.rs:224`). **Any positive number is accepted unmeasured.** |
| `stock.thickness_mm` | `post_grblhal.rs:205`, `toolpath.rs:408` | board thinner than declared → full-depth pass into the spoilboard; thicker → part never released | none |
| `machine.touch_plate_mm` / corner plate | `post_grblhal.rs:339` | wrong Z datum for the whole program | refused when **absent** (good); a wrong number runs |
| `machine.collet_mm` | `tools.rs:205` | `0.0` → `ColletVerdict::Undeclared` | honest verdict, but **a note only** — `is_runnable()` stays true |

`ClampHeightUndeclared` is the model for the rest: it is a **finding**, and
`JobResult::is_runnable` (`job.rs:491-497`) treats every finding except `Undeclared` as
fatal. `Undeclared` itself — nobody said where the clamps are — is **non-fatal by
design**, which is defensible, but it means the entire P7 family is satisfied by an empty
list on any job where the operator has not filled the panel in. Measured: a default job
with no clamps returns `fixture_findings: [Undeclared]`, `is_runnable: true`.

> ⚠ **Where this tool does not have the data, say so rather than invent a check.**
> Whether a given clamp *holds* against a given cut needs clamping force (N or bar),
> coefficient of friction between ply and the clamp face, cutter engagement force, and
> tool deflection. **None of those exist anywhere in this repo** —
> `docs/workholding-research.md` records that no clamping force is published for several
> catalogue entries at all. Any check phrased as "will it hold?" would be inventing
> numbers. The checks that ARE computable from geometry and program order are designed in
> `docs/design-68-hold-down-validation.md` §4, and they are the right scope.

---

## B11 — the simulation's tolerances, which are named in-file and are still narrowings

Recorded for completeness because they bound what B4/B5 could ever have caught:

* `sim::check` shrinks every `keep` and `remove` region by **one cell** before testing
  (`sim.rs:465-476`). At the default 0.6 mm cell, **the outer 0.6 mm band of every part —
  the finished edge — is outside the tested region.** That is exactly where a lead-in
  error lands. The rationale (a tangent profile pass would otherwise report the whole
  outline) is correct and the tolerance is honest; the consequence is still that the most
  safety-relevant band is the untested one.
* A gouge is only reported when `z < -hm.cell_mm` (`sim.rs:510`) — **gouges shallower than
  0.6 mm are discarded.**
* A region narrower than one cell is **dropped entirely** (`sim.rs:468-471`).

All three are documented in the module header and in `Precision::notes()` (`sim.rs:343-368`),
which is the right treatment. No action proposed; listed so a reader of `gouge: 0` knows
its width.

---

## B12 — the reach check runs on one path out of two

`RejectReason::TooShortToReach` (`core/src/recommend.rs:321`, raised at `:651-655`) refuses
a tool whose `cutting_length_mm` cannot reach the feature depth. It exists **only inside
`recommend`**. `plan_job` with an operator-chosen `Job.operations[].tool` never asks.

Measured:

```
tool: 6 mm, cutting_length_mm = 8.0     depth_total_mm = 18.3     stock = 18 mm
plan_job -> refusals = []       deepest_z_mm = -18.3
notes mentioning cutting length / reach:  NONE
```

The shank is driven 10 mm into the wall. **Reachable via `tool_id` (one cutter for the
whole job), which is the CLI's and the UI's ordinary single-tool path**; the per-feature
`tool_ids` path goes through `recommend` and is covered.

**Smallest test:** the four lines above, asserting a refusal. Red today.

---

## B14 — `Clamp` is a keepout, and the danger is a hold

Already declared in-tree, at `web/src/workholding.ts:39-45`:

> *"`resists` IS NOT CONSUMED BY ANYTHING YET, and it is the most important field in the
> file. `Clamp` today is pure geometry-to-avoid, so `Fixturing` cannot tell a fence from a
> toggle clamp — it will bless a side-pressure setup whose finishing pass is a full-depth
> profile with an upcut cutter. **P7 protects the CLAMP from the tool; nothing yet protects
> the PART from coming loose.**"*

And a second-order consequence worth naming, because it is the pattern where a false red
disarms a real check: the same file (`:318-328`) instructs the user **not** to declare a
vacuum pod as a clamp, because `height_mm = 50` would make `clearance_z` demand 34 mm on
every rapid — *"a false red, and false reds get muted"*. Two things follow. First, per B2
that false red **does not exist**, so the instruction is defending against a behaviour the
code does not have. Second, a user who follows it declares no keepout for the pod at all,
and **the real failure — a through-cut into the pod — then has nothing checking it**,
because `CutsClamp` is the only thing that would have fired (it tests XY regardless of Z,
which is the one direction that would have worked here). *The core cannot say "under"*, as
the file itself puts it.

Design for the computable half is `docs/design-68-hold-down-validation.md` §4 (four
checks, each with a plant). Nothing to add here beyond the disarming interaction above.

---

## What was checked and found NOT to be narrow

Recorded so a later reader does not re-audit them, and so this document is not read as a
list of everything that exists.

* **`recompute_bounds` / `check_stock_depth` in Z.** Z varies linearly along every move
  kind including arcs and drill cycles, so the endpoint minimum **is** the true minimum.
  B3 is an XY-only finding.
* **`Fixturing::check` tool radius.** Called with `biggest_r` across all tool groups
  (`job.rs:1284`) — wider than any single cutter, i.e. **over**-reports. Safe direction.
* **`RapidBelowClamp`'s clearance threshold** uses the globally tallest clamp
  (`fixture.rs:194`), so a rapid over a short clamp is judged against the tall one.
  Over-reports. Safe direction.
* **`CutsClamp` ignores Z**, so a cutting move over a clamp is flagged even at a Z that
  clears it. Over-reports. Safe direction (and it is what would catch B14's vacuum pod).
* **The NaN family.** `first_nonfinite_move` is re-scanned fresh at every decision point
  (`types.rs:964`, `post_grblhal.rs:713`, `:146`), never read from the stale
  `nonfinite_moves` snapshot. Correct, and the reasoning is written down.
* **`layout.rs` part-to-part clearance** uses real contour booleans, not bounding boxes
  (`layout.rs:71-77` and the `cavalier_contours` boolean ops), and it names its own
  known false red (a part nested in another's hole) at `:54-58`.
* **`JobSummary`** is read back out of the **emitted program text**, not `path.moves`
  (`job.rs:1288-1320`) — the one place in this tree where the plan-vs-emitted lesson is
  fully applied. It is the template for fixing B3 and B5.
* **Route reordering** moves no coordinate (`optimise.rs:21-27`), so running it before the
  geometric checks does not narrow them. Verified by reading; the ordering constraints
  themselves are B9.

---

## Method, and what would falsify this

* Every `file:line` was read at the source at `3023c585ad`.
* Every ✅-reachable finding was **executed** — B1 and B5 through
  `./target/release/2bee-slice import … --config … --json` (the same core the browser
  calls via `fixtures::plan_import*`); B1, B2, B3, B6, B12 through a throwaway crate
  linking `twobee-cam` by path, outside this tree. No file in `software/2bee.app` was
  modified except this document.
* Counts were taken by running: `cargo test --release` → **391 + 8 passing**;
  `gates/slicer_gate_check.mjs --list` → **48 declared gates**. Neither number was copied
  from a doc.
* **What would falsify B1:** a segment-walking call site for `Clamp::contains` that this
  audit missed. `grep -rn '\.contains(' core/ cli/ wasm/` returns two non-test geometric
  call sites, both `fixture.rs:235` and `:246`, both on `m.to`.
* **What would falsify B2:** any producer of a `MoveKind::Rapid` whose Z is not
  `machine.safe_z_mm`. `grep -rn 'safe_z_mm' core/src` returns five emission sites in
  `toolpath.rs`, all identical.
* **What would falsify B4:** a second writer of `BuiltJob::remove`.
  `grep -n 'remove.push\|remove.extend' core/src/fixtures.rs` returns one line, `:689`.

**Nothing in this document is a hardware claim.** No output from this tool has been run on
a controller and none of these failures has been observed physically; each is a statement
about what the checks in this tree do and do not measure.
