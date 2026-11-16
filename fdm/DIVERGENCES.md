# DIVERGENCES.md -- where twobee-fdm is allowed to differ from OrcaSlicer, and the proof that it may

**Founder rule (2026-10-14):** *OrcaSlicer output is a reference; if we have a better outcome use it. Always check, prove.*

**Reading enforced here: a deviation from Orca is a FAIL until proven BETTER.** "Looks nicer" is not evidence.
The instrument is `quality` (`src/quality/`; the binary source is `src/bin/quality.rs`, delivered as `src/quality/quality_bin.rs` until the lead adds `pub mod quality;` to lib.rs); this file is the ledger and the procedure.

## LEDGER STATUS: EMPTY -- no divergence from Orca is accepted as proven better (2026-10-14)

Not one. Measured today on four models (cube, ring, bridge, mushroom -- see "State today") the machine returns
`FAIL` on all four, so nothing can be accepted. Several metrics read BETTER on some model, and every one of those
is *not* an accepted divergence, for the reasons stated in "State today" and "Candidates, not proven".

## The rule, and where each clause is enforced

"Better" is accepted only when ALL hold. Code references are to `src/quality/mod.rs`.

| clause | meaning | enforced by |
|---|---|---|
| (a) | the metric was **declared before** it was measured: unit, direction, tolerance, risk flag | `DEFS` is the closed list. A metric not in it has no verdict. Every later change to a definition is logged below ("Definition changes") |
| (b) | ours beats Orca by **more than the measurement noise** | `judge`: SAME unless `abs(ours-orca) > max(noise_orca, noise_ours, abs_tol, rel_tol*value)`. Noise = max deviation over `--noise-runs` (default 4) re-analyses with +-0.5 um coordinate jitter (a 3-decimal rounding step) and a shifted raster lattice |
| (c) | **no other declared metric is WORSE** | `overall`: one WORSE or INCOMPARABLE row => `Fail`, whatever else improved |
| (d) | **same model and settings** | mesh height must match the G-code top Z; layer stacks must be identical (else exit 2, nothing compared); the 28 `SAME_SETTINGS` keys of the two CONFIG_BLOCKs must be equal -- if ours has no CONFIG_BLOCK the result is `Unverified` and BETTER is not accepted |
| (e) | a **negative control** shows the metric can detect worse | `run_controls`: 20 planted degradations of Orca's own file, each naming the metrics it must make WORSE; a metric is "controlled" only if its plant fired **on this model**. A BETTER on an uncontrolled metric is `Unproven`. A plant that does not fire is an **instrument defect** (exit 1). An unchanged copy and a 1-um shift of every coordinate must read SAME on every metric (false-positive control) |
| (f) | a **physical-risk metric never trades off silently** | `risk: true` metrics (outside-region, under/over-fill, gaps, first layer, flow, accel, jerk, bridge, layer time) -- WORSE on any is `Fail` even if time/travel/etc. improved. Tested by planting "feed x3 with E unchanged": print time reads BETTER, flow reads WORSE, overall FAIL |

`filament_mm` has direction **match**: less material is never BETTER (it could be missing infill). A saving can only
be accepted by first declaring a companion strength/coverage metric.

Exit codes: 0 PASS (SAME, or PROVEN BETTER) - 1 FAIL (WORSE / unproven BETTER / instrument defect) - 2 could not run
(unreadable file, mesh not this part, layer stacks differ).

## Procedure to propose a divergence

1. **State the divergence and the metric BEFORE running anything.** Write the entry header (below) with the declared
   metric(s) and the expected direction. If no metric in `DEFS` fits, add one to `DEFS` first (with a plant in `PLANTS`
   that must make it WORSE), commit that, then measure.
2. **Isolate it.** The comparison against Orca is a whole-file comparison, so one unfinished lane makes the file FAIL
   for unrelated reasons (see "State today"). Produce two files from OUR pipeline that differ only by the divergence
   (switch on / switch off = Orca behaviour) and run `quality off.gcode on.gcode --mesh m.stl`. The same instrument
   judges both. Then also run `quality orca.gcode on.gcode` to show no metric regresses against Orca.
3. **Same model, same settings**: the files must carry the same CONFIG_BLOCK keys (`SAME_SETTINGS`); use Orca's file as
   the settings source (`fdmslice model.stl orca.gcode out.gcode` does this).
