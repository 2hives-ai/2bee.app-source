# Gate integrity audit — who watches the watchmen

**Date:** 2026-08-10 · **Scope:** all 48 gates in `gates/slicer_gate_check.mjs`
**Measured against:** binary `ca90c71cf2a6`, core `BUILD_ID a15d548c1008` (22 files under `core/src`)
**Method:** read every gate limb; ran the full gate and `--quick` on this tree; drove the CLI directly
where a claim needed checking; recomputed the core fingerprint independently.

> This audit **fixes nothing**. Every finding is stated with the artefact it was measured at.
> Where a claim in `SLICER-GATES.md` or `AGENTS.md` is contradicted by the code, the code is quoted.

---

## 0. The two runs, side by side — this is the headline

Both runs are of the **same tree, same binary, minutes apart**:

```
$ node gates/slicer_gate_check.mjs
================ 46 passed, 1 failed, 1 pending ==========
NOTE: 1 gates cannot run yet. They are NOT green — see SLICER-GATES.md.
VERDICT: NO-GO                                            (exit 1)

$ node gates/slicer_gate_check.mjs --quick
================ 46 passed, 0 failed, 2 pending ==========
NOTE: 2 gates cannot run yet. They are NOT green — see SLICER-GATES.md.
VERDICT: GO                                               (exit 0)
```

🔴 **`--quick` did not skip a check. It converted the only failing gate into a PENDING one and
turned NO-GO into GO.** The cause is one line:

```js
// gates/slicer_gate_check.mjs:4026
console.log(`VERDICT: ${failed === 0 ? 'GO' : 'NO-GO'}`);
process.exit(failed === 0 ? 0 : 1);
```

`pending` is counted, printed in a NOTE, and then **discarded before the verdict**.

Why this is the most serious finding in the file rather than a cosmetic one: this lane's own rule is
*"the control asserts the **VERDICT** line, not the gate's own message"* (`SLICER-GATES.md` §2,
`AGENTS.md` Mission duty 2). **Every negative control in this suite therefore asserts a line that is
blind to PENDING.** Any defect that disarms a gate into PENDING instead of FAIL is asserted *green*
by the very mechanism built to catch it.

The lane has already watched this happen and recorded it, one gate wide:

> *"Found by planting it: stripping the hash line turned this gate PENDING and the run still said
> VERDICT: GO. So the one edit that permanently disarms this check was the one edit it waved
> through."* — `slicer_gate_check.mjs:3971`, gate BRND

BRND was fixed by making **that one branch** FAIL instead of PENDING. The structural hole was not
closed. It is still reachable from at least five places today:

| Route to PENDING | Reachable how | Verdict today |
|---|---|---|
| `I1` | `--quick` | **GO**, browser layer entirely unrun |
| `CTRL` | permanent — no transcript in `gates/controller/` | **GO** (this is by design and honest, but it is the same blindness) |
| `K3` | delete/never build `web/src/wasm` → `pend()` at `:3559` | **GO** |
| `BRND` | brand's master path moves or is deleted → `PENDING` at `:3990` | **GO** |
| `P7R` | remove `rotation_deg` from `ClampCfg` → reachability probe returns PENDING (documented, `SLICER-GATES.md:940`) | **GO** |

**Recommendation (not applied):** `VERDICT: GO` should require `failed === 0 && pending === 0`, or
introduce a third verdict (`GO-WITH-GAPS`) that is not the string a control is allowed to assert.
Until then, no `--quick` result may be quoted as a gate result, and **a PENDING gate must be read as
a red for reporting purposes.**

---

## 1. `--quick`, audited honestly

`QUICK` appears in exactly three places (`:31`, `:157`, `:3601`). It skips:

1. **`cargo build --release`** (`:157`) — the release binary is *not* rebuilt.
2. **The wasm rebuild + `wasm-bindgen` + the whole Playwright suite** (`:3601`), and reports
   `I1 → PENDING` with the message *"skipped by --quick, which is not a pass"*.

Two consequences, only one of which is documented:

- ✅ **Documented:** I1 is not run. `SLICER-GATES.md:1174` says so.
- 🔴 **NOT documented, and it is the worse one: `--quick` produces a MIXED evidence set and nothing
  detects the mismatch.** `cargo test --workspace` runs **unconditionally** (`:169`) and compiles the
  **current source**. Every other gate drives `target/release/2bee-slice`, which under `--quick` may
  have been built from anything. So G0 can be green about today's source while 45 gates are green
  about last week's binary.
  - `G14` does not close this: it hashes the same file at the start and the end of the run
    (`:412`), which detects a rebuild *during* the run, not staleness *before* it.
  - `K3` does not close this either: it compares the **CLI's** `BUILD_ID` to the **wasm's**. Two
    equally stale artefacts agree perfectly — which is the exact failure K3 was written for, one
    level up. **Nothing compares the binary's `BUILD_ID` to a fresh digest of `core/src`.**
  - This is cheap to close. I recomputed `core/build.rs`'s FNV-1a/64 + splitmix finalisation in
    Python over the 22 `.rs` files under `core/src` and got **`a15d548c1008`**, byte-identical to
    `2bee-slice buildid`. A ~20-line limb comparing those two would make `--quick` self-declare
    staleness.

⚠ **The mistake to avoid, since it was made today:** a `--quick` GO says nothing about the browser,
and **a browser number from an earlier run is not evidence for the current one** — I1 rebuilds the
wasm before it runs, so the two runs are not even testing the same artefact.

---

## 2. Which gates have a control that has actually been seen RED

**Criterion used:** a transcript exists **in the tree** — in `SLICER-GATES.md` or in a commit body —
showing that gate's own `FAIL <ID>` line. Not "a plant exists"; not "a control is described".

### Answer: **17 of 48.**

```
BRND  DINV  DOC  ENT  FLAG  G0  K3  P3  P5  P7R
PLANT PROBE REL  RPRB SPEC  SPIN TOOL
```

**31 of 48 have never been observed red anywhere in the tree:**

```
G1 G2 G3 G4 G5 G6 G7 G8 G9 G10 G11 G12 G13 G14
P1 P2 P4 P6 P7 P8 P9 MOVE MULTI B2B4 TECH C6 MARK LEAD F1 I1 CTRL
```

### The important distinction inside that 31

12 of them carry a **live registered plant** that gate `PLANT` re-verifies for non-vacuity on every
pass (`G3 G4 G5 G6 G8 P1 P2 P6 P7 P9 MOVE MULTI`). That is a running control and it is worth a lot —
but note carefully what it is:

> For the refusal-style gates (`G3 G4 G6 G8 P5 P6 P7 REL PROBE`), **the plant is the INPUT that must
> be refused, not a defect that makes the gate go red.** `--plant offbed` makes G3 *pass*. G3 goes red
> only if the product's travel check breaks — and **nobody has ever watched that happen.**
> `SLICER-GATES.md`'s HARD-gate table heads its Negative-control column with *"Each has been seen going
> red"*, and for these rows the column holds the input, not a red.

