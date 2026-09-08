# Spec citation audit — the 33 gate ids that do not exist

`FUNCTIONAL-SPEC.md` has a **Gate** column. 33 distinct gate ids in it
(`G-OFF`, `G-DEP`, `G-ENT`, `G-DIR`, `G-ORD`, `G-A2`, `G-A4`, `G-A6`, `G-B6`,
`G-C1`, `G-C2`, `G-D1`…`G-D5`, `G-E4`, `G-E5`, `G-F3`, `G-F5`, `G-SUM`,
`G-THEME`, `G-EST`, `E2E-F1`, `E2E-M1`, `E2E-T1`, `E2E-U1`…`U5`, `E2E-V1`,
`E2E-V2`) **exist nowhere in the repo**. The real gate ids are the 29 in
`gates/slicer_gate_check.mjs` (`G0`–`G14`, `P1`–`P9`, `B2B4`, `TECH`, `C6`,
`MARK`, `LEAD`, `F1`, `I1`, `CTRL`); everything else that can go red is a Rust
`#[cfg(test)]` fn (run by gate **G0**) or a Playwright test title (run by gate
**I1**).

Two of these citations have already been caught lying outright: **I7/`G-THEME`**
(row read ✅ while the app imported no tokens and shipped its own teal palette)
and **G-3/`P3`** (row claimed a gate that did not exist). This audit asks the
same question of the other 33.

**What this document is.** For each row it names the *real, runnable* check that
would go red if that row's behaviour broke — or says plainly that there is none.
A row is only **COVERED** if the assertion was opened and read and would
genuinely fail on the regression. Where the mapping was arguable it is
**PARTIAL** or **UNCOVERED**: a wrong mapping manufactures a false green, which
is worse than the honest dangling label the spec carries today.

**Scope note.** 33 gate ids span **35 rows** — `E2E-V1` is cited by both B5 and
I1, `E2E-U3` by both I5 and J2. All 35 rows are audited below.

**Snapshot.** Measured against the working tree at **`467459fb3`**. The tree was
being edited by other lanes during the audit (`core/src/mesh.rs` appeared
mid-run); it is not cited by any row here, so nothing below depends on it.

**This document changes nothing.** `FUNCTIONAL-SPEC.md` is untouched, no test was
renamed. Deciding what the spec should say next is a separate change.

---

## The table