4. **Run on every reference model that exercises the divergence**, with controls (default). Required: verdict
   `PASS (PROVEN BETTER)`, the improved metric listed as `fired` in the control column, `false_positive_controls_ok`.
5. **Record the entry** below with the numbers copied from `--json` output, the command line and the git SHA of the
   code. Re-run at every change that touches the lane; a regression turns the entry into a FAIL until re-proven.
6. If any step cannot be done, the divergence stays a FAIL. Say which step.

## Ledger format (one entry per accepted divergence)

```
### D-NNN <short name>              date: YYYY-MM-DD   status: ACCEPTED | WITHDRAWN (why)
- divergence: what we do differently from Orca (file/function, setting that switches it)
- declared metric(s): key (unit, better=lower|higher|match) -- declared on <date>, before measuring
- model(s) + settings: stl name/sha256, Orca process/filament/bed, CONFIG_BLOCK keys equal (count)
- numbers:   metric | orca | ours | noise floor | threshold | verdict      (every declared metric, not just the winner)
- negative control: plant name(s) that made this metric WORSE on this model, with their numbers
- risk metrics: all SAME or BETTER (list)
- command + json: the exact command; path to the saved --json
- code: git SHA of the slicer and of quality at proof time
```

### ENTRIES

*(none -- the ledger is empty. See "Candidates, not proven".)*

## State today (2026-10-14), what was actually run

* **Reference:** Orca 2.5.0-dev G-code from the local server for four generated models (`test/mkcube.js`, `test/mkoverhang.js`):
  `cube` 20 mm, `ring` 30 mm with 10 mm hole, `bridge`, `mushroom`; process `0.20mm Standard @BBL X2D - pnp coupon`,
  PETG, textured PEI.
* **Ours:** the delivered lanes assembled by the lead's pipeline (`fdmslice model.stl orca.gcode out.gcode`, the shared
  crate built 2026-10-14 ~17:00, settings read from the Orca file's CONFIG_BLOCK; `28/28` `SAME_SETTINGS` keys equal).
  Real end-to-end output, not Orca-vs-Orca. (Earlier the same day an older pipeline snapshot was also measured; its travel/
  retract rows were WORSE on all four models and have since improved on cube/ring/mushroom -- the instrument saw the change.)
* **Controls-only runs (`quality orca.gcode --mesh m.stl`):** all four models `PASS`, no instrument defect, false-positive
  controls SAME on 26-29 applicable metrics; 25 (cube, ring) / 28 (bridge, mushroom) of 29 metrics controlled.

| model | verdict | WORSE (risk) | BETTER (controlled unless noted) |
|---|---|---|---|
| cube | FAIL | solid_gap_count 17 -> 33, solid_gap_area 1.49 -> 1.995 mm2, jerk_ratio_p95 17.03 -> 17.14 | travel 4173 -> 4008 mm |
| ring | FAIL | solid_gap_count 20 -> 30, solid_gap_area 1.19 -> 4.08 mm2 | travel 15145 -> 14611, retract 544 -> 496, zhop 542 -> 494 |
| bridge | FAIL | travel 4287 -> 4779, retract 190 -> 196, zhop 188 -> 194 | solid_gap_count 39 -> 34, solid_gap_area 10.95 -> 4.44 mm2, jerk_ratio_p95 28.09 -> 24.01 |
| mushroom | FAIL | solid_gap_area 3.72 -> 11.33, seam_scatter 0.43 -> 0.70, jerk_ratio_p95 24.15 -> 24.55, jerk_violation_count 2238 -> 2329 | dim_err_mean 0.0204 -> 0.0129 mm, dim_err_p95 0.0226 -> 0.0099 mm, retract 135 -> 111, zhop 133 -> 109, seam_visibility 0.634 -> 0.500 (NOT controlled: saturated, not accepted) |

Reading: the BETTER cells are real measurements and every one of them sits next to a WORSE in the same file, so under
clause (c) none can be accepted. The WORSE rows are mostly *unfinished-lane* effects (solid-infill corner voids, seam
placement), not evidence about any intentional divergence.

