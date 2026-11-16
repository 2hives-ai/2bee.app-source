# twobee-fdm Gate Requirements

Definition of "done" for the FDM slicer core's **parity gate** (lane 8): `src/gcode_parse.rs`,
`src/parity.rs`, `src/bin/parity.rs`. Companion to [`../SLICER-GATES.md`](../SLICER-GATES.md) (CNC), same
conventions.

**What the gate is for.** The target is feature parity with OrcaSlicer 2.5.0-dev on the Bambu Lab X2D 0.4 nozzle,
and the only evidence of parity is a comparison of OUR G-code with OrcaSlicer's G-code on the same model and the
same resolved settings. Nothing here has printed anything. A green from this gate means "the G-code statistics
agree within tolerance", not "the print is good".

```
parity orca.gcode ours.gcode [--json] [--tol 3,10] [--all] [--no-seam-pos] [--include-custom] [--skip g1,g2]
parity orca.gcode ours.gcode --plant            # negative control on a real pair
parity --matrix [--models cube,ring,tbar,coupon0402|all] [--only key,key=value|baseline] [--quick]
                [--fresh] [--conc N<=3] [--json] [--save-dir DIR] [--plant]
parity --matrix --list                           # print the population without running anything
parity --selftest                                # all negative controls on synthetic G-code, no server needed
```

**Exit codes (the fleet contract):** `0` every case PASS/WARN over a non-empty population - `1` at least one
FAIL - `2` something could not run (PENDING). Exit `2` is **not a pass**, and a FAIL outranks a PENDING.

## Rules that bind every gate below

1. **Every gate names the physical or correctness failure it guards.**
2. **Every gate has a negative control** (`--plant` / `--selftest`): a planted defect that must turn it red.
   *A gate nobody has watched fail is not a gate.*
3. **A gate that cannot run reports PENDING, never PASS.** Missing data on either side is PENDING; a report over
   zero judged rows is PENDING; a matrix whose evaluated cases are fewer than planned is exit 2.
4. **The population size is printed next to every verdict** (`population: ... lines / extrusion moves / layers`,
   `POPULATION V variations x M models = N cases`), so a green over nothing is visible as nothing.
5. **Tolerances:** PASS within +-3 %, WARN within +-10 %, FAIL beyond (`--tol pass,warn`). Every relative metric
   carries an ABSOLUTE FLOOR (below) under which a difference is PASS, so a 0.3 mm gap-fill sliver cannot trip a
   percentage. Exact metrics have no band. The floors are in `Options::default()`; they are not hidden.

## How "ours" is obtained

Orca's G-code comes from the local server (`/api/slice?...&set=key%3Dvalue`, cached by FNV hash of the STL + preset +
overrides under `$TMPDIR/fdm-parity/cache`, `--fresh` bypasses). Its CONFIG_BLOCK is how the resolved settings
reach our code.

`ours_gcode()` in `src/bin/parity.rs` is the **one hook**:
`FDM_OURS_CMD='cmd {stl} {orca} {out}'` (exit `2` = cannot run, other non-zero = engine error) or, once the lead wires
it, a direct call to `pipeline::slice_gcode`. **Until one of the two is set every case is PENDING and the matrix exits 2.**
`FdmError::Unsupported` from our engine is PENDING (refusal is not a regression), any other error is FAIL.

## The gates

| Gate | Guards against | Judged by | Floor | Negative control |
|---|---|---|---|---|
| **LEN** per-feature path length (`feature:<F> / path_mm`) | walls/infill/skin printed too short or long: under-extruded parts, overfilled shells, wrong perimeter count | `ours` vs Orca, rel | 2.0 mm | `--plant` scales Outer/Inner/Overhang wall XY and E by +15 % in a copy of ours; must FAIL and move >= 8 points vs the unplanted comparison |
| **FEAT** feature presence | a whole feature missing (no top surface, no supports, no skirt, no gap fill) or invented | `path_mm` against 0 when absent | present side > 2 mm | `plant_drop_feature` strips a feature's E; must FAIL ("MISSING IN OURS"). A feature on one side only is FAIL, never skipped |
| **FLOW** per-feature filament (`e_mm`, `xsec_mm2`) | wrong extrusion cross-section, wrong flow ratio: weak or blobby walls | rel | 0.5 mm E, 0.002 mm2 | same wall plant (E scaled) |
| **WIDTH** line widths (`width_mean`, from `; LINE_WIDTH:`) | wrong bead width: gaps between lines or over-squish | rel | 0.01 mm | `nowidth` selftest: ours without `LINE_WIDTH` -> PENDING (never PASS) |
| **SPEED** per-feature `speed_mean` / `speed_max` | wrong feed rates: cooling, overhang quality, resonance, print time | rel | 1 mm/s | `plant_scale_speed` halves `F` inside Inner wall; `speed_max` must FAIL (test `speed_fan_retraction_bbox_controls_each_fail`) |
| **LAYER** count, z list, per-layer path | wrong layer stack: first-layer height, variable layer height, off-by-one layers | count and z EXACT (0.001 mm); worst layer path rel | 3 mm | `plant_z_shift` +0.05 mm must FAIL `layers / z_max_abs_diff` |
| **FIL** filament in layers + header `filament used [mm/cm3/g]` | wrong material use / cost / spool estimate | rel | 1 mm, 0.05 cm3/g | wall plant |
| **BBOX** extrusion bounding box (x,y abs 0.3/1.0 mm; z 0.01/0.05 mm) | part placed or scaled wrong, skirt/brim missing, off the bed | abs band | - | wall plant moves `bbox / xmax` to FAIL (same test) |
| **RETR** retraction count + total length | stringing, nozzle ooze, under-retracted travels; or excess retraction wearing the filament | rel | 3, 1 mm | `plant_strip_lines("G1 E-")` -> `retraction / count` FAIL |
| **ZHOP** z-hop count + max height | nozzle dragging over printed walls; hop height wrong | count rel, height abs 0.01/0.05 | 3 | removing the hop's return move -> `zhop / count` FAIL |
| **SEAM** outer-wall loop starts (count; per-layer position match) | seam placed on the wrong side or not at all; random seam scatter | count rel (floor 1); position: >= 90 % of Orca's seams matched within 0.5 mm = PASS, >= 70 % WARN | - | `seam_position_judged_and_random_mode_info`: seam moved 5 mm -> FAIL. **Position is INFO (not judged) for `seam_position=random`**, where no match is possible, and says so in the row |
| **FAN** M106/M107 command count and distinct `S` values | part cooling off/on at the wrong place: curl, sagging bridges, over-cooled layer adhesion | count rel (floor 2); S sets: 0 differences PASS, 1 WARN, more FAIL | 2 | `plant_strip_lines("M106")` -> both fan rows FAIL |
| **HEAD** header values: total / model / first-layer time, layer count, filament | wrong time estimate (queue planning), wrong layer count in the file's own header | rel; layer count exact | 5 s / 3 s | missing on ours -> PENDING |
| **MATRIX** the whole variation x model population | a setting that works alone but breaks in combination; a green that examined nothing | per-case worst row | - | `--matrix --only nosuchkey` -> population 0 -> PENDING exit 2; `--matrix --plant` must report CAUGHT == population |

