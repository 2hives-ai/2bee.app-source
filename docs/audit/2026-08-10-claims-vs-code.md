# Claims-vs-code audit — 2026-08-10

**Scope:** every claim this lane makes about itself (`README.md` status table,
`FUNCTIONAL-SPEC.md`, `SLICER-GATES.md`, `TODO.md`, `AGENTS.md`) checked against
the code, by running it.

**Anchored to** `ac6e978eead319488adc0b3f8667e377b3263f84` (2026-08-10 17:20:50
+1000, *"2bee.app: many drawings, each placed and turned"*) — the last commit
touching `software/2bee.app/` when this pass started. Every count below is a
measurement taken at that tree, not a number read out of a document. The tree
moved twice today; treat these as evidence with a timestamp, not as facts.

**Nothing was fixed.** This file is a report. No other file was edited.

## What was actually run

| Command | Result |
|---|---|
| `cargo test --workspace` | **391** passed in `twobee-cam` · **8** in `2bee-slice` (cli) · 0 in `twobee-cam-wasm` · 0 doc-tests. **399 total, 0 failed.** |
| `node gates/slicer_gate_check.mjs --list` | **48** HARD gates |
| `node gates/slicer_gate_check.mjs --quick` | **46 passed · 0 failed · 2 pending** (`I1`, `CTRL`). VERDICT: GO |
| gate `SPEC` (inside that run) | **71 rows, 182 citations all resolve; 3 cite `none`** |
| `grep -cE '^\s*test\(' web/e2e/*.spec.ts` | **54** declared browser tests (1 + 6 + 47), **0** `.skip` |
| `grep -o -- '-picker' web/e2e/*.ts \| wc -l` | **114** |
| Chromium against the running preview on `:4173` | `document.body.innerText.length === 0`, `[data-testid$="-picker"]` count `0`, `PAGEERROR: Error creating WebGL context` |

⚠ **`npx playwright test` could not run:** port `4173` was already served by
another process (`pid 174649`, `vite preview --port 4173`) and the config sets
`reuseExistingServer: false`. I did **not** kill it — another lane may be
mid-run. The browser evidence below was taken by driving Chromium at the
*already-running* server, which starts no second server and binds no port, so it
is not the port collision.

---

## The five most serious findings, worst first

### 1. 🔴 The cutter-reach rule is enforced on one path, not the other

**The finding, in full: the cutter-reach rule is enforced on one tool-selection path and
not on the other — and the browser's default path is the unchecked one.**

**Physical failure: the shank of the cutter is driven into the work. Broken tool,
burnt collet, part thrown.**

`core/src/recommend.rs:651` refuses a cutter whose flute length cannot reach the
depth:

```rust
if spec.tool.cutting_length_mm <= feature.depth_mm {
```

That rule reaches the emitting path **only through `tool_ids`** (the set), which
routes through `recommend`. The singular `tool_id` branch at
`core/src/fixtures.rs:1595` assigns the cutter to every operation directly and
asks `recommend` nothing.

Measured, on the most ordinary inputs this tool has — the default 18 mm plywood
sheet and a 1/8″ down-cut end mill with 12 mm of flute
(`core/src/tools.rs:259`):

```
$ 2bee-slice import gates/fixtures/plate.dxf \
    --config '{"tool_id":"End Mill - Down-cut 3.175mm 2F"}'
rc=0  bytes=32074
import: ok=true cut=17179mm deepest=-18.00mm gouge=0 tabs=10
```

**Exit 0. 32 kB of runnable G-code. No note, no warning, no refusal.** 6 mm of
plain shank is dragged through the ply on every pass.

The same tool, the same drawing, the same depth, named through `tool_ids`:

```
refused: drawing/part1: NO TOOL IN THIS LIBRARY CAN CUT THIS PROFILE.
  - End Mill - Down-cut 6mm 2F: 25mm of cutting length cannot cut 40mm deep;
    the shank would be in the cut
```

**The browser takes the unchecked branch whenever exactly one cutter is
selected** — `web/src/App.tsx:1167`:

```ts
...(toolIds.length > 1 ? { tool_ids: toolIds } : { tool_id: toolId }),
```