| Row | Acceptance (as written in the spec) | Cited gate (does not exist) | Verdict | The real check |
|---|---|---|---|---|
| A2 | an out-of-band `S` warns; dwell appears after `M3` | `G-A2` | 🔴 UNCOVERED | none |
| A4 | `--probe` emits `G38.2`×2 + `G10 L20 P1` | `G-A4` | 🟡 PARTIAL | `job.rs:422 z_is_re_referenced_after_every_tool_change` |
| A6 | each preset round-trips through save/load unchanged | `G-A6` | 🟡 PARTIAL | e2e:396 `a machine can be saved, reloaded after a page reload, and deleted` |
| A7 | invalid travel cannot be committed | `E2E-M1` | 🟡 PARTIAL | e2e:94 `the machine is adjustable and the change reaches the plan` |
| B5 | the rendered box matches the numbers | `E2E-V1` | 🔴 UNCOVERED | none |
| B6 | a sheet larger than travel is refused, not silently clipped | `G-B6` | ✅ COVERED | `job.rs:474 stock_larger_than_the_machine_is_refused_before_anything_else` + e2e:341 |
| C1 | every tool resolves to exactly one category | `G-C1` | ✅ COVERED | `tools.rs:399 every_tool_resolves_to_exactly_one_category` |
| C2 | a tool missing a required field for its category is invalid | `G-C2` | ✅ COVERED | `tools.rs:428` + `tools.rs:436` + `fixtures.rs:1365` |
| C3 | filtering never changes the underlying library | `E2E-T1` | 🟡 PARTIAL | e2e:114 `drill bits are categorised, and category constrains the tool` |
| D1 | a job with 3 tools produces 3 groups | `G-D1` | ✅ COVERED | `job.rs:377 three_tools_cost_exactly_two_changes` + `toolpath.rs:846` |
| D2 | N tools ⇒ exactly N−1 changes, never more | `G-D2` | ✅ COVERED | `job.rs:377` + `toolpath.rs:846 grouping_by_tool_costs_n_minus_one_changes` |
| D3 | every change block names Ø and type | `G-D3` | 🟡 PARTIAL | `job.rs:398 a_tool_change_stops_the_spindle_pauses_and_names_the_tool` |
| D4 | a change is followed by a probe **or** an explicit acknowledgement | `G-D4` | ✅ COVERED | `job.rs:422` + `job.rs:434 skipping_the_reprobe_is_allowed_but_never_silent` |
| D5 | `M5` before `M0`, `M3` after | `G-D5` | ✅ COVERED | `job.rs:398` |
| E2 | both paths produce the same model | `E2E-F1` | 🟡 PARTIAL | e2e:155 `clamps can be added and edited by hand, and are checked` |
| E4 | vacuum declares no keepout but **is not "no obstruction"** | `G-E4` | 🟡 PARTIAL | `fixture.rs:248` + `fixture.rs:261 presets_place_clamps_off_the_stock_or_at_its_edges` |
| E5 | an undeclared fixture warns on every export | `G-E5` | ✅ COVERED | `fixture.rs:248 nothing_declared_is_reported_and_is_not_the_same_as_confirmed_clear` + e2e:174 |
| F3 | a plate with 3 holes ⇒ 1 outer, 3 inner | `G-F3` | ✅ COVERED | `import.rs:672 holes_become_holes_and_not_separate_parts` + gate **F1** |
| F5 | an unclosed outline is a named error | `G-F5` | 🟡 PARTIAL | `import.rs:695 an_unclosed_outline_is_counted_not_silently_closed` |
| G-1 | offset distance = tool radius **everywhere**, within tolerance | `G-OFF` | 🟡 PARTIAL | `geometry.rs:333 offset_outward_grows_a_rectangle_by_exactly_the_delta` |
| G-6 | last pass ≥ 25% of a full pass, never a rubbing sliver | `G-DEP` | 🟡 PARTIAL | `rect_profile.rs:214 depth_schedule_folds_a_sliver_instead_of_emitting_it` |
| G-9 | no vertical plunge in a through-cut | `G-ENT` | 🔴 UNCOVERED | none |
| G-10 | direction reverses the traversal order | `G-DIR` | ✅ COVERED | `toolpath.rs:911 climb_and_conventional_traverse_in_opposite_directions` |
| G-11 | the outer profile is always last per part | `G-ORD` | 🟡 PARTIAL | `toolpath.rs:836 inner_features_are_cut_before_the_outer_profile` |
| H5 | estimate within 10% of the sum of segment times | `G-EST` | 🟡 PARTIAL | `job.rs:564 the_estimate_walks_the_emitted_moves` |
| I1 | renders without WebGL errors | `E2E-V1` | ✅ COVERED | e2e:40 `loads, plans, and renders without console errors` |
| I2 | scrubber position maps to a real move index | `E2E-V2` | 🟡 PARTIAL | e2e:219 `the scrubber changes what is drawn` |
| I3 | every model field is reachable from the UI | `E2E-U1` | 🟡 PARTIAL | e2e:76 `every panel the spec promises is present` |
| I4 | an imported file appears as named parts | `E2E-U2` | 🟡 PARTIAL | e2e:240 `a drawing can be imported and cut, and what could not be read is named` |
| I5 | downloaded bytes == core output bytes | `E2E-U3` | 🟡 PARTIAL | e2e:449 `the browser and the CLI emit byte-identical G-code` |
| I6 | a refused program shows the reason, and no download | `E2E-U4` | ✅ COVERED | e2e:209 `a refused program offers no download` + e2e:155 |
| I7 | no hardcoded colour outside tokens | `G-THEME` | 🔴 UNCOVERED | none (already flagged 🟡 in the spec) |
| I8 | viewport 360px → no overflow | `E2E-U5` | ✅ COVERED | e2e:230 `no horizontal page scroll at 360px` |
| J2 | filename carries part + tool | `E2E-U3` | 🔴 UNCOVERED | none |
| J3 | summary numbers derive from the emitted program, not the plan | `G-SUM` | 🔴 UNCOVERED | none |

**Counts: 13 COVERED · 16 PARTIAL · 6 UNCOVERED.**

---

## The COVERED rows — the assertion that would fail

Quoted so the mapping can be checked without re-deriving it.

- **B6** — `core/src/job.rs:479` `assert!(r.refusals[0].why.contains("travel"))` on a
  2400×1200 sheet, plus `:483` `assert!(!r.refusals[0].why.contains("turned"))` so a
  useless turn is not offered. Browser side, `web/e2e/slicer.spec.ts:352`
  `await expect(tooBig).toHaveAttribute('disabled', '')` on the 2700×1200 option.
  *Not asserted: that the 2400×1200 preset exists at all — the e2e names only two of the three.*
- **C1** — `core/src/tools.rs:404` `assert_eq!(counted, lib.len(), "a tool is in zero or two categories")`,
  summing `by_category` over `ToolCategory::all()`. A tool that fell out of every
  category, or landed in two, moves `counted` off `lib.len()`.
