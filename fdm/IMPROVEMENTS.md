# twobee-fdm: improvements over OrcaSlicer 2.5.0-dev (lane 9)

Product scope (founder, via 2bee_app): FDM is the *Make* step: tell the user what to set up, remove user decisions, no new knobs.
So every item here either (a) tells the user something before printing, (b) removes a setting decision, or (c) post-processes toolpaths.

**Everything is opt-in.** The Orca-parity path never calls any of this. `autoconfig` returns a `SettingsDelta` that only changes a `Config` when
the caller runs `delta.apply(&mut cfg)` (an empty delta is a measured no-op, and a key the base config lacks is refused). `pathopt` takes a plan
and returns a new one. Baseline = Orca's own G-code, reconstructed or re-sliced on this machine (Orca 2.5.0-dev, X2D 0.4, PETG coupon profile).

Reproduce (needs the local Orca server on :8765 and Orca CLI for `eval-orient`; without them every comparison prints PENDING, never PASS):

```
cargo build --release --bin improve
improve eval-preflight  DIR            # 62 solids with known truth, P/R per flag, estimate vs Orca header
improve eval-models     a.stl b.stl    # preflight on real models next to what Orca did
improve eval-autoconfig DIR [--only=a,b]   # base / naive support-on / auto, 4 Orca runs per model
improve eval-pathopt    orca.gcode ... # reconstruct Orca's order, optimise, PROOF of identical extrusion
improve eval-orient     DIR            # our orientation vs Orca --orient 1
improve preflight model.stl orca.gcode [--json]
```

## 1. Built and measured