So *selecting a second tool turns a safety check on*, and nothing anywhere says
so. An operator cutting one part with one cutter — the commonest job there is —
gets no reach check at all.

**Claims this refutes:**

- `README.md:70` — *"Tool recommendation ✅ per feature: internal radius,
  exact-drill-only holes, **reach**, collet fit … every choice carries its
  reason"*. True of `recommend.rs`; **not true of the program the tool emits**
  on the `tool_id` path.
- `TODO.md` index #9 — *"✅ done … `recommend` runs at plan time and every
  choice's REASON reaches the Notes panel"*. It runs at plan time on the
  `tool_ids` path only.
- `FUNCTIONAL-SPEC.md:228` (C7) ✅ — the citations are all `core:` tests of
  `recommend`'s own front door. None of them asserts that a program **emitted
  through `tool_id`** obeys the rule.
- Gate `TOOL` passes, and its own text says it asserts *"on the EMITTED
  PROGRAM"*. It does — for *no tool chosen* and *an unresolvable id*. It never
  drives a **resolvable id that is the wrong cutter for the depth**, which is
  the case that produces a runnable program.

**Contrast with `P6` (collet vs shank), which IS enforced on the emitting path.**
`machine.collet_mm=8` refuses (rc=1). So two of the four `recommend` rules reach
the program and two do not, and the spec presents all four as covered by one ✅.

**UNKNOWN:** whether the internal-radius and exact-drill rules reach the emitted
program on the `tool_id` path. Settled by running `import` with a `tool_id`
larger than a feature's internal radius and checking for a refusal.

---

### 2. 🔴 `Stock::z_zero_at_top` is inert, and gate `G11` tests a different door

**The finding, in full: `Stock::z_zero_at_top` is inert — the operator can move the Z datum
by a whole stock thickness and the program does not move. Gate `G11`, which exists for
exactly this, tests a different door.**

**Physical failure: every Z word is wrong by one stock thickness (18 mm at the
default). Zeroed on the spoilboard with a program written for the top, the first
plunge is 18 mm into the bed; the other way round the part is never touched.**

Measured:

```
$ 2bee-slice job plate --config '{"stock":{"z_zero_at_top":true}}'  > a.nc
$ 2bee-slice job plate --config '{"stock":{"z_zero_at_top":false}}' > b.nc
$ diff -q a.nc b.nc   →  IDENTICAL
summary: … deepest=-18.00mm   (both)
```

Byte-identical on the `job` path **and** on the `import` path (the browser's
path). The field is:

- declared `core/src/types.rs:532`, defaulted `true` at `:553`
- carried in the config `core/src/fixtures.rs:1259`
- applied `core/src/fixtures.rs:1472` — `set!(d.z_zero_at_top, st.z_zero_at_top)`
- written by the browser `web/src/App.tsx:1145`, from a real checkbox at
  `web/src/App.tsx:2822` (*"Z zero on stock top (else spoilboard)"*)
- **echoed back to the operator as if it took effect** —
  `web/src/App.tsx:2694`: `{ label: 'Z zero', value: d?.zZeroTop ? 'stock top' : 'spoilboard' }`

and **read by no planner, no post and no check.** `grep -rn z_zero_at_top` over
`core/`, `cli/`, `wasm/`, `web/` returns declarations, the config plumbing, the
UI, and one comment. Nothing else.

**The real mechanism is a different field entirely.** `PostOptions::z_offset_mm`
(`core/src/post_grblhal.rs:20`) shifts every emitted Z, and it is reachable from
**one place only** — `cli/src/main.rs:1092`, the `--spoilboard-zero` flag, which
is wired into the **`fixture`** subcommand. `JobConfig` has **no `post`
section**, so neither a config file nor the browser can reach `z_offset_mm` at
all.

**Gate `G11` — *"Z-ZERO SETTING BITES: a setting consumed by nothing reads as
configured"* — passes, and it is testing the flag, not the setting.**
`gates/slicer_gate_check.mjs:368-386`:

```js
const top   = slice(['fixture', 'rect-profile']).stdout;
const spoil = slice(['fixture', 'rect-profile', '--spoilboard-zero']).stdout;
```

The one setting in this repo that is in exactly the state G11's own description
names is the one G11 does not touch. **A gate written for this class, green,
beside the defect.**

**Claims this refutes:**

- `FUNCTIONAL-SPEC.md:204` (B3) — *"Z zero at stock top **or** spoilboard | the
  setting shifts every Z word by one thickness | `G11` | ✅ `G11` compares
  **every** Z word in both programs … **the acceptance verbatim**"*. The
  acceptance names *the setting*. `G11` measures *a CLI flag no host but the
  gate can reach*. This is a false green stated in the strongest available
  language.
- `SLICER-GATES.md:99` — the `G11` row's negative control is listed as
  `` `--spoilboard-zero` diff ``, which is honest about the mechanism and does
  not notice that the mechanism and the setting are two different things.

---

### 3. 🔴 `machine.max_feed_mm_min` is inert on every emitting path

**The finding, in full: `machine.max_feed_mm_min` is inert on every emitting path — its only
production consumer is the advisory `recommend`.**

**Physical failure: the program commands a feed the machine cannot deliver.
grblHAL silently clamps to its own `$110–112`, so the actual chipload is not the
planned one — the cutter rubs instead of cutting, burns the edge, and the
run-time estimate is wrong in the same breath.**

Measured:

```
$ 2bee-slice import gates/fixtures/plate.dxf --config \
  '{"tool_id":"End Mill - Down-cut 6mm 2F","machine":{"max_feed_mm_min":900}}'
F words emitted: F2 F25.0 F200.0 F300.0 F3600.0
```

**F3600 against a declared machine maximum of 900** — 4×, with no clamp, no
note, no warning, and byte-identical output to the unset case.

Consumers of the field, whole tree:

| Site | Kind |
|---|---|
| `core/src/types.rs:340` | declaration |
| `core/src/types.rs:476` | default `6000.0` |
| `core/src/fixtures.rs:1193`, `:1421` | config plumbing |
| `core/src/recommend.rs:540` | **the only production read** — `feed_for(...).min(machine.max_feed_mm_min)`, inside the advisory recommender |
| `core/src/job.rs:2710` | **a test** — inside `#[cfg(test)] mod wiring_tests` (module opens at `core/src/job.rs:2337`) |

So the *test at `job.rs:2710` asserts the property the production path does not
have*: it re-derives `feed_for(...).min(j.machine.max_feed_mm_min)` and compares
it to `op.params.feed_mm_min` — inside a job built by the test's own helper.

**Same class, same sweep — three more settings measured inert on the import path
(gcode AND diagnostics byte-identical):**

| Setting | Status |
|---|---|
| `machine.max_feed_mm_min` | **inert** (above) |
| `machine.spare_collets_mm` | inert on the emitting path — read only by `recommend`/`tools_for_machine` |
| `op.dogbone` | inert — `core/src/fixtures.rs:1663` guards it with `if p.dogbone != DogboneStyle::None`, and the import path never sets a non-`None` dogbone, so the UI's dogbone selector cannot turn relief on for an imported drawing. The guard is *documented and deliberate*; the consequence for the import path is not written down anywhere. |
| `stock.thickness_mm` **on the reference-job path only** | `job plate` pins `depth_total_mm: 18.0` at `core/src/fixtures.rs:555`; `apply` never re-derives it, and `core/src/toolpath.rs:410` only clamps *downward* (`.min(thickness + 0.3)`). So 25 mm and 40 mm stock both cut 18 mm deep, byte-identical. **The import path is correct** (`core/src/fixtures.rs:3684` derives depth from the configured stock — measured −12.00 / −25.00 / −40.00), so this is confined to fixtures. Recorded because `README.md:83`/`web` expose fixture jobs behind `?fixtures=1`. |

**`machine.spindle_max_rpm` is NOT inert — but its warning never reaches the
`import` operator.** See finding 5.

---

### 4. 🔴 Gate `I1` cannot pass on this box, and `README.md` says it went green