- **C2** — `core/src/tools.rs:430` `assert!(v.faults().contains(&ToolFault::MissingAngle))`
  (a V-Bit with no included angle), the opposite direction at `:441`
  `assert!(e.faults().contains(&ToolFault::AngleOnNonAngularTool))`, and
  `core/src/fixtures.rs:1371` `assert!(r.is_err(), "a tool with no chipload window was accepted")`.
  Gate **C6** additionally asserts an invalid tool is refused *by name* at runtime.
- **D1 / D2** — `core/src/job.rs:387` `assert_eq!(r.summary.tool_changes, 2, "expected 2 changes for 3 tools")`
  and `:388` `assert_eq!(r.summary.tools_used.len(), 3)`; `core/src/toolpath.rs:855`
  `assert_eq!(groups.len(), 2, "interleaved tools were not grouped")` proves the
  grouping is not merely a run-length collapse of an already-sorted list.
- **D4** — `core/src/job.rs:429` `assert!(after.contains("G38.2"), "no probe after the tool change")`
  and `:430` `assert!(after.contains("G10 L20 P1"), "the probe result was never written to the WCS")`,
  where `after` is the slice of the program *following* `M0`. The "or an explicit
  acknowledgement" limb is `job.rs:438`
  `assert!(r.notes.iter().any(|n| n.contains("wrong by the difference in tool length")))`.
- **D5** — `core/src/job.rs:412` `assert!(before.rfind("M5").is_some(), "the spindle was not stopped before the pause")`
  and `:418` `assert!(g.gcode[idx_m0..].contains("M3 S"), "the spindle never restarts after the change")`.
- **E5** — `core/src/fixture.rs:252`
  `assert_eq!(nothing.check(...), vec![FixtureFinding::Undeclared])` — an empty
  clamp list produces a finding rather than silence. Browser side,
  `web/e2e/slicer.spec.ts:179` asserts the notes contain
  `'nobody has confirmed the bed is clear'`, and `:185` asserts it *disappears*
  once `confirmed-clear` is ticked, so the warning is not stuck on.
- **F3** — `core/src/import.rs:677` `assert_eq!(parts.len(), 1)` and `:678`
  `assert_eq!(parts[0].inners.len(), 2, "the holes were not attached to the plate")`,
  with winding checked both ways at `:679`/`:680`. Gate **F1**
  (`gates/slicer_gate_check.mjs:808`) raises this to the shipping fixture:
  `dxfHoles === 4 && svgHoles === 4`.
- **G-10** — `core/src/toolpath.rs:933` `assert_ne!(va, vb, "climb and conventional produced the identical path")`,
  then the property that actually defines direction at `:955`
  `assert!(sa * sb < 0.0, "climb and conventional travelled the same way round")`
  (signed area of the emitted polyline), and `:967` `assert_eq!(bounds(&a), bounds(&b), "the direction changed the cut ENVELOPE")`
  so reversing cannot be faked by offsetting the wrong way.
- **I1** — `web/e2e/slicer.spec.ts:71` `expect(painted.ok).toBeTruthy()` where `painted.ok`
  is `seen.size > 3` over `readPixels` samples — a canvas that exists but drew
  nothing fails — and `:73` `expect(errors).toHaveLength(0)` over collected
  `console` + `pageerror` events.
- **I6** — `web/e2e/slicer.spec.ts:214` `await expect(page.getByTestId('status')).toHaveText('refused')`
  and `:216` `await expect(page.getByTestId('download')).toBeDisabled()`. The
  "shows the reason" limb is `:166`
  `await expect(page.getByTestId('blocked')).toContainText('CutsClamp')`.
  *Caveat kept visible: the two limbs are asserted in two different tests against two
  different refusals — no single test proves one refused program does both.*
- **I8** — `web/e2e/slicer.spec.ts:237` `expect(overflow).toBeLessThanOrEqual(0)` where
  `overflow = documentElement.scrollWidth - clientWidth` at a 360px viewport.

---

## PARTIAL — what is covered, and precisely what is not

### A4 — touch plate
**Covered.** `core/src/job.rs:422` proves a probe sequence containing `G38.2` and
`G10 L20 P1` is emitted after a tool change, and `core/src/post_grblhal.rs:326`
errors rather than skipping when `probe_enabled` is false (asserted at
`job.rs:451`).

**Not covered.** (a) the **×2** in the acceptance — nothing asserts the
*seek-then-measure* pair; `assert!(after.contains("G38.2"))` is satisfied by one.
(b) The **settings** the row is actually about — `touch_plate_mm`,
`probe_seek_feed`, `probe_feed`, `probe_max_mm`, `probe_retract_mm`,
`probe_x`/`probe_y` — none of them is asserted to reach the output, so any of
them could be dropped or swapped and every check stays green. (c) The `--probe`
CLI flag itself is exercised by nothing: no gate and no test passes it. *(Run by
hand during this audit it does emit two `G38.2` and one `G10 L20 P1` — the
mechanism works; it is the check that is missing.)*

