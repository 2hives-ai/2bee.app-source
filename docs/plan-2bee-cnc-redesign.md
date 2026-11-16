# 2bee.cnc redesign: the 2bee.3d approach for the CNC router

Founder, 2026-10-14: *"I really like the approach / look and feel of http://127.0.0.1:8765/ (pnp's
2bee.3d); we should use similar for the cnc: left side is the end object, then AI for all the
customizations, then send — and an extra page that guides the user through the process (tool change,
put the panels in, clamp it down) … manage multiple cnc machines."*

## Rulings (founder, 2026-10-14, asked directly by this lane)

1. **A separate CNC page** in the 2bee.3d style. 2bee.3d stays pnp's printer tool.
2. **A network bridge per router.** A small service on each router's controller computer. One screen
   sees and drives every machine on the LAN.
3. **The app streams the program, with an operator present.** It sends only after every checklist line
   is ticked, a forced air cut, and an "I am at the machine" confirmation. Nothing from this app has cut
   yet, so the first runs climb the ladder air cut → test panel → real ply, jointly with `ops`.
   (Contrast the printer: upload only, no remote start, ruled the same day.)

## What 2bee.3d does well (reviewed from the live page)

The page has three zones and about 260 words:
- **Left:** the objects, then the assistant's question chips and chat.
- **Centre:** the 3D plate and one results line.
- **Below:** the machine cards (status, camera, scan/add).

The AI is the settings panel and the machine is a card. 2bee.cnc today has about 1,137 words and 93
controls.

## Two pages, because a CNC job is not fully automatic (founder 2026-10-14)

*"have a separate jobs page where the operator can manage the jobs"* · *"on the main page just monitor the cnc and
send the job to the cnc"* · *"just because it has to be clamped down, etc … cnc is not 100% automatic"*.

- **Main page (2bee.cnc):** design + AI + machine cards that MONITOR (grblHAL state Idle/Run/Hold/Alarm/Door, job and
  progress) + **"Send to cnc-NN" = add to that machine's queue; it never starts motion.** One exception: **Feed Hold**
  on any running machine's card. Stopping is allowed from anywhere the machine is shown; starting is not.
- **Jobs page (the operator, at the machine):** a queue per machine and history; open a job → the guided run (load →
  clamp → cutter 1 → zero → forced air cut → "I am at the machine" → run); tool-change and clamp-change prompts at M0;
  feed hold / resume / abort; progress. The manual steps live here.

## Hard precondition from pcb/ops (2026-10-15)

- **NO E-STOP EXISTS.** The mushroom NC switch and contactor were designed and never ordered; the firmware has
  `ESTOP_ENABLE 0`. Router operation is on HOLD (ops: insurance, venue).
  ⇒ **Run stays DISABLED, with that reason on screen, until a physical e-stop is installed and ops lifts the HOLD.**
  The software is built and tested against the simulated controller meanwhile.
- **Bridge host:** the RPi Zero 2 W in the enclosure. It reaches the SKR Pro over USB CDC through pcb's hbs57_usb6 hub
  and opens `/dev/serial/by-id/…` (never `ttyACM0`). Wi-Fi, `cnc-NN.local` (proposed), Tailscale only for remote
  access, never a port forward. **CNCjs already runs on :8000, and only one sender may hold the port:** the bridge
  replaces it, or refuses to stream while it is connected (founder's call). Safety state comes from grblHAL's `?`
  report (`Alarm` = driver alarm on the reset input; `Door` = VFD fault, needs `SAFETY_DOOR_ENABLE`, to be checked
  in the build).

## pcb correction (2026-10-15-01-20-26): status is not safety

- The ALM → reset-input and VFD-fault → safety-door mappings are **designed, not wired**. grblHAL's `?` report
  is **telemetry**. The UI never presents an e-stop or door state as real, and **never treats the absence of
  `Alarm`/`Door` as "safe"**.
- **Streaming is refused until ops closes H5 (e-stop installed), regardless of operator presence.** The machine
  record carries `estopInstalled: false`, with no UI to flip it.
- Host picked by pcb: **RPi Zero 2 W, `cnc-01` (`cnc-01.local`), Raspberry Pi OS Lite 64-bit**, inside the sealed
  control enclosure; ops records the SOP row.

## Screen 1: Job

- **Left: what you're making.** Catalogue designs or a dropped DXF/SVG/STL. Each part shows its
  picture, size and quantity.
- **Left: Cut assistant.** Chips: workpiece and material · which cutters (registered only) · tabs? ·
  finish or speed · dogbones? · hold-down · nest tight · check my job. There is also free text through
  `tools/claude-bridge`. The model proposes **job settings only, never G-code** (`cnc/jobAsk.ts`,
  option B), and the core re-plans and validates every proposal.
- **Centre: the workpiece in 3D.** Parts placed, toolpaths toggled, clamp zones. One results line:
  time · cutters · tool changes · deepest cut.
- **Below: Machines.** One card per router: name, status, work area, cutters loaded, camera. Add/Scan
  includes the read-only **Analyse router** step. The job is planned against the chosen machine.

## Screen 2: Cut (the guided run)

Built from `core/src/setup.rs` facts read off the real program, with 3D views (`Measure3D`). Each step
is ticked:
1. Load the workpiece.
2. Clamp it, with the keep-outs shown.
3. Fit cutter 1 and check the collet.
4. Set zero, or probe.
5. **Air cut.** Forced first, spindle off, Z lifted.
6. Cut. Each M0 tool change shows "fit cutter N"; clamp-change pauses show the new positions.
7. Done.

## Exists vs missing

| Exists | Missing |
|---|---|
| catalogue; `autoPlan.ts` + core import plan; `jobAsk.ts`; `setup.rs` facts (hash-tied); Tools tab + photos; router analysis + guided measurements; Run tab sender (fake controller only); print-job validator pattern | several parts per workpiece in the planner; clamp PLACEMENT (the core only checks clamps); tools per MACHINE; machine registry + cards; the router network bridge; the guided run page; any run against a real controller (CTRL gate, physical ladder) |

## Phases (each gated, with red runs, like the rest of this lane)

1. **Page shell.** New `2bee.cnc` page in the 2bee.3d layout, reusing today's pieces. The old CNC tab
   stays behind Expert tools.
2. **Machines.** Registry and cards: router profile from Analyse, tools per machine, the job planned
   against the chosen machine.
3. **Router bridge.** Per-machine service: serial↔LAN, the same security pattern as the printer/claude
   bridges, read-only status first, streaming only behind the run page's gates. Hardware and placement
   come from `pcb`/`ops`.
4. **Cut assistant.** Chips + AI through one validator.
5. **Guided run page.** setup facts → steps; forced air cut; streaming through the bridge.
6. **Several parts per workpiece,** and clamp placement in the core.

Nothing here has cut anything.