**The finding, in full: gate `I1` cannot pass on this box, and `README.md` says it reported
green today. Three ✅ rows and the whole `K` spec table rest on it.**

**Two documents in this tree, both dated 2026-08-10, say opposite things.**

`README.md:84`:

> **376 Rust unit tests** and **49 browser tests**, both measured 2026-08-10 by
> running them — `cargo test -p twobee-cam` and gate `I1`, which reports
> `browser suite green (49 tests)`.

`SLICER-GATES.md:1143`:

> 🔴 **I1 CANNOT PASS ON THIS BOX TODAY** … Every one of the 49 browser tests
> fails, across all three spec files … Chromium cannot create a WebGL context at
> all, so `three.js` throws at boot and React unmounts — `document.body` renders
> 0 characters.

**I measured it myself rather than pick a side.** Driving Chromium at the
already-running preview server:

```
body text length = 0
picker count     = 0
CONSOLE: THREE.WebGLRenderer: A WebGL context could not be created …
PAGEERROR: Error creating WebGL context.
```

`SLICER-GATES.md` is right. `README.md:84` asserts a green string
(`browser suite green (49 tests)` — the literal format string at
`gates/slicer_gate_check.mjs:3625`) that the gate cannot have produced today.
The `--quick` run I did reports `PENDING I1`.

**What rests on it:**

| Claim | Where |
|---|---|
| Web UI ✅ — viewport, panels, program map, samples, gate instruments | `README.md:77`, check `I1` + the browser suite |
| Object picker ✅ — one list per panel, seven surfaces | `README.md:78`, check `I1` + "111 `-picker` references" |
| WASM build ✅ — browser runs the same core | `README.md:76`, check `K3` `I1` |
| `I1` spec row ✅ — *"renders without WebGL errors"* | `FUNCTIONAL-SPEC.md:308` — **the acceptance is literally the thing that fails** |
| `K3` ✅ *"the browser produces the same G-code as the CLI"* | `FUNCTIONAL-SPEC.md:331` |
| `K4` ✅ *"canvas renders, no console errors, geometry present"* | `FUNCTIONAL-SPEC.md:332` |

🔴 **And the `K` table is structurally invisible to gate `SPEC`.** `specRows()`
at `gates/slicer_gate_check.mjs:3427` does `header.indexOf('Gate')` and skips any
table where that is `-1`. The `K` table's header is
`| # | Feature | Acceptance | Status |` — **no `Gate` column**. So `K1`–`K4` are
four ✅ claims that `SPEC` can never check, by construction, and two of them are
false today. `K2` (*"every HARD gate has a plant"*) is false on its face as well:
gate `PLANT` reports **20 plants** against **48 gates**, and `SLICER-GATES.md`'s
own table lists non-plant controls for `G1`, `G10`, `G14`, `K3`, `SPEC`.

⚠ `TODO.md`'s audit note already says *"Every `gate I1` citation in this table is
currently PENDING, not green"* — so `TODO.md` is honest and `README.md` is not,
about the same gate, on the same day.

---

### 5. 🔴 `clearance_z` lifts nothing, and four places say it does

**The finding, in full: `clearance_z` lifts nothing, and three doc sites plus an
operator-facing string say it lifts every rapid.**

**Physical failure: an operator who believes the tool flies over their clamps
sets a 40 mm cam clamp and expects clearance. What actually happens is a
refusal — safe, but not what was promised — and if the check is ever narrowed,
there is no lifting behaviour underneath it to fall back on.**

`Fixturing::clearance_z` (`core/src/fixture.rs:193`) has **exactly one
non-test caller**: `core/src/fixture.rs:229`, inside `check`, where it is a
**comparison threshold** for `RapidBelowClamp`. It never sets a Z.

Every rapid Z in the emitted program comes from `machine.safe_z_mm` alone:

```
core/src/toolpath.rs:430, 664, 691, 719, 800   Move::rapid(… machine.safe_z_mm)
core/src/post_grblhal.rs:781, 942, 1140        G0 Z{safe_z_mm + z_offset_mm}
```

**Comments and copy that assert otherwise:**