**A real check** would post one program with a known probe configuration and
assert: exactly two `G38.2` lines, the first at `F{probe_seek_feed}` with
`Z-{probe_max_mm}`, the second at `F{probe_feed}`, a `G10 L20 P1 Z{touch_plate_mm}`
between them and the retract, and a `G0 X{probe_x} Y{probe_y}` before the pair
when either is non-zero — then change each setting and require the corresponding
word to move.

### A6 — machine presets
**Covered.** `web/e2e/slicer.spec.ts:396` saves a machine, **reloads the page**,
reselects it and asserts `:412` `toHaveValue('1234')` for travel X and `:415`
`toHaveValue('8')` for the collet — a genuine persistence round-trip, and the
collet limb catches the specific failure of restoring a machine without the field
that decides which tools are selectable.

**Not covered.** The row is about the **three named presets** (600×900,
1250×670, 300×180). `MACHINE_PRESETS` lives at `web/src/App.tsx:33`, is exposed
as `data-testid="machine-preset"` at `App.tsx:669` — and **no test ever touches
that testid**. So nothing asserts the presets exist, carry those travels, or
survive a save/load. What is tested is a *user-entered* machine, which is a
different feature. Only 2 of a machine's fields are compared, so "unchanged" is
not asserted either.

**A real check** would, for each of the three presets, select it, save under a
name, reload, reselect, and compare **every** machine field against the preset's
declared values.

### A7 — machine editor live validation
**Covered.** `web/e2e/slicer.spec.ts:94` proves a travel change **reaches the
plan**: after `travel-x`=300 / `travel-y`=180 it asserts `:101` `stock-too-big`
visible, `:102` `blocked` visible and `:104` `status` = `refused`.

**Not covered.** The acceptance as written — *"invalid travel cannot be
committed"* — is not asserted, and appears not to be implemented: `travel-x` and
`travel-y` are rendered by `Num` (`web/src/App.tsx:688`) **without a `min`**, so 0
or a negative travel commits silently. The app's actual design is
*commit-then-refuse*, which is a defensible design, but it is not what the row
claims.

**A real check** would either assert that a non-positive travel is rejected at
the input (value not committed, message shown), or the row should be rewritten to
the property the app really has — at which point e2e:94 covers it as-is.

### C3 — tool filter/search
**Covered.** `web/e2e/slicer.spec.ts:114` asserts the category list contains six
named categories (`:119`), that selecting `Drill` populates the tool list with
Brad Point / Twist / Dowel (`:125`–`:127`), and that category is a *rule* not a
label (`:133` `.caps .no` contains `profile`).

**Not covered.** (a) **Search/filter by diameter** — there is no diameter filter
in the UI at all (`web/src/App.tsx` uses `diameter_mm` only for display at
`:972`), so half the feature is neither built nor checked. (b) The acceptance —
*"filtering never changes the underlying library"* — is asserted nowhere: no test
filters, unfilters, and compares the option set back to the full library.

**A real check** would capture the full `tool-select` option list, apply a
category filter, restore it to "all", and assert the option list is identical to
the capture — and separately that a filtered-out tool is still *addressable*
(the collet test at `:319` does this for the collet dimension and is the model to
copy).

### D3 — tool-change comment
**Covered.** `core/src/job.rs:414`
`assert!(g.gcode.contains("TOOL CHANGE -> 3mm end mill"), "the change does not name the tool to fit")`
— the change block echoes the tool's name, not a bare `M0`.

**Not covered.** The acceptance says the block names **Ø and type**. The test
supplies the tool name itself (`tool("3mm end mill", …)`), so the assertion
proves the comment echoes `tool.name` — it *cannot fail* if the real library
named a tool in a way that carried neither diameter nor type. Nothing asserts
that library ids carry a diameter. Nor does any test cover **"every"** change:
the job has exactly one change.

**A real check** would post a 3-tool job and assert that *every* `M0` is preceded
by a comment containing a millimetre value matching that tool's
`diameter_mm` and its category — driven from the tool record, not from a string
the test wrote.

### E2 — clamps by drag and by number
**Covered.** The **by-number** path: `web/e2e/slicer.spec.ts:155` adds a clamp,
types x/y/w/h, asserts `:166` `blocked` contains `CutsClamp`, then moves it clear
and asserts `:171` `status` returns to `runnable` (so the check is not stuck red).

