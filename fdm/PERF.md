# twobee-fdm performance (lane 10)

Harness: `cargo run --release --bin fdmbench -- --threads 1,2,24 --reps 3 --gcode a.gcode[,b.gcode] --gcode-mb 60`
(`src/bench.rs` is pulled in by the bin with `#[path]`, it is not a lib module). Per stage: wall time, exact allocation
count/bytes (counting global allocator), peak RSS, and an order-sensitive bit hash of every output (FNV over f64 bit
patterns). The hash is the equality proof: it is identical before/after and across thread counts. Exit 1 on mismatch.
`FDMBENCH_BREAKDOWN=1` prints per-geom-op costs. Machine: 24 cpus, SHARED (loadavg 35-50 during the runs), so every
number below is the minimum of 4 alternating base/new invocations x best-of-3. Treat +-10% as noise.

## Delivered (lane 1/8 files): before -> after, hashes identical on every row
| stage (1 thread) | before | after | x |
|---|---|---|---|
| load STL 200k tris (parse+weld) | 33 ms, 30 MB alloc | 21 ms, 12 MB | 1.6 |
| Mesh::validate 200k tris | 115 ms | 25 ms | 4.6 |
| slice_mesh sphere 200k tris/400 layers | 65 ms, 379k allocs, 154 MB | 42 ms, 14k allocs, 100 MB | 1.5 |
| slice_mesh tray sets (4-14k tris) | 2.6-13.5 ms | 1.5-7.9 ms | 1.5-2.1 |
| gcode_parse 61 MB Orca G-code | 450 ms (135 MB/s), 6.8M allocs | 277 ms (220 MB/s), 5k allocs | 1.6 |
| parity::compare_text (2 parses) | 891 ms | 440 ms (2 parses in parallel) | 2.0 |
| geom ops per layer (offset/diff/union/hatch) | unchanged | unchanged | 1.0 |

Did NOT help: removing the 7M per-line allocations in gcode_parse alone (-99.9% allocs) moved wall time <5% (malloc
is cheap here); the win came from feature interning (3-4 BTreeMap<String> lookups per move -> Vec index). The exact
decimal fast path (`fast_decimal`, Clinger) is bit-identical to `str::parse` (400k-sample test) and gained ~5%.
`config::from_gcode` jump-to-marker: no measurable change (the CONFIG_BLOCK sits near the file start in Orca output).
geom offset/diff/union cost is inside i_overlay (`outline()` of a re-offset ring is 5x the first offset: 4 ms vs 0.8 ms
for 1.3k points); nothing exact can be done in the wrapper (see "not bit-identical" below).

## Parallelism (native only, `#[cfg(not(target_arch = "wasm32"))]`, serial fallback on wasm; wasm32 check passes)
* `slice::par_map(items, threads, |i, x| ..)` / `par_map_chunked`: deterministic ordered map (atomic chunk counter,
  results stored by index). `slice::default_threads()` = env `FDM_THREADS` or hardware parallelism, 1 on wasm.
* `slice::slice_mesh_threads(mesh, specs, opt, threads)`; `slice_mesh` uses `default_threads()` capped at tris/2048
  (spawning 24 threads for a 12-triangle cube cost 9 ms vs 0.2 ms serial). Layers are cut+chained+regioned
  independently; per-layer triangle lists are built once by counting sort in ascending triangle order (O(T+L+hits)),
  so segment order, hence every float, equals the serial result. Tests: parallel==serial on cube/ring/torus/open mesh
  at 1,2,3,5,8,32 threads, a planted-difference negative control, par_map ordering.
* `geom::hatch_threads(.., threads)`: bit-identical to `hatch`, per-line clips on several cores.
* geom ops over 100-400 real layers, 12 threads (loaded machine): sphere 6.2 s -> 0.56 s (24 thr), torus 4.0 -> 0.48,
  trays 0.9 -> 0.32. Bit hashes equal for 1/2/24 threads.
* Float summation order: unchanged everywhere (no reduction was parallelised; gcode_parse is a sequential state
  machine and stays one thread per file).

## Opt-in, NOT bit-identical (needs a lead decision, not applied by default)
`geom::hatch_batched`: all hatch lines in ONE i_overlay clip instead of one call per line: 6.5-7x faster (sphere 2.7 s ->
0.4 s over 400 layers). i_overlay quantises onto a grid whose origin/scale come from each call's bounding box, so the
batched grid differs: same segment count and order on all 8 models, end points differ by <= 1.1e-5 mm. Nobody calls
`hatch` today (infill has its own fills). The same effect means: batching/merging ANY two geom calls changes bits.

## Findings for lanes still being written (measured on a current copy of the shared tree; G-code byte-identical)
Stage profile of `pipeline::slice_with_config` on pnp_blinds_16_set (66 layers), 1 thread, loaded machine:
walls 0.44 s | surfaces::classify 1.6 s | fill_layer+sparse 2.7 s | motion+gcode 0.34 s | slice+load 0.003 s.
1. **pipeline.rs steps 1 and 3 are serial loops over independent layers.** Wrapping them in `slice::par_map` (walls via
   `generate_walls(&l.region, lower, upper, ..)`, fill via `fill_layer` + `fill_sparse`) gave BYTE-IDENTICAL G-code on
   coupon0402/12/16 sets. walls 0.33 -> 0.07 s (12 thr). Step 3 only 5.5 -> 4.4 s because of finding 2.
2. **surfaces/narrow.rs `split_solid_surface` + fill.rs `concentric_internal` are ~85% of step 3.** One layer (11) costs
   1.8 s of 2.7 s on the 16-set (3.3 s of 5 s on coupon0402); layer 15 another 0.46 s. Measured with timers: layer 11
   split_solid_surface 1.1-1.2 s, concentric_internal (walls::medial_axis on 8 narrow islands) 0.53 s. Cause by
   reading: for each of n_v threads it scans ALL ring edges (O(n_v*E)) and calls `inside(&inner, x, mid)` (O(E)) per
   candidate section. Fix: sort edges once by x-range and sweep, replace per-section point-in-polygon by crossing parity
   (k even/odd in the sorted ys). Also `line_fill` has an O(S^2) neighbour sweep (`segs` x `orig`, fill.rs ~L294) that did
   not show up above 50 ms here but grows with threads per island; bucket by `k`.
3. **surfaces::classify is serial: 1.6 s on the 16-set**: discover_vertical_shells 0.60 s, bridge_over_infill 0.44,
   process_external_surfaces 0.32, detect_surfaces_type 0.20. detect_surfaces_type and process_external_surfaces are
   per-layer functions of (layer i-1, i, i+1) inputs: compute into a new Vec with `par_map`, then assign.
4. gcode::generate (motion+gcode) 0.2-0.45 s serial: layer-local pieces (seam, travel planning) could use par_map only if
   the previous-layer end position is not an input; time estimation must stay sequential (running sum order).
5. Many tiny `poly::offset(&vec![p.clone()], d)` calls per polygon (supports/grid.rs:253, infill.rs:439): each builds a
   fresh i_overlay adapter; merging them changes bits (see above) but is the cheapest big win where bits may change.
6. `bin/parity.rs` (lane 8, not editable here) parses Orca and ours with `parse` one after the other; use
   `parity::compare_text` (now 2 threads) for a 2x.
