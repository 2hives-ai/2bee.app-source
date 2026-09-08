# 2026-08-28 — End-to-end application review

Requested by founder: "review the application end 2 end, make a good judgement, be honest
how the application at."

Method: four parallel read-only audits (core engine, web UI, gate harness, docs-vs-reality),
plus direct measurement on this box — `cargo test -p twobee-cam --lib`, the gate suite
(`--quick` completed; full run still in progress at time of writing), and a manual
reproduction of the web typecheck failure. Claims below are measured where marked.

## Verdict up front

**Unusually strong engineering for a pre-hardware project, with one genuine 🔴 (build red
on committed code) and 3 overstated claims.** The docs' reputation for honesty is mostly
earned — verified by running things, not reading rows.

## Measured, not trusted

- **717/717 Rust tests pass** (`cargo test -p twobee-cam --lib`, 8.4s, this box, today).
  README says 665 measured 2026-08-13 and says "count by running" — the number moved the
  direction it predicted.
- **Gate suite real**: 59 gates; `--quick` run today: **54 passed, 0 failed, 5 budgeted
  could-not-run** (I1, CTRL, RUN, AGPL, SPLNT — all expected under `--quick`).
  Verdict INCOMPLETE, correctly not a pass. Negative controls witnessed working:
  planted PENDING → NO-GO exit 1; unknown flag → exit 2 with empty stdout. Gates assert on
  **emitted G-code**, not settings (ENT, MULTI, DOOR, PROBE all read the program bytes).
- README's route-travel claim re-measured exact: `route plate` 570.548→409.115mm (28.3%).
- **Refusal discipline is real**: production code nearly panic-free (3 panic-capable sites,
  all defensible), refused jobs emit zero bytes, PENDING budget enforced — an unbudgeted
  pending is a FAIL, verified live.

## Broken right now

- 🔴 **`npm run typecheck` FAILS on committed code** — 3 errors in `web/e2e/run18.spec.ts`
  (`:113` `any`→`never`, `:138-139` `delete` on props not on the inferred type), committed
  in `a1efde7d92` (RUN-18). Reproduced manually on this box. `npm run build` is therefore
  broken. Invisible to gate I1 because the Playwright webServer runs `vite build` *without*
  typecheck, and `typecheck-coverage.test.ts` guards config coverage, not greenness.
  **Nothing catches this class of red.**
- 🔴 **The STEP importer in `core/src/mesh.rs` is unsound by this repo's own rules.** The
  module header says "STL intake"; the file hides ~600 lines of hand-rolled STEP, OBJ and
  3MF parsing, reachable from real imports (`import.rs:1965-1985`, `cli/src/main.rs:590-655`).
  `parse_step_section` (mesh.rs:1076): only planar faces within 0.1mm of the section Z
  contribute — vertical walls dropped by a bare `continue` (mesh.rs:1278-1280) with **no
  message**, the exact "plausible-looking wrong part" failure the module exists to prevent.
  Cylindrical faces emit a full circle assuming infinite, axis-vertical cylinders
  (mesh.rs:1292-1311). Circles flattened to n-gon polylines, bulges dropped
  (mesh.rs:1300-1307). Tests assert only "no geometry found" on trivial files.
  Worst gap between doctrine and code in the tree.
- ⚠ One reachable panic: `order_operations` `.partial_cmp(...).unwrap()`
  (`core/src/toolpath.rs:1780`) — a NaN `depth_total_mm` crashes instead of refusing.
  Nothing validates `OperationParams` finiteness upstream.

## Overstated claims

- 🔴 **README stack table is false**: "WASM in a Web Worker — slicing must not block the
  canvas". The CAM core loads on the **main thread** (`web/src/cam.ts:11-38`). The only
  Worker in `web/src` is the serial streamer (`run/streamer.worker.ts`). A big DXF blocks
  the canvas the README says it protects.
- 🔴 **TODO #64 is a false ✅**: the index row claims "Phase 2: multi-workpiece planning
  (each workpiece planned separately, G-code combined)" is done. The code says the opposite
  in its own 🔴 comment: "only the ACTIVE workpiece is planned" (`web/src/App.tsx:1707-1710`).
  This is the only place a ✅ currently claims a physical capability the code disclaims.
- ⚠ README stale citations: `SESSION_VERSION` says "bump to 2", code is **3**
  (`web/src/store.ts:556`) — a third bump nobody wrote back; "six rows that say `none`" vs
  the spec's current "3 citing `none`" (and gate SPEC today reports **0** `none` rows —
  the drift has moved twice); MULTI's line citation dead again (the "cite the needle, not
  the line" rule is written beside it).
- ⚠ Pockets: the engine is real and gated, but **user drawings can never produce a
  pocket** — `plan_operation` (`core/src/toolpath.rs:1762`) only dispatches drill/profile;
  `clearing_loops` is reachable only from the gate fixture (`fixtures.rs:1068`). The README
  "Geometry engine ✅ … pockets with islands" row is fixture-only as a user capability.