**Not covered.** The **drag** path for clamps, and therefore the whole acceptance
(*"both paths produce the same model"*). Clamp dragging exists — `Viewport.tsx:110`
`draggingClamp`, resolved on the bed plane at `:170`–`:177` — but no test drives
it. The one drag test (`e2e:363`) drags the **sheet**, not a clamp, and asserts
the *datum*. Note also that the sheet-drag path rounds to 0.1mm
(`Viewport.tsx:187`) while the clamp-drag path (`:173`) does **not** — so the
status column's claim that both paths "round to 0.1mm so both paths read the
same" is asserted by nothing and is not obviously true of the clamp path.

**A real check** would drag a clamp on the canvas, read back `clamp-0-x`/`-y`,
type those same numbers into a second clamp, and assert both produce the same
`report` (same G-code / same fixture findings).

### E4 — clamp presets
**Covered.** `core/src/fixture.rs:261` asserts `pressure-bar`, `cam-clamps` and
`screws` each declare clamps and — the important limb — `:266`
`assert!(!f.confirmed_clear, "{name} must not self-certify the bed as clear")`.
`fixture.rs:254`–`:257` covers the vacuum preset: empty clamp list, but
`confirmed_clear == true`, so its `check()` returns empty **where an undeclared
fixturing returns `Undeclared`** (`:252`). That distinction — an empty list from a
vacuum table is not the same empty list as "nobody looked" — is genuinely
asserted.

**Not covered.** The acceptance's literal wording, *"vacuum … **is not** 'no
obstruction'"*, is asserted nowhere; the code models a vacuum zone as exactly *no
obstruction* (`fixture.rs:145`, `clamps: Vec::new()`) and the test asserts that.
If the intended fact is that a vacuum pod/gasket still has height, nothing
expresses it. Separately, `data-testid="clamp-preset"` (`App.tsx:1111`) is
**never exercised by any e2e test**, so no check proves the presets are reachable
from the UI or that choosing one populates the clamp list.

**A real check** would (a) settle which reading is meant and assert it, and (b)
select each preset in the browser and assert the resulting clamp list matches the
core preset for the same stock size.

### F5 — open contours
**Covered.** `core/src/import.rs:701`
`assert_eq!(r.open_contours, 1, "an open chain was reported as closed")` — the
parser counts an unclosed chain instead of silently closing it.

