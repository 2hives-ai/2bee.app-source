# print3d-bridge: slice a 3D print job with 2bee.fdm (no printer access)

The server half of the 3D print tab (`web/src/print3d/`). It is a migration of `pnp`'s 2bee.3d
(`/home/gbacs/build/web-slicer`, node `server.js` on 127.0.0.1:8765; founder 2026-10-15: *"migrate
the 2bee.3d into this app"*). A small Node server with no npm dependencies. It takes STL files from
the app, slices each plate for the Bambu Lab X2D (0.4 nozzle), and hands back the G-code and the
engine's own numbers (time, layers, grams). The app arranges the parts itself and sends fixed
placements; the bridge's own arrange routes still work and run on the selected engine.

## What slices

**2bee.fdm, by default** (2026-10-16, founder: *"no orcaslicer anymore!"*): this app's own Rust
engine, `fdm/src/bin/fdmslice.rs --presets` (crate `twobee-fdm`, build with
`cargo build --release -p twobee-fdm`). 🔴 **It has not printed anything.** The app's gate ENGINE
keeps Upload off until a person marks the first print as a calibration print.

- **Settings source:** Orca PRESET FILES in `~/.config/OrcaSlicer` (machine `Bambu Lab X2D 0.4
  nozzle`, the job's process preset, one filament preset), read only, plus
  `orca-defaults-x2d.config`: the values Orca compiles in for keys no preset sets, captured once
  from a real Orca X2D slice (its header says which, and which per-job keys were left out). Only keys
  the presets left unset are taken from it. The bridge's startup line says this.
- **Nothing on the default path spawns, stats or reads the `orca-slicer` binary** (a test runs the
  bridge with a fake orca that leaves a marker if spawned, and asserts the engine argv).
- **Refused, not approximated:** several filaments on one plate (one slot per plate for now); a
  custom G-code template the engine could not render (`FDM-UNRESOLVED` in the file fails the
  slice); an object the engine reports more than 0.05 mm away from where it was asked to go.
- **Absent, not invented** (fields an Orca reply had): `wipeTower`, Orca's plate.json object boxes,
  Orca's slice_info warnings. The reply lists them in `notComputed` and names `engine`.
- If `fdmslice`, the defaults file or the X2D machine preset is missing, every slicing route answers
  **503 with the reason**. There is no fallback to Orca.

**`--engine orca`** runs the OrcaSlicer CLI instead (the reference, for the parity tool): the
bridge picks the profiles, writes Orca's input files, runs `orca-slicer` and reads back what Orca
wrote.

## 🔴 It never talks to a printer

- No MQTT, no FTP or FTPS, no start, pause or stop, no camera. The bridge opens no network
  connection to anything. It spawns `fdmslice` (or, with `--engine orca`, `orca-slicer` and `unzip`), and it reads and writes files.
- It **never reads `OrcaSlicer.conf`**, which is where 2bee.3d took the printer's IP and LAN
  access code from. It reads only Orca's preset folders (`system/BBL`, `user/default`), read-only.
- Sending a sliced plate to the printer is `tools/printer-bridge`'s job: **upload only**, and a
  person starts the print at the printer's own screen (founder 2026-10-14).
- The filament slots and the build plate are **declared by the person** (`PUT /v1/slots`). They
  are not read from the printer.
- **Nothing has printed from this code.** The 10 mm cube in the tests was sliced, not printed.

The tests hold this in two ways: every printer-shaped path (`/api/printer/start`, `/v1/print`,
`/v1/send`, `/v1/upload`, `/api/camera`, ...) answers 404, and with comments stripped, no file in
this directory contains `mqtt`, `8883`, `basic-ftp`, `ftp`, `OrcaSlicer.conf`, `access_code` or
`project_file`.

## Run it

```bash
node tools/print3d-bridge/bridge.mjs                                     # token generated and printed
PRINT3D_BRIDGE_TOKEN='<16+ chars>' node tools/print3d-bridge/bridge.mjs --port 8789
node tools/print3d-bridge/bridge.mjs --token-file ~/.config/2bee/print3d.token
```

It binds **127.0.0.1 only**. If the engine or the X2D machine profile is missing, the bridge
still starts so the app can say why. `/v1/health` reports `engine.found:false`, and every route
that needs the engine answers **503** with the reason.

Every flag (any other flag exits **2**):

| Flag | Default |
|---|---|
| `--port N` | 8789 |
| `--host 127.0.0.1` | the only accepted value; anything else exits 2 |
| `--allow-origin URL` (repeatable) | added to `http://localhost:5178`, `http://127.0.0.1:5178`, `https://2bee.app` |
| `--token-file PATH` | else env `PRINT3D_BRIDGE_TOKEN`, else a token generated for this run and printed |
| `--engine twobee-fdm\|orca` | `twobee-fdm` (2bee.fdm); `orca` = the OrcaSlicer CLI, for comparison runs only |
| `--fdm-bin PATH` | env `FDM_BIN`, else `target/release/fdmslice` of this repo |
| `--fdm-defaults FILE` | `tools/print3d-bridge/orca-defaults-x2d.config` |
| `--orca-bin PATH` | env `ORCA_BIN`, else `~/build/OrcaSlicer/build/package/bin/orca-slicer` |
| `--orca-config DIR` | env `ORCA_CONFIG`, else `~/.config/OrcaSlicer` (read only) |
| `--data-dir DIR` | `~/.local/share/2bee-print3d`: `slots.json`, `jobs/` (saved jobs), `uploads/` (STL by sha256, swept after 24 h), `slices/` (Orca output, deleted after 1 h, or 24 h / size cap as in 2bee.3d) |
| `--max-body BYTES` | 110 MiB (an STL may be 100 MB) |

Token rules are printer-bridge's: at least 16 characters, no whitespace, otherwise exit 2.

## API

Every route needs `Authorization: Bearer <token>`. Without it the answer is **401** and no work
is done. The `Host` must be a loopback name (403 otherwise, a DNS-rebinding guard). An `Origin`
not on the list gets 403. `OPTIONS` answers CORS and Private Network Access preflights with no
token. Errors are `{ok:false, error}` with the HTTP status. Engine results are passed through
unchanged, with the status 2bee.3d gave them: a failed slice is
`200 {ok:false, id, error, log}`.

| Route | Body | Answer |
|---|---|---|
| `GET /v1/health` | | `{ok, engine:{id:'twobee-fdm'\|'orca', label, bin, found, printed:false, defaults?, defaultsFound?}, machine:{name,found}, printing:false, note}` |
| `GET /v1/profiles` | | process and filament presets for the X2D 0.4 (system + user), `bed` area, `byFilamentId` |
| `GET /v1/slots` | | `{ok, bedPlate, slots:[{id,label,type,color}], types, bedTypes}` |
| `PUT /v1/slots` | `{bedPlate?, slots:[{id,type,color}]}` | same as GET. Any invalid id, type, colour or plate is a 400, and the file stays unchanged. The write is atomic |
| `POST /v1/job/upload?name=x.stl` | raw STL | `{ok, sha256, name, size, triangles, size3d}`. 400 if it is not a readable STL |
| `GET /v1/job/file/<sha256>` | | the STL bytes, or 404 |
| `POST /v1/job/arrange` | job | the engine arranges one plate (2bee.3d `/api/job/arrange`) |
| `POST /v1/job/plates` | job + `strategy` (`fit`/`filament`/`balance`/`tall`/`manual`), `tallMm?`, `strict?` | the plate plan (2bee.3d `/api/job/beds`): `{ok, beds:[{index, objects, placements, estimate}], tooBig, assignment, repaired, bed, summary}` |
| `POST /v1/job/slice` | job + `bedIndex` + `optimise` | the engine's slice of that plate: `{ok, id, engine, notComputed?, stats, analysis, objects, filaments, warnings, wipeTower?, optimise?}` |
| `GET /v1/job/strategies` | | `{ok, strategies, objectives:[{id,label,blurb,weights}], defaultObjective}` |
| `POST /v1/job/save` | `{job}` | `{ok, id, path, job}` (STL bytes embedded in the saved file) |
| `GET /v1/job/list` | | `{ok, dir, jobs}` |
| `POST /v1/job/load` | `{id}` or `{job}` | `{ok, job}` |
| `GET /v1/job/saved/<id>` | | the saved job file |
| `GET /v1/gcode/<16 hex>` | | `plate_1.gcode`, text/plain. 404 once it has expired |

The JSON field names (`beds`, `bedIndex`, `bed`) are 2bee.3d's and are kept so the vendored code
runs unchanged. The URL says `plates`.

## Where the code comes from

| File | What |
|---|---|
| `jobs.cjs`, `beds.cjs`, `allowlist.cjs`, `multipart.cjs` | **vendored verbatim** from web-slicer at commit `65227d3`. These four files were unchanged against HEAD on 2026-10-15 (`git diff --stat` touched only `public/*` and `server.js`). The only edits are a 3-line header and `require('./x')` → `require('./x.cjs')`. A test checks both the hash and that nothing else differs |
| `engine.cjs` | `server.js` lines 62-79, 87-173, 222-415, 418-688, 922-929, extracted by line range into a `createEngine()` factory. Three edits are named in its header: `applyOverrides` inlined from `chat.js:56-63`; slots and plate come from the local slots file (no printer registry); the `unknown printer` check is removed |
| `bridge.mjs` | new. The HTTP layer is modelled on `tools/printer-bridge/bridge.mjs` |

Source sha256 (the web-slicer files at `65227d3`):

| File | sha256 |
|---|---|
| jobs.js | `c74b768f296e14796cdcf15565f1a4c4843aa67aeca3ef895775bb53da99c9de` |
| beds.js | `81b14c1a46b7d40c101d6e0907e1be3f5d07b5e436bbc5584a582bcead5d2e63` |
| allowlist.js | `7af6e483ab1cbc2e7db5e02497676d2a9bec0f7221e7140c731d7f89ec5a010c` |
| multipart.js | `1fddd5f78e895232fc1d419f5fc28a7649f3fa9d91ff4e929f0ba39c9fae896b` |

**Re-vendor rather than edit.** If pnp changes one of these files, the hash test goes red and
names the file.

### Dropped from 2bee.3d's server, and why

| Dropped | Why |
|---|---|
| `printerInfo()`: reads the printer's IP and **access code** from `OrcaSlicer.conf` | the access code belongs to `tools/printer-bridge` (`--code-file` / env), never to Orca's config |
| `/api/send` (FTPS upload of Orca's `.gcode.3mf`) | upload is `tools/printer-bridge`'s job. ⚠ That bridge packages the **G-code text** itself. It does not send Orca's full 3MF, and it is not yet known whether the X2D lists the smaller package (see its README) |
| `/api/printer/start`, `/api/printer/stop`, pause / resume, `printer-mqtt.js` | founder 2026-10-14: upload only, no remote start. All of them need the MQTT command channel |
| `/api/printer/status`, `/api/printer/slots` (AMS read) | read-only in intent, but they go through the same MQTT login and a `pushall` request. That is a command channel, so they were not ported. Slots are declared instead |
| `/api/printer/slot` (AMS write) | a command to the printer |
| `/api/camera` (ffmpeg on the printer's RTSPS stream, with the access code in its argv) | needs the access code; not part of slicing |
| `/api/printers*` (registry, LAN discovery, Moonraker / OctoPrint / Bambu adapters) | printer management, not slicing. The app's printer card talks to `tools/printer-bridge` |
| `/api/chat/*` (claude-bridge call, rules parser, `improve` preflight binary) | in the app, the assistant runs in the browser through `cad/ask.tsx` → `tools/claude-bridge`. Every override is checked again here at slice time by the vendored `allowlist.cjs` (`applyToProfiles`). A refused key makes the slice a 400 |
| `/api/compare`, `/api/owngcode` (Rust `fdmslice` + `parity` binaries) | not part of the migrated tab |
| `/api/model?name=` preload, legacy `/api/slice`, static file serving, `/brand/*` | the app serves its own page |

## Tests

```bash
node --test tools/print3d-bridge/print3d-bridge.test.mjs
```

17 tests (2026-10-16). The HTTP tests run the **real `bridge.mjs` as a subprocess** with a throwaway
data dir, a FAKE `orca-slicer` that leaves a marker if spawned, and a wrapper around the real
`fdmslice` that logs its argv. Added 2026-10-16: default engine is 2bee.fdm (health shape, startup
line) · the app path (fixed placement, optimise off) slices a 10 mm cube with the real engine,
G-code read back, walls where the placement put them, orca marker absent, engine argv `--presets`
· the bridge's plates route arranges without orca, and two slots on one plate are refused · a
missing `fdmslice` → 503 with the reason on every slicing route, no fallback · a missing defaults
file → 503 · `--engine cura` → exit 2. 2bee.fdm measured on that cube: 10m 47s, 50 layers,
0.69 g, 0.1 s (Orca on the same job: 11m 3s, 0.63 g). Red runs 2026-10-16: default engine planted
back to `orca` → 5 tests fail (6, 12-15); the 503 check for a missing engine removed → test 14
fails. The real-engine tests need `target/release/fdmslice`; the real-Orca test (now on its own
bridge started with `--engine orca`) runs only when the binary and the X2D machine profile exist.
Otherwise it is **SKIPPED with a `PENDING:` reason** and is never counted as passed. The same
applies to the hash test when pnp's tree is absent.

Covered: 401 with no token or a wrong one, checked against the disk so no upload and no slots
file are written · 403 for Host and Origin · OPTIONS + PNA · start refusals (`--host 0.0.0.0`, an
unknown flag, a short token → exit 2) · no answer on the machine's LAN address · `/v1/health`
shape · printer-shaped paths 404 · slots round-trip, and five invalid bodies → 400 with the file
byte-identical · cube upload (sha256, size3d, triangles), file read-back byte for byte, junk → 400
· no-printer-channel source scan · vendored hash and body · **real Orca**: one 10 mm cube planned
onto one plate, plate 1 sliced, G-code read back with `G1` moves and `; total layer number`.

Measured 2026-10-15 (`0.20mm Standard @BBL X2D`, ams1-3 PETG, Generic PETG preset):
**11m 3s, 50 layers, 0.63 g**, Orca 1.3 s. Orca also warned
`bed_temperature_too_high_than_filament`.

**Red runs** (2026-10-15). Each plant was applied to the file with sed, the suite was run, and
the file was restored; `cmp` against a backup confirmed it was byte-identical:

| Plant | Result |
|---|---|
| (a) token check skipped (`if (false && !tokenMatches…`) | `not ok 1 - 401 without a token…` · pass 11 fail 1 |
| (b) Origin check skipped | `not ok 2 - 403 for a non-loopback Host and for a disallowed Origin` · pass 11 fail 1 |
| (c) Host check skipped | `not ok 2` · pass 11 fail 1 |
| (d) `server.listen(port, '0.0.0.0')` | `not ok 5 - binds 127.0.0.1 only` · pass 11 fail 1 |
| (e) slot colour validation skipped | `not ok 8 - PUT /v1/slots…` · pass 11 fail 1 |
| (f) the string `mqtt` planted in `engine.cjs` code | `not ok 10 - no printer channel by construction…` · pass 11 fail 1 |
| restored | 12 pass, 0 fail, 0 skipped |

## 🔴 Not verified

- **Nothing printed.** No G-code from this bridge has been uploaded or printed.
- **`optimise:true`** (2bee.3d slices up to 4 arrangements per plate and keeps the best) runs the
  vendored code unchanged, but no test here exercises it. Only `optimise:false` was run.
- **Multi-plate, multi-filament, group (inlay) jobs and `repackFewerBeds`** are pnp's tested
  code (their `test/arr_server.js`, `beds_server.js`), vendored or extracted unchanged. They have
  not been re-run here.
- **Saved jobs** (`save`/`list`/`load`) are not covered by a test here.

## Commit record (2026-10-16)

The switch to 2bee.fdm landed in `47c1dba9d8` with the WRONG commit message: the subject and body there
describe a clamp change in the CNC core ("clamps move mid-job ..."), because two agents wrote their message to
the same scratch file and that one was read. The 21 files in `47c1dba9d8` are the engine switch only (fdm,
tools/print3d-bridge, web/src/print3d and the copy lines listed below); no core/ file is in it. The correct
description of that change is the commit that adds this section.