| Site | Text |
|---|---|
| `core/src/fixture.rs:165` | *"`clearance_z` takes the TALLEST clamp and **lifts every rapid above it**"* |
| `core/src/fixture.rs:428` | *"`clearance_z` **lifts every rapid** above the tallest clamp"* |
| `web/src/workholding.ts:325` | *"height_mm = 50 makes `clearance_z()` **demand 50 − 18 + 2 = 34mm on EVERY** …"* — **operator-facing catalogue text, and `workholding.ts` IS imported by `App.tsx`** |
| `web/src/workholding.ts:354`, `:594` | same shape |
| `FUNCTIONAL-SPEC.md:256` (E3) | Feature: *"Toolpaths **route around keepouts**; **rapids cross above clamp height**"* — ✅, cited `P7`. **Neither clause is true.** The toolpath does not route around a keepout (it refuses), and rapids do not cross above clamp height. The ✅ is carried by the narrowed Acceptance (*"a cutting move inside a keepout is refused"*), which `P7` does prove — so the row is green on a promise the Feature column does not make. |

`FUNCTIONAL-SPEC.md:253` (E1) gets this right and says so at length — the `P7`
gate *"never triggers `RapidBelowClamp`"* — so the correction exists three rows
above the row that still carries the claim.

---

## Everything else found, by document

### `README.md`

| Line | Claim | Measured |
|---|---|---|
| 84 | *"**376 Rust unit tests**"* | **391** in `twobee-cam` (+8 in the cli crate = **399**). Row already warns it goes stale; it did, inside a day. |
| 84 | *"**49 browser tests**"* | **54** declared (`test(` in the three spec files; 0 `.skip`). **0 passing** — see finding 4. |
| 84 | *"gate `I1`, which reports `browser suite green (49 tests)`"* | 🔴 false today — finding 4. |
| 83 | *"Gates: **37 HARD** as of 2026-08-08 23:05"* | **48**. The row explicitly says *"take it from `--list`, never from this row"*, which is the right defence; the number is 11 out. |
| 78 | *"111 `-picker` references in `web/e2e/`"* | **114**. |
| 78 | *"`SavedSet` … **is deleted**"* | ✅ correct — the three surviving mentions in `web/src/App.tsx` (252, 2588, 2847) are prose recording the deletion, not code. |
| 74 | *"helical entry is REFUSED as unimplemented"* | ✅ correct — `op.entry=Helix` → rc=1 on the import path; gate `ENT` asserts it. |
| 74 | residual noted: *"`rect_profile.rs` … still matches `Ramp \| Helix` together at line 160"* | ✅ still true at `core/src/rect_profile.rs:160`. |
| 67 | STL 🟡 *"12 `core:` tests, no gate"* | UNKNOWN — not counted this pass. Settled by `cargo test -p twobee-cam mesh`. |
| 82 | Theme 🟡 *"No gate watches any of this"* | ✅ correct; there is no `G-THEME` in `--list`. |

**Not stale, worth recording as still-true:** *"Nothing here has cut anything"*
(`README.md:86`) and `CTRL` PENDING — the `--quick` run confirms
`PENDING CTRL … no controller transcript in the tree`.

### `FUNCTIONAL-SPEC.md`

- **Counts are right:** gate `SPEC` measured **71 rows, 182 citations, 3 `none`**,
  which matches the brief. `SPEC` proves each citation **resolves** and — worth
  noting, because it is better than the header claims — it also catches
  `` `none` `` beside a ✅ (`gates/slicer_gate_check.mjs:3477`).
- **`B3` (line 204)** — false green, finding 2.
- **`E3` (line 256)** — Feature column asserts behaviour that does not exist,
  finding 5.
- **`C7` (line 228)** — ✅ for `recommend`'s front door; silent on the emitting
  path, finding 1.
- **`I1` (line 308), `K1`–`K4` (lines 329–332)** — finding 4.
- **`G-12` (line 290)** already records its own contradiction: *"the third pass
  above SAID this row lost its ✅ and the row still carried one"*. **Still
  unresolved** — line 77 names `A5`, `F2`, `G-5`, `G-12` as four downgrades and
  three were made.