**Not covered.** That it becomes a **named error the operator sees**. The note is
built at `core/src/fixtures.rs:1270` (*"N contour(s) did not close and were NOT
cut …"*) and **no test or gate asserts that string ever appears** — not in the
report, not in the UI notes. Gate **F1** uses `plate.dxf` and `spline.dxf`,
neither of which has an open contour, so the gate never exercises this path. The
sibling case *is* checked (`F1` asserts the SPLINE is named), which makes the gap
easy to miss.

**A real check** would add an open-outline fixture to `gates/fixtures/`, import it
through the CLI with `--json`, and assert the notes contain `did not close`
and that the open contour produced no cutting moves.

### G-1 — arc-preserving offset
**Covered.** `core/src/geometry.rs:338`–`:341` assert an outward offset of 3mm
moves a rectangle's **bounding box** by exactly 3 on all four sides;
`geometry.rs:352` `assert!(arcs >= 4, "offset produced {arcs} arc segments — curves were polylined")`
keeps curves as curves; `geometry.rs:361` asserts a 4mm slot with a 6mm tool
offsets to **nothing** rather than to a tiny path that would be cut;
`rect_profile.rs:226` asserts the emitted span is part + 2×radius.

**Not covered.** *"offset distance = tool radius **everywhere**"*. Every
assertion above is on a **bounding box or a span of an axis-aligned rectangle** —
four straight edges. Nothing samples points along a general offset loop and
measures the distance back to the source contour, so a wrong offset on a curved
or non-convex region (exactly where offsetting is hard) passes all of them.

**A real check** would sample the offset loop densely, compute the minimum
distance from each sample to the source contour, and assert every sample is
within tolerance of the tool radius — on a rounded rect and on a contour with a
concave corner.

### G-6 — multi-pass depth + finish allowance
**Covered.** `core/src/rect_profile.rs:214` asserts 18.4mm at 6mm/pass produces
**3** passes, not 4 — the 0.4mm sliver folded in — and `:207` that the schedule
reaches the total exactly.

**Not covered — and this is the sharp part. There are two `depth_passes`
implementations and the tested one is not the shipping one.**
`rect_profile.rs:70` is **private to the fixture generator**;
`toolpath.rs:186` is the `pub` one that `plan_profile` calls at `toolpath.rs:319`
and is therefore what every real job uses. The two are textually identical today
(both fold when `total - cur < per_pass * 0.25`), but **no test calls
`toolpath::depth_passes`**, so the engine's copy can drift or be edited with
every check staying green. `rect_profile.rs` says of itself that it is *"a fixture
generator, not the engine"* — and the only depth-schedule tests live in it.
Separately, the row's **finish allowance** limb has no profile-side test at all
(`pocket.rs:259` covers pockets only).

**A real check** would test `toolpath::depth_passes` directly as a property —
for a range of totals and per-pass values, the last step is never smaller than
25% of a full pass and the sum reaches the total exactly — and assert a profile
job's finish allowance leaves the wall stock it claims.

### G-11 — cut ordering
**Covered.** `core/src/toolpath.rs:836` builds a part with two holes and asserts
`:842` `assert_eq!(ops.last().unwrap().name, "plate", "the outer profile must be LAST")`.

**Not covered.** That ordering is asserted on the output of
`operations_for_part` for a **single tool**. `plan_job` then runs the ops through
`group_by_tool` (`core/src/job.rs:242`), which **reorders across the part** —
grouping preserves order *within* a group only. So a part whose holes are drilled
with a drill and whose profile is cut with an end mill has its ordering decided by
grouping, and nothing asserts the outer profile is still last. Nothing asserts
the property on the **emitted program** either (the check is on an op list, not on
`( op: … )` section order in the G-code) — which is the exact shape of the defect
gate **P4** was rewritten for.

**A real check** would post a multi-tool job with interior features and assert
that, in the emitted program, the `( op: <part> )` section for the outer profile
appears after every other section belonging to that part.

### H5 — run-time estimate
**Covered.** `core/src/job.rs:564` asserts the estimate is non-zero and
plausible: `:570` `assert!(r.summary.estimated_seconds > 10.0 && … < 3600.0)`;
`job.rs:578` asserts a tool change adds >60s so operator time is not omitted.

**Not covered.** The acceptance's **10%** — nothing compares the estimate against
an independently computed sum of segment times; the only number the assertions
know is a 10s..3600s window three orders wide. The spec already marks this row 🟡
and says it is *"never checked against a real cut"*, which is true and is a
different gap again (that one needs **ops** and a machine).

**A real check** (for the software half only) would recompute Σ(length/feed) over
the emitted moves in the test, independently of `estimate()`, and assert
agreement within 10% — which would catch a missed move kind or a wrong rapid rate.

### I2 — playback scrubber
**Covered.** `web/e2e/slicer.spec.ts:219` screenshots the canvas at full progress
and at 0.1 and asserts `:227` `expect(partial).not.toBe(full)` — the scrubber does
change what is drawn.

**Not covered.** *"scrubber position maps to a **real move index**"*. The
mapping exists (`web/src/Viewport.tsx:387`
`const upTo = Math.max(1, Math.floor(props.moves.length * props.progress))`) and
nothing asserts it: the test compares **screenshot byte lengths**, which is a
proxy that would be equally satisfied by any redraw, and would not notice an
off-by-N, an inverted scale, or a mapping to time instead of index.

**A real check** would expose the drawn move count (a testid, or a `data-`
attribute on the canvas) and assert it equals `floor(total × progress)` at
several positions, including 0 and 1.

### I3 — panels
**Covered.** `web/e2e/slicer.spec.ts:76` asserts nine panels are visible:
`panel-machine`, `-stock`, `-tools`, `-op`, `-clamps`, `-verify`, `-summary`,
`-sim`, `-gcode`.

**Not covered.** The acceptance is *"every model field is reachable from the
UI"* — a claim about **fields**, and the test asserts **containers**. A panel can
be present with half its inputs removed and this passes. Concretely,
`data-testid`s that exist in `App.tsx` and are exercised by **no** test:
`machine-preset`, `clamp-preset`, `material`, `direction`, `dogbone`,
`probe-enabled`, `probe-after-change`, `supports-arcs`, `z-zero-top`,
`show-rapids`, `sim-uncut`, `sim-spoil`, `est-time`, `tool-changes`,
`import-tools`, `export-tools`, `store-import`, `store-export`.

**A real check** would enumerate the config fields the core accepts
(`fixtures::JobConfig`) and assert each has a reachable control — the honest cheap
version is to assert the presence of each known testid and require a new field to
add one.

### I4 — import + parts list
**Covered.** `web/e2e/slicer.spec.ts:240` asserts `:248` the imported file's name
is displayed, `:249` the job becomes `runnable`, and `:252` the notes report
`4 interior feature` — so the holes demonstrably came across, not just "1 part
imported". `:256`/`:257` assert an unreadable entity is named (`SPLINE`,
`NOT imported`), and `:262` that the import can be cleared.

