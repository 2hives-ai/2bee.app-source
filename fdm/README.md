# twobee-fdm

FDM slicing core for the Bambu Lab X2D, in Rust, parity-tested against OrcaSlicer's G-code.
Separate workspace member; does not touch `twobee-cam` and does not flip `Technology::Fdm`.

Status: skeleton + lanes under construction. Nothing here has printed anything.

**Used by the app since 2026-10-16** (founder: *"no orcaslicer anymore!"*): `tools/print3d-bridge` slices the 3d tab with
`fdmslice --presets` by default. That mode takes its settings from Orca PRESET FILES (`Config::from_presets`, per-variant
keys reduced by Orca's own key sets) plus `--defaults` (`tools/print3d-bridge/orca-defaults-x2d.config`, the values Orca
compiles in for keys no preset sets), one filament per plate, and never runs Orca. Still nothing has printed.

| lane | module(s) | scope |
|---|---|---|
| 1 | config, mesh, slice, geom | Orca CONFIG_BLOCK/preset parsing, STL, layer slicing, boolean/offset |
| 2 | walls, arachne | classic walls, gap fill, thin walls, Arachne |
| 3 | surfaces | top/bottom/solid/bridge/overhang classification |
| 4 | infill | sparse patterns + connections |
| 5 | motion, gcode | seam, travel, retraction, skirt/brim, machine G-code, time |
| 6 | supports | normal/tree supports, raft |
| 7 | effects | ironing, fuzzy skin, spiral vase, surface patterns |
| 8 | gcode_parse, parity, bin/parity | G-code statistics + OrcaSlicer comparison gate |
| lead | pipeline | orchestration |

Reference prototype (JS, this machine): `/home/gbacs/build/web-slicer/` (engine/, tools/compare.js, PARITY numbers in the handover ticket).
Reference implementation: OrcaSlicer source `~/build/OrcaSlicer/src/libslic3r/`; local CLI `~/build/OrcaSlicer/build/package/bin/orca-slicer`.