The remaining **19 have neither a plant nor a recorded red**: `G1 G2 G7 G9 G10 G11 G12 G13 G14 P4 P8
B2B4 TECH C6 MARK LEAD F1 I1 CTRL`. Several are self-evidently red-able by construction (G1's
three-run hash, G12's exact `rpm × flutes × chipload`, G11's exact 18.000 shift, G14's hash pair).
The structurally weak ones are in §4.

### The negative-control column is partly the check restated

In the `## HARD gates` table, these entries are **descriptions of the assertion**, not negative
controls: `build break` (G0), `3-run hash compare` (G1), `banned-word scan` (G2), `drill fixture`
(G9), `median-segment math` (G10), `exact rpm x flutes x chipload` (G12), `stdout must be empty`
(G13), `hash at start and end` (G14), `transformed hole positions` (P8), `arc count with and without
leads` (LEAD), `marking moves at engraving depth` (MARK). A column that sometimes holds a control and
sometimes holds a restatement of the check reads uniformly as "controlled".

### The commit-body rule

`SLICER-GATES.md` §2 requires the red run in the **commit body**, and gives the `gcommit -F` mechanism.
Measured across the **194** `slicer:`/`2bee.app:` commits in the last 2000: **11 carry a
`VERDICT: NO-GO` transcript.** The most recent is
`d8b4046db2` (2026-08-09, BRND). **All 38 lane commits since then carry none** — including
`ac6e978eea`, which armed gate **MULTI** (the 48th gate), and `7cdbff1cb7`, which built **MOVE**.
The doc records three misses as a known defect; the true figure is that the rule has been unobserved
for the whole of the most recent 38-commit run.

---

## 3. Vacuous assertions, gates that can only pass, and gates that read the plan

### 3.1 🔴 `MOVE` cites four witnessed reds that do not exist

`SLICER-GATES.md:990` ends MOVE's row with **"Four witnessed reds below."** There is no MOVE section
below it, and no `FAIL MOVE` transcript anywhere in the repository — not in `SLICER-GATES.md`, not in
any commit body. Verified with `grep -oE 'FAIL +MOVE'` across `SLICER-GATES.md` and 2000 commit
bodies: zero hits.

This is precisely the defect gate **SPEC** exists to prevent — a row citing evidence that does not
resolve — arriving in the document SPEC does not scan. **SPEC parses `FUNCTIONAL-SPEC.md` only**
(`:3351`). `SLICER-GATES.md`, the document that states which gates are armed and where their reds
are, **is checked by nothing.** The gate implementation itself (MOVE, `:519–715`) is one of the best
in the file; it is the evidence citation that is empty.

⚠ Related, same shape: **MULTI's** "two witnessed reds" (`:1024`) are `cargo test` failure counts and
a CLI `exit=/bytes=` pair — real evidence, but **not a gate `FAIL` line and not a `VERDICT` line**,
which is what §2 requires a control to assert.

### 3.2 🔴 `P4` — the count is still read off the PLAN, and the doc says the opposite

`SLICER-GATES.md:113` states P4 *"now counts relief bores in the EMITTED G-code, and the reported
figure is derived from the moves rather than from the plan."* Measured, both halves are wrong for the
gate as written:

```js
// slicer_gate_check.mjs:1201
if (socket.dogbones === 4 && plate.dogbones === 0 && bores >= 8) {
```

- `socket.dogbones` / `plate.dogbones` are scraped from stderr `dogbones: N`, emitted by
  **`cli/src/main.rs:1245` — `eprintln!("dogbones: {}", built.dogbones.len())`**. That is
  `BuiltJob::dogbones`, i.e. **the plan**. The 4-and-0 assertion — the whole substance of the gate —
  never touches the program.
- `bores` counts **every** `^G98 G8[123]` line in the socket program. Measured today: the socket
  emits exactly 8 canned cycles — 4 drill holes at `F300` and 4 relief bores at `F3600`. The check
  `bores >= 8` **cannot distinguish a relief from a drill hole.** A socket fixture that gained four
  more holes and lost every relief would satisfy it.
- A relief-selective, program-derived count **already exists one field away** and the gate does not
  use it: `core/src/fixtures.rs:2767` counts
  `m.kind == MoveKind::DrillCycle && m.text == "relief"`, under a comment reading *"🔴 Counted from
  the EMITTED MOVES, not from `built.dogbones`."*

### 3.3 🔴 `P8` — no negative control, and it tests a function that exists only for the gate

```js
// slicer_gate_check.mjs:1513
const moved    = slice(['nest-check', '30', '500', '400']);
const identity = slice(['nest-check', '0', '0', '0']);
if (moved.code === 0 && identity.code === 0 && /4 holes/.test(moved.stdout)) {
```

- The gate asserts **two exit codes and one substring**. The position check it advertises
  (*"at the transformed positions"*) happens inside `core/src/fixtures.rs::nest_check`, whose doc
  comment opens `/// Gate P8: …` — **a core function written for, and reachable only by, this gate.**
- The hazard P8 names is `build_nest.py` dropping internal holes, and `SLICER-GATES.md:994` calls P8
  *"the highest-consequence one on the list"*. **Nothing in the product path is exercised.** A
  transform in `plan_report_import_many` / the `nest` path that lost interior geometry would leave
  P8 green, because P8 re-implements the transform on `plate()` and checks its own arithmetic.
- The `identity` limb (`nest-check 0 0 0`) is decoration: with `rot=dx=dy=0` the expected position
  equals the original by construction.
- `/4 holes/` also matches `14 holes`.
- **No plant, no failing input, no way to make it red on demand.** It is not in the registry
  (`2bee-slice plants` lists 20; P8 is not among their `gate=` fields).

### 3.4 🔴 `TECH` — a gate whose named failure has no reachable input

```js
cnc = JSON.parse(slice(['dialect-rules', 'cnc']).stdout);
fdm = JSON.parse(slice(['dialect-rules', 'fdm']).stdout);
… cnc.implemented === true && cnc.has_post === true
… fdm.implemented === false && fdm.has_post === false
… banned lists mention 'extruder' / 'spindle'
```

- Every assertion is on a **metadata dump**. Nothing is posted, nothing is refused, no program is
  read. This is the exact shape `AGENTS.md` bans: *"assert on the EMITTED PROGRAM, never on the
  setting that was supposed to produce it."*
- `Technology::Fdm` is reachable from **exactly one place in the entire CLI** — the `dialect-rules`
  reporting subcommand (`cli/src/main.rs:900`). No `job`, `report`, `import`, `nest` or `fixture`
  path takes a technology. So *"an unimplemented process posted as CNC"* **cannot occur**, and the
  gate cannot go red for the reason it exists.
- Its stated control (*"`Technology::Fdm` must refuse"*) is a restatement of one of its own limbs.
- The seam's real exercise is a second `Post` implemented **inside a Rust test module**
  (`core/src/post.rs`) — which PLANT's own note names as the largest remaining hole in the evidence:
  *"Negative controls written inline inside a test are outside this gate entirely."*

### 3.5 Gates still reading the plan rather than the emitted program

The lane counts six historical instances (P3, P4, ENT, `JobSummary`, REL, `wrong-drill`). These are
live today:

| Gate | What it reads | Layer | Why it matters |
|---|---|---|---|
| **P1** TABS | `tabs: lifts=N` from stderr | `count_tab_lifts(&r.path)` — `cli/src/main.rs:1276`, walks `path.moves` **before the post** | P1 guards *"untabbed parts break loose into a 2.2 kW spindle"*. Its sibling **REL**, guarding the *same physical failure*, deliberately reads `( op: … )` sections out of the emitted G-code. A post that dropped or mis-emitted the tab lifts leaves P1 green. `path.moves` is named in `AGENTS.md` as one of the four defects this rule exists for. |
| **P4** DOGBONE | `built.dogbones.len()` | the plan | §3.2 |
| **MARK** | `report.render[]` | built from `r.path.moves` (`core/src/fixtures.rs:2642`), plus `tools_used` metadata | The threshold (`shallow.length > 20`) is arbitrary and the array is the **viewport preview**, not the program. No plant. |
| **B2B4** datum limb | `base.gcode !== moved.gcode` | program, but **direction and magnitude unasserted** | The pass message claims *"the datum shifts the program"*; any change to any byte satisfies it. G11, thirty lines away, asserts the shift is **exactly 18.000** on every Z word. B2B4's material limbs read `notes` strings. No plant. |
| **C6** | `notes` contains *"is invalid"* / *"NOT added"* | note strings | Measured: `report plate --config` with the invalid tool actually returns `ok=false`, `gcode` **0 bytes**, and a refusal. The stronger fact is available and unused. |
| **F1** | `/with (\d+) interior feature/` from the import note | the importer's own count | F1's `agree` limb (DXF gcode === SVG gcode) *is* program-derived and is the good half. The hole count is not: an importer that reports 4 and a planner that drops one leaves F1 green. |

### 3.6 Limbs with no paired positive

- 🔴 **`G8` (ARC PRECONDITION)** — the only refusal gate in the G-series with **no clean-run limb**:
  ```js
  const planted = slice(['fixture', 'rect-arcs', '--plant', 'arc-first']);
  if (planted.code !== 0 && /before any positioning/.test(planted.stderr))
  ```
  G3, G4, G6, P6, P7 all assert `clean.code === 0` and emit a distinct `STUCK RED` message when they
  do not. G8 does not. It is *incidentally* covered because G7 runs `rect-arcs` clean four gates
  earlier — which is exactly the reasoning `SLICER-GATES.md` rejects for P3:
  *"Incidental coverage under another gate's name is not the same fact as a gate."*
- **`G13` (FAIL CLOSED)** is asserted on **one** refusal path (`--plant offbed` on `rect-profile`),
  while the codebase now has ~20 refusal sites. This is largely compensated — P5, MULTI, MOVE, TOOL,
  PROBE, REL and P7R each independently assert empty stdout — but G13's own message
  (*"a rejected program emits no G-code at all"*) is a universal claim proved on one sample.

### 3.7 Narrow holes in `PLANT` itself, beyond the three it already declares

`PLANT` declares three limits (§ *What PLANT does NOT cover*): it proves a plant still changes
something not that the change is the right defect; it is CLI-only; inline-in-test controls are
outside it. Two more, found here:

1. **Limb 2 is a text search over the whole file, not over the gate the contract names.**
   ```js
   const driven = new Set([...src.matchAll(/'--plant',\s*\n?\s*'([a-z0-9-]+)'/g)].map(m => m[1]));
   … if (p.gate !== 'NONE' && !driven.has(p.name)) problems.push(…)
   ```
   The contract's `gate=` field is never used to locate the invocation. If gate X's literal is
   deleted while gate Y drives the same plant, limb 2 is satisfied and X is silently unarmed. (Red
   **D** in `SLICER-GATES.md` proves the *converse* — that RPRB staying green is caught — not this
   direction.)
2. **Limb 3's `refuses` arm accepts any non-zero exit with empty stdout.** It does not check the
   refusal is *about the planted defect*. A binary that started refusing `plate` for an unrelated
   reason would satisfy every `refuses` contract at once. (The consuming gates do check the message —
   `G3` for `outside X travel`, `P7` for `CutsClamp` — so this is covered in practice, but PLANT's
   own green does not carry it, and PLANT's green is the one quoted as covering the others.)

### 3.8 Minor / cosmetic

- `slicer_gate_check.mjs:3930` — the `// --- PENDING gates ---` section marker has been concatenated
  onto the BRND comment on one line.
- `:4003–4007` — the backfill loop `if (kind !== 'PENDING') continue;` is **dead code**: all 48 rows
  in `GATES` are `HARD`.
- `I1`'s red is uninformative. Today's full run printed:
  `FAIL I1 BROWSER PARITY + UI browser suite errored: ours-are-untouched-chromium/trace.zip`
  The `catch` branch's `/(\d+) failed/` did not match, so the message fell through to
  `txt.slice(-300)` — a trace filename. A reader gets neither the failure count nor the cause, and
  the cause (§5) is not a code defect at all.

---

## 4. The three weakest gates

### 1. `P8` — NEST TRANSFORM

Asserts two exit codes and the substring `4 holes`, against a core function that exists solely to be
gated. **No plant, no failing input, no product path.** The hazard it names — nest output losing
interior geometry — is untouched by it. `SLICER-GATES.md` calls it the highest-consequence gate on
the list, and it is the one that most closely resembles the historical
*"a limb asserting only `exit === 0`"*. It is currently the closest thing in the file to a gate that
**can only pass**.

### 2. `TECH` — TECHNOLOGY SEAM

Asserts a metadata dump (`implemented`, `has_post`, two ban-list substrings) and nothing else. The
failure it names is unreachable: no product path accepts a technology, so no job can be posted as the
wrong one. Its declared control restates one of its own limbs, and the real seam test lives inline in
a Rust test module, which `PLANT` names as the largest hole in this suite's evidence. It reads a
setting — the defect this lane has now been bitten by six times.

### 3. `P4` — DOGBONE RELIEF

Its substantive assertion (`4` on a socket, `0` on a plate) comes from `built.dogbones.len()` — **the
plan** — while `SLICER-GATES.md` states the opposite in print. Its one program-derived limb counts
*all* canned cycles and cannot tell a relief bore from a drill hole; the socket's 4 drill holes
supply half the threshold. A relief-selective count derived from the moves already exists in the core
and is not used. No plant. This is a stale ✅ **and** a stale claim about a fix, in the family the
lane's own rule was written for.

**Runners-up, in order:** `P1` (highest physical consequence of any gate here, and the only evidence
it reads is `path.moves`, pre-post — while REL, guarding the same failure, reads the emitted
sections); `MARK` (viewport preview array + arbitrary threshold, no plant); `B2B4` (a datum limb that
accepts any change to any byte, next door to G11 which asserts the exact shift).

---

## 5. What the WebGL outage costs, precisely

**State, re-confirmed today:** the full run reports `FAIL I1`. Chromium on this box cannot create a
WebGL context (`GL_VENDOR = Disabled`), `three.js` throws at boot, React unmounts, and no control
exists for any test to find. `web/e2e/` declares **54 `test(` titles** across three spec files
(`slicer.spec.ts`, `persistence.spec.ts`, `dev-server.spec.ts`). **Zero of them are passing.**

🔴 **First correction: `SLICER-GATES.md:1171` says *"I1 is PENDING"*. It is not.** The code can only
report I1 as PENDING under `--quick` (`:3636`); in a full run every path through the I1 block calls
`fail()`. The doc's claim is wrong in form, and wrong in the direction that matters — because a
PENDING I1 would be waved through by the verdict (§0), while a FAIL I1 correctly blocks it. The
current behaviour is the safe one; the document describes the unsafe one.

### Guarantees that are unproven while the browser cannot run

| Claim | Cited to | Status today |
|---|---|---|
| **Browser and CLI emit byte-identical G-code** — the gate table's entire description of I1, and the reason `AGENTS.md` says *"one core, three hosts"* | `e2e:"the browser and the CLI emit byte-identical G-code"` (spec **I5**) | **UNPROVEN.** The parity test carries its own negative control and neither runs. |
| **The viewport draws imported geometry where the machine will cut it** | `data-part-bbox`, browser assertion (`SLICER-GATES.md:1215`) | **UNPROVEN.** MOVE proves the drag reaches the *program*; the picture is browser-only. |
| **P7R's turned clamp is actually drawn turned** | *"That leg is I1's"* (`SLICER-GATES.md:946`) | **UNPROVEN.** P7R limb E proves the angle leaves the core, not that three.js turns the box. |
| **The multi-select, per-part turn and paired refusal appear in the UI** | three browser tests added with MULTI | **UNPROVEN**, and `SLICER-GATES.md:1124` says so. |
| **The "PAST THE EDGE … NOT simulated" note reaches the operator's panel** | browser assertion | **UNPROVEN.** The disclosure that substitutes for coverage is itself unverified. |
| **The browser's empty-tool-set guard** | `web/src/App.tsx` | **UNPROVEN** — and `SLICER-GATES.md:1213` already notes no browser test exercises the refusal. |
| **The download equals what the panel shows** | spec **I5**, marked 🟡 | **UNPROVEN and never was** — `download` appears once in the suite as `toBeDisabled()`. |

### The measured number

I parsed `FUNCTIONAL-SPEC.md` the way gate SPEC does: **71 rows with a Gate column, 182 citations.**
Of those rows, **17 cite at least one `e2e:` test**, and **11 rows have NO non-browser coverage at
all** (their entire Gate cell is `e2e:` / `I1` / `K3`):

```
A6  A7  C3  E2  I1  I2  I3  I4  I5  I6  I8
```

🔴 **SPEC is green on all 11.** SPEC verifies that a citation *resolves to a real runnable thing*; it
has no notion of whether that thing can currently run. Its own note already says *"a resolving
citation is a floor, not a coverage claim"* — but the floor is currently at zero for these rows and
nothing says so. Four of the eleven carry ✅ in Status.

### Does any gate's message overstate coverage given this?

- 🔴 **Yes — `SLICER-GATES.md`'s I1 row and the gate table entry.** `['I1', 'BROWSER PARITY + UI',
  'HARD', 'the browser and the CLI must emit identical G-code']` is printed by `--list` as a live
  guard. It is a guard nothing has exercised on this box.
- 🔴 **Yes — SPEC's PASS line**: *"71 rows, 182 citations all resolve; 3 row(s) cite `none` —
  UNCOVERED and saying so."* It reports **3** uncovered rows. The true figure while the browser is
  down is **3 + 11 = 14**. The count SPEC prints specifically to stop uncovered rows growing silently
  is undercounting by a factor of ~4.
- ✅ **No** for `K3` — it is careful, and its own comment states it is a currency check and not a
  parity check.
- ✅ **No** for `PROBE`, which ends its PASS line with an explicit
  *"NOT COVERED: browser parity for the XYZ path"*. That is the pattern the other rows should follow.

---

## 6. Summary

| Question | Answer |
|---|---|
| Gates | **48**, all HARD |
| Registered plants | **20**, covering 20 gates; 28 gates have no plant |
| Gates with a control **observed red and recorded in the tree** | **17 of 48** |
| Gates with neither a plant nor a recorded red | **19** |
| Commits carrying the required red transcript in the body | **11 of 194**; none in the last **38** |
| Full-gate verdict, this tree, 2026-08-10 | **NO-GO** (46 / 1 fail / 1 pending) |
| `--quick` verdict, same tree, same minute | **GO** (46 / 0 fail / 2 pending) |
| Browser tests declared / passing | **54 / 0** |
| Spec rows whose only evidence is a browser test | **11 of 71**, all green in SPEC |

**The single change with the most leverage:** make `PENDING` block the verdict. Every negative
control in this suite asserts the VERDICT line, and that line currently cannot tell "48 gates
answered" from "47 answered and one was switched off".