**Not covered.** *"appears as named **parts**"* (plural). Everything asserted is
about the **file** and a hole count; nothing asserts a per-part list, or that a
drawing containing several outlines yields several separately named parts. There
is no `parts list` testid in `App.tsx`.

**A real check** would import a fixture containing two disjoint outlines and
assert two named entries appear, each nameable/selectable.

### I5 — G-code view + download
**Covered.** `web/e2e/slicer.spec.ts:449` is the strongest test in the suite: it
drives the UI off its defaults, reads the **displayed** G-code and asserts `:505`
`expect(browserGcode).toBe(cliGcode)` byte-for-byte against the CLI, and then —
the part most equality tests omit — carries its own negative control at `:524`,
requiring the same comparison to *reject* a CLI run with `depth_per_pass_mm`
changed.

**Not covered.** The acceptance is *"**downloaded** bytes == core output bytes"*,
and the download is never exercised. `download` appears in the suite once, at
`:216`, only as `toBeDisabled()`. The download path builds its own `Blob`
(`web/src/App.tsx:476`–`:481`) from `report.gcode`; nothing asserts the blob's
contents equal what the panel shows, so a truncation, a re-encode, or a stale
`report` capture in that closure would ship unnoticed.

**A real check** would capture the Playwright `download` event on a runnable job,
read the saved file, and assert its bytes equal both the displayed G-code and the
CLI output.

---

## UNCOVERED — no test asserts this

### A2 — spindle min/max, spin-up dwell, PWM, reverse — `G-A2`
Nothing asserts either limb of the acceptance.

- **"an out-of-band `S` warns"** — the warnings exist
  (`core/src/post_grblhal.rs:272`, `:279`, `:283`) and a negative control for
  them already exists: `Plant::RpmOutOfRange`, wired through the CLI as
  `--plant rpm` (`cli/src/main.rs:41`, `:52`), which requests 60,000 rpm. **No
  gate and no test ever passes it.** Run by hand during this audit it prints
  `warning: requested spindle speed exceeds the spindle's maximum` — so the guard
  works and is armed by nobody. A plant built in the callee and never fired by a
  caller reads as protection and is not.
- **"dwell appears after `M3`"** — emitted at `post_grblhal.rs:291`–`:293`
  (`G4 P2.00` with the default `spindle_spinup_s = 2.0`, `types.rs:176`). Nothing
  asserts it. Gate **G2** would not catch its removal (`G4` is not a banned or
  required word), and **G6** asserts the opposite property (cutting with the
  spindle *off* is refused).
- **PWM and reverse** (`spindle_pwm`, `spindle_reverse`, `types.rs:138`/`:143`)
  reach no assertion at all — neither field is read by any test, and `M4` appears
  nowhere in the emitted program.

**A real check** would: run `--plant rpm` and require a non-zero exit or a warning
on stderr naming the spindle maximum (gate-shaped, with the plant as its negative
control); assert a `G4 P{spindle_spinup_s}` line immediately follows `M3` and
disappears when the setting is 0; and either wire `spindle_pwm`/`spindle_reverse`
to the output and assert them, or delete them — a field consumed by nothing reads
as configured.

### B5 — 3D stock in the viewport — `E2E-V1`
`e2e:40` proves the canvas painted *something* (>3 distinct colours) with no
console errors. **Nothing compares the rendered box to the stock numbers.** The
stock could render at the wrong size, in the wrong place, or at a stale thickness
and every assertion holds. The nearest thing is `e2e:106`, which asserts the
`deepest` **readout** follows the thickness — a number in a panel, not the render.
Note the suite's own precedent: the sheet-rotation test (`:296`) exists precisely
because *"a rotation that only turned the render"* is the failure mode here.

**A real check** would read the stock mesh's world-space bounding box out of the
scene (or project its corners and assert against known screen positions at a
fixed camera) and require it to equal `stock-x`/`stock-y`/`thickness`, then change
one and require the box to follow.

### G-9 — ramp and helical entry — `G-ENT`
The acceptance is *"no vertical plunge in a through-cut"*. Ramping is
implemented (`core/src/toolpath.rs:329`–`:344`, with the ramp length clamped to
half the perimeter) and `EntryMode::Ramp` is the default (`types.rs:383`). **No
test or gate asserts the absence of a vertical plunge.** Worse, both toolpath
tests that touch entry explicitly set `EntryMode::Plunge` (`toolpath.rs:978`,
`:1022`) because they are testing leads — so the ramp path is *deselected* by the
only tests near it. `EntryMode::Helix` has no distinct behaviour at all: it is
matched together with `Ramp` at `toolpath.rs:329` and `rect_profile.rs:160`, so
the row's "helical entry" names something that does not exist separately.