**Findings against OURS the instrument surfaced (not divergences; defects to fix):**
* Solid-infill voids: ours leaves 33 patches / 2.0 mm2 on the cube vs Orca 17 / 1.5 mm2; ring 30 / 4.1 vs 20 / 1.2. Patches
  are at wall/infill inner corners in the first and last shell layers. `solid_gap_count` is a risk metric.
* Feed on short internal-solid segments: ours commands 234-250 mm/s on 0.90 mm internal-solid segments (cube layer 95,
  mushroom/bridge layer 65) against Orca's 93-153 mm/s on the same feature. Only visible in the `flow_by_feature` notes;
  the declared `flow_peak_ratio` (segments >= 2 mm) reads SAME. A short segment never reaches that feed, so it is a
  commanded-feed defect, not necessarily a print defect.

## Definition changes (the log for clause (a))

All thresholds in `DEFS` were written before the first measurement. These changes were made AFTER the first run on
Orca's own files, each for an instrument defect found by measuring Orca (never by looking at ours-vs-Orca outcome), and
each changes how the same two files are scored, so they are listed:

1. **Coverage footprint** (`analyze.rs coverage`): first version rasterised each bead at its volume width w_v = E*A/(len*h).
   Orca's own outer/inner wall pair then showed a 0.02 mm "void" (flow ratio 0.95 narrows w_v), read as 8% wall under-fill
   that moved with the raster lattice (noise 3.2 of 8.4). Now: **two footprints** -- the volume width for over-fill
   (excess material) and the full stadium width w_v + h(1-pi/4) plus `COVER_SLACK` = 0.025 mm for under-fill/gaps (a void
   must be wider than 0.05 mm). Orca's wall under-fill 8.38% -> 0.018%, noise 3.2 -> 0.026.
2. **Layer-0 retraction debt** (`parse.rs`): a 3 mm retract in the start G-code, never paid by a G1, swallowed the entire
   first layer (skirt + both walls) of the mushroom file as "debt payoff". Debt now resets at the first layer. Regression
   test `start_gcode_retraction_debt_does_not_swallow_layer_zero`. This changed first_layer_coverage on mushroom 64% -> 99.96%.
3. **`flow_peak_ratio` min length 2 mm** (`PEAK_MIN_LEN`): Orca's own ring file read 1.000 on a 0.53 mm segment, a property of
   the segmenter. Violations (> 1.03 x limit) still count from 0.3 mm. Effect: ours-vs-Orca flow_peak rows WORSE -> SAME on
   cube/bridge/mushroom. Disclosed because it moved a row in ours' favour; the Orca-only reason is the 0.53 mm reading.
4. **`seam_scatter` cap 5 -> 20 mm** (`seams`): the 5 mm cap silently discarded every pair of unequal seams, so a seam
   scatter plant read 0.0000. Found by the plant, not by the data.
5. **Gap size in area, not cells** (`MIN_GAP_AREA_MM2` = 0.01 mm2): at `--cell 0.035` the count rose 17 -> 147 on Orca's cube.
   With the area rule `--cell 0.035` and `0.05` agree on every verdict for cube and bridge; at `0.07` cube `solid_gap_area`
   flips WORSE -> SAME (cell^2 approaches the threshold). Use 0.035-0.05.
6. Plants: `jitter_walls` split into 0.12 mm (mean, p95) and 0.8 mm (max): on bridge/mushroom Orca's own worst sample is
   0.45-0.47 mm so a 0.12 mm plant cannot raise the max -- the plant was too weak, not the metric.

## Instrument limits -- what a green does NOT mean

* **Not a print.** Nothing here has printed. Metrics are toolpath-level; "better" means better on a declared proxy.
* **Print time** is our own trapezoid + classic-jerk planner applied identically to both files. Against Orca's header model
  time it reads -6.5% (cube), -12.1% (ring), -8.7% (bridge), -7.3% (mushroom). It compares two files fairly; it does not
  predict the printer. Layer-time metrics inherit this: on mushroom 47 of 70 Orca layers are under 12 s by this estimator.
* **Jerk** compares commanded feeds at extrusion junctions with `machine_max_jerk_x` (10). Orca's file gives p95 = 17-28 x
  the limit; the Bambu firmware's own junction handling is not modelled, so absolute values mean nothing, only the delta.