**Not judged, shown as INFO:** `moves` (segmentation differs legitimately), `Custom` (start/end G-code and purge
lines; `--include-custom` judges it), the `--skip`ped groups (each shown as `SKIPPED`, never dropped silently),
parser warnings from our file.

## The parser (`gcode_parse.rs`)

Refuses what it cannot read faithfully: inches (`G20`) and a file with no motion lines are errors, not zeros.
Handles `M82`/`M83`, `G90`/`G91`, `G92`, `G2`/`G3` arcs (`I/J` or `R`, `P` turns; arc length, not chord, enters the
path length; arc extremes enter the bbox) and Orca's `Slope Lift` z-hops (`G3 Z... P1`). Retractions use a **debt**
model: a negative E opens or extends a retraction, a positive E pays the debt first and only the remainder is
extrusion, so wipe-while-retracting moves are not path and one retract+wipe counts once. A z-hop is counted when it
COMPLETES (nozzle returns to the layer z), so the end-G-code park move is not a hop.

## Known limits (state them, do not paper over them)

- **Only Orca-process-level keys can be varied.** The server applies `set=` to the process preset, and its value
  pattern rejects parentheses. Measured 2026-10-14: `filament_flow_ratio`, `retraction_length`, `fan_max_speed`
  (filament/printer keys) produce Orca G-code identical to the baseline, `support_type=tree(auto)` is rejected
  (`bad set override`). They are NOT in the matrix. Retraction and fan are covered through `z_hop`,
  `reduce_infill_retraction`, `reduce_crossing_wall`, `enable_overhang_speed`, `bridge_speed`. Varying filament/printer keys
  needs a server extension.
- **NOOP detection.** Each case records whether Orca's motion lines equal the baseline's for that model. The
  summary prints `NOOP-VARIATIONS`; a NOOP case is still compared (it checks the baseline again) but adds no new
  evidence. Measured: 18 of 348 default cases are NOOP, all model-dependent (support on a cube has nothing to
  support; `detect_overhang_wall=0` on a cube).
- **Seam position is a deterministic-mode check only.** `random` is not judged; `nearest` depends on the previous
  position and only matches if our travel order matches.
- **Time estimates** are compared when present on both sides; ours reports none until lane 5 emits them, which
  makes every case PENDING on `header / *time*` (use `--skip header` to see everything else, the skip is printed).
- **Matches Orca's statistics, not its toolpaths.** Two files can agree on every row and still differ in where
  the lines are. `parity` ships `direction_histogram` (port of `layer_lines.js`) for the infill angle/spacing
  question; it is a library function, not a gate row.

## Models and variations

`default_models()`: `cube` (20 mm), `ring` (20 mm cube, 8 mm square hole), `tbar` (30x20x15 T, 10 mm overhangs both
sides: supports, bridges, overhang walls), `coupon0402` (real tray). `all_models()` adds the four other
`pnp_blinds_*_set.stl` trays. The STLs for `cube`, `ring`, `tbar` are written by `stl_cube` / `stl_tbar` (tests assert
volume and, for `tbar`, a closed 2-manifold). `variations()` lists 86 single/multi-setting variations plus the
baseline, covering layer height, wall loops, line widths, shell layers, infill density and 14 patterns, seam position,
wall order, surface patterns, ironing, Arachne, thin walls, spiral vase, raft, skirt/brim, z-hop/retraction,
fuzzy skin, compensation, anchors, supports (style/angle/build-plate-only/interface), bridge and overhang
settings. `--matrix --list` prints the exact population.

## Self-check

`cargo test -p twobee-fdm gcode_parse parity` (21 tests) and `parity --selftest` (7 controls) run with no server.
Last red run of the controls is the `--plant` / `--selftest` output in the commit body, as for the CNC gates.