- **`B4` (line 205)** — the `core:the_material_reaches_the_emitted_feed` case the
  brief asked about is **already found and correctly downgraded to 🟡**. Verified
  at `core/src/job.rs:2279`: the body does filter `r.path.moves`, i.e. the plan.
- 🔴 **A sibling of that shape, not cited anywhere and therefore not caught:**
  `core/src/job.rs:1939` `a_quarter_turn_moves_the_program_not_only_the_picture`
  walks `r.path.moves`, while its name and its own comment say *"the COORDINATES
  that reach the controller"*. It is also only an `assert_ne!` — "they differ" —
  which a rotation about the wrong pivot or a sign flip satisfies just as well.
  Low impact today (nothing cites it); recorded because it is the exact pattern
  `B4` was downgraded for, in a test named the same way.
  *(`core/src/fixtures.rs:5907` and `:5942`, the multi-drawing pair, DO read
  `.gcode` — they are the counter-example and are fine.)*

### `SLICER-GATES.md`

Every gate in `--list` was looked for in this file.

- 🔴 **`BRND` appears nowhere in it — zero mentions.** It is armed and passing
  (`PASS BRND VENDORED BRAND MARK 2 vendored mark(s) match …`). The file that
  `AGENTS.md` names as reading-order #2, *"what 'done' means"*, does not know it
  exists.
- 🟡 **`DINV` and `CTRL` have no row in any of the three gate tables.** Both are
  discussed in prose (`DINV` at lines 701, 709, 725, 845; `CTRL` at 73, 1238,
  1312), so a reader can find them — but the tables are what a reader counts.
- **Table arithmetic:** *"HARD gates — implemented and armed"* (line 79) lists
  **18**; *"Previously PENDING — all now armed"* (line 954) lists **12**;
  *"Armed later still"* (line 974) lists **15**. **45 of 48.**
- ✅ **`I1`'s WebGL section (lines 1141–1171) is accurate and current** — I
  reproduced it independently. It is the best-calibrated claim in the tree today.
- ✅ Gate descriptions checked against what each now asserts: `G11`'s row is
  honest about its mechanism (`--spoilboard-zero` diff) even though the
  mechanism is the wrong door; `P7R`, `REL`, `MOVE`, `MULTI`, `PLANT`, `PROBE`
  rows match their `--list` text and their gate output.

### `TODO.md`

Rows measured against the code. **Four stale reds** (the class this file's own
audit note says is the harder half) and **one stale count**:

| Row | Says | Measured |
|---|---|---|
| **#45** | *"`MESH_SAMPLES` has no consumer — four STL samples nothing renders \| ⬜ open"* | 🔴 **STALE.** `web/src/App.tsx:2` imports it and uses it at `:993`, `:1477`, `:1660`, `:1743`. |
| **#34** | *"catalogue WRITTEN, not OFFERED — **Nothing imports either file**"* | 🔴 **STALE.** `workholding.ts` is imported by `web/src/App.tsx` and `web/src/store.ts`; `workholdingShape.tsx` by `App.tsx`. |
| **#35** | *"same shape as #34 … `materials.ts` … **has no importer**"* | 🔴 **STALE.** Imported by `web/src/App.tsx`. |
| **#37** | *"⚠ `touchplates.ts` reaches the app through nothing (`touchplateShape.tsx` has no importer either)"* | 🔴 **STALE.** `touchplates.ts` ← `touchplateShape.tsx`, `store.ts`, `App.tsx`; `touchplateShape.tsx` ← `App.tsx`. |
| **#50** | *"e2e `the sheet can be turned by its handle` fails, unattributed \| ⬜ open"* | 🟡 The test no longer exists. #1b records the handle's removal and the e2e being **inverted** onto `web/e2e/slicer.spec.ts:1113` (`not.toHaveAttribute('data-rotate-handle')`). An open row for a deleted test. |
| **#14** index + Done table | *"gate SPEC: **68 rows, 137 citations**"* | **71 rows, 182 citations** (measured). |
| **#14** Done table | cites `gates/slicer_gate_check.mjs:1475` for SPEC | 🔴 **wrong line.** 1475 is inside `P7R`'s clamp-echo limb. `SPEC` starts at `gates/slicer_gate_check.mjs:3321`. |
| **#52** | *"I1's count goes 37 → 43"*; audit note *"41 tests, was 37"* | **54** declared. |