* **Acceleration** reads the `M204` in force against `machine_max_acceleration_extruding[0]` (extruder-index assumption).
* **Fidelity/coverage ground truth** is OUR lane-1 slice of the mesh at the G-code's own layer mid-planes; it is only as
  right as that slice. A mesh that does not line up (mean outer-wall error > 0.25 mm) is refused, not scored.
* **Seam visibility** saturates (cube 1.0, bridge 1.0): it cannot be shown WORSE there, so it is uncontrolled and any BETTER on
  it is rejected. A model with concave corners (ring: 0.5) is needed.
* **Uncontrolled on a model** (listed per run): bridge metrics on models with no bridge, seam_visibility. Rerun on a model that exercises them.
* **Four small synthetic models.** Nothing about real parts with fuzzy skin, supports, ironing or multi-material is
  covered; `Support`/`Skirt`/`Brim`/`Ironing`/`Prime tower` extrusion is excluded from coverage by design.
* The first mushroom reading (Orca "floating cantilever" warning on the model) is a valid but overhang-heavy part.

## Candidates, not proven (each needs steps 1-6 above)

| # | where Orca is (measurably) weak, from Orca's OWN file | numbers | what would have to be shown |
|---|---|---|---|
| C1 | **Small voids at inner corners of solid layers.** Orca leaves 17 patches / 1.49 mm2 on the cube (0.11-0.18 mm2 each, layers 1-2 and 95-99, at wall/infill corners), ring 20 / 1.19 mm2, bridge 39 / 10.9 mm2 | `solid_gap_*` (risk) | ours is currently *worse* on cube/ring/mushroom; first reach Orca, then a corner-fill rule that beats it |
| C2 | **Curved-wall deviation.** Orca's outer wall on the revolved mushroom is 0.0204 mm mean / 0.0226 p95 from the sliced contour (cube/ring: 0.0000). Ours: 0.0129 / 0.0099 -- measured BETTER, both controlled and fired | `dim_err_mean_mm`, `dim_err_p95_mm` | cause not investigated (guess: resolution/simplification of the slice polygon); needs the isolated A/B of step 2 and a second curved model. Not accepted: whole file FAILs |
| C3 | **Overhang walls off the contour.** Orca's worst outer/overhang sample is 0.445 mm (bridge) / 0.474 mm (mushroom) from the sliced contour; ours 0.450 on mushroom (SAME) | `dim_err_max_mm` | a rule that places overhang walls closer *without* raising overhang-curl risk; no curl metric is declared |
| C4 | **Retractions.** Orca retracts 198 times in 100 plain cube layers (2 per layer), 544 on the ring. Ours: ring 496, mushroom 111 vs 135 (BETTER, controlled), cube/bridge not better | `retract_count`, `travel_mm`, `zhop_count` | there is no stringing/oozing-risk metric, so fewer retractions cannot be called better: declare one first (e.g. non-retracted travel length crossing open air) and plant it |
| C5 | **Corner speed.** Orca commands the full feed into every corner: p95 junction change is 17x (cube) to 28x (bridge) the 10 mm/s jerk setting. Ours: bridge 24.0 (BETTER), cube 17.1 (WORSE) | `jerk_ratio_p95` | needs the printer's actual junction behaviour; if firmware already smooths this, there is nothing to win. Measure on the printer before spending effort |
| C6 | **Seam placement.** Orca's seams on the mushroom score 0.634 and scatter 0.43 mm layer to layer; cube/bridge saturate at 1.0 | `seam_visibility`, `seam_scatter_mm` | a model with concave corners and a control that can read WORSE there |
| C7 | **Grid-crossing over-fill.** Orca's file shows 1.0-1.2% bead overlap (infill crossings) | `overfill_pct` | ours is SAME (1.17); a crossing rule would have to beat noise 0.2-0.4 pp |

## How to run

```
quality orca.gcode ours.gcode --mesh model.stl            # full: 29 metrics + 20 plants + false-positive controls (20-45 s)
quality orca.gcode ours.gcode --mesh model.stl --json     # machine-readable, includes noise floors and populations (n)
quality orca.gcode --mesh model.stl                       # controls only: Orca vs its own planted degradations
quality ... --no-controls | --cell 0.05 | --noise-runs 4 | --offset x,y
```
Per-metric populations (`n`) are in `--json`; `solid_gap_*` and the "where the numbers come from" block name the layer and XY of the
biggest voids and the feature behind the peak flow, so a WORSE row points at the code to read.
