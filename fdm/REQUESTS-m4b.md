> **Status 2026-11-27 (2bee_app):** written 2026-10-14 during the multi-material (M4B) build and left
> uncommitted until now. Re-checked today: the refusals are still in code (`src/gcode_mm.rs:300`
> both-extruder multi-material and `:303` M83; `src/wipe_tower.rs:186-188` rotation, smooth timelapse,
> wrapping detection). NOT re-measured: the ~11% print-time gap and the ~0.2% flush gap vs OrcaSlicer.
> They are from 2026-10-14 and may have moved. The parity gate still has no tool-change rows.
> Nothing here has printed.

# M4B requests / notes for the lead
- No types.rs change: filament per path is a side table `GcodeOptions.multi = Some(MultiMaterial{path_filament[layer][path], ..})` (src/gcode_mm.rs). M4A fills it.
- wipe_tower.rs / gcode_mm.rs are loaded from gcode.rs via #[path]; no lib.rs line needed (if you add `pub mod wipe_tower;` remove the #[path] line).
- Refused (FdmError::Unsupported): filaments on BOTH X2D extruders (nozzle change/ramming), smooth timelapse, wrapping detection, rotation != 0.
- Not matched: estimated print time of tool-change files is ~11% low vs Orca (estimator gap, cause not found); flush length ~0.2% high.
- parity gate has no tool-change/per-filament rows: tools/mmstats.py, tools/towerstats.py in /home/gbacs/build/fdm-corpus/tools/ compare them.