- ⚠ Gate **MARK** reads plan-side `render` (`gates/slicer_gate_check.mjs:3490` ←
  `core/src/fixtures.rs:4335`), not the emitted program — one doctrinal violation inside
  the harness that enforces the doctrine. Small blast radius (marking is cosmetic), but
  exactly the defect class the standing rule was written against.
- ⚠ AGPL publish probe (`probePublished`, `gates/slicer_gate_check.mjs:8748-8768`) does not
  filter RFC1918 answers — the documented 2026-08-11 false-red class (`10.0.0.1` resolver
  lie) is still open. Fail-safe direction, but unmitigated.
- ⚠ SPLNT prose drift: its GATES row says "31 self-plant controls", the registry has 34;
  budget text says "34 children … 2 clean baselines" while the drive message says 3.
  Functional logic correct (counts live); only the prose is stale — in the file that fails
  other files for stale counts.

## Genuinely impressive

- Corrected-in-place documentation culture catches even stale 🔴s — rare, and verified:
  `docs/cnc-controller-status.md` corrections are internally consistent with README,
  TODO #114/#126 and the transcript; `decision-64` was actually implemented as written.
- Store versioning: `SESSION_VERSION = 3` with the reasoning recorded per bump (2→3 because
  `zZeroTop` kept its name and changed meaning — a stored blob would cut a workpiece
  deep), version mismatch restores nothing with an operator-readable banner, per-field
  validation drops are named.
- e2e tests mostly meaningful, not presence checks: browser-vs-CLI **byte-identical**
  G-code, planted gouge caught by simulation, refused program offers no download,
  multi-drawing overlap refusal.
- Honest reds carried visibly and correctly: nothing has cut anything; the AGPL §13 offer
  is broken and budgeted PENDING (footer 404 kept deliberately until `legal` rules);
  CTRL's 2026-08-20 transcript held inadmissible rather than laundered into evidence.
- Gate harness culture: SPEC fails on empty indexes, DOOR has a "door that refuses
  everything agrees with nothing" guard, ENT carries a paired positive, PLANT audits the
  plants three ways including non-vacuity.

## Weakest tier (named, lower severity)

- AuthGate has zero test coverage — a named hole, still a hole: Cognito misconfig ships
  green (TODO #133).
- Tail tests in `slicer.spec.ts`: theme-toggle test vacuous if the toggle is absent;
  "stock box matches the numbers" asserts only that a data attribute contains the word
  `datum`.
- `SPARE_COLLETS_MM` hardcoded in `App.tsx:401`, mirroring the core's reference machine by
  comment only — silent-divergence risk.
- `styles.css:8` imports `brand/tokens.css` by relative path outside `web/` — `web/` cannot
  build standalone; only two I1 tests would catch a dead import.
- 19 build warnings (unused imports/variables); `depth_passes` implemented twice
  identically (`rect_profile.rs:83`, `toolpath.rs:371`); `group_by_tool` inner/outer
  classification by name substring (`toolpath.rs:1843-1882`).
- TODO.md id space compromised by its own admission: #65–#69 double-assigned, the
  full-gate-run series restarts at #126 colliding with main-series #126–#139.
- `App.tsx` 11,308 lines / `Viewport.tsx` 7,188 — monolith tax.

## Bottom line

Ship-shape core, trustworthy gates, docs better than any comparable tree. **Actions, in
priority order:**

1. Fix `run18.spec.ts` type errors — the build is red *now* and no gate watches the class.
2. Refuse or fix the STEP importer — it violates the lane's first rule (name it, never
   skip it) on a path that feeds the spindle.
3. Correct the README worker row and TODO #64 — both claim capabilities the code
   explicitly disclaims.
4. Fix the `order_operations` NaN unwrap.
5. Repair MARK to read the emitted program (or annotate the row), filter RFC1918 in the
   AGPL probe, refresh the stale citations.

Physical validation remains honestly zero: nothing has cut anything; a board parsed 47/50
lines once (2026-08-20, inadmissible transcript, re-probe is TODO #126). The app is at
"credible software, unproven on hardware" — and says so itself, which is the strongest
signal in this review.

---

**Full gate run landed (same day, this box): 56 passed, 0 failed, 3 could-not-run** —
RUN, CTRL and AGPL, all budgeted, all blocked on hardware (`gates/controller/` transcript)
or `legal`'s §13 mechanism ruling, not on anything this lane can fix in code. The two gates
the `--quick` run skipped both ran and passed in the full run: **I1** (browser suite,
wasm rebuild, parity) and **SPLNT** (all 34 self-plants driven against clean baselines and
observed to move their gates). Verdict INCOMPLETE — correctly not a pass, and the three
pendings are the honest ceiling of what can be verified without a machine on the USB cable.
