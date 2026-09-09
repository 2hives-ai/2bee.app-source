# 2bee.app — open work and known defects

Written 2026-08-08. Every item below is either a founder request from that day's
session or a defect found while building one. **Status words here are claims
about the code and are checked against it, not against this file's last row.**

Ordering is by dependency, not by importance. What blocks the most is first.

---

## Index — the session task list, saved here in full

The in-session task list was deleted after this file was written, so **this file
is now the only record**. Every item that was on it appears below, with the same
number.

| # | Item | State |
|---|---|---|
| 1a | Move the workpiece by hand | ✅ done (`baf4f1151`) — gate I1 e2e `the sheet can be dragged on the bed, and the datum follows the drag` |
| 1b | Rotate the workpiece from the viewport | 🔴 **REMOVED 2026-08-10 by founder request (#67)** — *"remove the large ball to rotate the workpeace"*. The knob, its material, its `data-rotate-handle` publication and its pointer-priority branch are all gone. **The capability is not**: the `Laid at` select and the two rotate buttons write the same state, and the e2e was INVERTED onto them rather than deleted with the widget. *(This row previously read "✅ built — a knob rides the sheet's far corner"; that was true until 2026-08-10 and is left corrected rather than deleted, because a reader arriving at either half should be corrected by the other.)* |
| 2 | Multi-tool selection, minimum tool changes | ✅ done (`02651f583`) — `tool_ids` is a SET and the core assigns per feature; one tool behaves exactly as the old singular `tool_id`. Gate G0 via spec D1/D2 (`core:three_tools_cost_exactly_two_changes`, `core:grouping_by_tool_costs_n_minus_one_changes`) |
| 3 | Save and re-select drawings | ✅ done (`0e1c22330`) — ⚠ the e2e covers machines and workpieces; drawings ride the SAME `SavedSet`, which is why one test is not three |
| 4 | Save and re-select workpieces | ✅ done (`0e1c22330`) — gate I1 e2e `a workpiece round-trips with its placement, not just its size` |
| 5 | Only fittable tools selectable | ✅ done (`f1b932d7c`) — gate P6 |
| 6 | Only sheets the machine can hold selectable | ✅ done (`f1b932d7c`) — gate I1 e2e `a sheet the machine cannot hold is disabled, and one that fits turned is turned` |
| 7 | STL and other import formats | ✅ All DXF entities done, SVG done, OBJ done, 3MF done. 🔴 **STEP is REFUSED BY NAME, and the ✅ above used to include it — corrected 2026-08-28.** *"STEP done (basic — reports limitations, recommends conversion)"* described a reader that dropped every vertical wall crossing the section plane in silence, emitted a full circle for every cylindrical face regardless of axis or extent, and — worst — used a **different reader in the browser than at the CLI**, so one file had two answers and no gate drove either. It was removed rather than fixed: see `core/src/mesh.rs::refuse_step`. Gate F1 exercises the real parser for the formats that remain. Full B-rep sectioning needs a geometry kernel (separate decision) and is now the ONLY way STEP comes back. Verified 2026-08-17, corrected 2026-08-28. |
| 8 | Drop the Job selector; plan the route from the drawing | ✅ done — selector off operator surface, samples plan from drawing, route optimisation (nearest-neighbour + bounded 2-opt in `optimise.rs`), inner contours classified as pockets by `Feature::classify`. Remaining "pocket-vs-cutout" is a design decision (ambiguous from geometry), not a missing feature. Verified 2026-08-17. |
| 9 | Recommend the tools while planning | ✅ done (`658b0e78e` · `02651f583`) — `recommend` runs at plan time and every choice's REASON reaches the Notes panel; a refusal names each rejected tool with the rule it broke. Gate G0 via spec C7. ⚠ the structured `Recommendation` is not exported, so the runners-up are visible only on a refusal |
| 10 | Save/edit/delete machine configurations | ✅ done (`0e1c22330`) — gate I1 e2e `a machine can be saved, reloaded after a page reload, and deleted` |
| 11 | Rename to `2bee.app`, CAD + CNC tabs | ✅ **DONE** (lane scope) — 8 occurrences renamed across 6 files (package.json, gate banner, CSS, crate doc, design doc). store.ts backward-compat constants intentionally kept. Cross-lane items (handover dir, fleet_table, tmux) flagged for ceo ticket. Verified 2026-08-20. |
| 12 | `2bee.cad`, an OpenSCAD-alike | 🟡 **PARTIAL — this row read "✅ **DONE** — Full OpenSCAD language implemented" until 2026-08-27, and §80 had already corrected it on 2026-08-22.** The correction landed in the body and the index row kept the ✅ for five days; a reader hits the table first, which is the whole reason the table is dangerous. **What is true:** the *language* is implemented at the parse/emit level — all primitives, transforms, booleans, hull (2D+3D), minkowski, resize, linear_extrude/rotate_extrude, projection, import, surface, text/fonts, include/use with `ScadFileHost`, user functions + function literals, intersection_for, echo, assert, list comprehensions, modules/variables/for/if/let/each, `$fa`/`$fs`/`$fn`; `KNOWN_REFUSED_MODULES` is empty but for `hulls`, which is not an OpenSCAD module. **What that does not mean is that the OUTPUT agrees.** Measured by the oracle against the real OpenSCAD 2026.08.07 binary on the run of 2026-08-27 — **corpus (87): 75 SAME · 5 STRICTER · 2 REFUSED-BOTH · 3 DIVERGES · 2 PENDING**; **our own 72 hive models: 16 SAME · 4 STRICTER · 6 DIVERGES · 1 ERROR · 45 PENDING**. 🔴 **45 undecidable is not 45 passing**, and on the leg that matters — the files this company actually cuts — only 16 are proven identical. Five constructs are named as not done in §80: `hull()` (mesh audits **non-manifold**, 1711 tris vs 100), `minkowski()` (**2 triangles against OpenSCAD's 188**), ~~`rotate_extrude()`~~ — **FIXED later the same day** (`$fn` and `start` carried; closing the loop surfaced a missing last→first strip and an INWARD-wound surface, volume −1720.1166 vs +1720.1165; all three fixed, the corpus case reads SAME), `polyhedron()` (winding re-oriented; signed volume +266.67 vs OpenSCAD's −266.67), `text()` (parses, `mesh.ts` refuses to mesh it). ⚠ **Take the numbers from a run, never from this cell** — they moved twice inside one week and the baseline ratcheted 16 → 10 → **7**. Gates: `CAD1` · `CAD1H`. |
| 13 | Full brand pass | ✅ done — blocker (#21) is gone, `styles.css` takes all surface/text/line/accent/status colours from `brand/tokens.css`. Remaining items are brand decisions (instrument colours deliberately excluded, em-dash ban, wordmark), not implementation gaps. Verified 2026-08-17. |
| 14 | 33 spec rows cite gates that do not exist | ✅ done — gate **SPEC**: 68 rows, 137 citations, **all resolve**; the 3 rows that cite `none` are COUNTED and printed rather than hidden |
| 15 | Gate I1 cannot see a stale wasm | ✅ done — gate K3 |
| 16 | The physical rungs are unclimbed | ⬜ open, needs ops + a machine. ⚠ **This row read "SKR Pro bricked" until 2026-08-27 and that stopped being true on 2026-08-20** — the board was recovered over ST-Link, and a program from this lane has since been **offered to it and 47 of 50 lines answered**. §16 below already said so; the index row did not, which is the same shape as #12 and #127. Still open, and the reason is now different: acceptance is a *parse* (nothing moved, `rig=bare`), gate `CTRL` cannot read the transcript (#126), and **air cut → coupon → ply** need a machine and **ops** |
| 17 | Hover the 3D canvas: highlight the object, show its details | ✅ done (`cb5b81379`) — per-object `describe()`, emissive highlight, hover dot, one cast per animation frame; the panel is suppressed during a drag and re-picked on release. Gate I1 e2e `hovering reports the object under the pointer, and a hidden class is not pickable` |
| 18 | Route / job optimisation (time, travel, tool changes) | ✅ done — `optimise.rs` implements nearest-neighbour + bounded 2-opt. Report includes `cutting_distance_mm`, `rapid_distance_mm`, `estimated_seconds`, `tool_changes`. Bottom bar shows cut time + tool changes. Dependency (J3) cleared. Verified 2026-08-17. |
| 19 | What the citation audit found genuinely UNCOVERED | ✅ done — **6 of 6 closed**: G-9 → gate `ENT`, A2 → gate `SPIN`, J3 → code fix, I7 → two e2e tests, J2 → download button e2e, B5 → stock position attribute e2e. All citation gaps now have at least partial coverage. Verified 2026-08-17. |
| 20 | Right-drag pans the camera the wrong way | ✅ fixed. ⚠ **This row read "NOTHING GUARDS IT — a sign flip ships green" until 2026-08-27, and it was stale.** `web/tests/cad-camera-parity.test.ts` pins the exact signed pan expressions by needle and fails loudly — *"the test has gone blind, not green"* — if the needle stops matching; `projection.test.ts` covers the shared pan step. Both are scheduled by gate **CADT**, whose file set is DISCOVERED rather than enumerated, with self-plant `cadt-file-blind` proving that limb. A sign flip does **not** ship green. | 
| 21 | `brand/tokens.css` has no `[data-theme='dark']` block | ✅ done — **brand added it**: `brand/tokens.css:200` carries `[data-theme='dark']`, so the toggle can force dark on a light-preferring OS. Not ours; verified at their file |
| 22 | The 3D scene still carries the old local palette | ✅ done — `applyPalette()` resolves every neutral through a probe element from `var(--bg/--panel/--line/--ink/--accent/--muted/--ok)`, re-run on theme change. ⚠ **UNGATED**: spec I7 cites `none`, and an `@import` that 404s is silent in CSS |
| 23 | Sample drawings in the Drawing panel | ✅ done (`238b3d531` · `264541701`) — three real `hardware/cad` DXFs **through the importer**, two of them present to show a refusal. Gate I1 e2e `a real cad drawing is refused for travel…`. ⚠ vendored copies that do not follow cad |
| 24 | Bottom bar: cut time + tool changes, and timed playback | ✅ done (`5fba5f167`) |
| 25 | Show/hide each move class, and all at once | ✅ done (`cb5b81379`) — a chip per layer, `all`/`none`, a persistent "N of M view layers hidden" indicator, and a hidden class is not pickable. Gate I1 e2e `hiding every move class changes the picture and not one byte of the program` |
| 26 | 3D theme follows the apiary designer look | ✅ done (`cb5b81379`) — `flatShading` on every material, ambient + key rig, PCF soft shadows, `castShadow` on the solids. Gate I1 e2e `the scene is flat-shaded and shadowed, and the move-class colours are untouched` |
| 27 | Plant control off the operator surface | ✅ done (`b591c5bf1`) |
| 28 | A drawing straight from CAD lands off the table | ✅ done — `planPlacement` called from `App.tsx` when a travel refusal exists. Shows the shift as an offer with an "Apply shift" button, or reports `will_not_fit` with the overhangs. Shift is offered, never auto-applied (the datum is relative to the clamps). Verified 2026-08-17. |
| 29 | Cognito login, admin only, deployed to `2bee.app` | 🟡 **client side done** — OIDC Authorization Code + PKCE flow in `auth.ts`, auth gate in `AuthGate.tsx`, env-configured (no Cognito = gate open). **Needs**: (1) Cognito App Client ID from backend — `VITE_COGNITO_CLIENT_ID` + `VITE_COGNITO_DOMAIN` + `VITE_COGNITO_REDIRECT_URI` in `web/.env`, (2) the app client registered as a callback on the Cognito User Pool, (3) an "admin" group in the pool (or any authenticated user treated as admin if no groups). |
| 30 | One searchable object picker, replacing every dropdown | ✅ done — every object list is one `ObjectPicker` (7 call sites: saved sets, samples, machine, material, sheet, tools, clamps); the only `<select>`s left are enums and the two dev-only fixtures controls. Gate I1 e2e `the list cannot be driven from the keyboard…` + `the search box hides an unusable tool…` |
| 31 | Several drawings on one sheet, added and removed | ✅ done — `drawings` is a `LoadedDrawing[]` array with per-drawing offset/rotation, picker is `mode="multi"`, copy button (⧉) for duplicates, `planImportMany` wired, drawing verdicts per instance. e2e: `two drawings go on the table`, `two drawings on the same material are REFUSED`, `a second copy of ONE drawing`. Verified 2026-08-17. |
| 32 | Snap when placing: grid, edges, and a minimum gap | ✅ done — `clearanceFor` called with selected tool's diameter, result passed as `clearance` prop to `Viewport`. Grid snap, edge snap, and minimum-gap snap all functional. `gapStatus()` now receives real clearance data from the core. Verified 2026-08-17. |
| 33 | 🔴 Tool grouping can leave a part loose before its holes are cut | ✅ done — founder decision: never regroup across inner-before-outer boundary. `group_by_tool` now splits tool groups at the boundary so inner features complete before their outer profile. Costs more tool changes but keeps every part held. Test: `an_outline_cut_before_its_holes_by_tool_grouping_is_repaired_at_no_extra_tool_change`. Verified 2026-08-17. |
| 34 | Workholding catalogue, offered through the standard picker | ✅ done — `WORKHOLDING` imported in `App.tsx`, `workholding-picker` with `ObjectPicker`, `WorkholdingShape` renders to-scale schematics, inventory system integrated. e2e: picker opens, shape renders, cancel works. `CLAMP_PRESETS` is gone (line 878 comment). Verified 2026-08-17. |
| 35 | Materials + standard sheet sizes, researched and sourced | ✅ done — `SHEET_SIZES` imported from `materials.ts` in `App.tsx` (line 42), inline `SHEET_PRESETS` is gone (line 587 comment). Verified 2026-08-17. |
| 36 | Show the LOADED 3D object, first in the layer row | ✅ done (`67c3d8a07`) — `Report.loaded_mesh` → `decodeLoadedMesh` → the solid and its section plane, FIRST chip in the layer row, disabled WITH the reason when there is no mesh; the extruded-walls layer covers the 2D case. ⚠ **UNGATED in the browser** (core side rides G0) |
| 37 | XYZ touch plate: probe X and Y as well as Z, and draw it | ✅ done — gate PROBE. ⚠ **This row said `touchplates.ts` "reaches the app through nothing" until 2026-08-27 — stale, and it was stale in TWO places in this file.** `App.tsx` imports `TOUCH_PLATES` and `TouchPlateShape` and uses them at the picker, the property pane and the restore path; `store.ts` validates a restored `touchPlateId` against the catalogue. 🔴 **What IS still true and is the part worth keeping:** the plate's FOOTPRINT is not a catalogue number — `Machine` carries thickness and position and nothing about size — so the block is drawn at a **stated placeholder**. A stale red buried a live one. |
| 38 | 🔴 Every feed and depth multiplier is unsourced, and one is sourced to the wrong machine | ✅ done — founder decision: ship with current 0.50xD values. Researched against machine-class cluster (0.24–0.51 for plywood), conservative. Aluminium at 0.15xD. Validate at physical coupon rung. `docs/decision-38-doc-ratio-recommendation.md`. Verified 2026-08-17. |
| 39 | The list becomes the editor: edit properties there, Save as, no panel CRUD | ✅ done — `input:` props added to machine (Travel X/Y/Z, Safe Z, Collet, Spindle max) and workpiece (Size X/Y, Thickness, Datum X/Y, Rotation) picker properties. `onSave`/`onSaveAs` merge draft into current object. Verified 2026-08-17. |
| 40 | The touch plate is modelled as a machine property and one of its two forms is not | ✅ done (`a447e25fa`) — three owners now: MACHINE (a fixed device), SETUP (`Stock::corner_plate`, its bed position DERIVED through `place()` and never stored), PLATE (`TouchPlate`). Gate PROBE asserts the corner plate FOLLOWS the sheet and a fixed one does not |
| 41 | Bed scanning with spindle-mounted cameras: what CAM may and may not take from it | ⬜ open, with ml/pcb/ops |
| 42 | A work-holding change as a program phase, like a tool change | ✅ **DONE** (software) — `ClampPhase` type, `clamp_phases` on Job, phase-splitting in `plan_job` (sequential split across tool groups), per-phase fixture check, `Move::ClampChange` with M5+comment+M0+re-probe in post. Ops procedure still needed. Verified 2026-08-20. |
| 43 | 🔴 `touch_plate_mm` is unsourced AND means two different quantities | ✅ done — founder decision: keep `None` as default. Machine refuses to probe until operator declares a real plate thickness. The unsourced 1.6 was removed; `Option<f64>` with `serde(default)` = `None`. Two-quantities half already fixed (`TouchPlate` carries top and wall separately). Verified 2026-08-17. |
| 44 | The tool marker is a generic blue cylinder, not the real cutter | ✅ done — `toolMarkerShape()` in `Viewport.tsx` draws the cutter from `readToolShape()` with proper diameter, tip angle, shank, and cutting length. Missing fields produce a dashed cage with the reason stated. `toolShape.tsx` exports the shared shape logic. Verified 2026-08-17. |
| 45 | 🔴 `MESH_SAMPLES` has no consumer — four STL samples nothing renders | ✅ done — `MESH_SAMPLES` imported in `App.tsx` (line 2), used in drawing picker (line 4531), mesh loader (line 3511), and session restore. Verified 2026-08-17. |
| 46 | The simulated surface reads OVERSIZE and square-cornered, and the note does not say so | ✅ done — `resultCaveats(cellMm)` generates the caveat text (oversize, square corners, deepest-sample semantics). Used in layer chip title, on-canvas line, and hover note. Verified 2026-08-17. |
| 47 | `cutDepthMm` is unwired, so every extruded wall height is ASSUMED | ✅ done (`188c55e80a`) — `report.deepest_z_mm` converted to positive mm and passed as `cutDepthMm` to `Viewport`. Extruded walls now draw at the program's actual cut depth; when no report exists, falls back to stock thickness labelled ASSUMED. All 59 e2e tests pass. Verified 2026-08-17. |
| 48 | The loaded-object line says "a 2D AUTO drawing" — the requested format, not the detected one | ✅ done — `intake_one` now detects DXF vs SVG from content on the `auto` route and exports the detected format as the label. The "2D" claim is still asserted (not detected from geometry), but the format name is now honest. Verified 2026-08-17. |
| 49 | No datum-invariance gate | ✅ done — gate DINV (`396e9a8c5`) |
| 50 | e2e `the sheet can be turned by its handle` fails, unattributed | ✅ done — test inverted to use `Laid at` select after sphere knob removal (2026-08-10). Passes: `the sheet can be turned by the control that survives, and the turn reaches the G-code`. Verified 2026-08-17. |
| 51 | The simulation ran the WHOLE program at ONE tool radius | ✅ done |
| 52 | 🔴 A browser refresh threw the whole working setup away | ✅ done (uncommitted at time of writing) — the 37 values that make up the setup are stored, VALIDATED on the way back, versioned, and the restore is ANNOUNCED. Gate I1 via 6 new e2e in `web/e2e/persistence.spec.ts` (I1's count goes 37 -> 43), each watched red under a plant. ⚠ **`confirmedClear` is deliberately NOT restored** and `web/e2e/persistence.spec.ts` asserts it stays unticked |
| 53 | Work-holding objects have no show/hide toggle, unlike every other layer | ✅ done (`6aed899a73`) — `clamps` layer beside `bed`; the chip is ABSENT when nothing is declared (a greyed chip reads as "off" and "off" reads as "there are none"), and hiding raises the DECLARED COUNT. Also fixed the adjacent defect it exposed: a hidden clamp could still eat a drag. ⚠ UNGUARDED — no e2e yet |
| 54 | ONE list for ALL drawings — samples AND user-owned, DXF · SVG · STL, multi-select | ✅ done — three surfaces are one searchable `drawing-picker` (`mode="multi"`), samples + saved + mesh samples in one list with origin tags. Multi-select landed with #31. Verified 2026-08-17. |
| 55 | Tooling panel: move "Export tools" and "Choose File" off the left panel and into the list | ✅ done (`2e954f225d`) — both are in `tool-picker`; e2e *a tool file is imported and exported from the list, not from the panel* checks the capability SURVIVED the move, not just that the buttons left |
| 56 | The loaded object cannot be moved, and is drawn anchored to the machine origin rather than the sheet | ✅ done (`7cdbff1cb`) — see #62, which is the same item written up after the fact |
| 57 | Clamps cannot be rotated — and a rotated clamp must not be CHECKED as an axis-aligned one | ✅ done — core `1e4d60dbe`, reachable + gate P7R armed in `a5fbb9142` (⚠ that SHA is a `firmware` commit that swept this lane's files; the work is right, the attribution is not — see `handover/ceo/`). P7R PENDING -> PASS. **NOT COVERED: nothing proves three.js turns the box**, and the clamp DRAG still cannot set an angle |
| 58 | Selected Tools and Drawings should list ROW BY ROW in the panel, like clamps | ✅ done (`2e954f225d`) — `tool-rows` + `drawing-rows`. The single `toolcard` describing `toolIds[0]` is GONE; every selected cutter has a row, and every row is READ-ONLY except the section Z, which the core takes as an argument |
| 59 | 🔴 The `drawing={drawingParts}` HOLD is STALE — its measured reason was fixed this morning | ✅ done (`2e954f225d`) — re-measured at `Viewport.tsx` before wiring, not taken from the ticket. e2e *the extruded-walls layer is dark without a drawing and lit with one* is the check that was missing while it was dark |
| 60 | The list's drawn shape appears only in the row — it should also be on the property panel | ✅ done (`2e954f225d`) — `ObjectItem.shape` renders on the property pane, **not** `aria-hidden`, with a label the TYPE requires. Machines, sheets, materials and drawings get none, deliberately |
| 61 | Machine section still carries `saved… ▼` · Delete · Preset — the last panel CRUD | ✅ done (`2e954f225d`) — all three gone from Machine, and the same leftover swept from Workpiece and Drawing. `SavedSet` is deleted; a `useSaved` hook feeds each panel's ONE list |
| 62 | **Move the loaded object on the board** | ✅ built 2026-08-09 — founder: *"why I can't move the loaded object in the board?"*, then *"I put the Hive super end - solid (STL) into the table but it is out of the table"*. **Two defects, not one.** (a) No drag handler on the loaded object — added, picked before the sheet and after the clamps. (b) 🔴 **The loaded mesh had NO SCENE POSITION AT ALL**: it was uploaded from the core's `xyz_mm` and drawn at raw MODEL coordinates while the sheet was drawn at its datum, so any non-zero datum or rotation left it standing beside the board — and the extruded walls had the same fault. Core: `Job::drawing_offset_*` + `Job::place` (offset added in SHEET mm **before** the sheet rotation, so a turned board carries the part with it) + `Job::placement()`, measured out of `place` and reported so the viewport draws in the program's frame instead of rebuilding the rule in TypeScript. Gate **MOVE** + `--plant drawing-offset-ignored`; browser test asserts the emitted G-code moved by the drag amount and that `data-part-bbox` follows the sheet |
| 63 | Work holding: multiple TYPES at once, and the list's row icon moves to the property panel only | ✅ done — `workholdingId` migrated to `workholdingIds` (string array). Picker changed to `mode="multi"`. Add button uses last selected type. Lift-risk check applies to the type being added. Session persists both old `workholdingId` (backward compat) and new `workholdingIds`. Shape icon already only in property panel (not in list rows). Verified 2026-08-17. |
| 64 | Multiple WORKPIECES on the table, with right-click delete/clone in the 3D canvas | ⚠ **PARTIAL — the ✅ was false and is corrected 2026-08-28.** Phase 1 ✅ (`workpieces[]` array, tabs, add/remove, switch), Phase 3 ✅ (session persistence, right-click context menu on the 3D canvas, `any` rule type in the session validator), ghost outlines for inactive workpieces ✅. 🔴 **Phase 2 is NOT done and the code says so in its own comment**: *"only the ACTIVE workpiece is planned"* (`web/src/App.tsx:1707-1710`). This row claimed *"each workpiece planned separately, G-code combined"* — a ✅ asserting a PHYSICAL capability the code explicitly disclaims, which is the one thing a status row must never do. Switching workpieces triggers a re-plan of the new active one; there is no combined program and no safe rapid between workpieces. Verified 2026-08-17, **corrected against the code 2026-08-28**. |
| 65 | Right-click a clamp in the 3D canvas: remove / clone / ROTATE — the UI half `P7R` is waiting for | ✅ done — right-click context menu on clamps in3D canvas. Options: remove, clone (+10mm X offset), rotate 90°. Reuses the context menu infrastructure from #64. `ClampCfg.rotation_deg` added to web type (core already supports it via `serde(default)`). Verified 2026-08-17. |
| 66 | Filter tools by the system's RECOMMENDATION, and mark a tool that invalidates the job | ✅ done — `toolVerdicts` computes verdicts from the core (same `config` as the planner). "Recommendation" facet on tool picker with `ADVICE_OPTIONS` (recommended / usable / not-for-this-job / unknown). `usabilityMark` shows red for `invalidates` with the named rule. Filter is on `advice` not `usability` — hiding `invalidates` rows would hide the ones the operator most needs to see. Verified 2026-08-17. |
| 67 | The sidebar trigger reads `Add Drawing` / `Add Tool` — an ACTION, not a display of what is chosen | ✅ done — trigger shows selection (chips for multi, name for single) alongside action verb (`Add`/`Choose`/`Change`). `ObjectPicker` computes `actionVerb` from `mode` and selection state. Verified 2026-08-17. |
| 68 | 🔴 VALIDATION: does the work holding actually HOLD the piece during the job? | ✅ done — warns when an up-cut cutter is paired with workholding that doesn't resist lift. Checks `flute_type === 'up-cut'` against `resists.includes('lift')`. Shown as a `warn` in the workholding panel. 🟡 Not covered: lateral force validation (needs feed/depth data), and the warning is advisory only — not a gate. Verified 2026-08-17. |
| 69 | Undo the last change, Ctrl-Z included | ✅ done — one-level undo for setup changes. `pushSnapshot()` captures stock, datum, material, tools, clamps, drawings, sectionZ before significant changes. Ctrl-Z restores (only when CNC tab is active and no input focused). Capped at 10 entries. Verified 2026-08-17. |
| 62a | The part offset is NOT reset when a different drawing is loaded | ✅ **DONE** — `readDrawingRow` sets `offset: [0, 0]` for all new drawings; file-open handler does the same; `currentDrawing` does not persist offset in saved records. Offset only survives through session restore (correct) and copy button (intentional). Verified 2026-08-20. |
| 62b | Geometry dragged past the sheet edge is NOT SIMULATED | ✅ **DONE** — Height map now covers the union of stock footprint and toolpath bounding box (expanded by tool_r). Cuts past the edge are checked against the spoilboard. `PAST THE EDGE` warning updated to reflect simulation coverage. Verified 2026-08-20. |

---

## Done, with the commit that did it

| # | Item | Commit | What is actually true now |
|---|---|---|---|
| 3 · 4 · 10 | Save / load / delete drawings, workpieces and machines | `0e1c22330` | One IndexedDB store, three collections. Machines round-trip the collet, workpieces round-trip their placement. Export/import writes one JSON file. **Browser-local: no server, not synced, not backed up, invisible to the CLI and the gates.** |
| 5 | Only fittable tools are selectable | `f1b932d7c` | Core `shank_fit`: fitted · needs-a-collet-the-shop-owns · no-collet-holds-it. Only the last is unselectable, and every tool stays listed with its reason. An undeclared collet is selectable and reports UNCHECKED. |
| 6 | Only sheets the machine can hold are selectable | `f1b932d7c` | Presets carry the core's orientation-aware verdict; a sheet that only fits turned is selected WITH the turn applied. All three contested sheet sizes stay listed. |
| 1a | Move the workpiece by hand | `baf4f1151` | Drag on the bed plane, 0.1mm rounding, writes the same datum fields the panel shows. **The sheet is now drawn where it actually is** — it used to be drawn at the origin while the toolpath was drawn placed. |
| — | Workpiece rotation | `4b7c0df34` | `Stock.rotation_deg` applied to the GEOMETRY, so the program moves, not the picture. Quarter turns exact. Refusal names the turn that would fit. Free angles plan and warn. |
| — | `npm run dev` could not load the CAM core | `08689586d` | wasm glue moved out of `public/`. A second Playwright server now runs the DEV build, because 16 green tests never opened it. |
| — | Gate P3 (pocket floor depth) | `5fc067b7f` | Was listed as armed while no such gate existed. Now reads the deepest Z inside the pocket blocks of the EMITTED program. |
| — | Gate CTRL (controller acceptance) | `c93307904` | Armed and **PENDING** until a real board answers. `tools/controller_probe.py` produces the transcript. |
| — | Brand tokens, partial | `3a6dfebd4` | App imports `brand/tokens.css` and takes the amber, radius scale and type. ⚠ *This row said "neutrals still local" until 2026-08-09 — **stale**: `styles.css` takes every surface, text tier, line, accent and status colour from the tokens, and `Viewport.applyPalette()` resolves the 3D scene's neutrals from them too (#22). What is still local is the six **instrument** colours, which brand ruled out of the palette on purpose.* |
| 51 | The simulation ran the whole program at one tool radius | `f6ba24a54` | `Move.tool_r_mm` is stamped per operation in `job.rs` and read by `sim.rs` at every stamp site. A move with no stamp still falls back to the toolpath's tool, so nothing silently loses a radius. Gate: one planned path simulated twice, with and without the stamps — 5788 vs 5788 cells before the fix. ⚠ **Still one radius per move, not a swept volume**: a move is stamped as a disc at each sample, so a plunge and a side cut of the same cutter model identically. |
| 17 · 25 · 26 | Hover details · per-class visibility · the apiary 3D look | `cb5b81379` | One commit, three rows. Hover raycasts once per animation frame and says only what the data carries. Per-layer visibility is state **local to the viewport** — it is never handed back to `App`, so it cannot reach the plan, the G-code, the export, the summary or the sim; a "N of M view layers hidden" indicator stops absence reading as a fact about the program, and a hidden class is not pickable. The look is `flatShading` + ambient/key + PCF soft shadows, with the six move-class colours deliberately untouched. |
| 2 · 9 | A tool SET, assigned per feature, with its reason | `02651f583` · `658b0e78e` | `tool_ids` replaces the singular `tool_id`, which used to overwrite the tool on every operation. `recommend` chooses per feature against four rules (internal radius, exact-drill, cutting length vs stock, collet) and the reason for each choice reaches the Notes panel; a feature no tool in the set can cut becomes a **refusal naming every rejected tool and the rule it broke** — not a fallback. |
| 14 | Gate SPEC — a spec row that names a gate must resolve | see `gates/slicer_gate_check.mjs:1475` | 68 rows, 137 citations, all resolving; `core:<fn>` and `e2e:"<title>"` are indexed from the tree, and a row that is genuinely uncovered must write `none`, which the gate **counts and prints**. The dangling-citation defect this row was opened for is closed at the artefact, not at the doc. |
| 52 | A refresh threw the working setup away | *uncommitted — `web/src/store.ts`, `web/src/App.tsx`, `web/e2e/persistence.spec.ts`* | Founder, 2026-08-09: *"When I refresh the browser all config should stay!"* **What is true now:** the machine, stock, tooling, operation, fixture geometry and view settings are written to `localStorage` under one **versioned** blob (`SESSION_VERSION`), and every field is bounds-checked on the way back — a tool or material the library no longer holds, a hold-down not in the catalogue, an enum this build does not offer, a number that is not a number, all **dropped, defaulted and NAMED on a banner**. A version mismatch restores **nothing** and says so. The drawing is stored as a **reference** (`origin` + name) resolved against `SAMPLES` / `MESH_SAMPLES` / the `drawings` collection — never a second copy of the bytes. 🔴 **NOT restored, each for a stated reason:** `confirmedClear` (an attestation that a human looked at the bed — nobody looked in this session), `plant` (a deliberate defect, four of which post a runnable program), `job` (a gate fixture), `sectionZ` (a statement about one solid this app cannot prove the restored bytes are), `extraTools` (arbitrary JSON driving feed and rpm, unvalidatable here — the COUNT is stored so the loss is reported by number). Library-bound fields are restored **inside the load that sets `ready`**, so no unvalidated tool id ever reaches the planner, which would otherwise take `fixtures.rs`'s `unwrap_or_else` branch and silently plan around a Ø6mm end mill nobody picked. ⚠ **No spec row and no `SLICER-GATES.md` row yet** — both files were outside this pass's scope; the tests ride gate **I1** (41 tests, was 37). |
| 40 | The touch plate had three owners wearing one field set | `a447e25fa` · `614e5f81e` | MACHINE keeps a fixed device; SETUP gains `Stock::corner_plate`, whose bed position is **derived through `place()` every time and never stored**, so it cannot go stale when the sheet moves; PLATE gains `TouchPlate` (top and wall as separate quantities). Gate PROBE watches the corner plate follow the sheet and a fixed plate not follow. |

---

> **Audit note, 2026-08-09 — how this table was re-checked, and what it does not carry.**
> Every row above was re-read **against the code**, never against its own previous value, per the
> rule `README.md` states about its own status table. That found stale ⬜/🔵 on 15 rows, and a stale
> ✅-adjacent claim in the Done table (the neutrals line). It also found three rows in the opposite
> direction — **written, correct, and unreachable**: `workholding.ts` (#34), `materials.ts` (#35) and
> `touchplates.ts`/`touchplateShape.tsx` (#37) have **no importer anywhere in `web/src`**, exactly like
> `MESH_SAMPLES` (#45). Code that looks shipped and cannot be reached is the harder half of this audit,
> because nothing goes red for it.
>
> 🔴 **Done-but-ungated — the set that can regress silently.** Each of these is ✅ above and no gate
> would go red: **#20** (pan basis), **#22** (3D palette from tokens — spec I7 cites `none`), **#24**
> (the bar's readout; the estimate arithmetic under it rides G0/J3), **#36** (the loaded mesh in the
> browser; the core side rides G0), and **#3** for drawings specifically (the e2e exercises machines
> and workpieces, and drawings only share the component).
>
> ⚠ **Every `gate I1` citation in this table is currently PENDING, not green.** I1 runs the Playwright
> suite; `--quick` skips it, and **#50 records one of its tests failing**. A row citing I1 is naming the
> check that *would* fire, not a check anybody has watched pass today. `--quick` on 2026-08-09:
> **36 passed · 0 failed · 2 pending (I1, CTRL)**.

---

## Open — founder requests, in DEPENDENCY order (item ids are not sequential here)

⚠ **The ids below run out of numeric order on purpose.** Per the rule at the top of this
file, ordering is by dependency — what blocks the most is first — so `#8 · #9 · #2 · #7 …`
is the intended reading order, not a numbering defect. **An id is a permanent handle**: it
is cited in commit subjects and in other lanes' tickets, so an item is never renumbered to
tidy the sequence. **Gaps are also intentional** — a missing id means that item is ✅ done
and lives in *Index* or *Done, with the commit that did it* above, not that it was lost.

### #8 · Drop the Job selector; plan the route from the drawing
  ✅ **DONE** — done — selector off operator surface, samples plan from drawing, route optimisation (nearest-neighbour + bounded 2-opt in `optimise.rs`), inner contours classified as pockets by `Feature::classify`. Remaining "pocket-vs-cutout" is a design decision (ambiguous from geometry), not a missing feature. Verified 2026-08-17.
The `Job` dropdown is the built-in GATE FIXTURES leaking into the product UI.
Target: import a drawing, the system assigns operations and orders the route,
the left panel holds the parameters.

🔴 **The `Plant` dropdown is the same problem one step worse** — it is the
negative-control flag whose entire purpose is making gates go red, sitting on
the operator surface. It comes off with `Job`, or goes behind a dev flag.

Exists already: drill-vs-contour per hole, inner-before-outer ordering, grouping
by tool. Does not exist: **deciding pocket-vs-cutout for an inner closed loop**
(ambiguous from geometry alone — needs a rule or a per-contour control), and
travel-order optimisation.

⚠ Do not call the result "best possible" in code or UI. It is a heuristic order,
not an optimum, and naming it optimal is a claim nothing can back.

### #9 · Recommend the tools while planning
  ✅ **DONE** — done (`658b0e78e` · `02651f583`) — `recommend` runs at plan time and every choice's REASON reaches the Notes panel; a refusal names each rejected tool with the rule it broke. Gate G0 via spec C7. ⚠ the structured `Recommendation` is not exported, so the runners-up are visible only on a refusal
Feeds off `shank_fit`, so a recommendation can never name a tool the machine
cannot hold. Rules to settle: smallest internal radius caps cutter diameter; an
exact-match drill for a hole; cutting length vs stock thickness; material caps
rpm and depth per pass.

⚠ Must stay overridable and **show its reason**. An auto-picked tool whose basis
is invisible looks like a decision somebody made.

### #2 · Multi-tool selection with minimum tool changes
  ✅ **DONE** — done (`02651f583`) — `tool_ids` is a SET and the core assigns per feature; one tool behaves exactly as the old singular `tool_id`. Gate G0 via spec D1/D2 (`core:three_tools_cost_exactly_two_changes`, `core:grouping_by_tool_costs_n_minus_one_changes`)
The core already emits `N distinct tools − 1` changes with `M0` blocks and a
re-probe. The gap: `JobConfig.tool_id` is **singular and overwrites the tool on
every operation**, collapsing multi-tool jobs to one tool. Needs a tool SET plus
per-feature assignment — which is what #9 produces.

⚠ Spec rows D1–D5 cite gates `G-D1`–`G-D5` that **do not exist**. The
minimum-change claim is currently ungated; gate it as part of this.

### #7 · STL and other import formats
  ✅ **DONE** — All DXF entities done, SVG done, OBJ done, 3MF done. 🔴 **STEP is REFUSED BY NAME (2026-08-28)**, not supported: the hand-rolled reader produced a plausible-looking wrong part three ways and disagreed with itself across the two hosts. Removed rather than fixed — `core/src/mesh.rs::refuse_step` carries the evidence. Gate F1 exercises the real parser for the remaining formats. Full B-rep sectioning needs a geometry kernel (separate decision). Verified 2026-08-17, corrected 2026-08-28.
🔴 **STL is a 3D mesh; this is 2.5D profile CAM.** It can be SECTIONED at a Z to
give cuttable contours, or it needs 3D surfacing, which does not exist here.
Silently giving (a) to someone expecting (b) cuts a flat profile of a 3D shape
and looks plausible. Build the section, name it a section everywhere.

**Higher value than STL:** DXF `SPLINE` / `ELLIPSE` and the SVG `A` arc command.
Those are today's named refusals and what real exporters emit constantly.

Then OBJ/3MF (same mesh machinery). STEP via `ruststep`/`truck` is a separate
decision. Gerber/PCB is out of scope by founder ruling. **Every dependency must
be licence-checked against AGPL-3.0-or-later before it lands.**

### #1b · Rotate the workpiece from the viewport
Quarter-turn buttons and the `Laid at` selector exist in the panel. An on-screen
rotate handle does not.

### #11 · Rename to `2bee.app`, with `2bee.cad` and `2bee.cnc` tabs
  ✅ **DONE** — **DONE** (lane scope) — 8 occurrences renamed across 6 files (package.json, gate banner, CSS, crate doc, design doc). store.ts backward-compat constants intentionally kept. Cross-lane items (handover dir, fleet_table, tmux) flagged for ceo ticket. Verified 2026-08-20.
🔴 A session rename touches **four** places nothing reconciles — the root
`CLAUDE.md` Sessions row, `scripts/fleet_table.sh`, the tmux session name, and
`handover/2bee_slicer/` — plus this lane's directory, Cargo package names, gates
and docs. Root canon: change all four in the SAME commit; a partial rename is
how the fleet spawns duplicate sessions. Two of those files are not this lane's,
so it needs a `ceo` ticket.

✅ **PRODUCT NAME — founder, 2026-08-08, asked directly.** `2bee.app` is the
product's name and may appear as such in the UI, docs and code.

🔴 **CORRECTED THE SAME DAY, hours later: the founder has REGISTERED the domain
`2bee.app`.** The line above originally read *"not a domain … must NOT appear as
a hostname, URL, DNS record, certificate SAN or config value"*, and that is now
false. Left visible rather than deleted, because a stale prohibition misleads
exactly like a stale permission.

⚠ **What is settled and what is NOT:**
- ✅ Settled: the name, and that the founder owns the registration.
- 🔴 **NOT settled: whether anything is SERVED from it.** Founder rule 2026-07-20
  is still standing canon — *"`2bee.farm` IS THE ONLY DOMAIN TO USE"* — and
  owning a domain is not the same decision as publishing on it. That call is the
  founder's and it reaches `sales`, `brand`, `legal` and `backend`, not just this
  lane. Routed to `ceo`; **do not put `2bee.app` in a URL, a link, an email
  signature or outward copy until it comes back.**
- ⚠ **`.app` is HSTS-PRELOADED at the TLD level.** Browsers will refuse plain
  HTTP to it entirely — there is no cleartext fallback, not even for a redirect.
  So a valid certificate is a precondition of the FIRST request, not a follow-up
  task. Whoever deploys it needs to know that before they try.

None of this blocks the rename or the tabs: the app can be called `2bee.app`
whether or not anything is ever served from that hostname.

### #12 · `2bee.cad` — an OpenSCAD-alike in the browser
  🟡 **PARTIAL — this line read "✅ **DONE** — Full OpenSCAD language implemented" until 2026-09-09, and it was the THIRD statement of #12 in this file: the index row (line 31) was corrected 2026-08-27 and §80 on 2026-08-22, while this one kept the ✅ with no correction banner. 🔴 I then quoted THIS copy to `ceo` and reported a canon-vs-canon conflict that does not exist — ⇒ ***a file that states one item in three places will be quoted from whichever copy the reader reaches, and the uncorrected one is indistinguishable from the current one.*** **What is true:** the *language* is implemented at the parse/emit level — all primitives, transforms, booleans, hull (2D+3D), minkowski, resize, linear_extrude/rotate_extrude, projection, import, surface, text/fonts, include/use with ScadFileHost, user functions + function literals, intersection_for, echo, assert, list comprehensions, modules/variables/for/if/let/each, $fa/$fs/$fn. KNOWN_REFUSED_MODULES is empty (only `hulls` — not a real OpenSCAD module). 19.5K lines of CAD code. Verified 2026-08-20.
Founder: *"should look like the openscad, have the same functionalities"*.

Scope reality: OpenSCAD is a CSG language **plus** a geometry kernel **plus** an
editor **plus** a previewer. That is a multi-month build, not a tab. Honest
staging:

1. A tab shell that says plainly what is and is not built. **No fake CAD.**
2. Editor and parser for a useful SCAD subset (primitives, transforms, boolean
   CSG, modules, variables, `for`/`if`).
3. A mesh kernel — evaluate `manifold-rs` / `csgrs` for **AGPL compatibility
   before adopting**.
4. Preview in the existing three.js viewport.
5. Hand geometry straight to the CNC tab. That is the entire point of one app.

⚠ `hardware/cad` owns the real `*_wcnc.scad` models. This tool consumes and
produces files; it must not become a second source of truth for hive geometry.

### #13 · Full brand pass
  ✅ **DONE** — done — blocker (#21) is gone, `styles.css` takes all surface/text/line/accent/status colours from `brand/tokens.css`. Remaining items are brand decisions (instrument colours deliberately excluded, em-dash ban, wordmark), not implementation gaps. Verified 2026-08-17.
`handover/brand/2026-08-08-2bee_slicer-brand-review.md` is with brand. Founder
has since said to proceed rather than wait.

The one real blocker: `brand/tokens.css` switches on
`@media (prefers-color-scheme)`, this app has an explicit toggle on
`[data-theme]`, and one palette cannot drive both without a second copy of the
values here — which `tokens.css` forbids. Resolution is either brand adding
`[data-theme]` support or this app dropping its toggle.

Also open: whether the toolpath legend colours (cut/rapid/tab/drill) are brand's
or instrument colours; whether the em-dash ban binds the **38 core diagnostic
strings** that reach the screen; and the wordmark.

### #17 · Hover the 3D canvas: highlight the object and show its details
  ✅ **DONE** — done (`cb5b81379`) — per-object `describe()`, emissive highlight, hover dot, one cast per animation frame; the panel is suppressed during a drag and re-picked on release. Gate I1 e2e `hovering reports the object under the pointer, and a hidden class is not pickable`
**Amended 2026-08-08, founder: while an object is being MOVED, the properties
window goes away** and returns when the pointer is released. It obscures the thing
being dragged and it is describing numbers that are changing underneath it.
⚠ Suppress the PANEL, not the picking: if the drag ends with the pointer still on
the object, the panel comes straight back — and with the CURRENT numbers. A panel
that reappears showing the pre-drag position is worse than one that stayed hidden,
because it reads as a measurement of where the part is now.

Founder 2026-08-08: hovering over the 3D canvas should highlight whatever is
under the pointer and show that object's details in a window.

Pickable things in the scene today: the **sheet**, each **clamp**, the **tool**
marker, and the **toolpath** segments. The viewport already raycasts on
`pointerdown` for the sheet-drag and clamp-drag, so the picking machinery exists;
this adds a `pointermove` path, a highlight material, and a panel.

What each object can honestly report:
- **Sheet** — size, thickness, material, datum, angle. All present in the UI state.
- **Clamp** — name, footprint, height, and whether it is a declared keepout.
  ⚠ "no clamps declared" and "clamps checked" are different facts (gate E5) and
  the hover panel must not blur them.
- **Tool** — id, diameter, flutes, shank, and its fit verdict for this machine.

🔴 **The toolpath is the trap.** `RenderMove` carries `kind`, `x`, `y`, `z` and
nothing else. It does NOT carry the feed, the operation name, the tool, or the
pass depth. So a hover panel that shows "F3600" or "pocket-3" for a segment would
be **deriving machining facts in TypeScript**, which is the same defect already
made twice in this app (the travel-fit rule, and the collet check). Two honest
options, in order of preference:
1. Plumb the real per-move data through from the core — extend `RenderMove` with
   the operation name, tool id and feed the post already knows.
2. Show only `kind` and the coordinates, and say nothing else.
**Do not compute the missing fields in the UI.**

⚠ **Performance:** raycasting every `pointermove` against a `LineSegments` set of
thousands of segments will not be free. Throttle to animation frames, and pick
against the coarse objects (sheet, clamps, tool) before the path. If it still
drags, that is a real finding to report, not a reason to silently sample fewer
segments — a hover that quietly ignores half the program would mislead about
what is there.

### #18 · Route / job optimisation — time, travel, tool changes
  ✅ **DONE** — done — `optimise.rs` implements nearest-neighbour + bounded 2-opt. Report includes `cutting_distance_mm`, `rapid_distance_mm`, `estimated_seconds`, `tool_changes`. Bottom bar shows cut time + tool changes. Dependency (J3) cleared. Verified 2026-08-17.
Founder 2026-08-08: optimise the route and the job for speed, fewer tool changes
and so on.

**These objectives fight each other.** Fewer tool changes means cutting every
feature a tool can reach before swapping, which lengthens rapid travel. Shortest
travel means taking features in spatial order, which swaps tools more often. So
the first piece of work is not an algorithm, it is deciding what is being
minimised and saying so in the UI. A single "Optimise" button that silently picks
one trade-off is a decision the operator cannot see.

🔴 **Two constraints are NOT tradeable, and an optimiser that reorders across
them produces a faster program that throws a part into a 2.2 kW spindle:**
- **Inner features before the outer profile.** Cut the outline first and the part
  is loose; everything after that is cutting a part held only by its tabs.
- **Tabs, fixture keepouts and climb direction.** All three already have gates
  (P1, P7, G-DIR). The optimiser must be run BEFORE them, never instead of them.

🔴 **It cannot be measured yet, and this is the blocking dependency.** The
citation audit found that `job.rs` computes the summary — including the time
estimate — by walking `path.moves`, which is **the plan, not the emitted
program** (row J3, `docs/spec-citation-audit.md`). Anything the post does
afterwards is invisible to it. **Optimising against a number derived from the
plan would report improvements the machine never sees.** Fix J3 first, then
optimise against the emitted program.

⚠ Do not call the result optimal. Ordering cuts to minimise travel is a
travelling-salesman problem; what we will ship is a heuristic. "Shorter than
before, measured on the emitted program" is a claim we can back. "Optimal" is not.

### #19 · The gaps the citation audit found
  ✅ **DONE** — done — **6 of 6 closed**: G-9 → gate `ENT`, A2 → gate `SPIN`, J3 → code fix, I7 → two e2e tests, J2 → download button e2e, B5 → stock position attribute e2e. All citation gaps now have at least partial coverage. Verified 2026-08-17.
`docs/spec-citation-audit.md` (agent, 2026-08-08) checked all 35 rows citing a
gate id that does not exist: **13 COVERED, 16 PARTIAL, 6 UNCOVERED**. The
UNCOVERED six are the real risk, and two of them are physical:

- **G-9 "no vertical plunge in a through-cut" — UNCOVERED, physical.** Ramping is
  implemented and is the default, but nothing asserts a plunge is absent, and the
  two nearest tests deliberately set `EntryMode::Plunge` because they are testing
  leads — **the gate deselects the very case it exists for.** Worse:
  `EntryMode::Helix` has no distinct behaviour, it is matched together with
  `Ramp`, so "helical entry" names something that does not exist.
- **A2 spindle band + spin-up dwell — UNCOVERED, physical, and the plant already
  exists.** `Plant::RpmOutOfRange` / `--plant rpm` is built and **no gate or test
  ever passes it**. A negative control armed by nobody. The `G4` dwell after `M3`
  is asserted nowhere.
- **J3 summary "derives from the emitted program" — the code contradicts the
  row.** It walks the plan. Blocks #18.
- **B5 "the rendered box matches the numbers"** — the test proves only that the
  canvas painted more than three distinct colours.
- **I7 theme** — confirmed: nothing would go red if the `brand/tokens.css` import
  were deleted.
- **J2 download filename** — no test triggers a download at all.

Two more, outside the table and worth as much:
- **G-6 has TWO `depth_passes` and the tested one is not the shipping one.** The
  fixture generator's copy has the tests; the `pub` one every real job runs has
  none. Identical today, free to drift green.
- **G-11's ordering is asserted before `group_by_tool` regroups it.** Nothing
  asserts "outer profile last" on the emitted program for a multi-tool part.

### #20 · Right-drag pans the camera the wrong way
✅ **DONE** — Pan basis derived from camera angles. Regression guard comment at `Viewport.tsx:4159` + two source-text tests in `projection.test.ts` (§11) asserting `right = (-sinθ, cosθ)` and up-vector sign flip. Verified 2026-08-20.
Founder 2026-08-08. Confirmed at `web/src/Viewport.tsx:270-273`. Two defects in
three lines: the `dy` contribution to `target.x` is multiplied by literal `* 0`
so it is dead, and the `dy` contribution to `target.y` carries a stray `* -1`.
Horizontal and vertical drag therefore disagree about sign and the pan fights the
mouse.

⚠ Fix by DERIVING the screen-right and screen-up basis vectors on the bed plane
and applying them, not by flipping signs until it feels right. A sign chosen by
trial and error is wrong again the moment the camera convention changes. Whichever
convention is chosen must match the SHEET drag, which already follows the pointer,
so the two gestures do not contradict each other.

### #21 · The theme toggle cannot force dark on a light-preferring OS
  ✅ **DONE** — done — **brand added it**: `brand/tokens.css:200` carries `[data-theme='dark']`, so the toggle can force dark on a light-preferring OS. Not ours; verified at their file
`brand/tokens.css` gained a `[data-theme='light']` block on 2026-08-08
(`aded4ab9e`), which is why this app could drop its local palette entirely
(`b97cc9a0b`). **There is no matching `[data-theme='dark']` block.**

Consequence, measured: on an OS that prefers light, the toggle can go light but
**cannot force dark** — `[data-theme='dark']` matches nothing, the media block's
light values stay, and the user gets a light UI while the button reads ☀. On a
dark-preferring or no-preference OS both directions work, which is exactly why
this would survive casual testing.

The fix is one block in `brand/tokens.css` mirroring `:root`'s dark values. **That
is brand's file.** Deliberately NOT patched locally: a dark palette copied into
this app is invisible drift the day brand next changes a neutral.

### #22 · The 3D scene still carries the old local palette
  ✅ **DONE** — done — `applyPalette()` resolves every neutral through a probe element from `var(--bg/--panel/--line/--ink/--accent/--muted/--ok)`, re-run on theme change. ⚠ **UNGATED**: spec I7 cites `none`, and an `@import` that 404s is silent in CSS
The viewport hardcodes the neutrals it was matched to before the brand pass
deleted them (`Viewport.tsx` background, bed, grid, stock, edges). It also takes
a `props.dark` boolean rather than reading the resolved theme, so it is wrong in
the light-OS case above regardless. Read the computed custom properties at
runtime instead of copying hex.

⚠ **Not in scope: the toolpath legend colours** (cut/tab/drill/rapid/change/probe).
Whether those are brand's or instrument colours is the open question with the
brand session, and legibility of a machining program is a safety property rather
than a style one.

### #23 · Sample drawings in the Drawing panel
  ✅ **DONE** — done (`238b3d531` · `264541701`) — three real `hardware/cad` DXFs **through the importer**, two of them present to show a refusal. Gate I1 e2e `a real cad drawing is refused for travel…`. ⚠ vendored copies that do not follow cad
Founder 2026-08-08. Ship a few drawings the user can pick without having a file.

🔴 **They must be REAL DRAWINGS PARSED BY THE IMPORTER, not fixture jobs.** The
built-in jobs (`plate`, `pocket`, `socket`, …) construct geometry in Rust and
bypass DXF/SVG parsing entirely, so a demo built on them exercises none of the
import path and proves nothing about the thing a user will actually do. A sample
that takes a different route through the code than the user's file is a demo that
can be green while import is broken.

This is also the honest replacement for the `Job` selector in #8: the operator
picks a **sample drawing**, not a "job type", and the route is planned from it the
same way it would be from their own file.

Provenance matters: the natural samples are real 2bee hive panels, which come from
`hardware/cad`'s `*_wcnc.scad → DXF` chain. **`cad` owns those.** Vendor a copy
with a note saying where it came from and when — a silently drifting copy of
another lane's geometry is worse than no sample.

Include at least one sample that exercises a **named refusal** (a `SPLINE`, or an
SVG `A` path command), so the "what could not be read is named" behaviour is
visible to anyone evaluating the tool rather than only to the gate.

### #24 · Bottom bar — cut time and tool changes, with timed playback
  ✅ **DONE** — done (`5fba5f167`)
Founder 2026-08-08: replace the `100%` readout with the **total cut time** and the
**number of tool changes**, and add a play button that runs the cut **in time**,
with x2 / x5 / x10.

Tool changes are free: `summary.tool_changes` already exists and is derived from
the grouping. The time is not free, for three reasons, and all three must be
handled before a number goes on screen where an operator will plan their day
around it.

🔴 **1. The estimate currently walks the PLAN, not the emitted program.** Row J3
in `docs/spec-citation-audit.md`: `job.rs` computes the summary via `estimate(&path…)`
over `path.moves`, so anything the post does afterwards — a refused probe, an arc
degraded to line segments, a dropped move — is invisible to it. **Putting that
number in the largest text in the window makes it the thing everyone trusts.** Fix
J3 first. Shares this dependency with #18.

🔴 **2. It has never been checked against a real cut.** `FUNCTIONAL-SPEC.md` H5 is
🟡 for exactly this. Say **estimate** on screen, and say what it leaves out:
the largest known omission is **acceleration and deceleration**. grblHAL's planner
ramps into and out of every corner, so a sum of distance ÷ feed systematically
**under**estimates, and it under-estimates worst on programs with many short
segments — which is precisely the arc-heavy work this tool produces. A number that
is wrong in a known direction should say which direction.

🔴 **3. Playing "in time" needs per-move durations, which need per-move FEEDS, and
`RenderMove` does not carry them** — it has `kind`, `x`, `y`, `z` and nothing else.
Deriving feed in TypeScript would be a second copy of a machining rule in the one
place no gate can see it, which this app has already done twice (the travel-fit
rule and the collet check). **Plumb feed, operation name and tool id through from
the core.** #17 (hover details) needs exactly the same data — do it once, for both.

Then the playback itself: the scrubber already maps `progress` 0..1 onto the move
list, so play is a clock driving that value. x2/x5/x10 scales wall-clock only.
⚠ Playback speed must not touch the program: nothing in this feature may write to
a feed, and a gate or test should assert the emitted G-code is byte-identical at
x1 and x10.

### #25 · Show/hide each move class, and all at once
  ✅ **DONE** — done (`cb5b81379`) — a chip per layer, `all`/`none`, a persistent "N of M view layers hidden" indicator, and a hidden class is not pickable. Gate I1 e2e `hiding every move class changes the picture and not one byte of the program`
Founder 2026-08-08. Today the viewport has ONE toggle, `showRapids`. Wanted: a
toggle per move class, plus an all-on / all-off.

The classes the renderer already separates: **rapid · cut · tab · drill · change ·
probe**. They are drawn as one `LineSegments` set per kind precisely so a kind can
be switched off wholesale, so the renderer is ready for this; the state is not.
The legend is the natural control — make each swatch the toggle.

🔴 **The trap, and it is the whole reason this needs care: hiding a class changes
the PICTURE and never the program.** Someone who hides `cut`, sees a clean board,
and concludes nothing is cut there has been misled by a control we gave them. So:

- A **persistent indicator whenever anything is hidden** ("2 of 6 move classes
  hidden"), visible without opening a panel. Absence must not read as a fact about
  the program.
- **Nothing in this feature may reach the G-code, the export, the summary or the
  simulation.** The gouge / uncut / spoilboard checks run over the whole program
  regardless of what is drawn, and a test should assert that hiding every class
  leaves the emitted bytes and the sim counts identical.
- Hidden classes should not be **pickable** either, once #17 lands. A hover panel
  reporting an object the user cannot see is worse than no hover.

⚠ `tab` deserves its own toggle for a specific reason: showing tabs alone is how
an operator checks a part will not come loose, which is gate P1's physical
failure. That is an inspection tool, not a display preference.

### #26 · The 3D theme follows the apiary designer
  ✅ **DONE** — done (`cb5b81379`) — `flatShading` on every material, ambient + key rig, PCF soft shadows, `castShadow` on the solids. Gate I1 e2e `the scene is flat-shaded and shadowed, and the move-class colours are untouched`
Founder 2026-08-08, pointing at `2bee.farm/apiary/design` and
`software/frontend/`: the slicer's 3D view should look like that, and **that look
is now the standard** — brand told (`handover/brand/2026-08-08-...-3d-look.md`).

What that look actually is, read off
`software/frontend/src/components/ApiaryDesigner3D.tsx`: **flat shading on every
material** (`meshStandardMaterial flatShading`), deliberately **low-poly**
primitives (8-to-12 segment spheres and cylinders), **emissive accents at low
intensity** (0.2-0.6) for anything that should read as active, `castShadow` on
solids, and colours taken from named tokens rather than literals.

⚠ **One boundary, and it is a safety boundary rather than a taste one.** The
toolpath's colours are a LEGEND for a machining program: cut, rapid, tab, drill,
tool-change, probe. The scene furniture (bed, sheet, clamps, tool) can take the
apiary look wholesale. The toolpath's *semantics* cannot be traded for style —
if a style change makes two move classes harder to tell apart, the style loses.

⚠ The frontend gets this look via `@react-three/fiber` + `drei`. This app uses
three.js **directly**. Do not add r3f here for the sake of matching: the look is
materials, geometry density and lighting, all of which are reproducible in plain
three.js. A new dependency needs an AGPL-3.0-or-later licence check first.

### #27 · The plant control is off the operator surface
  ✅ **DONE** — done (`b591c5bf1`)
Founder 2026-08-08, having asked what "Plant" meant — which was itself the
answer. Done in the working tree, behind `?plants=1`, kept reachable ONLY because
the browser suite needs it to arm the simulation check. Commit held: the file is
shared with an agent that has uncommitted work in it.

### #28 · A drawing straight from CAD lands off the table
  ✅ **DONE** — done — `planPlacement` called from `App.tsx` when a travel refusal exists. Shows the shift as an offer with an "Apply shift" button, or reports `will_not_fit` with the overhangs. Shift is offered, never auto-applied (the datum is relative to the clamps). Verified 2026-08-17.
Found 2026-08-08 while choosing sample drawings, by running the CLI importer over
the `cad` lane's own DXF exports rather than over anything this lane wrote.

`hardware/cad/2bee_hive/cnc_nest/super_end.dxf` imports cleanly — 1 part, 21
interior features, 85 tabs, 22.4m of cutting — and is then **refused**:

```
error: move outside X travel: -3 (allowed 0 .. 600)
error: move outside Y travel: -3.5 (allowed 0 .. 900)
```

Nothing is wrong with the drawing. CAD does not put a part's corner on the
machine origin, and the tool radius pushes the outer profile 3mm further out
still. **Every real drawing will do this**, so today the first thing a user meets
is a refusal they have to solve by hand with the datum fields.

The fix is to offer the shift, not to apply it silently: report the drawing's
extent, and offer "move the datum so the whole program fits". ⚠ Applying it
automatically would move the part relative to the clamps without saying so, and
`P7`'s physical failure is a toolpath through a clamp.

⚠ **This is exactly the kind of finding that only appears when the demo path and
the user path are the same code.** The fixture jobs never showed it because they
are built at sensible coordinates in Rust.

### #29 · Cognito login, admin only, served from `2bee.app`
Founder 2026-08-08: *"To log in use the same cognito as it is used for 2bee.farm ;
deploy it to 2bee.app; only admins can log in! login ui is in 2bee.farm"*, and
*"deployment framework already in 2bee.farm!"*

**This answers the open domain question**: `2bee.app` IS to be served. Ticketed to
`backend` (cert in us-east-1, CloudFront alias, bucket in the blue/green scheme,
Cognito callback URLs) and noted to `ceo`, whose 2026-07-20 one-domain rule this
supersedes for this surface.

🔴 **"Only admins can log in" and "only admins can get it" are different
requirements.** This app is static assets plus a WASM file. A token check inside
the app decides what the UI shows; it does not stop anyone downloading the bundle
from the origin. Gating the ASSETS needs CloudFront signed cookies or an edge
check, which is backend's work and materially larger. Do not let the client-side
gate be described as protecting the code.

⚠ **And AGPL §13 cuts across it:** serving this to authenticated admins is still
serving it over a network, so the complete corresponding source must be offered to
those users. The footer link already does that. Locking the bundle buys secrecy of
*operation*, never of the code.

⚠ `2bee.farm` and `2bee.app` are different registrable domains, so **no cookie or
`localStorage` crosses between them**. The login UI living on `2bee.farm` cannot
hand a session to `2bee.app` directly; it has to be an OIDC redirect with
`2bee.app` registered as a callback.

Client side is mine and will be built behind a config value so it is inert until
backend hands over a real app client id, domain and callback.

### #30 · One searchable object picker, replacing every dropdown
  ✅ **DONE** — done — every object list is one `ObjectPicker` (7 call sites: saved sets, samples, machine, material, sheet, tools, clamps); the only `<select>`s left are enums and the two dev-only fixtures controls. Gate I1 e2e `the list cannot be driven from the keyboard…` + `the search box hides an unusable tool…`
Founder 2026-08-08: *"There should be a standard way to add objects to the app:
All files, objects (Drawing, Machine, Workpiece, Tools … etc). When I click on it
should bring up a list (same style), when I select one show the properties of the
object, this list should be searchable, able to add one (e.g. machine) or more
(e.g. tools, Drawings) to the app. I do not like the drop down, can't search in
it. This list became a standard (branding)."*

One component, every object type: **Drawings · Machines · Workpieces · Tools ·
imported files**. Click, search, select, see properties. Single-select for a
machine or a workpiece; multi-select for tools and drawings, because a job has one
machine and a SET of tools.

🔴 **The one thing this must not do: hide the unusable ones.** The tool list
already marks a tool the machine cannot hold, with the reason and the shop's
collets; the sheet list already says "fits turned 90°" or "too big for this
machine". A search box that filters those out re-creates the exact defect those
labels were built to kill — **absence reading as reassurance**. Search narrows by
NAME; it must never drop an item because it is unusable, and a filtered-out
disabled item should still be counted somewhere ("3 hidden by search").

⚠ **Keyboard is a regression risk, not a nicety.** A native `<select>` gives
type-ahead, arrow keys, Enter and Escape for free, and a hand-rolled list loses
all four unless they are built. Whatever ships needs `role="combobox"` /
`role="listbox"`, `aria-activedescendant`, and those four keys working — a
workshop user with a hand on the machine should not have to find a mouse.

⚠ The properties view must show what the CORE says about the object (the tool's
fit verdict and reason, the sheet's footprint and turn, the machine's collets),
not a second description written in TypeScript. That rule has been broken twice
already in this app.

**It is also a brand standard by the founder's own words**, so `brand` owns
canonising it. Ticketed. This lane builds the component; brand decides whether it
binds the dashboard and the game too.

### #31 · Several drawings on one sheet, added and removed
  ✅ **DONE** — done — `drawings` is a `LoadedDrawing[]` array with per-drawing offset/rotation, picker is `mode="multi"`, copy button (⧉) for duplicates, `planImportMany` wired, drawing verdicts per instance. e2e: `two drawings go on the table`, `two drawings on the same material are REFUSED`, `a second copy of ONE drawing`. Verified 2026-08-17.
Founder 2026-08-08: *"able to add/remove multiple drawing to the canvas"*.

🔴 **This is NESTING arriving through the front door, and `README.md` says
nesting is not written.** What exists: P8 proves a part's transform carries its
interior holes (the failure it guards is a nested outline that looks right and has
lost its rabbets and bores). What does not exist: any nester, and any check that
two parts do not occupy the same material.

Today `imported` is ONE drawing and `plan_import` takes one text blob. Several
drawings means the job is assembled from **N placed parts**, each with its own
position and rotation, and that changes four things:

1. 🔴 **Overlap between parts is not checked ANYWHERE.** Drop two drawings on the
   same spot today and the program cuts both, through each other. Cutting a part
   out of material another part occupies is scrap at best and a loose offcut under
   a 2.2 kW spindle at worst. **A multi-part job needs an overlap refusal before
   it needs anything else** — including before it needs to look good.
2. **Each part needs its own tabs.** P1's failure is per part, not per job: three
   parts, one tabbed, still means two loose pieces.
3. **Ordering across parts fights #18.** Finishing one part before starting the
   next is the safe order; grouping every part's pockets under one tool is the
   fast one. They are not the same program and the trade-off must be stated, not
   silently taken.
4. **The sheet-fit and travel checks apply to the UNION**, not to each part.
   `placement.rs` already answers "what shift makes this fit"; it takes an extent,
   so a union of extents is the natural input.

⚠ Adding a drawing must be reversible: **remove** is in the founder's ask and is
the harder half, because removing a part has to remove its operations from the
route without renumbering something a person was reading.

**LANDED 2026-08-10 — items 1 and 4(partly); item 2 is OPEN and item 3 is STILL A STATED
TRADE-OFF.** Founder, same day: *"In the drawings I should able to add more than 1 drawings,
I should able to rotate the drawings"*.

✅ **N drawings, each placed and TURNED.** `fixtures::plan_report_import_many` is now the ONE
plan path for every import — the single-drawing entry points are one-element calls of it,
asserted byte-for-byte, so there is no path on which the check below does not run. A drawing's
placement is an **offset (a delta from as-drawn, in sheet mm) and a rotation about its own
lower-left corner**, applied to the GEOMETRY through `layout::PlacedDrawing`, which is `Stock`'s
transform and not a second one. Zero means AS DRAWN, deliberately: an importer that defaulted a
drawing to the sheet corner would move every existing job's geometry the day it landed, silently,
and the program would still look right.

✅ **Item 1 — THE OVERLAP REFUSAL, and it comes first.** The check runs on the placed parts
**before a single operation is generated**, and a condemned sheet returns with `gcode` EMPTY.
🔴 *The check itself had existed since 2026-08-08 in `layout.rs` and **nothing that emitted a
program had ever asked it***: `2bee-slice layout` graded a nest and printed no G-code, while
`import` planned two overlapping profiles and posted at exit 0. Gate **MULTI** drives it through
the real binary, with `--plant overlap-unchecked` (inverted polarity — the clean run refuses and
the planted one emits) and a **paired positive**, because a refusal test with no positive beside
it is indistinguishable from a check that refuses everything.

✅ **Removal is reversible and renames nothing.** Operation names are `drawing/part`, so taking a
drawing off the sheet cannot renumber another one's operations — the names a person was reading a
moment ago still say the same thing. A duplicate id is REFUSED rather than disambiguated.

🔴 **Item 2 — TABS ARE STILL PER JOB. OPEN.** `P1`'s physical failure is per part: three parts
with one of them tabbed still leaves two loose pieces. Nothing in this pass touched it, and gate
MULTI does not claim it.

🟡 **Item 3 — the ordering trade-off is STATED, not resolved.** `layout::operations` emits each
part complete before the next starts (the safe order); `job` regroups by tool (the fast one) and
interleaves parts. The planning path uses the job's regrouping, so gate **REL** is what stands
between that and a part worked on after its own release.

🟡 **Item 4 — the union.** `layout_extent` / `plan_placement` answer sheet-fit and travel over the
UNION and **the planning path does not ask them**. What does run is the travel check on the
planned toolpath, which is the stronger answer for travel and says nothing about whether the
MATERIAL is big enough — and the sheet basis is contested three ways in this repo, so nothing here
picks one.

⚠ **Named limit, not discovered:** a part deliberately nested inside another part's HOLE is
refused as an overlap. A false red, carried onto every refusal rather than left to be found —
refusing a legal nest costs a re-draw, permitting an illegal one costs a cutter.

⚠ **Named limit:** with no `part_gap_margin_mm` declared, pairs are checked against the CUTTER
DIAMETER ALONE — the bare geometric minimum, nothing for runout, sheet bow or chip clearance. Every
report says so on its face rather than defaulting a number nobody chose.

### #32 · Snap when placing: grid, edges, and a minimum gap
  ✅ **DONE** — done — `clearanceFor` called with selected tool's diameter, result passed as `clearance` prop to `Viewport`. Grid snap, edge snap, and minimum-gap snap all functional. `gapStatus()` now receives real clearance data from the core. Verified 2026-08-17.
Founder 2026-08-08, asking whether there should be snap-to-grid. Yes, and it
should be three things, because the third is the one that stops scrap.

1. **Grid snap** — the sheet drag already rounds to 0.1mm, which stops a datum
   carrying 14 decimals of mouse noise but does not help anyone land on 10mm.
   Offer a chosen step (1 / 5 / 10mm), off by default, and show it.
2. **Edge snap** — in practice more useful than an absolute grid: snap a part to
   the sheet edge, to the machine origin, or to another part's edge. Nesting is
   done against edges, not against a coordinate.
3. 🔴 **A minimum gap between parts, which is a machining constraint and not a
   preference.** Two parts placed 3mm apart with a 6mm cutter have nowhere for
   the cutter to go: it removes the edge of both. The gap must be at least the
   cutter diameter plus a clearance, and **snapping two parts flush together is
   exactly the gesture a grid invites**. So the snap that feels most natural is
   the one that produces the unrunnable job — which is why this belongs with #31
   rather than after it.

🔴 **BUILT AND UNREACHABLE FOR AN UNKNOWN NUMBER OF DAYS — 2026-08-09.** Legs 1
and 2 were implemented, correct, and wired into both drag handlers, and **no
click could reach the controls**: the top-left overlay column carries
`pointerEvents: 'none'` (it is text ~774px wide over a 790px canvas, and with
events on it shields every 3D affordance under it), the `move-classes` row takes
events back on itself, and the `snap-controls` row — added later — did not. The
chips rendered, styled as enabled, reported `aria-pressed`, and were dead;
`document.elementFromPoint()` at a chip's own centre returned `viewport-canvas`,
so the click became a camera orbit. Fixed by re-enabling events on the **chip**,
not the row: a flex-column child stretches, so `pointerEvents: 'auto'` on the row
would have made an invisible shield the full width of the column over canvas its
buttons never occupied. ⚠ **A dead control and a working one are identical in a
screenshot, and nothing in this app goes red for either** — the reachability
assertions this needs are listed with the e2e work, not landed.

⚠ Snap changes the DATUM, which changes the program. That is fine and it must be
visible: the numeric fields stay authoritative and must show the snapped value,
never a rounded display of an unsnapped truth. And snapping must not be allowed to
place a part into a clamp or off the table quietly — the existing travel and
fixture checks still run, and a snap that lands somewhere illegal should be
refused with the reason rather than accepted because the grid said so.

### #33 · 🔴 Tool grouping can cut a part loose before its holes are drilled
  ✅ **DONE** — done — founder decision: never regroup across inner-before-outer boundary. `group_by_tool` now splits tool groups at the boundary so inner features complete before their outer profile. Costs more tool changes but keeps every part held. Test: `an_outline_cut_before_its_holes_by_tool_grouping_is_repaired_at_no_extra_tool_change`. Verified 2026-08-17.
Found 2026-08-08 by the route-ordering work, which **detected it and deliberately
did not repair it**, because repairing it costs something only the founder should
spend.

**The failure.** A part whose outline is cut with tool A and whose holes are cut
with tool B. Operations are grouped by tool to minimise changes, so all of A runs
first — which means **the outline is cut, the part is now held only by its tabs,
and tool B then works on a part that is no longer fixed.** That is P1's physical
failure (a part breaking loose into a 2.2 kW spindle) arriving through the
ordering rules rather than through a missing tab.

**Why it is not already caught.** `TODO.md` #19 records that G-11's
interior-before-outer ordering is asserted *inside `operations_for_part`*, before
`group_by_tool` regroups everything across the part. The assertion and the shipped
order are two different things, and only the first is checked. This is the
concrete instance of that gap, not a new one.

**Current state:** `optimise.rs` checks the property on the FINAL order rather
than on the intent, and emits a 🔴 warning naming the part and the late features.
A warning is the weakest of the three honest answers.

**The decision, which is a cost decision and therefore the founder's:**
1. **Refuse the job.** Safest, and it stops work the machine could physically do.
2. **Break tool grouping for that part** — cut its holes with tool B before the
   outline, accepting an extra tool change (a minute at the machine plus a Z
   re-reference) to keep the part held down.
3. **Keep warning.** Cheapest, and it relies on an operator reading a warning
   about a program that will run.

⚠ This lane's standing rule is *refuse rather than approximate*, which points at
1 or 2. I am not choosing between "slower" and "riskier" on the founder's behalf.

### #34 · Workholding catalogue, offered through the standard picker
  ✅ **DONE** — done — `WORKHOLDING` imported in `App.tsx`, `workholding-picker` with `ObjectPicker`, `WorkholdingShape` renders to-scale schematics, inventory system integrated. e2e: picker opens, shape renders, cancel works. `CLAMP_PRESETS` is gone (line 878 comment). Verified 2026-08-17.
Founder 2026-08-08: research workpiece holdings on the web and offer them through
the standardised list (#30).

What exists already: `core/src/fixture.rs` has `Clamp { name, x, y, w, h,
height_mm }` and `Fixturing`, gate **P7** refuses a toolpath through a clamp, and
gate **E5** keeps *"no clamps declared"* and *"clamps checked"* as different
states. `App.tsx` has three hardcoded presets (pressure bar, cam clamps, screws)
invented in this lane, not sourced from anything.

What is wanted: a real catalogue — toggle clamps, low-profile cam clamps, T-track
hold-downs, vacuum pods and full vacuum tables, tape-and-CA, screws into the
spoilboard, side pressure — each pickable, each with the properties the CAM
actually needs.

🔴 **The properties that matter here are the ones a picture never shows:**
- **Height above the bed.** This decides tool clearance and it is why P7 exists.
- **Footprint**, because the keepout is a footprint and not a point.
- **Whether it obstructs at all.** ⚠ Vacuum declares no keepout and that is NOT
  the same as "no obstruction" — E5 exists for exactly this distinction and a
  catalogue entry must not flatten it.
- **What it holds against.** Side pressure resists lateral cutting force and does
  nothing about lift; tape resists lift poorly and shear well; screws resist both
  and put fasteners where the cutter must not go.

🔴 **Sourcing rule, because a catalogue entry is a claim about a real product.**
Every entry carries its source URL and the date it was read. No invented model
numbers, no remembered dimensions, no prices at all — **pricing and purchasing
are `bom`'s lane, not this one.** An entry we cannot source gets described
generically ("toggle clamp, typical footprint 60x25mm") and says that it is
generic rather than wearing a manufacturer's name it did not earn.

⚠ Boundary: this lane models workholding as GEOMETRY the toolpath must avoid.
Which ones the shop actually buys is `bom`'s, and the physical fitting is `ops`'.

### #36 · Show the LOADED 3D object, first in the layer row
**Amended 2026-08-08, founder: a 2D drawing is shown as WALLS extruded to the
workpiece height**, so a DXF reads as an object rather than as lines on a plane.

✅ For a **through cut** that is exactly right: a profile cut through 18mm ply
produces a prism of the contour, and drawing it at stock thickness is a true
picture of the result.

🔴 **It is wrong for anything cut to a partial depth.** A 6mm pocket in an 18mm
sheet extruded to 18mm draws a hole straight through a board that will still have
12mm of material under it. So the wall height must come from the OPERATION'S
DEPTH where one is known, and fall back to stock thickness only for a genuine
through cut. Where the depth is unknown, draw it at thickness and SAY the height
is assumed rather than measured — the same rule the importer already follows for
missing `$INSUNITS`.

⚠ And it is still a picture of the DRAWING, not of the machined result: it has
square inside corners the cutter cannot make, and no dogbones. The simulated
stock surface is the one that shows what the machine leaves; this shows what was
asked for. Two different claims, and they will sit next to each other in the same
canvas.
Founder 2026-08-08: the first entry on the top toggle row should be the full 3D
object as loaded.

🔴 **Two different objects, and the UI must never blur them:**
- **Loaded object** — the mesh the user imported. The INPUT.
- **Simulated result** — the stock after machining, from the height map (#24,
  being exported now). The OUTPUT.
The founder has called the second one "the final product" and the first one "the
full 3d object what has been loaded" in consecutive messages. If both are ever
drawn at once, a viewer must be able to tell at a glance which solid is their
model and which is our simulation of what the machine would leave.

**Neither is available in the browser today, for different reasons:**
- The loaded mesh is parsed by `core/src/mesh.rs` and **immediately sectioned**;
  only the resulting 2D contours travel on. The triangles are dropped in the core
  and never reach the report. Carrying them through is new core + wasm work.
- A DXF or SVG has **no 3D object at all**. That is what the format is, not a
  missing feature, and the toggle must say so rather than looking broken.

Until the data exists the toggle sits first and DISABLED with the reason: 2D
drawing / mesh not exported yet / nothing loaded. A control that is absent looks
like a feature nobody thought of; one that is disabled and says why is a promise
with a reason attached.

### #37 · XYZ touch plate — probe X and Y as well as Z, draw it, route it first
  ✅ **DONE** — done — gate PROBE. ⚠ `touchplates.ts` reaches the app through nothing (`touchplateShape.tsx` has no importer either), so the plate is drawn at a **stated placeholder footprint**, not a catalogue one
Founder 2026-08-08: the touch plate should be an X, Y **and** Z plate; show it in
the 3D canvas when it is on; make sure the probe is in the route; and put its
layer FIRST on the top row — touch, cut, tab, drill.

**Today it is Z ONLY.** `Machine` carries `probe_enabled`, `touch_plate_mm`,
seek/slow feeds, `probe_max_mm`, `probe_retract_mm`, and an optional probe X/Y
POSITION — but the emitted sequence is a two-stage Z probe and `G10 L20 P1 Z…`
and nothing else. There is no X or Y probe anywhere.

🔴 **The thing that makes an XYZ plate different from a Z plate, and the reason
this is not a small change: an X or Y probe touches with the SIDE of the cutter,
so the work offset depends on the TOOL RADIUS.** Get the radius wrong and every
coordinate in the program is off by that amount, in a direction nobody sees on
screen — the toolpath looks perfect and the part is cut in the wrong place. A Z
probe touches with the tip and has no such term, which is why the existing code
gets away with not knowing the diameter.

Also required, and each is a physical failure if missed:
- **The spindle must be OFF while probing.** A probe with the spindle running
  destroys the plate, the cutter, or both. Gate `SPIN` now asserts `M3` is
  followed by a dwell; this needs the opposite assertion on the probe path.
- **Which corner, and which way the plate faces.** A probe that assumes the
  front-left corner and meets the plate from the wrong side drives the cutter
  into it. The corner is a setting, not an assumption.
- **The probe runs BEFORE any cutting**, because it establishes the origin every
  later coordinate is measured from. Emitting it after the first cut sets an
  origin for work already done.
- **The plate thickness enters X and Y as well as Z** — the plate has a wall,
  and its thickness offsets the touch point on every axis it is used for.

Visualisation: draw the plate where it is declared, at its declared size, only
when probing is on. ⚠ It is an obstacle like a clamp: a plate left on the bed is
something the cutter can hit, and gate P7 exists for exactly that class. Whether
it becomes a keepout is a real question, not a rendering detail.

### #38 · 🔴 The feed and depth numbers are unsourced
  ✅ **DONE** — done — founder decision: ship with current 0.50xD values. Researched against machine-class cluster (0.24–0.51 for plywood), conservative. Aluminium at 0.15xD. Validate at physical coupon rung. `docs/decision-38-doc-ratio-recommendation.md`. Verified 2026-08-17.

🔴 **In full: the feed and depth numbers are unsourced, and the worst one is sourced to a
machine we do not have.**

`docs/materials-research.md` (agent, 2026-08-08), audited against Onsrud, Techno
CNC, Amana and CNCCookbook with URLs and read dates.

**All eighteen numbers** — 6 materials x `chipload_factor` / `max_doc_ratio` /
`max_rpm` in `core/src/tools.rs` — **landed in one commit (`a0f2949eb`) and carry
no citation anywhere in this lane.** `grep` for any tooling manufacturer's name
across the whole lane returns nothing. These numbers set the FEED and the DEPTH
OF CUT for every program this tool emits.

`SLICER-GATES.md` already admits feeds are unvalidated — **but only about the
TOOL's chipload window.** It never mentions the material multipliers, so nothing
in the repo flagged these as unverified. A caveat that names the smaller gap
makes the larger one harder to see.

**Two are outside every published figure:**
- **Acrylic `chipload_factor = 1.15`** against a published 0.63–1.00. And the
  comment explaining it is right physics in the wrong place: Onsrud's remedy for
  melting acrylic is *more feed with a SINGLE-FLUTE O-flute cutter*, which
  doubles the chip by halving the flute count. We have no O-flute concept, so the
  fix was folded into the material multiplier, where it also applies to a 2-flute
  cutter. **Worse than a guess, because the comment reads as authority.**
- **MDF 1.10 and Softwood 1.20**, both just above their published bands.

🔴 **The most dangerous is `max_doc_ratio() == 1.0` for Plywood, MDF and
Softwood.** Not the furthest from published — acrylic is — but it applies to the
material we actually cut, on every job, and authorises a **full-diameter,
full-width slot**, which is what a through-profile always is. Its only support is
industrial tooling charts, and **no chart found states the spindle power or
gantry rigidity it assumes**. The one prosumer-router source halves it
specifically for slotting. Ours is a 2.2 kW SKR Pro gantry.

⚠ **That is not "unsourced" — it is sourced to a machine we do not have**, which
is less obvious and therefore worse.

Also found: `default_library()`'s docstring claims its chiploads are "the
published windows for hardwood/ply in the diameter class". Uncited and measurably
off — our 6mm 2F is 0.10mm where Onsrud says 0.15–0.20mm and Techno 0.25–0.33mm.
**2.5-3x conservative**, which partly offsets the aggressive multipliers in
absolute feed, but the docstring is not true as written.

**Nothing was edited.** Changing a feed or a depth of cut is a physical decision
and it is the founder's, not an agent's. The decision: halve `max_doc_ratio` for
the sheet materials (slower, safer, and matches the only prosumer source), or
keep it and record that we are running industrial numbers on a hobby gantry.

### #39 · The list becomes the editor
  ✅ **DONE** — done — `input:` props added to machine (Travel X/Y/Z, Safe Z, Collet, Spindle max) and workpiece (Size X/Y, Thickness, Datum X/Y, Rotation) picker properties. `onSave`/`onSaveAs` merge draft into current object. Verified 2026-08-17.
Founder 2026-08-08: *"When I select an object on the list able to change the
properties there and able to save as when it is not an out of the box config
(when it is not out of the box, have save); remove the name and save, saved …,
delete from the left panel, all property changes are from the list module."*

So the picker stops being a chooser and becomes the one place an object is
chosen, inspected, edited, saved and deleted. The left panel loses its name box,
Save, saved-list and Delete entirely.

**Two classes of object, and they behave differently:**
- **Out of the box** — the built-in machine presets, the tool library, the sample
  drawings. Editable, but the only way to keep a change is **Save as** under a
  new name. The built-in itself never changes, so a shop can always get back to
  a known starting point.
- **Saved by the user** — has **Save** as well, because overwriting your own
  named thing is the ordinary case.

🔴 **THE RULE THAT DECIDES WHICH PROPERTIES ARE EDITABLE AT ALL: an INPUT may be
edited; a DERIVED value may never be.** A tool's diameter, flutes, shank and
chipload window are inputs. Its **fit verdict** — "12mm shank; the shop's collets
are 6mm, 3.175mm, 6.35mm, 8mm" — is the CORE'S ANSWER about that tool on this
machine. A sheet's size is an input; "fits turned 90°" is derived. Making a
derived value editable would let someone type over a machining verdict and get a
green that means nothing, which is the exact failure this lane exists to prevent.
So the property list must carry, per row, whether it is an input and what type it
is — and derived rows render as text, never as fields.

⚠ Editing a tool's chipload or a machine's collet **changes what the machine
does**. A saved object is not a preference; it is a machining setting that
outlives the session. Changes take effect on save, and the affected job re-plans
so a person sees the consequence rather than discovering it at the machine.

### #40 · The touch plate belongs to the SETUP, not only to the machine
  ✅ **DONE** — done (`a447e25fa`) — three owners now: MACHINE (a fixed device), SETUP (`Stock::corner_plate`, its bed position DERIVED through `place()` and never stored), PLATE (`TouchPlate`). Gate PROBE asserts the corner plate FOLLOWS the sheet and a fixed one does not
Founder asked, 2026-08-08: *"is touchplate can be under the workpiece? touchplate
is for the machine? (customized machine, move the touch plate manually?)"* — and
the questions expose a modelling error.

**Two different physical devices are modelled as one field set on `Machine`:**

1. **A fixed Z plate or tool setter**, bolted to the table at a known spot. That
   genuinely IS a machine property: it does not move when the work does.
2. **An XYZ corner plate**, hooked over the corner of the WORKPIECE. The code's
   own doc says so — `ProbeCorner` is *"which corner of the workpiece the plate is
   hooked over"*, and Left/Right are defined as the workpiece's min/max X. **It
   moves with the sheet.** That is a property of the SETUP, not of the machine.

**What goes wrong today:** saving a machine config saves the plate with it, and
moving or turning the workpiece does not move the plate. The datum the whole
program is measured from can therefore be left describing a corner that is no
longer there — and every coordinate is displaced with nothing on screen to say so.

**Can it be UNDER the workpiece?** Not as a plate: the cutter cannot reach it
without going through the sheet. The equivalent already exists and is supported —
`Stock::z_zero_at_top = false` zeroes Z on the **spoilboard** instead of the stock
top. That is the right answer for a through cut, and the materials research makes
it sharper: *"18mm ply"* spans at least two real thicknesses in AU, so a depth
measured from the top of the sheet inherits that variation while one measured from
the table does not.

**Moving it by hand:** `probe_x`/`probe_y` is a real position for an XYZ plate
(*"the point over the plate's top face"*), so dragging it in the viewport is
reasonable and is the natural next step. ⚠ But for a CORNER plate it must FOLLOW
the workpiece corner rather than float free — a plate dragged away from the corner
it references is a program measured from a datum that does not exist. For a Z-only
plate, `0,0` keeps its current meaning: *probe where the tool already is*.

### #41 · Bed scanning with spindle-mounted cameras
Founder, 2026-08-08: three ESP32-S3 + OV5640 boards bought, to mount around the
spindle and scan the bed for clamps, screws, obstacles and the workpiece, and
possibly to position the spindle.

**The idea is sound and the value is real — but only for one of the two jobs it
could be asked to do, and the two must not be confused.**

✅ **FINDING things.** The app today cannot see the bed at all. `Fixturing` knows
only what a human typed, and gate **E5** exists because *"no clamps declared"* and
*"clamps checked"* are different states. A scan that PROPOSES clamp footprints —
which the operator then confirms — turns a blank declaration into a checked one
without ever asserting more than it saw. This is the high-value case and it needs
nothing like machining accuracy.

🔴 **SETTING the datum. No.** The XY datum has to be right to about 0.1mm, and
every coordinate in the program is displaced by whatever error it carries — the
identical failure mode as a wrong tool radius on an XY probe, and just as
invisible on screen. A camera at spindle distance, even well calibrated, is a
millimetre-class instrument. **The touch plate sets the datum; the camera says
where to look for it.** A scan may CHECK a probed datum and refuse a mismatch;
it may not replace it.

🔴 **The failure mode that makes this dangerous rather than merely limited: a
detector that misses an obstacle is worse than no detector**, because it converts
*"I must declare my clamps"* into *"the machine checked"*. E5's distinction is
precisely what a half-trusted scan destroys. So a scan result must land as
`proposed`, never as `confirmed_clear` — that flag stays a human's to set.

⚠ Physical realities that bound it: the spindle, tool and dust shoe **occlude**
the area directly under them; a running job buries the scene in chips; the bed
sits in the gantry's shadow; and screws sunk flush in a spoilboard are close to
invisible from above while being exactly what must not be hit.

**Not this lane's to build.** `ml` owns models, `pcb` owns the boards, `ops` owns
the machine. This lane owns what the CAM does with a result: a `proposed keepout`
path into `Fixturing` that a human confirms, and a datum CHECK that can refuse.
Ticketed to `ml`.

### #42 · A work-holding change as a program phase, like a tool change
  ✅ **DONE** — **DONE** (software) — `ClampPhase` type, `clamp_phases` on Job, phase-splitting in `plan_job` (sequential split across tool groups), per-phase fixture check, `Move::ClampChange` with M5+comment+M0+re-probe in post. Ops procedure still needed. Verified 2026-08-20.
A cut through a clamp is a HARD REFUSAL today (`FixtureFinding::CutsClamp`), so
the operator's only options are re-nest or move the clamp and re-plan. Offering a
PHASE SPLIT instead — `M5`, a comment naming which clamp and where to, `M0`,
resume — turns an unplannable job into a runnable one.

Three of the four pieces already exist: the detection (and the clamp is widened by
the tool radius, so the centre can be clear while the cutter still eats it), the
operator-pause primitive the tool-change path already emits, and `OfferedFix` as
the channel for offering without applying. **What is missing is the phase split.**

🔴 **It is NOT a copy of the tool-change path, and the differences are the
dangerous part:**
- **A tool change does not change what holds the work down. This does.** The
  instruction is two steps, not one — *new clamp on before old clamp off* — or the
  part is loose mid-program.
- **`M0` already makes position unknown; this can make the DATUM unknown**, which
  is a different and worse fact. Needs an explicit "do not move the part", or a
  re-probe on resume.
- **The fixture check becomes per-phase**, not per-job: the remaining moves must be
  re-checked against the NEW clamp set or the second phase is unchecked.
- 🔴 **WHEN matters most.** The part is progressively less attached as the program
  runs, so a clamp released near the end may be holding a part that by then hangs
  on TABS ONLY. The safe boundary is not "before the first move that hits the
  clamp" — it is bounded by how much material still joins the part to the sheet at
  that instant, which couples directly to the tab count and height.

⚠ Separately: the core checks clamp vs TOOLPATH, not clamp vs the part's own
geometry. The extruded-walls layer can now SHOW a clamp standing over the
drawing's contours, but showing is not checking and the verdict stays in the core.

🔴 **FOUNDER REFINEMENT 2026-08-09 — make it a DECLARED CLAMPING SEQUENCE, not an
ad-hoc "move this clamp now".** The job declares an ordered sequence of clamp
STATES (phase 0 holds {A,B,C}; phase 1 holds {A,B,D}), and the program is
partitioned to match. This is strictly better than a per-finding offer, because
it makes the two properties above **machine-checkable instead of prose**:
- the *order* ("new on before old off") becomes a diff between consecutive
  phase states, so a sequence that ever drops below the required restraint is
  refused rather than described in a comment nobody has to read;
- the fixture check runs per phase against that phase's own clamp set, which is
  the "per-phase, not per-job" requirement expressed as data;
- and the tab coupling gets somewhere to live: at each boundary, "is the part
  still held, given what has already been cut?" is a question about the phase
  state plus the cuts completed, which a declared sequence can carry and an
  ad-hoc offer cannot.

Needs **ops** for the operator procedure. This lane cannot self-certify a
mid-program manual intervention.

### #43 · 🔴 `touch_plate_mm` is unsourced, and it means two different quantities
  ✅ **DONE** — done — founder decision: keep `None` as default. Machine refuses to probe until operator declares a real plate thickness. The unsourced 1.6 was removed; `Option<f64>` with `serde(default)` = `None`. Two-quantities half already fixed (`TouchPlate` carries top and wall separately). Verified 2026-08-17.
From `docs/touchplate-research.md` (13 products, 10 sourced).

**Two defects in one field:**

1. **The default is unsourced and fails in the running direction.**
   `Machine::default().touch_plate_mm = 1.6`. Real published Z figures across the
   13 products: **5, 13, 15, 15.4, 15.5** — nothing near 1.6. And the failure
   directions are NOT symmetric: an undeclared WALL is `0.0` and gets REFUSED,
   while a wrong TOP simply RUNS, about 13mm out. Same family as #38: a number
   nobody sourced, on the side that does not refuse.
2. **It means a different physical quantity on the two device types.** On a corner
   plate it is a thickness to subtract. On a 90mm tool setter it is a machine-Z
   datum. Entering 90 into today's field zeroes the tool 90mm high.

⚠ **The ownership finding that reshapes #40:** the split does NOT follow
Z-only-vs-XYZ. A Z-only plate laid on the stock is workpiece-referenced exactly as
much as a corner plate. The deciding property is *"is it fastened to the table?"*,
and there are **three** owners: the SETUP (corner, probe x/y, XY depth), the
MACHINE (a fixed setter's standing height), and **the PLATE ITSELF** — a purchased
object, i.e. a catalogue entry.

✅ Independent confirmation our arithmetic is right: gSender computes the XY datum
as `-(toolRadius) - xyThickness`, identical to ours. It is the ownership that is
wrong, not the maths.

⚠ Do not over-fit to the wall: only **1 of 13** products publishes one, and that
one comes from gSender's shipped defaults, where a SINGLE `xyThickness` serves
five plate types while `zThickness` is per-type. In practice the wall is treated as
a property of the shop, not of the plate. Two products have no wall at all — one
probes a bore where the radius cancels, one measures the tool off a chamfer — so
any model must let a plate legitimately have none.

---

## Open — defects found while building the above (ids restart low; not sequential)

⚠ **Same rule as the section above: dependency order, ids never renumbered, gaps honest.**
The first item here is `#14`, which is lower than the `#43` that ends the previous section —
that is a **section boundary, not a decreasing sequence**.

🔴 **FIVE ID COLLISIONS IN THIS SECTION — `#65`, `#66`, `#67`, `#68` and `#69` each name TWO
DIFFERENT ITEMS** (found while working the `pa` TOC heading-audit ticket; not fixed, see below).

| id | first item | second item |
|---|---|---|
| #65 | More than one copy of the SAME drawing | Right-click a clamp: remove / clone / rotate |
| #66 | Panel order | Filter the tool list by recommendation |
| #67 | Remove the sphere knob that rotates the workpiece | The sidebar control is an ADD button, not a select |
| #68 | Does the work holding actually hold it? | Show/hide the cutter, like every other drawn thing |
| #69 | Undo, and Ctrl-Z | The pair check's SCOPE, made explicit before #64 needs it |

**A bare `#65` in a commit or a ticket is therefore AMBIGUOUS**, and both senses are already
in use: `docs/design-68-hold-down-validation.md:590` means the *clamp* `#65`, while
`docs/decision-64-multiple-workpieces.md:592` means the *drawing-copy* `#65`. Measured cost of
renumbering (`grep -rEoh '#65([^0-9]|$)' software/2bee.app/docs/`): **15 references outside
`TODO.md`** would need re-pointing — `#65` ×8, `#68` ×7, `#66`/`#67`/`#69` ×0 — plus the commit
subjects `cd48db34b6` `ba0911fc40` `65612c2ddd` `6f97c94bf8` `c9c741da6d`, which cannot be
re-pointed at all. **So the ids stand and the collision is named instead** —
cite these five by id **and title together**, never by id alone.

### #14 · 33 spec rows cite gates that do not exist
  ✅ **DONE** — done — gate **SPEC**: 68 rows, 137 citations, **all resolve**; the 3 rows that cite `none` are COUNTED and printed rather than hidden
`FUNCTIONAL-SPEC.md` has 63 gated rows. **33 name a gate id that exists nowhere
in the repo** — `G-OFF`, `G-DEP`, `G-ENT`, `G-DIR`, `G-ORD`, `G-A2`…`G-E5`,
`G-SUM`, `G-THEME`, `G-EST`, `E2E-U1`…`E2E-V2`. The behaviour is probably
covered by the 130 unit tests and the browser suite, so this is a **broken
citation, not proven absence of coverage** — but the lane's own rule is *"if you
mark a row ✅, name the gate that would go red if it regressed"*, and 33 rows
name something that cannot go red.

Two of them have already been caught lying: `G-THEME` (the app imported no brand
tokens at all) and `P3` (no such gate existed).

Fix: verify each row against a real test, carry the id in the test name so it
resolves by grep, **then** arm a gate that fails when any spec Gate token does
not resolve. Do not map rows by eyeball — a wrong mapping manufactures a false
green, which is worse than the honest dangling label.

### #15 · Gate I1 cannot see a stale wasm
  ✅ **DONE** — done — gate K3
I1 proves the browser and the CLI agree on **one program's bytes**. It does not
prove the wasm was built from the current core. Measured on 2026-08-08: a
`public/wasm` artefact was missing a plant added to the core an hour earlier and
**I1 passed anyway**, because the change only affects planted runs so both hosts
agreed on identical stale output.

Fix: a build fingerprint baked into the core (hash of `core/src`), exported by
both the CLI and the wasm, asserted equal by the gate.

### #16 · The physical rungs are unclimbed
**Nothing this lane has emitted has ever cut anything.** Gate CTRL is armed and
PENDING; a Pi and a bare SKR are on the bench, which reaches controller
acceptance and no further. Air cut → foam/MDF coupon → real ply need a machine
and **ops**, and cannot be self-certified here.

✅ **RUNG 1 HAS BEEN REACHED ONCE — 2026-08-20 — AND THE RECORD DID NOT SAY SO
UNTIL 2026-08-27.** `fixture rect-profile` was sent to a real grblHAL 1.1f board
over `/dev/ttyACM0`, `rig=bare`, and **47 of its 50 lines were answered**. Left
visible rather than folded into the paragraph above, because that paragraph is
still true of *cutting* and the two facts are one sentence apart.

🔴 **AND IT COUNTS FOR NOTHING AT THE GATE, WHICH IS #126.** The transcript is
inadmissible on a recording gap, not on its content — `--program-command` was
optional and was not passed, so `program_command` is `""` and CTRL's first check
refuses the file rather than guess what produced it. Measured 2026-08-27: the
transcript's `program_sha256` matches `fixture rect-profile` from this build
**byte for byte**, so the missing value is *inferable* — and writing an inferred
value into a record of what a machine said is forging custody. **Re-run it.**
`tools/controller_probe.py` now refuses to write a transcript without the flag.

⚠ **The 3 remaining lines were NOT rejected**, and `docs/cnc-controller-status.md`
said they were until 2026-08-27. `M5`, `G0 Z5.000` and `M30` each carry
`replies: []` and `verdict: null` — the board stopped answering. A dead link is a
bench fault; *"rejected by grblHAL"* is a claim about **our post** and points the
next reader at `post_grblhal.rs` for a floating input on a table.

**SKR Pro v1.2 controller status (2026-08-20):** Board is **ALIVE**. ST-Link V2
recovered the bricked board — flashed no-bootloader grblHAL via SWD at
`0x08000000`, erased EEPROM, grounded limit switch pins (X-/Y-/Z- signal to GND),
and set `CONTROL_ENABLE=0` in build flags to disable floating EXP1 control inputs.
Board boots to `Idle`, `$X` unlocks, G-code accepted. See
`docs/cnc-controller-status.md` for full history.

✅ **The pre-condition this section set is DISCHARGED** — it read *"Before the
first transcript: confirm what firmware is actually on the SKR (grblHAL or the
Marlin an SKR Pro ships with) and whether anything else holds the serial port."*
The board shipped with Marlin, was reflashed, and the transcript's own banner
records `GrblHAL 1.1f ['$' or '$HELP' for help]` with `[VER:1.1f.20260817:]`.
Kept rather than deleted: a discharged pre-condition that is simply removed looks
like one nobody thought of.

### #44 · The tool marker is a generic blue cylinder, not the real cutter
  ✅ **DONE** — done — `toolMarkerShape()` in `Viewport.tsx` draws the cutter from `readToolShape()` with proper diameter, tip angle, shank, and cutting length. Missing fields produce a dashed cage with the reason stated. `toolShape.tsx` exports the shared shape logic. Verified 2026-08-17.
Founder, 2026-08-09: *"update the tooling (blue cylinder) from the design of the
real tool."* `web/src/Viewport.tsx` draws the program head as
`CylinderGeometry(3, 3, 40, 8)` in a hardcoded teal — **the same picture for a
Ø1 engraver, a Ø6 down-cut end mill and a Ø20 surfacing cutter**, and the same
picture for a drill as for a profile bit.

🔴 **This is the exact defect #31 already fixed in 2D, still live in 3D.**
`web/src/toolShape.tsx` draws a tool honestly from the core's `ToolRow` — true
diameter, flute count and direction, tip and included angle, and it REFUSES to
draw (empty dashed frame) when the row states no diameter. The viewport has the
same `ToolRow` on `props.tool` and ignores every field of it.

Do it from the same facts, and keep the same refusal: a marker drawn at a
diameter the row does not state is a measurement nobody took, and the marker
sits in a scene people use to judge whether a cutter clears a clamp. Reuse
`toolShape.tsx`'s field reading rather than re-deriving it — a second copy of
"what shape is this tool" is how the two views start disagreeing.

⚠ Note the hardcoded teal is deliberately outside the brand-token palette pass
(it is an INSTRUMENT colour, like the move classes). Changing the geometry does
not settle the colour question, which is still open with `brand`.

### #45 · 🔴 `MESH_SAMPLES` has no consumer — four STL samples nothing renders
  ✅ **DONE** — done — `MESH_SAMPLES` imported in `App.tsx` (line 2), used in drawing picker (line 4531), mesh loader (line 3511), and session restore. Verified 2026-08-17.
`web/src/samples/index.ts` defines `MESH_SAMPLES` with a careful loader that
re-derives the triangle count from the delivered bytes and refuses a mismatch.
**Nothing imports it.** Measured 2026-08-09: `App.tsx` imports `SAMPLES` only,
and a grep for `MESH_SAMPLES` across `web/src` returns no hit outside the file
that declares it.

So the STL sample path — including the hive box added in `00e82c13c` — is
correct, tested at the CLI, and **unreachable from the UI**. This is the
"control with no consumer" shape: the code looks like a shipped feature and the
user has no way to reach it.

Wire it in the Drawing panel next to `SAMPLES`. ⚠ Mesh samples are
ASYNCHRONOUS (`bytes()` fetches) where drawing samples are already in memory,
and they need a section Z — that is why the type is deliberately separate, and
the picker has to show `midHeightZMm` as CHOSEN FOR YOU rather than as a
default that is right.

### #46 · The simulated surface reads OVERSIZE and square-cornered, and the note does not say so
✅ **DONE** — `resultCaveats(cellMm)` generates explicit caveat text about oversize, square corners, and deepest-sample semantics. Used in layer chip title, on-canvas line, and hover note. Verified 2026-08-20.
Founder, 2026-08-09, on the `simulated stock after machining` layer: *"why can I
look through when it has a drill through?"* and *"it is having 90 degrees even it
has been cut out with a drill?"* Both are the same root cause, and **neither is a
bug in the simulation** — but the on-screen note does not currently cover them.

Measured 2026-08-09 on `plate.dxf` (Ø6mm holes, 18mm stock), reading the decoded
height map directly:

| display cell | Ø6mm hole reads as | |
|---|---|---|
| 3.0mm (what the app asks for) | 3 cells = **9.0mm** | 50% oversize, and 3 cells cannot be round |
| 1.2mm | 6 cells = 7.2mm | |
| 0.6mm | 10 cells = **6.0mm** | exact |

- **Square corners** are the CELL GRID, not the cutter. And they are oversize *by
  design*: `stock_surface_of()` in `core/src/fixtures.rs` reduces each k×k block
  by its **minimum** (deepest) sample, deliberately — "over-reports removed area
  at coarse cells and never under-reports it", which is the safe direction.
- **"Looking through"** a through hole: the map's deepest value is exactly
  `-18.0` = the stock thickness (1,441 cells of 46,184 at that depth; nothing
  below it). It is a PIT whose floor is coplanar with the sheet's underside, seen
  through a workpiece drawn translucent on purpose. A height map is single-valued
  — it cannot represent "no material here", only "removed down to here".

🔴 **The gap to close is the WORDING, not the geometry.** The layer currently
says *"a feature narrower than one cell is absent from it, not blurred"* — true,
and it does **not** warn that features that ARE drawn come out oversize and
square-cornered at coarse cells. Someone can measure a 9mm hole off a 6mm one and
the note reads as if it had covered the risk. Say both, and consider making the
display cell a control rather than a fixed 3mm.

### #47 · `cutDepthMm` is unwired, so every extruded wall height is ASSUMED
✅ **DONE** (`188c55e80a`) — `report.deepest_z_mm` converted to positive mm and passed as `cutDepthMm` to Viewport. Extruded walls draw at actual cut depth; falls back to stock thickness labelled ASSUMED when no report. Verified 2026-08-20.
`Viewport.tsx` declares `cutDepthMm?: number | null` and `App.tsx` does not pass
it, so the extruded-walls layer draws at the sheet thickness and labels the
height **ASSUMED** in warn colour. Correct behaviour, and it is not the right
final state.

⚠ **The obvious wiring is not quite right and the ticket should say so.**
`Math.abs(report.deepest_z_mm)` is the deepest point of the WHOLE program, so a
job mixing a 6mm pocket with a through profile would draw every wall at 18mm —
the exact error the ASSUMED label exists to warn about, just with a confident
number instead of a hedge. The honest fix is a **per-operation depth** exported
from the core so each contour is extruded to its own operation's depth.

### #48 · The loaded-object line says "a 2D AUTO drawing"
✅ **DONE** — `intake_one` detects DXF vs SVG from content on the `auto` route; browser strips prefix and filters `auto`. Verified 2026-08-20.
`App.tsx` passes `loaded={{ name, format }}` using the format it REQUESTED
(`'auto'`), not the one the core DETECTED by content. The viewport therefore
renders *"hive-super-end.dxf is a 2D AUTO drawing"*. The core decides DXF / SVG /
STL from the bytes — pass that back and the sentence names the real format.

### #49 · 🔴 No datum-invariance gate — the blind spot outlived the bug
✅ **DONE** (`396e9a8c5`) — Gate DINV runs the check at a moved datum with plant `bed-anchored-sim`. Verified 2026-08-20.
`a9f3b09db` fixed the gouge check comparing a placed toolpath against unplaced
keep/remove regions. **Nothing would catch it coming back.** Measured before the
fix on the `plate` fixture at travel 2000×2000, changing only Datum X: gouges
went 0 → **1929** → 0 across X = 0, 150, 300. A pure datum change cannot alter
what is cut relative to the sheet, so that count must be invariant.

⚠ The **0 at X = 300 was the dangerous cell, not the 1929**: path and regions
stopped overlapping entirely, so the check had nothing to compare and returned a
green nobody earned. A false red and a vacuous green are indistinguishable in the
Simulation panel.

**Why 35 gates stayed green over a live defect: every fixture defaults to
`origin_x_mm: 0.0`, where both halves are inert.** The gate to add plans one
fixture at several datums (including a large one that would have moved the path
clear of the regions) and asserts the sim counts and `deepest_z` are identical.
It needs a `--plant` negative control that reintroduces the mis-anchoring and is
watched going red, per SLICER-GATES.md.

### #50 · e2e `the sheet can be turned by its handle` fails, unattributed
✅ **DONE** — Test inverted to use `Laid at` select after sphere knob removal. Asserts knob is gone, rotation reaches G-code. Verified 2026-08-20.
`web/e2e/slicer.spec.ts:695` fails with *"the drag never settled on a quarter
turn"* (the swing never reports 90/180/270). Observed 2026-08-08–09 across
several runs.

Not yet attributed to a commit. A clean baseline was not obtainable at the time:
`App.tsx`, `styles.css` and the wasm were all changing concurrently, and the
then-HEAD `Viewport.tsx` no longer type-checked against `App.tsx`'s newer props,
so the build failed before the suite could run. Evidence it is not the walls
layer: the test runs `?fixtures=1`, where `drawing` is `[]`, so `data-walls` is
absent and no wall object is built. **Bisect it once the tree is quiet.**


### #53 · Work-holding objects have no show/hide toggle
✅ **DONE** — Clamps layer toggle exists with e2e guard at `slicer.spec.ts:5197`: adds clamp, hides layer, asserts `clamps-hidden` with "declared and HIDDEN" + "fixture check still runs", asserts G-code unchanged, re-shows. Verified 2026-08-20.
Founder, 2026-08-09: *"add option to hide/unhide the workdown objects like the
others (workpiece table/bed all/none … etc)"*.

Measured at the code: `LAYERS` in `web/src/Viewport.tsx:249` holds **12** entries —
`loaded · result · walls · touch · cut · tab · drill · rapid · change · probe ·
workpiece · bed`. **Clamps are not among them.** They ARE drawn
(`Viewport.tsx:2724`, positioned from `c.x/c.y/c.height_mm`), so today they are the
one scene object you cannot switch off to look under, and the one whose absence you
cannot distinguish from "no clamps declared".

⚠ That second half is the reason this is more than a convenience. `Fixturing`
already treats *"nothing declared"* and *"a human confirmed the bed is clear"* as
different facts, and refuses to conflate them. **An empty bed and a hidden clamp
must not look the same either** — so the toggle has to follow the existing
`presentKinds` pattern, where a layer with nothing in it is not offered rather than
offered-and-empty.

Do it with the existing chip machinery, and note the trap that has now bitten twice
in that column: the overlay is `pointerEvents: 'none'` and each CHIP re-enables
`'auto'`. A new control that misses that renders, styles as enabled, reports
`aria-pressed` and is unclickable — exactly what happened to the snap controls.

### #54 · ONE list for ALL drawings — samples AND user-owned
  ✅ **DONE** — done — three surfaces are one searchable `drawing-picker` (`mode="multi"`), samples + saved + mesh samples in one list with origin tags. Multi-select landed with #31. Verified 2026-08-17.
Founder, 2026-08-09: *"drawings should be selected like tools (able to add multiple
drawings to the table) … have 1 selection (list) for all drawings"*, sharpened the
same day: *"in the drawings merge the 2 lists, have just 1 list including the same
and user owned drawings (able to select multiple drawings)"*.

Measured — there are **THREE** drawing surfaces today, not two:

| surface | what it holds |
|---|---|
| `sample-picker` (`App.tsx:1546`) | the shipped DXF/SVG samples (`SAMPLES`) |
| `mesh-sample-picker` (`App.tsx:1589`) | the shipped STL samples (`MESH_SAMPLES`) |
| `SavedSet collection="drawings"` (`App.tsx:1700`) | **the user's own saved drawings**, from IndexedDB |

All three collapse into one searchable multi-select list, and several drawings can
be on the table at once.

⚠ **Mesh entries are not interchangeable with drawing entries and the merge must not
hide that.** `MESH_SAMPLES` loads ASYNCHRONOUSLY (`bytes()` fetches) where `SAMPLES`
are already in memory, and a mesh needs a **section Z** that a 2D drawing does not.
That is why the two types were deliberately kept separate in `samples/index.ts`. One
LIST is right; one TYPE would be wrong. The picker must show `midHeightZMm` as
**chosen for you**, not as a default that is correct.

⚠ **Names must disambiguate what a thing IS.** A DXF and an STL both called *"Hive
super end"* collided on 2026-08-09 and became `Hive super end — solid (STL)`. In one
list, picking the wrong one is picking a **section of a solid** over a **drawn
profile** — and both produce a program that posts and cuts.

⚠ The user's own drawings arrive with **no provenance and no measurements** — no
"measured through the CLI importer" line, because nobody measured them. A merged
list must not let a shipped sample's confidence rub off on a file somebody dragged
in this morning; the origin has to stay visible per row.

**LANDED 2026-08-09 — the MERGE. Not the MULTI, and the split is the point.**

✅ **One list.** `sample-picker`, `mesh-sample-picker` and the drawings `SavedSet` are gone;
`drawing-picker` holds all three, searchable, with row ids prefixed by SURFACE
(`sample:` / `mesh-sample:` / `saved:`). Bare names were not safe enough: a DXF and an STL
of the same part are two different objects, and nothing stops a user saving their own
drawing under a shipped sample's name — two rows with one id in a list keyed by id is a
picker that silently selects the wrong part, and both parts post and cut.
✅ **Origin per row**, built through one `shipped()` / `yours()` pair so the three merged
lists cannot drift apart in how loudly they say it. A shipped row states what it was copied
from and that it was measured through the CLI importer; a saved row states that **nothing was
measured, nobody checked it, and clearing site data deletes it**.
✅ **Mesh rows stay distinguishable**: `3D solid`, the section Z, and `CHOSEN FOR YOU` are on
the row *before* anything loads, next to a note that loading it is a FETCH that can fail.
✅ **A fix found on the way:** every load path now clears `sectionZ`. Before the merge only
the mesh path did, so *pick a mesh → type a Z → pick a DXF → pick a second mesh* sectioned the
second solid at a number chosen for the first, printed "which you chose", and cut it.

🔴 **NOT DONE: multi-select. It was not delivered as a picker mode, deliberately.**
`mode="multi"` would have cost one word and produced chips saying two parts over a program
containing one — the shape this lane has been bitten by four times. What it actually needs:
- **#31**, all of it: a core that plans N placed parts, and **an overlap refusal before
  anything else** — drop two drawings on one spot today and the program cuts both, through
  each other;
- per-part tabs (P1's failure is per part), and sheet-fit over the **union**;
- a session store that can hold more than one drawing reference. `SessionValues.drawing` is a
  single `{origin, name}` in `web/src/store.ts`, **which was outside this pass's file scope** —
  so a multi-selection could have been held in memory and would have been dropped on refresh
  with nothing to say so.

⇒ The founder's *"able to add multiple drawings to the table"* is **open, and it is #31**, not a
line in this item. The Drawing panel says so on screen rather than leaving the list looking
like it forgot.

**MULTI LANDED 2026-08-10 — and every one of the three blockers above was cleared first, in that
order.** The picker is `mode="multi"`; `SessionValues.drawings` is a LIST whose entries are
validated and **dropped by name**, each carrying its own placement so a restored drawing comes
back WHERE IT WAS; and `plan_report_import_many` plans N placed parts with the overlap refusal in
front of it (#31, gate MULTI).

🔴 **The refusal on 2026-08-09 was correct and is the reason this is safe today.** `mode="multi"`
would have cost one word and produced chips saying two parts over a program containing one — and
a selection that could not survive a refresh, with nothing on screen to say it had gone. Both
halves were built before the word was changed.

⚠ **`SESSION_VERSION` went 1 → 2**, so every stored setup is discarded once. That is the schema
rule working, not a defect: `drawing: {origin,name}|null` became `drawings: DrawingRef[]`, and
`partX`/`partY` — one sheet-wide offset — were REMOVED in favour of a placement per drawing. A v1
blob read field-for-field by this build would restore a sheet with no drawings on it while the
banner said the setup came back.

### #55 · Tooling panel CRUD belongs in the list
  ✅ **DONE** — done (`2e954f225d`) — both are in `tool-picker`; e2e *a tool file is imported and exported from the list, not from the panel* checks the capability SURVIVED the move, not just that the buttons left
Founder, 2026-08-09: *"tooling, remove the Export tools, Choose File (new) from the
left navbar, put this functionality into the list"*.

Same move already made for machines/workpieces/drawings: the left panel shows
properties **read-only**, and every add/import/export/delete lives in the
standardised list. This is the last panel still carrying its own file controls.

**LANDED 2026-08-09.** `ObjectPicker` gained an `actions` slot (list-level controls, beside
`+ add`, never per-item); Tooling passes `Export tools` into it and wires `onAdd` to the tool
file input.

⚠ **The `<input type="file">` elements stay MOUNTED and off screen rather than living inside
the dialog**, and that is not a shortcut. An input that exists only while a popup is open
cannot be handed a file by anything that has not opened the popup — including a test driver,
and including a person who dismissed the dialog. The visible affordance is the labelled button
in the list; the input is plumbing it clicks.

⚠ **And the plumbing had to be hidden from assistive tech**, which the work only found because
a failing test printed the accessibility tree: the Drawing panel was announcing a bare
**"Choose File"** button with no name and no relationship to the list it belongs to — a second,
worse copy of a control that already exists and is labelled. `aria-hidden` + `tabIndex={-1}`.

### #56 · The loaded object cannot be moved, and is not anchored to the sheet
  ✅ **DONE** — done (`7cdbff1cb`) — see #62, which is the same item written up after the fact
Founder, 2026-08-09: *"why I can't move the loaded object in the board?"* and *"I
put the Hive super end - solid (STL) into the table but it is out of the table"*.

Two findings, measured, and they may be one bug:
- `Viewport.tsx` has exactly three drag handlers — `draggingClamp`,
  `draggingStock`, `draggingRotate`. **The loaded mesh has none.**
- **The loaded mesh gets no `position.set` at all.** The sheet is placed at its
  datum (`stock.position.set(centre[0], centre[1], -sz/2)`, line 2626) and so is
  every other object (bed, grid, clamps, touch plate, tool head). The mesh is
  uploaded from the core's `xyz_mm` and drawn at RAW MODEL COORDINATES — anchored
  to the machine origin, not the sheet. Move the sheet and the object stays behind.
- And the core has **no offset field for an imported drawing**: `Stock::place`
  (`core/src/types.rs:612`) is the only thing that moves geometry. So a drag handler
  alone would have nothing to write to — this is a vertical slice.

🔴 **The distinction that must survive the fix:** this lane REFUSES to move a part
automatically to resolve an interference — `fit` reports a datum shift and will not
apply one, `layout` grades a placement rather than choosing one, **because the
clamps do not move with the parts**. An operator deliberately dragging is a
different act and is allowed. The fix must not become a path by which the software
relocates geometry on its own, and a drag into a declared clamp must still be
refused by P7.

⚠ And if the picture is made to follow the sheet, it must follow **the same
arithmetic the program does** — the sheet carries a datum AND a rotation. A mesh
parented to the sheet visually while the G-code is computed another way would make
the render and the program disagree, which is worse than today's honest mismatch:
right now the object is visibly in the wrong place instead of invisibly so.

### #57 · Clamps cannot be rotated
  ✅ **DONE** — done — core `1e4d60dbe`, reachable + gate P7R armed in `a5fbb9142` (⚠ that SHA is a `firmware` commit that swept this lane's files; the work is right, the attribution is not — see `handover/ceo/`). P7R PENDING -> PASS. **NOT COVERED: nothing proves three.js turns the box**, and the clamp DRAG still cannot set an angle
Founder, 2026-08-09: *"able to rotate the clamps"*.

Measured: `ClampCfg` (`core/src/fixtures.rs:1153`) is `name · x · y · w · h ·
height_mm` — **no rotation**, and `Clamp::footprint()` builds the keepout as
`Contour::rect(x, y, w, h)`, which is axis-aligned by construction. A toggle clamp
mounted at 30° to the bed cannot be described today, so it is either drawn wrong or
declared as a bigger axis-aligned box than it is.

🔴 **THE TRAP, and it is the whole of this item.** Adding a `rotation_deg` that the
VIEWPORT honours while `footprint()` keeps returning an axis-aligned rect gives an
operator a clamp that **looks** right and is **checked** wrong. Gate P7 refuses a
cut into a clamp by testing the toolpath against that contour — so a rotated clamp
checked as its unrotated rect either:
- passes a cut that goes into the real clamp (the rect misses where the clamp
  actually is), or
- refuses a program that was fine (the rect covers where it is not).

The first is a cutter into steel. **This is the same defect family as
`ClampHeightUndeclared` and as every "assert on the emitted program, not the
setting" finding in this lane: the picture and the check must be computed from ONE
number.** So rotation goes in the CORE, `footprint()` returns the rotated polygon,
and the P7 test that proves it must plant a cut that clears the axis-aligned box and
hits the rotated one — a control that only tries an obviously-inside cut would pass
with the rotation ignored.

⚠ `Stock::rotation_deg` is the precedent worth copying: it is applied to the
GEOMETRY the program is cut from, exact on quarter turns, and free angles plan and
warn. Reuse that shape rather than inventing a second rotation convention — two
rotation conventions in one scene is how the sheet and the clamps start disagreeing
about which way is positive.

### #58 · Selected Tools and Drawings should list row by row, like clamps
  ✅ **DONE** — done (`2e954f225d`) — `tool-rows` + `drawing-rows`. The single `toolcard` describing `toolIds[0]` is GONE; every selected cutter has a row, and every row is READ-ONLY except the section Z, which the core takes as an argument
Founder, 2026-08-09: *"similar to clamps show the selected Tools (like a table, row
by row); Drawings (row by row)"*.

Measured — the three do not currently agree:
- **Clamps** ARE rows: `App.tsx:2579` maps each clamp to a line with its own
  editable `name / x / y / w / h / height` inputs. This is the shape the founder
  wants copied.
- **Tools** are a multi-select picker with CHIPS. Every property comes from the
  core's `ToolRow` verbatim — fit verdict, reason, chipload window — and that must
  not change: describing a tool in TypeScript would be the third time this app
  re-derived a machining fact the core already answers.
- **Drawings** are neither. There is one `imported-name` note (`App.tsx:1748`) for
  a single loaded drawing — no rows, because multi-drawing (#54) is not built yet.

⚠ So #58 depends on #54 for the drawings half: rows need more than one drawing to
list. The tools half can be done now.

⚠ And rows must stay READ-ONLY for anything the core decides. The left panel was
deliberately made read-only for properties, with all editing moved into the list
(founder, 2026-08-08). A tool row showing feed, chipload or fit is DISPLAYING the
core's answer; a clamp row is different because clamp geometry is an operator
declaration, not a derived value. Do not let the visual similarity turn a derived
number into an editable field.

**LANDED 2026-08-09.** `tool-rows` and `drawing-rows`, in a `.objrow` layout that is
DELIBERATELY NOT `.clamp`'s six-input grid — reusing it would have made a declaration and an
answer look interchangeable at exactly the moment the difference decides whether a value may
be typed over. e2e asserts `tool-rows` contains **zero `<input>` elements**.

🔴 **What it replaced was worse than "no rows": a single `toolcard` built from `toolIds[0]`.**
With a SET — which is how this app has worked since multi-select landed — it described the
first cutter and said nothing about the rest. A job planned with a drill and an end mill
rendered the facts of one of them. The new test asserts BOTH rows carry their own capability
chips, which is the half a one-row check cannot see.

⚠ **The rows caught a real error in their own test.** The first version asserted an end mill
shows `drill: no`. Measured at `core/src/tools.rs:70`, `can_drill` is
`EndMill | Drill | Countersink` — an end mill CAN make a hole by plunging. The assertion was a
guess about a machining fact dressed as a check, and a version that had guessed right would
have been just as unmeasured. It now asserts `profile`/`pocket`, cited to `tools.rs:59` and
`:64`.

⚠ **The drawings half is a table of ONE**, and it is written as a table anyway: #31 lengthens
the array and changes nothing else here, whereas the single-drawing note it replaced would
have had to be thrown away. ✅ **And that is exactly what happened on 2026-08-10** — the array
lengthened, the row structure did not move, and each row gained the three cells the founder's
second ask needs: **Offset X**, **Offset Y** and **Turn**. They are editable for the same reason
the section Z is (an operator DECLARATION the core takes as input, not a value the core derived);
everything else on the row is still the core's answer and still read-only. A fourth control —
◉ / ○ — says which drawing the viewport drag handle, the `Part X/Y` fields and the section Z are
about, because with two parts on a sheet those three would otherwise be editing whichever one the
code happened to pick. The one editable cell in a drawing row is the **section Z**, which
is a genuine exception — the core takes it as an ARGUMENT, so typing it is answering a
question, not overwriting an answer.

### #59 · The `drawing={drawingParts}` HOLD is stale — its reason was fixed this morning
  ✅ **DONE** — done (`2e954f225d`) — re-measured at `Viewport.tsx` before wiring, not taken from the ticket. e2e *the extruded-walls layer is dark without a drawing and lit with one* is the check that was missing while it was dark
`App.tsx:2714` still carries a documented HOLD refusing to pass `drawing={drawingParts}`
to the viewport, with the measurement that justified it:

```
   rotate handle, page coords      886.3, 300.9
   element actually under it       SPAN[data-testid=gap-status]
   overlay container rect          y 53.8 -> 302.8, full width
   container pointer-events        auto
```

🔴 **`container pointer-events` is no longer `auto`.** It was changed to `'none'`
(with each chip re-enabling `'auto'`) in `3dab19fdd`, which is the commit that fixed
the covered rotate handle and, separately, the unclickable snap controls. The e2e
`the sheet can be turned by its handle` has been green since. **The blocker's own
measurement no longer describes the code.**

⇒ Re-measure and wire it. `drawingParts` is memoised and marked *"held, not dead"*
at `App.tsx:1275`, so this is a one-line change plus a re-run of the rotate test.
Wiring it also lights the **extruded walls** layer, which cannot render without it.

⚠ Recorded as its own item rather than fixed in passing because `App.tsx` is held by
the loaded-object agent. **This is the exact failure AGENTS.md names — "a stale 🔴 is
as expensive as a stale ✅, and harder to find: nobody re-reads a row that already
admits it is uncovered, and nobody re-tests a blocker that names a reason."** The
reason was precise, measured, and true when written, which is what made it survive.

**LANDED 2026-08-09, and re-measured before wiring rather than taken from this ticket.**
Read at `web/src/Viewport.tsx`: the top-left overlay column is `pointerEvents: 'none'` with
each control row inside it re-enabling `'auto'`, changed by `3dab19fdd` — a commit whose
subject is about the snap controls and which never mentions this prop. **The fix this HOLD was
waiting for was made for a different reason nine days ago, and nothing connected the two.**

✅ `drawing={drawingParts}` is passed. The three-state contract is preserved — `undefined` =
not wired, `[]` = the core exported no contours, an array = real parts; never `null`.
✅ The rotate-handle e2e was re-run and is green. It asserts `elementFromPoint` at the handle
is the CANVAS *before* it drags, which is what makes "covered" and "broken arithmetic"
distinguishable — the confusion that cost a day.
🔴 **New e2e, because nothing was watching the thing the HOLD cost.** The extruded-walls layer
cannot render without this prop and had been dark the whole time with no check going red.
*the extruded-walls layer is dark without a drawing and lit with one* asserts BOTH states: a
chip that is always disabled and one that is always enabled both pass a one-sided check.

### #60 · The drawn shape belongs on the property panel, not only in the row
  ✅ **DONE** — done (`2e954f225d`) — `ObjectItem.shape` renders on the property pane, **not** `aria-hidden`, with a label the TYPE requires. Machines, sheets, materials and drawings get none, deliberately
Founder, 2026-08-09: *"the all images in the list (like for the Hold-down should be
presented on the property (right) panel)"*.

Measured. They are not photographs — they are **drawn SVG components** built from
the catalogue's own fields: `ToolShape` (`toolShape.tsx:437`), `WorkholdingShape`
(`workholdingShape.tsx:813`), `TouchPlateShape` (`touchplateShape.tsx:763`).

- They render in **exactly one place**: the option ROW, via `ObjectPicker`'s `icon`
  prop at `ObjectPicker.tsx:970`, inside `.op-opt-icon` and marked
  `aria-hidden="true"`. The properties/preview panel on the right shows text rows
  only.
- Three catalogues supply an icon — touch plates (`App.tsx:1917`), tools (2281),
  work holding (2536). **Machines, materials, sheets and drawings supply none.**

So the change is: render the same component, larger, in the property panel beside
the `ObjectProperty` rows.

⚠ **`aria-hidden` must come off when it moves.** In the row it is decoration beside
a name. On the property panel it becomes a primary description of the object — at
which point hiding it from a screen reader is wrong, and it needs a real label
derived from the same fields the shape is drawn from.

⚠ **Do not invent shapes for the catalogues that have none.** A machine or a sheet
has no honest icon, and a placeholder would be a picture of nothing. `ToolShape`
already REFUSES to draw (empty dashed frame) when a row states no diameter — that
refusal is the pattern to keep, not to paper over.

🔴 **A drawing thumbnail is the one to be careful with, and it connects to #54.** A
2D drawing could show its outline honestly. A **mesh** cannot: the picture would be
the SOLID while the machine cuts ONE SECTION of it. That is exactly the confusion
`Hive super end — solid (STL)` was renamed to prevent, and a thumbnail would
reintroduce it in a stronger form — a picture is more persuasive than a name. If a
mesh gets a thumbnail at all, it must show the SECTION at the chosen Z, not the
solid.

**LANDED 2026-08-09.** `ObjectItem.shape` is a compound `{ node, label }`, and the label is
required BY THE TYPE rather than documented as advisable — a picture that says something
nobody can read as text is a claim only sighted users get to check. `aria-hidden` comes off:
the row icon keeps it (there it repeats a name beside it), the property-panel shape does not.
The e2e asserts that through `closest('[aria-hidden="true"]')`, because an svg carrying its
own `role="img"` is still invisible to a screen reader if any ANCESTOR is hidden — which is
precisely how it is rendered in the row, so checking the svg alone would pass on the wrong
arrangement.

Supplied by the three catalogues that have an honest shape: tools (`ToolShape` at its `'pane'`
frame — which already existed and **nothing had ever asked for**, so the drawing lived only at
22×24px, the size at which a shank step and a flute length are exactly what you cannot see),
work holding, and touch plates.

🔴 **NOT supplied for machines, sheets, materials or drawings, and the e2e asserts the
absence.** A sheet of plywood has no picture that says anything its size does not, and a
placeholder would be a drawing of nothing rendered as a fact. That assertion is what stops the
feature spreading to every list because it looks nice.

🔴 **NO DRAWING THUMBNAIL, for the reason above.** A mesh row would need the SECTION at the
chosen Z, and this app does not have one until the part has been planned — which is circular,
because the plan is what the picture would be helping you choose. A 2D row could show its
outline honestly, but a list where some rows have a picture and the mesh rows do not is an
invitation to read the absence as a property of the part. Left undrawn, on purpose.

### #61 · Machine section: remove `saved… ▼`, Delete and Preset from the panel
  ✅ **DONE** — done (`2e954f225d`) — all three gone from Machine, and the same leftover swept from Workpiece and Drawing. `SavedSet` is deleted; a `useSaved` hook feeds each panel's ONE list
Founder, 2026-08-09: *"in the machine section remove the: saved… ▼ / Delete /
Preset"*.

Measured — the Machine section (`App.tsx:1818`, `<Section title="Machine">`) carries
three controls that are all selection/CRUD rather than properties:

| control | where |
|---|---|
| `saved… ▼` picker | `SavedSet testid="saved-machine"` (`App.tsx:1821`) |
| **Delete** button | inside `SavedSet` (`App.tsx:344`, `${testid}-delete`) |
| **Preset** picker | `ObjectPicker label="Preset" testid="machine-picker"` (`App.tsx:1858`) |

This finishes a job started on 2026-08-08, and `SavedSet`'s own comment says so:
*"The name box and the Save button are GONE from the panel — founder: remove the
name and save, saved…, delete from the left panel"*. **The name box and Save went;
`saved… ▼` and Delete did not.** A partly-applied rule reads as a deliberate
exception to whoever arrives next.

⚠ **The same leftover is in TWO more panels**, not just Machine: `SavedSet` is used
by drawings (`App.tsx:1700`) and workpieces (`App.tsx:2050`) with identical
controls. Fixing Machine alone leaves the inconsistency the founder is objecting to,
one section over. **Sweep all three** — and note drawings is being rebuilt anyway by
#54, so that one lands with the merge.

⚠ **Do not delete the CAPABILITY with the control.** Loading a saved machine and
deleting one must still be reachable — from the list, per the standing rule that the
panel shows properties read-only and every add/import/export/delete lives in the
standardised list. #55 is the same move for Tooling; this and #55 should land
together or the panels disagree again.

⚠ **`Preset` is not the same thing as `saved…` and must not be merged carelessly.**
`Preset` is the shipped machine catalogue (`machine-picker`); `saved…` is the user's
own saved machines from IndexedDB. Collapsing them into one list is the right
end-state — it is exactly #54's shape for drawings — but it inherits #54's
constraint: **a shipped preset's provenance must not rub off on a machine the user
typed in themselves.** Origin stays visible per row.

**LANDED 2026-08-09, all three panels in one pass.** `SavedSet` is deleted; a `useSaved(collection)`
hook hands each panel its saved objects and the writes that change them, and the panel composes
ONE `ObjectPicker` from its catalogue and them.

- **Machine** — `machine-picker` = shipped presets + saved machines. `saved… ▼`, `Delete` and
  the separate `Preset` picker are gone.
- **Workpiece** — `workpiece-picker` = the shipped SHEET catalogue + saved workpieces. Fixing
  Machine alone would have left the identical leftover one section over.
- **Drawing** — folded into #54's merge.

✅ **The capability survived**: load, save, save-as and delete are all reachable from the list.
🔴 **`ObjectItem.removable` was added to `ObjectPicker` and defaults to `!builtIn`** — before
it, `onRemoveItem` put a delete control on EVERY row. Harmless while a list held only the
user's own things; wrong the moment a shipped catalogue entry sits in the same list, because a
built-in lives in the bundle and "deleting" it either does nothing or removes something that is
back after a reload. Honoured on the Shift+Delete path too, so the protection is not
mouse-only.

⚠ **A row that never ticks, and it is deliberate.** A preset ticks when the travels match; a
SAVED machine never does. The tick means *"this is what the app currently holds"*, and a saved
machine is ten numbers any of which the operator may change after loading — a tick surviving
that would claim the panel still describes the saved object when it does not. So a saved row is
an ACTION, and its properties say exactly what choosing it sets. Same for a saved workpiece,
whose row also states **"On this machine: NOT CHECKED HERE"** — `sheetFits` is computed per
catalogue id and a saved workpiece is not one, so the fit verdict every shipped row carries is
genuinely absent rather than quietly missing.

⚠ **The delete test had to change shape, not just its locators.** It used to assert *"the list
is empty and says Nothing here yet"*. That is now untrue by design — the presets are always
there — so it asserts the two halves separately: the saved row is gone AND the presets are not,
because a delete that took the catalogue with it would pass an "is it gone" check just as
happily.

### #63 · Work holding: several types at once, and drop the row icon
  ✅ **DONE** — done — `workholdingId` migrated to `workholdingIds` (string array). Picker changed to `mode="multi"`. Add button uses last selected type. Lift-risk check applies to the type being added. Session persists both old `workholdingId` (backward compat) and new `workholdingIds`. Shape icon already only in property panel (not in list rows). Verified 2026-08-17.
Founder, 2026-08-10: *"Work Holdings: I should able to add multiple work holding
types (and more than 1 clamps if needed), remove the image from the list left side,
leave it on the right side only"*.

Measured — **one of the three is already built:**

| ask | state |
|---|---|
| more than one CLAMP | ✅ **already works** — `add-clamp` (`App.tsx:3407`) appends, and `clamps.map` renders one editable row each. No limit. |
| multiple work-holding TYPES | 🔴 not built — `workholding-picker` is `mode="single"` (`App.tsx:3302`), so choosing a second preset replaces the first |
| icon on the row | 🔴 still there — `op-opt-icon` (`ObjectPicker.tsx:1076`). #60 added the shape to the PROPERTY panel and left the row copy in place; the founder wants only the panel one |

The icon half is small: delete the row `icon` render and its grid column, keep
`ObjectItem.shape` on the panel. ⚠ Keep `shape.label` REQUIRED — #60 made the label
mandatory *by the type* so a shape cannot reach the panel unnamed, and removing the
row copy must not weaken that.

🔴 **THE TRAP IN THE MULTI HALF IS DATA LOSS, NOT LAYOUT.** A work-holding preset
DECLARES clamp geometry, and clamp rows are hand-editable — an operator types the
real positions off the bed. Today a preset selection writes `clamps`. If picking a
second type simply writes again, **it silently discards a declaration a human made
by measuring**, and `Fixturing` treats a declaration as the thing that makes the bed
not-unknown. So multiple types must be ADDITIVE, and a preset must never overwrite a
hand-edited clamp without saying so.

⚠ Second-order, from today's clamp work: several types mean more clamps, and clamps
now carry `rotation_deg` (`1e4d60dbe`) plus the `ClampHeightUndeclared` finding. Two
presets can also place clamps that OVERLAP EACH OTHER — worth deciding whether that
is refused, warned, or ignored, and **it is the same question #31 answers for
overlapping parts**. Answer them the same way or the two surfaces will disagree.

### #64 · Multiple workpieces, and a right-click menu on the sheet
  ⚠ **PARTIAL — corrected 2026-08-28, this said ✅ DONE.** Phase 1 done (`workpieces[]` array, tabs, add/remove, switch); Phase 3 done (session persistence, right-click context menu on the 3D canvas, `any` rule type in the session validator); ghost outlines for inactive workpieces done. 🔴 **Phase 2 — multi-workpiece planning — is NOT done**, and `web/src/App.tsx:1707-1710` says so in its own comment: *"only the ACTIVE workpiece is planned"*. No combined G-code, no safe rapid between workpieces. Verified 2026-08-17, corrected against the code 2026-08-28.
Founder, 2026-08-10: *"able to add multiple workpeaces (when I right click on the
workpeace in the 3d canvas able to delete/clone the workpeace)"*.

Two halves, and they are not the same size.

**The UI half is small.** A context menu on the sheet object in the viewport with
Delete and Clone. The viewport already hit-tests the sheet for dragging, so the
target exists. ⚠ Right-click currently PANS the camera (the derived pan basis) — a
context menu must not cost the pan, so decide which button/modifier does what and
say so, rather than discovering it by feel.

**The model half is a core change, and it carries a physical trap.**
`Job.stock` is ONE `Stock` (`core/src/job.rs:26`). Its `thickness_mm` is read in
**30 places** across the core, and it is not cosmetic:

- `toolpath.rs:410` / `:797` — `depth = op.params.depth_total_mm.min(stock.thickness_mm + 0.3)`.
  **The cut depth IS the stock thickness.**
- `job.rs:1285` — `fixturing.check(&path, biggest_r, job.stock.thickness_mm, …)`, and
  `clearance_z` converts clamp heights from the BED datum to the STOCK-TOP datum
  using it.
- `zZeroTop` means Z=0 is the top of *the* stock.

🔴 **So two sheets of DIFFERENT thickness under one program is a physical failure,
not a layout question.** A depth computed for an 18mm sheet, run over a 12mm one,
cuts 6mm into the spoilboard; run over a 25mm one, it leaves the part attached and
the tabs meaningless. And they cannot share a Z zero at all — the top of one is not
the top of the other.

⇒ **Decide the model deliberately, and refuse what it cannot express.** The honest
options, in rough order of cost:
1. **Several sheets, ONE thickness** — refuse a second sheet whose thickness differs,
   naming both. Cheapest, and it is a real restriction an operator can act on.
2. **A program PER SHEET** — parts belong to a sheet, and each sheet posts its own
   file with its own Z zero. Correct, and the biggest change: `Job` stops being one
   program.
3. **Several sheets, mixed thickness, one program** — do NOT build this. There is no
   Z zero that is true for both.

⚠ Whatever is chosen, **the sheet a part sits on must be explicit**, because #31 is
adding N parts with their own placements right now. A part whose sheet is implied by
overlap is a part that changes sheets when someone drags it.

⚠ **Clone must copy the DECLARATION, not just the picture** — thickness, material,
datum, rotation, and whether it inherits the parts on it. A clone that copies the
box but not the material silently re-derives feeds from a different chipload.

### #65 · More than one copy of the SAME drawing
  ✅ **DONE** — done — right-click context menu on clamps in3D canvas. Options: remove, clone (+10mm X offset), rotate 90°. Reuses the context menu infrastructure from #64. `ClampCfg.rotation_deg` added to web type (core already supports it via `serde(default)`). Verified 2026-08-17.
Founder, 2026-08-10: *"Drawing: Able to add more than 1 from the same drawing"*.

**LANDED 2026-08-10, with #31.** Two copies of one file are **two parts with two
placements**, and the thing that makes that work is that a part is keyed by its
**INSTANCE**, never by the drawing it points at.

🔴 **What a name-keyed model does instead, and why it is the quiet kind of wrong:**
the second copy vanishes, or both copies share one placement and move together, or a
restore de-duplicates them on the next refresh and the operator loses a part they
placed. None of those announce themselves — every one of them still posts a runnable
program.

So the instance id exists in three places and all three had to change together:
- **core** — `ImportSource::id`. It always was an instance key; `plan_report_import_many`
  refuses a duplicate id outright rather than disambiguating one, because operation
  names are `<instance>/<part>` and two copies sharing a name means a refusal that
  cannot say which copy it condemned.
- **web state** — `LoadedDrawing.instance`, minted as `Hive super end`, `Hive super
  end #2`, … Readable rather than a serial number, because it is what the emitted
  program calls the part: a refusal naming `d2/part1` is a refusal about a part the
  operator cannot find on screen.
- **persistence** — `DrawingRef.instance`, and the list is deduped on the INSTANCE.
  It is restored, never re-minted: re-minting renames the operator's copies on every
  refresh, and the names in a program they downloaded yesterday stop matching the
  names on screen.

🔴 **THE COPY LANDS ON TOP OF THE ORIGINAL AND THE JOB IS THEN REFUSED. That is a
decision, recorded here because the next person will read whichever behaviour they
find as intentional.** Offsetting the copy automatically is the convenient answer and
it is the SOFTWARE MOVING A PART ON ITS OWN — the one thing this tool does not do,
for the reason `fit` reports a datum shift and refuses to apply one: the clamps stay
bolted to the table while the parts do not, so a part relocated to be convenient is a
part relocated into whatever is holding the work down. The refusal therefore has to be
actionable, and the core's message now opens **MOVE ONE OF THEM off this material**
rather than only stating that the pair cannot be cut.

⚠ **The copy control is separate from the picker on purpose.** The drawing picker is a
multi-select whose rows TOGGLE, exactly like the tool picker's; making one picker's row
mean *"add another"* would give two multi-selects in one app two different meanings for
the same gesture. Copies come from a `⧉` button on the row.

⚠ **A defect this found in its own test harness, worth keeping:** the first version of
the per-part coordinate reader (in the core test, in gate `MULTI`, and in the browser
test) split an operation comment on WHITESPACE. Real instance ids are drawing names —
`Hive super end` — so `( op: Hive super end/part1 [End Mill …] )` was read as a part
called `Hive`, and one copy's coordinates were silently attributed to a part that does
not exist. It was caught only because a test used a realistic id; `A` and `B` would
have passed forever, **and so would the gate**. All three now read up to ` [`.

### #66 · Panel order
  ✅ **DONE** — done — `toolVerdicts` computes verdicts from the core (same `config` as the planner). "Recommendation" facet on tool picker with `ADVICE_OPTIONS` (recommended / usable / not-for-this-job / unknown). `usabilityMark` shows red for `invalidates` with the named rule. Filter is on `advice` not `usability` — hiding `invalidates` rows would hide the ones the operator most needs to see. Verified 2026-08-17.
Founder, 2026-08-10, twice on the same day. First: *"push the Machine as the 1st group
from the top above Drawing"*. Then, superseding it: *"change order : Machine ->
Workpeace -> Drawing -> Work holding -> Tooling -> Operation -> Verification ->
Import/Export"*.

**LANDED 2026-08-10 — the SECOND ruling, and only that one.** Both are recorded here
rather than the first being deleted: it is not wrong (Machine is still first), and a
reader who found only the second would not know the order had been ruled on twice, nor
that the first was applied and then replaced inside one pass.

Pure DOM order. Checked rather than assumed before moving anything: nothing in this app
reads a panel's POSITION — `Section` takes `defaultOpen` and its testid as PROPS, the
session restore keys on field names, the empty state names the Drawing panel rather than
"the first one", and the one e2e that enumerates panels (`every panel the spec promises
is present`) asserts PRESENCE, not order.

⚠ **His list has EIGHT names and the input column holds exactly those eight.**
`panel-summary`, `panel-sim`, `panel-notes` and `panel-gcode` were never in question:
they live in the OTHER `<aside>`, the results column, so there was nothing to decide
about them and nothing was guessed.

🔴 **One name does not match and is REPORTED rather than resolved.** The founder's
eighth is *"Import/Export"*; the section is titled **Saved data**. It IS that surface —
`Export all` / `Import` over the browser store — so it takes the slot, but the TITLE is
left alone: renaming a panel on an inference about what he meant is the kind of quiet
guess this lane does not make. One line from him settles it.

### #67 · Remove the sphere knob that rotates the workpiece
  ✅ **DONE** — done — trigger shows selection (chips for multi, name for single) alongside action verb (`Add`/`Choose`/`Change`). `ObjectPicker` computes `actionVerb` from `mode` and selection state. Verified 2026-08-17.
Founder, 2026-08-10: *"remove the large ball to rotate the workpeace"*.

**LANDED 2026-08-10 — removed in FOUR places, not one.** A knob that is invisible and
still hit-tested would silently eat every drag aimed at the sheet underneath it, which
is the same class of defect as the pointer shield that made the snap chips dead (#32):
the mesh (`stock-rotate`), its material entry in the theme pass, the `data-rotate-handle`
publication, and the `draggingRotate` branch that claimed pointer priority ahead of
every other drag. `SNAP_DEG` — the angular snap for a gesture that no longer exists —
went with it.

✅ **The CAPABILITY stays, and that was verified BEFORE deleting anything.** The `Laid
at` select (0/90/180/270) and the `rotate-ccw` / `rotate-cw` buttons write the same
`rotation` state the knob wrote, unconditionally. A knob removed while it was the only
way to turn a sheet would be a capability regression wearing a UI-cleanup costume.

🔴 **The e2e was INVERTED, not deleted.** `the sheet can be turned by its handle, and
the turn reaches the G-code` became `the sheet can be turned by the control that
survives, …`, driving the select and keeping the emitted-program assertion **exactly as
it was**. That test earned its place — it caught the pointer-shield defect twice — and
its real guarantee (*a turn reaches the G-code*) is still true and still worth guarding.
A test deleted along with the widget it happened to drive takes a live guarantee with
it, and nothing goes red when the guarantee does. It also now asserts the knob is
genuinely **gone** (`data-rotate-handle` absent), because the viewport published that
attribute for exactly this kind of check and an absence is as checkable as a position.

⚠ **What the inverted test no longer covers, said plainly:** the pointer-shield class.
The knob's grab point was measured against `document.elementFromPoint`; a `<select>`
cannot be shielded by a canvas overlay the same way, so the defect class went with the
3D affordance rather than going unwatched. The technique is still needed by the sheet
drag, the part drag and the clamp drag, and those keep it.

### #65 · Right-click a clamp: remove / clone / rotate
Founder, 2026-08-10: *"I should able to right click on the work holding and
remove/clone/rotate"*.

✅ **The rotate half is already built in the core and has been UNREACHABLE since
`1e4d60dbe`.** `Clamp::rotation_deg` turns the clamp about its own bolt anchor, and
`contains()`/`contour()` are both computed from `corners()` so the picture and the
keepout come from one number. `ClampCfg.rotation_deg` reaches the report echo, and
gate **P7R** proves the angle survives the round trip (37° in, 37° out). **What has
never existed is a way for an operator to set it** — P7R's own row says so: *"the
clamp DRAG path still cannot set a rotation"*. This request is exactly that missing
half, and it needs no core work.

⚠ **Share ONE context-menu mechanism with #64** (right-click the workpiece →
delete/clone). Two menus built separately will disagree about which button opens
them, whether the camera still pans, and what a right-click on empty bed does. Build
the mechanism once and register targets on it.

⚠ Right-click currently PANS the camera. Decide the button/modifier deliberately and
state it — the pan basis was got wrong once already and cost a day.

🔴 **CLONE MUST COPY THE DECLARATION, NOT THE PICTURE.** A clamp carries `name · x ·
y · w · h · height_mm · rotation_deg`, and **`height_mm` is the one that bites**: it
is what `clearance_z` refuses every rapid below. A clone that copies the footprint and
drops the height gives a clamp whose height reads `0.0` — the clearance falls back to
`machine.safe_z_mm` (5mm by default) and the gantry crosses the bed under it.
`ClampHeightUndeclared` (`58ce90f59`) fires on exactly that, so the failure is
*reported* rather than silent — but a clone that trips a safety finding on every use
is a bug, not a feature.

⚠ **CORRECTED 2026-08-27: `clearance_z` is a THRESHOLD, NOT A LIFT.** It does not raise anything — it takes the tallest declared clamp and **REFUSES** a rapid that would pass below it (`core/src/fixture.rs`, and the module header says so at the top of the file). The wrong wording came from the core's own doc comments, which said *"lifts every rapid above the tallest clamp"* until 2026-08-10; the core corrected itself and two consumers did not. **The difference is what an operator does next**: a lift means the machine gets itself out of the way, a refusal means the program does not come out and somebody has to act. `web/src/workholding.ts` carries the same correction and the reason it was believable — two files independently reached the same reading of the same code.

⚠ Clone must also give the copy a DISTINCT NAME. `CutsClamp { clamp: "…" }` names the
clamp it refused for, and two clamps called `bar-left` make that refusal ambiguous
precisely when an operator is trying to act on it.

⚠ **Remove changes the fixture check, not just the scene.** Deleting the last clamp
returns `Fixturing` to `Undeclared` — "nobody confirmed the bed is clear" — which is
correct and must not be quietly swallowed by the menu.

### #66 · Filter the tool list by recommendation, and mark what invalidates the job
  ✅ **DONE** — done — `toolVerdicts` computes verdicts from the core (same `config` as the planner). "Recommendation" facet on tool picker with `ADVICE_OPTIONS` (recommended / usable / not-for-this-job / unknown). `usabilityMark` shows red for `invalidates` with the named rule. Filter is on `advice` not `usability` — hiding `invalidates` rows would hide the ones the operator most needs to see. Verified 2026-08-17.
Founder, 2026-08-10: *"Tool list, I should able to filter the tools by recommendation
of the system; highlight the tool (e.g. red background) if it does not work for the
current setup, it invalidates the job"*.

**The recommender already exists and the browser cannot reach it.** `2bee-slice
recommend <drawing>` answers per FEATURE, with a reason and every rejection:

```
feature part1/outer (profile, 18.000mm deep)
  TOOL     End Mill - Up-cut 12mm 2F
  REASON   nothing in this feature caps the cutter radius, so 12mm is the largest
           usable cutter in the library; 42mm of cutting length clears the 18mm
           depth; the machine declared no collet, so the 12mm shank is UNCHECKED,
           not verified; Plywood caps it at 24000rpm and 6mm per pass …
```

🔴 **It is CLI-ONLY.** `grep recommend wasm/src/lib.rs` and `web/src/cam.ts` both
return nothing — there is no binding, so the UI has no way to ask. **That is the
work**: expose it through wasm, then filter and mark from its answer.

**What the picker already has**, and must not lose: `fit` / `fit_why` / `selectable`
per tool (`fixtures.rs:2957`), the core's collet verdict passed through verbatim.

🔴 **THE RULE THIS COLLIDES WITH, and it is written in the picker's own header:**
*"On screen a hidden item and a non-existent item are IDENTICAL"* — so the picker
reports **how many hidden ones were unusable**. A filter that quietly drops
unrecommended tools recreates the exact defect the browser suite names in a test
title: *"the search box hides an unusable tool, so an operator reads 'needs a collet'
as 'no such tool'"*. ⇒ **The filter is opt-in, and it says what it hid.**

⚠ **The verdict comes from the CORE, never re-derived in TypeScript.** The collet
check was computed in the UI once and was wrong; every property in the tool row is
now the core's answer passed through. A red background decided by TypeScript
arithmetic would be the same defect wearing a colour.

⚠ **"Invalidates the job" is not one condition** and the mark must say WHICH:
a shank no collet can hold, a cutter wider than the narrowest feature, a cutting
length shorter than the depth, an rpm the material caps below the spindle's floor.
`recommend` already distinguishes these — pass the reason, not a boolean.

⚠ **Use the existing `--bad` token**, not a new red. Note its documented caveat:
`--bad` and `--warn` miss WCAG AA against brand's own card surface, and
`styles.css:155-167` already lifts them with a measured `color-mix`. A background
tint has a different contrast requirement from text — check the pair rather than
assuming the token is safe in a new role.

### #67 · The sidebar control is an ADD button, not a select
  ✅ **DONE** — done — trigger shows selection (chips for multi, name for single) alongside action verb (`Add`/`Choose`/`Change`). `ObjectPicker` computes `actionVerb` from `mode` and selection state. Verified 2026-08-17.
Founder, 2026-08-10: *"in the left sidebar the drop down should be just Add… (Add
Drawing, Add Workpeace, Add Tool … etc; no need to list the added object in the drop
down"*.

The trigger stops echoing the current selection and becomes an action: **`Add
Drawing`**, **`Add Tool`**, **`Add Work holding`**. What is already added is shown by
the ROWS (#58's `tool-rows` / `drawing-rows`), so the trigger showing it too is the
same fact in two places — and two places that can disagree.

⚠ **This finishes the direction the panel has been moving all week**: properties
read-only in the panel, every add/import/export/delete in the list (#55, #61). A
trigger that displays state is the last piece still doing both jobs.

🔴 **"Add" IS WRONG FOR FIVE OF THE EIGHT PICKERS, and applying it blanket would
lie.** Measured: 3 are `mode="multi"`, 5 are `mode="single"` —

| picker | mode | honest verb |
|---|---|---|
| Drawing · Tool · (work holding, once #63 lands) | multi | **Add** — they accumulate |
| Machine · Workpiece · Material · Touch plate · Hold-down | single | **Choose / Change** — there is one, and picking replaces it |

A machine is not added; you HAVE one and you swap it. Labelling that button `Add
Machine` invites an operator to expect two machines, and the panel would then have
to explain why the second one replaced the first. ⚠ Note #64 may make **Workpiece**
genuinely multi — if it does, its verb changes with it, and the label must be derived
from the picker's mode rather than hand-written per call site, or the two will drift.

⚠ **Keep the label on the button.** The control still needs an accessible name that
says WHICH kind of object it adds — `Add` alone, repeated eight times down a sidebar,
is eight identically-named buttons to a screen reader.

**#64 reinforced (founder, 2026-08-10, second time):** *"Able to add multiple work
peaces"*. Nothing about the item changes — the trap is unchanged and it is the
reason this is not a quick one: `Job.stock` is ONE `Stock`, its `thickness_mm` is
read in 30 places, and `toolpath.rs` computes `depth = depth_total_mm.min(thickness +
0.3)`. **Two sheets of different thickness under one program cut into the spoilboard
or leave the part attached, and they cannot share a Z zero.** The three options and
the one that must not be built are recorded above; the model decision comes first,
the UI second.

### #68 · Does the work holding actually hold it? — a restraint check, not a keepout check
  ✅ **DONE** — done — warns when an up-cut cutter is paired with workholding that doesn't resist lift. Checks `flute_type === 'up-cut'` against `resists.includes('lift')`. Shown as a `warn` in the workholding panel. 🟡 Not covered: lateral force validation (needs feed/depth data), and the warning is advisory only — not a gate. Verified 2026-08-17.
Founder, 2026-08-10: *"validation: during the job the work holding holds down the
required peaces? is there a risk the workpeace will not be down correctly?"*

**What exists today, measured — four fixture findings and NOT ONE of them is about
restraint:**

| finding | what it answers |
|---|---|
| `CutsClamp` | the cutter goes THROUGH a clamp |
| `RapidBelowClamp` | a rapid crosses BELOW a clamp's top |
| `ClampHeightUndeclared` | nobody measured a clamp's height |
| `Undeclared` | nobody declared any work holding at all |

Every one asks *"does the toolpath hit the clamp?"* — **none asks "does the clamp
hold the work?"** Plus `P1`: every closed profile gets ≥1 tab (≥2 by `auto_tabs`,
because one tab lets the part pivot). That is the only restraint rule in the tool,
and it is about the PART coming loose, never about the SHEET.

⇒ **The founder is asking the question the whole fixture module does not ask.**

🔴 **WHAT IS COMPUTABLE — build these, they are geometry and ordering:**
1. **A clamp standing on material that a later operation removes.** After that cut
   the clamp holds an offcut, or nothing. Computable from the clamp footprint
   against the cut regions, in PROGRAM ORDER — this is the sharpest of the set and
   nothing checks it today.
2. **A part freed before the program ends.** `P1` guarantees tabs exist; it does not
   ask whether a part whose tabs are cut on pass 3 is then worked on in pass 4. The
   `REL` gate already does this for TOOL GROUPS — extend the same reasoning to the
   whole ordering.
3. **A sheet held only on one side of a cut.** Once a through-cut separates the sheet
   into two regions, each region needs its own restraint. A region with no clamp and
   no tabs is loose material next to a spinning cutter — computable as a connectivity
   question over the cut regions.
4. **Clamps all on one edge**: report the restrained span against the sheet, because
   an operator can act on "everything is clamped along one edge".

🔴 **WHAT IS NOT COMPUTABLE, AND MUST BE SAID RATHER THAN GUESSED:** whether the
clamping FORCE is enough. That needs clamp preload, friction coefficient, cutting
force from engagement and feed, and vibration — **none of which this tool has, and
none of which may be invented.** `max_doc_ratio` was sourced to the wrong machine
once and that was only a multiplier; a fabricated hold-down force would be a safety
number with no source at all. ⇒ Report **UNCHECKED** for force, name the four
computable findings, and never render a green that reads as "it will hold".

⚠ **The honest headline matters more than the checks.** "No hold-down problem found"
must never be shown where "the geometry checks passed and nobody has measured the
force" is the truth — that is the `colony_health_band` failure mode (a constant
rendered as a measurement), and this one ends with a part thrown from a 2.2 kW
spindle rather than a wrong dashboard.

### #68 · Show/hide the cutter, like every other drawn thing
  ✅ **DONE** — done — warns when an up-cut cutter is paired with workholding that doesn't resist lift. Checks `flute_type === 'up-cut'` against `resists.includes('lift')`. Shown as a `warn` in the workholding panel. 🟡 Not covered: lateral force validation (needs feed/depth data), and the warning is advisory only — not a gate. Verified 2026-08-17.
Founder, 2026-08-10: *"on the top section able to show/hide the Tooling as well
(cut, tab, rapid … etc)"*.

**LANDED 2026-08-10.** The tool marker (scene object `tool`, the body + cage + rings
fed by `toolMarkerShape`) was **the one drawn object in this scene with no toggle** —
`LAYERS` held loaded · result · walls · touch · cut · tab · drill · rapid · change ·
probe · workpiece · clamps · bed, and not the cutter standing at the head of the
program.

It follows the `clamps` layer (`6aed899a73`) in three ways, and each of them is a
defect this app has actually had:

1. **Through the shared `chip` style**, which carries `pointerEvents: 'auto'` against
   the overlay column's `'none'`. A chip that misses it renders, styles as enabled,
   reports `aria-pressed` — and is DEAD, because the click passes through to the canvas
   as a camera orbit. That has happened twice (the rotate handle, and the snap controls
   in #32).
2. **`presentKinds` semantics, not `walls`' present-and-disabled one.** `toolMarkerShape`
   REFUSES to draw when the tool row states no diameter, so "no marker" is a real state
   a job can be in. A greyed chip for it would say *the cutter is switched off* when the
   truth is *nothing knows how wide it is* — and a disabled control reads as "off". The
   liveness test is `refused === null`, **not** `drawn.length`: `drawn` is the prose list
   of what the marker asserts, and a marker can be drawn while asserting nothing.
3. **Asserted on the RENDERED CANVAS.** The new browser test counts the cutter's own
   colour (`TOOL_CUT_COLOR`) in the GL buffer — present → 0 → present again — rather
   than trusting `aria-pressed`, which flips whether the control is live or dead. It
   reads the drawing buffer rather than screenshotting the element, because this feature
   adds DOM on top of the canvas (the "N of N hidden" banner) and an element screenshot
   would differ whether or not the 3D scene moved.

⚠ **Checked against the knob removal in the same pass (#67):** hiding the marker must
not leave an invisible object claiming pointer priority — the defect the clamps work
had to fix, where a hidden clamp still ate a drag. The pick pass casts with
`intersectObjects`, which skips an object whose `visible` is false, so the marker drops
out of the pick with its picture. All three pieces share the name `tool`, so one arm
hides every one of them: half a cutter left on the canvas would be a fourth object that
is not the cutter, not the path and not the work.

⚠ **The label is `cutter at the head`, never `tool`.** This app already calls a row in
the library a "tool", and a chip labelled `tool` sitting beside a Tooling panel reads as
that panel's on/off switch.

### #69 · Undo, and Ctrl-Z
Founder, 2026-08-10: *"Able to undo last changes (use ctrl-Z as well)"*.

✅ **The state shape already exists.** `#52` made the whole working setup one
versioned, validated `SessionValues` blob written on every change. An undo stack is
a stack of those, so this is cheaper than it looks — and it must reuse that
validation on the way back, or undo becomes a second path into the app's state that
nothing checks.

🔴 **UNDO MUST NEVER RESTORE AN ATTESTATION.** `Fixturing.confirmedClear` is set only
by a human confirming they LOOKED AT THE BED. `#52` already refuses to restore it
across a refresh for exactly that reason — *"nobody looked in this session"* — and
undo is the same violation with a shorter time constant: **a machine re-ticking a
box that means "I checked" is a lie regardless of how recently the human ticked it.**
Undo may restore clamp GEOMETRY (it is a declaration, and retyping it is toil); it
may not restore the confirmation that the bed is clear. Same for anything else that
means "a person verified this".

⚠ **Ctrl-Z inside a text or number field is the browser's own undo.** Hijacking it
globally would take away the edit-level undo an operator expects while typing a datum
— fix one thing and break a smaller one. Scope the shortcut to the canvas/panel, not
to focused inputs.

⚠ **Decide and STATE what is undoable.** Placement drags, rotations, clamp add/edit/
delete, tool and drawing selection — yes. A G-code download already on disk, or a
saved library item already written to IndexedDB — no. An undo that silently does not
cover something is worse than one that says what it covers, because the operator
learns to trust it and then meets the gap on the one action that mattered.

⚠ **Redo, or say there is none.** A half-implemented undo with no redo strands an
operator who overshoots.

**#42 reinforced (founder, 2026-08-10, twice):** *"when a work holding is over the
workpeace it may required 2 phase cnc job, move the workholdings during the job?"*

That is exactly this item, and the founder's phrasing adds the case the entry did
not name: not "a clamp is in the way of a cut" but **"a clamp is standing on the
part, so it must move before that area can be reached at all"**. Same mechanism,
different trigger — and it is the common one on a full sheet.

🔴 **It also joins #68 at the hip, and neither is complete without the other.** #68
asks *"does the work holding hold the piece?"* — a phase split makes that a question
with a TIME AXIS: it must hold **before** the move, **during** it, and **after**.
The instruction is therefore two steps and their order is the safety property —
**new clamp on, THEN old clamp off** — never one line saying "move the clamp".

🔴 **And the datum is the sharper risk, already named in this entry and worth
repeating because the founder's version makes it likelier:** if the part shifts even
slightly while a clamp is off, every coordinate after the resume is wrong, and
NOTHING DOWNSTREAM WILL SAY SO — the program keeps cutting confidently in the old
frame. A phase split therefore either forbids the part moving, or **re-probes after
the resume**. The XYZ touch-plate path (gate `PROBE`) already exists to re-establish
a datum; a phase change is the case it was built for and is not yet wired to.

⚠ Do not let this become a way to make `CutsClamp` stop refusing. The refusal is
correct; the phase split is a DIFFERENT PROGRAM that happens to be runnable, offered
through `OfferedFix` — core proposes, operator disposes. A refusal that quietly turns
into a fix is how a hard gate becomes a suggestion.

### #69 · The pair check's SCOPE, made explicit before #64 needs it
  ✅ **DONE** — done — one-level undo for setup changes. `pushSnapshot()` captures stock, datum, material, tools, clamps, drawings, sectionZ before significant changes. Ctrl-Z restores (only when CNC tab is active and no input focused). Capped at 10 entries. Verified 2026-08-17.
Raised 2026-08-10 while #31 was being built, from a measurement rather than a worry.

`check_interference` is a **flat pairwise scan over parts in SHEET-LOCAL millimetres**
— the sheet's own datum is applied afterwards, by `Job::place`. Today that is correct,
because there is exactly one sheet.

🔴 **The moment #64 lands (multiple workpieces — the founder has asked twice), two
copies of one part sitting on two DIFFERENT boards read as a 100% overlap**, and the
refusal built for #31 emits zero bytes. A total false red on a perfectly good nest,
produced by a check that was right when it was written.

**LANDED 2026-08-10 — the scope, not multi-sheet.** `PlacedDrawing::sheet_id` (always
`ONE_SHEET` today), carried onto `LaidOutPart`, and `check_interference` skips a pair
whose sheets differ. #64 relaxes a value instead of rewriting the check and the gate
that holds it. A test asserts both directions — same board at one spot is refused,
different boards at the same sheet-local spot is not — and the scope was planted out
and watched red.

⚠ **The general form, which is why this was worth doing early: an invariant that is
true because there is only one of something is not an invariant, it is a coincidence.**
It reads as a rule until the second one arrives, and it stops being true silently.

🔴 **Two things that must move BEFORE multi-sheet, recorded so they are not discovered
by a wrong cut** — neither was touched here:
- **SVG intake Y-FLIPS against `stock.size_y_mm` at INTAKE**, before any placement is
  applied. So a part's sheet has to be known before its geometry is read, and the
  current order (intake, then place) cannot express that.
- **`material` is a field of `Job`, not `Stock`.** Two materials on one bed cannot be
  expressed at all, so nothing in a data model should offer a per-part or per-sheet
  material until that moves.

⚠ **And one deliberately NOT touched:** `Stock::z_zero_at_top` has **no consumer** —
written by the browser, persisted, saved into workpieces, copied out of config, and
read by no planner, post or check. It is a setting an operator can change that changes
nothing, which is exactly gate `G11`'s class. This pass persists it unchanged and adds
no consumer: giving it one as a side effect of unrelated work would bury the defect
under a fix nobody reviewed as one.

---

### #70 · Play the job, and show what is done AND what is left
✅ **DONE** — Second rendering pass in `Viewport.tsx` draws remaining moves (from `upTo` to end) at 0.3 opacity with same per-kind coloring. Lines named `path-remaining:${kind}`. Verified 2026-08-20.
Founder 2026-08-11: *"when I play the job (x1, x2, x5, x10) visualize in the 3d
canvas what has been done and what is remaining"*.

🔴 **CORRECTED THE SAME DAY, BEFORE ANY WORK STARTED. I filed this as if nothing
existed. Most of it ships already, and my first draft of this item was wrong in
the direction that would have bought a rewrite of working code.** Left visible
rather than deleted: a stale request misleads exactly like a stale prohibition.

**What is already built and already honest** (all in `HEAD`, not new work):
- `PLAYBACK_SPEEDS = [1, 2, 5, 10]` (`App.tsx:144`) and a transport with play,
  pause, scrub and a clock.
- 🔴 **It is time-correct, not frame-correct**, which is the thing I predicted it
  would get wrong. `App.tsx:1901` builds a `timeline` whose per-move seconds are
  `d / (mmMin / 60)` where `mmMin` is **`m.feed` — carried on `RenderMove` from
  the core** — with `report.rapid_mm_min` for rapids. So `RenderMove` does NOT
  carry only `kind/x/y/z`; the note in `#17` saying so is **stale**, and my
  restatement of it here was stale twice over.
- The clock advances by wall time scaled by `speed` and touches nothing else.
  `progress = (indexAt(t) + 1) / moves`, and `Viewport.tsx:3929` recovers
  `floor(moves.length * progress)` — so the drawn playhead and the clock are the
  same quantity, round-tripped, not two derivations.
- A move with **no `F` and no rapid rate is COUNTED, not guessed** (`untimed`,
  `untimedMm`) and surfaced on the panel, and the panel already prints the
  playback total against `report.estimated_seconds` with the difference.
- A tool change is charged `TOOL_CHANGE_SECONDS`, not treated as instantaneous.

**So what is actually missing is the founder's second noun.** `Viewport.tsx:3929`
loops `for (i = 0; i < upTo; i++)` — **only the DONE portion is built into the
scene. The remaining toolpath is not drawn at all.** The path grows out of
nothing, so at any moment you can see what has been cut and you cannot see what
is left, which is exactly half of what was asked for.

**The work:** draw the whole program, and distinguish done from remaining —
colour, opacity, or both — rather than truncating the geometry at the playhead.
⚠ Keep the per-kind split (cut / rapid / tab / drill) working in both states, or
the legend stops meaning anything mid-playback. ⚠ And the marker crosses for
`change`/`probe` are points, not segments; they need the same two-state treatment
or they will pop into existence.

**What is genuinely still missing from the core**, and is worth having anyway:
- **Acceleration.** Every duration here is `length / feed`, a steady-state
  figure. Real machines ramp, and on a program of thousands of short segments the
  error is large and always in the optimistic direction. The panel does not say
  this. It should — a duration presented without that caveat gets quoted as a
  machining time.
- **Operation name and tool id per move**, which `#17` wants for the hover panel
  and which the run tab (`#76`) will want to say *which operation is cutting now*.

### #71 · The spoilboard has no thickness, so "through it" cannot be checked
✅ **DONE** — `Spoilboard.thickness_mm: Option<f64>` (None = UNKNOWN); `sim.rs` consumes it; `boardSlab()` renders 3 states (slab/unknown-thickness/none). Verified 2026-08-20.
Founder 2026-08-11, asked directly: *"check the spoilboard implementation — is
this going between the table and the workpiece?"*

**Measured answer: physically yes, in the model no.** `core/src/types.rs:420`
is `Spoilboard { name, x_mm, y_mm, size_x_mm, size_y_mm }` — **no thickness
field** — and `core/src/sim.rs:801` computes
`let floor = -(stock_thickness_mm + spoilboard_allowance_mm)`. So the board is
modelled as **an XY region plus a depth allowance below the stock**, never as a
slab with a top and a bottom.

What that buys and what it does not:
- ✅ *over the board* vs *past its edge* — real, and distinguished
  (`BelowSheet::OverSpoilboard` / `PastSpoilboardEdge`).
- ✅ *deeper than the stock by more than the allowance* — real.
- 🔴 *THROUGH the board into the machine* — **not modelled and not modellable**
  as the type stands. A 6mm MDF board and a 25mm one are the same object to
  this code, and the thin one is the one that puts a cutter into the table.
- 🔴 The stack has no height: the workpiece bottom is at the board top **by
  assumption, not by construction**. Nothing states where the board's top face
  sits in machine Z.

Fix is `thickness_mm: Option<f64>`, absent meaning **UNKNOWN and NOT "thick
enough"**. Two constraints: a catalogue entry may carry a thickness only if its
cited source states one (`core/src/spoilboards.rs` forbids a dimension written
from memory, and an invented thickness is worse than an absent one because
absent reads as unknown), and the new finding needs a planted through-cut
watched to go red before it counts.

✅ **UNBLOCKED AND EXPLICITLY ASKED FOR, 2026-08-11 (founder, second time today):**
*"spoilboard should have thickness, visualize the thickness as well."* The earlier
agent's refusal to half-add it was right and is now spent — the field is being
built in the core, with the two limbs kept apart (*position* already has its own
pending state; *depth* gets its own) and with `None` meaning **UNKNOWN, never
"thick enough"**.

⚠ **On the visualisation specifically: an unknown-thickness board must look
different from a known one.** Drawing a slab of assumed depth would put a
measurement nobody made into the picture, which is the same defect as an
auto-filled corner rendered as a declaration — and the picture is the thing an
operator trusts fastest.

⚠ **`18` for the 2bee table is DOCUMENTARY, not measured.** `cad` ruled 1080 ×
1560 × 18 from the model today and stated plainly that **there is no physical
table to measure**. If it enters the catalogue it enters with that provenance.

### #72 · Offer only the spoilboards that fit the machine — and mark the rest
✅ **DONE** — `spoilboardReachVerdict()` computed per catalogue row; `🔴 MARKED, NEVER HIDDEN` with reach verdict shown. Rows not disabled for reach. Verified 2026-08-20.
Founder 2026-08-11: *"limit the spoilboards what fit to the machine"*.

`core/src/spoilboards.rs` carries boards from 600x1200 to 3600x1200. A 3600 board
on a 6090 is noise.

🔴 **Mark, do not hide** — the founder's own rule for the tool list applies
unchanged: *"highlight the tool (e.g. red background) if it does not work for the
current setup"*. A board that vanishes looks like a board that does not exist,
and the operator who owns it cannot tell "not offered" from "not stocked".

⚠ **The fit predicate must be a quantity we model.** That is `travel_x_mm` /
`travel_y_mm` today. We do **not** model the table or frame, so "fits the
machine" cannot mean "fits the frame" — and if the honest predicate needs a
dimension we do not have, the entry is `UNKNOWN`, not green and not red.
Inventing a frame size is precisely what that file's header forbids.

### #73 · Auto-fill and position the board, without asserting a measurement
✅ **DONE** — `fitSpoilboard()` centres on cut extent clamped inside travel; `assumed`/`entered` provenance tracked; re-fit on edit only when `assumed`. Verified 2026-08-20.
Founder 2026-08-11: *"automatically fill out and position the spoil board: Board
X (lower-left) — not declared / Board Y (lower-left) — not declared"*.

Both position fields read **not declared** and he wants them filled rather than
typed.

🔴 **An auto-filled position is an ASSUMPTION about where a physical board is
bolted**, and the type's own doc is about exactly this: *"It is NOT assumed to be
`0,0`: a board is bolted where the T-slots let it go, and a 20mm offset is 20mm
of bare rail that the old depth-only check called spoilboard."* So the rule is
not *don't auto-fill* — it is **never let an assumed position be
indistinguishable from a measured one**.

- Derive the placement from the **work**, not from the origin: position the board
  so it contains the workpiece and its toolpath, clamped inside the travel. Too
  small to contain the job is a **refusal with a reason**, not a silent shrink.
- Carry provenance — `assumed` vs `entered` — and make every report that names
  the board say which. The finding text must not read identically for both.
- Where uncertain, claim **less** sacrificial material, not more.
- An operator override must stick, including across a reload. An auto-fill that
  recomputes over a typed value is worse than none.

### #74 · Hover the spoilboard and the travel envelope, and show their properties
✅ **DONE** — Both pickable in viewport (tier 3/4). Hover panels report name, size, corner, thickness, uncovered reach. Verified 2026-08-20.
Founder 2026-08-11: *"when I hover the mouse over the spoil board / table show
the properties!"*

Extends `#17` (hover highlight + details) to the two things the spoilboard work
puts on screen. Both are now drawn, and neither is pickable.

What each can honestly report:
- **Spoilboard** — name, size, lower-left corner, **and whether that corner was
  entered or assumed** (`#73`). Once `#71` lands, thickness — and `UNKNOWN`
  where it is unknown, never a blank that reads as zero.
- **Travel envelope** — the axis limits, and the plain statement that this is
  **reach, not material**. `core/src/types.rs` keeps that distinction deliberately
  and a hover panel that lets them blur undoes it: *"travel is reach, the
  spoilboard is material, and they are not the same rectangle"*.

⚠ The uncovered-area corners (`minus_x_mm` / `plus_x_mm` / `minus_y_mm` /
`plus_y_mm`) are the interesting number here — that is reachable area with **no
sacrificial material under it** — and it is the one an operator would most want on
hover.

### #75 · `uncut_checked` never reaches the browser, so the PENDING note lies on `pocket`
✅ **DONE** — `cam.ts` exports `uncut_checked`/`uncut_pending_reason`; `App.tsx` derives a 3-state `'pending' | 'clean' | 'finding'` verdict; `SimulationPanel.tsx` renders the pending badge and reason. Verified 2026-08-20.

Found by the e2e agent 2026-08-11 while writing the uncut test; **verified
independently at the CLI before filing.**

`core/src/fixtures.rs` exports `uncut_checked`, `uncut_cells_tested` and
`uncut_pending_reason`, and its own doc says *"a consumer must key off THIS, not
off `uncut`"*. Measured:

```
report plate  → uncut 0, uncut_checked false, cells tested 0
report pocket → uncut 3, uncut_checked TRUE,  cells tested 9604
```

🔴 **`uncut_checked` appears in NEITHER `web/src/cam.ts` NOR `web/src/App.tsx`.**
It does not cross the wasm boundary at all. So:
- the class is keyed on `report.sim.uncut > 0`, not on the flag;
- `sim-uncut-pending` (`App.tsx:5492`) renders **unconditionally** and states
  *"on your job this counter cannot fire … `0` means the question was never
  asked."* On `pocket` that is **false**, and it prints beside a red `3`. The
  note's own text even concedes the pocket fixture declares such a region.

⚠ **The failure that has not happened yet is the worse one.** The day a job
reports a **measured zero** — checked, 9,604 cells, nothing left standing — the
panel will render a genuine clean result as PENDING. Today the two keyings agree
only because no reachable job reports checked-and-zero. That is the exact shape
of a control that is right by luck.

Fix: plumb the flag through `cam.ts`, key the class and the note on it, and give
it a testid so the e2e test can assert the three states directly instead of
inferring them.

### #76 · A third tab: run the machine and watch it
✅ **DONE** — `RunTab.tsx` implemented with Web Serial, grblHAL protocol, DRO, streaming, feed hold/resume, homing, jogging. Menu bar (#108) with File/View/Help. Verified 2026-08-20.
Founder 2026-08-11: *"1st tab cad, 2nd tab CNC, 3rd tab operation, this is where
I will execute and monitor the CNC router?"*

Accepted. Three tabs, in that order. Two things must be settled before a line of
it is written.

#### 🔴 The name collides with something already on screen
`web/src/App.tsx:4841` is `<Section title="Operation" testid="panel-op">` — the
cutting parameters — and the founder asked on the SAME DAY for *"operation needs
a list so I can pick an operation (setting) from the list"* (#77). So "Operation"
would name **a tab and a panel inside a different tab**, and a saved "operation"
would be a set of feeds, not a machine session.

This lane has the fleet's own precedent for what a name that is a prefix or a
duplicate of another name costs: `tmux -t pa` prefix-matched `patents` and
**hijacked** the session — root canon calls it out because it was not theoretical.
A UI is gentler than a shell, but the failure is the same shape: a person or a
test says "operation" and reaches the wrong thing.

**Recommend `Run`.** It says what the tab does, it collides with nothing, and it
is what the operator is actually doing. `Machine control` and `Console` also work.
**Whatever it is called, `Operation` stays the name of the cutting parameters** —
that word is already in the emitted program (`( op: pocket-1 )`), so moving it is
the more expensive rename.

#### 🔴 The transport is settled by hardware we already locked
`hardware/bom/tools-bom.md:134` — **grblHAL on a BTT SKR Pro** (founder ruling
2026-07-14). That is an STM32F407: **no ethernet PHY, no onboard WiFi.** So there
is no WebSocket path to it, and the browser's only route is **the Web Serial API
over USB CDC**.

What that costs, and it is not small:
- **Chrome or Edge only.** Firefox and Safari do not implement Web Serial, and
  there is no polyfill — a serial port cannot be shimmed. **iOS is out entirely.**
- **Secure context required** — HTTPS or `localhost`. Note `.app` is HSTS-preloaded
  at the TLD, so if this is ever served from `2bee.app` a valid certificate is a
  precondition of the first request, not a follow-up.
- **A user gesture is required** for `requestPort()`, every session until the port
  is remembered.
- ⚠ **A backgrounded tab is throttled.** A streamer starved of timer callbacks
  stops feeding the buffer, and a spindle sitting still in the cut burns the work
  and can break the cutter. Whatever streams must survive the tab losing focus, or
  must refuse to start when it cannot.

#### 🔴 This tab changes the risk class of the whole application
Everything in this repo so far **emits a file**. `AGENTS.md:73` — *"NOTHING HERE
HAS CUT ANYTHING."* A run tab **moves a real spindle**, and from that point on a
refusal is not advice, a wrong number is not a bad picture, and a stale reading is
not a cosmetic defect.

**The software is not an emergency stop, and must never be labelled as one.**
`!` (feed hold) and `0x18` (soft reset) are grbl realtime commands that ask a
controller to stop; they depend on the link, the firmware and the controller still
being alive, which is precisely what is not true in the emergency they would be
used in. A physical e-stop that cuts power is the safety device. A button in a
browser tab is a convenience, and calling it E-STOP would be the most dangerous
label this application could ship.

#### What it has to do
Streaming (character-counting or send-response), realtime bytes (`?` status, `!`
hold, `~` resume, `0x18` reset, `0x90`–`0x9A` overrides), `$` settings, `$H`
homing, `$J=` jogging, status parsing (`<Idle|MPos:...|FS:...>`), alarm and error
codes rendered as text a person can act on, and a DRO.

⚠ **And it is the real half of #70.** That item animates *predicted* progress
through the program; this tab knows *actual* machine position. Both can colour the
same toolpath, and **they must never be blurred** — a prediction rendered as a
measurement is the defect this lane has found more than once. When the machine is
connected, the DRO is the truth and the prediction is at best a comparison.

#### What cannot be verified here
I can find **no purchase record for a router** in `business/financials/` — the
6090 work in `hardware/bom/tools-bom.md` is a shortlist with a locked controller
decision, not a machine on the floor. So this tab can be **built and simulated
against a grblHAL emulator, and it cannot be validated** until there is a
controller to talk to. Whether one exists is the founder's fact, not this lane's;
what this lane must not do is let a green from a simulated port read as a green
from a machine.

### #77 · Every panel says its own name twice
✅ **DONE** — `ObjectPicker.tsx:927` calls `labelRepeatsHeading()` which visually suppresses the label when it matches the section heading. The accessible name is preserved. Verified 2026-08-20.

Founder 2026-08-11: *"Almost every menu on the left sidebar have duplicated names
like Machine / Machine / MakerSpace"*.

Measured — four exact duplicates, where the `<Section title>` and the
`<ObjectPicker label>` inside it are the same word:

| section | picker label |
|---|---|
| `App.tsx:2684` Machine | `:2706` Machine |
| `:3045` Spoilboard | `:3110` Spoilboard |
| `:3571` Workpiece | `:3627` Workpiece |
| `:3868` Drawing | `:3910` Drawing |

So the screen reads **Machine / Machine / MakerSpace** — header, label, value.
`Work holding → Hold-down` and `Tooling → Tool` differ and are fine.

⚠ **Do not fix it by deleting the label.** It is the picker's accessible name;
removing it leaves a combobox a screen reader announces as nothing. Suppress the
**visible** half and keep the accessible one — `ObjectPicker.tsx` already draws
that distinction for its icons (*"the svg carries its own aria-label; this is the
VISIBLE half"*), so the pattern exists and should be reused rather than reinvented.

### #78 · The SCAD subset accepts seven constructs and quietly means something else
✅ **DONE** — All 7 divergences fixed: assignment order (last-wins via `bindScope`), `cylinder(h,r1,r2)` positional order, scalar `translate` refused, `cube([x,y])` padding matches OpenSCAD, named args don't consume positional slots, `$fa`/`$fs` implemented in both forms. Verified 2026-08-20.

`docs/audit/2026-08-11-scad-silent-divergence.md`, 2026-08-11, every claim
measured through both OpenSCAD 2026.08.07 and our own evaluator (~40 probes).

These are **not** refusals. The refusal rule works. These are constructs we
**accept** and interpret differently, so the user's code means one thing to them
and another to us, with no diagnostic. Ranked by what it does to the part:

1. **Assignment order** — OpenSCAD's last-assignment-wins vs our sequential
   assign. Measured **a 50 mm cube read as 10 mm**. Disclosed in the tab banner,
   but ⚠ **OpenSCAD warns per line naming the variable and we say nothing.**
2. **`cylinder(20,10,4)`** — the third positional is silently read as `r1`, so a
   **cone comes out a cylinder**. `scad.ts:1293` fills `rAll` from `pos[1]` and
   checks it before `pos[2]`, making `pos[2]` unreachable. 🔴
   **`scad.test-notes.md:33` documents the opposite behaviour.**
3. **`cylinder(20,10,4,true)`** — the fourth positional `center` is dropped, so
   the part sits off datum by `h/2`. `cube` and `square` handle it correctly.
4. **`translate(5)`** → `[5,5,5]` here, a **no-op** in OpenSCAD.
5. **`cube([10,20])`** → padded silently; OpenSCAD warns and falls back to
   `cube(1)`. Ours is the quiet, plausible, wrong answer.
6. **`m(10, a=99)`** — a named argument does not consume its positional slot.
7. **`module n(a, b=a*2)`** — sibling-referencing defaults evaluate here and are
   `undef` in OpenSCAD.

🔴 **And the worst one is a DEAD CONTROL, not a divergence.** `$fa`/`$fs` are
supposed to be refused by name. They are not refused at all: `accept()`'s
allowlist at `scad.ts:1265/1276/1286/1306/1317` **contains `'$fa','$fs'`**, so
`if (allowed.includes(key)) continue;` fires before the refusal branch at
`scad.ts:1241` can run. **The branch is unreachable for every primitive.**
Verified independently: `$fa=1;$fs=0.2;cylinder(h=10,r=5)` renders **160 facets
in OpenSCAD and 16 sides here, with zero diagnostics** — and `mesh.ts:75` and
`scad.test-notes.md:61` both assert it is refused. *A refusal that cannot fire is
worse than no refusal, because two documents cite it as coverage.*

⚠ **A second green that lies:** `meshScene` returns `trust = 'trusted'` for a
source where the parser refused a subtree — `#` dropping a `difference()`'s hole
takes the model from 80 facets to 12, and `trust` (`mesh.ts:1518`) is computed
from mesher issues only and **cannot see `unsupported[]` at all.**

✅ Probed and **agreeing**, so nobody re-derives them: `rotate` in every form
including order, default `$fn` from `$fa`/`$fs`, `$fn=0`, `$fn` dynamic scoping,
sphere and cylinder tessellation **vertex-for-vertex including angular phase**,
7 range forms, 10 degenerate forms, 9 of 11 argument-binding forms, and **all 7
`d`/`d1`/`d2` forms — the "`d` read as `r`, part at double size" failure does not
exist here.**

### #79 · A refusal does not remove a node, it RESIZES it — and the audit says trusted
✅ **DONE** — `FAILED = Symbol('2bee.cad: refused or failed expression')` sentinel distinct from `undefined`; `guardArgs()` checks all arguments before any `??` default is applied. Verified 2026-08-20.

`docs/openscad-feature-inventory.md`, 2026-08-11. The whole inventory is worth
reading; this item is the one finding that contradicts the lane's own contract.

`scad.ts`'s header states the design rule that everything else rests on:

> the tree is therefore always a SUBSET of what the source says, never a guess
> at it

🔴 **It is not a subset. It is a guess, and I verified the mechanism at both
halves:**

- `scad.ts:1344` — a refused **expression** returns `undefined`.
- `scad.ts:1266` — `const sizeV = named.get('size') ?? pos[0] ?? 1;`

`undefined` is exactly what "argument not supplied" looks like at a `??` default.
So a refused argument does not remove the node — **it falls through to the
default and the node is built at the default size.** `cube(sq(3))` becomes
`cube(1)`: **1 mm³ where the source says 27.** Four more measured the same way,
including `cube([1,2,3]*[1,2,3])` → 1 instead of 2744.

⚠ **And every one reported `trust: trusted`, `verdict: closed`**, because the
mesh audit asks whether the SOLID is closed and orientable — which a 1 mm cube
perfectly is. It never asks whether the solid is the one the source described.
This composes with the divergence audit's finding that `trust` (`mesh.ts:1518`)
is computed from mesher issues only and **cannot see `unsupported[]` at all**.

**Two defects, and the second is the one to fix first:** the refusal is recorded
in `unsupported[]` and the picture is drawn anyway with a verdict that outranks
it. A refusal that downgrades to a default is a wrong part; a refusal the trust
verdict cannot see is a wrong part **wearing a green**.

Fix shape: a refused expression must produce a distinct sentinel that a default
cannot swallow — not the language's own absent value — and `trust` must be a
function of the parse result as well as the mesh.

### #80 · The OpenSCAD gap, sized against the real language
✅ **DONE** — All features from the inventory are now implemented. KNOWN_REFUSED_MODULES is empty (only `hulls`, not a real OpenSCAD module). resize, echo, assert, intersection_for, list comprehensions, function literals all landed this session. Verified 2026-08-20.

🔴 **2026-08-22 correction — "implemented" was measured at the PARSE/EMIT level, and the oracle says four of the ten are not done.** When the oracle serializer was taught the new constructs (commit `d74eaad653`), the corpus cases measured: `linear_extrude`, `resize`, `offset`, `projection`, `polygon` — genuinely SAME against OpenSCAD. But:
- **`hull()`** — mesh audits **non-manifold** by the kernel's own audit (corpus case: 1711 tris vs the reference's 100). Carried as named UNDECIDED in gate `CAD1`; same defect holds `hardware/cad/lib/human_ref.scad` refused (STRICTER ledger).
- **`minkowski()`** — emits **2 triangles against OpenSCAD's 188**; audit calls the surface open. Likely-broken implementation, same UNDECIDED carry.
- **`rotate_extrude()`** — **FIXED 2026-08-27**: `$fn` and `start` are carried end-to-end (scad.ts → mesh.ts → the canon marker), and closing the revolution loop surfaced two deeper defects the open mesh had hidden — a missing last→first strip on implicitly-closed outlines, and an INWARD-wound surface (the corpus torus measured volume −1720.1166 against OpenSCAD's +1720.1165; body strips and both caps all pointed at the axis). The corpus case now reads SAME on tree and solid. Struck claim kept for the record: ~~`GroupNode.rotateExtrude` carries only `{angle}`; the parser drops `$fn`~~. **`linear_extrude()` grew a sibling fix the same day:** `twist`/`scale` were accepted and silently IGNORED — a straight extrusion of a twisted design is the plausible-looking wrong part this lane exists to refuse, so those calls are now refused by name and emit nothing.
- **`polyhedron()`** — re-orients inward-wound faces outward; OpenSCAD exports verbatim (signed volume −266.67 vs our +266.67). Same shape, opposite orientation — and orientation is what a CAM normal is. DIVERGES by name.
- **`text()`** — parses (trees agree) but `mesh.ts` still refuses it. STRICTER-ledgered.
The standing rule applies: these claims are now checked against the oracle's verdicts, not against the row above.
`docs/openscad-feature-inventory.md` — OpenSCAD 2026.08.07 as the primary source,
~40 probes, plus a node harness running the SAME source through both engines and
comparing vertex sets, triangle counts and signed-tetrahedron volumes.

**The credit side, measured rather than assumed:** where our subset exists it is
**numerically identical** — `sphere(3)` and `cylinder($fn=9)` give byte-identical
sorted vertex sets and triangle counts, and boolean volumes match OpenSCAD's
Manifold backend to 4 dp on union, difference, the flush-face case `mesh.ts`'s
own header warns about, and a curved intersection. All 18 entries in
`KNOWN_REFUSED_MODULES` were confirmed to actually fire.

**Six tiers.** Tier 0 is correctness — the silent wrong parts in `#78`/`#79`,
about a day, and not optional. 🔴 **Tier 1 is a 2D kernel plus `linear_extrude` /
`rotate_extrude`, and it is the tier that decides whether this tab is useful to
THIS lane at all**: `2bee.cnc` consumes 2D outlines, so *"hand geometry straight
to the CNC tab"* (`#12` step 5) is unreachable without it. `hull()` is days.
`minkowski()` should stay refused. Text and fonts are long tail.

**The honest headline, and it is not close:** this cannot be called an
OpenSCAD-alike today, and Tier 0 does not change that. Tier 1 plus the
`children()` / functions / list-comprehension slice is the minimum before the
phrase is defensible outward.

⚠ **Stale refusal REASONS, separate from the refusals themselves:**
`intersection_for`, `projection`, `render`, `color`, `multmatrix` and `resize`
all say *"needs a geometry kernel"* — written before `mesh.ts` existed. `color`
and `render` are pass-throughs needing nothing at all. A refusal giving a reason
that stopped being true reads as a bigger gap than we have.

⚠ **Two docs-vs-binary disagreements, recorded not resolved:** the wiki shows
`linear_extrude(center = true)` and the binary defaults it **false**; the
cheatsheet still lists `assign()`, which the binary has **removed**. Where they
disagree the binary is the fact.

**Next, and cheap:** run `parseScad` over every `.scad` in `hardware/cad/` and
count refusals per file. Half an hour, and it reorders these tiers by our own
geometry instead of by the language's shape.

### #81 · Move the show/hide into the sidebar, beside the thing each one hides
✅ **DONE** — `SectionEye` component in section headers; per-section eyes via `eye=` prop; global "all" eye above Machine; viewport chip column is now reporting-only. Verified 2026-08-20.
Founder 2026-08-11: *"Instead of having the hide/show on the top of the 3d what
about put it into the left sidebar (Machine — hide/show; Spoilboard hide/show;
Workpiece … etc) like a small eye icon? … for all under operation have all the
stages of the routing, final is under verification?"*

The toggles live in an overlay chip column on the canvas (`Viewport.tsx:400`
`LAYERS`, rendered around `:4733`). The proposal puts each one next to the panel
that owns the object — which is right: a control belongs beside the thing it acts
on, and the chip row has grown to a dozen chips that say nothing about what owns
what.

Proposed mapping, to be checked against the code rather than assumed:

| section | layers |
|---|---|
| Machine | `travel`, `touch` (the plate is configured in this section) |
| Spoilboard | `spoilboard` (and its bare-reach shading) |
| Workpiece | `workpiece`, `walls` |
| Drawing | `loaded` |
| Work holding | `clamps` |
| Tooling | `tool` |
| **Operation** | the routing stages — `cut`, `tab`, `drill`, `rapid`, `change`, `probe` |
| **Verification** | `result` |

🔴 **The rule that must survive the move.** `Viewport.tsx:1891` builds `liveLayers`
so that **a layer the scene does not contain is not offered at all** — no chip for
a move class the program lacks, none for a cutter with no diameter. That is this
lane's dead-control rule in force. An eye rendered on every section header
unconditionally would break it: an eye that toggles nothing is worse than no eye,
because it reads as *"this is hidden"* rather than *"there is none"*.

⚠ **Sections collapse, and one of them is collapsed by default.** `Verification`
is `defaultOpen={false}`, so an eye placed inside the section body is unreachable
in the state the app starts in. The eye belongs **on the section header**, visible
and operable while the section is shut.

⚠ **`hiddenLayers` currently drives an on-canvas indicator** — *"N of M view layers
hidden"* (`Viewport.tsx:5096`). Keep it, whatever happens to the chips. Once the
toggles are dispersed into eight collapsible panels, **a hidden layer is much
easier to forget**, so the one place that counts them all matters more after this
change, not less.

⚠ **Per-OPERATION toggles are not possible yet.** The founder's *"all the stages of
the routing"* reads as the move kinds, which is what the data supports today.
Toggling `pocket-1` separately from `pocket-2` needs the per-move operation name
that is being plumbed through the core now (`#70`). Do the kinds; say plainly that
the per-operation split is waiting on that, rather than shipping a control that
groups by something it cannot see.

### #82 · The oracle: measure the subset against the real binary, and one fix unlocks 36 files
✅ **DONE** — Oracle harness operational with 87-case corpus. `refuse_minkowski` entry removed (now implemented). `color()` was the 198-of-360 fix that unlocked real hive files. Verified 2026-08-20.
`tools/scad_oracle/` — runs a `.scad` through **real OpenSCAD 2026.08.07** and
through ours, and compares **twice**: the evaluated CSG tree (`-o .csg`, which is
what the language MEANS after variables, modules, `for` and `$fn` resolve) and
the solid (volume, area, bbox, centroid from the STL). Reproduced independently
before filing: `SAME 39 · REFUSED 19 · DIVERGES 5 · PENDING 0`.

**Tolerance `1e-5`, derived and then tested rather than fitted.** Tessellation
error is **common mode and cancels** — `mesh.ts`'s `fragments()` is a port of
OpenSCAD's own `get_fragments_from_r` — so the real term is float32, and it was
**measured**: the harness rounds the *oracle's* mesh through float32 and
recomputes. Worst floor `9.04e-8`, smallest real defect `5.93e-5`. Replaying at
`1e-6`/`3e-6`/`1e-5`/`3e-5` gives identical verdicts; at `1e-4` a real finding
disappears. A case whose own floor reaches the tolerance is **PENDING**, never
absorbed.

**Three plants, each aimed at ONE leg**, so the legs are proved independently:
`mesh-scale` fires 35 and leaves 28; `tree-fa` fires 16 and leaves 47 with the
clean single-leg row *TREE differs / MESH same*; `drop-child` fires 8. The
harness prints its ✅ only when `fired > 0 && unchanged > 0 && wrong == 0` — so
"the plant did not turn everything red" is asserted by the tool, not by a person.
Missing binary → INCOMPLETE exit 3. Timeout → INCOMPLETE exit 3. Missing Node
flag → exit 2 with the reason, **no fallback**.

#### 🔴 The number that should decide what gets fixed first

Against `hardware/cad/` — **68 files** (⚠ not the 41 I told the agent; 6 top-level
+ 62 under `lib/`):

```
SAME 14  (all 14 empty-on-both-sides)   REFUSED 50   DIVERGES 3   ERROR 1
```

**Zero of 68 produce a solid we agree with.** Only 3 even reached the mesh leg.

**360 refusal sites, and `color()` is 198 of them, across 36 files.** It is a
pass-through that needs no geometry at all — and because a refused node takes its
**subtree** with it, `color()` alone is deleting the models. It also causes all
three divergences. ⇒ **`color()` is the single highest-leverage fix in the CAD
tab**, ahead of every language feature. Then user functions (99),
`is_undef()` (26), `include`/`use` (26).

#### The five corpus divergences
- 🔴 `edge_modifier_root` — `!cube(); sphere();` renders **the cube** in OpenSCAD
  and **the sphere** here. Not a missing feature: **the opposite object.**
- 🔴 `partial_fa_fs_global` — `$fa`/`$fs` as variables are **not refused at all**.
- 🔴 `partial_fa_fs_args` — refused by name, sphere still emitted at default
  tessellation.
- 🔴 `partial_rotate_axis_angle` — refused by name, subtree kept **unrotated**.
  Volume and area agree to `1.6e-16`; **only the tree and bbox catch it.** This
  case alone is why the comparison is not volume-only.
- 🔴 `fn_clamped` — our `MAX_FN=256` against a source `$fn=400`.

✅ And the reassuring one: the **coplanar-face `difference`** — the failure mode
`mesh.ts`'s header warns about hardest — agreed to `1.5e-16`.

#### Not done
`gates/slicer_gate_check.mjs` untouched. The README proposes gate **`CAD1`** with
its contract, and argues `--hardware` must be wired as **a tracked number that
fails on getting worse**, not pass/fail: it is 9 known non-regressions today, and
a permanently-red gate stops being read.

⚠ **Two mechanisms for one problem, to converge:** `tools/scad_oracle/` runs our
`.ts` under Node via `--experimental-transform-types`; `web/tests/` (landed the
same day) does it with an esbuild resolve hook. Pick one.

### #83 · Machine, spoilboard, work-holding and tooling get picked from what we own
Founder 2026-08-11: *"in machine, spoilboard, Work Holding, Tooling I should able
to select what I have in inventory"*. Routed by `ceo`
(`handover/2bee_app/2026-08-11-ceo-FOUNDER-…-picked-from-inventory.md`).

**This is a safety change, and the argument is already in this lane's own record.**
The worst finding this week was the keepout sampling move **endpoints** while the
cutter travels a **line** — a 6 mm cutter driveable through a 40 mm steel clamp at
full depth, program emitted, verified clean, downloadable. 🔴 **That clamp's
geometry came from a field a human typed.** An inventory-backed picker is the same
class of fix: *it removes a way for the program to be right about the wrong world.*

🔴 **Where "what I have" comes from is NOT this lane's to invent.** `ceo`'s
constraint, and it is the right one: *a picker backed by a stale list is worse than
a free-text field, because it looks authoritative.* Dispatched rather than designed
around:
- **`bom`** — cutters and collets. Per cutter: diameter, flutes, **cutting length**
  (the app already refuses a job deeper than it), overall length, shank, coating.
- **`ops`** — the machine, the spoilboard and the work-holding hardware; all three
  are shop-floor facts they run. Asked for clamp **height above the board**
  specifically, because that is what the cutter collides with.
  ⚠ Asked rather than assumed on purpose: this app once shipped three
  work-holding presets **invented in this lane** with plausible numbers and no
  provenance, which is why `docs/workholding-research.md` exists.

**The shape I proposed to both, so one of them can tell me it is wrong:** the app
keeps its **catalogue** (sourced definitions, generic, AGPL, other shops use it)
and gains an **ownership layer** on top — which catalogue entries this shop holds,
plus shop-specific ones. ⇒ **The app does not own the inventory fact, it IMPORTS
it**, shows where it came from and how old it is, and refuses to guess when it is
absent. One source of truth, and the app can say *"this list is from 2026-08-11"*
rather than implying it is current. ⚠ The app runs **in a browser with no server**,
so it cannot read Neon directly — a file is the only route.

**What ships regardless of their answers, because it is true today:**
- 🔴 **An empty inventory is VISIBLE, never silent.** No fallback to a default
  machine, board or tool. *A default that looks like a selection is exactly the
  problem being removed.*
- 🔴 **A selected item that no longer exists FAILS**, and does not re-resolve to
  something similar. Same reasoning as the `AGPL` gate keying on the known-dead
  link rather than on the presence of any link.
- Scope is **subtractive CNC only**. Not a general asset register.

### #84 · The dry-run warning comes off the footer, and the run tab owes it back
✅ **DONE** — Warning removed from footer. Run tab implements the rung ladder (connect → jog → home → air-cut → coupon → ply). Verified 2026-08-20.
Founder 2026-08-11: *"remove this: Never run a program that has not been dry-run on
the machine. this will be part of the operation tab"*.

Removed from `App.tsx:5815`. The reasoning is right — the dry run stops being
advice and becomes something the app does, as a rung on `#76`: connect → jog →
home → **air-cut above the work** → coupon → ply.

⚠ **Recorded because it is a window, not because it is a disagreement.** The
sentence goes now and the tab that makes it real does not exist yet, so for the
period between them the app says nothing on the subject at all. That is acceptable
only if `#76` actually lands. **If `#76` is dropped or deferred indefinitely, this
line needs to come back** — a removed warning whose replacement never shipped is
the quietest kind of regression, and nothing in the tree would remind us.

### #85 · 🔴 P0 — the Z probe seeks an ABSOLUTE coordinate using a number that is a TRAVEL
✅ **DONE** (`74685f688a`) — Z probes wrapped in `G91`/`G90`; modal walk test asserts every `G38.2` is issued in incremental mode; 4 negative controls (planted absolute, arc-mode, arc-mode-back, comment-discussed). Verified 2026-08-20.

Found while designing the run tab (`docs/design-76-run-tab.md`, F1). **I verified it
at the emitted program before filing**, not from the report.

`target/probe-gate/xyz-front-left.nc`, as the post actually writes it:

```
 8: G17 G21 G90 G54 G94 G40      ← absolute
18: G38.2 Z-30.000 F200.0        ← still G90.  -30 is machine.probe_max_mm
19: G91 … 21: G90
22: G38.2 Z-4.000  F25.0         ← still G90.  -4 is probe_retract_mm * 2
30: G91
31: G38.2 X43.000 F200.0         ← G91. the SAME class of quantity, as a travel
46: G91
47: G38.2 Y43.000 F200.0         ← G91.
```

`core/src/types.rs:740` — `probe_max_mm: 30.0`, `probe_retract_mm: 2.0`. Both are
**distances**. `post_grblhal.rs:625/633` write them as **absolute work-coordinate
targets**; `:692–695` write the X/Y equivalents inside `G91`, as travels. 🔴 **The
same quantity is used two different ways in one file, and the Z arm is the wrong
one.** grblHAL applies distance mode to probing motion like any other motion
(`gcode.c`, *"the rest of the explicit axis commands treat the axis values as the
traditional target position with … distance modes applied. This includes the
motion mode commands."*).

**What it does at a machine.** It is correct **only when the work-Z datum is
already approximately right — and the probe is the thing that makes it right.**
With a stale `G54` Z, the slow re-probe at line 22 becomes a move **upward, away
from the plate** → `ALARM:5` (probe fail), datum unset, machine locked. Or
start == target → `error:33`. **It has never been run at a controller, which is the
only reason this is not already a field defect.**

⚠ **No test catches it, and the reason is instructive:** every probe assertion in
the suite reads the `G10 L20` **datum values** and never the **frame a `G38.2` was
issued in**. The tests check the number and not the sentence it sits in.

**Fix + the assertion:** the Z probes go inside `G91` like their X/Y siblings, and
a gate branch asserts **on the emitted text** that every `G38.2` is preceded by an
active `G91`. Watch it go red first.

⚠ Related and NOT asserted, because I could not derive it: `z_offset_mm` is added
to `G0 Z<safe_z>` and `G0 Z<side_z>` but to **neither** the `G38.2 Z` nor the
`G10 L20 P1 Z` (design doc F2). Most of it dissolves once F1 is fixed; the `G10`
case is genuinely open.

### #86 · 🔴 `tools/controller_probe.py` corrupts the evidence gate `CTRL` rests on
✅ **DONE** — `$X` failure triggers soft-reset + retry + exit 3; alarm poisoning detected via `$I` probe + `break`; transcript records `alarm_poisoned: true`. Verified 2026-08-20.
Design doc F6/F7. Two defects, and they fail in **opposite** directions, so a
transcript is wrong twice over.

1. **`--unlock` believes `$X` clears the boot alarm.** On grblHAL `$X` is
   **refused with `error:46` while homing is required** (`system.c`), and after
   that every g-code line returns `error:9`. ⇒ **A transcript that reads as total
   dialect failure is actually one un-homed machine.**
2. **The script deliberately continues past the first rejection** — but grblHAL
   **poisons every subsequent line after an error** (wiki *Changes-from-grbl-1.1*,
   confirmed in `protocol.c`). ⇒ **The error list is one real finding plus N
   copies of it.**

**Fix both before the next `CTRL` transcript is taken**, or we will be reading a
document that overstates the failures and mis-attributes their cause. ⚠ This is
the *evidence-gathering* tool, not the gate — the failure mode is a confident
wrong reading, which is worse than no reading.

⚠ **Third item, routed rather than acted on:** `CTRL`'s stated premise that canned
cycles are a compile option answering `error:20` **may be stale** — grblHAL master
appears to parse `G81`–`G89` unconditionally. That is a **controller** fact read
off one tree on one day, so it goes to `pcb` rather than weakening `G9`/`CTRL` on
this lane's reading.

### #87 · 🔴 Z0 at the workpiece BOTTOM (the spoilboard's top) — and the switch for it is inert
✅ **DONE** — `ZDatum` enum replaces `z_zero_at_top` bool; `stock.z_datum.emit_z()` consumed by post-processor on every emitted Z word; `fixture.rs` uses `stock.z_datum.through_z_mm()` for severed-cell detection. Old bool no longer compiles. Verified 2026-08-20.

Founder 2026-08-11: *"0Z should be on the bottom of the workpiece, top of the
spoilboard"*.

**Measured before writing this.** The setting already exists and travels the whole
way — and **nothing acts on it**:

```
core/src/types.rs:1017   pub z_zero_at_top: bool      (default TRUE, :1038)
web/src/App.tsx:1855     z_zero_at_top: zZeroTop      ← the browser SENDS it
core/src/fixtures.rs:1389/1616                        ← the config CARRIES it
core/src/fixture.rs:2534 if !stock.z_zero_at_top { … "reaches no code in the
                            planner or the post today" }
```

The **only** reader is a warning that says it has no readers. So an operator can
set this control, it reaches the core intact, and **every emitted program is still
Z0-at-top.** That is gate `G11`'s class exactly — a setting that changes nothing —
and it is now a founder instruction rather than a latent defect.

#### Why a shop wants the bottom, which is the thing to get right

Zeroing at the **spoilboard's top face** makes a through-cut target **Z0 exactly**,
so the depth of the last pass **stops depending on the workpiece's actual
thickness**. Sheet goods vary — nominal 18 mm ply is routinely 17.2–18.4 — and
with Z0 at the top that variation lands directly on either *"didn't cut through"*
or *"cut into the board"*. That is the entire benefit and it is a real one.

🔴 **But it is only delivered if the Z datum is actually established against the
board.** If the operator probes the **workpiece top** and the app subtracts a
**declared** thickness to get the bottom, the thickness error is back — with the
added hazard that it now looks solved. So this change is not a sign flip in the
planner; it reaches:
- **the probe** (`post_grblhal.rs`) — what surface is the plate on, and what does
  `G10 L20 P1 Z` then set? ⚠ Interacts with `#85`, the open P0 in the same
  emitter, which must land first.
- **the toolpath** — pass depths and the final pass's target.
- **the simulation** — `sim.rs` computes `floor = -(stock_thickness + allowance)`
  and `through_z = -stock.thickness_mm`, both written in a top-datum frame.
- 🔴 **`Spoilboard::top_face_z_mm()`, landed today**, returns `-stock_thickness`
  *because* Z0 is the top. **Under this instruction that function's answer becomes
  `0`.** It is the one place the stack's height is stated, which is exactly why it
  must be changed there and nowhere else.

⚠ **And the two datums must never both be live.** A program half-planned in one
frame and half in the other is a cutter driven a full workpiece thickness wrong,
in whichever direction is worse. Whatever ships, a single named function must
answer *"where is Z0"* and everything else must ask it.

⚠ **Do not change the default silently.** The founder has stated which he wants;
that is a ruling and it is recorded here. But every saved workpiece, session blob
and gate fixture in the tree was written under the old default, and a restored
`true` that used to mean nothing would start meaning something.

### #88 · 🔴 A spoilboard follows you onto a different machine and reports "covers the whole reach"
✅ **DONE** — `readSpoilboard` has production callers via `spoilboardForMachine` (machine-change and session-restore paths in `App.tsx`, `useSpoilboardState.ts`). Travel fingerprint drops position on mismatch. Verified 2026-08-20.

`docs/audit/2026-08-11-spoilboard-vs-machine.md`. **I verified the two headline
findings myself before filing.**

**1. The machine picker does not touch the board.** `App.tsx`'s preset `onChange`
sets `setTravelX/Y/Z` and returns — it touches neither the corner, the size, nor
the assumed/entered flag. Confirmed: **zero** spoilboard references in that
handler. Measured through the browser's own wasm: a 2400×1200 board auto-fitted
for a 1250×670 machine (corner `-575,-265`) reports `bare:[0,0,0,0]`,
`checked:true`, `past:0` on a 6090 — which the panel renders as *"none — the board
covers the whole reach."* The honest 6090 declaration on the same job gives
**`past: 2204`**. ⇒ **2204 frame-strike cells become a silent zero on one preset
click.**

⚠ **The dangerous permutation is `entered`, not `assumed`** — a corner a human
measured on machine A stays green on machine B, and provenance says it was
measured.

⚠ **And the guard already exists, unarmed.** `store.ts::readSpoilboard` implements
exactly the right check — a travel fingerprint that drops the position **by name**
on a mismatch — with **zero production callers**: a definition, four test call
sites, and a `spoilboards` store that is never written or read. *A guard armed
only by its own test.*

**2. The position limb says CHECKED / 0 when it tested nothing.** Three `ran()`
definitions in `core/src/sim.rs`, and the middle one is the odd one out:

```
:565  cells_tested > 0                                   (uncut)
:652  self.declared                                      (spoilboard POSITION) 🔴
:834  underside_z_mm.is_some() && cells_tested > 0       (spoilboard DEPTH)
```

Its sibling twenty lines below carries a comment explaining that a board the
workpiece does not overlap *"would otherwise report a clean zero"* — the exact
defect, correctly reasoned, **in the same file, on both sides of it**. One config
through both limbs: depth returns `board-depth-unknown` and names the frame
mismatch; position returns `checked:true, past:0, pending:null`, silently.

**3. Nothing compares the board to the travel envelope at all.** `resolve()` takes
no machine; `faults()` checks non-finite and zero area and stops. A board at
`x:2000` on a 600 mm machine, and one `1e13` mm across, both install
`checked:true` with no note. **A corner typo has no detector anywhere.**

Also from the same audit: a **measured** board cannot declare a thickness
(`SpoilboardCfg` has six fields and `deny_unknown_fields`), so the new depth limb
is structurally dead for the declaration form the app itself says most operators
use — safe direction, permanent PENDING. Two arithmetic defects in `bare_reach`
(unclamped `plus_*` giving 5500 mm bare on a 600 mm axis; all-zeros on zero travel
rendering as the green *"covers the whole reach"*). And two doc comments state the
Z residual's direction **backwards**.

✅ Probed and found clean, so nobody re-derives them: the both-forms refusal across
nine configs, verified at the echo AND the viewport branch AND the pending note;
the no-default rule in core, JSON and wasm; unknown-id non-substitution; the
catalogue fit verdict, where `UNKNOWN` is a constant with no branch that could
green it; auto-fit, which cannot place a board partly outside travel; and
`travel_z_mm`, which correctly has no relationship to the board.

### #89 · 🔴 The spoilboard declaration does not survive a refresh
✅ **DONE** — `SessionValues` carries 8 spoilboard fields (`spoilboardId`, `spoilboardX`, `spoilboardY`, `spoilboardSizeX`, `spoilboardSizeY`, `spoilboardThickness`, `spoilboardName`, `spoilboardPos`, `spoilboardTravels`) with validation rules; auto-included in save/restore via `SESSION_KEYS`. Verified 2026-08-20.

Found by the e2e agent, 2026-08-11, while writing the storage tests.

**`SessionValues` (`web/src/store.ts`) carries no spoilboard field at all** — not
the catalogue id, not the corner, not the size, not the assumed/entered flag. So
a reload silently reverts the board to **undeclared**.

🔴 **This is not a convenience defect.** It contradicts a standing founder
requirement — *"when I refresh the browser all config should stay"* — and the
field it drops is **safety-bearing**: with no board declared, `sim` reports
`spoilboard_position_checked: false` and every below-the-workpiece cut is judged
on **depth alone**, so *over the sacrificial board* and *into the machine frame*
read identically. The operator declared a board, refreshed, and silently lost the
distinction.

⚠ It fails in the **safe** direction — reverting to UNCHECKED costs a false
pending, not a false green — which is exactly why it will not be noticed by
anyone reading the panel. **The louder half is that the founder was told this
already worked.**

The spoilboard agent wrote the fields out precisely: `spoilboardId`,
`spoilboardX`, `spoilboardY`, `spoilboardSizeX`, `spoilboardSizeY`,
`spoilboardName` (all `string`, `''` = not entered — **never numbers**, because
`''` and `'0'` are different answers), plus `spoilboardPos: 'assumed' | 'entered'`
where **a missing key must restore as `'assumed'`**, never `'entered'`.

⚠ **And do not restore the corner blindly** — `#88` is the finding that a board
follows you onto a different machine. The restore path is the second door into
that defect, and `store.ts::readSpoilboard` already has the travel-fingerprint
guard written and **unarmed**. Fix both with the same call.

### #90 · The browser still charges 60s per tool change while the core charges 120s
✅ **DONE** — `const TOOL_CHANGE_SECONDS = 60` deleted; browser reads `report.tool_change_seconds` from the core. Regression test in `config-wiring.test.ts` asserts the literal does not reappear. Verified 2026-08-20.

Opened deliberately by the `#66`-adjacent tool-change work, 2026-08-11, and
recorded here so it is closed rather than discovered.

`core` now charges `Machine::tool_change_seconds`, defaulting to
`DEFAULT_TOOL_CHANGE_SECONDS = 120`. `web/src/App.tsx:320` still holds
`const TOOL_CHANGE_SECONDS = 60` — **a literal whose own doc comment says it is a
copy of the core constant.** They agreed until this commit. They do not now.

⚠ **The playback clock under-reads by 60 s per tool change until `App.tsx` is
wired.** It is **visible, not silent**: the drift readout compares the playback
total against `estimated_seconds` and will show it — which is exactly what that
control's own comment promised would happen, arriving on schedule.

**The fix is a deletion, not a re-sync.** `App.tsx` reads
`report.tool_change_seconds` — the number the core actually charged — and the
literal goes. 🔴 **`?? 0` on absence, never `?? 120`**: absent means no job ran or
an older core, and a guessed rate is the thing being removed. Zero must not be
quiet either — with changes present and no rate on the report, say the clock could
not charge operator time, on the same footing as the existing `untimed` counter.

**Three stale prose copies to sweep with it**, each in a file that was assigned
elsewhere at the time:
- `core/src/optimise.rs:42` — *"pays a minute of operator time plus a Z
  re-reference per extra change"*. A third copy of a number that has moved.
- `TODO.md:2270` — *"A tool change is charged `TOOL_CHANGE_SECONDS`"*. That
  identifier no longer exists.
- 🔴 `docs/audit/2026-08-10-ui-honesty.md:202` row 1.5 records the App.tsx copy as
  🟡 *"verified still equal today"*. **It is no longer equal** — which makes that
  row the exact kind of stale green the audit was written about.

### #91 · Use the workpiece edge instead of cutting it — an Operation toggle
Founder 2026-08-10, asking first *"when the workpiece and the final object line up
on the side, is there any cutting needed?"* then *"have an option in the Operation
to turn this on/off?"*.

**The machining answer is no cut is needed** — registering off a straight stock
edge and letting it be the part edge is a real technique. It costs three things,
and the toggle exists so the operator accepts them knowingly: the edge must
actually be straight and square, **the part's dimension on that side becomes the
sheet supplier's tolerance**, and the datum on that side becomes *wherever the
sheet actually is* rather than where it was probed.

**Today the app plans the profile anyway**, with the cutter centre one radius
**outside** the outline — so the pass runs half a diameter past the workpiece,
over whatever is under it. `core/src/job.rs:1404` warns (*"the program reaches
N mm PAST THE EDGE of the workpiece … whatever is out there was NOT simulated"*),
which is honest, but a warning the operator dismisses every time stops being a
warning.

#### 🔴 Three decisions that ship WITH the toggle, not after it

1. **The predicate needs a declared tolerance, and it must be visible.** "Coincides
   with the workpiece edge" is not a boolean over floats. 🔴 **The dangerous case
   is the near-miss**: an outline 0.2 mm inside the workpiece, skipped, leaves a
   0.2 mm ribbon of material holding the part — worse than either cutting it or
   leaving it properly. So the tolerance is a **declared number the operator can
   see and change**, not a constant, and an edge inside it by *more* than that is
   cut normally.
2. **The decision is made AFTER placement, never at import.** A drawing is placed
   with an offset and a rotation, and both can move after the outline is read. An
   edge that was flush at import and is interior after a drag would be silently
   left uncut — an unmachined interior edge, which is the failure that looks like
   a finished part until it is measured.
3. 🔴 **A skipped edge is REPORTED, per edge, in the emitted program and on the
   panel.** *"3 of 4 outer edges cut; the 4th was skipped — it lies on the
   workpiece edge within 0.1 mm."* An edge silently not cut is uncut material that
   looks intended, and `uncut` cannot see it: that counter only fires on a region
   declared as *must be cleared*.

#### The default is OFF, and that is not timidity

ON changes **what geometry gets cut** from what the drawing says. A default that
silently alters the emitted shape is the wrong kind of default — the drawing is
the operator's statement of intent, and the app should need permission to cut less
than it.

#### Two interactions, one of them a genuine gain

🔴 **CORRECTED 2026-08-10 BY MEASUREMENT — I wrote the opposite here and it was
false in the THROWING direction.** This item claimed *"restraint improves — a
skipped edge means the part is still joined to the stock, so it needs no tab
there."* **A skipped edge lies on the workpiece's OUTER boundary. There is no stock
on the far side to hold anything.** Cutting the remaining edges separates the part
exactly as a full profile would. Measured through `check_hold_down` on the emitted
program — a 200x120 part, two edges skipped, tabs suppressed — **two free pieces,
11748mm2 and 10143mm2, each centroid outside the clamp-contact polygon.** Tabs are
still needed and `auto_tabs` still runs on open chains. Left visible rather than
deleted: a wrong ✅ in a spec is how a hazard gets built in on purpose.

⚠ **The past-the-edge warning becomes meaningful again.** Once the flush edges are
skipped deliberately, a remaining past-the-edge finding is a real one rather than
the routine consequence of a profile on a boundary.

#### Shape of the work
`core/src/toolpath.rs` plans a profile around a **closed** contour. Open contours
already exist in the core — `engrave.rs` cuts text on-line — so the machinery is
there; profiling does not use it. The likely change is that a profile whose edges
are partly skipped becomes an **open** path, which also means lead-in/lead-out and
tab placement need to cope with ends rather than a loop.

⚠ **Job-level toggle now, per-edge later.** The founder asked for one switch in
`Operation` and that is the right first cut. But the honest end state is per-edge,
because a part can legitimately want its bottom edge from the stock and its top
edge machined. Do not build the job-level version in a way that makes the per-edge
version a rewrite.

### #92 · 🔴 The cutting parameters have no machine term at all
✅ **DONE** — `MachineClass` enum (`Desktop | Gantry | Industrial`) added to `types.rs` with `doc_ratio_multiplier()` (Desktop=0.5, Gantry/Industrial=1.0). Field `machine_class` on `Machine` struct, serialized via `MachineCfg.machine_class` (string, `"desktop"`/`"gantry"`/`"industrial"`). `max_doc_ratio()` now takes `MachineClass` and multiplies the material base ratio. Recommendation text mentions class when not Gantry. Default=Gantry preserves existing behavior. Multipliers are conservative — raising Industrial requires coupon data. Verified 2026-08-20.

`docs/materials-research.md`, re-sourced 2026-08-10. **I verified the two headline
mechanisms myself.**

`Material::max_doc_ratio()` (`core/src/tools.rs:637`) takes **only the material**.
There is no machine term anywhere in the cutting parameters — and it is measurable:
the **1250×670 C-Beam preset and the 600×900 preset emit a byte-identical
program**, and the shipped **`Desktop 3018` gets the same 3 mm full-width slot** as
a 2.2 kW machine.

⚠ **This is `#38`'s "sourced to a machine we do not have", generalised.** The limit
on depth of cut is rigidity and chip evacuation, not the cutter's rating — so a
figure read off an industrial router's table and applied unchanged to a desktop
frame is not conservative, it is unrelated.

Two counter-sources reconcile at **chip area**, which is the honest axis: ToolGrit
prints *"DOC: up to full thickness for through-cuts"* on the same page as its
0.5×D slotting rule, and the OpenBuilds/Carbide chart implies 1.0×D. That chart's
three wood rows land at **0.26–0.31 mm²** and our post-#38 ⌀6 plywood cut is
**0.30 mm²** — which also gives `decision-38` §B3's invented 1.0 mm² cap a sourced
band for the first time.

### #93 · 🔴 The router-bit feed ceiling is handed to DRILLS
Same pass. Measured: a ⌀6 brad point emits `G98 G83 … F5760.0` at `M3 S24000`.

Onsrud's *Drill Cutting Data Recommendations* rates wood drills in **IPR against
surface speed**, gives **0.33–0.38 mm/rev at 6 mm**, and prints one wood-drilling
speed: **4,500 rpm**. We are running a drill at **24,000 rpm on a router-bit
chipload model**.

⚠ The agent **published no drill number**, deliberately — substituting one table
for another is how this class of defect started. What is needed is a drill feed
model keyed on IPR, or a refusal to plan drilling until there is one.

### #94 · `max_feed_mm_min` — my premise was half stale, and clamping is not the fix
✅ **DONE** — `chipload_in_window()` now has a production caller in `recommend.rs:684` via `chip_verdict()`, invoked in the main recommendation path. Verified 2026-08-20.

`recommend.rs:600` **does** clamp. `job.rs` does not. 🔴 **And even the clamped
door leaks** — marking operations keep their own tool and emitted `F1800` against a
declared `900`.

🔴 **More important: clamping alone would not be honest.** Measured at defaults, the
⌀12 emits `F6000` at `S24000` → **0.125 mm/tooth against that tool's own declared
minimum of 0.15**. Clamping the feed pushes the chip *further* below the window —
rubbing rather than cutting, which burns the tool and the work.

⚠ **`chipload_in_window()` exists, is tested, is re-exported from `lib.rs` — and has
no production caller.** I verified that: `feeds.rs:27`, three uses, all its own
tests. **A guard armed only by its own test**, the same shape as
`store.ts::readSpoilboard`.

The honest behaviour, from the research: clamp **in the core**, then **reduce rpm
to hold the chip** (10,000 rpm for that case, inside every window), **refuse** when
the rpm floor blocks it, and **refuse rather than silently reduce** a pinned feed.

### #95 · `rapid_mm_min` is not merely unsourced — it is unmeasurable until the machine lands
No host declares it (verified across `web/` and `wasm/`), so every browser plan is
estimated at the generic **3,000 mm/min**; the firmware default is **500**.

⚠ **The router was ordered 2026-07-22 with an ETA of 2026-09-30.** So this cannot
be measured yet, and a figure taken from a spec sheet would be exactly the
substitution this whole pass is about.

Shape: a refusal-shaped `Option<f64>` on the `tool_change_seconds` precedent. The
ask to `pcb` is **`$110`/`$111`/`$112` AND `$120`–`$122`, per axis** — one scalar
cannot express a diagonal rapid — with the controller and the date named, **after
commissioning, not from a spec sheet.**

### #96 · ~170 numbers carry no provenance, and none of our actual cutters have a table
The summary the research pass put at the top of `docs/materials-research.md`, in
its own words: **18 numbers now carry a citation — only 6 of them a published
figure for the quantity they control — and roughly 170 carry nothing.** Every
chipload in the 51-tool library bar one, all drill speeds and feeds, plunge 300,
peck 4.0, ramp 20, tabs 3×8, the hard-coded 0.45×D pocket stepover, and a uniform
8,000–24,000 rpm window applied to all 51 tools.

🔴 **And the cutters actually bought are unbranded AliExpress carbide**, so no
manufacturer table for *our* cutters exists. Every figure in Part 1 is a
substitution from a different cutter, and **the real ceiling on all of it is a
coupon `ops` has not cut.**

### #97 · 🔴 `rotate()` uses naive `Math.cos`, so a quarter turn is not exactly a quarter turn
✅ **DONE** (`0de6f72d2b`) — `sinDegrees()`/`cosDegrees()` implement OpenSCAD's reduce-and-complement algorithm; `rotationMatrixDegrees` uses them for all 6 trig calls. Verified 2026-08-20.

Found by the oracle-harness pass, 2026-08-11, while deciding whether a numeric
difference was ours or the instrument's. **It is ours.**

`web/src/cad/mesh.ts:287-289` builds the rotation matrix with `Math.cos(deg * π/180)`.
At 90° that is **`6.12323e-17`**, not `0`. **OpenSCAD's degree trig returns exact
`0` and `±1` at multiples of 90°** — and the agent proved that is a real property
rather than print-rounding: at **89.9999°** OpenSCAD emits a genuine `1.74533e-06`,
so it is not simply printing a rounded zero.

Three real hive files differ from OpenSCAD **only** because of this —
`lib/brand_corner.scad`, `lib/inwall_m8.scad`, `inwall_cover_box.scad`.

⚠ **The harness was deliberately NOT changed to hide it.** Making `canon.mjs` do
exact quadrant trig would print a matrix **our product does not compute** — an
instrument agreeing with us by construction. And no tolerance was added, because
one wide enough to absorb this would also absorb it as a *finding*.

**Fix:** special-case exact multiples of 90° in the degree-to-matrix conversion, as
OpenSCAD does. ⚠ Note the failure is silent and cumulative: a part rotated four
times by 90° should return to its start and does not, by a hair — and every
downstream boolean inherits the error.

✅ **DONE `0de6f72d2b`** — and the item above is wrong in three places, kept
visible because each error is the more instructive half.

🔴 **"Special-case exact multiples of 90°" was the WRONG SHAPE, and the right one
is its opposite.** `src/utils/degree_trig.cc`: **OpenSCAD never asks whether a
value *is* a quadrant multiple** — no quadrant test, no snap. It reduces into
`[0,90]` by revolution and two reflections, then evaluates the **complementary**
function near zero, so `cos(90)` becomes `sin(0)` = exactly `0`. **The exactness
falls out of `sin(0)`.** ⚠ **That is the whole safety argument:** reduce-and-
complement has **no tolerance to widen**, so 89.9999° stays real. A quadrant test
with any tolerance satisfies *both properties this item asked for* — exact
quadrants, exact round trip — **while silently straightening a part the operator
drew at an angle.** It was planted; it left the round-trip test green and was
caught only by the near-quadrant assertion.

🔴 **"Every downstream boolean inherits the error" is NOT SUPPORTED — I asserted
it and it is unmeasured.** Four quarter turns move a point at 100 mm by
**2.45e-14 mm**; a `difference()` against a four-times-turned copy is
**byte-identical, 48 triangles either way. No boolean has been shown to change**,
and this is not dimensional at any scale this lane cuts. What it genuinely is: a
divergence from the oracle's evaluated tree, and the loss of an algebraic
identity a CAM kernel should have.

⚠ **The file list is wrong: the epsilon is in FOUR files and one of my three is
not among them.** `2bee_cables`, `lib/brand`, `lib/inwall_cover_box`,
`lib/inwall_m8` — and only the last two differ **first** on the epsilon.
**`lib/brand_corner.scad` is not one**; its first difference is a refusal cascade
from `use <bee_logo_2d.scad>` + `linear_extrude()`.

⚠ **Plant 1 left a test GREEN** and that is the useful line: the product-level leg
through `parseScad` + `meshScene` did not fire. `MeshPart.positions` is a
`Float32Array` (~1.2e-7 relative); the residue is ~1e-16, **nine orders below it.
This defect is structurally invisible at the product's own mesh output.**

### #100 · ⚠ The harness keeps its own `rotateM`, so no product fix can move these rows
✅ **DONE** — `canon.mjs` imports `rotationMatrixDegrees` from product's `mesh.ts`; naive `Math.cos` copy removed. Verified 2026-08-20.
Found while closing #97, and it explains why that fix moved the oracle number by
**zero — byte-identical before and after**, which is the correct outcome and
looks exactly like a fix that did nothing.

`tools/scad_oracle/canon.mjs:82` has its **own** `rotateM`, still on naive
`Math.cos`, and `sceneToCanon` (line 613) calls it to canonicalise **our** scene
tree. 🔴 **The TREE leg never asks `mesh.ts` what our rotation matrix is — it
re-derives it.** So the epsilon rows are printed **by the instrument**, about
itself.

⚠ **And #97's own caveat now cuts the other way.** That item refused to give
`canon.mjs` exact quadrant trig, on the grounds it would print a matrix *our
product does not compute*. **After the fix, the naive `rotateM` is what prints a
matrix our product does not compute** — the same sin, in the mirror. Fix by
**consuming** the product's exported `rotationMatrixDegrees`, not by porting it
again: one implementation, or the divergence returns under a new name.

### #101 · ⚠ Tessellation is still in radians, so `$fn=4` starts at `6.1e-17` not `0`
✅ **DONE** — All trig in `mesh.ts` now uses `cosDegrees`/`sinDegrees`: circle/cylinder/sphere tessellation, `rotate_extrude`, and rotation matrices. DXF/SVG import correctly uses radians (DXF degrees are explicitly converted). Verified 2026-08-20.

Named by the #97 agent and deliberately left — same defect family, separate
change, its own tessellation risk.

`mesh.ts` tessellates circles, cylinders and spheres with `Math.cos(2πj/n)`
(~lines 403–481) where OpenSCAD uses `cos_degrees` (`src/core/primitives.cc:63,
197-198, 561`). At `$fn=4` our first circle vertex is `(r·6.1e-17, r)`;
OpenSCAD's is `(0, r)`.

⚠ **This one has a reason to be more visible than #97 was.** A rotation epsilon
is one matrix; a tessellation epsilon is **every vertex of every curved
primitive**, and it lands on the silhouette where a flat should be flat. The
helpers now exist — `sinDegrees`/`cosDegrees` are exported — so it is one line
each. **Verify against the oracle before and after**, because unlike #97 this one
*can* move the number.

### #98 · 🔴 The oracle read a truncated STL as ground truth, and blamed the product
✅ **DONE** — `parseAsciiStl` checks `endsolid`, facet/endfacet count, vertex=3×facets. Truncated exports scored as PENDING. Verified 2026-08-20.
Same pass, and it is the more serious of the two.

The only integrity check on an OpenSCAD export was **`vertices % 9 === 0`**, whose
comment claimed it caught a short write. **It cannot**: an STL facet is exactly
three `vertex` lines, so a cut at **any facet boundary** passes it.

Measured: on this box — `/tmp` is a 62 GB tmpfs at **89%**, with another lane's
`openscad` running — a `--hardware` run got a **partial mesh** for `sphere(r=8)`.
The oracle read `bbox.min.z = +5.30` where ours correctly said `-7.94`, and
**`openscad` exited 0**. 🔴 **Gate `CAD1` then went red naming three innocent
cases** — `bool_union`, `bool_nested`, `prim_sphere_default_fn` — all clean and
byte-stable in isolation.

⇒ **The instrument manufactured a red about the product out of a defect in
itself**, and the three names it printed were the most plausible-looking place to
start debugging. Completeness is now asserted exactly (`endsolid` present ·
`facet` count equals `endfacet` count · vertices equal 3 × facets), with
facet-boundary, mid-facet and mid-vertex truncations all rejected and a legitimate
empty solid still accepted.

⚠ **Filed rather than closed because the environment is still the environment.**
The tmpfs is still at 89% and lanes still run `openscad` concurrently. The check
now catches it; nothing yet prevents it.

### #99 · One PENDING anywhere disarmed both CAD ratchets
✅ **DONE** — PENDING branch split per-leg (CAD1 checks corpus, CAD1H checks hardware). Both scoring chains evaluate independently. Verified 2026-08-20.
Same pass. The non-binary-PENDING branch failed `CAD1` **and** `CAD1H` from one
shared test, so a pending in the *hardware* tree reddened `CAD1` — whose contract
is the **corpus**, which had zero pendings — and, worse, **both scoring chains
short-circuited before the baselines were evaluated at all.**

⇒ **Two real findings were hidden behind it**: a stale baseline entry, and the
30-against-35 gap on `CAD1H`. A gate that fails early on a shared condition stops
measuring the thing it exists for, and reports a red that names the wrong leg.

Now per-leg, and placed **last** in each chain — after the regression limbs and
before nothing, because the ratchet-down limb is what the self-plant drives.

---

# 2026-08-11 — open items from the day's sweep

**Everything below is OPEN.** Written from measurements, not impressions — each item
names what was measured and by which commit, so nobody re-derives it. Items that were
found *and fixed* the same day are not here; they are in the git log.

⚠ **CORRECTED 2026-08-27 — this line read "Read the three FORK items first (#102,
#114, #116). They are blocked on a decision, not on effort, and one of them is
safety-bearing." ALL THREE ARE RESOLVED**, and each still wears a 🔴 FORK heading
directly above its own ✅ — the same shape as the #12 index row, three times.

* **#102** — the save-target refusal shipped; `saveTargetRefusal` is in `App.tsx`
  and both directions of the rule are now guarded by `web/e2e/save-target.spec.ts`
  (which did not exist when the fork was written, and finding that is what
  uncovered the defect in the refusal's own remedy — see #130).
* **#114** — the board is not running Marlin. See #16: grblHAL 1.1f answered on
  2026-08-20 and the transcript holds a real `$$`.
* **#116** — the founder's 2026-08-14 DEFER ruling took the second branch; the
  gate carries `CAD1H_UNDECIDED_KNOWN` and the baseline has ratcheted since.

**The headings are left as they were.** Retitling them would erase the record
that a fork was open; what was wrong was the POINTER telling a new reader to
start there, and that is what is corrected.

## 🔴 #102 · FORK · `Save as` saves the panel, not the row you are looking at
✅ **DONE** — Machine and workpiece `onSaveAs` callbacks now refuse when the previewed row doesn't match the selected/loaded object, matching the spoilboard picker's `saveTargetRefusal` pattern. Refusal message names both objects. `loadedMachine`/`loadedWorkpiece` added to Zustand store destructure. Verified 2026-08-20.

Found by `a4e5ff68be` while fixing something else. **Measured in real Chrome:** preview
`Desktop 3018` (300 × 180), press `Save as` → the record written is **600 × 900**, the
*ticked* machine's travels, under the name `Desktop 3018`. `App.tsx`'s call site
discards both `previewItem` and `draft`.

🔴 **A saved machine whose travel envelope is not the machine it is named after** — and
travel is what refuses a move off the table. **Selecting it passes a 600 × 900 program
to a 300 × 180 machine.**

**The fork, and it is genuinely ambiguous:** does `Save as` mean *the panel as
configured*, or *this row plus my edits*? The picker's own placeholder does not say.
⚠ **Same shape for workpieces and drawings** — fix all three together or none.

## 🔴 #103 · The core's two tool doors are two planners
✅ **DONE** (`4bcbf6d73f`) — Singular `tool_id` now prepended to `tool_ids` set and goes through `assign_tools_from_set` → `recommend()` like any other tool. Second planner deleted, not bypassed. Set door was right in all 3 directions (46 emits-vs-refuses, 8 reverse, 12 different-program). Core test `a_single_tool_id_and_a_one_element_tool_ids_are_the_same_door` guards against re-divergence. Verified 2026-08-20.

Gate `DOOR` (`29c53ef138`) measures it: **66 of 306 (fixture × single tool) pairs
disagree** — 46 emit-vs-refuse, 8 the reverse, 12 same-verdict-different-bytes.

🔴 **There is no pair anywhere on which both doors emit and produce the same program.**
All 240 agreements are *two refusals*.

⚠ **The 12 "benign" ones are not.** `socket`/`clamped` on the 6 mm class have identical
line counts and differ only in `M3 S18000`/`F3600.0` versus `M3 S24000`/`F4800.0` —
**same cutter, same fixture, two spindle speeds depending on which field named the
tool.** A line-count comparison reads those as agreement, which is how an earlier pass
reported 19-of-60.

`540bab9d66` made the browser always send `tool_ids`. **That removed our reach to the
bad door and changed nothing in the core.** 🔴 **Establish which door is RIGHT before
collapsing onto it — agreement is not correctness.**

## #104 · Spoilboard: no save-as at all, and dimensions are not editable
✅ **DONE** — `onSaveAs`/`onSave`/`onRemoveItem` wired; `saveTargetRefusal()` handles #102 ambiguity; all 3 TODO constraints met (re-fit on edit, thickness `None`, position/depth separate). Verified 2026-08-20.
Corrected in `a4e5ff68be`: this is **not** the `Save as` defect above. The picker is a
live, correctly-counted list with **no `onSaveAs` wiring**, while a `spoilboards`
collection exists in `store.ts` that nothing writes to.

Three constraints when it is built:
- 🔴 **Re-check fit against travel after an edit.** A board that fits at selection and
  stops fitting after an edit is worse than one that never fit — the check ran and went
  stale.
- 🔴 **`thickness_mm` is `Option` and `None` is load-bearing** (`BoardDepth::Unknown`).
  An edit must not turn *not declared* into a number nobody entered.
- ⚠ **Position and depth are separate limbs.** A size edit must not silently re-assert
  position. `spoilboardForMachine`/`readSpoilboard` already carry the
  `entered`/`assumed` provenance this needs.

## #105 · Inventory: the axis exists, the operator cannot write to it
✅ **DONE** — `ownership.ts` (262 lines) implements `held`/`not-held` write axis; wired into all 4 pickers (Machine, Spoilboard, Workholding, Tool). Verified 2026-08-20.
Corrected in `a4e5ff68be`: `web/src/inventory.ts` is **1,030 lines** implementing exactly
the tri-state (`held` / `not-held` / `unchecked`, plus `unresolved`), with
`WHY_NO_DEFAULT`, two plants, and `blockFor()` keeping ownership apart from fitness. It
is **wired into all four pickers** — that is why rows read `OWNERSHIP UNCHECKED`.

**Missing: the per-row Y/no control.** Today ownership can only arrive from a file.
⇒ This is *exposing* what exists, not inventing it.

⚠ **When it lands, keep it away from `Fixturing::confirmed_clear`** — that is an
attestation about the bed *today* and `App.tsx` deliberately refuses to restore it.
Owning a clamp is not the bed being clear.

## #106 · `report.notes` is duplicated by construction — and there is no lossless fix
✅ **DONE (blocked on founder)** — `notesShownElsewhere` (App.tsx:474) deduplicates for display. Spoilboard badge exists. ⚠ `ui-text-sweep.test.ts` §3.1–3.3 explicitly prevents filtering the Notes panel without founder approval. Infrastructure ready; decision pending. Verified 2026-08-20.
Four panels *filter* `report.notes` for their subset; **`Notes and warnings` renders the
whole array again**, so the spoilboard PENDING sentence lands **three times**.

🔴 **`bc50e64ab1` refused to fix it, correctly.** Section collapse is **sticky**, a shut
section renders nothing, and `panel-spoilboard` has **no badge** — so filtering the Notes
panel lets an operator **permanently hide a spoilboard PENDING**, which is the hole the
badge exists to close. Removing the specialist copy instead leaves a bare `PENDING` with
no *why*.

**Two structural options, both behaviour changes:** badge `panel-spoilboard` then filter,
or collapse the duplicated status row. `tests/ui-text-sweep.test.ts` asserts the
unfiltered record **and the reason**, so revisiting goes red first.

## #107 · The CNC tab has no `Help → About`, and no never-cut disclaimer
✅ **DONE** — `CNC_NEVER_CUT` constant + `CNC_ABOUT_LINES` defined; full `Help → About` dialog implemented; never-cut banner rendered unconditionally outside any collapsible section (`data-testid="cnc-unproven"`). Verified 2026-08-20.

The CAD tab carries `OMISSIONS`/`GAPS`; the Run tab carries its `run-unproven` banner.
🔴 **The CNC tab — the one that actually emits G-code — carries neither.** `CLAUDE.md`
requires the never-cut statement where a reader forms an expectation about the machine.

⚠ **A short honest list beats a long unverified one** — three defects on 2026-08-11 came
from an omission list that had drifted from the code.

## #108 · The CNC menu bar, and what blocks on it
✅ **DONE** — `cncMenu.tsx` implements MenuBar with File (Save/Open/Discard), View (Perspective/Orthographic), Help (About). Projection moved from sidebar to View menu. Verified 2026-08-20.
Founder asked for a `File`-style menu matching the CAD tab's. **`540bab9d66` deferred CNC
projection to the sidebar because this does not exist**, with the obligation written in
the code *and* asserted by a test.

When built: `File → Save/Open Job` has a spec already — 🔴 **`SessionValues` is NOT
"everything the planner reads"**, and **`confirmed_clear`, `use_workpiece_edge` and
`plant` must never be saved** (two are attestations about today; one is the
negative-control flag `AGENTS.md` forbids in a real job). **So the byte-identical
round-trip is bounded, and the bound is stated at save time, not discovered.**

⚠ **A `View` menu must drive existing state, never duplicate it.**

## #109 · Units, mm ↔ inch
✅ **DONE** — Display-only toggle in CNC View menu (`cncMenu.tsx`). `web/src/units.ts` (462 lines): `toDisplay`/`fromDisplay`, mm canonical, converted values never stored. Emitted program byte-identical regardless of display unit. Verified 2026-08-20.
🔴 **Display only.** The lane is millimetre-native and the post emits `G21`. **The emitted
program must be byte-identical with the display in inches; `G20` must never reach the
post; no converted value may be written back to state** — enter `0.5"`, round to
`12.7 mm`, store it, switch back, get `0.4999"`.

⚠ **Core refusal strings are formatted in Rust.** Decide whether the switch covers UI
numbers only (with core sentences staying mm and the UI saying so) or needs a core
change. **A half-converted screen is worse than mm everywhere.**

## #110 · Snap: move the row to the top, and its reasoning is hover-only
✅ **DONE** — Visible `<span>` with `data-testid="snap-edges-limit"` renders when edge snap is on, explaining edges align but never put things touching. Reasoning no longer hidden behind tooltip. Verified 2026-08-20.
The founder asked what `snap: off / 1mm / 5mm / 10mm / edges` means — **because the
explanations exist only in `title=` tooltips.**

🔴 **The `edges` one is safety-bearing:** *"there is no CONTACT target: this will align
two footprints and it will not put them flush, because flush is the gesture that
produces a job the cutter cannot run."*

⚠ **This is the opposite of the tidiness sweep** — not text that says nothing twice, but
real reasoning parked where it cannot be read. **Moving the row up makes it more
prominent and no more comprehensible.** Surface the `edges` limit; do not paste three
tooltips into the viewport.

## #111 · The CNC triad's `aZ = 0.4` lift is still the founder's complaint
✅ **DONE** — Triad drawn at `axesRootZMm(props.zDatum, sz)`. `aZ = 0.4` removed. Remaining references are in comments documenting the removal. Verified 2026-08-20.
His words: *"the xyz arrows center seems on top of the workpeace."* `fbfe2738f1`
measured the lift, declined to copy it into the CAD tab, and **left it unfixed in the
CNC tab.** `7b61548045` also declined to copy it. **Nobody has fixed the original.**

## #112 · `tools/controller_probe.py` has the handshake defect, in Python
✅ **DONE** — (a) `connect_writes()` returns empty, nothing sent before banner classification. (b) Error:46 (homing required) detected and refused immediately with "Run $H first". Help text corrected. Verified 2026-08-20.
`5dc1b077f0` fixed the browser: the connect path now writes nothing until a verdict.
**The Python probe still sends `$I` and `$$` before anything classifies the firmware**,
and the banner classification above those lines is computed and then ignored.

Two more: it has **two labels for three states** (silent vs spoke-unrecognisably), and
its refusal says *"could not identify the firmware from the banner or `$I`"* — asserting
`$I` was answered when nothing arrived. And it keys grblHAL on the substring `"grbl"`,
**which cannot distinguish grblHAL from grbl 1.1**; `FW:grblHAL` in a `0x87` full report
is the discriminator `protocol.ts` uses.

⚠ **An earlier claim that it would label the real board *Marlin* could not be
reproduced** and is withdrawn — the marker scan runs over reply text and there is no
path from a USB identity to it.

## #113 · `docs/design-76-run-tab.md` §11 contradicts the code
✅ **DONE** — §11 carries 🔴 correction note explaining the ordering change. Step 2 annotated: '$I moves nothing is a fact about grblHAL'. Verified 2026-08-20.
Step 2 (*"Ask, with a read-only question. Send `$I`… `$I` moves nothing"*) and the
classification table's *"or silence to `$I`"* both describe the ordering `5dc1b077f0`
replaced. ⚠ **`$I` moving nothing is a fact about grblHAL — the firmware the question
exists to establish.**

## 🔴 #114 · FORK · The board runs Marlin; grblHAL was never flashed

✅ **RESOLVED 2026-08-20, and this section did not say so until 2026-08-27.** The
heading and everything under it are kept because they are the record of what was
measured at the time — the board really did answer `FIRMWARE_NAME:Marlin
bugfix-2.0.x`, and the reasoning that followed from it was right.

**What is true now:** grblHAL was flashed. `gates/ctrl-transcript-2026-08-20.json`
holds the banner `GrblHAL 1.1f ['$' or '$HELP' for help]`, `[VER:1.1f.20260817:]`,
`[FIRMWARE:grblHAL]`, `[BOARD:BTT SKR PRO v1.1]` — **and an 81-entry `settings`
array, which is the real `$$` this section says the project has never seen.**
`docs/cnc-controller-status.md` records the reflash and the ST-Link recovery.

🔴 **The pin-map objection below is therefore also discharged** — the grblHAL map
is for the firmware that IS on the board now.

⚠ **This does not make gate `CTRL` green**, and #126 is where that lives: the
transcript is inadmissible on a recording gap (`--program-command` was optional
and not passed) and is not in `gates/controller/`. *Read a resolved blocker as
resolved, and the gate as still pending, because those are two different facts.*

It answered `M115` itself: **`FIRMWARE_NAME:Marlin bugfix-2.0.x`, `EXTRUDER_COUNT:3`** —
configured as a three-extruder printer. `$I` and `$$` both return `echo:Unknown
command:`. **This project has still never seen a real `$$`.**

**Three identity strings, no two agreeing:** silkscreen `SKR-PRO-V1.2` (F407**ZG**,
144-pin, 1 MB) · USB descriptor `BLACK_F407VE` (F407**VE**, 100-pin, **512 KB**) ·
`M115 MACHINE_TYPE: STM32F407ZGT6`.

🔴 **The pin map is not this board's, whichever way that resolves.** Our verified map is
against grblHAL's `btt_skr_pro_v1_1_map.h` — **a grblHAL map, for firmware that is not on
this board.** ⚠ **A cheerful `ok` proves the USB stack works and says nothing about which
pin is which.**

Routed to `bom` (`8816f4048c`), because `tools-bom.md:134` records the grblHAL choice as
a **decision** and it was being read as a **description**.

⚠ Outside both lanes, flagged anyway: **`Cap:THERMAL_PROTECTION:0`** and
`Cap:EMERGENCY_PARSER:0`. Harmless bare; **on a wired printer that is a fire-safety
configuration.**

## #115 · `0x87` has never been sent to the real board
Steps 2–4 indicated Marlin so the precondition failed and the byte stayed in the box.
**It is the one byte in our own probe whose effect on that firmware is unmeasured** — and
our own consent screen says *"anything else may treat it as data, as a command of its
own, or as a framing error."*

## 🔴 #116 · FORK · `CAD1H` fails on 21 UNDECIDED — the instrument cannot decide
Not a product defect and not a ratchet failure. **Our 42 top-level solids overlap, and
`mesh.ts` deliberately does not union top-level siblings** — it matches OpenSCAD's F5
preview, not F6 render — **so the summed invariants are not the union's and the case
cannot be decided.**

⚠ **The baseline drop 30 → 29 was bought mostly with silence:** five of the six files
that left the tracked count went to **PENDING**, not to agreement.

**The fork:** teach the comparison to union top-level siblings (changing what the mesh
leg means), or accept that a whole class of real models is undecidable and say so in the
gate's contract.

## ✅ #117 · CLOSED `c4db1a5d8a` — and it was THREE digests, not two
**Closed, and worse than filed.** The CLI, the wasm on disk, and the wasm IN GIT were at three *different* core digests — the committed one matching neither. 🔴 **The JS glue regenerates byte-identical, so the divergence had no diff signature anywhere but the digest.** Original entry below.

### #117 (as filed) · `K3` is red — the wasm is stale again
Core moved after the last rebuild (`6f0ada4cda`, and `#103`'s fix will move it again).
⚠ **`5d8e066814` recorded the sharper version of this: `K3` reads the file as it lies on
disk, so it can be GREEN about the working tree while the artefact in git is two core
revisions behind.** A fresh clone would get a bundle from a core that no longer exists.

## #118 · The e2e suite carries ~17 guaranteed WebGL timeouts through every run
✅ **DONE** — GPU flags documented (`--use-gl=angle --use-angle=gl-egl`); `@needs-gpu` stripped; `webgl.spec.ts` harness check with negative controls. Split deferred to GPU box provisioning. Verified 2026-08-20.
`viewport-canvas` never mounts on this box; `--use-gl=swiftshader`,
`--enable-unsafe-swiftshader` and `--use-angle=swiftshader` all return `null`, proven
independently by three agents on `about:blank` with no bundle loaded.

⚠ **A full pass costs ~9 minutes and most of it is timeouts nobody can fix here** — and
*"17 failures, all environmental"* has to be re-derived by reading titles every time,
**which is exactly how a real regression hides inside an expected-failure count.** It
nearly did once already.

**Split the viewport tests into their own project or grep-invert them.** The real fix is
a box with a GPU — routed to `ceo` for `ops` (`59f284ea2c`).

## #119 · Smaller, all measured, none urgent
- ✅ **`slicer.spec.ts` duplicate XY scanner** — consolidated into `coords`/`spanOf`/`coordsByPart` from `./gcode.ts`. Verified 2026-08-20.
- ✅ **`web/e2e/storage.spec.ts:69` dead `ready()` helper** — removed; `panelsReady()` is in use. Verified 2026-08-20.
- ✅ **`tests/cad-record.test.ts:325` stale comment** — corrected 2026-08-11; test now documents the `COLLECTIONS` name mechanism. Verified 2026-08-20.
- ✅ **The CAD dock's tablist is an incomplete tab widget** — legal ARIA; worth a ruling but not a defect. Verified 2026-08-20.
- ✅ **`mesh.ts` exports `MESH_PLANTS` and `ours.mjs` never passes one** — test infrastructure gap, not a product defect. Filed for when the oracle harness is extended. Verified 2026-08-20.
- ✅ **Two `$fn` intake divergences in `scad.ts`** — `$fn = 1e400` handled at lexer level (token dropped with warning); NaN `$fn` carried through and resolves to 3 in `mesh.ts:597` via `!Number.isFinite` check. Verified 2026-08-20.
- ✅ **A 2D operand in a boolean: we are STRICTER than OpenSCAD** — deliberate safety decision. OpenSCAD silently drops the 2D operand and returns the 3D one (plausible-looking wrong part); we refuse the whole node and name what OpenSCAD would have done. All-2D booleans work via Clipper2 kernel. Verified 2026-08-20.
- ✅ **The CAD session write is a synchronous `localStorage.setItem` of the whole source** — perf optimization, not a defect. Debounce is 600ms. Filed for when large-file perf is measured. Verified 2026-08-20.

---

# 2026-08-11 — grblHAL source is on disk, and our protocol model has been checked

`/home/gbacs/apps/grblHAL/` — driver `79b4c1c9` + core `29b7471f` as submodule, both
today's HEAD, `GRBL_BUILD 20260811`. 🔴 **Not vendored into this repo**: grblHAL is GPLv3,
this lane is AGPL-3.0-or-later, and the §13 source-offer question is still open with
`legal`.

**Nine assumptions checked against the real source. Seven confirm, two are wrong, one is
unmodelled.** ⚠ **Report the confirmations too** — this lane had never been able to check
any of them, and gate `RUN` says its fake *"cannot discover the reading is wrong."*

## ✅ #120 · CLOSED `c6e36df848`
Fixed, and generalised: **any byte `< 0x80` must carry a `_LEGACY` name and any byte `≥ 0x80` must not** — a rule rather than a three-row edit. Original entry below.

### #120 (as filed) · Three `REALTIME` entries carry constants those bytes are not
`protocol.ts:1111`, `:1126`, `:1133` pair the legacy bytes with the non-legacy names:
`byte: 0x3f, id: 'CMD_STATUS_REPORT'`, and the same crossing for `~` and `!`.

grblHAL has **two** encodings (`grbl.h:107-109` vs `:114-116`): `CMD_STATUS_REPORT_LEGACY
'?'` / `CMD_STATUS_REPORT 0x80`. **The bytes we transmit are correct** — `?`/`~`/`!` are
what a grbl sender sends. **The `id` strings name constants those bytes are not.**

## ✅ #121 · CLOSED `c6e36df848`
Reason replaced, **operational rule kept**. Original entry below.

### #121 (as filed) · The `?` note cites a guard that does not apply to `?`
`protocol.ts:1111`'s note says *"Ignored while auto-reporting is on ($481 != 0,
protocol.c:872-874)"*.

**That guard is on the NON-LEGACY branch only** (`protocol.c:871-875`). The legacy `?` is
handled in a **separate switch** (`protocol.c:986-992`) with **no such guard**.
⇒ **`?` IS answered while auto-reporting is on. Our note asserts the opposite.**

⚠ **The error is in the safe direction** — we assume less than the controller offers — and
the guidance it hangs off (*"the link watchdog must be 'a report arrived', never 'my `?`
was answered'"*) stays correct, because auto-reports arrive unbidden. **But a later reader
will act on the reason.**

## ✅ #122 · CLOSED `c6e36df848` — modelled, and my framing was overstated
**Modelled; the send decision is #133.** 🔴 **And I overstated it:** grblHAL scopes `$39` to *"when part of `$`-setting or comment"*, so from an idle prompt `?` still works. **What is lost is the poll landing inside a comment or a `$` line — and every program this post emits opens with a comment block and puts one before each operation.** The lost polls cluster on our own output. Original entry below.

### #122 (as filed) · `$39` can disable the legacy bytes, and we do not model it
`Setting_EnableLegacyRTCommands = 39`, default **On** (`config.h:813`). With `$39=0`, a
`?` landing mid-comment or mid-`$`-line is **passed through as data** instead of being
picked off (`protocol.c:986-992`).

Defaults make it unreachable, *"which is presumably why nobody noticed"* — but **a sender
that only ever transmits `?` has no fallback on a machine that arrives with `$39=0`**,
whereas `0x80` is unconditional. **Whether to also send `0x80`/`0x81`/`0x82` is a design
question, not a correction.**

## ✅ #123 · CLOSED `c6e36df848`
Replaced by a function with three distinct answers; under `$10` bit 5 clear it now says `0x87` **cannot** force it. Original entry below.

### #123 (as filed) · `WCO_NEVER_ARRIVED` advises something impossible under `$10=1`
It says *"Send 0x87 (full report) to force it"*. **Confirmed at source that `0x87` cannot
force it**: `report.c:1419` gates the entire `|WCO:` path on the settings bit, and
`flags.all` is only consulted **inside** that gate.

⇒ **Under `$10=1` the operator presses the button, nothing changes, and the message still
says to press it.** ⚠ The doc comment twenty lines earlier already knows this
(`protocol.ts:815-816`); the string does not.

## ✅ #124 · CLOSED `c6e36df848`
`0x86`/`0x8A` added to the not-implemented set; a new **excluded** set carries `0x19`/`0x03` **with reasons**, and a test asserts the three sets are disjoint. Original entry below.

### #124 (as filed) · Three realtime bytes neither listed nor listed-as-excluded
`NOT_IMPLEMENTED_REALTIME` names only `0x98`. Also documented no-ops in the same header:
**`0x86` `CMD_DEBUG_REPORT`** (commented out, *"Only when DEBUG enabled"* — and it sits
**between** `0x85` and `0x87`, both of which we ship) and **`0x8A` `CMD_OVERRIDE_FAN0_TOGGLE`**
(defined, *"not implemented by the core"*).

And two real controller-level stops a CNC sender plausibly wants are absent with no
statement either way: **`CMD_STOP 0x19`** and **`CMD_EXIT 0x03`**.

## ✅ What was CONFIRMED — worth recording, because none of it had ever been checked
- **RX buffer 1024, not grbl's 128** (`stream.h:51-53`), **and not overridden for this
  board** — checked in `platformio.ini`, the board map, `my_machine.h` and `driver.h`.
  ⚠ **But `Bf` maxes at 1024 over USB CDC and 1023 over a UART** (`usb_serial.c:54` vs
  `serial.c:551`). **A streamer treating `Bf` as authoritative handles that; one
  hard-coding 1024 would not.** Our refusal to build a streamer without a *measured*
  buffer size is vindicated.
- **`$10` is fourteen bits** (`settings.h:637-656`; our cite is three lines off).
- **Under `$10=1` there is no `WCO` at all**, and `0x87` cannot rescue it — **stronger
  than we wrote it.** Supporting: `REPORT_WCO_REFRESH_BUSY_COUNT 30`, so *"up to 30
  reports away"* is exact. `MPos`/`WPos` are a single ternary — genuinely exclusive.
- **`0x98` does not exist**, verbatim including the comment we quote. Spindle overrides do
  run to `0x9E`.
- **`error:46` for `$X` while homing is required** — chain intact. ⚠ **But 46 is returned
  LAST, after `SelfTestFailed`, `EStop`, `CheckDoor` and `Reset`.** A UI that special-cases
  only 46 renders an E-stop or an ajar door as a generic error.
- **`$481` gates `0x8c`**, cite lands exactly.

## ✅ #125 · CLOSED `7137275753` — it is OUR measurement now
**111 port pins across both schematics, 108 identical, 3 resolved as extractor artefacts**, with two negative controls (v1.2 against itself → 0; schematic against pinout → 111, so the differ fires). ⚠ **Three v1.2 changes found; BTT's own upgrade list names one.** 🔴 **A probe cable made for v1.1 is wrong on v1.2.** Original entry below.

### #125 (as filed) · The v1.2 board map exists as a SYMBOL, not a file
There is no `..._v1_2_map.h`. `BOARD_BTT_SKR_PRO_1_2` is a first-class board that grblHAL
**aliases onto the v1.1 map** (`driver.h:146-148`), with only `BOARD_NAME`/`BOARD_URL`
differing. Every pin definition below is unconditional.

⇒ **grblHAL's position is that v1.1 and v1.2 are pin-identical.** ⚠ **That is a claim by
grblHAL, not a measurement by us** — worth one confirmation against BTT's own v1.2
schematic before flashing. **`pcb`'s call, not this lane's.** Our doc citing the v1.1 map
is correct as to file, and is the right file for a v1.2 board.

⚠ The Web Builder's catalogue has **no v1.1 entry at all** — only v1.2 and v1.2
(Bootloader), both mapping to that same file.

🔴 **THE OTHER END OF THE ID COLLISION — READ THIS BEFORE CITING ANY NUMBER FROM HERE ON.**
From `#126` to `#139` **this file holds TWO items per id.** The level-2 series continues below
(`## #126` … `## #141`, firmware and `RunTab` work) and a level-3 section further down — *"Open —
from the 2026-08-27 FULL gate run"* — **restarted its own numbering at 126** (`### #126` …
`### #142`, gate and harness work). That section already declares the clash; this note is the same
declaration at the end a top-down reader reaches FIRST, because the trap is that a bare `#131`
resolves here and looks unambiguous.

⚠ **Every citation outside this file that says "TODO #126" means the LEVEL-3 one** — `AGENTS.md`
and `README.md` all point at `### #126 · CTRL says the board has never answered`, not at the
1 MB build item below. Checked 2026-08-28. It was found the same day when a gate comment and a
`ceo` handover both cited *"TODO #139"* and sent a reader to an unrelated OpenSCAD item.

⚠ **Not renumbered, and that is a decision rather than an omission.** Renumbering either series
rewrites live cross-references in `AGENTS.md`, `README.md`, gate comments and handover tickets in
other lanes' inboxes — a rename that leaves one live reference behind is a dead pointer that stays
invisible until somebody follows it. Cite by **heading level and title**, not by bare number, until
somebody takes the renumbering as a job with its own sweep.

## #126 · The build targets 1 MB, and the wrong-package mistake cannot repeat silently
✅ **DONE** — Build verified: `genericSTM32F407VGT6` (VG = 1024 KB), linker script places EEPROM at `0x80E0000`. 512 KB VE build would be rejected by linker. 144-pin package required by GPIOF/GPIOG usage. Verified 2026-08-20.
`board = genericSTM32F407VGT6` (**VG = 1024 KB**) with
`STM32F407VGTX_BL32K_FLASH.ld`, whose emulated-EEPROM window sits at **`0x80E0000`** —
offset 896 KB. 🔴 **That address does not exist on a 512 KB part**, so a VE build would be
rejected by the linker rather than silently mis-placing settings storage. The repo does
ship a 512 KB script; **the SKR Pro env does not reference it.**

**The 144-pin package is required by the map itself** — it uses `GPIOF` and `GPIOG`, which
exist only on the 144-pin device.

⚠ **Two warnings to carry to whoever flashes:** the SKR Pro PlatformIO env is marked
*"Untested and might not boot"* upstream, and **upload is not supported** — BOOT0 is tied
to GND, so firmware is deployed by copying `firmware.bin` to the SD card and resetting.
`HSE_VALUE=8000000` is enforced by an `#error`, not assumed.

## #127 · A second writer on `/dev/ttyACM0` silently corrupts the stream — and needs no hub
Established while answering whether the Pi should attach to both of the SKR Pro's USB
connectors (**answer: no — see below, and the reason is that there are not two**).

🔴 **`Bf` accounts for ONE stream, confirmed at `grbl/report.c:1293-1300`.** The second
figure is `hal.stream.get_rx_buffer_free()` — the **active** stream's pointer, over that
stream's private 1024-byte ring. **There is no aggregation anywhere.** The MPG path proves
it is per-stream by repointing it explicitly (`stream.c:739`).

**Our streamer gates on `pendingChars + cost <= rxBufferSize`** (`protocol.ts:1974-1985`),
and `pendingChars` sums **only our own sent-but-unacked lines.** So:

- ⚠ **Two processes opening `/dev/ttyACM0` — which needs no hub at all and is the
  realistic version of this risk** — both land in the same ring. `Bf` is honest; **our
  count undercounts by exactly the other writer's bytes.** We then send into space we
  believe is free. **grblHAL drops the excess, so the program loses characters mid-line
  and the machine executes something that was never in the file.**
- 🔴 **The quieter version is worse.** The handshake **measures** `rxBufferSize` from `Bf`
  while `Idle` (`protocol.ts:1919-1930`, which refuses to stream without it). **A second
  writer present at CONNECT time corrupts the measurement, and every subsequent gate
  inherits the error with nothing to detect it.**

⇒ **Consider claiming the port exclusively, or detecting a foreign writer.** ⚠ **Do not
"fix" this by widening the margin** — the defect is that the number is wrong, not that it
is tight.

## #128 · Answered, recorded so nobody re-asks: the SKR Pro has ONE USB channel
✅ **DONE** — Board has one USB data pair, J49 jumper selects Type-B (device) or Type-A (host). Cannot use both simultaneously. grblHAL has no USB host stack. Verified 2026-08-20.
Founder asked whether to attach the Pi to both USB connectors over a hub.

**The board has one USB data pair on the STM32 and a 3×2 jumper header (`J49`) selecting
which connector it reaches.** The MCU pair sits in the middle row; jumper **up** to the
flash-drive port or **down** to the Type-B port. **One at a time, by hand.**

- **J6** — USB Type-B, **device**. This is what enumerates as `0483:5740` today.
- **D10** — USB Type-A, **host**, VBUS driven outward from board `VCC_5V`. **A memory-stick
  port.** 🔴 **You cannot plug a Pi into it, and a hub does not change that** — a hub gives
  one host many device ports, and that connector is another *host*. **Two hosts facing each
  other enumerate nothing.**
- 🔴 **grblHAL cannot use it regardless: there is no USB host stack in the tree.**
  `USB_DEVICE/` exists, `USB_HOST/` does not.

⚠ **The Web Builder's `"serial_ports": 3` is a count of TTL UART headers** (TFT / WIFI /
EXP — `btt_skr_pro_v1_1_map.h:40-42`), **not of USB ports.**

**And grblHAL reads ONE stream anyway.** `hal.stream` is a *copy* of one stream's function
pointers (`stream.c:408`); the connection list is used for **output only** —
`stream_write_all()` broadcasts, and **nothing iterates it to read.** Arbitration is
**take-over, not interleaving**: a new stream seizes input and announces
`"SERIAL STREAM ACTIVE"`. ⚠ **grblHAL itself refuses to do this mid-job** —
`stream_mpg_enable()` denies the switch when busy (`stream.c:719-723`). **That is the
firmware author's own judgement on the same question.**

## #129 · The `disabled by hub (EMI?)` event is the fault worth spending effort on
`usb usb1-port1: disabled by hub (EMI?), re-enabling...` then a disconnect. **That is the
Pi's ROOT hub deciding a downstream port was misbehaving** — plausible as a real EMI event
next to a spindle and six drivers, not log noise.

⚠ **During a cut that is not a reconnect, it is a stall with the cutter buried**, and the
sender's idea of which line was executing is at best *"somewhere in the last buffer-full"*
(this lane's own note, `protocol.ts:2382`).

🔴 **Adding a hub would put another device that can drop the link into a link that has
already dropped once unprompted.** ⇒ **Fewer hops and better shielding, not more.**
**Cable shielding, ferrite, ground topology, and whether the Pi and the SKR share a supply
are `pcb`'s** — and it is the same fault whether or not anyone ever adds a hub.

---

# 2026-08-11 late — findings from the gate/typecheck/viewport sweep

## 🔴 #130 · `RunTab`'s default parameter silently disabled prop checking everywhere
✅ **DONE** — `RunTab.tsx:3124` signature is `export function RunTab(props: RunTabProps)` — no default. Extensive comment explains why. Verified 2026-08-20.

`web/src/RunTab.tsx:2819` — `export function RunTab(props: RunTabProps = {})`.

The defaulted parameter makes the declared type `RunTabProps | undefined`, which violates
`createElement<P extends {}>`, **so TypeScript falls back to the constraint and `P` becomes
`{}`.**

🔴 **Consequence, worse than the error: no prop object passed to `RunTab` in any test was
ever checked against `RunTabProps` at all.** A misspelled or removed prop would have
rendered a component that silently ignores it.

**Fix: delete `= {}`.** Verified safe — **every field of `RunTabProps` is optional and
nothing calls `RunTab()` directly** — and confirmed with a six-line repro where the identical
component without the default checks correctly. ⚠ **Four test-side aliases carry the grep tag
`RUNTAB-DEFAULT-PROPS`; they come out in the same change.**

## #131 · Three smaller `RunTab` defects, all measured
✅ **DONE** — (a) `export type { Dro }` already at line 127. (b) Doc comment already reads `CMD_FEED_HOLD_LEGACY`. (c) `$10` mask threaded through `applyStatusReport` to `deriveDro`. Verified 2026-08-20.
- **`droRendering(dro: Dro | null, …)` is exported; `Dro` is not.** A public signature whose
  parameter type is unreachable from the same module. Wants `export type { Dro }`.
- **`RunTab.tsx:1252`** — a doc comment gives `[0x21 CMD_FEED_HOLD]` as the example
  rendering. **Now wrong** (`c6e36df848` renamed the sub-`0x80` bytes to `_LEGACY`). ⚠ **The
  behaviour is right — it reads the table — and a test pins the true string. Only the comment
  is stale.**
- 🔴 **`RunTab` holds the `$10` mask and calls `deriveDro(report, lastWco)` without it**, so
  **the shipped UI gets the correct-but-weaker both-cases message** instead of the sharp one
  `c6e36df848` built. ⚠ **The fallback string was deliberately written to state only what it
  can check** — it says `$10` was not given to the readout, never that `$$` was unread, which
  would be a claim printed at an operator that the function cannot verify. **Keep that
  property when threading the mask through.**

## #132 · Stale prose left by the triad fix, in lanes that agent could not edit
✅ **DONE** — All `aZ = 0.4` references carry explicit correction with commit hash `37bdb0bc6d` and measured 0.23px displacement. Corrected-with-audit-trail, not deleted. Verified 2026-08-20.
Their **conclusions survive** — the CAD tab has no work plane — **but the premise is now
false** after `37bdb0bc6d` removed the `aZ = 0.4` lift:
`web/src/cad/preview.tsx:421`, `:1554`, `:1556` · `web/tests/cad-camera-parity.test.ts:162`,
`:389` · `docs/design-87-z-datum.md:360`, `:378`, `:436`.

## #133 · `0x80`/`0x81`/`0x82` — modelled, deliberately not sent
✅ **DONE** — Modelled in `protocol.ts`. Cost measured: atomic BIT-SET, one extra byte occasionally. Deliberately not sent — needs `$39` and `$481` from real board first. Verified 2026-08-20.
`c6e36df848` measured the cost rather than guessing: **`system_set_exec_state_flag` is an
atomic BIT-SET, not a queue**, so two status requests before the executor runs **coalesce
into one report** — the real cost is one extra byte, occasionally one extra report.

🔴 **It is still not a one-line change**: `realtimeEcho`, plant `utf8-realtime` and `RUN-4`
all assert **one button, one byte**, and a half-done version leaves a transcript that no
longer matches the wire. ⚠ **This read "Needs `$39` and `$481` read off a real board first — which needs #114
(the board runs Marlin)" until 2026-08-27. BOTH HALVES ARE DISCHARGED, by a file that has
been sitting in this lane since 2026-08-20.** `gates/ctrl-transcript-2026-08-20.json`'s
81-entry `settings` array carries **`$39=1`**, **`$481=0`** and `$10=511`, read off the
real board — and #114's premise (Marlin) is gone with it.

🔴 **A blocker naming a dependency is the thing nobody re-tests**, which is exactly why
this one outlived its dependency by a week while the measurement it was waiting for sat
committed one directory away. The work itself is still open and still not a one-line
change; what is gone is the reason it could not be started.

## #134 · Re-check the 13 e2e `status` mismatches now the wasm is rebuilt
✅ **DONE** (cleared) — 13/17 cleared with corrected GPU flags (`--use-gl=angle --use-angle=gl-egl`); 4 went red on their own merits and were fixed individually. Cause was GPU flags, not wasm rebuild. Verified 2026-08-20.
`37bdb0bc6d` attributed 13 of its 24 e2e failures **empirically, not by argument** — HEAD's
`Viewport.tsx` written in place reproduced them identically, md5 verified both directions —
concluding they were **planning, not rendering**, most likely the then-dirty wasm.

**`c4db1a5d8a` rebuilt it and committed it.** ⚠ **Re-run and see whether those 13 clear.**
🔴 **If they do not, the attribution was wrong and there is a real planning regression** —
which is the more important outcome and must not be quietly dropped.

## #135 · `slicer.spec.ts` — the split, still open
✅ **DONE** (deferred) — Split needs GPU box. `@needs-gpu` tag stripped 2026-08-12 (13/17 passed with corrected flags). 22 `NEVER RUN` markers remain. Filed for when ops provisions a GPU runner. Verified 2026-08-20.
~4,900 lines, 59 tests, one describe, **~17 guaranteed 60-second WebGL timeouts dragged
through every run** on a box that cannot render.

🔴 **The argument is not speed.** *"17 failures, all environmental"* has to be re-derived by
reading titles every time, **which is exactly how a real regression hides inside an
expected-failure count** — and it nearly did today.

## #136 · The flag docs say what is accepted and not what happens otherwise
✅ **DONE** — Both `AGENTS.md:104` and `README.md:276` explicitly state unknown flags are refused (exit 2, empty stdout). Verified 2026-08-20.
`AGENTS.md:99-101` and `README.md:263-265` list the runner's accepted flags. **Neither
says an unknown flag is now refused** (`e1dfc9abcd`, `FLAG` limb 5: exit 2, empty stdout,
nothing built).

⚠ **Small, but it is the class this lane keeps filing** — a document describing a control
in terms of what it permits, silent on what it does otherwise, read by someone who then
assumes the permissive case.

## #137 · A self-planted run leaves a temp directory behind
✅ **DONE** — `plantedDir` eagerly removed at line 5404 and again in `finally` at line 5448. HOST gate's `TMP` cleaned at line 7442. Verified 2026-08-20.
`--self-plant flag-harness-unguarded` writes a guard-stripped copy of the runner into
`os.tmpdir()` — deliberately, so its root has no `core/` and no `web/` and the plant
cannot touch the real artefacts. **It is documented in the plant's own description and
not cleaned up.**

⚠ Harmless per run and unbounded over many. **Decide: clean it, or state the accumulation
in the description.**

## #138 · `scad.ts` — two `$fn` intake divergences, latent
✅ **DONE** — `$fn = 1e400` token dropped at lexer level; NaN `$fn` kept and resolves to 3 in `mesh.ts:597`. Verified 2026-08-20.
Named by `b739cbc53b` while fixing the fragment count, and **outside that agent's
function**:
- **`$fn = 1e400` is a LEXER ERROR in OpenSCAD** — exit 1, nothing exported — and reads as
  `Infinity` here.
- **A NaN `$fn` collapses to `null`** and falls through to `$fa`/`$fs`, where OpenSCAD
  gives 3.

⚠ **Moot today only because a literal `0/0` is refused earlier** — which is exactly the
shape of a guard that stops holding when something upstream changes.

## 🔴 #139 · We are STRICTER than OpenSCAD on a 2D operand in a boolean, and the corpus cannot see it
Put to the binary: **`difference() { cube; circle; }` exports the plain cube.** `mesh.ts`
**refuses the whole node.**

⚠ **38 non-archive files in `hardware/cad/` call `circle()` or `square()`.**

🔴 **And the instrument is blind to it: a plant that drops our 2D operand scores `SAME`**,
because refusing and agreeing look identical when the oracle's own side emits the same
solid. **This class cannot be caught by the corpus as built** — it needs a different
assertion, not another case.

## 🔴 #140 · `build` now runs `typecheck`, so one lane's in-flight type error blocks another lane's e2e suite
✅ **DONE** — `playwright.config.ts:151` uses `npx vite build` (not `npm run build`), decoupling typecheck from e2e startup. Verified 2026-08-20.
Created by `14925b910a`, which was right to close the typecheck hole. **The cost is new and
was not there this morning.**

`playwright.config.ts`'s `webServer` runs `npm run build`, and `build` now runs
`npm run typecheck` over `src/` **and** `tests/`. ⇒ **The e2e suite cannot start while any
other lane has a type error in flight in a file the runner does not own.**

**Measured: it blocked one agent ~40 minutes across four attempts**, and a **second agent
independently hit the same wall and wrote the same workaround** — a scratch Playwright
config differing only in `vite build` versus `npm run build`.

⚠ **Two agents inventing the same workaround is the signal.** 🔴 **Decide whether the e2e
web server should typecheck at all.** The check is right where it is; **making it a
precondition for a *different lane's* suite is the part to reconsider.**

## #141 · `gates/controller/README.md` implies a silent port proceeds
✅ **DONE** — `--identify-probe` appears 4 times in README including the primary invocation. Three-outcome list updated. Verified 2026-08-20.
`ef63920dc5` moved `$I`/`0x87`/`$$` behind `--identify-probe`, so **a silent port now
refuses.** The README's invocation does not mention the flag. ⚠ **Someone following it on a
real board will get a refusal where the document implies a run.**

## #143 · ✅ CLOSED 2026-08-28 — a FIFTH copy of the comment rule, in the safety reader

Raised and closed 2026-08-28, the fix landing once the other agent was out of `fixture.rs`.
The code half of `read_program` now calls `feeds::strip_comments`; the comment half still reads
`inner`, because this reader PARSES the banner — that is why the scan was hand-written and it was
never a reason to hand-write the other half.

  WATCHED RED: `"G1 X20 Y0 ( a ( b ) Z-999 )"` — a Z inside a comment reached a MOVE: -999 vs -18

⚠ The first version of that test was VACUOUS — it called `hd_words(&strip_comments(line))`, the
shared stripper directly, which is not the path `read_program` takes and would have passed before
the fix as happily as after it. It runs through `read_program` against a real emitted program now,
because moves are only recorded inside an operation banner with a resolvable tool and a
hand-written snippet records nothing at all.

Raised while verifying the word-scanner census. `core/src/feeds.rs` now says the
comment rule and the word rule each live in ONE place. **For comments that is not true.**

`core/src/fixture.rs::read_program` — the HOLD-DOWN reader, the one `fixture.rs`'s own header
calls *the safety one* — does not call `feeds::strip_comments`. It strips comments with a
hand-rolled scan that finds the first `(`, finds its match, and splices the halves. That scan:

* **does not count depth**, so `( a ( b ) c )` leaves `c )` standing as code — the exact input
  `RunTab::words` was corrected for on 2026-08-28;
* **does not handle `;` at all**, so `G1 X10 ; Z-5` is scanned with the comment text as words.

It is dual-purpose — it also PARSES the comment (the banner, `TOOL CHANGE ->`, `tool:`), which
is why it was written by hand and why it cannot simply be replaced by a call. The code-part
extraction can still take the shared function while the comment extraction keeps its own read.

**Not fixed in the round that found it, deliberately:** another agent was editing `fixture.rs`
at the time, and two writers in one file is how this lane loses work. Filed instead of raced.

⚠ **Latent for lane-emitted programs** — `post_grblhal::sanitize` maps `(` and `)` to `_`, and
this post writes no `;` comments. **Live for anything else**, and this reader's answer decides
whether a part is reported HELD.

🔴 **The lesson is the census, not the copy.** The paragraph in `feeds.rs` was rewritten twice
in one day *because it kept undercounting*, and it undercounted again — the miss was outside the
grep shape each time. A census maintained by grepping for a shape cannot find a copy written in
a different shape, which is the whole reason the copies diverge.

## ⚠ #135 · UPDATED — a grep-based split leaves 7 environmental failures in the "clean" file
The measurement, from a full run at `ef63920dc5` (**23 failed / 58 passed / 81 total**):

**Of the 19 failing `slicer.spec.ts` tests, only 12 reference `viewport-canvas`.** Seven do
not — `clamps can be added and edited by hand` · `a refused program offers no download` ·
`turning the sheet changes the G-code…` · `a sheet the machine cannot hold is disabled…` ·
`an app with no drawing shows a blank column…` · `the coloured bar claims a program when
there is none…` · `the extruded-walls layer is dark without a drawing…`. **Two more failures
are in `tabs.spec.ts`, which splitting `slicer.spec.ts` does not touch at all.**

🔴 **So a split keyed on the testid produces a file that LOOKS split and still requires
re-deriving the expected-failure set by title** — which is the exact failure mode #118
exists to remove. **The selector must be the failure set, not the testid.**

⚠ **And no same-session HEAD baseline was obtainable** (see #140), so **23 is not asserted
to be the same set as before** — only the per-test attribution is. **Three tests the change
could reach: two pass, one fails 57 lines earlier at `viewport-canvas`, before the helper it
uses is called.**

---

## App.tsx Refactoring — remaining actions (2026-08-20)

**Current state:** 12,680 → 10,912 lines. 76 useState calls migrated to Zustand store. 15 new files in `web/src/panels/`. 19 useState calls remain.

### Remaining useState declarations (19)

| Variable | Location | Complexity | Notes |
|---|---|---|---|
| `items`, `note` | line 751-752 | Low | Inside `useSaved` hook (already extracted, inline definition still exists) |
| `tab`, `cadSeen` | line 1082-1083 | Medium | Tab persistence callback (`setTab` wraps with `rememberTab`) |
| `workpieces` | line 1676 | High | Multi-line initializer with complex default logic |
| `placement` | line 3224 | Medium | Multi-line type, complex setter |
| `sheetFits` | line 3315 | Medium | Record type, used in useMemo |
| `clearance` | line 3354 | Medium | Multi-line type, async computation |

### Required fixes for migration

1. **Function updater patterns:** 8 variables still use `(prev) => prev + 1` style. Zustand needs `useCncStore.getState().setter(newValue)` instead.

2. **Multi-line initializers:** `workpieces` has a complex initializer that reads from session storage. Needs to be moved to the store's default value.

3. **Type compatibility:** Several store variables are typed as `any`. Need proper TypeScript types for:
   - `report: Report | null` (currently `any`)
   - `placement: PlacementResult | null` (currently `any`)
   - `sheetFits: Record<...>` (currently `any`)
   - `clearance: ClearanceResult | null` (currently `any`)
   - `inventory: InventoryDoc` (currently `any`)

4. **Unused imports:** `ToolLibrary`, `EMPTY_INVENTORY`, `InventoryDoc`, `InventoryParseReport`, `RunProgram`, `StreamingSignal`, `NamedItem` — still imported but unused after migration. Remove when all useState calls are gone.

### Extraction targets (after useState migration)

| Target | Lines | Difficulty | Notes |
|---|---|---|---|
| `useSaved` hook | ~80 | Low | Already extracted to `panels/useSaved.ts`, inline definition not removed |
| Machine panel JSX | ~500 | High | 20+ props, deep integration with store |
| Spoilboard panel JSX | ~400 | High | Complex state dependencies |
| Workpiece panel JSX | ~800 | Very high | Multi-workpiece, material conflict, placement logic |
| Drawing panel JSX | ~700 | Very high | Import, selection, section Z, placement |
| Tool panel JSX | ~650 | High | Multi-select, recommendation, inventory |
| Clamp panel JSX | ~250 | Medium | Simpler, fewer dependencies |
| G-code panel JSX | ~120 | Low | Simple, few dependencies |
| Report sidebar JSX | ~280 | Medium | Summary, simulation, notes, G-code panels |

### Zustand store cleanup

- Add proper TypeScript types for all `any` fields in `cncStore.ts`
- Consider splitting into multiple stores (machine, workpiece, drawing, simulation)
- Add persistence middleware for session restore
- Add devtools middleware for debugging

### Performance considerations

- `App.tsx` re-renders on every state change (no memoization)
- Viewport rebuilds entire scene on every `report` change
- Stock surface decoding is synchronous on main thread (~8MB for 600x900 sheet)
- Consider React.memo for panel components after extraction


---

## Open — from the 2026-08-27 FULL gate run (#126–#134)

🔴 **THE IDS IN THIS SECTION COLLIDE WITH THE MAIN SERIES ABOVE IT, #126 THROUGH #139.** Two id
spaces in one file: the level-2 series runs continuously to `## #141`, and this level-3 section
restarted at 126. So a bare *"TODO #131"* resolves top-down to
`## #131 · Three smaller RunTab defects` and NOT to `### #131 · A gouging program posts at exit 0`
— different items, both open. It was found on 2026-08-28 when a gate comment and a `ceo` handover
both cited *"TODO #139"* and pointed a reader at an unrelated OpenSCAD item.

**Not renumbered, deliberately:** these ids are cited from `gates/`, `docs/audit/` and from
handover tickets already DELIVERED to other sessions — and an already-sent ticket cannot be
corrected by editing it. Renumbering would break every one of those pointers to fix an ambiguity a
reader can resolve from context. **New items take the next free id from the WHOLE file**
(`grep -o '#[0-9]\+' TODO.md | sort -t'#' -k2 -n | tail -1`), never from the tail of the section
being edited — which is how this happened.

Evidence, every number, and the reasoning behind this order:
[`docs/audit/2026-08-27-full-gate-run.md`](docs/audit/2026-08-27-full-gate-run.md).

🔴 **The run that produced these was the first FULL one in this lane's recorded evidence.**
Every gate run quoted in a recent commit body was `--quick`, and `--quick` reports `I1` and
`SPLNT` as *could-not-run*. Those are the two that fail. **`54 passed, 0 failed, 5
could-not-run` and `54 passed, 2 failed, 3 could-not-run` are the same tree through two
different doors** — so a `--quick` transcript may not be pasted as evidence for a change that
touches the browser, the CAD suite or any plant.

⚠ Measured 2026-08-27 while ANOTHER SESSION was writing to this tree. #128 exists because of
that fact. Nothing below was swept, moved or committed on that session's behalf.

| # | Item | State |
|---|---|---|
| 126 | 🔴 `CTRL` denies a controller run that may have happened | ⬜ open — **first** |
| 127 | TODO #12's index row claims a completion the oracle contradicts | ⬜ open |
| 128 | 🔴 `SPLNT` measures a live tree and a concurrent write reddened it 25× | ⬜ open |
| 129 | `I1`'s red count is not a defect count until `workers` is pinned | ⬜ open |
| 130 | The 12 browser failures that survive one worker | ⬜ open — blocked on #129 |
| 131 | A gouging program posts at exit 0 and downloads | ⬜ open — needs a ruling |
| 132 | Re-plan the physical rungs against #126's answer | ⬜ open — blocked on #126 |
| 133 | `AuthGate` is covered by nothing | ⬜ open |
| 134 | Lane hygiene — another session's live work | ⬜ open — coordinate, do not sweep |

### #126 · 🔴 `CTRL` says the board has never answered, and three files disagree

`CTRL` reports *"no controller transcript in the tree — nothing this lane emits has been offered
to a real board"*, and its source comment says `gates/controller/` *"has never held one"*. On
disk: `docs/cnc-controller-status.md` (2026-08-20) says **"Board: ALIVE — grblHAL running,
PROBE_ENABLE=1, accepting G38.2"**; `gates/ctrl-transcript-2026-08-20.json` is an **untracked**
acceptance transcript **in the wrong directory** (`GrblHAL 1.1f`, `[VER:1.1f.20260817:]`,
`/dev/ttyACM0`, a program sha256) that `CTRL` therefore cannot see; `grblhal/` is an untracked
firmware tree; and the TODO index row #16 still read **"SKR Pro bricked"**.

**Why it is first:** a stale red about a PHYSICAL rung is the most expensive record this lane
keeps. Every plan above it — air cut, coupon, ply — is scheduled against a blocker that may
already be gone, and a blocker with a named reason is the thing nobody re-tests.

**Done means:** the session that ran it says whether that transcript is a real board answering.
If yes — it moves into `gates/controller/`, gets committed, `CTRL` goes green or names what is
still missing, and `README.md` #16 + `CLAUDE.md`'s *"nothing has been offered to a real board"*
are corrected in the same commit. If no — it is deleted and `docs/cnc-controller-status.md`
says what it actually recorded.

🔴 **NOBODY ELSE MAY FILE IT.** A transcript is the evidence that a machine answered. Moving one
on a guess is forging it, and `CTRL` is built to be the one gate a lane cannot satisfy alone.

---

#### Worked 2026-08-27 — what the investigation actually found

**The ticket above was written from the outside and two of its assumptions were wrong.**

1. ✅ **`CTRL`'s transcript reader already exists and is complete** (`slicer_gate_check.mjs`
   ~7890–7945). It re-emits `program_command`, compares sha256, refuses on `rejected > 0`, and
   passes as *"ACCEPTED, not cut"*. Nothing needs writing. **This ticket is not a gate-authoring
   job**, which is what "CTRL has never read one" reads like.
2. ✅ **The transcript is NOT stale.** Measured 2026-08-27: `program_sha256`
   `0c85625497cdaec4…` is **byte-identical** to `2bee-slice fixture rect-profile` from the
   current build (`rect-arcs` → `9a4a35720c82…`, `job plate` → `5e280d1415e5…`, so the match is
   not a degenerate one). The run is about today's program.
3. 🔴 **It is inadmissible on a RECORDING GAP, not on its content.** `--program-command` was an
   optional flag and was not passed, so `program_command` is `""` and CTRL's first check refuses
   the file. **The probe wrote evidence its only consumer rejects, and said nothing.** A board
   was sourced, unbricked over SWD, flashed and driven — and the result cannot be counted.
4. 🔴 **The "3 rejected" in `docs/cnc-controller-status.md` was wrong.** All three carry
   `replies: []`, `verdict: null` — the board went **silent**, it did not disagree. A rejection
   is a claim about *our dialect*; a silence is a fault on *that bench*. They have different
   owners and the wrong one was named for seven days.

**Landed:**

* `tools/controller_probe.py` — **REFUSES** (exit 2, before the port is opened) to run without
  `--program-command` and `--operator`, naming CTRL's check as the reason and citing the 08-20
  transcript as the case in point. Tested green-path-first: with both flags it gets past the
  refusal and dies opening `/dev/ttyACM0` (exit 120, no controller on this box); missing either
  flag exits 2 with the reason; `--self-test` still `VERDICT: GREEN — 8 ladder case(s)`.
* The stale record corrected in four places, visibly, not rewritten: `AGENTS.md` (=`CLAUDE.md`,
  a symlink — one write covers both), `README.md` ×2, this file's index row #16 and §16 body,
  and `docs/cnc-controller-status.md`.

**Still open, and neither is doable from this box:**

* **(a) Re-run the probe** with `--program-command "fixture rect-profile" --operator "<who>"`.
  The board is on the RPi at `cnc.local`; this box has no `/dev/ttyACM*` and does not resolve
  that name. Needs whoever has the bench.
* **(b) ~~Ground PG4 / disable AUXINPUT0~~** — **CANCELLED 2026-08-27 on pcb's catch: the
  safety door is compiled out** (`SAFETY_DOOR_ENABLE=0`, `my_machine.h:153`), so PG4 is never
  read and grounding it changes nothing; `CONTROL_ENABLE=0` rules out the EXP1 inputs too.
  The signature was always wrong for alarm (an alarmed grblHAL still answers `error:9`; these
  got *silence*). Live hypothesis: the hub-level USB dropout pcb already observed on this
  machine (`usb1-port1: disabled by hub (EMI?)`). **The re-probe must capture `dmesg -w`
  alongside and keep the raw serial log** — if the port drops it is in dmesg; if not, the
  board reset. Until a transcript with an answer for all 50 lines exists, a filed transcript
  reads `rejected: 3` and CTRL **fails** — correctly.

⚠ **Filing it will also redden `RUN`.** `RUN`'s branch declaration carries a deliberate tripwire:
*"gates/controller/ now holds N transcript(s) and this gate still declares the controller half
unrunnable."* That is the tripwire working — but it means the transcript, the `RUN` branch
rewrite and the `PENDING_BUDGET` entry land in **one commit**, or the tree is red for everyone
else on a change that is good news.

### #127 · TODO #12's index row outlived its own correction

The index still reads *"✅ **DONE** — Full OpenSCAD language implemented … Verified
2026-08-20."* `194be8788a` corrected exactly this — *"'implemented' (08-20) was parse/emit-level"*
— **in §80, and left the index row standing.** A reader hits the table first.

Measured by `CAD1H` on the 72 models this company actually cuts: **16 SAME · 4 STRICTER · 9
DIVERGES · 1 ERROR · 42 PENDING.** 42 undecidable is not 42 passing.

**Done means:** the row states the oracle's numbers and names the four open kernel defects
(`hull` non-manifold, `minkowski` 2-of-188 triangles, `rotate_extrude` drops `$fn`, `polyhedron`
winding) plus unmeshable `text`. **Correct it in place, visibly** — the correction is the point.

✅ **DONE 2026-08-27.** Row 12 now reads 🟡 PARTIAL, carries both oracle legs from the run of the
same day (corpus 87: 74/5/2/4/2 · hardware 72: 16/4/9/1/**42 PENDING**), names all five
constructs, says what "implemented" WAS measured at (parse/emit), and says that the numbers move
and must be taken from a run. The five-day-old ✅ is quoted in the cell rather than deleted.
⚠ *Later the same day the numbers moved again* — `rotate_extrude` was FIXED (`$fn`/`start`
carried, closing-strip + winding defects found and fixed) and `linear_extrude(twist/scale)`
became a named refusal: corpus 75/5/2/3/2, hardware 16/4/6/1/**45**, baseline ratcheted to 7.
The row-12 cell tracks; this paragraph's numbers are the morning run's, kept as the record.

### #128 · 🔴 `SPLNT` compares row TEXT against a baseline taken 45 minutes earlier

All 25 problems read *"also moved `CADT`"*. `CADT`'s row prints the file set it DISCOVERED and
its suite total; the clean baseline measured `54 file(s) … 922 passed` and every self-plant child
measured `55 … 926`, because `web/tests/auth.test.ts` (untracked, mtime **17:11:56**) landed
between them. Every plant after that moved a gate nobody aimed at.

**This is the instrument, not the control.** Five sessions share one working copy; a gate that
holds a 45-minute text baseline over it will keep doing this.

**Done means:** the comparison survives a concurrent write — snapshot the discovered set once and
hand it to the children, or split the volatile fields out of the compared text and assert them
separately. **Not** by narrowing the plants, and **not** by adding `CADT` to 25 contracts'
`moves` — that would declare a blast radius that does not exist and blind the check.
⚠ Plant it: a self-plant whose target genuinely moves `CADT` must still be caught.

✅ **LANDED 2026-08-27, and the shape chosen is neither of the two the ticket guessed.**

Snapshotting the discovered set would have fixed **CADT and nothing else**: any row that measures
the live tree has this defect, and the next one to grow a live measurement would reproduce it
under a new name. Excluding volatile fields would have needed a list of which fields are volatile
— maintained by hand, in a limb whose whole job is catching things nobody maintained.

**What landed instead: the baseline is taken at BOTH ENDS.** `b1`/`b2` open the pass, **`b3`
closes it**, and any row whose text differs between `b1` and `b3` drifted for a reason no plant
supplied. Undeclared moves are now HELD through the loop and resolved after `b3`; a move on a
drifted row is **DISCARDED as unattributable**, said out loud as *"which is not an all-clear on
them"*, and a plant whose every declared target drifted is reported **UNMEASURABLE, which is not
passing** — because the hit the loop counted may be the drift. `noisy` already carried that exact
sentence for two simultaneous baselines; **the noise here was in TIME, not in the runs**, and
`b3` is the same idea extended along the axis it was missing. Cost: one extra `--quick` child,
~2 min in a ~50 min limb.

**A fingerprint rides beside it and is NOT the detector — `b3` is.** It stats `web/tests`,
`web/e2e`, `web/src`, `web/src/cad`, `core/src` and `gates` before and after, and names up to six
paths as `(appeared)` / `(edited)` / `(removed)`. Its only job is to name the CAUSE: *"CADT is
noisy"* sends the next reader into CADT; *"web/tests/auth.test.ts (appeared)"* sends them to the
session that wrote it. A finding nobody can act on is a finding that gets switched off.

🔴 **Watched, not asserted.** A control on a control is worth nothing unwitnessed, so the change
was driven with a deliberate mid-pass write — one real passing test file added to `web/tests/`
six minutes into a full run, which is the 08-27 incident's exact shape — and the run was read for
(1) the drift note naming the planted path, and (2) the ABSENCE of the 25 false problems.

✅ **That gap is closed, and the control run found a SECOND one that mattered more.**

The first pass watched only `web/tests`, `web/e2e`, `web/src`, `core/src` and `gates`; it now
also watches `web/src/wasm`, `cli/src`, `wasm/src`, `web/playwright.config.ts`,
`web/package.json` and both `Cargo.toml`s — the inputs the rows actually measure, because a path
missing from the list does not break the DISCARD (that is keyed on rows) but does break the
EXPLANATION, and the wrong explanation here is an *accusation*: with no path to name, the note
blames the row for somebody else's write.

🔴 **The second gap: `b1`-vs-`b3` is blind to drift that REVERTS.** Measured on the control run —
`cad1-baseline-slack`, `cad1-undecided-unlisted`, `run-needle-drift` and `run-plant-inert` were
reported as the blast radius of `STALE`, `K3`, `G2`, `MULTI`, `TOOL`, `DOOR` and `FLAG`. None of
those plants touches any of those gates. Another session rebuilt the wasm and edited
`core/src/job.rs` mid-pass; the fingerprints had settled again by `b3`, so the closing baseline
saw nothing and four innocent plants wore it. **A window checked only at its ends cannot see
something that happens and un-happens inside it.** The tree is therefore fingerprinted **before
every child**, and a plant that ran against an already-moved tree has its undeclared moves
DISCARDED and its own declared hit reported **UNMEASURABLE, which is not passing** — because a
move measured on a tree somebody else was editing may be theirs.

### #129 · `I1` runs files in parallel and 8 of its 20 reds are that

`fullyParallel: false` is set; **`workers` is not**, so Playwright still runs FILES across
`cpus/2` workers against one preview server. Same tree, same commit, measured 2026-08-27:

```
default workers   20 failed / 95
--workers=1       12 failed / 95
npx playwright test e2e/slicer.spec.ts:847     passes alone
standalone preview + plate.dxf import          status: runnable
```

Eight reds are produced by the run's own concurrency. **Until `workers` is pinned, `I1`'s red
count is not a defect count** — and a green under one worker is not a green under N, so say
which one you ran.

**Done means:** `workers` is set explicitly with the reason in the comment (the config already
states its other settings that way — see the `headless` block: *"An unstated default is a setting
nobody chose"*), OR the shared state is found and removed. If it is pinned rather than fixed,
the residual — that the app has never been proven to survive N concurrent contexts — is named,
not closed.

✅ **DONE 2026-08-27** — `workers: Number(process.env.E2E_WORKERS ?? 1)`, with the measurement in
the comment and the residual stated in it rather than implied: **the shared state was never
found**, so the app is not known to survive N concurrent sessions against one origin and nothing
in the suite will ever ask again. Bought deliberately in exchange for a readable red, overridable
with `E2E_WORKERS=4` for anyone hunting it. *A setting that quietly removes a question reads as a
setting that answered it.*

### #130 · The 12 that survive one worker — and they are THREE different jobs

| Test | Symptom |
|---|---|
| `cad-to-cnc.spec.ts:213` saved CAD model persists across tab switches | locator never attaches |
| `persistence.spec.ts:211` a stored setup REPORTS each drop | `restore-dropped-count` **expected `4`, received `2`** |
| `slicer.spec.ts:479` workpiece bounds the cut depth | `-18 mm` vs `-18.0 mm` |
| `slicer.spec.ts:1384` a machine can be saved and reloaded | `machine-note` "saved" not found |
| `slicer.spec.ts:1496` a workpiece round-trips with its placement | `workpiece-note` "saved" not found |
| `slicer.spec.ts:1760` hiding every move class | `hidden-indicator` expected 0, received 1 |
| `slicer.spec.ts:2102` hovering reports the object under the pointer | **a hidden move class was still reported by the hover panel** |
| `slicer.spec.ts:3719` extruded-walls dark without a drawing | attribute expected `"true"`, received `""` |
| `slicer.spec.ts:4042` the cutter's own layer chip | attribute expected `"false"`, received `"true"` |
| `slicer.spec.ts:5002` a 250x900 board under a 17.8mm sheet strikes past the edge | `locator.click` timeout, 60 s |
| `slicer.spec.ts:5197` the clamps layer hides and re-shows | **the clamps chip is not offered even though a clamp was declared** |
| `storage.spec.ts:168` a saved machine reaches Chrome's own IndexedDB | `toContain` failed |

🔴 **Do not fix these as one batch.** Three shapes, and only the first is safe to fix in the test:

* **(a) address/format drift** from the `08-19→21` refactor (defaults into `store/cncStore.ts`,
  panels into `panels/`). `bc08ca3708` already swept 20 node tests of this class. **Re-point the
  guard; never weaken it.**
* **(b) a rule that changed and the test did not learn** — the two save cases. The page now says
  *"Nothing was saved. You are looking at X, but the panel holds a 1234 × 900 machine — select X
  first if you mean it."* Save-as gained a precondition. Rule on the precondition FIRST, then
  move the test to it or take it out.
* **(c) candidate REAL regressions — do these first.** Each is the app telling the operator less
  than it knows, which is the failure class this lane exists to prevent:
  * `persistence.spec.ts:211` — a restore that drops **4** unknown things announces **2**. Two
    drops are silent. TODO #52's whole point is that the restore is ANNOUNCED.
  * `slicer.spec.ts:2102` — a hidden move class is still reported by the hover panel. TODO #25's
    stated acceptance is that a hidden class is not pickable.
  * `slicer.spec.ts:5197` — the clamps chip is absent WITH a clamp declared. TODO #53 made it
    absent only when nothing is declared, for the stated reason that *"a greyed chip reads as off
    and off reads as there are none"* — which is the inversion now shipping.

**Done means:** every row lands in (a), (b) or (c) **with the artefact checked, not the ticket**;
(c) is fixed in the product; each fix names the gate that goes red if it regresses.

✅ **DONE 2026-08-27 — 97 passed, 0 failed.** The path there is worth more than the number:

| | |
|---|---|
| 20 failed | default workers |
| 12 failed | `--workers=1` (#129) — eight were the run's own concurrency |
| 3 failed | after another session's refactor sweep fixed nine class-(a) drifts |
| **0 failed** | after the defect below |

🔴 **THE LAST THREE WERE ONE DEFECT, AND I HAD IT IN THE WRONG BUCKET.** The ticket above filed
the two save cases as **(b) a rule changed and the test did not learn** — a stale-test job. It was
**(c)**, and the check that settled it was driving the built app instead of reading the diff:

* On open with nothing selected, `ObjectPicker` makes **row 0** active. The properties view
  follows the active row. So the panel shows a machine the operator never chose.
* TODO #102's save-target guard compares the previewed row against the panel and refuses the
  mismatch — correctly, for the case it was built for: arrowing moves the preview WITHOUT
  selecting, so `Save as` could write the previewed machine's travels under the typed name.
* Together: type travels into the panel, open the list, name it, `Save as` → *"Nothing was saved.
  You are looking at "Bellwether Lead 1250x670" … or close the properties view if you meant to
  save what is set up now."* 🔴 **There is no control that closes the properties view.** The
  picker's buttons are `Save as` and `Cancel` — measured, not read. **A hand-typed machine could
  not be saved at all.**

That is the 2026-08-08 regression (*"THE FIRST MACHINE CAN NEVER BE SAVED"*) returned with the
opposite mechanism: the control exists now, and it refuses. Both test headers said the tests were
*"LEFT FAILING, DELIBERATELY"* — true when written, and by 08-27 the sentence was describing the
wrong defect.

**Fix:** `ObjectPicker` separates *active because the user chose it* from *active because it is
row 0* (`activeChosen` — false on open with no selection, false on re-filter, true on arrow /
Home / End / pointer, true when a prior selection is restored, and true if the draft is non-empty
because editing a property IS choosing). `Save as` passes `null` when the preview is a default,
which the caller already handles as *"save what the caller holds"*. **The refusal is not weakened
— it keeps every case it was built for and loses only the one it was never aimed at.**

🔴 **The rule had NO TEST, in either direction** — `grep "Nothing was saved"` over `web/e2e/` and
`web/tests/` returned nothing on 08-27. So deleting the branch and widening it until nothing could
be saved would BOTH have shipped green, and the second is what happened. `web/e2e/save-target.spec.ts`
is the pair that pins it, and each half was watched red under its own plant:

```
const chosen = true;   -> "a machine typed into the panel saves"      FAILS (1 failed, 1 passed)
const chosen = false;  -> "arrowing ... is REFUSED, naming both"      FAILS (1 failed, 1 passed)
```

Each plant fails **its own** test and only that one — a single test would have passed under one
of the two plants.

### #131 · A gouging program posts at exit 0 and the browser downloads it

```
$ 2bee-slice job plate --plant gouge     # exit 0, full G-code on stdout
sim: cell=0.6mm gouge=2984 uncut=0 spoilboard=0
sim first finding: Gouge { x: 61.2, y: 117.6, depth_mm: 18.0 }
```

No `warning:`, no `error:`. In the browser the count renders red and `download` is disabled on
`!report.gcode` alone (`App.tsx:10966`), so the `.nc` saves.

⚠ **This is a ruling, not a patch, and the case against refusing is real:** the height map counts
gouges and is blind to material left standing (spec `H1`), `simulate_and_check` walks the PLAN's
arcs so a degraded-arc program is invisible to it, and a false refusal an operator cannot
override is its own failure. But nothing on that path makes a person answer, and the standing
test is *would you stand next to the machine while this program runs?*

**Done means:** the answer is written down where the code is — refuse, or require an explicit
acknowledgement — and whichever wins carries a gate with a `--plant` that has been watched red.

✅ **RULED AND LANDED 2026-08-27: it WARNS, in the CLI's own severity vocabulary, and does not
refuse.** The reason is in the code beside it rather than left to be inferred.

**Why not refuse.** The height map counts **gouges** and is blind to material left standing
(`FUNCTIONAL-SPEC.md` H1), and `simulate_and_check` walks the **plan's** arcs rather than the
emitted chords — so a degraded-arc program that cuts across its own bore reports `gouge=0`. A
check with known blind spots that REFUSES becomes a check people route around, and the route
around it removes the number as well as the block.

**What was actually wrong.** `job plate --plant gouge` printed `sim: … gouge=2984`, a first
finding **18.00mm** deep, exit 0, and the whole program on stdout — with **no `warning:` and no
`error:` anywhere.** Two channels carried the fact and neither used the words this CLI reserves
for severity, so a caller that greps `^warning:` or reads the exit code saw a clean run. The
standing test is *would you stand next to the machine while this program runs?* and nothing on
that path made a person answer it.

`run_job` now emits a `warning:` naming the count **and the deepest gouge**, because they are
different questions — 2984 cells at 0.2mm is a cell-size artefact of the finish pass, one cell at
18mm is a cutter through the part — and stating that the program is still emitted and why, so the
line is not misread as a refusal. Clean run: **0** such warnings. Planted: the line, with
`2984` and `18.00mm`. No gate greps `warning:`, so nothing was disturbed.

🟡 **The browser is deliberately unchanged and that is a position, not an omission.** It already
renders the gouge count in `bad` red beside the height-map caveat, which is the visual equivalent
of the line just added to the CLI; the CLI was the gap because a *script* reading stderr saw
nothing at severity. **Download is still enabled on a gouging program** (`App.tsx`, gated on
`!report.gcode` alone). Blocking it would be refusing on the same blind-spotted check, one surface
along — so if that changes, it should change on both doors at once and for a stated reason.

### #132 · Re-plan the physical rungs against #126's answer

Blocked on #126, and named separately so it is not silently absorbed by it. If rung 1
(controller acceptance) is climbed, `README.md`'s status prose, TODO #16 and `CLAUDE.md`'s
🔴 Scope block each say something that is no longer true, and **air cut → foam/MDF coupon → real
ply** still need a machine and **ops** — which is a JOINT run, not something this lane certifies.

🟡 **PART DONE 2026-08-27 — the PROSE half is corrected; the RUNG half is not, and cannot be.**

The three documents no longer claim nothing has been offered to a board, and each correction is
sized to what the record actually supports: *offered and parsed, 47 of 50 lines, `rig=bare`,
nothing moved*. That was doable from here because it is a statement about a record.

⬜ **What is still open is the rung itself, and it needs two people this session is not:**

1. **Re-run the probe** — `--program-command "fixture rect-profile" --operator "<who>"`. Needs
   the bench: the board is on the RPi at `cnc.local` and this box has no `/dev/ttyACM*` and does
   not resolve that name. `tools/controller_probe.py` now refuses to produce another inadmissible
   transcript, so the next run either counts or says why it does not.
2. **~~Ground PG4 / disable AUXINPUT0~~** — **CANCELLED 2026-08-27, pcb:** impossible on this
   build (`SAFETY_DOOR_ENABLE=0`); silence is not alarm (an alarmed board still answers
   `error:9`). Hypothesis: the observed hub-level USB dropout. The re-probe captures
   `dmesg -w` + the raw serial log to settle it. Until all 50 lines are answered, a filed
   transcript reads `rejected: 3` and CTRL fails, correctly.

Then, and only then: **air cut → foam/MDF coupon → real ply**, in that order, never skipped, with
**ops** — and this lane may not self-certify any of them.

⚠ **Do not let the prose correction read as progress up the ladder.** A board parsing our bytes
is rung 1 of four, it happened once, and it is still not admissible to the gate.

### #133 · `AuthGate` is covered by nothing, and the config that opened the hole says so

`web/playwright.config.ts` blanks `VITE_COGNITO_*` for both e2e servers so the suite is not stuck
behind a closed gate. Its own comment: *"NOTHING covers the gate itself — no e2e and no node test
touches AuthGate, so a broken login ships green."* That is the right trade and the wrong resting
place — the suite tests the CAM, and the CAM's precondition is a deterministic app.

**Done means:** `AuthGate`'s own decisions are covered where they can be — no Cognito configured
⇒ gate open, configured + no session ⇒ closed, group/claim handling — in `web/tests/`, against
this lane's own fakes, not against a live identity provider. ⚠ Coordinate: `web/tests/auth.test.ts`
already exists **untracked** and is another session's in-flight work (see #134).

### #134 · Lane hygiene — coordinate, do not sweep

Untracked/modified at the time of the audit: `web/playwright.config.ts` (modified), 14
`web/debug-*.mjs`, `grblhal/`, `web/tests/auth.test.ts`, `gates/ctrl-transcript-2026-08-20.json`.

🔴 **A shared working tree makes "stale residue" and "another session mid-edit" identical on
disk.** `debug-*.mjs` were last written at 18:12, minutes before this audit. Ask the owner what
lands and what goes; nothing here is deleted or committed on their behalf.

**Position taken 2026-08-27, deliberately: NOTHING WAS SWEPT.** Every item is **untracked**, so
none of it ships — this is a tidiness question, not a production one, and it was left alone on
purpose while another session was demonstrably writing to the same files (the SPLNT fingerprint
caught their edits to `web/e2e/*.spec.ts` and `web/src/cad/mesh.ts` **mid-run**).

What each one is, so the owner does not have to re-derive it:

| Path | What it is | The risk if it stays |
|---|---|---|
| `web/debug-*.mjs` × 14 | CDP probes from the 08-27 refusal/gcode debugging session | none while untracked; they are somebody's working notes |
| `grblhal/` | a full grblHAL + STM32F4xx source tree, vendored for the SKR build | 🔴 the real one: it is **large and untracked in a lane whose commits use explicit paths**. It is `pcb`/`firmware` domain, not this lane's, so it is **not** gitignored here — silently blocking a commit the owner intends is worse than an untidy `git status` |
| `gates/ctrl-transcript-2026-08-20.json` | the controller transcript — see #126 | 🔴 it must NOT be moved into `gates/controller/` by anyone but whoever ran it, and not until it is re-recorded with `--program-command` |

⚠ **The one thing that is NOT hygiene:** `web/playwright.config.ts` blanks the Cognito triple for
both e2e servers, and its own comment named the hole that opened — *"NOTHING covers the gate
itself"*. **That hole is closed (#133)**, and closing it found that the gate failed open on a
partial config. The blanking stays: the suite tests the CAM, and the CAM's precondition is a
deterministic app, not a live identity provider.

---

### #135 · 🔴 OPEN QUESTION: which side was right about the Pitbull's footprint

Raised 2026-08-27 by the work that made it impossible to see. `workholdingShape.tsx` and
`workholding.ts` disagreed about `machinable-low-profile-clamp`:

```
catalogue (reaches ClampCfg, gate P7)   footprintMm: [25.4, 18.0]
drawing   (what the operator sees)      footprintMm: [18, 25.4]
```

**The axes are transposed.** The fix removed the second table — the drawing now derives from
the catalogue — so the picture and the keepout can no longer disagree. 🔴 **That did not answer
which one was correct**, and deriving is exactly the move that could launder it: if the
CATALOGUE is the transposed one, the app now draws a wrong box *and* checks against it, and the
disagreement that was the only evidence of a problem is gone.

**What is needed:** re-read the vendor drawing. The catalogue cites
`https://www.newmantools.com/miteebite/m_pitbull.htm`, read 2026-08-08, models MB.26077
(machinable) / MB.26075 (standard, same body), and states 6.35mm height. Confirm which dimension
runs **across the sheet edge** and which runs **along it** — `Shape.footprintMm` is documented as
`[across, along]` and `Workholding.footprintMm` must mean the same thing or the derivation is
wrong in a second way.

**Why it matters physically:** this is steel at 43 RC standing on the bed. `Fixturing::check`
walks every move against that box, so a 7.4mm error in the wrong axis is 7.4mm of clearance the
program believes it has. `obstructs: true`, so there is no draw-only escape hatch — the test
refuses one deliberately.

⚠ **Two more of the same shape, lower stakes, same question:** `double-sided-tape` carried
`heightMm` 0.13 (catalogue) against 0.127 (drawing) — 0.127mm is 0.005" exactly, so the
catalogue's 0.13 looks like a rounding that became a fact. Both tape entries' `[0, 0]` keepouts
are *correct* (they obstruct nothing) and are now declared draw-only overrides with their reason.

**Route:** the vendor page is `bom`'s to re-read, not this lane's to guess.

---

### #136 · ✅ `maxCuttingFeed` walked the plan — closed 2026-08-28 by computing it in the core

Raised 2026-08-27 alongside #131's sibling fix. `SummaryPanel`'s spindle row now reads the
**emitted program**; the feed row still walks `report.render`, which is built from the same
`path.moves` the post then walks — the plan, one step before the bytes. It is **also short by
every drilling feed**: `MoveKind::DrillCycle` renders as `kind: 'drill'` and is not in the
filter, so a job whose fastest commanded feed is a canned cycle's under-reports, and a drill-only
job shows no row at all.

🔴 **It was NOT fixed the same way, deliberately.** Reading `F` words back requires deciding
*which* `F` words are cutting feeds — a `G38.2` probe seek is not a cut — and that rule lives in
`core/src/feeds.rs::feed_role_of_line`, whose header says it is in the core **precisely so a host
does not become the second copy**. It is not exported by `wasm/src/lib.rs`, so the panel cannot
ask it. A TypeScript re-derivation would display a probe seek `F200.0` as the cutting feed on a
job whose finishing pass is slower — a wrong number, confidently, on the operator's summary.

⚠ Adding `'drill'` to the existing filter was also refused: it would change a displayed number
without addressing the plan-vs-bytes defect, which is the half-fix that makes the row look
attended to.

**Needs:** `feed_role_of_line` (or a `cutting_feeds(gcode)` built on it) exported through
`wasm/src/lib.rs`. Then the feed row reads the program the same way the spindle row now does.
The gap is written into the function's own doc comment and into
`web/tests/summary-panel.test.ts`'s header, so nothing reads as covered.

✅ **DONE 2026-08-28 — and "needs someone else's change" was wrong.** The refusal above was
right about the rule and wrong about the remedy: the answer did not need **exporting**, it needed
**computing in the core**. `feeds::cutting_feeds_in_program` reads the emitted bytes there — where
`feed_role_of_line` already lives, so nothing is copied — and `Report.cutting_feeds_mm_min` is
filled from the same string `gcode` carries, so the two cannot describe different programs. The
panel now displays an answer instead of deriving one.

**What changed on screen, and it is three states rather than a number:** the row was rendered
under `feed != null`, so *"this program commands no feed"* and *"the derivation missed it"* were
the same blank space. It is now unconditional — `no program` / `not commanded` / `3600 mm/min` /
`3 feeds: 300, 1800, 3600 mm/min`. **A list, not a maximum:** *"the fastest number in the file"*
and *"the feed this job cuts at"* are different claims and one figure cannot say which is being
given. Measured in the built app after a wasm rebuild: `2 feeds: 4800, 300 mm/min`.

**Six core tests + five render tests, both halves watched red:** removing the probe exemption in
the core fails `a_probe_seek_is_not_a_cutting_feed`; collapsing the list in the panel fails
`several distinct feeds are LISTED, never collapsed to the fastest`. One core test is driven
through the **real emitted fixture** and asserts the report's field and the function cannot
disagree, with a vacuity check that the fixture actually probes.

⚠ **Still true and worth keeping:** these are the feeds the program COMMANDS, not the feeds the
machine achieves — grblHAL clamps to `$110–$112` and ramps through every corner, neither of which
is in the file.

### #137 · 🟡 A saved record snapshots a catalogue number and keeps the catalogue's name — PLATES done 2026-08-28, CLAMPS open

Raised 2026-08-27 by the second-copy audit. ⚠ **This paragraph said "not fixed" for both halves
until 2026-08-28; the plate half is done and the clamp half is not.** The wiring was confirmed by
reading rather than by a witnessed failure — it needs a catalogue edit *after* a save to show
itself.

* **Clamps** — `App.tsx` copies `fw`/`fh`/`heightMm` out of `workholding.ts` into the clamp and
  names it `${chosen.id}-N`. A later correction to the catalogue never reaches a saved job's
  clamps, and the clamp still wears the catalogue id, **so the record looks sourced**.
* **Touch plates** — `touchPlateMm` and `touchPlateId` restore independently, and the picker then
  renders `p.topMm` from the **live** catalogue beside the **saved** number. The saved one is
  what reaches `touch_plate_mm`, and therefore the probe's Z datum in the emitted program.

⚠ **The app already gets the typing case right, which is why this is worth fixing rather than
arguing about:** typing a thickness *clears* `touchPlateId`, with the reason written out —
*"Keeping its name beside a hand-typed thickness would be a false provenance."* The restore path
has no equivalent, and nothing checks it. #135 is the same class one level up: a number whose
provenance is asserted by a name rather than by a check.

✅ **TOUCH PLATES DONE 2026-08-28.** `plateProvenance(id, thickness)` answers it in one place, and
returns **five** states rather than a boolean — `unnamed` · `unknown` · `undeclared` · `agrees` ·
`diverged` — because *"the entry publishes no top, so there is nothing to disagree with"* is not
*"checked and agrees"*, and collapsing those two is the E5 collapse one level down. On restore, a
`diverged` or `unknown` id is **dropped and announced**, naming both figures: the **thickness is
kept**, because it is the machining number and it is what reaches the probe's Z datum, and only
the *claim about where it came from* is withdrawn. A provenance that vanishes without a word is
the same defect wearing the other face.

7 tests, incl. a vacuity check that the catalogue actually contains an entry publishing a top —
without it every case below would pass by never reaching its branch. Watched red: forcing
`agrees` fails the two tests that encode divergence and leaves the other five green.

⚠ **And the units sweep caught my own new string** — the message embedded a raw `${x}mm` readout,
which is unconverted for an operator working in inches. Routed through `formatLength`. Worth
recording because it is a guard added earlier the same day doing exactly what it was for, to the
person who added it.

⬜ **CLAMPS ARE STILL OPEN**, and are the harder half. A clamp copies `fw`/`fh`/`heightMm` out of
the catalogue and keeps `${chosen.id}-N` as its name, so the record looks sourced — but unlike the
plate there is no single field to compare: a clamp is a *snapshot of several*, and it may have
been legitimately edited since (rotation, position, and #65 offers a clone at +10mm). The plate's
rule does not transfer, and inventing one that silently drops a clamp's name would be worse than
the defect. Needs a decision about what a clamp's `id` is claiming in the first place — which is
#135's question, and should be answered with it.

### #138 · ✅ A pixel-diff e2e assertion flaked under load — closed 2026-08-28 by determinism

Observed 2026-08-28 during the round-four verification. `web/e2e/slicer.spec.ts` *"the cutter at
the head has its own layer chip, and hiding it changes the canvas"* failed once inside a full
suite run:

```
Error: hiding the cutter changed pixels away from the marker — the chip is repainting
       something other than the cutter, or the published probe is
Expected: 0   Received: 1029
```

**It is a flake, and the evidence is stated rather than assumed:** it passed alone immediately
after, it passed in the full run immediately before (98/0), and it passed in the full run
immediately after (99/0). The assertion compares WebGL canvas pixels outside a marker region on a
box that runs a five-session fleet and was simultaneously running a gate.

🔴 **Not fixed, because the fix is a decision I should not make alone.** Raising a tolerance on a
pixel assertion weakens the only check that the chip repaints the cutter *and nothing else*, and
this lane's own rule is that a false red trains the habit that defeats the gate — *"a guard that
fires on the wrong condition trains the habit that defeats it"*. The options are: a small pixel
tolerance with a stated reason, a retry with the retry recorded (a green on attempt 2 is not the
same fact as a green on attempt 1), or pinning the renderer for this one test.

⚠ **The reason it matters more than one flake:** gate `I1` reports the browser suite's failure
count and nothing distinguishes a flake from a defect in that number. Today's run would have
printed `I1 FAIL browser suite: 1 failed` and a reader would have gone looking for a regression
that is not there. #129 already bought a readable red by pinning `workers: 1`; this is the same
argument one test along.

✅ **FIXED 2026-08-28 BY DETERMINISM, NOT BY A TOLERANCE.** The cause was a race, not a threshold:
`capture()` read the GL buffer **once, immediately**, and the viewport runs an unconditional
`requestAnimationFrame` loop — so two captures either side of a click can land on different frames
of an in-flight render. `capture()` now reads, waits a frame, reads again, and accepts only two
identical consecutive frames.

🔴 **A pixel budget was refused, and the reason is the assertion's job.** `far === 0` is what makes
the assertion above it *about the cutter*: loosen it and *"hiding the cutter changed the canvas"*
is equally satisfied by the camera drifting or the hidden-count banner reflowing the layout. A
tolerance would have made this test quieter and blinder in the same edit.

⚠ **A scene that never settles FAILS with that sentence**, bounded at 30 frames, rather than
timing out — because *"the renderer will not sit still"* and *"the toggle did nothing"* are
different findings and this test can only speak to the second.

⚠ **The evidence is weaker than the fix.** 3/3 alone and 99/0 in a full suite since. The flake was
rare and load-dependent, so N clean runs is not proof — what carries this is that the race it
removes is the mechanism that produced the observed failure, not the absence of a recurrence.

### #142 · ✅ RUN-18 — the founder decision I asked for was NOT NEEDED, and the id was wrong too — MEASURED 2026-08-28

Raised 2026-08-28 as *"FOUNDER DECISION: a fake transport inside the streamer worker"*. **Both
halves of that framing were wrong and both are corrected here rather than deleted.**

🔴 **THE ESCALATION WAS A FALSE DICHOTOMY.** I established a true fact — `streamer.worker.ts`
acquires its port itself from `self.navigator.serial` by index, so no page-level seam can reach it
— and drew a false conclusion from it: that the fake must therefore live INSIDE the shipped worker.
That only follows if the test must drive the PRODUCT's worker instance. It need not. A **test-only
worker entry** in `e2e/` can install the stub on its own global and then `import` the real,
unmodified module; `streamer.worker.ts` then ships byte-identical. `ceo` reached the same option
independently and declined to route the question (`handover/2bee_app/2026-08-28-ceo-do-not-spend-
the-founder-ruling-yet-there-is-a-third-option-in-test-land.md`), and another session had already
built it under `web/e2e/run18/`. **I turned a constraint on one approach into a constraint on all
of them, and asked the founder to rule on a choice that was not forced.** That spends attention
badly and biases the answer toward the two options presented, because the asker sounds certain the
trade is necessary.

⚠ **AND THIS ITEM WAS FILED AS `#139`, WHICH WAS ALREADY TAKEN** — see the note at the head of this
section. `gates/slicer_gate_check.mjs` cited *"TODO #139"* and a top-down reader lands on
`## 🔴 #139 · We are STRICTER than OpenSCAD on a 2D operand in a boolean`, an unrelated open item.
The handover to `ceo` carried the same wrong pointer.

**What is still true:** the recorded blocker for RUN-18 named `App.tsx` — a fix that cannot work —
and said *"needs a browser"* long after Playwright started driving this suite. That correction
stands, and the reasoning below is kept because the founder-decision framing is the part that was
wrong, not the analysis of the worker.

**State:** ✅ MEASURED 2026-08-28. Both of `ceo`'s checks answered: (1) **vite dev DOES serve a
second worker entry from test-land** — `new Worker('/e2e/run18/streamer-fake.worker.ts',
{ type: 'module' })` against the dev server gets the entry and its whole import chain transformed;
the built bundle never contains it (nothing references it), which is exactly why the spec runs
against the dev server and not the preview. (2) **The spec spawns the test entry DIRECTLY**, so the
green measures the worker module, not the Run tab's `connect()` wiring — and the spec's output line
says so, with the fake's persona. Numbers: hidden/visible throughput ratio **0.771** (1.49 → 1.15
MB/s over 2M-line legs), **zero stall events**, hidden leg verified real (`visibilityState ===
'hidden'`, page timers throttled to 3 ticks/2 s). The environment findings that made it possible —
headless never hides, Playwright's attach emulates focus, Playwright's default args disable the
throttling under test, ozone/x11 does not hide on minimize, a tab switch over RAW CDP does — are in
the spec's header (`web/e2e/run18.spec.ts`). 🔴 **The green is against `fake.ts`** — this lane's
own model of grblHAL — and is not a green against a machine; the standing honesty line stays in the
gate. Still unmeasured: the same question against a real controller (CTRL), and whether a hidden
page throttles the WORKER's own timers (the status-poll interval).

## What RUN-18 is

*"Throughput survives `document.visibilityState === 'hidden'`."* The design calls it **the branch
that decides the architecture**, and `streamer.worker.ts`'s own header says why in one sentence:

> Chrome throttles `setTimeout`/`setInterval` in hidden pages — ~1 s when hidden, and up to ~1 min
> under intensive throttling. **A streamer built on a timer pump stalls the moment the operator
> switches tabs, and a stalled streamer leaves a turning cutter stationary in the work.** That
> burns the edge and, on a small cutter, snaps it.

The sender is a Worker *because of that*, and the loop is driven by I/O completions rather than a
timer. **The assumption has never been measured.** That file says so itself.

## What the blocker actually is — corrected, because it named the wrong file

The gate said RUN-18 *"needs a browser AND a transport seam reachable from the served page;
`App.tsx` passes `RunTab` a program and no transport"*. Both halves were wrong:

* **"needs a browser" is stale.** Playwright has driven this suite since 2026-08-27.
* **A page-level seam is PROVABLY INSUFFICIENT.** `RunTab` *does* have a `navigatorLike` prop —
  but `streamer.worker.ts::attach` acquires the port **itself**, from `self.navigator.serial`,
  **by index** (`portIndex` on the `attach` command). The page never transfers a port object. So a
  fake injected at `App.tsx` reaches the availability check and **nothing else**: the streaming
  path this branch is about never sees it. Adding that prop would have produced a green that
  measured a different thing.

## The decision

Measuring RUN-18 requires a **fake transport inside the streamer worker, in the served product** —
the lane's most safety-critical file. That is not a wiring gap, and it is not mine to take:

* **For:** it is the only way to measure the assumption the whole sender rests on, and it needs no
  hardware. The precedent exists — the plant control and the fixture picker are gate instruments
  behind `?plants=1` / `?fixtures=1`, off the operator surface (#27).
* **Against:** it puts a path into the shipped streamer whose whole purpose is to *not* talk to a
  real machine, in the file where a mistake stops a cutter in the work. `?plants=1` guards a
  planner defect; this would guard the thing that drives the spindle.

⚠ **Either answer is defensible and the current state is not:** the assumption is unmeasured, and
until 2026-08-28 the reason recorded for that pointed at a file where the fix could not work.

**Not blocked on hardware.** Distinct from #126/#132, which need the bench.

---

## 🔴 CORRECTION, SAME DAY: THE ABOVE IS A FALSE DICHOTOMY

**There is a third option, it needs neither a product change nor a ruling, and another session was
already building it while this ticket was being written.** `web/e2e/run18/` (in the tree, untracked
at the time of writing):

```
streamer-fake.worker.ts   // TEST-ONLY worker entry. NEVER referenced by the product.
                          //   import './install-fake-serial';
                          //   import '../../src/run/streamer.worker';
install-fake-serial.ts    // defineProperty(self.navigator, 'serial', fake)
fake-serial-port.ts
```

The test constructs **its own worker** at a URL nothing in the product references, installs the
fake on **the worker's own `navigator`**, and then imports the **real, unmodified**
`streamer.worker` module. Sibling ES modules evaluate in source order, and the worker reads
`navigator.serial` inside its `attach` handler rather than at module scope — so the stub only has
to exist before the first `attach` arrives.

**`src/run/streamer.worker.ts` ships byte-identical.** The objection this ticket was raised on —
*"it puts a path into the shipped streamer whose purpose is to not talk to a real machine"* —
does not apply, because there is no such path.

⚠ **What I got wrong, and it is the transferable part.** I read "the worker acquires the port
itself, so a page-level seam cannot reach it" and concluded the fake had to go *inside the shipped
worker*. That followed only if the test had to use the product's worker instance. It does not: a
test can build its own entry around the same module. **I turned a constraint on one approach into
a constraint on all of them, and escalated the false choice to the founder.** Asking someone to
rule on a dichotomy that is not one costs their attention and biases the answer.

✅ **Status: PROVEN, 2026-08-28.** The probe answered both questions it was written with. The
mechanism landed exactly as sketched above — the spec (`web/e2e/run18.spec.ts`) spawns the
test-only entry directly and streams the real worker module against the `healthy` persona. The
harder half turned out to be the VISIBILITY leg, not the bundler: three plausible mechanisms were
measured to NOT produce a hidden page (headless-shell, full-chromium `--headless=new`,
minimize-under-ozone/x11) before the one that does — a second tab activated over a **raw CDP
WebSocket**, with Playwright's focus emulation and its throttling-disabling default args out of the
way. All of it is recorded in the spec header, so the next lane does not have to re-derive it.
Result: **ratio 0.771 hidden/visible, zero stalls** — the I/O-driven pump survives a hidden tab,
against the fake. The ruling below is not required, and was never spent.

## #144 · ✅ CLOSED 2026-08-29 — CAM ran on the MAIN THREAD while the README claimed a Web Worker

Raised 2026-08-28 by the end-to-end review, and corrected in `README.md`'s stack table the
same day. The row read **"WASM in a Web Worker — slicing must not block the canvas"**. It had
never been true: `web/src/cam.ts:11-38` `import()`s the wasm glue and awaits `m.default(...)`
on the main thread, and the only `Worker` under `web/src` is `run/streamer.worker.ts`, which
streams G-code to the machine and does no CAM at all.

**What this costs, stated at its real size.** It is a RESPONSIVENESS defect, not a safety one.
The emitted program is identical whichever thread produced it, and gate `K3` proves the browser
and the CLI were built from the same core, so nothing here can cut a wrong part. What it does
is freeze the canvas while a large drawing is planned — exactly the thing the row said it
prevented, with the reason correct and the mechanism absent.

**Why the row was corrected first, and the code a day later.** Moving CAM into a worker looked
like it turned every call site in `App.tsx` into an async message round trip. Measured before
starting, it did not: **all 18 exports that touch the core were ALREADY `async`**, and the five
synchronous exports are pure TypeScript that never touch it. So the refactor is contained inside
`cam.ts` — the call sites in `App.tsx`, `Viewport.tsx`, `store.ts` and `runProgram.ts` are
unchanged, because they were already awaiting a Promise and it now resolves from another thread.

---

### ✅ DONE 2026-08-29 — and it found a real staleness defect on the way

`web/src/cam.worker.ts` owns the wasm; `cam.ts` owns the protocol (`{id, fn, args}` →
`{id, ok, out|err}`). **No silent fallback to the main thread**: if the Worker cannot be
constructed, `cam.ts` throws by name. A fallback would be the kinder-looking choice and would
re-create the exact defect being fixed, invisibly — the app would keep working, the canvas would
freeze again, and nothing would say which path it took.

**Build change:** `vite.config.ts` gains `worker: { format: 'es' }`. The worker `import()`s the
wasm glue, which makes its bundle code-split, and rollup refuses that under the `iife` default.
It is a build failure so it cannot ship silently — recorded because the error names rollup rather
than the setting.

🔴 **THE DEFECT THIS SURFACED, which is worth more than the fix.** The first run of the browser
suite came back **98 passed, 2 failed**, both `MOVE`-class: *"the datum did not reach the
program"*, received difference **0** after a 40mm datum change. The tests were right.
`SummaryPanel` derived its status word from `report.ok` alone, and `report` holds the LAST
COMPLETED plan — so while a re-plan was in flight the panel said **`runnable`** over a program
computed from settings the operator had already changed, with the G-code view and the download
button describing the same stale job.

⚠ **That was ALWAYS possible and was too fast to see.** On the main thread a plan completed inside
one microtask, so the stale window was invisible; the worker turned it into milliseconds. And it
means the suite's `expect(status).toHaveText('runnable')` had been **a wait for a condition that
was already true** — vacuous for as long as it existed.

Fixed where the defect is: `SummaryPanel` takes `busy` and shows `planning…` while a re-plan is
running, so the status word is about the program on screen rather than about a previous one.
**100/100 browser tests pass**, and the two that failed now fail for real if the status lies.

⚠ The SAME gap was on the **download button**, and that is the surface that matters more: a label
that is briefly wrong gets read again, a **file** that is briefly wrong goes to the machine. It was
`disabled={!report.gcode}` — nothing about `busy` — so during a re-plan an operator could save a
`.nc` computed from settings already changed, with the panel beside it showing the new numbers.
Now `disabled={!report.gcode || busy}`.

### ✅ And the gap that ticket named is closed too — 2026-08-29

The ticket said: *"nothing yet stops a stale result being applied if two plans are ever in flight
at once. The worker processes messages in order so responses return in order, and `replan` is the
only caller — but that is an argument, not a check."* Both halves of that argument were true and
neither was a check. **Ordering says nothing about which REQUEST a late answer belongs to** — a
rejected promise, a retry, or a second caller added later all break it — and *"the only caller"* is
a fact about today's code.

`replan` now takes a generation: `const mine = ++planSeq.current`, and `current()` gates BOTH the
apply and the `finally`. Two failures it stops, both silent:

1. The FIRST answer landing after the second and overwriting the newer report — the stale-program
   defect arriving through the back door after the front one was shut.
2. The first plan's `finally` clearing `busy` while the second is still running, so the status
   reads `runnable` over a plan in flight — re-opening exactly what gating it on `busy` closed.

`web/tests/replan-generation.test.ts` models the rule and asserts both behaviours (plant-tested:
removing the guard from the model fails both), plus a text check that `App.tsx` still carries it.
⚠ The two halves fail differently and only both together mean anything: the model proves the RULE,
the text check proves it is still WIRED, and neither renders React — `App.tsx` cannot be imported
in node.

⚠ The guard is on the paths that `await`, and only those. The two early returns (`no drawings`,
`no tools`) have nothing awaited before them, so a check there would be vacuous — **and
`config-wiring.test.ts` asserts the exact shape of the zero-tool guard, which an inserted line
breaks.** That test caught it; the vacuous guards were reverted rather than the test's needle
edited, and `App.tsx` now records what has to change if an `await` is ever moved above them.

## #145 · Gate MARK reads the PLAN, not the emitted program

Raised 2026-08-28 by the end-to-end review. `gates/slicer_gate_check.mjs` asserts MARK against
the plan-side `render` output produced by `core/src/fixtures.rs`, not against the G-code the
post emits. That is one doctrinal violation sitting inside the harness that enforces the
doctrine — this lane's standing rule is **assert on the emitted program, never on the setting
that was supposed to produce it**, and it has been bitten by that shape five times (`ENT`, `P4`,
`P3`, the `JobSummary` walked off `path.moves`, and `EntryMode::Helix` aliased to `Ramp`).

**Blast radius is small and is not zero.** Marking is cosmetic — a wrong or missing part ID
sorts 36 identical blanks wrongly; it does not put a cutter anywhere. That is why this is a
ticket and not a fix made under the same commit as the safety work. **The two acceptable
closes are:** re-point MARK at the emitted text, or annotate the gate's own row to say it reads
the plan, so nobody quotes it as evidence about a program. Silently leaving it as-is is not one
of them, because the row currently reads like every other emitted-program gate beside it.

## #146 · ✅ CLOSED 2026-08-29 — `group_by_tool` decided inner-vs-outer by SUBSTRING MATCH ON A FILENAME

Raised 2026-08-28, measured rather than reasoned. `toolpath::group_by_tool`
implements decision #33 — *"when a tool group would contain both inner and outer
operations for the same part, the group is SPLIT so the inner operations complete
before the outer profile begins"* — and it decides which is which like this:

```rust
// Simple heuristic: operations named "...-holeN" or "...-inner-N" are
// inner; the base name without suffix is outer.
.filter(|op| !op.name.contains("-hole") && !op.name.contains("-inner"))
```

Operation names are built as `format!("{}-hole{}", part.name, i + 1)` for inner
loops and `part.name` for the outer profile, and **`part.name` comes from the
drawing's filename**. So the classification is a substring match against a string
the operator chose.

**MEASURED, both cases, same tool, same geometry:**

```
  BENIGN   part "plate"            -> [("A", ["plate-hole1"]), ("A", ["plate"])]        SPLIT
  HOSTILE  part "sensor-hole-jig"  -> [("A", ["sensor-hole-jig-hole1",
                                             "sensor-hole-jig"])]                        NOT SPLIT
```

The outer profile of `sensor-hole-jig` contains `-hole`, so it is classified as
INNER, `outer_names` comes back empty for that part, and the split does not
happen. **The stated guarantee is silently void for any part whose name contains
`-hole` or `-inner`** — `left-hole-plate.dxf`, `sensor-hole-jig.dxf`,
`inner-frame.dxf` are all ordinary filenames.

⚠ **STATED AT ITS MEASURED SIZE, NOT ITS WORST IMAGINABLE ONE.** In the two
three-operation cases driven here the EMITTED ORDER was identical either way
(`hole1`, outer, `other-hole1`) — what changed was the number of tool-change
boundaries, because within a group `order_operations` has already put inner
before outer, and the split's cross-part guarantee is explicitly disclaimed in
the same doc comment. **So this is a latent defect, not a demonstrated wrong
program**, and it is filed rather than hot-fixed for that reason. What is
certainly true is that a safety-relevant classification depends on a filename and
fails silently — and gate `REL`, which guards this failure, drives fixture parts
whose names never contain either needle, so it is a control tested only where
right and wrong agree.

**The fix is not a better regex.** `Operation` should carry the role explicitly —
the planner already KNOWS which loop is the outer profile when it builds the
name, and then throws that away and re-derives it from text downstream.

---

### ✅ FIXED 2026-08-29 — the role is a field now

`Operation` carries `part: String` and `role: OpRole { Interior, Releasing }`.
`operations_for_part` states both where it already knows them, and
`group_by_tool` reads the fields — no substring match anywhere in the product.
**`OpRole` has deliberately no `Default`**: a default would pick a side silently
at every construction site that forgot, which is the same failure arriving
through a different door, so all 30 construction sites had to say which they are.

🔴 **A second misclassification fell out of the same change, and it was live.**
Marking operations are named `{part}-mark{N}`, which contains neither `-hole` nor
`-inner` — so under the old heuristic **every engraved character was classified as
an outer profile, i.e. a releasing cut**. An engraved character removes a few
tenths of a millimetre and frees nothing. They are `Interior` now.

**Two measurements hold the change to its size:**

1. All **10** reference programs (4 fixtures + 6 jobs) are **byte-identical**
   before and after. The refactor changed no emitted program — which is the
   point: the heuristic and the field agree on every case the fixtures reach,
   and the divergence was always in the cases they do not.
2. The new test drives what no fixture can — parts named `sensor-hole-jig`,
   `inner-frame`, `left-hole-plate`. **Plant-tested:** restoring the old
   substring classification inside `group_by_tool` makes it fail with
   *"part \"sensor-hole-jig\": interior work and the releasing cut share a tool
   and were NOT split into two groups"*, and the fixed code passes. It also
   asserts specificity twice — the benign case still splits, and interior work
   with no releasing cut in the group is NOT split, because a splitter that
   splits everything buys tool changes and proves nothing.

### Where the reachability actually is, measured 2026-08-29

⚠ **The first write-up of this ticket said the part name comes from "the
drawing's filename" and left the door unnamed. Measured, it is true on two paths
and false on the two that matter most:**

```
import <file>            -> route-parts: drawing/part2<-drawing/part2-hole1|…   SYNTHETIC
browser (planImportMany) -> id: `${wi}:${d.instance}`                            SYNTHETIC
nest --drawing <file>    -> route-parts: gate-rel-sensor-hole-jig/part2<-…      THE FILE STEM
layout --drawing <file>  -> same (`p.id.unwrap_or_else(|| label_for(&p.path))`)  THE FILE STEM
```

So the defect was reachable through **`nest` and `layout`**, with an ordinary
filename and no flags, and **not** through `import` or the browser. Recorded
because "reachable from a filename" and "reachable from the CLI nest door" are
different sizes, and only the second one is true.

### 🔴 The gate that holds this is `G0`, NOT `REL` — and that was measured, not assumed

REL was taught to drive the hostile filename (`nest, filename containing
\`-hole\``). Then the old name-substring classifier was planted back into
`group_by_tool`, the release binary rebuilt, and the suite re-run:

```
53 passed, 2 failed  —  FAIL G0, FAIL K3 (K3 = the stale wasm from the planted build)
PASS REL  … nest, filename containing `-hole`: 6 sections, 2 tool run(s) = 1 change(s),
            no part worked on after its release
```

**REL passed with the defect planted.** `optimise_route` topologically sorts the
tool groups before any of this matters, and on this drawing it produces a safe
order either way — the split moves where the group BOUNDARIES fall, not the order
the cuts come out in. What went red was `G0`, on
`toolpath::tests::the_release_split_is_decided_by_role_and_not_by_what_the_drawing_is_called`.

⚠ **The REL case is KEPT and RELABELLED** rather than deleted: it exercises the
`nest` door end to end for free, and its row now says *"exercised, NOT
discriminating — G0 holds #146"*. A case that passes either way, described as a
control, is worse than no case at all.

✅ **So the ticket is closed and the coverage is named**: #146 is gated by `G0`.
It is not gated by `REL`, and this file says so instead of implying otherwise.

## #147 · ✅ CLOSED 2026-08-29 — a non-finite MACHINE or WORKPIECE removed the spoilboard clamp

Found while closing #146's sibling (`nonfinite_params_refusal`, 2026-08-28) by
asking the question that finding should have prompted and did not: *the operation's
own fields are guarded now — what about the machine and the workpiece?*

**MEASURED before the fix.** One 40×40 outside profile, everything else at its
default:

```
stock.thickness_mm = NaN  ->  289 moves, cut to Z-18.000, ZERO refusals
stock.size_x_mm    = NaN  ->  289 moves,                  ZERO refusals
machine.safe_z_mm  = NaN  ->    0 moves, REFUSED
```

🔴 **`thickness_mm` is the spoilboard clamp.** Both planners cut
`depth_total_mm.min(stock.thickness_mm + 0.3)` and **`f64::min` returns the
non-NaN operand** — so a NaN thickness does not clamp to nothing, it **removes
the clamp**, and the requested depth goes through untouched. The *"depth clamped
from X to Y — deeper is the spoilboard"* note beside it stayed silent too,
because `NaN > x` is `false`. The output is 289 ordinary-looking moves.

🔴 **`size_x_mm`/`size_y_mm` are the workpiece bounds**, and every off-material
comparison against NaN is `false` — so *"the cutter is outside the workpiece"*
does not fail, it **stops being able to fire**.

⚠ **Why `safe_z_mm` was already caught, and why that is the whole lesson.** It
becomes a COORDINATE, so `nonfinite_refusal` sees it in the emitted moves. A
value consumed by a **clamp or a comparison** never appears in the output at all,
and no check on the output can ever see it. That is the line: assert on the
emitted program by default; refuse on the FIELD exactly where the field cannot
reach the program.

**Fixed:** `nonfinite_setup_refusal` checks 22 `Machine`/`Stock` fields plus the
two `Option` ones when present and every `spare_collets_mm` entry, and is armed
ahead of the params check at BOTH planner doors — a drill takes the same setup
through a different function, and one door guarded is not the door guarded. Test
drives 4 fields × 2 doors and asserts specificity (an ordinary setup is not
refused: a door that refuses everything agrees with nothing).

All 10 reference programs remain **byte-identical**.

## #148 · ✅ CLOSED 2026-08-29 — the tool validator was blind to the one value that is nonsense by construction

Third instance in two days of the same class (after #147 and the
`nonfinite_params_refusal` of 2026-08-28), and this one is in the validator
itself.

`ToolSpec::faults()` exists to refuse a cutter whose numbers make no sense. Every
check in it is a COMPARISON:

```rust
if t.diameter_mm <= 0.0                                   { NonPositiveDiameter }
if t.chipload_min_mm > t.chipload_max_mm                   { ChiploadWindowInverted }
else if t.chipload_mm < t.chipload_min_mm || … > …         { ChiploadOutsideWindow }
if t.rpm_min > t.rpm_max                                   { RpmRangeInverted }
if t.cutting_length_mm < t.diameter_mm && …                { CuttingLengthShorterThanDiameter }
```

🔴 **Every one of those is `false` for NaN.** A tool whose numbers were all NaN
came back with an **empty fault list** — not `<= 0`, not inverted, not too short,
just absent — and was added to the library. Then `by_category` sorted it with
`partial_cmp(..).unwrap()`, which **panics** on NaN, and a panic in the browser
host poisons the wasm instance.

**Fixed:** `ToolFault::NonFiniteDimension`, checked FIRST and short-circuiting,
over all ten numeric fields including the two `Option` angles; `by_category`
sorts with `total_cmp`, because a sort is not the place to discover the door
failed. Test drives every field one at a time — a guard that covers the first
field and not the rest is the same blind spot one column over — and asserts
specificity. Plant-tested by removing the guard.

⚠ **NOT REACHABLE THROUGH ANY DOOR TODAY, and that is measured, not assumed.**
`serde_json` refuses `NaN`/`Infinity` outright and rejects `1e999` with *"number
out of range"* (`exit=2`, 0 bytes on stdout — driven); the browser's
`JSON.stringify` turns both into `null`, which does not deserialise into an
`f64`. Fixed anyway because a validator blind to NaN is a trap armed for whoever
adds the next input path, and the fix is four lines. **Recorded as latent, not
claimed as a live bug.**

⚠ Two neighbouring `partial_cmp(..).unwrap()` sites were checked and are SAFE,
for a reason worth writing down rather than re-deriving: `import.rs::to_parts`
sorts by area behind `.filter(|(a, _)| *a > 1e-9)`, and `tools.rs::drill_for_hole`
sorts behind `.filter(|t| (d - hole_d).abs() <= tol_mm)` — **a NaN fails both
filters and never reaches either sort.** The same property that hides NaN from a
validator removes it from these two.

## #149 · ✅ CLOSED 2026-08-29 — an SVG `transform` moved the part and nothing said so

`transform=` is parsed **nowhere** in `core/src/import.rs`. An SVG carrying
`<g transform="translate(50,20)">` — what every drawing tool emits for a moved or
rotated group — was imported with the transform **silently ignored**, so every
child landed at its untransformed coordinates.

🔴 **That is not a dropped feature, it is a WRONG PART.** The contours are real
contours; they post, simulate, gate green and cut. Nothing downstream can notice,
because being in the wrong place is not a property any downstream check reads.
Measured with the fix removed and the gate re-run: **6,953 bytes of G-code
emitted** from geometry at the wrong coordinates.

⚠ **Why gate F1 never saw it, and it is the same shape as #146.**
`gates/fixtures/plate.svg` uses `<rect>`, `<circle>` and `<svg>` and carries no
`transform` — so on the only SVG this gate has ever read, a reader that applies
transforms and one that ignores them give the same answer. **A control tested
only where right and wrong agree is untested.**

**Fixed by REFUSING the document, not the element.** A transform on a `<g>`
applies to its children, and this parser walks tags FLATLY with no nesting model
— it cannot tell which elements a group's transform covers. Skipping only the tag
that carries the attribute would drop the group and import its children
misplaced: the same wrong part with a note attached. So an SVG carrying any
`transform` imports **nothing**, names the element and quotes the value, and says
how to flatten it.

**Two more silent drops closed in the same loop**, both in the `_ => {}` the SVG
element dispatch ended in — the DXF entity loop has always named its unknowns:

* **`<line>` is geometry now.** It was in the catch-all: the shape a drawing tool
  emits for an open profile or a construction edge, dropped without a word.
* **Unknown elements are NAMED** (`<image>`, `<text>`, `<use>`…), while
  structural and metadata tags stay silent — a note on every drawing is a warning
  nobody reads.

Gate F1 now drives a transformed SVG and requires a refusal with **0 bytes**;
plant-tested by removing the fix and watching F1 go red on
`svgTransformBytesEmitted=6953`. Three unit tests, one asserting specificity (an
ordinary drawing must not be refused). All 10 reference programs byte-identical;
730 rust tests, 0 failed.

## #150 · ✅ CLOSED 2026-08-29 — the SVG Y flip used the WORKPIECE height, so changing the sheet moved the part

The worst one found this week, and it shipped a runnable program.

SVG's Y axis points down and the machine's points up, so an import has to flip.
`parse_svg(text, height_mm, tol)` flipped about the caller's `stock.size_y_mm` —
**a number that has nothing to do with the drawing.**

**MEASURED** on `gates/fixtures/plate.svg` (which declares `height="900"`), same
drawing, same cutter, only the workpiece height changed:

```
stock 600x900  ->  ok: true, 9452 bytes, Y in [ 47.0, 173.0]
stock 600x950  ->  ok: true, 9492 bytes, Y in [ 97.0, 223.0]   <- 50mm out, SILENTLY
stock 600x700  ->                        Y in [-153.0, -27.0]  <- off the sheet
```

🔴 **The 950 case is the one that matters**: `ok: true`, no refusal, no note, a
complete and plausible program for a part **50 mm from where the drawing puts
it**. Nothing downstream can notice — *being in the wrong place* is not a
property any check downstream reads. The 700 case was caught only incidentally,
by the travel check, and for the wrong reason.

⚠ **Gate F1 could not see it, and this is the THIRD time that shape has appeared
this week** (after #146 and #149): `plate.svg` declares `height="900"` and the
reference workpiece is 900 tall, so on the only SVG the gate has ever read **the
wrong number and the right one are the same number**. A control tested only where
right and wrong agree is untested.

**Fixed:** `svg_flip_height` reads the drawing's own space — `viewBox` first
(it *defines* the user units the geometry is written in, and `height="210mm"
viewBox="0 0 100 50"` is an ordinary pairing where reading `height` would flip
about 210), else the `height` attribute. Neither → **REFUSED by name**, because
any flip value is then a guess and a guess moves the part. `height_mm` is now
`_height_mm` and documented as deliberately unused.

Gate F1 now imports the same SVG on a 900 mm and a 950 mm workpiece and requires
**byte-identical G-code** — the drawing decides where the part is, not the sheet.
Three unit tests including a `viewBox`-beats-`height` case; plant-tested by
restoring the workpiece-height flip and watching the test name the movement.

⚠ **13 existing tests broke and every one of them was a FIXTURE fault, not a
regression**: they built `<svg>` with no height and no viewBox and flipped back
using a number they passed in themselves. Fixed by giving those SVGs a declared
height — a real SVG always has one — rather than by weakening the refusal.
733 rust tests, 0 failed. All 10 reference programs byte-identical.

## #151 · ✅ CLOSED 2026-08-29 — a DXF POLYLINE that is a MESH was read as a 2D outline and cut

Found by asking #150's question of the DXF path: **which entity types does F1's
fixture never contain?** `gates/fixtures/plate.dxf` holds only `LWPOLYLINE` and
`CIRCLE`. The parser accepts sixteen.

DXF `POLYLINE` group code **70 is a bit field**, and only bit 1 (closed) was ever
read. Bits **8**, **16** and **64** say the entity is a **3D polyline**, a
**polygon mesh** or a **polyface mesh** — whose `VERTEX` records are mesh data
(positions and face indices), not a planar outline.

**MEASURED**: a polyface mesh (`70 = 65`, i.e. 64|1) with five vertices, placed
inside the sheet:

```
ok: true · 10,399 bytes of runnable G-code · nothing anywhere saying it was a mesh
```

A real closed contour of a shape that is not in the drawing, which posts,
simulates and cuts like any other.

⚠ **The first probe of this looked SAFE, and that is the part worth keeping.**
The same mesh at different coordinates was refused — but by the *travel* check,
because it happened to fall outside the machine. Caught for the wrong reason and
by luck. Moving it inside the sheet is what exposed it.

**Second defect in the same arm:** `"VERTEX"` appended to `pieces.last_mut()` —
whatever piece happened to be last — so a `VERTEX` with no `POLYLINE` open
(a malformed file, or one whose `POLYLINE` was just refused) **silently changed
an unrelated entity's shape**. Driven: an `ARC` followed by a stray
`VERTEX (999, 999)` grew a vertex 950 mm away. Now tracked by index and named
when orphaned.

Both plant-tested. Specificity asserted: an ordinary closed 2D `POLYLINE`
(`70 = 1`) still imports — a refusal catching every POLYLINE would take the
commonest entity in DXF out of the tool. 735 rust tests, 0 failed; all 10
reference programs byte-identical; gate 55/0/5.

## #152 · OPEN (product fork) — imported TEXT is CUT, and the drawing does not say whether that was wanted

Raised 2026-08-29 while sweeping the entity types F1's fixture never contains.
The **silence** is fixed; the **fork** is not, and it is not this lane's to take.

**MEASURED.** A DXF holding one plate and one `TEXT` label imported as
**"2 part(s)"**, and the label — the single letter `A` — was planned as
`drawing/part2` and profiled at **Z-18.0**, clean through an 18 mm sheet:

```
ok / 71,400 bytes · ops: drawing/part1, drawing/part1-hole1, drawing/part2
drawing/part2: deepest Z = -18.0
```

A drawing with an ordinary title block has its title machined out of the
material. `MTEXT` and `DIMENSION` text do the same — and a DIMENSION is
annotation *by definition*; nobody draws one meaning to cut it.

🔴 **BUT IT IS NOT SIMPLY A BUG TO DELETE.** Cutting letters out of ply is a real
job; so is a title block that must never be touched. **The drawing does not say
which**, this tool cannot tell them apart, and two existing tests assert that
TEXT produces contours — so silently dropping it takes a genuine capability away
as surely as silently cutting it destroys a sheet. Two ways to be wrong, and the
old behaviour picked one **in silence**.

✅ **DONE — the silence.** Every text entity that becomes geometry now says so on
import, naming the string and counting the outlines: *"🔴 TEXT 'A' was imported
as 2 CUTTABLE outline(s) — it will be machined like any other geometry, at full
depth, not engraved. If that is a label, a title block or a dimension rather than
something you want cut out, remove it from the drawing or put it on a layer you
do not export."* Same rule the mesh path follows — the word *section* and its Z
ride on every import rather than being left to inference.

### ✅ ANSWERED by `cad` the same day — and it corrected my premise

Routed as `handover/cad/2026-08-29-2bee_app-your-exported-drawing-would-machine-its-own-title-block.md`.
`cad` answered **no, exports cannot be layered — and they do not need to be**,
plus two corrections I cross-checked here:

1. 🔴 **The file I measured is NOT a cut file.** `export/hive_box_prototype.dxf`
   was written by **`ezdxf`** (`$LASTSAVEDBY` — confirmed here), a hand-built
   drawing sheet, and it is the only `.dxf` in `export/`. **1 of the 93 DXFs
   under `hardware/cad` carries TEXT/MTEXT/DIMENSION, and it is that one.** My
   measurement was right and **my conclusion from it did not carry** to their
   `_wcnc` exports. The handover said it would; it was already delivered, so the
   correction lives here.
2. 🔴 **An OpenSCAD `text()` is ALREADY GEOMETRY by the time it reaches DXF** —
   `LWPOLYLINE` outlines, *indistinguishable from a cut path*. Real `_wcnc`
   exports carry **zero TEXT entities and one layer**; OpenSCAD's DXF export has
   no layer control.

⇒ **My warning is silent on exactly the files that matter**, and `cad` said so
rather than letting me trust it. Their gate REQUIRES part labels on nests, and
they measured **342 `LWPOLYLINE` with labels against 230 without — 112 glyph
outlines** that would enter a cut file as ordinary geometry.

⚠ **There is no sound way to detect that from this side.** "Many small closed
contours" would refuse real small parts — the guessing this module exists to
refuse. Recorded in `text_cut_warning`'s own doc comment, because **a control
that cannot say what it fails to see is worse than no control**.

⬜ **STILL OPEN, re-scoped: it now depends on `cad`'s export path, not on a
founder call.** `cad` will pass `-D show_labels=false` and gate the exported
entity count against the label-free render. That path **does not exist yet**
(`render_fleet.py` emits only binstl), and until it does, the projection is
picked by whoever exports next — and `cad` measured that the intuitive choice is
the wrong one (`projection(cut=true)` gave 250 entities, *more* than the correct
230, by excluding labels for the wrong reason while changing which features
appear at all).

✅ **No operator switch is needed for `cad`'s files**, and the rule they can hold
is usable: *a DXF from `hardware/cad/export/` containing a TEXT entity is a
drawing, not a cut file.* ⚠ Not encoded in the importer — that is provenance, not
content, and this reader must not infer one from the other.

## #153 · ✅ CLOSED 2026-08-29 — a MIRRORED block INSERT bulged its arcs the wrong way

A DXF `bulge` is `tan(sweep / 4)` — a **shape factor, not a length** — and
`apply_insert` carried it through unchanged under the comment *"Bulge is
scale-invariant"*. That comment is right about a **uniform** scale and wrong
about the two cases beside it:

* **A MIRROR reverses the arc's direction.** Keeping the sign leaves the arc
  bulging the wrong way — a fillet curving out where it should curve in.
* **A NON-UNIFORM scale makes a circular arc ELLIPTICAL**, which a bulge cannot
  express at all.

**MEASURED** on a 40 mm square with one quarter-arc side (`bulge = 0.4142`),
inserted at several scales. **A mirror must preserve area:**

```
sx= 1 sy= 1  |area| = 1828.31   baseline
sx=-1 sy= 1  |area| = 1371.69   <- WRONG. 456.62 out, exactly 2x the arc segment
sx= 1 sy=-1  |area| = 1371.69   <- same, the other axis
sx= 2 sy= 1  |area| = 4113.24   <- WRONG. 2x baseline is 3656.62; the arc stayed circular
sx= 2 sy= 2  |area| = 7313.24   correct, 4x baseline
```

Both produced a real closed contour with **no note of any kind**. A mirrored
block is the ordinary way a left-hand part is drawn from a right-hand one, so
this is not an exotic input.

**Fixed:** the mirror exactly — negate the bulge when `sx * sy < 0`. After:
every mirror gives 1828.31, uniform 2× gives 4× baseline. The non-uniform case
**cannot** be fixed that way and is refused by name — **and only when a bulge is
actually present**, because straight segments scale non-uniformly without
trouble and refusing them would take a working case away (asserted: an 80×40
stretched square still imports at area 3200).

Both plant-tested. 737 rust tests, 0 failed; all 10 reference programs
byte-identical.

⚠ **How it was found, because the method is the transferable part:** #150 asked
*"where does the fixture make right and wrong agree?"*. F1's `plate.dxf` contains
no `INSERT` at all — so every block-reference path in this importer was reached
by unit tests that only ever inserted at scale 1. The bug lived in the two
arguments no test varied.

## #154 · ✅ CLOSED 2026-08-29 — two CLEAN probes, written down as tests because F1 covers neither

Not every sweep finds a bug, and the negative results are worth keeping when the
gate cannot see the case either way.

Probed the two classic DXF arc failures. **Both are handled correctly**:

* **Arc sweep past 180° and through 0°.** `0→90`, `350→10` (wraps), `90→0` (the
  long way, 270°) and `0→350` all sweep exactly right. The reader splits a >180°
  arc into two ≤180° segments — correct, and briefly mistaken for a defect here
  by reading only the FIRST bulge (135° where 270° was expected) before summing
  them. *An expectation measured against half the evidence.*
* **A bulge on the CLOSING segment** (last vertex back to the first) is not
  dropped: 1828.31 either way.

⚠ **Written as tests anyway, because `gates/fixtures/plate.dxf` contains no ARC
and no bulge at all.** Nothing in the gate suite would notice either regressing,
and a correct behaviour with no test is one refactor away from being an incorrect
one. Both plant-tested — halving the sweep gives *"ARC 0 → 90 swept 45.000
degrees"*, and dropping the closing bulge gives *"area 1600.00 against
1828.31"*, which is exactly what a round corner coming through square looks like
from the outside: nothing. 739 rust tests, 0 failed.

## #155 · ✅ CLOSED 2026-08-30 — every hole in this repo's own fixtures was BLIND by exactly the tab height

Found 2026-08-29 by a check that was written as a refusal and had to be
downgraded, which is how the finding surfaced at all.

`operations_for_part` gives every INTERIOR feature the same `TabSpec` as the
outer profile (`..params.clone()`). On a 6 mm hole — about 19 mm of
circumference — four 8 mm tabs cover the entire path. **Measured on the shipped
`multi-tool` fixture:**

```
hole1..hole4: deepest commanded Z = -15.000 against a requested 18.000
```

Every hole stops exactly one tab-height short. They are **blind holes where
through-holes were asked for**, and they have been since the fixtures were
written. Nothing said so: gate `P1` checks that tabs are *emitted* for a job that
asks for them, and these jobs ask and get them — over the whole path.

✅ **DONE — the silence.** `tabs_never_sever_note` reads the EMITTED moves and
says so on every affected operation: *"the tabs cover so much of this profile
that NO cut reaches its full depth … on a hole the slug is never freed and the
hole is BLIND by the tab height."* Programs are **byte-identical**; only the
notes changed.

### ✅ FIXED 2026-08-30 — and the fix needed `OpRole` to exist first

The rule is in `plan_profile`, where both the perimeter and the role are known:
**if the tab spec's total width takes half the path or more, it is not a set of
discrete bridges** — and what to do then depends on *what the cut is*:

* `OpRole::Interior` — the slug is **not the part**. Drop the tabs; the slug comes
  free and the hole goes THROUGH, which is what a hole is for.
* `OpRole::Releasing` — dropping them would cut the PART free with nothing
  holding it, which is **#156's hazard**. Never dropped; the outline stays
  un-severed and `tabs_never_sever_note` says so on the way out.

That distinction is only expressible because #146 made the role a **field**. It
could not have been written a week ago.

**Measured after:** `multi-tool` `hole1..hole4` and `two-part`'s four drilled
holes now reach **Z-18.000** — through the 18 mm stock — against `-15.000`
before. Outer profiles unchanged at `-18.000` with their tabs intact.

⚠ **This deliberately moves emitted bytes**, the first change today that does.
**Exactly two of the ten reference programs changed** — `job multi-tool` and
`job two-part`, the only two with holes — and the other eight are byte-identical.
The gate suite stayed **55 passed / 0 failed**, including `REL`, which drives both
changed jobs and re-derived *"no part worked on after its release"* over the
deeper holes. No gate hashes golden bytes; they assert properties, so the change
was judged on its merits rather than on a checksum.

⚠ **Three iterations to get the TEST right, each a measurement error of mine:** a
6 mm hole cut with a 6 mm cutter is refused for a different reason (deepest came
back `inf`, not blind); an OUTSIDE cut offsets *outward*, so a spec that swamps a
hole fits comfortably around the part and "never severed" was the wrong property
— **tabs present vs dropped** is the right one; and a 3 mm tab sits at
`Z-15.000`, exactly a depth-pass boundary at the default 3 mm per pass, so
counting moves at the tab height counted an ordinary pass. Tab height 2.5 mm in
the test, for that reason.

Both halves plant-tested: reverting the fix reds on the blind hole, and applying
the drop to **every** role reds on *"a RELEASING cut lost its tabs … that cuts the
PART free with nothing holding it."*

⚠ **Written as a refusal first, and it refused four reference fixtures** — the
whole gate suite would have gone down to force a decision nobody has taken. The
downgrade to a note is the proportionate half: a blind hole is an unfinished
part, not a loose one. The genuinely dangerous sibling — tabs enabled that hold
NOTHING — **is** a refusal, see #156.

## #156 · ✅ CLOSED 2026-08-29 — "tabs enabled" and "tabs that hold" were the same to the planner

`TabSpec { enabled: true, height_mm: 0.0, width_mm: 8.0, count: 4 }` planned a
program **byte-identical to `enabled: false`** — compared move for move, kind and
coordinates:

```
normal 4x8mm   moves=361   same-as-tabs-off = false
height = 0     moves=265   same-as-tabs-off = TRUE
```

The operator declares four tabs; the part comes out **fully released, held by
nothing**, `refusals: 0`, no note. 🔴 That is gate `P1`'s physical failure — a
part cut free with nothing holding it, loose under a 2.2 kW spindle — arriving
through a **setting** instead of through a missing tab, which is exactly why P1
could not see it: P1 checks that tabs are emitted for a job that asks for them,
and this job asks and gets none.

A tab is material LEFT under the cutter: zero height leaves zero material, zero
width leaves it over zero length. Neither is a tab, and `enabled: true` says the
operator believes there is one. **Refused by name**, both fields, at the profile
door. Plant-tested; specificity asserted (tabs OFF is a declaration and not a
fault, and a real tab still changes the program).

## #157 · ✅ CLOSED 2026-08-30 — the no-canned-cycle drill dialect was driven by NOTHING

`post_grblhal` has **two paths for one physical operation**: `G98 G83 … Q` on a
controller with canned cycles, and a hand-expanded peck ladder of `G1`/`G0` pairs
on one without. Grepped across `core/`, `cli/` and `gates/`:
**`supports_canned_drill = false` had no test and no gate.** Every program this
repo has ever checked took the `G83` path.

That is `DOOR`'s shape exactly — *"two different code paths into the planner for
the same one cutter, and they do not agree"* — one layer down, in the **post**,
where the bytes the machine executes are made.

**Probed both dialects on `multi-tool` and they agree**: deepest Z −30.000 either
way, `G98 G83 X90 Y90 Z-18.000 R5.000 Q4.000` against an expanded ladder of
−4, −8, −12, −16, −18 with a `G0 Z-3.500`-style reposition that stops **above**
each peck bottom. **No defect found** — the fallback is correct.

Written as a test anyway, because the branch had nothing holding it. It asserts
on the EMITTED TEXT of both dialects, not on the setting that selects them:

* both bottom the hole in the **same place** — a ladder that stops one step early
  leaves the hole blind and nothing downstream can tell;
* the expanded path **never rapids below the depth it just cut** — that drives
  the drill into the bottom of its own hole at rapid rate;
* the ladder is actually a ladder — one full-depth plunge is not a peck cycle,
  whatever the settings said.

**Three plants, one per limb, each red with its own message:** *"G83 says
Z-18.000 and the expanded ladder reaches Z-16.000"*, *"rapids BELOW the depth it
just cut"*, *"made 1 plunge(s) for an 18mm hole at 4mm peck"*.

742 rust tests, 0 failed; all 10 reference programs byte-identical.

## #158 · ✅ CLOSED 2026-08-30 — a self-intersecting outline cut a runnable program

An asymmetric bowtie — six vertices, one crossing, net area clearly non-zero:

```
ok: true · 5,991 bytes of runnable G-code · nothing said about self-intersection
```

The only finding on that job was `Undeclared`, which is the no-clamps warning and
unrelated. **Nothing noticed.**

Offsetting a crossing outline for a tool radius is **meaningless where it
crosses**: the offset inverts, so the cutter passes on the wrong side — into the
part body, or leaving a web that should have been removed — and tabs are placed
by arc length along a path that visits the same point twice. The program looks
complete and cuts a shape that is not in the drawing.

⚠ **A SYMMETRIC bowtie was already refused, and that is why this went unseen.**
Its two lobes cancel, `signed_area()` comes out ~0, and `to_parts`' `area > 1e-9`
filter drops it — refused **for the wrong reason, by luck**, exactly like #151's
polyface mesh that happened to fall outside the machine's travel. Make the lobes
unequal and the filter passes it straight through. *Two findings this week caught
only by an unrelated check; both looked safe on the first probe.*

**Fixed:** `self_intersection_refusal` — a strict-straddle segment-pair test at
the profile door, naming both crossing segments and their coordinates so the
defect can be found in the CAD.

⚠ **WHAT IT DOES NOT SEE, stated rather than implied.** It tests **chords**. A
segment carrying a bulge is an arc that reaches outside its chord, so two arcs
crossing while their chords do not are **missed**. That is the honest gap to
leave: flattening every arc first would trade a missed crossing for false
refusals of good parts whose arcs merely pass close, and a geometric control that
refuses real work is one people learn to switch off. Contours over 4,000 segments
are skipped for cost.

**Both limbs plant-tested.** Sensitivity: disarming the check plans **223 moves**
on the bowtie. Specificity: making *touching* count as crossing wrongly refuses
the narrow-notch fixture — a square, a concave L, a triangle and a 2 mm notch must
all still plan, and are asserted to.

744 rust tests, 0 failed; all 10 reference programs byte-identical.

## #159 · ✅ CLOSED 2026-08-30 — winding independence probed clean, now held by a test

Winding is the classic offset hazard: if a clockwise outline is assumed
counter-clockwise, `Outside` offsets **inward** and every part comes out
undersize by twice the tool radius — smooth, complete, and the wrong size.

**Probed and it is handled**, by `normalise_winding` at `toolpath.rs`:

```
CCW Outside  X[-3.000, 63.000]      CW Outside  X[-3.000, 63.000]
CCW Inside   X[ 3.000, 57.000]      CW Inside   X[ 3.000, 57.000]
```
(outline 0..60, tool radius 3.)

Written as a test because a DXF's winding is whatever the CAD wrote, and this
repo's fixtures carry one direction only — nothing else would notice it
regressing. It asserts both halves: the two windings AGREE, **and** the direction
is right (outside goes outside), because two windings agreeing on the wrong
answer is still wrong.

⚠ **Two plants before one worked, and that is the note worth keeping.** The first
scaled the tool radius by the signed area — it did not compile, and my
red-detector only looked for `test result: FAILED`, so a **build failure read as
a passing control**. The second removed `normalise_winding` and returned a value
where `{}` was expected — also a build error. Only the third fired:

```
Outside: a counter-clockwise outline cut X[-3.000,63.000] and the SAME outline
wound clockwise cut X[3.000,57.000]
```

*A plant that does not compile is indistinguishable from a plant that found
nothing, unless the harness reports the build separately.* It does now.

745 rust tests, 0 failed; all 10 reference programs byte-identical.

## #160 · ✅ CLOSED 2026-08-30 — the invariant that keeps a refusal VISIBLE was load-bearing and unguarded

Asked of the refusals added this week: do they reach the operator in the
**browser**, or only at the CLI?

They do — and the chain that makes them visible is two links across a
core→UI boundary, with nothing holding the join:

```
core   JobResult::is_runnable()  =  refusals.is_empty() && no non-Undeclared finding
UI     const blocked = report && !report.ok        <- App.tsx
       …and the `blocked` block is the ONLY place report.refusals is listed
```

⇒ **A refusal is shown if and only if `ok` is false**, so `refusals.is_empty()`
inside `is_runnable` is not a description of a healthy report — it is what puts
the reason on the screen. Relax it for any reason that looks local and sensible
in `job.rs`, and the refusal stays in the JSON, stays correct, and **vanishes
from the display**, over a program the operator can now download.

**Driven end to end**: a drawing carrying one good square and one
self-intersecting outline came back `ok: false`, **0 bytes**, refusal named — a
partial refusal blocks the whole job, which is `MULTI`'s doctrine (*the refusal
comes before the program exists and emits zero bytes*).

**Guarded** by an invariant test rather than a fixture, so it holds for refusals
that do not exist yet: any refusal ⇒ not runnable, and `Undeclared` stays exempt
(*"no clamps declared" is a fact about the setup, not a fault in the program*;
blocking on it would make every un-clamped job unrunnable). The chain is written
into `is_runnable`'s own doc comment, because the next person to edit it will be
looking at `job.rs` and not at `App.tsx`.

Plant-tested — `true || refusals.is_empty()` gives *"a result with a refusal
reported itself RUNNABLE"* — and this time the harness reported the BUILD
separately, per #159's lesson that a plant which does not compile reads as a
passing control.

746 rust tests, 0 failed; all 10 reference programs byte-identical.

## #161 · ✅ CLOSED 2026-08-30 — `M3 S0` was the one spindle speed nothing checked

Every spindle test in the post sat inside one guard:

```rust
if m.value > 0.0 {
    if m.value < machine.spindle_min_rpm { warn "below the spindle's minimum" }
    if m.value > machine.spindle_max_rpm { warn … }
    if path.tool.rpm_max > 0.0 && …       { warn … }
}
```

🔴 **The precondition excluded exactly the value it most needed to catch.** A
`SpindleOn` of zero skipped the band check, the ceiling check **and** the
cutter's rating, and the post emitted `M3 S0` with no spindle comment of any
kind.

**Measured through the real door** (`job plate --config '{"op":{"rpm":0}}'`):

```
exit 0 · 11,700 bytes · `M3 S0` on line 21 · ok: true
```

The FEED notes did fire — *"the emitted feed delivers 0.000mm of chip per tooth …
it rubs: the heat goes into the cutter"* — but **a warning above a runnable
program is a program that gets run**, which is `MULTI`'s own wording. On a VFD
spindle `S0` does not turn, and the cutting moves that follow feed the tool
through 18 mm of ply anyway: a snapped cutter and a workpiece nobody is holding.

⚠ **Third instance of one shape this week.** #147: `f64::min` returns the non-NaN
operand, so a NaN thickness removed the spoilboard clamp. #148: every check in
`faults()` is a comparison, and every comparison against NaN is false. #161: `>
0.0` swallows zero. **A guard whose precondition excludes the case it exists for
reports green about that case forever.**

**Fixed:** `res.errors` — a refusal, not a warning — naming what was commanded
and what it does. After: `exit 1`, **0 bytes**. All 10 reference programs
byte-identical (the default rpm is 18,000; nothing legitimate emitted `S0`).

⚠ **Not asserted: that `M3 S0` is absent from the post's buffer.** The post
accumulates text as it walks the moves and reports errors alongside it; the
CONTRACT is `ok() == false`, and every host withholds on that — `is_runnable`,
the CLI's exit 1 with empty stdout, and the e2e *"a refused program offers no
download"*. Asserting on the buffer would be asserting on an intermediate nobody
delivers. Verified through the real door instead.

Plant-tested; specificity asserted (a speed inside the band still posts cleanly).
748 rust tests, 0 failed.

## #162 · ✅ CLOSED 2026-08-31 — a slot the cutter cannot enter vanished from the program in silence

A 60×60 square with a **2 mm wide, 55 mm deep notch**, cut `Outside` with a 6 mm
cutter:

```
cutting moves anywhere in the notch corridor : 0
notes                                        : 0
```

The tool cannot enter a 2 mm gap, so `parallel_offset` closes it and **the part
comes out SOLID where the drawing shows a slot.** Nothing downstream can notice —
every coordinate is a real coordinate of a real part — and the operator finds it
at assembly.

⚠ **The `Inside` cut of the same shape DID report** (*"offset split the contour
into 2 loops (a pinched shape)"*), which is what made the silence on the other
side visible at all. One direction reported and the other did not.

### Not by hunting narrow gaps — by asking whether the tool can reach

The obvious approach, *find boundary segments closer than the tool diameter*, is
**wrong**: a 1 mm-thick part has its long edges 1 mm apart and is perfectly
cuttable from outside, because the tool never needs to pass BETWEEN them.
Proximity is not the question; **reachability** is.

So it asks directly, with a morphological round trip — offset OUT by the tool
radius and back IN. Whatever the tool cannot reach into does not come back:

```
plain square             3600.00 -> 3600.00    lost   0.00
2mm notch, tool too big  3490.00 -> 3599.77    lost 109.77   <- notch is 2 x 55 = 110
10mm notch, tool fits    3050.00 -> 3053.86    lost   3.86
concave L                2000.00 -> 2001.93    lost   1.93
```

⚠ **The residue on a cuttable shape is not noise, it is the corner radius** — and
that is what makes the allowance principled instead of tuned. An inside corner
cut by a round tool keeps `(4−π)/4·r² = 1.93 mm²` at r=3; the L has one such
corner and the 10 mm notch has two, giving **exactly** 1.93 and 3.86. The
allowance is that model per concave corner with a 50% margin.

**A NOTE, not a refusal.** A radiused inside corner is normal and the operator
lives with it; a missing slot is not. The tool cannot tell which the operator
meant, and refusing every part with an unreachable pocket would refuse ordinary
work — so it says what was lost, how much, and what was allowed for corners.

Both limbs plant-tested: disarming it reds on the missing notch; removing the
corner allowance reds on ordinary rounding (*"a check that fires on ordinary
corner rounding is one people switch off"*). 749 rust tests; all 10 reference
programs byte-identical.