| # | module | what | measured result | not measured / caveat |
|---|---|---|---|---|
| 1 | `preflight.rs` | bed fit, filament/time estimate, overhang + bridge span, thin features, adhesion, stability, warp, recommended filament/nozzle/plate/temps/AMS, plain-language setup list, mesh health | table 1a | thresholds for warp/bridge limits per material are rules of thumb |
| 2 | `improve/autoconfig.rs` | settings recommender (support on/off + type, brim, wall generator, layer height, walls/infill by use, thick bridges) with `--explain` | table 2 | print *quality* effects (layer height, brim) are not visible in G-code |
| 3 | `improve/pathopt.rs` + `gcode_plan.rs` | island + infill ordering, seam alternatives, min-layer-time allocation, extruded-segment PROOF | table 3 | gain is under a retraction MODEL (86-97% precision, 100% recall vs Orca's own decisions); no G-code was written by us |
| 4 | `improve/orient.rs` | automatic orientation priced by support / contact / time | parity with Orca `--orient 1` (table 4) | **no gain over Orca** |

### 1a. preflight accuracy (`improve eval-preflight`, 62 synthetic solids with analytic truth; 60 sliced by Orca, 2 refused by Orca because they do not fit the bed)
Truth is analytic (slope angle, bridge span, wall width, footprint) and, for three flags, ALSO what Orca actually produced: support with `enable_support=1`, any extrusion above the slab for a thin wall.

| flag | n | TP | FP | FN | TN | precision | recall |
|---|---|---|---|---|---|---|---|
| has_overhang (analytic) | 45 | 21 | 0 | 0 | 24 | 100% | 100% |
| has_overhang vs **Orca emitted support** | 49 | 22 | 0 | 1 | 26 | 100% | 96% (miss: a cone on a 1 mm tip, Orca adds support under the tiny contact) |
| needs_support (cantilever or bridge > limit) | 29 | 13 | 0 | 0 | 16 | 100% | 100% |
| bridge_over_limit | 15 | 6 | 0 | 0 | 9 | 100% | 100% |
| thin_unprintable (classic) vs analytic | 43 | 7 | 0 | 0 | 36 | 100% | 100% |
| thin_unprintable (classic) vs **Orca output** | 12 | 7 | 0 | 0 | 5 | 100% | 100% |
| thin_unprintable (arachne) vs **Orca output** | 12 | 2 | 0 | 0 | 10 | 100% | 100% |
| adhesion_high / tall_slender / warp_high / fits_bed | 7 / 5 / 3 / 5 | | 0 | 0 | | 100% | 100% (few positives) |
| **hold-out** (slopes 22/27/34/38/55, bridges 9/14/22, walls .30/.38/.46/.55/.90, chosen after thresholds were fixed) | 13 overhang, 8 needs_support, 13 thin | 5 / 4 / 2 | 0 | 0 | | 100% | 100% |

Honest reading: the shapes are simple and I chose them; the thin-wall thresholds (classic 0.42 mm = one line, arachne ~0.19 mm) were measured on the
same wall sweep (in-sample), the slope/bridge flags follow Orca's own layer-difference rule (`SupportMaterial`) and were not tuned except the 0.004 mm
sliver opening. Precision 100% on a small synthetic set is NOT a claim about arbitrary models. Orca-specific finding: Orca-with-arachne does not print
0.18 mm walls but prints 0.20 mm (`min_feature_size` 0.1 mm is not the limit).
Estimate vs Orca header over 60 baseline cases: filament mean error +3.3% (mean |err| 6.3%); on the 5 real pnp trays -1.7%, -0.9%, -2.8%, -1.8%,
-2.2%. Print time is a rough model (mean |err| 33% on synthetic parts, -15..-26% on trays: complex parts are slower than any ideal-speed model).

### 2. autoconfig (`improve eval-autoconfig`, Orca model time / filament, naive = "support on", base = "support off")

| model | what auto decided | base | naive support-on | auto |
|---|---|---|---|---|
| cube, tube, window (pocket bridge 12 mm), 8 mm bridge, coupon tray | support stays/turns OFF (+ thick bridges on bridges >= 6 mm) | 23.2 min / 3.48 g (cube) | same (cube); 8 mm bridge 19.6 min / 2.61 g | 8 mm bridge 16.9 min / 2.26 g: **-14% time, -13% filament vs support-on** |
| T cantilever | support ON, `normal(auto)` instead of tree | 17.3 / 2.43 (fails) | 25.9 / 3.68 | 19.2 / 3.90 : **-26% time vs naive support-on** |
| mushroom | support ON normal + brim | 12.3 / 1.98 | 27.5 / 3.61 | 17.0 / 3.62 : **-38% time** |
| 20 mm bridge | support ON normal | 18.1 / 2.93 | 26.1 / 3.99 | 19.4 / 3.98 : **-26% time** |
| 0.25 / 0.35 mm wall | `wall_generator=arachne` | wall NOT printed (classic) | same | wall printed, +1.9 min, +0.08 g |
| 5x50 tower | brim 8 mm, 3 walls, 20% infill | 29.3 / 1.42 | | 29.2 / 1.50 (+0.08 g) |

Support type (rule `support_type -> normal(auto)` when overhang >= 100 mm2): Orca normal vs tree on 6 shapes, model time -38, -26, -25, -24, -10, 0 %
(median -25%), filament -2..+6%. Not measurable from G-code: removal ease and surface finish (tree is gentler); that is why the rule is limited to wide overhangs.
Support turned off where not needed (9 cases, isolated A vs B): -6% time, -3% filament in total (the effect is concentrated in the 8 mm bridge and window cases).
Rules marked `rule:` in the explain text (brim size, layer height, walls/infill by use) are NOT measured; sphere: layer height 0.16 raised time 33.0 -> 43.8 min.

### 3. pathopt (`improve eval-pathopt`): Orca's order reconstructed from its G-code, model retractions, same extrusion PROVEN

Orca actual vs our model on Orca's order: retraction count +5..+14% (model over-counts), travel -11..-20% (model excludes wipe/z-hop moves).
Retraction rule vs Orca per travel (n = 4743..23629 travels per model): recall 100%, precision 86% (coupon), 93% (12), 92% (16), 95% (8emb, 8paper).
Rule source: `GCode.cpp` ~8798 `needs_retraction` + `RetractWhenCrossingPerimeters::travel_inside_internal_regions` (read, not guessed).

| model | Orca actual retractions | model on Orca order | optimized | change | travel mm model -> opt | proven lower bound (any order) |
|---|---|---|---|---|---|---|
| coupon0402 | 737 | 840 | 721 | **-14.2%** | 29639 -> 26151 (**-11.8%**) | 115 |
| set_12 | 1777 | 1910 | 1472 | **-22.9%** | 103488 -> 87815 (**-15.1%**) | 282 |
| set_16 | 1473 | 1591 | 1255 | **-21.1%** | 97738 -> 81707 (**-16.4%**) | 260 |
| set_8emb | 2965 | 3118 | 2699 | **-13.4%** | 130236 -> 104285 (**-19.9%**) | 408 |
| set_8paper | 3569 | 3737 | 3391 | **-9.3%** | 123646 -> 101046 (**-18.3%**) | 343 |
| cube / ring / T | 197 / 322 / 134 | 196 / 327 / 136 | 196 / 303 / 135 | 0 / -7.3% / -0.7% | -1.9 / -1.8 / -8.2% | 0 / 0 / 0 |

The lower bound is the number of component gaps >= `retraction_minimum_travel` per layer (valid for any ordering of the same paths); it is loose
because most retractions are between walls / top-surface lines whose order is fixed by the quality rules (e.g. coupon: 305 of the 721 left). Gain comes
from sparse-infill and internal-solid-infill runs (sparse->sparse 598 -> 250 on set_12) and from visiting islands in a shorter tour (travel).
PROOF: `verify_same_extrusion` compares the per-layer multiset of (feature, width, segment); segments of reorderable features are undirected, ALL
others directed; OK on all 8 models (74335 / 197325 / 182777 / 234569 / 221416 / 6252 / 7579 / 4908 segments) for full, islands-only and infill-only runs. Negative controls in the unit tests: dropped path, 2 um shift, reversed wall, changed feature all fail.
Quality rules kept: walls, top/bottom surface, bridge lines keep order AND direction; only consecutive same-feature sparse / internal-solid / gap / internal-bridge / support
paths are reordered; islands are reordered only if each island is one contiguous block (so walls-before-infill is never broken). Seams: for exactly closed
outer loops `rotate_seams` (concave / aligned) keeps the edge set (proved by the same check); Orca's loops are open (a gap), so the seam comparison on Orca
data is a polygon metric on closed-ified loops: set_12 mean layer-to-layer seam jump 0.42 -> 0.14 mm, concave share 9% -> 16%; set_16 0.34 -> 0.33; 8emb 0.48 -> 0.20; 8paper 0.46 -> 0.44; coupon 0.18 -> 0.09.
That a concave seam hides better is a rule, not measured here. Min layer time (`balance_layer_time`): changes `speed` only; total added time equals Orca-style
uniform slowdown BY CONSTRUCTION (cube: 756 s both), the difference is that hidden infill / inner walls absorb it first (outer wall untouched in 98 of 98 short layers on
the cube). Whether that prints better is not measurable here.

### 4. orientation (`improve eval-orient`): our pose vs Orca `--orient 1` (CLI)
T upright, T on its side, mushroom, 20 mm bridge, 25 degree slope, 5x50 tower, the real coupon tray. Our pose and Orca's gave the same result on all of them:
support 13586 mm -> 0, model time 25.9 -> 17.2 min (T), tower 29.3 -> 6.4 (ours) / 7.5 (Orca, with auto brim rule); the tray is kept by both. **Orca's own auto-orient already
solves these cases, so this is parity, not an improvement.** It is shipped because it prices the same things the user is told (and is a pure function), not because it wins.

## 2. Researched candidates (web search; sources are what the research found, I did not re-verify the issue threads beyond the titles)

| candidate | source | status |
|---|---|---|
| island TSP ordering + retraction-aware travel | Orca #5217 "avoid crossing" failures; NozMod (Kaplan et al., SCF'22); Fok et al. rural postman | **built** (3) |
| per-island minimum layer time | Orca #10206 (stale), #11318 | **partly built**: allocation function only. Orca's rule is per layer; per-object cooling needs the print-by-object path, not built |
| seam placement scoring (concave, supported, aligned) | Orca #15380, #12270, #12271 (scarf starts in mid-air) | **built** as metric + rotation for closed loops; scarf ramps not built (no scarf in this crate) |
| auto-orientation pricing bridges/cantilevers | Orca wiki auto-orient; #11540, #10234 | **built**, measured parity with Orca (no gain) |
| shortest-span bridge direction | Orca #11942 | **checked, not an improvement**: on a 30x12 pocket ceiling Orca bridged at 90 deg = across the 12 mm span (`improve bridge-dirs`); `Bridge.angle_deg` in preflight reproduces the choice |
| adaptive layer height (cusp + roughness) | Wasserfall, Hendrich, Zhang, IEEE CASE 2017 | **not built**: Orca `SlicingAdaptive.cpp` (read) already does cusp height with horizontal-facet snapping; no demonstrated gap |
| auto brim size / mouse ears from adhesion risk | Orca #2807 (no per-spot ears) | **brim width built** (rule, not measured); ears **not built** (needs first-layer corner geometry in the motion lane) |
| wall count from medial-axis thickness | Kuipers et al., Arachne (arXiv 2004.13497) | **not built**: Arachne exists; autoconfig only decides classic vs arachne (measured) |

## 3. Facts found on the way (useful to the lead)
* Orca's STL reader rejects a binary STL whose normals are all zero and whose first bytes are < 0x80 ("can not be parsed"): cube 40 failed, cube 20 did not. Write real normals.
* The server's `set=` accepts only `[\w .,%/@+-]*`: `support_type=normal(auto)` is rejected. `improve::orca` uses a scratch process preset (removed after each run) or the Orca CLI.
* With `enable_support=1` the large pnp trays (234 mm wide) are refused by Orca ("no object fully inside"): support/skirt does not fit the 256 mm bed.
* Orca's `--orient 1` CLI works with the settings saved by the server (`improve::orca::cli_slice`).
* Orca adds a few tree-support layers under a cone resting on a 1 mm tip (contact area 3 mm2); preflight does not predict that (the one miss in 1a).
* The pnp coupon has 12 slivers 0.32 mm x 92 mm in one layer (z ~ 9.4, set_16): classic walls drop them; preflight says so and that it is a single layer.