**Confirmed still-true reds, not stale:** #16 (physical rungs unclimbed — `CTRL`
PENDING agrees), #31/#54 partial (superseded by today's `MULTI` gate, which
passes), #38 and #43's unsourced-default halves, #33 founder decision.

### `AGENTS.md` (= `CLAUDE.md`)

- ✅ Every CLI invocation in the Tooling block runs: `fixtures`, `fixture
  rect-arcs`, `fixture rect-profile --plant deep` (rc=1, refuses as documented),
  `import … --format stl --z`, `--list`, `--quick`.
- 🟡 *"Gates from `--list` (**37** and moving — it changed twice inside one
  audit)"* → **48**. The instruction beside it (*count by running*) is right and
  is what this pass did.
- 🟡 *"unit tests from `cargo test` (**237**, and it was 226 twenty minutes
  earlier)"* → **399**.
- ✅ The `brand/tokens.css` bullet's correction is current: `web/src/styles.css`
  does import the tokens, and the six move-class colours are local by brand
  ruling.

---

## Cross-cutting shapes, for whoever fixes these

1. **A control an operator can change that changes nothing** — gate `G11` exists
   for this class and is armed on the one instance that *is* wired
   (`--spoilboard-zero`) rather than on the instance that is not
   (`z_zero_at_top`). The class now has **four** members measured here:
   `stock.z_zero_at_top`, `machine.max_feed_mm_min`, `machine.spare_collets_mm`
   (emitting path), `op.dogbone` (import path). A generalised form of my sweep —
   vary one config field, require the emitted program **or** the diagnostics to
   move, allowlist the ones that legitimately should not — would have caught all
   four and would catch the next one.

2. **A rule enforced through one door and not the other.** `recommend`'s four
   rules: collet reaches the program, **reach does not**. The `import`
   subcommand prints `notes`/`errors`/`refusals` and **not `r.warnings`**
   (`cli/src/main.rs:875–885`), while `job`/`report` print all four — so gate
   `SPIN`, which reads `stderr` from the **`fixture`** path, is green about a
   warning that the **`import`** path silently drops. Measured:
   `machine.spindle_max_rpm=9000` → `S18000` emitted, warning present in the
   `--json` report and absent from `import`'s human output. *(The browser is
   fine — `web/src/App.tsx:4433/4444` renders `report.warnings`.)*

3. **A ✅ carried by a narrowed Acceptance while the Feature column still
   promises more** — `E3` is the clean case. The gate proves the Acceptance; the
   reader reads the Feature.

4. **A table with no `Gate` column is invisible to `SPEC` by construction** —
   the `K` table. `SPEC` skipping it is deliberate and documented; nothing warns
   that four ✅ rows live there.

---

## UNKNOWN — what this pass could not settle, and what would settle it

| Question | What would settle it |
|---|---|
| Do the **internal-radius** and **exact-drill** rules reach the emitted program on the `tool_id` path, or are they in the same state as reach? | `import` a drawing with an internal radius smaller than a `tool_id` cutter and check for a refusal. |
| Does the full gate (`I1` + `K3` byte-parity) pass on a box with working WebGL? | Run `node gates/slicer_gate_check.mjs` where `swiftshader` initialises. Nothing in this tree can answer it. |
| Is the `54` browser-test count the number `I1` would report? | `I1` parses its own count from the Playwright output; 54 is `test(` occurrences. They can differ if a `describe` parameterises. Settled by one green `I1`. |
| README `:67` — *"12 `core:` tests"* for STL | `cargo test -p twobee-cam mesh` and count. |
| Whether `metal-nest-a1.dxf` is a real `hardware/cad` file (README `:77`, *"three **real `cad` DXFs**"*) | Diff against `hardware/cad/`. Out of this lane's tree. |
| Who is serving `:4173` | `pid 174649`. Not killed — another lane may be mid-run. |
