# 2bee.app

Web-based CAM for CNC routers. Browser-first, no install, no server round-trip.

**Licence: AGPL-3.0-or-later** (founder ruling 2026-08-08: *"use AGPL as a basis
and rewrite the code if needed"*). Derived in part from the 2bee CNC fork of
OrcaSlicer, itself AGPL. **§13 obligation: if this is served over a network, its
source must be offered to every user.** That is a link in the UI footer, not an
afterthought.

> 🔴 **THE §13 OFFER IS NOT CURRENTLY DISCHARGED, AND CANNOT BE UNTIL SOMEONE
> PUBLISHES THE SOURCE.** The paragraph above says what the obligation is; this
> block says what is actually true, because those were different facts for as
> long as the link has been wrong and nothing said so.
>
> **Measured 2026-08-11** (anonymous `curl -I`, with `https://github.com` → **200**
> as the control, so the box was online and the failures are real):
>
> | Target | Result |
> |---|---|
> 🟢 **RESOLVED 2026-09-09 — the row below is the HISTORY, not the state.**
>
> | Target | Result |
> |---|---|
> | `github.com/2hives-ai/2bee.app-source` — **what the app links today** | 🟢 **200 anonymously.** `LICENSE` **200 and its first lines read "GNU AFFERO GENERAL PUBLIC LICENSE Version 3"** — verified by **content**, not by the file existing. Tag `src-8483971c40` **200**, and its bound monorepo commit is present in this tree |
> | `github.com/2bee-farm/2bee.slicer` — what the footer linked until 2026-09-09 | **404** — wrong org, wrong name. It was **never guessed into a plausible URL**, which is why this row existed |
>
> ⚠ **What the offer is, exactly:** a mirror of `software/2bee.app/` per `legal`'s ruling,
> **minus `AGENTS.md`** — `ceo` narrowed that inside the tree and said so rather than doing it
> silently, on the grounds that a fleet operating manual is not source needed to generate, install
> or run the work. **This lane reviewed and did not overrule it.**
>
> 🔴 **AND THE OFFER IS THE FIRST THING A STRANGER SEES, not a footer.** The whole app is behind
> `AuthGate`, so an anonymous visitor gets four lines and this link — measured on the built bundle,
> which is why the dead URL mattered more than a footer would have.

## Scope — CNC today, designed for a second process (founder, 2026-08-08)

**"CNC only for now"** and **"design the tool for later FDM."** Those are two
instructions, and the second is the harder one: it says the CNC assumptions must
not become the architecture.

**What is built:** subtractive CNC, and only that. Nothing generates an additive
toolpath and nothing pretends to.

**What is designed for:** a second technology arrives as a NEW FILE, not as an
edit to the CNC path. Three things carry that:

| | |
|---|---|
| `core/src/tech.rs` | `Technology { Cnc, Fdm }`. Anything true of machining and not of every process — a spindle, stock to remove, tool-radius compensation — is **asked for** here rather than assumed. Every answer today is the CNC one; what matters is that the question is asked at all. |
| `core/src/post.rs` | `trait Post`. Dialects are selected **by technology**, so a CNC job cannot be handed an additive post. `for_technology(Fdm)` returns `None` — a refusal, never a fallback, because posting additive through grblHAL would emit `M3` for a machine with no spindle. |
| Scoped bans | Gate G2's banned-word list is **per technology and lives in the core**, not in the gate. CNC bans extruder words; FDM bans spindle words. When additive arrives the fix is to ask for its rules — *never to empty the list*, which would remove the protection from the process that already ships. |

The seam is **tested, not asserted**: `post.rs` implements a second technology's
post entirely inside its test module and requires it to work through the trait.
If that test ever needs a change to `post_grblhal.rs` to compile, the seam has
closed and this section has stopped being true.

⚠ **What this is NOT.** It is not a half-built FDM mode, and `Technology::Fdm`
reports `implemented() == false` everywhere it is asked. A slicer, layer model,
extrusion widths, retraction, cooling and supports are all absent. The design
makes adding them *possible without disturbing what ships*; it does not make
them nearly done.

Also out of scope, decided the same week: **PCB isolation milling / autorouting**
(founder, "freerouter is not in scope").

## Why this exists

The CAM step is the only manual, proprietary, unversioned link in an otherwise
generator-driven chain:

```
OpenSCAD *_wcnc.scad -> DXF -> [ CAM ] -> G-code -> gSender/CNCjs -> grblHAL SKR Pro
     (hardware/cad)                                                  -> 2.2 kW spindle
```

> ⚠ **CITE THE NEEDLE, NOT THE LINE — corrected 2026-08-27.** Several `file:LINE`
> citations added to this file earlier the same day were **wrong at the moment they
> were committed**, not through decay: two commits 31 seconds apart moved each
> other's line numbers in a shared working tree, and one of them
> (`slicer_gate_check.mjs:1945`, cited for gate `MULTI`) landed a reader inside a
> different gate entirely. Citations into files this fleet edits concurrently are
> now written as the grep that finds them. The ones into stable files were checked
> and were correct.

## Status — honest

**Re-audited against the code 2026-08-08 (evening), row by row.** Every ✅ below
names the check that would go red if it regressed; the corrections that pass
made to this table are listed underneath, because a row that was quietly
rewritten teaches nobody anything.

| | | Check |
|---|---|---|
| Post-processor | ✅ grblHAL dialect, ported and gated | `G2` `G7` `G8` `G9` |
| Domain model | ✅ tools, machines, stock, operations, moves | `G0` |
| Feeds | ✅ `feed = rpm x flutes x chipload`, one formula, one place | `G12` |
| Geometry engine | ✅ arc-preserving offsets, tabs, corner relief, drill/profile routing. ⚠ **"pockets with islands" is an ENGINE, not a user capability — corrected 2026-08-28.** `core/src/pocket.rs::clearing_loops` is real and gated, and it is reachable from **one** caller: the gate fixture at `core/src/fixtures.rs` (grep `clearing_loops`). A user drawing can never produce a pocket — `plan_operation` dispatches `Drill` and everything else to the profile planner, and `OpType::Pocket` is constructed nowhere in this repo. 🔴 **That is a DECISION and not an oversight**, recorded in `fixtures.rs` beside the uncut-coverage tests: a drawing's interior loop is not evidence of a pocket, and `import.rs` reads no layer, depth or attribute that could tell a pocket floor from a slug that drops free. Declaring those loops as removal regions would invent thousands of `Uncut` cells about material the program was never asked to clear. The row is corrected rather than the code | `P1`–`P5` (they exercise the engine through the fixture, which is what makes this row's ✅ readable as a user capability — it is not one) |
| DXF/SVG intake | ✅ subset — anything unreadable is **named**, never skipped | `F1` |
| STL intake | 🟡 a mesh is parsed and **SECTIONED at one Z** — one flat outline through the solid, named as a section in the notes on every import. `core/src/mesh.rs`, wired to the CLI (`import --format stl --z`) and to the browser (`plan_import_bytes`). **This is not 3D surfacing** and is not a step towards it: no Z-level roughing, no waterline, no scallop. An open chain, a plane that crosses nothing, and a face lying in the plane are each refused **by name**. Mesh formats read here: **STL, OBJ, 3MF** — all three are triangle meshes, which is the only thing this section path can honestly take. 🔴 **STEP is REFUSED BY NAME (2026-08-28), and this row used to include it.** The hand-rolled B-rep reader dropped every vertical wall crossing the section plane with a bare `continue` and no message, emitted a full circle for every cylindrical face regardless of axis or extent, and — the finding that settled it — **the browser and the CLI used two DIFFERENT readers on the same file**, so one part had two answers and no gate drove either. Removed rather than repaired: `core/src/mesh.rs::refuse_step` carries the evidence, and STEP now returns zero geometry with a named reason on all three doors. | **23** `mesh::` tests (`cargo test -p twobee-cam --lib mesh::`, measured 2026-08-28 — this cell said 12 and was stale; count by running), **no gate** |
| Multi-drawing layout | 🟡 several **placed** drawings on one sheet, each positioned and rotated through `Stock`, with a real polygon check between them: **overlap** and **closer than the cutter** are refused as two different findings with two different fixes. `core/src/layout.rs`, `2bee-slice layout`. | 14 `core:` tests + **`MULTI` (HARD)** — ⚠ **this cell read "no gate" until 2026-08-27 and that was wrong**, understating coverage. `MULTI` is registered HARD at `gates/slicer_gate_check.mjs` (grep `'MULTI'`) and its section runs from `:1945`, asserting the refusal emits **zero bytes** with a **paired positive** so a check that refused everything could not pass it. The neighbouring **STL intake** row's *"no gate"* was re-checked in the same pass and **is still true** — `grep -n "'STL'" gates/slicer_gate_check.mjs` finds no such gate id |
| Nesting | 🔴 **still not written, and `layout.rs` is not it.** An overlap CHECK grades a placement a human chose; a NESTER chooses one. Nothing here moves a part to resolve an interference — deliberately, because the clamps do not move with the parts. `jagua-rs` remains the intended source. | `P8` covers transforms only |
| Tool recommendation | ✅ per feature: internal radius, exact-drill-only holes, reach, collet fit, material rpm/depth caps, prefer-a-tool-already-in-the-job — every choice carries its reason **and every rejection carries the rule it broke**. `core/src/recommend.rs`. | 17 `core:` tests |
| Route ordering | ✅ nearest-neighbour + bounded 2-opt **inside** constraints it may not trade against (interior-before-outer, tool grouping, shallow-before-deep, unattributable ops pinned and named). It permutes operations and **moves no coordinate**. Measured, not asserted: `route plate` removes 161.4mm of 570.5mm link travel (28.3%). Nothing in the file is called optimal. | 9 `core:` tests |
| Datum placement | ✅ works out the shift that would make a drawing fit — **reported, never applied**, because the datum is the part's position relative to the clamps and the clamps are bolted to the table. A program wider than the table gets a refusal naming the axis, **not** a best-effort shift. `core/src/placement.rs`, `2bee-slice fit`. | 12 `core:` tests |
| Program summary | ✅ **parsed back out of the emitted G-code**, not walked off the plan — distances, deepest Z, `M0` count. `EstimateBasis` carries what it cannot know: motion blocks, short moves, unmeasured blocks, blocks it could not read (**named**, never dropped), and that it does not model acceleration. Tool **names** are the one plan-derived field, and the struct says so. | `core:the_estimate_walks_the_emitted_moves` · `core:a_clean_program_leaves_nothing_unread` |
| Entry into the cut | ✅ ramp is the default and the **emitted program** is asserted to descend only with XY motion · 🔴 **helical entry is REFUSED as unimplemented** — see the correction below | `ENT` |
| Spindle | ✅ a `G4` dwell follows every spindle start before the first cut; an rpm outside the machine's band warns | `SPIN` `G6` |
| WASM build | ✅ the browser runs the same core the CLI and gates run — and `K3` fingerprints the two so a **stale** wasm cannot agree with itself | `K3` `I1` |
| Designs (shop) | ✅ **the landing tab** (founder 2026-08-31, *"the 1st page … so the user can 'shop for the designs'"*). A card grid over **cad's own `hardware/cad/` tree**: pick one and it opens in 2bee.cad with its whole import closure. Generated at build time by `web/scripts/build-shop-catalogue.ts` into `web/public/shop/`, which is **not in git** — a committed copy of another lane's designs would drift silently, and `vite build` only copies `public/`, so `npm run shop` is chained into `build` and into the e2e webServer. **80 listed of 127 candidates** (measured 2026-08-31; cad's tree moves, so run it rather than quoting this). A design is listed **only if this reader opens it** with zero errors and zero unsupported constructs; the other 47 are named with their reason in the page footer, because "the catalogue is small" and "the reader got worse" must not be the same silent number. 🔴 **Thumbnails are rendered from OUR mesher, not from OpenSCAD** — `openscad` is installed on this box and is deliberately not used: a prettier picture of what OpenSCAD makes of a source would advertise a part this app does not produce, at the one moment the user is choosing. Each card therefore also carries `meshScene`'s own `trust` verdict unmodified, and a non-`trusted` card QUOTES that verdict rather than paraphrasing it. 🔴 **CORRECTED 2026-08-31 — `trust` was counting REFUSALS ONLY, so a design could be `trusted` and wrong.** `2bee_hive_fan_box_panel_wcnc.scad`, a CNC sheet part, drew 41.2 × 41.2 × 1 mm for a 121.5 × 407 × 18 mm panel and carried a *complete render* badge: its `difference()` had lost its first operand, the mesher said so as a **warning**, and warnings were not consulted. Warnings now declare what they altered (`MeshIssue.alters`: geometry / precision / appearance) and a geometry-altering one demotes to `suspect`. ⚠ **AND THAT FIXES ONE OF TEN.** Measured against OpenSCAD 2026.08.07: 10 of 47 `trusted` designs disagree by >5% in volume; this change demotes **1**. The other 9 are wrong with NO diagnostic at all, and no verdict computed from this app's own reports can reach them — see the `OSCAD` differential-gate proposal. ⚠ **A catalogue, NOT a store** — no price, no stock, no order, and none may be added here (pricing is `business/pricing-model.md` and is never quoted outward). ⚠ **Nothing in it has ever been cut.** | `I1` — `web/e2e/shop.spec.ts`, 6 tests incl. the whole flow against `dist/`; unit: `tests/shop-handoff.test.ts` + `tests/shop-catalogue.test.ts`. **No dedicated gate** |
| Web UI | ✅ 3D viewport, adjustable machine/stock/tools/clamps, G-code view + download, coloured program map (every move as a slice, in program order), three **real `cad` DXFs** as samples that take the same path through the importer a user's own file does, and the gate instruments (`Job`, `Plant`) off the operator surface behind `?fixtures=1` | `I1` + the browser suite |
| Object picker | ✅ **one list per panel** — drawings (shipped DXF/SVG + shipped STL + your own saved), machine (presets + saved), workpiece (sheet catalogue + saved), tool, material, work holding, touch plate. `SavedSet` — the second `saved… ▼` picker and its `Delete` that sat beside each catalogue — **is deleted**; add/import/export/delete live in the list. It does **not** replace every dropdown: `<select>`s remain for enum settings (entry mode, direction, dogbone, sheet rotation, the gate instruments), which is a different kind of choice. ⚠ **Multi-select on drawings is NOT built and was refused deliberately** — chips saying two parts over a program containing one; it needs N placed parts with an overlap refusal first (#31), and the session store holds ONE drawing so a multi-selection would be dropped on refresh. ✅ **CORRECTED 2026-08-27 — BOTH LIMBS OF THAT ⚠ ARE NOW FALSE, and the sentence is kept only as the record of a refusal that was right when it was made.** Multi-select on drawings **IS built**: the drawing picker is `mode="multi"` at `web/src/App.tsx` (grep the symbol), alongside the tool and hold-down pickers (`:9380`, `:9125`). The named blocker is also gone: the session store holds **a list**, not one drawing — `SessionValues.drawings: DrawingRef[]` at `web/src/store.ts:816`, each entry validated and dropped **by name**, behind a `SESSION_VERSION` bump to **2** recorded at `web/src/store.ts` (grep `BUMPED TO 2`) — ⚠ **2 was the bump that carried THIS change, and it is not the current version: `SESSION_VERSION` is now 3**, bumped 2026-08-11 because `zZeroTop` kept its name and changed its meaning, recorded immediately above the constant (grep `2 -> 3`). Read the constant, not this sentence — (*"`drawing: {origin, name} \| null` became `drawings: DrawingRef[]`"*), so a multi-selection now survives a refresh instead of vanishing silently. The two preconditions the refusal set were met first and in order — `plan_report_import_many` plans N **placed** parts (every import goes through it, including a single drawing, so there is no path that skips the check), and the overlap refusal emits **zero bytes** and is held by HARD gate `MULTI`. The reasoning is preserved in the picker's own header at `web/src/App.tsx` (grep it), including the founder line that reopened it (2026-08-10, *"I should able to add more than 1 drawings"*). **Staleness direction: UNDERSTATED** — the row denied a shipped feature and cited a schema limitation the schema no longer has. **Still NOT done, and named rather than implied:** tabs are per JOB, not per part (TODO #31 item 2), so three parts with one of them tabbed still leaves two loose pieces. Verified by reading `App.tsx` and `store.ts` on 2026-08-27; nothing run. | `I1` + `MULTI` + `-picker` references in `web/e2e/` (⚠ the *111* this cell used to give is a hand-copied count — grep it, do not read it) |
| Verification | ✅ height-map material removal, gouge / uncut / spoilboard detection | `P9` |
| Marking | ✅ single-stroke part IDs, cut shallow with their own tool | `MARK` |
| Materials | ✅ ply/MDF/hardwood/softwood/acrylic/aluminium bound feed, depth and rpm | `B2B4` `G12` |
| Theme | 🟡 the app imports `brand/tokens.css` and takes every surface, text tier, line, accent and status colour from it. The six **move-class** colours are local on purpose — brand ruled them out of the palette as instrument/safety colours (ticket, 2026-08-08). ~~**No gate watches any of this**; an `@import` that 404s is silent in CSS.~~ ⚠ **CORRECTED 2026-08-27 — that struck-through sentence is stale in the UNDERSTATED direction, and it is the harder kind to find: nobody re-tests a blocker that names a reason.** *No gate* is still true; *nothing watches it* is not. **Two Playwright tests read the computed custom properties**, in `web/e2e/slicer.spec.ts`, grep `'brand tokens are loaded \u2014 CSS custom properties are set'` and `'theme toggle switches between light and dark'`​— ⚠ **these were cited as `:5328` and `:5350` until 2026-08-28 and BOTH had drifted: `:5328` is a catalogue-id refusal test, in a different describe block entirely. That is the very defect the ⚠ block above this table names, still live in the row three lines under it, which is why line citations into this file are now written as the grep that finds them`, and the first would go red if the `@import` were deleted — verified by reading the chain rather than by running it: `web/src/styles.css:8` is the only definition of the import, and `--bg`/`--ink`/`--accent` are aliased at `:133`, `:139`, `:146` as bare `var(--color-bg-secondary)` / `var(--color-text-primary)` / `var(--color-amber)` **with no fallback argument**. Those three brand tokens are defined **only** in `brand/tokens.css` (`:14`, `:37`, `:26`) and nowhere in `web/`, so a dead import makes each `var()` guaranteed-invalid, `getPropertyValue('--bg')` returns `''`, and `expect(bg).toBeTruthy()` fails. **Still NOT covered:** these run under gate `I1`, not under a theme gate — there is no `G-THEME` and there never was; and the second test's assertion is wrapped in `if (await toggle.count() > 0)`, so it is vacuous on any build that drops `theme-toggle` (present today, `web/src/App.tsx` (grep the symbol)). | `I1` — two `e2e:` tests; **no dedicated gate** |
| Gates | **Run `node gates/slicer_gate_check.mjs --list` — this row does not carry a count.** ⚠ It said **59 HARD as of 2026-08-13** until 2026-09-07, when the live table held **62**: the row told the reader not to trust it and carried a number anyway, and the number is what gets quoted. Deleting it beats updating it — an updated count goes stale on the next gate, an absent one cannot. **A measured claim about a live tree is stale by the time it is written down** — so this row states the shape, not a score: run the gate. · 🟡 **8 budgeted PENDING, which is not a pass:** `CTRL`, `RUN`, `AGPL` (all always), `CAD1`, `CAD1H`, `BRND` (always, binary/brand dependency), `I1`, `SPLNT` (under `--quick` only) · 🔁 `K3` flips red whenever `core/` moves ahead of the committed wasm. That is the gate working, not a defect: rebuild (`npm run wasm`), never read `I1`'s green as cover. | `--list` |
| Tests | **665 Rust unit tests** measured 2026-08-13 by running `cargo test -p twobee-cam --lib`. ⚠ These numbers move fast: the count read 376 three days ago. **Count by running, never by reading this row** — it is written from a measurement and goes stale the same way the last one did. Browser tests are driven by gate `I1`. | `G0` `I1` |

**Nothing here has cut anything.** No material-removal claim has been checked
against a physical part.

⚠ **CORRECTED 2026-08-27.** This paragraph read *"No output has been run on a
real controller"* until today, and that half had been false since **2026-08-20**,
when `fixture rect-profile` was sent to a real **grblHAL 1.1f** board (bare rig,
`/dev/ttyACM0`) and **47 of 50 lines were answered**. See
`docs/cnc-controller-status.md`. Kept visible rather than rewritten, because a
stale 🔴 misleads exactly as badly as a stale ✅ and nobody re-reads a red.

**What that does and does not buy, in the order the mistakes get made:**

- **Nothing moved.** `rig=bare` — no motors, no spindle, no material. Acceptance
  is a *parse*: the board said it understood the words. Air cut → coupon → ply
  are unchanged and need a machine and **ops**.
- **The other 3 lines were not rejected — the board went silent.** The transcript
  records `replies: []`, `verdict: null` for `M5`, `G0 Z5.000` and `M30`. That is
  a dead link mid-program, **not** a dialect disagreement, and reading it as one
  would send the next person into `post_grblhal.rs`. ⚠ The cause is UNKNOWN —
  this bullet named "a floating AUXINPUT0" until 2026-08-27, and that was
  impossible: the safety door is compiled out (`SAFETY_DOOR_ENABLE=0`), which
  pcb caught. A grblHAL in alarm still answers `error:9`; these got silence.
  Hypothesis, unmeasured: a hub-level USB dropout observed on this machine
  (`dmesg`: `usb1-port1: disabled by hub (EMI?)`). Settled on the #126 re-probe
  with `dmesg -w` captured alongside.
- **Gate `CTRL` is still PENDING, correctly.** The transcript is **inadmissible**:
  the probe's `--program-command` was optional and was not passed, so CTRL cannot
  re-emit the program and compare hashes, and the file is not in
  `gates/controller/` where CTRL looks. TODO #126 carries the two conditions.
  `tools/controller_probe.py` now refuses to write a transcript without that flag
  — a tool that produces evidence its only consumer rejects has failed quietly,
  and it did.

A Pi + SKR with **nothing else connected** arrived 2026-08-08; the board was
bricked on 2026-08-19 by a DFU flash to the wrong address and recovered over
ST-Link on 2026-08-20.

### What this table said yesterday, and why it was wrong

Kept visible rather than rewritten. Six of these were **stale reds** — the table
denying work that exists — which mislead exactly as badly as a stale green, and
were the harder half to find because nobody re-reads a 🔴.

| Was | Is | Direction |
|---|---|---|
| *"Nesting: 🔴 not written"* — with nothing else in the row | Still true of **nesting**, and it was hiding `layout.rs`: N placed drawings, polygon overlap, cutter-gap refusal. The precise statement is that an overlap **check** exists and a **nester** does not. | understated |
| *"Gates: 31 HARD armed, 0 pending"* | **36** gates, and *"0 pending"* contradicted the same cell's own note that CTRL is pending. `ENT`, `SPIN`, `SPEC`, `K3`, `P3`, `CTRL` were added since. | both |
| *"Tests: 123 unit · 16 browser E2E"* | 376 unit, 49 browser (measured 2026-08-10). | understated |
| *"`web/` Vite + React UI. **Not written yet**"* — in the Layout block, two lines under a ✅ Web UI row | The UI ships: 3D viewport, panels, program map, samples, an object picker at seven call sites. **The same file contradicted itself and both halves stayed for weeks.** | understated |
| *"`docs/` G-code contract and design notes"* | `docs/` holds `materials-research.md`, `spec-citation-audit.md`, `workholding-research.md`. There is **no G-code contract document**; the contract is a version constant in `core/src/lib.rs`. A reader following this line finds nothing. ⚠ **2026-08-27: the correction in this cell OVERCORRECTED.** Naming three files was fine as an illustration and was then copied into the Layout block as if it were the inventory — `docs/` held far more than three even in August, and holds **35** today (23 in `docs/` + 12 in `docs/audit/`, counted 2026-08-27). The Layout block now states the shape and the one-liner that counts it. **A correction can create the next defect**, and this one did. | overstated → the fix then understated |
| *"a **persistent** tool store"* listed as not built | A persistent store exists — IndexedDB, `web/src/store.ts` — for **machines, workpieces and drawings**. **Tools are still browser-session only**, so the row was right about tools and wrong about persistence. | both |
| Summary numbers described as coming from the emitted moves | They now do (`job.rs` parses the posted program). Until tonight they were walked off the **plan**, which `FUNCTIONAL-SPEC.md` J3 recorded as a 🔴 while this file implied the opposite. | was overstated, now true |

🔴 **The one that matters most — `EntryMode::Helix` was a lie the program told
about itself.** `Helix` was matched together with `Ramp`, so a job that asked for
a helical bore got a **linear ramp** and nothing said so. Arming gate `ENT` — the
first check to assert on the **emitted program** rather than on the setting —
found something worse in the same place: the engine was emitting a **vertical
full-depth plunge** while the setting read `Ramp`. Both are fixed: ramp entry is
asserted at the G-code (`100 ramping moves, 0 vertical plunges`), and `Helix` is
now **refused as unimplemented** rather than silently aliased, exactly as
`Technology::Fdm` is. *A control that is green about intent and never reads the
output is not a control.* ⚠ Residual, named rather than left to be found:
`rect_profile.rs` — the **fixture generator**, not the engine — still matches
`Ramp | Helix` together at line 160.
✅ **THAT RESIDUAL IS CLOSED — corrected 2026-08-27.** The sentence above
(*"still matches `Ramp | Helix` together at line 160"*) is stale in the
**understated** direction: it names an open defect that no longer exists.
`core/src/rect_profile.rs::build` returns a `Result` and **refuses Helix at
`:128`, before any move is built**; the `match` at `:207` keeps
`EntryMode::Helix => unreachable!(…)` as its own arm so a fourth entry mode is a
compile error here rather than a silent inheritance of the ramp. Three tests hold
it, and one of them —
`the_generator_refuses_helix_in_the_engines_own_words` (`:328`) — asserts
**byte-equality** with `toolpath::plan_profile`'s own refusal, which is the check
whose absence let this file and the engine mean different things by one word.
Verified by reading the source on 2026-08-27; nothing was run.

Not built, and named rather than left to be discovered: **nesting** (see above),
**spiral/zigzag pocket strategies** (`pocket.rs` is concentric only), **3D
surfacing** (an STL enters as one section and that is the whole offer), and a
persistent store for **tools** (machines, workpieces and drawings do persist).
The run-time estimate is now read back out of the emitted program and displayed,
but has **never been checked against a real cut** — that rung needs **ops** and a
machine. See `FUNCTIONAL-SPEC.md`, where each carries the reason it matters.

## Layout

```
core/    Rust CAM core. Builds native (gates, CLI) AND wasm32 (browser worker).
         They must be the same code — a gate that exercises a different build
         than the product ships is not a gate.
cli/     2bee-slice — headless harness. The gates drive this.
gates/   slicer_gate_check.mjs + fixtures + the controller probe transcripts.
web/     Vite + React UI — viewport, panels, program map, sample drawings,
         and src/shop/ (the Designs catalogue: the landing tab).
         ⚠ This line read "Not written yet" until 2026-08-08, two lines under a
         ✅ Web UI status row. One file, two answers, neither flagged.
web/scripts/  Build-time generators. build-shop-catalogue.ts reads cad's
         hardware/cad/ tree and writes web/public/shop/ — GENERATED, gitignored,
         and regenerated by `npm run shop` (chained into build). Nothing here
         is committed, so cad's designs have exactly one source of truth.
docs/    Research, DESIGN memos, DECISION records and audit notes.
         ⚠ CORRECTED 2026-08-27, and this line has now been wrong twice in
         two different directions. It read "G-code contract and design notes"
         — OVERSTATED: there is no G-code contract document; the contract is
         GCODE_CONTRACT_VERSION in core/src/lib.rs. It was then replaced by
         "materials, workholding, the spec-citation audit", which UNDERSTATES
         it badly: counted 2026-08-27, docs/ holds 23 .md files plus a
         docs/audit/ subdirectory of 12 more. Naming three of 35 reads as an
         inventory, and a reader who wants the hold-down design memo, the
         Z-datum design, the touchplate-ownership decision or the licence
         audit concludes they are not here.
         Take the shape, not the list: docs/design-*.md (design memos),
         docs/decision-*.md (rulings), docs/*-research.md (sourced research),
         docs/audit/YYYY-MM-DD-*.md (dated audits). Count by running
         `ls docs/*.md docs/audit/*.md | wc -l` — 35 today, and it moves.
```

## Running it locally

### The web app

```bash
cd web
npm install
npm run dev            # http://localhost:5178
```

That is the whole thing. The compiled core is committed at
`web/public/wasm/`, so a fresh clone needs **no Rust toolchain** to run the app.

**After changing anything in `core/` or `wasm/`, rebuild it:**

```bash
npm run dev:fresh      # rebuild the wasm, then start the dev server
# or just the rebuild:
npm run wasm
```

⚠ `npm run dev` does **not** rebuild the wasm. A change to the Rust core with a
plain `dev` leaves the browser running the previously committed module — the
page works, the numbers are stale, and nothing says so. Use `dev:fresh` when the
core has moved. Rebuilding needs the Rust toolchain:

```bash
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.100   # must MATCH the crate version
```

The wasm-bindgen CLI and the `wasm-bindgen` crate version have to agree; the
crate is pinned to `=0.2.100` in `wasm/Cargo.toml` for exactly that reason.

### The command line

Same core, no browser:

```bash
cargo build --release
./target/release/2bee-slice jobs                       # reference jobs
./target/release/2bee-slice job plate                   # G-code on stdout, diagnostics on stderr
./target/release/2bee-slice job plate --plant gouge     # watch a check fire
./target/release/2bee-slice import drawing.dxf          # cut your own drawing
./target/release/2bee-slice import part.stl --format stl --z 12   # ONE SECTION at Z, not surfacing
./target/release/2bee-slice report plate                # the full JSON the browser gets
./target/release/2bee-slice fixture rect-profile --plant deep    # post-level refusal
```

Four subcommands **answer a question and emit no G-code at all** — they exit `0`
answered, `1` refused, `2` bad invocation:

```bash
./target/release/2bee-slice recommend drawing.dxf   # which cutter per feature, the REASON, every rejection
./target/release/2bee-slice route plate             # reorder the cuts; prints link travel WITH its basis
./target/release/2bee-slice fit drawing.dxf         # already inside / shift by X,Y / will-not-fit + the axis
./target/release/2bee-slice layout --drawing a.dxf --at 0,0 --drawing b.dxf --at 300,0 --cutter 6
```

`fit` reports a datum shift and **never applies one** — the clamps do not move
with the sheet. `layout` grades a placement; it does not choose one.

### The gate

```bash
node gates/slicer_gate_check.mjs           # everything, incl. the browser suite (~2 min)
node gates/slicer_gate_check.mjs --quick   # skip the rebuild and the browser
node gates/slicer_gate_check.mjs --list    # what each gate guards
```

🔴 **Those three flags are the entire set, and an unknown one is REFUSED** (`e1dfc9abcd`):
exit **2**, **empty stdout**, nothing built, spawned or written — `--help` included, because
there isn't one, and `--only` because this runner cannot scope a run to a subset of gates.
**Check the exit code**: a refused run and a run that found nothing look the same on stdout.
(The third flag is `--self-plant <name>`, the harness's own negative control.) *This block
used to list only what is accepted; a control described by its permissions is read as
permissive by default.*

⚠ The full run starts its own preview server on **4173** and will FAIL if
something is already serving that port — deliberately, so a stale server from an
earlier run is never tested in place of a fresh build. Kill it and re-run:

```bash
pkill -f "vite preview"
```

Two gates report **PENDING**, which is not a pass:

- **`CTRL`** — no controller transcript is in `gates/controller/`, which is where
  this gate looks. ⚠ **That is no longer the same statement as "nothing this lane
  emits has been offered to a real board" (corrected 2026-08-27).** A program was
  offered on 2026-08-20 and 47 of its 50 lines were answered by a real grblHAL
  1.1f board; the transcript sits at `gates/ctrl-transcript-2026-08-20.json` and
  is **inadmissible** — no `program_command`, so CTRL cannot check it for
  staleness. TODO #126. What is still true, and is the part that matters: **no
  transcript has ever been READ by this gate.**
- **`I1`** — skipped by `--quick`. It is armed; `--quick` just did not run it.

And **`K3` goes RED whenever `core/` has moved without a wasm rebuild**, naming
both fingerprints. That red is the point: `I1` would still pass, because two
hosts running the *same old* core agree perfectly. Fix it by rebuilding
(`npm run wasm`), never by reading `I1`'s green as cover.

## Stack, and why

| Layer | Choice | Reason |
|---|---|---|
| CAM core | **Rust → WASM** | one source compiles native (fast gates) and `wasm32` (browser); `jagua-rs` nesting is already Rust |
| UI | **TypeScript + React + Vite** | matches `software/frontend` — three.js, brand tokens, Playwright already in-org |
| Runtime | ✅ **WASM in a Web Worker** — `web/src/cam.worker.ts` owns the core, `cam.ts` owns the protocol | ⚠ **This row was FALSE for weeks and is now true; the history is kept because a row that was quietly rewritten teaches nobody anything.** It read *"WASM in a Web Worker — slicing must not block the canvas"* while `cam.ts` loaded the glue on the MAIN THREAD, so a large drawing froze the canvas the row said it protected: the reason was right and the mechanism was absent. Corrected to say so on 2026-08-28, built on 2026-08-29 (TODO #144). The refactor was contained in `cam.ts` because all 18 core-touching exports were already `async`. **No silent fallback**: if the Worker cannot be constructed, `cam.ts` throws by name — a fallback would re-create the defect invisibly. 🔴 It surfaced a real one: `SummaryPanel` read `runnable` off the LAST COMPLETED plan, so during a re-plan the status, the G-code view and the download button all described a job the operator had already changed. Always possible, too fast to see on one thread. Fixed — the status shows `planning…` while a re-plan is in flight | `I1` (100/100), and the two `MOVE` tests that caught the staleness |
| Node | **harness only, never the engine** | gate runner and golden files |
| Storage | IndexedDB / File System Access | client-side only, no backend |

Rejected: TypeScript-only core (perf, throws away `jagua-rs`); C++→Emscripten
port of the fork (welded to `libslic3r`, drags an 18 GB tree into WASM).

## Reading order for anyone picking this up

1. [`SLICER-GATES.md`](SLICER-GATES.md) — what "done" means and what is not covered.
2. [`FUNCTIONAL-SPEC.md`](FUNCTIONAL-SPEC.md) — every feature numbered, with the
   check that proves it, and the rows that say `none` because nothing does.
   ⚠ **This line used to give that as "six". Do not put a number here.** It has
   been 6, then 3, and gate `SPEC` reported **0** on 2026-08-28 — a hand-copied
   tally in a reading-order list is stale within days and nobody re-derives it.
   Count by running: `node gates/slicer_gate_check.mjs --quick` prints the live
   figure on SPEC's own row.
3. `core/src/types.rs` — the domain model. Millimetres and `f64`, everywhere.
4. `core/src/post_grblhal.rs` — the dialect, with the grblHAL facts that were
   verified rather than assumed.
5. `core/src/rect_profile.rs` — read its header before extending it. It is a
   fixture generator, not the engine.

The modules that answer a question instead of emitting one — `placement.rs`,
`layout.rs`, `recommend.rs`, `optimise.rs`, `mesh.rs` — each open with the
physical failure they exist for and, more usefully, a **"what this does NOT
do"** section. Read that section before trusting the module.