**A real check** would plan a through-cut with the default entry and assert that
no feed move descends in Z with no XY component — and, as the negative control,
that the same job with `EntryMode::Plunge` *does* contain one. The Helix limb
needs either an implementation or removal from the row.

### I7 — theme from `brand/tokens.css` — `G-THEME`
Already marked 🟡 in the spec, and confirmed here: **there is no check of any
kind.** `web/src/styles.css:8` does now `@import '../../../../brand/tokens.css'`
and takes the amber/radius/type from it, but the neutral palette is still local
hex (`styles.css:22`–`:26` light, `:37`–`:41` dark) and there are hardcoded
colours in components — `web/src/App.tsx:1244`–`:1247` sets
`background: '#2e7d32' / '#e6a700' / '#1565c0' / '#9e9e9e'` inline for the legend
swatches. So the acceptance (*"no hardcoded colour outside tokens"*) is false
today as well as unchecked. The spec row is honest about the palette; the point
here is that **nothing would go red** if the `@import` were deleted tomorrow.

**A real check** is cheap and belongs in the gate runner: scan `web/src/**` for
`#[0-9a-f]{3,8}` and `rgb(`/`hsl(` literals outside the token definition block in
`styles.css`, fail on any hit, and separately assert `styles.css` still imports
`brand/tokens.css` and that a named token actually resolves in the browser
(`getComputedStyle`), because an import that 404s is silent in CSS.

### J2 — `.nc` download filename — `E2E-U3`
The filename is built at `web/src/App.tsx:481`:
`` a.download = `${report.job}-${toolId.replace(/[^\w.-]+/g, '_')}.nc` `` — so the
behaviour exists and does carry part + tool. **No test asserts it**, because no
test triggers a download at all (see I5). A regression to `output.nc` — or to a
stale `toolId` — would be invisible.

**A real check** would capture the Playwright download event and assert
`download.suggestedFilename()` contains the job name and the selected tool id,
then change the tool and require the filename to follow.

### J3 — program summary — `G-SUM`
The acceptance is a **provenance** claim: *"summary numbers derive from the
emitted program, not the plan"*. Nothing checks it, and reading the code the
claim does not hold: `core/src/job.rs:339` computes the summary as
`let (cut, rapid, secs) = estimate(&path, &job.machine)` and `estimate`
(`job.rs:85`) walks `path.moves` — the **toolpath**, i.e. the plan. Fields
`cutting_distance_mm`, `rapid_distance_mm`, `estimated_seconds` and
`deepest_z_mm` (`job.rs:341`–`:344`) are all plan-derived, and the browser panel
renders exactly those (`App.tsx:1285`–`:1295`). Anything the post does *after*
the plan — refusing a probe (`post_grblhal.rs:330`), degrading arcs, dropping a
move — is invisible to the summary.

This is the same defect class the repo has already been bitten by twice and
written about: gate **P4**'s own comment records that dogbone counts *"described
the plan, not the output"* for weeks, and gate **P3**'s `pocketFloorZ` helper
exists because *"the number a gate asserts on comes from the emitted program, not
from the plan that produced it"*. J3 asserts that lesson as a property and
nothing enforces it.

**A real check** would re-derive at least two summary numbers by parsing the
**emitted G-code** — total feed distance from the `G1/G2/G3` words, deepest Z from
the `Z` words — and assert agreement with the reported summary within tolerance.
The negative control is the one that makes it a gate: make the post drop or clamp
a move and require the comparison to go red.

---

## Counts

| Verdict | Rows | Which |
|---|---|---|
| ✅ COVERED | **13** | B6, C1, C2, D1, D2, D4, D5, E5, F3, G-10, I1, I6, I8 |
| 🟡 PARTIAL | **16** | A4, A6, A7, C3, D3, E2, E4, F5, G-1, G-6, G-11, H5, I2, I3, I4, I5 |
| 🔴 UNCOVERED | **6** | A2, B5, G-9, I7, J2, J3 |

35 rows, 33 distinct phantom gate ids (`E2E-V1` and `E2E-U3` are each cited
twice).

**The six UNCOVERED rows are the real risk**, and two of them are physical:
**G-9** (a vertical plunge in a through-cut burns the bit and the work — the
behaviour is implemented and deselected by the only tests near it) and **A2**
(an out-of-band spindle speed; the negative control `--plant rpm` already exists
and is fired by nothing). **J3** is the one that would quietly poison other
checks, because a plan-derived summary is exactly the defect gates P3 and P4 were
each rewritten to escape.

None of the 35 rows is currently protected by the id the spec names, including
the 13 COVERED ones — a reader following the Gate column finds nothing in every
single case.
