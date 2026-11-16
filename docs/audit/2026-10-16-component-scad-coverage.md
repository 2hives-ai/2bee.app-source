# Component SCAD coverage: every part on our boards vs `cad`'s OpenSCAD models

> **UPDATE 2026-10-16 (after `cad` `d9f1a864b6`, ticket 10-20-30): live boards 144 of 144 HAS.**
> `cad` added 24 files to `hardware/cad/lib/components/`, each with a `// MPN:` header index. The
> script now reads that index first (tokens split on spaces/commas, quotes and unbalanced brackets
> stripped, whole-token or 2-4 adjacent tokens joined; never a substring) and counts a part HAS when
> cad declares its MPN there. Re-run:
> `cd software/2bee.app/web && node --import ./tests/register.mjs scripts/component-scad-coverage.ts`
> → live `HAS 144 · PARTIAL 0 · MISSING 0 · UNSURE 0 of 144` · pnp-wip `HAS 0 · PARTIAL 1 · MISSING 41 · UNSURE 3 of 45`
> · deferred `HAS 9 · MISSING 21 of 30` · superseded `HAS 63 · MISSING 51 · UNSURE 2 of 116`.
> Negative control: with the index lookup disabled the same run prints live `HAS 0 · PARTIAL 2 ·
> MISSING 57 · UNSURE 85`, so the 144 comes from the index, not from the old heuristics.
> ⚠ HAS = cad DECLARES a model for that MPN. 70 chip passives share one generic package module
> (`pkg_chip("<MPN>")`, lookup aborts on an unknown MPN), and several bodies are PROV_ (XGL4030,
> CD110, three SOT-23 FETs, SN74AHCT1G125, 2 MLCC heights, USB-A/USB-C/RJ12 plug envelopes) — see
> cad's ticket. Nothing here checked a dimension. pnp WIP parts are not indexed yet (pnp has no fab
> BOMs). The sections below the tables are the original 09:07 audit; the tables are re-generated.

**Date:** 2026-10-16 · **Lane:** `2bee_app` · **Tree:** `hw-naming-cleanup-placement-audit` at `1f4c67020e` · **Read-only on `hardware/`.**

Founder, 2026-10-16: *"check on all component's scad file, we have to have all for pcb and pnp"*.

## Answer

**Almost none of them exist.** Of the **144 unique parts on the 8 live fab boards, 0 have a
datasheet model of their own in `hardware/cad/`**. 2 are PARTIAL (the two ESP32-S3-WROOM-1U
variants, drawn with the WROOM-1 model, which is a different outline). 1 is UNSURE (the Luckfox
2x20 header, drawn only inside the Luckfox board model). The other 141 are MISSING. The pnp WIP
boards are the same: of 45 parts, 0 HAS, 1 PARTIAL, 44 MISSING.

That is the expected shape of this library, not a broken one. `hardware/cad/lib/components/`
holds **47 files of bought modules and mechanicals** (breakout boards, motors, fans, cameras,
drivers, antennas). It holds **no chip-level SMD parts and no generic package models**: no R0402,
no SOT-23, no SOIC-8, no QFN. What stands in for the board's parts in cad's assemblies today is a
**courtyard-sized box per ref**: `pcb_sync/pcb_sync_viz.scad:_pv_bodies` reads the generated
`<board>_pcb_sync.scad` arrays. Every live part has one (column *pcb_sync box*), but a box is not
a model, and this audit does not count it as one.

## Population (printed before the findings)

| Class | Boards | Refs | Unique parts | Source |
|---|---|---|---|---|
| **live** | 8: buck48_05, buck48_24, hbs57_usb6, outlet, sensor_pod_v3_io, sensor_pod_v3_soc, solar_box_comms, solar_box_power | 515 | **144** | `fab/**/<id>-bom.csv` + `-cpl.csv` |
| **pnp-wip** | 5: pnp_bus_controller, pnp_feeder_backplane, pnp_max_feeder (`Feeder-Panelized`), pnp_max_feeder_shield, pnp_stack | 264 | **45** | **`.kicad_pcb` footprints**. No pnp_* board has a fab BOM/CPL. |
| deferred | 2: autoframe_motor (REMOVED per its own `_DEFERRED.md`), autoframe_motor_2ch | 128 | 30 | fab BOM |
| superseded | 5: hbs57_mux, pico_zero_carrier, sensor_pod, sensor_pod_v2, solar_box | 255 | 116 | fab BOM. **Reported, not counted as gaps.** |

- The live set the script derives (dirs with BOM+CPL and no `_SUPERSEDED.md` / `_DEFERRED.md`, not `pnp_*`) is exactly the 8 the brief named.
- **50 refs are excluded as non-components** (nothing to model): mounting holes, fiducials, test points and Tag-Connect TC2030 pads. 2 are on live boards: `sensor_pod_v3_soc` GND test point and TC2030.
- **pnp-wip is a different population and must not be read as a BOM.** Its parts are KiCad footprint value plus footprint name. Connectors (`J*`) are grouped by footprint alone, because their KiCad value is a signal label (`SHLD P01/F0`, `12V IN`). `pnp_stack` has 4 mounting holes and no parts. `pnp_lane_strip` has no board file at all. `Feeder-Panelized` is a 25-up panel of RinthLabs' MaxFeeder, which gives 125 refs but only 5 parts.
- Unique part = `Mfr_PN`, or `value|package` when the row has no Mfr_PN. Two MPNs in the same value and package are two parts, e.g. `SI2301 3A` and `Si2301CDS-T1-GE3`.

## Totals

| Class | HAS | PARTIAL | MISSING | UNSURE | of | KiCad 3D body: lib / pcb `box_*.step` / none |
|---|---|---|---|---|---|---|
| **live** | **0** | **2** | **141** | **1** | 144 | 88 / 56 / 0 |
| **pnp-wip** | 0 | 1 | 44 | 0 | 45 | 5 / 0 / 40 |
| deferred | 0 | 0 | 30 | 0 | 30 | 0 / 0 / 30 |
| superseded (not gaps) | 1 | 1 | 114 | 0 | 116 | 0 / 0 / 115 (+1 other) |

The KiCad column is context, not the question. On the live boards, 88 parts carry a KiCad library
body (`${KICAD9_3DMODEL_DIR}/…`, the passives, SOT/SO/diodes). 56 carry `pcb`'s plain
`hardware/pcb/common/3dmodels/box_WxDxH.step` stand-in, and those are exactly the ICs, modules and
connectors that matter for fit. The generated pnp_* boards carry no 3D model reference at all.
Only the imported RinthLabs `Feeder-Panelized` has KiCad library bodies.

### What the non-MISSING rows are

- **PARTIAL: `ESP32-S3-WROOM-1U-N8R8` (solar_box_comms, DNP) and `-N16R8` (outlet), plus the
  pnp_max_feeder_shield footprint.** `lib/components/esp32_s3.scad:esp32_s3` models the
  **WROOM-1** (PCB antenna, 18 × 25.5; variants `wroom1`/`wroom1_n16`/`wroom1_n8r2`). The **-1U**
  is **18 × 19.2 × 3.2 with a u.FL**, per `hardware/datasheets/espressif_esp32-s3-wroom-1_datasheet.pdf.md:3144-3161`.
  It is a different outline, so the model is the right family and the wrong part.
  ⚠ Side finding for `cad`: the same datasheet gives the WROOM-1's thickness as **3.1 ± 0.15**
  (`:3015`), but `esp32_s3.scad` uses `mod_t = 3.2`. 3.2 is the -1U's value (`:3144`).
- **UNSURE: `2.54mm 2*20P`** (sensor_pod_v3_soc 2x20 male header). Its pin geometry exists only
  inside `lib/components/luckfox_pico_zero.scad:lpz_board` (`lpz_hdr_*`), as part of the Luckfox
  board, not as a standalone header. Whether that serves the carrier-side part is `cad`'s call.
  The matching female socket `2.54-2*20` on sensor_pod_v3_io is MISSING:
  `luckfox_pico_zero.scad` itself says its STEP holds no female socket.
- **HAS (superseded only): `ICS-43434`.** `lib/components/ics43434_mic.scad` is a real chip-level
  model, but the part is on no live board. The live mic is `MSM381ACB022`, which is MISSING.

### Near misses checked and rejected (MISSING, with the reason in the table)

`INA219AIDR` (only the GY-219 breakout is modelled) · `INA226AIDGSR` · `BME280` (`honey_tank_sensor.scad`
names a BME280 breakout PCB, not the LGA-8) · `KF301-5.0-2P` (drawn inline on the INA219 breakout at
3.5 mm pitch, not a module) · JST XH 2p/3p/side-entry (only `2bee_cables.scad:_jst_xh5`, a 5-pin
**cable** plug cube) · Micro-Fit 2x7 / 2x6 (only a private 3-ckt viz cube in `controller_pcb.scad`) ·
`USB-231-ARY` (`usb_a_panel_dtype.scad` is a panel feed-through, a different part) · `DS1133-S60BPX`
6P6C (only the driver-side RJ12 in `hbs57_driver.scad`) · `RV1106G3` (named only inside the Luckfox
board and camera models).

**Named but not modelled:** several live MPNs appear in assembly files as **dimension constants
or comments**, not modules. They are useful to `cad` as already-sourced heights. Examples:
`solar_box_split_enclosure_3d.scad:51-53` (`KF301-5.0-2P` 10.0, `XT60PW-M30` 8.4, `43045-1413`
mated 17.27), `sensor_pod_v3_lookmodel.scad` (`MSM381ACB022`, `43045-1213` family analog),
`pnp_feeder_connector_adapter_3d.scad` (`B-2100S06P-A110` pin length), and
`pnp_drum_params.scad:2556` (`05B20L22P` envelope, retired).

## Priority for `cad` (live boards first)

Two kinds of gap, which call for different work:

1. **Bodies that decide fit**: tall, mechanical or large parts. These need **datasheet-accurate
   models** (cad has the `cad-doc-replicator` agent for exactly this). Some vendor modules have no
   public drawing beyond a listing and will need the vendor drawing first. Live, highest first:
   Mornsun `URB4805YMD-10WR3` / `URB4824YMD-10WR3` (25.4 × 25.4 DIP module) · `LKML2502A331MF`
   330 µF/100 V radial (D12.5 L25) · `14D101K` 14 mm MOV · `TMY1102M` Y-cap · `0452.500MRL` NANO2 fuse ·
   `10V220uF CD110` radial · `XT60PW-M` · Molex `43045-1413` (2x7) and `43045-1213` (2x6) ·
   `USB-231-ARY` USB-A · `DS1133-S60BPX` 6P6C ×6 · `WJ500V-5.08-2P` and `KF301-5.0-2P` screw terminals ·
   JST `B2B-XH-A`, `B3B-XH-A`, `S2B-XH-A-1` · Ckmtw `B-2100S0xP` pin headers · `2.54-2*20` socket and
   `2.54mm 2*20P` header · `TF-01A` microSD · `TYPE-C16PIN` USB-C · `05B20L22P` FPC-22P · `B3U-1000P` switch ·
   `ESP32-S3-WROOM-1U` (fix the variant) · `MSM381ACB022` mic (its port position matters to the enclosure) ·
   `BME280` · `SK6812MINI-E` · ICs with a footprint large enough to matter: `RV1106G3` QFN-128, `CP2108`
   QFN-64, `FE1.1s` SSOP-28, `ADS131M04` TSSOP-20, `BQ77915` TSSOP-24, `CN3722` / `MAX3232` TSSOP-16, `CS1238`
   SOP-14, `TPS54360` HSOP-8, the inductors (`XGL4030`, `CKST0603`, `VLS252010`) and the SMB/SMC diodes.
2. **Passives and small discretes**: 81 of the 144 live parts sit on 12 packages. These are
   R0402 31, C0603 14 (3 of them LEDs on a C0603 land), C0402 9, SOT-23-3 7, SMB 5, C0805 3,
   C1206 3, R2512 3, SOD-523 3, and R0603 / SMA / SOD-123 1 each (from `--json`, grouped by `pkg`). One **generic package module per package**
   (IPC body dimensions, parameterised) would cover all of them as PARTIAL, which is honest and
   enough for fit. One module per resistor value would only add maintenance. Whether generic is
   acceptable for "we have to have all" is a **decision** for `cad` (and the founder, if it is
   contested). This audit would score those parts PARTIAL, not HAS.

Then the pnp WIP boards: `ESP32-C3-MINI-1` (pnp_bus_controller), `SP3485EN-L/TR`, `AP2112K-3.3`, JST XH 4p,
screw terminals 2p/3p, `2920L500/24SLDR`, and the MaxFeeder's `SW_SPDT` microswitch, JST ZH 6p and
1x05 pin socket. The pnp WIP boards carry no fab BOM yet, so this list will move when `pcb` writes one.

## Method and re-run

Script: `software/2bee.app/web/scripts/component-scad-coverage.ts` (read-only, uses this lane's own
`parseCsv` / `parseKicadFootprints`, the same parsers the PnP and PCB tabs run).

```bash
cd software/2bee.app/web
node --import ./tests/register.mjs scripts/component-scad-coverage.ts            # population + totals
node --import ./tests/register.mjs scripts/component-scad-coverage.ts --md       # + the tables below
node --import ./tests/register.mjs scripts/component-scad-coverage.ts --json /tmp/cov.json
COVERAGE_PCB_ROOT=$(mktemp -d) node --import ./tests/register.mjs scripts/component-scad-coverage.ts; echo $?   # negative control: must be 2
```

Exit `0` = report produced (gaps are the finding, not a failure). Exit `2` = could not run,
**including an empty population**. Negative control run 2026-10-16: empty `COVERAGE_PCB_ROOT` → all
classes 0 → `INCOMPLETE: empty population … not a pass`, **exit 2**. Real run → exit 0.

- **Models searched:** 427 `.scad` files / 1045 `module`s under `hardware/cad/`, excluding `export/`,
  `stl/` and the 19 generated `*_pcb_sync.scad` data files (position arrays, not models).
- **Candidate rule:** a `module` whose name has a token of 5 or more characters, with both letters
  and digits, that prefixes the part's normalised MPN or value (`ina219_gy219` → `INA219AIDR`). Or a
  `lib/`, `ref_models/`, `vendor_models/`, `2bee_connectors.scad` or `2bee_cables.scad` file whose first
  60 lines name such a token. **A candidate is never a verdict.** The `REVIEWED` table in the script
  holds the verdicts, each checked by reading the cited file. An unreviewed candidate prints
  **UNSURE**, never HAS.
- **Second angle (done once, by hand):** every live MPN's first 7 normalised characters were grepped
  across all 427 files, including assembly files. Every hit was read. They were dimension constants
  or comments (listed above under *named but not modelled*), and none was a model the first pass
  missed.
- ⚠ **What this does not catch:** a model for a part that never names the part's MPN or a
  digit-bearing token of it, e.g. a module called `screw_terminal_5mm`. The library holds no such
  file today (checked by reading the 47 `lib/components/` names and the `lib/` root). A future
  generic package module will show as MISSING until `REVIEWED` names it. Add it there, because
  the script will not guess.

## Full output (2026-10-16)

```
component-scad-coverage · repo /home/gbacs/hives/2bee.farm/
models: 427 .scad files (excl. export/, stl/, *_pcb_sync.scad), 1045 modules; 19 *_pcb_sync.scad

POPULATION
  live       boards  8 · refs  515 · unique parts 144
      buck48_05                  fab-bom   rows  11 refs  13 unique   9  hardware/pcb/buck48_05/fab/buck48_05-bom.csv
      buck48_24                  fab-bom   rows  11 refs  13 unique   8  hardware/pcb/buck48_24/fab/buck48_24-bom.csv
      hbs57_usb6                 fab-bom   rows  37 refs 138 unique  30  hardware/pcb/hbs57_usb6/fab/hbs57_usb6-bom.csv
      outlet                     fab-bom   rows  39 refs  98 unique  37  hardware/pcb/outlet/fab/outlet-bom.csv
      sensor_pod_v3_io           fab-bom   rows  20 refs  35 unique  20  hardware/pcb/sensor_pod_v3/fab/io/sensor_pod_v3_io-bom.csv
      sensor_pod_v3_soc          fab-bom   rows  42 refs  77 unique  39  hardware/pcb/sensor_pod_v3/fab/soc/sensor_pod_v3_soc-bom.csv
      solar_box_comms            fab-bom   rows  34 refs  56 unique  34  hardware/pcb/solar_box_comms/fab/solar_box_comms-bom.csv
      solar_box_power            fab-bom   rows  54 refs  85 unique  53  hardware/pcb/solar_box_power/fab/solar_box_power-bom.csv
  pnp-wip    boards  5 · refs  264 · unique parts  45
      pnp_bus_controller         kicad_pcb rows  18 refs  24 unique  18  hardware/pcb/pnp_bus_controller/pnp_bus_controller.kicad_pcb
      pnp_feeder_backplane       kicad_pcb rows  19 refs  87 unique  19  hardware/pcb/pnp_feeder_backplane/pnp_feeder_backplane.kicad_pcb
      Feeder-Panelized           kicad_pcb rows   5 refs 125 unique   5  hardware/pcb/pnp_max_feeder/Feeder-Panelized.kicad_pcb
      pnp_max_feeder_shield      kicad_pcb rows  18 refs  28 unique  18  hardware/pcb/pnp_max_feeder_shield/pnp_max_feeder_shield.kicad_pcb
      pnp_stack                  kicad_pcb rows   0 refs   0 unique   0  hardware/pcb/pnp_stack/pnp_stack.kicad_pcb
  deferred   boards  2 · refs  128 · unique parts  30
      autoframe_motor            fab-bom   rows  30 refs  70 unique  29  hardware/pcb/autoframe_motor/fab/autoframe_motor-bom.csv
      autoframe_motor_2ch        fab-bom   rows  31 refs  58 unique  30  hardware/pcb/autoframe_motor_2ch/fab/autoframe_motor_2ch-bom.csv
  superseded boards  5 · refs  255 · unique parts 116
      hbs57_mux                  fab-bom   rows  16 refs  33 unique  11  hardware/pcb/hbs57_mux/fab/hbs57_mux-bom.csv
      pico_zero_carrier          fab-bom   rows  22 refs  28 unique  21  hardware/pcb/pico_zero_carrier/fab/pico_zero_carrier-bom.csv
      sensor_pod                 fab-bom   rows  23 refs  33 unique  22  hardware/pcb/sensor_pod/fab/sensor_pod-bom.csv
      sensor_pod_v2              fab-bom   rows  33 refs  68 unique  31  hardware/pcb/sensor_pod_v2/fab/sensor_pod_v2-bom.csv
      solar_box                  fab-bom   rows  58 refs  93 unique  57  hardware/pcb/solar_box/fab/solar_box-bom.csv
  excluded as non-components (no body to model): 50 refs — (empty footprint, no plated pads) · Fiducial 1mm · Mounting_Hole_D3.2mm · TC2030 · TC2030-IDC-NL · Tag-Connect TC2030-IDC-NL (6-pin pogo, DNP) · Test point

COVERAGE (unique parts per class)
  live       HAS 0 · PARTIAL 2 · MISSING 141 · UNSURE 1  of 144   | kicad 3D: lib 88 · box_*.step 56 · other 0 · none 0 · no board file 0
  pnp-wip    HAS 0 · PARTIAL 1 · MISSING 44 · UNSURE 0  of 45   | kicad 3D: lib 5 · box_*.step 0 · other 0 · none 40 · no board file 0
  deferred   HAS 0 · PARTIAL 0 · MISSING 30 · UNSURE 0  of 30   | kicad 3D: lib 0 · box_*.step 0 · other 0 · none 30 · no board file 0
  superseded HAS 1 · PARTIAL 1 · MISSING 114 · UNSURE 0  of 116   | kicad 3D: lib 0 · box_*.step 0 · other 1 · none 115 · no board file 0

NON-MISSING
  [live] UNSURE  2.54mm 2*20P — hardware/cad/lib/components/luckfox_pico_zero.scad:lpz_board — the 2x20 header PIN geometry is drawn inside the Luckfox board model (lpz_hdr_*), not as a standalone header module; whether that counts for the carrier-side header is a cad call
  [live] PARTIAL ESP32-S3-WROOM-1U-N16R8 — hardware/cad/lib/components/esp32_s3.scad:esp32_s3 — same as N8R8: the WROOM-1 model (18x25.5), not the -1U outline (18x19.2)
  [live] PARTIAL ESP32-S3-WROOM-1U-N8R8 — hardware/cad/lib/components/esp32_s3.scad:esp32_s3 — models ESP32-S3-WROOM-1 (PCB antenna, 18x25.5; variants wroom1/n16/n8r2). The -1U is 18x19.2x3.2 with u.FL (hardware/datasheets/espressif_esp32-s3-wroom-1_datasheet.pdf.md:3144-3161) and is not a variant
  [pnp-wip] PARTIAL ESP32-S3-WROOM-1U|ESP32-S3-WROOM-1U — hardware/cad/lib/components/esp32_s3.scad:esp32_s3 — the WROOM-1 model (18x25.5), not the -1U outline (18x19.2, u.FL)
  [superseded] PARTIAL ESP32-S3-WROOM-1U-N8R8 — hardware/cad/lib/components/esp32_s3.scad:esp32_s3 — models ESP32-S3-WROOM-1 (PCB antenna, 18x25.5; variants wroom1/n16/n8r2). The -1U is 18x19.2x3.2 with u.FL (hardware/datasheets/espressif_esp32-s3-wroom-1_datasheet.pdf.md:3144-3161) and is not a variant
  [superseded] HAS     ICS-43434|ICS-43434 LGA bottom-port I2S MEMS mic — hardware/cad/lib/components/ics43434_mic.scad:ics43434_mic — chip-level LGA-6 3.5x2.65 model; footprint sourced from the BOM, body height 0.98 and port flagged PROV in its own header
```

## Tables per board class (re-generated after cad d9f1a864b6)
### live

| # | Part (Mfr_PN or value\|package) | Value | Package | Boards | Refs | SCAD | Where / why | KiCad 3D | pcb_sync box |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 0402WGF1003TCE | 100k | R0402 | hbs57_usb6, outlet, sensor_pod_v3_io, sensor_pod_v3_soc, solar_box_comms, solar_box_power | 18 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 2 | 0402WGF1000TCE | 100R | R0402 | hbs57_usb6, outlet, sensor_pod_v3_soc, solar_box_comms, solar_box_power | 16 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 3 | 0402WGF1001TCE | 1k | R0402 | hbs57_usb6, sensor_pod_v3_io, sensor_pod_v3_soc, solar_box_comms, solar_box_power | 15 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 4 | 0402WGF1002TCE | 10k | R0402 | hbs57_usb6, outlet, sensor_pod_v3_soc, solar_box_comms, solar_box_power | 29 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 5 | CL21A106KAYNNNE | 10uF/25V | C0805 | hbs57_usb6, outlet, sensor_pod_v3_soc, solar_box_comms, solar_box_power | 22 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 6 | CC0603KRX7R9BB104 | 100nF | C0603 | hbs57_usb6, outlet, solar_box_comms, solar_box_power | 16 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 7 | CL05B104KO5NNNC | 100nF | C0402 | hbs57_usb6, sensor_pod_v3_io, sensor_pod_v3_soc, solar_box_comms | 42 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 8 | CL10B105KA8NNNC | 1uF | C0603 | hbs57_usb6, outlet, solar_box_comms, solar_box_power | 16 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 9 | CL21A226KOQNNNE | 22uF | C0805 | outlet, sensor_pod_v3_soc, solar_box_comms, solar_box_power | 12 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 10 | 0402WGF0000TCE | 0R | R0402 | hbs57_usb6, sensor_pod_v3_io, solar_box_power | 28 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 11 | 2N7002 | 2N7002 | SOT-23-3 | outlet, solar_box_comms, solar_box_power | 7 | HAS | hardware/cad/lib/components/pkg_discrete.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 12 | AP63203WU-7 | AP63203-5to3V3 | SOT-23-6 (TSOT-23-6) | outlet, sensor_pod_v3_soc, solar_box_comms | 3 | HAS | hardware/cad/lib/components/pkg_discrete.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | box-step | yes |
| 13 | CL31A106KBHNNNE | 10uF/50V | C1206 | buck48_05, buck48_24, solar_box_power | 3 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 14 | INA219AIDR | INA219 | SOIC-8 | outlet, solar_box_comms, solar_box_power | 7 | HAS | hardware/cad/lib/components/pkg_ic.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 15 | RC0402FR-074K7L | 4.7k | R0402 | hbs57_usb6, sensor_pod_v3_io, solar_box_power | 5 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 16 | USB-231-ARY | 5V OUT Pi | USB-A receptacle TH horizontal (XUNPU USB-231-ARY) | buck48_05, hbs57_usb6, solar_box_comms | 5 | HAS | hardware/cad/lib/components/usb_a_231_ary.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | box-step | yes |
| 17 | WJ500V-5.08-2P | 48V IN | Screw terminal 2p WJ500V-5.08 | buck48_05, buck48_24, hbs57_usb6 | 8 | HAS | hardware/cad/lib/components/screw_terminal.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | box-step | yes |
| 18 | XGL4030-222MEC | 2.2uH | Inductor 4030 SMD | outlet, sensor_pod_v3_soc, solar_box_comms | 3 | HAS | hardware/cad/lib/components/pkg_xtal_l.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | box-step | yes |
| 19 | 0402WGF1022TCE | 10k2 | R0402 | outlet, solar_box_power | 2 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 20 | 0402WGF1623TCE | 162k | R0402 | outlet, solar_box_power | 2 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 21 | 0402WGF2201TCE | 2.2K | R0402 | sensor_pod_v3_soc, solar_box_comms | 4 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 22 | 0402WGF4701TCE | 4k7 | R0402 | outlet, solar_box_comms | 8 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 23 | 0402WGF5113TCE | 511k | R0402 | outlet, solar_box_power | 2 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 24 | 0402WGF5362TCE | 53k6 | R0402 | outlet, solar_box_power | 2 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 25 | 0402WGF7681TCE | 7k68 | R0402 | outlet, solar_box_power | 2 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 26 | 0402WGF8452TCE | 84k5 | R0402 | outlet, solar_box_power | 2 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 27 | 0452.500MRL | 500mA | Fuse NANO2 6.1x2.69 (Littelfuse 452/454) | buck48_05, buck48_24 | 2 | HAS | hardware/cad/lib/components/fuse_nano2_0452.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | box-step | yes |
| 28 | 0603B682K500NT | 6800pF | C0603 | outlet, solar_box_power | 2 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 29 | 14D101K | S14K60 | Radial disc 14mm, 7.5mm pitch | buck48_05, buck48_24 | 2 | HAS | hardware/cad/lib/components/mov_disc_14d.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | box-step | yes |
| 30 | 1812L150/24MR | PTC 1.5A | Fuse 1812 | hbs57_usb6, solar_box_power | 2 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | box-step | yes |
| 31 | 43045-1413 | Micro-Fit-2x7 | Molex Micro-Fit 3.0 2x7 | solar_box_comms, solar_box_power | 2 | HAS | hardware/cad/lib/components/molex_microfit_43045.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | box-step | yes |
| 32 | AO3400A | AO3400 | SOT-23-3 | solar_box_comms, solar_box_power | 3 | HAS | hardware/cad/lib/components/pkg_discrete.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 33 | B560C-13-F | B560C-13-F | SMC | outlet, solar_box_power | 4 | HAS | hardware/cad/lib/components/pkg_discrete.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 34 | BME280 | BME280 | Bosch BME280 LGA-8 2.5x2.5x0.93mm | sensor_pod_v3_io, solar_box_comms | 2 | HAS | hardware/cad/lib/components/bme280_lga8.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | box-step | yes |
| 35 | BSMD1812-300-16V | PPTC-INLET-3A-16V-INTERIM-see-note | Fuse 1812 | outlet, solar_box_power | 3 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | box-step | yes |
| 36 | CC0603JRNPO9BN680 | 68pF | C0603 | outlet, solar_box_power | 2 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 37 | CC0603MRX5R8BB106 | 10uF | C0603 | sensor_pod_v3_io, sensor_pod_v3_soc | 2 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 38 | CC1206KKX7R0BB105 | 1uF/100V | C1206 | buck48_05, buck48_24 | 2 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 39 | CKST0603-10uH/M | 10uH | CKST0603 Shielded Inductor | outlet, solar_box_power | 3 | HAS | hardware/cad/lib/components/pkg_xtal_l.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | box-step | yes |
| 40 | CL05A105KA5NQNC | 1uF | C0402 | sensor_pod_v3_io, sensor_pod_v3_soc | 3 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 41 | CL05B103KB5NNNC | 10nF | C0402 | sensor_pod_v3_io, sensor_pod_v3_soc | 2 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 42 | FMF25FPJR010-LH | 10mR | R2512 | solar_box_comms, solar_box_power | 5 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 43 | KF301-5.0-2P | Terminal 2p | Screw terminal 2p | outlet, solar_box_power | 8 | HAS | hardware/cad/lib/components/screw_terminal.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | box-step | yes |
| 44 | LKML2502A331MF | 330uF/100V | Radial elec cap D12.5 L25 (YMIN LKML2502A331MF) | buck48_05, buck48_24 | 4 | HAS | hardware/cad/lib/components/cap_radial_elec.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | box-step | yes |
| 45 | MF-MSMF110-2 | PPTC-INTERIM-see-note | Fuse 1812 | outlet, sensor_pod_v3_io | 5 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | box-step | yes |
| 46 | NTF5P03T3G | P-FET-30V-5A2-VGS20-SOT223-G1D2S3 | SOT-223-3 TabPin2 | outlet, sensor_pod_v3_io | 3 | HAS | hardware/cad/lib/components/pkg_discrete.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | box-step | yes |
| 47 | SMBJ16A | TVS-UNIDIR-16V-SMB | SMB | outlet, solar_box_power | 2 | HAS | hardware/cad/lib/components/pkg_discrete.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 48 | SMBJ5.0A | SMBJ5.0A | SMB | hbs57_usb6, solar_box_comms | 2 | HAS | hardware/cad/lib/components/pkg_discrete.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 49 | SS34 | SS34 | SMA | sensor_pod_v3_soc, solar_box_comms | 2 | HAS | hardware/cad/lib/components/pkg_discrete.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 50 | TF-01A | microSD | microSD push-push TF-01A 9-contact | sensor_pod_v3_soc, solar_box_comms | 2 | HAS | hardware/cad/lib/components/microsd_tf_01a.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | box-step | yes |
| 51 | TMY1102M | 1nF/2kV Y1 | Y-cap TMY1102M 7.8x5.4mm | buck48_05, buck48_24 | 4 | HAS | hardware/cad/lib/components/ycap_tmy1102m.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | box-step | yes |
| 52 | TPD1E05U06DYAR | TPD1E05U06 | TVS SOD-523 (TPD1E05U06, unidir ESD) | hbs57_usb6, sensor_pod_v3_soc | 8 | HAS | hardware/cad/lib/components/pkg_discrete.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | box-step | yes |
| 53 | TPS54360DDAR | TPS54360 | HSOP-8 PowerPAD | outlet, solar_box_power | 2 | HAS | hardware/cad/lib/components/pkg_ic.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | box-step | yes |
| 54 | 0402B102K500NT | 1nF | C0402 | sensor_pod_v3_soc | 1 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 55 | 0402B221K500NT | 220pF | C0402 | sensor_pod_v3_soc | 3 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 56 | 0402CG180J500NT | 18pF | C0402 | sensor_pod_v3_soc | 4 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 57 | 0402WGF1200TCE | 120R | R0402 | solar_box_power | 1 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 58 | 0402WGF1243TCE | 124K | R0402 | sensor_pod_v3_soc | 1 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 59 | 0402WGF1501TCE | 1k5 | R0402 | outlet | 1 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 60 | 0402WGF1583TCE | 158k | R0402 | solar_box_power | 1 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 61 | 0402WGF1802TCE | 18K | R0402 | sensor_pod_v3_soc | 1 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 62 | 0402WGF2003TCE | 200K | R0402 | sensor_pod_v3_soc | 1 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 63 | 0402WGF220JTCE | 22R | R0402 | sensor_pod_v3_soc | 1 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 64 | 0402WGF4703TCE | 470k | R0402 | solar_box_power | 1 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 65 | 0402WGF4992TCE | 49k9 | R0402 | solar_box_power | 1 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 66 | 0402WGF5101TCE | 5.1K | R0402 | sensor_pod_v3_soc | 2 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 67 | 0402WGJ0105TCE | 1M | R0402 | solar_box_power | 1 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 68 | 0402WGJ0335TCE | 3.3M | R0402 | solar_box_power | 1 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 69 | 05B20L22P | FPC-22P | FPC-22P 0.5mm bottom-contact | sensor_pod_v3_soc | 1 | HAS | hardware/cad/lib/components/fpc_05b20l22p.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | box-step | yes |
| 70 | 0603CG1R5C500NT | 1p5 | C0603 | solar_box_power | 1 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 71 | 0603WAF330JT5E | 33R | R0603 | solar_box_power | 5 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 72 | 10V220uF CD110 | 220uF/10V | Radial elec cap | hbs57_usb6 | 1 | HAS | hardware/cad/lib/components/cap_radial_elec.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | box-step | yes |
| 73 | 2.54-2*20 | 2x20-2.54-SKT | 2x20 2.54mm socket - Luckfox Pico Zero J1 compatible | sensor_pod_v3_io | 1 | HAS | hardware/cad/lib/components/pin_header_254.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | box-step | yes |
| 74 | 2.54mm 2*20P | 2x20-2.54-VERT | 2x20 2.54mm header - Luckfox Pico Zero J1 compatible | sensor_pod_v3_soc | 1 | HAS | hardware/cad/lib/components/pin_header_254.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | box-step | yes |
| 75 | 43045-1213 | Micro-Fit-2x6 | Molex Micro-Fit 3.0 2x6 | sensor_pod_v3_io | 1 | HAS | hardware/cad/lib/components/molex_microfit_43045.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | box-step | yes |
| 76 | ADS131M04IPWR | ADS131M04PW | Texas_PW0020A_TSSOP-20_4.4x6.5mm_P0.65mm | sensor_pod_v3_io | 1 | HAS | hardware/cad/lib/components/pkg_ic.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 77 | AO3407A | AO3407A | SOT-23-3 | solar_box_power | 1 | HAS | hardware/cad/lib/components/pkg_discrete.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 78 | B-2100S02P-A110 | NTC-PACK | Pin header 2p r1 vert | solar_box_power | 1 | HAS | hardware/cad/lib/components/pin_header_254.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | box-step | yes |
| 79 | B-2100S06P-A110 | UART | Pin header 6p r1 | solar_box_comms | 1 | HAS | hardware/cad/lib/components/pin_header_254.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | box-step | yes |
| 80 | B-2100S06P-B110 | UART | Pin header 6p r2 | outlet | 1 | HAS | hardware/cad/lib/components/pin_header_254.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | box-step | yes |
| 81 | B2B-XH-A(LF)(SN) | FAN | JST XH 2p TH | solar_box_comms | 4 | HAS | hardware/cad/lib/components/jst_xh.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | box-step | yes |
| 82 | B3B-XH-A(LF)(SN) | BAL-C1-C3 | JST XH 3p TH | solar_box_power | 1 | HAS | hardware/cad/lib/components/jst_xh.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | box-step | yes |
| 83 | B3U-1000P | RECOVERY | Tactile switch SMD 3.0x2.5mm 2-terminal (Omron B3U-1000P land) | sensor_pod_v3_soc | 2 | HAS | hardware/cad/lib/components/tact_b3u_1000p.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | box-step | yes |
| 84 | BNTPD1E05U06DYAR | TPD1E05U06 | TVS SOD-523 (TPD1E05U06, unidir ESD) | solar_box_comms | 2 | HAS | hardware/cad/lib/components/pkg_discrete.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | box-step | yes |
| 85 | BQ7791514PWR | BQ77915 | TSSOP-24 | solar_box_power | 1 | HAS | hardware/cad/lib/components/pkg_ic.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 86 | BZT52C12 | ZENER-12V-SOD123 | SOD-123 | solar_box_power | 1 | HAS | hardware/cad/lib/components/pkg_discrete.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 87 | CC0603JRNPO9BN180 | 18pF | C0603 | hbs57_usb6 | 2 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 88 | CC0603KRX7R9BB471 | 470pF | C0603 | solar_box_power | 1 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 89 | CC0603KRX7R9BB474 | 470nF | C0603 | outlet | 5 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 90 | CESD5V0D5 | CESD5V0D5 | TVS SOD-523 (TPD1E05U06, unidir ESD) | sensor_pod_v3_soc | 1 | HAS | hardware/cad/lib/components/pkg_discrete.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | box-step | yes |
| 91 | CL05A106MQ5NUNC | 10uF | C0402 | sensor_pod_v3_soc | 4 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 92 | CL05A474KA5NNNC | 470nF | C0402 | solar_box_comms | 1 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 93 | CL05B224KO5NNNC | 220nF | C0402 | sensor_pod_v3_io | 1 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 94 | CL10A105KB8NNNC | 1uF/50V | C0603 | solar_box_power | 1 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 95 | CL10B224KB8NNNC | 220nF | C0603 | solar_box_power | 1 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 96 | CL21A475KAQNNNE | 4.7uF | C0805 | hbs57_usb6 | 2 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 97 | CL31B106KAHNNNE | 10uF/25V | C1206 | outlet | 4 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 98 | CN3722 | CN3722 | TSSOP-16 | solar_box_power | 1 | HAS | hardware/cad/lib/components/pkg_ic.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 99 | CP2108-B03-GMR | CP2108 | QFN-64 9x9mm 0.5p + EP (CP2108, SiLabs Table 5.2) | hbs57_usb6 | 2 | HAS | hardware/cad/lib/components/pkg_ic.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | box-step | yes |
| 100 | CS1238 | CS1238 | SOP-14 (CS1238) | sensor_pod_v3_io | 2 | HAS | hardware/cad/lib/components/pkg_ic.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | box-step | yes |
| 101 | DMG3415U-7 | P-FET-30V-SIG-VGS20 | SOT-23-3 | outlet | 1 | HAS | hardware/cad/lib/components/pkg_discrete.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 102 | DMP6023LE-13 | P-FET-60V-7A-VGS20-SOT223-G1D2S3 | SOT-223-3 TabPin2 | solar_box_power | 1 | HAS | hardware/cad/lib/components/pkg_discrete.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | box-step | yes |
| 103 | DS1133-S60BPX | CH0 | 6P6C modular jack RA TH tab-up (Wurth 615006138421) | hbs57_usb6 | 6 | HAS | hardware/cad/lib/components/rj12_ds1133_s60bpx.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | box-step | yes |
| 104 | EA3036C | EA3036C | WQFN-20 3x3x0.75mm 0.4p + EP | sensor_pod_v3_soc | 1 | HAS | hardware/cad/lib/components/pkg_ic.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | box-step | yes |
| 105 | ESP32-S3-WROOM-1U-N16R8 | ESP32-S3-WROOM-1U | ESP32-S3-WROOM-1U | outlet | 1 | HAS | hardware/cad/lib/components/esp32_s3.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | box-step | yes |
| 106 | ESP32-S3-WROOM-1U-N8R8 (DNP) | ESP32-S3-WROOM-1U-N8R8 | ESP32-S3-WROOM-1U | solar_box_comms | 1 | HAS | hardware/cad/lib/components/esp32_s3.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | box-step | yes |
| 107 | FE1.1S-BSOP28BCN | FE1.1s | SSOP-28 10x4mm 0.64p (Terminus FE1.1s) | hbs57_usb6 | 1 | HAS | hardware/cad/lib/components/pkg_ic.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | box-step | yes |
| 108 | FRC0402F2400TS | 240R | R0402 | sensor_pod_v3_soc | 1 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 109 | GX2512-2W-100mR-1% | 100mR | R2512 | solar_box_power | 1 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 110 | INA226AIDGSR | INA226 | VSSOP-10 (MSOP-10) 3x3mm 0.5p | solar_box_power | 1 | HAS | hardware/cad/lib/components/pkg_ic.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 111 | KT-0603R | RED | C0603 | hbs57_usb6 | 1 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 112 | LG Q976.01-MGNI-35-1 | GRN-5V-Vf2.0-2.2 | C0603 | outlet | 1 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 113 | MAX3232ECPWR | MAX3232 | TSSOP-16 | hbs57_usb6 | 3 | HAS | hardware/cad/lib/components/pkg_ic.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 114 | MPZ2012S601AT000 | FB 600R/2A | Bead 0805 (TDK MPZ2012) | hbs57_usb6 | 1 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | box-step | yes |
| 115 | MSM381ACB022 | MSM381ACB022 | MSM381ACB022 | sensor_pod_v3_io | 1 | HAS | hardware/cad/lib/components/mic_msm381acb022.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | box-step | yes |
| 116 | OT2JI-111-8.192M | 8.192MHz | Oscillator 3225 4-pad (YXC YSO110TR land) | sensor_pod_v3_io | 1 | HAS | hardware/cad/lib/components/pkg_xtal_l.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | box-step | yes |
| 117 | P0603P1N46G12 | GRN | C0603 | hbs57_usb6 | 2 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 118 | PPMT20V3 | P-FET-20V-SIG | SOT-23-3 | solar_box_comms | 1 | HAS | hardware/cad/lib/components/pkg_discrete.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 119 | RC0402FR-07150KL | 150k | R0402 | hbs57_usb6 | 1 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 120 | RC0402FR-072K7L | 2.7k 1% | R0402 | hbs57_usb6 | 1 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 121 | RC0402FR-0733RL | 33R | R0402 | solar_box_comms | 1 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 122 | RC0402FR-0749K9L | 49K9 | R0402 | sensor_pod_v3_soc | 1 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 123 | RLP25FEGMR010 | 10mR | R2512 | outlet | 4 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 124 | RV1106G3 | RV1106G3 | RV1106 QFN-128 12.3x12.3mm | sensor_pod_v3_soc | 1 | HAS | hardware/cad/lib/components/pkg_ic.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | box-step | yes |
| 125 | S2B-XH-A-1(LF)(SN) | JST-XH-2P-SIDE-ENTRY | JST XH 2p side-entry S2B-XH-A-1 (B 7.4 x C 7.6) | sensor_pod_v3_io | 1 | HAS | hardware/cad/lib/components/jst_xh.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | box-step | yes |
| 126 | SC-20S,32.768kHz,20PPM,12.5pF | 32.768kHz | Crystal SMD 2.05x1.2 SC-20S 2-pad | sensor_pod_v3_soc | 1 | HAS | hardware/cad/lib/components/pkg_xtal_l.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | box-step | yes |
| 127 | SI2301 3A | P-FET-20V-3A-LOGIC | SOT-23-3 | solar_box_comms | 1 | HAS | hardware/cad/lib/components/pkg_discrete.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 128 | Si2301CDS-T1-GE3 | P-FET-20V-3A-LOGIC | SOT-23-3 | outlet | 8 | HAS | hardware/cad/lib/components/pkg_discrete.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 129 | SK6812MINI-E | SK6812-MINI-E | SK6812-MINI-E addressable RGB (4-pad; WS2812B-2020 alt land) | solar_box_comms | 1 | HAS | hardware/cad/lib/components/sk6812mini_e.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | box-step | yes |
| 130 | SMBJ15CA | SMBJ15CA | SMB | hbs57_usb6 | 12 | HAS | hardware/cad/lib/components/pkg_discrete.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 131 | SMBJ24A | TVS-UNIDIR-24V-SMB | SMB | solar_box_power | 1 | HAS | hardware/cad/lib/components/pkg_discrete.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 132 | SMBJ6.0D-M3/H | SMBJ6.0A | SMB | sensor_pod_v3_io | 1 | HAS | hardware/cad/lib/components/pkg_discrete.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 133 | SMD1206P050TF/15 | 500mA PTC | Fuse 1206 | sensor_pod_v3_soc | 1 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | box-step | yes |
| 134 | SMD1812P050TF/60 | PTC 500mA | Fuse 1812 | hbs57_usb6 | 2 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | box-step | yes |
| 135 | SN74AHCT1G125DBVR | 74AHCT1G125 | SOT-23-5 (DBV) | solar_box_comms | 1 | HAS | hardware/cad/lib/components/pkg_discrete.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | box-step | yes |
| 136 | TPD4E05U06DQAR | TPD4E05U06 | USON-10 (DQA) TPD4E05U06 1.0x2.5mm | solar_box_comms | 2 | HAS | hardware/cad/lib/components/pkg_discrete.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | box-step | yes |
| 137 | TYPE-C16PIN | TYPE-C16PIN | USB-C receptacle 16P SMD (Shouhan TYPE-C 16PIN, LCSC C393939) | sensor_pod_v3_soc | 1 | HAS | hardware/cad/lib/components/usb_c_type_c16pin.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | box-step | yes |
| 138 | URB4805YMD-10WR3 | URB4805YMD-10WR3 | Mornsun URB/URA_YMD-10WR3 horizontal DIP, 25.4x25.4, 6x 1.0 pin | buck48_05 | 1 | HAS | hardware/cad/lib/components/mornsun_urb_ymd_10wr3.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | box-step | yes |
| 139 | URB4824YMD-10WR3 | URB4824YMD-10WR3 | Mornsun URB/URA_YMD-10WR3 horizontal DIP, 25.4x25.4, 6x 1.0 pin | buck48_24 | 1 | HAS | hardware/cad/lib/components/mornsun_urb_ymd_10wr3.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | box-step | yes |
| 140 | VLS252010HBX-1R5M-1 | 1.5uH | Inductor 2520 SMD | sensor_pod_v3_soc | 3 | HAS | hardware/cad/lib/components/pkg_xtal_l.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | box-step | yes |
| 141 | W25Q128JVSIQ | W25Q128JV | SOIC-8 | sensor_pod_v3_soc | 1 | HAS | hardware/cad/lib/components/pkg_ic.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 142 | X322512MOB4SI | 12MHz | Crystal_SMD_3225-4Pin_3.2x2.5mm | hbs57_usb6 | 1 | HAS | hardware/cad/lib/components/pkg_xtal_l.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 143 | X322524MOB4SI | 24MHz | Crystal_SMD_3225-4Pin_3.2x2.5mm | sensor_pod_v3_soc | 1 | HAS | hardware/cad/lib/components/pkg_xtal_l.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | kicad-lib | yes |
| 144 | XT60PW-M | XT60PW-M | XT60PW-M30 male right-angle power connector | solar_box_power | 1 | HAS | hardware/cad/lib/components/xt60pw_m.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | box-step | yes |

### pnp-wip

| # | Part (Mfr_PN or value\|package) | Value | Package | Boards | Refs | SCAD | Where / why | KiCad 3D | pcb_sync box |
|---|---|---|---|---|---|---|---|---|---|
| 1 | (connector)\|Screw terminal 2p | (connector) | Screw terminal 2p | pnp_bus_controller, pnp_feeder_backplane, pnp_max_feeder_shield | 3 | MISSING |  | none | no-sync-file |
| 2 | 100nF\|C0603 | 100nF | C0603 | pnp_bus_controller, pnp_feeder_backplane, pnp_max_feeder_shield | 6 | MISSING |  | none | no-sync-file |
| 3 | (connector)\|JST XH 4p TH | (connector) | JST XH 4p TH | pnp_feeder_backplane, pnp_max_feeder_shield | 40 | MISSING |  | none | no-sync-file |
| 4 | (connector)\|Pin header 4p r1 vert | (connector) | Pin header 4p r1 vert | pnp_bus_controller, pnp_max_feeder_shield | 2 | MISSING |  | none | no-sync-file |
| 5 | 10k\|R0402 | 10k | R0402 | pnp_bus_controller, pnp_max_feeder_shield | 5 | MISSING |  | none | no-sync-file |
| 6 | 10uF\|C0805 | 10uF | C0805 | pnp_bus_controller, pnp_max_feeder_shield | 2 | MISSING |  | none | no-sync-file |
| 7 | 120R\|R0402 | 120R | R0402 | pnp_bus_controller, pnp_max_feeder_shield | 2 | MISSING |  | none | no-sync-file |
| 8 | 1k\|R0402 | 1k | R0402 | pnp_bus_controller, pnp_max_feeder_shield | 3 | MISSING |  | none | no-sync-file |
| 9 | 22uF\|C0805 | 22uF | C0805 | pnp_bus_controller, pnp_feeder_backplane | 3 | MISSING |  | none | no-sync-file |
| 10 | 560R\|R0402 | 560R | R0402 | pnp_bus_controller, pnp_max_feeder_shield | 4 | MISSING |  | none | no-sync-file |
| 11 | GRN\|C0603 | GRN | C0603 | pnp_bus_controller, pnp_max_feeder_shield | 2 | MISSING |  | none | no-sync-file |
| 12 | SP3485EN-L/TR\|SOIC-8 | SP3485EN-L/TR | SOIC-8 | pnp_bus_controller, pnp_max_feeder_shield | 2 | MISSING |  | none | no-sync-file |
| 13 | SS54\|SMC | SS54 | SMC | pnp_bus_controller, pnp_max_feeder_shield | 2 | MISSING |  | none | no-sync-file |
| 14 | (connector)\|JST_ZH_B6B-ZR_1x06_P1.50mm_Vertical | (connector) | JST_ZH_B6B-ZR_1x06_P1.50mm_Vertical | Feeder-Panelized | 25 | MISSING |  | kicad-lib | no-sync-file |
| 15 | (connector)\|Pin header 6p r1 vert | (connector) | Pin header 6p r1 vert | pnp_feeder_backplane | 34 | MISSING |  | none | no-sync-file |
| 16 | (connector)\|PinSocket_1x05_P2.54mm_Vertical_Clean_Locking | (connector) | PinSocket_1x05_P2.54mm_Vertical_Clean_Locking | Feeder-Panelized | 25 | MISSING |  | kicad-lib | no-sync-file |
| 17 | (connector)\|Screw terminal 3p | (connector) | Screw terminal 3p | pnp_bus_controller | 1 | MISSING |  | none | no-sync-file |
| 18 | 0R\|R0402 | 0R | R0402 | pnp_max_feeder_shield | 2 | MISSING |  | none | no-sync-file |
| 19 | 10k2\|R0402 | 10k2 | R0402 | pnp_feeder_backplane | 1 | MISSING |  | none | no-sync-file |
| 20 | 10uF/50V\|C1206 | 10uF/50V | C1206 | pnp_feeder_backplane | 2 | MISSING |  | none | no-sync-file |
| 21 | 10uH\|CKST0603 Shielded Inductor | 10uH | CKST0603 Shielded Inductor | pnp_feeder_backplane | 1 | MISSING |  | none | no-sync-file |
| 22 | 13k0\|R0402 | 13k0 | R0402 | pnp_feeder_backplane | 1 | MISSING |  | none | no-sync-file |
| 23 | 162k\|R0402 | 162k | R0402 | pnp_feeder_backplane | 1 | MISSING |  | none | no-sync-file |
| 24 | 1M2\|R0402 | 1M2 | R0402 | pnp_feeder_backplane | 1 | MISSING |  | none | no-sync-file |
| 25 | 1N4001\|D_A-405_P7.62mm_Horizontal | 1N4001 | D_A-405_P7.62mm_Horizontal | Feeder-Panelized | 25 | MISSING |  | kicad-lib | no-sync-file |
| 26 | 1N4001\|D_SMA-SMB_Universal_Handsoldering | 1N4001 | D_SMA-SMB_Universal_Handsoldering | Feeder-Panelized | 25 | MISSING |  | kicad-lib | no-sync-file |
| 27 | 1uF\|C0603 | 1uF | C0603 | pnp_max_feeder_shield | 2 | MISSING |  | none | no-sync-file |
| 28 | 2.2uH\|Inductor 4030 SMD | 2.2uH | Inductor 4030 SMD | pnp_bus_controller | 1 | MISSING |  | none | no-sync-file |
| 29 | 2920L500/24SLDR\|Fuse 2920 | 2920L500/24SLDR | Fuse 2920 | pnp_feeder_backplane | 1 | MISSING |  | none | no-sync-file |
| 30 | 3300pF\|C0603 | 3300pF | C0603 | pnp_feeder_backplane | 1 | MISSING |  | none | no-sync-file |
| 31 | 53k6\|R0402 | 53k6 | R0402 | pnp_feeder_backplane | 1 | MISSING |  | none | no-sync-file |
| 32 | 6800pF\|C0603 | 6800pF | C0603 | pnp_feeder_backplane | 1 | MISSING |  | none | no-sync-file |
| 33 | 84k5\|R0402 | 84k5 | R0402 | pnp_feeder_backplane | 1 | MISSING |  | none | no-sync-file |
| 34 | AP2112K-3.3\|SOT-23-5 (DBV) | AP2112K-3.3 | SOT-23-5 (DBV) | pnp_max_feeder_shield | 1 | UNSURE | hardware/cad/lib/components/pkg_discrete.scad (header names "ap2112k") — auto-candidate, not reviewed | none | no-sync-file |
| 35 | AP63203-5to3V3\|SOT-23-6 (TSOT-23-6) | AP63203-5to3V3 | SOT-23-6 (TSOT-23-6) | pnp_bus_controller | 1 | MISSING |  | none | no-sync-file |
| 36 | B560C-13-F\|SMC | B560C-13-F | SMC | pnp_feeder_backplane | 1 | UNSURE | hardware/cad/lib/components/pkg_discrete.scad (header names "b560c") ; hardware/cad/lib/components/pkg_discrete.scad:pd_b560c_13_f — auto-candidate, not reviewed | none | no-sync-file |
| 37 | ESP32-C3-MINI-1\|ESP32-C3-MINI-1 13.2x16.6mm module (PCB antenna at top, EP=pad53) | ESP32-C3-MINI-1 | ESP32-C3-MINI-1 13.2x16.6mm module (PCB antenna at top, EP=pad53) | pnp_bus_controller | 1 | MISSING | esp32_s3.scad models the S3-WROOM-1 only; no C3-MINI-1 (13.2x16.6) model | none | no-sync-file |
| 38 | ESP32-S3-WROOM-1U\|ESP32-S3-WROOM-1U | ESP32-S3-WROOM-1U | ESP32-S3-WROOM-1U | pnp_max_feeder_shield | 1 | PARTIAL | hardware/cad/lib/components/esp32_s3.scad:esp32_s3 — the WROOM-1 model (18x25.5), not the -1U outline (18x19.2, u.FL) | none | no-sync-file |
| 39 | PPTC-1A\|Fuse 1812 | PPTC-1A | Fuse 1812 | pnp_bus_controller | 1 | MISSING |  | none | no-sync-file |
| 40 | PPTC-PACK-3A-16V\|Fuse 1812 | PPTC-PACK-3A-16V | Fuse 1812 | pnp_max_feeder_shield | 1 | MISSING |  | none | no-sync-file |
| 41 | SMBJ15A\|SMB | SMBJ15A | SMB | pnp_bus_controller | 1 | MISSING |  | none | no-sync-file |
| 42 | SMBJ30A\|SMB | SMBJ30A | SMB | pnp_feeder_backplane | 1 | MISSING |  | none | no-sync-file |
| 43 | SMBJ6.0A\|SMB | SMBJ6.0A | SMB | pnp_max_feeder_shield | 1 | UNSURE | hardware/cad/lib/components/pkg_discrete.scad (header names "smbj6") ; hardware/cad/lib/components/pkg_discrete.scad:pd_smbj6_0d_m3_h — auto-candidate, not reviewed | none | no-sync-file |
| 44 | SW_SPDT\|Microswitch | SW_SPDT | Microswitch | Feeder-Panelized | 25 | MISSING |  | kicad-lib | no-sync-file |
| 45 | TPS54360\|HSOP-8 PowerPAD | TPS54360 | HSOP-8 PowerPAD | pnp_feeder_backplane | 1 | MISSING |  | none | no-sync-file |

### deferred

| # | Part (Mfr_PN or value\|package) | Value | Package | Boards | Refs | SCAD | Where / why | KiCad 3D | pcb_sync box |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 0402WGF1002TCE | 10k | R0402 | autoframe_motor, autoframe_motor_2ch | 10 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | none | yes, no |
| 2 | 0402WGF1003TCE | 100k | R0402 | autoframe_motor, autoframe_motor_2ch | 12 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | none | yes, no |
| 3 | 0402WGF2202TCE | 22k | R0402 | autoframe_motor, autoframe_motor_2ch | 2 | MISSING |  | none | yes, no |
| 4 | 0402WGF3302TCE | 33k | R0402 | autoframe_motor, autoframe_motor_2ch | 4 | MISSING |  | none | yes, no |
| 5 | 0402WGF330JTCE | 33 | R0402 | autoframe_motor, autoframe_motor_2ch | 2 | MISSING |  | none | yes, no |
| 6 | 0402WGF4700TCE | 470 | R0402 | autoframe_motor, autoframe_motor_2ch | 4 | MISSING |  | none | yes, no |
| 7 | 0436500315 | MicroFit-3P | Molex Micro-Fit 3.0 43650-0315 1x03 vertical THT (internal header) | autoframe_motor, autoframe_motor_2ch | 10 | MISSING |  | none | yes |
| 8 | 10uF-0603-X5R | 10uF | 0603 2-term | autoframe_motor, autoframe_motor_2ch | 2 | MISSING |  | none | yes, no |
| 9 | AO3400A | AO3400 | SOT-23-3 | autoframe_motor, autoframe_motor_2ch | 6 | HAS | hardware/cad/lib/components/pkg_discrete.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | none | yes, no |
| 10 | AP63203WU-7 | AP63203 | SOT-23-6 (TSOT-23-6) | autoframe_motor, autoframe_motor_2ch | 2 | HAS | hardware/cad/lib/components/pkg_discrete.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | none | yes |
| 11 | AP63205WU-7 | AP63205 | SOT-23-6 (TSOT-23-6) | autoframe_motor, autoframe_motor_2ch | 2 | MISSING |  | none | yes |
| 12 | CL05A105KA5NQNC | 1uF | C0402 | autoframe_motor, autoframe_motor_2ch | 4 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | none | yes, no |
| 13 | CL05A106MQ5NUNC | 10uF | C0402 | autoframe_motor, autoframe_motor_2ch | 2 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | none | yes, no |
| 14 | CL05B104KO5NNNC | 100nF | C0402 | autoframe_motor, autoframe_motor_2ch | 18 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | none | yes, no |
| 15 | CL05B473KO5NNNC | 47nF | C0402 | autoframe_motor, autoframe_motor_2ch | 2 | MISSING |  | none | yes, no |
| 16 | CL10A226MQ8NRNC | 22uF | 0603 2-term | autoframe_motor, autoframe_motor_2ch | 4 | MISSING |  | none | yes, no |
| 17 | DRV8873HPWPR | DRV8873H | DRV8873H HTSSOP-24 PowerPAD (TI SLVSET1 §5) — PH/EN hardware variant | autoframe_motor, autoframe_motor_2ch | 2 | MISSING |  | none | yes |
| 18 | ESP32-C3-MINI-1-N4 | ESP32-C3-MINI-1 | ESP32-C3-MINI-1 13.2x16.6mm module (PCB antenna at top, EP=pad53) | autoframe_motor, autoframe_motor_2ch | 2 | MISSING | esp32_s3.scad models the S3-WROOM-1 only; no C3-MINI-1 (13.2x16.6) model | none | yes |
| 19 | G6S-2 DC12 | DPDT-12V | Omron G6S-2 DPDT relay THT (KiCad verified land, re-centered) | autoframe_motor, autoframe_motor_2ch | 6 | MISSING |  | none | yes |
| 20 | NXH35V100M6.3*11 | 100uF | Radial elec cap | autoframe_motor, autoframe_motor_2ch | 2 | MISSING |  | none | yes |
| 21 | PPTC-4A\|1206 2-term (PPTC fuse) | PPTC-4A | 1206 2-term (PPTC fuse) | autoframe_motor, autoframe_motor_2ch | 2 | MISSING |  | none | yes, no |
| 22 | RVT220UF35V | 220uF | Alu-elec SMD V-chip case-D (Ø6.3x7.7mm), pad1=+ pad2=- | autoframe_motor, autoframe_motor_2ch | 4 | MISSING |  | none | yes |
| 23 | S1A | S1A | SMA (DO-214AC) flyback diode | autoframe_motor, autoframe_motor_2ch | 6 | MISSING |  | none | yes, no |
| 24 | SK6805-EC15 | SK6805 | SK6805-EC15 1515 1-wire RGB LED (1=VDD 2=DOUT 3=GND 4=DIN) | autoframe_motor, autoframe_motor_2ch | 2 | MISSING |  | none | yes, no |
| 25 | SMAJ18CA-E3/61 | SMAJ18CA | SMA (DO-214AC) bidirectional TVS (relay-contact snubber, no polarity) | autoframe_motor, autoframe_motor_2ch | 6 | MISSING |  | none | yes, no |
| 26 | SMBJ15A | SMBJ15A | SMB (DO-214AA) TVS diode | autoframe_motor, autoframe_motor_2ch | 2 | MISSING |  | none | yes, no |
| 27 | SN74AHCT1G125DBVR | 74AHCT1G125 | SOT-23-5 (DBV) | autoframe_motor, autoframe_motor_2ch | 2 | HAS | hardware/cad/lib/components/pkg_discrete.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | none | yes |
| 28 | SS54 | SS54 | SMC (DO-214AB) Schottky | autoframe_motor, autoframe_motor_2ch | 2 | MISSING |  | none | yes, no |
| 29 | XGL4030-222MEC | 2.2uH | Inductor 4030 SMD | autoframe_motor, autoframe_motor_2ch | 3 | HAS | hardware/cad/lib/components/pkg_xtal_l.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | none | yes |
| 30 | CKCS252012-2.2uH/N | 2.2uH-2520 | Inductor 2520 SMD | autoframe_motor_2ch | 1 | MISSING |  | none | no |

### superseded

| # | Part (Mfr_PN or value\|package) | Value | Package | Boards | Refs | SCAD | Where / why | KiCad 3D | pcb_sync box |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 0402WGF1000TCE | 100R | R0402 | pico_zero_carrier, sensor_pod, solar_box | 4 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | none | yes |
| 2 | 0402WGF1002TCE | 10k | R0402 | pico_zero_carrier, sensor_pod, solar_box | 9 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | none | yes |
| 3 | 0402WGF4701TCE | 4k7 | R0402 | pico_zero_carrier, sensor_pod, solar_box | 7 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | none | yes |
| 4 | 2N7002 | 2N7002 | SOT-23-3 | pico_zero_carrier, sensor_pod, solar_box | 3 | HAS | hardware/cad/lib/components/pkg_discrete.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | none | yes |
| 5 | BME280 | BME280 | BME280 LGA-8 | pico_zero_carrier, sensor_pod, solar_box | 3 | HAS | hardware/cad/lib/components/bme280_lga8.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | none | yes |
| 6 | CL05B104KO5NNNC | 100nF | C0402 | pico_zero_carrier, sensor_pod, solar_box | 15 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | none | yes |
| 7 | CL21A226KOQNNNE | 22uF | C 0805 | pico_zero_carrier, sensor_pod, solar_box | 6 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | none | yes |
| 8 | SK6812MINI-E | SK6812-MINI-E | SK6812-MINI-E RGB LED | pico_zero_carrier, sensor_pod, solar_box | 3 | HAS | hardware/cad/lib/components/sk6812mini_e.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | none | yes |
| 9 | SN74AHCT1G125DBVR | 74AHCT1G125 | SOT-23-5 (DBV) | pico_zero_carrier, sensor_pod, solar_box | 3 | HAS | hardware/cad/lib/components/pkg_discrete.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | none | yes |
| 10 | 0402WGF1001TCE | 1k | R0402 | pico_zero_carrier, sensor_pod | 2 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | none | yes |
| 11 | 0402WGF1003TCE | 100k | R0402 | pico_zero_carrier, solar_box | 3 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | none | yes |
| 12 | AP2112K-3.3TRG1 | AP2112K-3.3 | SOT-23-5 (DBV) | pico_zero_carrier, sensor_pod | 2 | UNSURE | hardware/cad/lib/components/pkg_discrete.scad (header names "ap2112k") — auto-candidate, not reviewed | none | yes |
| 13 | BNTPD1E05U06DYAR | TPD1E05U06 | TVS SOD-523 (TPD1E05U06, unidir ESD) | sensor_pod, solar_box | 4 | HAS | hardware/cad/lib/components/pkg_discrete.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | none | yes |
| 14 | CL05A105KA5NQNC | 1uF | C0402 | pico_zero_carrier, sensor_pod | 4 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | none | yes |
| 15 | CL05A106MQ5NUNC | 10uF | C0402 | pico_zero_carrier, sensor_pod | 2 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | none | yes |
| 16 | RC0402FR-0733RL | 33R | R0402 | pico_zero_carrier, solar_box | 2 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | none | yes |
| 17 | SMBJ6.0D-M3/H | SMBJ6.0A | SMB | pico_zero_carrier, sensor_pod | 2 | HAS | hardware/cad/lib/components/pkg_discrete.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | none | yes |
| 18 | 0402WGF0000TCE | 0R | R0402 | sensor_pod | 1 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | none | yes |
| 19 | 0402WGF1022TCE | 10k2 | R0402 | solar_box | 1 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | none | yes |
| 20 | 0402WGF1200TCE | 120R | R0402 | solar_box | 1 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | none | yes |
| 21 | 0402WGF1302TCE | 13k0 | R0402 | solar_box | 1 | MISSING |  | none | yes |
| 22 | 0402WGF1583TCE | 158k | R0402 | solar_box | 1 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | none | yes |
| 23 | 0402WGF1623TCE | 162k | R0402 | solar_box | 1 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | none | yes |
| 24 | 0402WGF330JTCE | 33R | R0402 | sensor_pod | 1 | MISSING |  | none | yes |
| 25 | 0402WGF4992TCE | 49k9 | R0402 | solar_box | 1 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | none | yes |
| 26 | 0402WGF5113TCE | 511k | R0402 | solar_box | 1 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | none | yes |
| 27 | 0402WGF5362TCE | 53k6 | R0402 | solar_box | 1 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | none | yes |
| 28 | 0402WGF8452TCE | 84k5 | R0402 | solar_box | 1 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | none | yes |
| 29 | 0603B682K500NT | 6800pF | C0603 | solar_box | 1 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | none | yes |
| 30 | 0603CG1R5C500NT | 1p5 | C0603 | solar_box | 1 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | none | yes |
| 31 | 0R\|R0402 | 0R | R0402 | sensor_pod_v2 | 1 | MISSING |  | none | no-sync-file |
| 32 | 100k\|R0402 | 100k | R0402 | hbs57_mux | 1 | MISSING |  | none | no-sync-file |
| 33 | 100K\|R0402 | 100K | R0402 | sensor_pod_v2 | 1 | MISSING |  | none | no-sync-file |
| 34 | 100nF\|C0603 | 100nF | C0603 | hbs57_mux | 2 | MISSING |  | none | no-sync-file |
| 35 | 100nF\|R0402 | 100nF | R0402 | sensor_pod_v2 | 10 | MISSING |  | none | no-sync-file |
| 36 | 10K\|R0402 | 10K | R0402 | sensor_pod_v2 | 3 | MISSING |  | none | no-sync-file |
| 37 | 10uF\|C0603 | 10uF | C0603 | sensor_pod_v2 | 1 | MISSING |  | none | no-sync-file |
| 38 | 10uF\|C0805 | 10uF | C0805 | hbs57_mux | 1 | MISSING |  | none | no-sync-file |
| 39 | 10uF\|R0402 | 10uF | R0402 | sensor_pod_v2 | 4 | MISSING |  | none | no-sync-file |
| 40 | 12pF\|R0402 | 12pF | R0402 | sensor_pod_v2 | 2 | MISSING |  | none | no-sync-file |
| 41 | 1812L150/24MR | PPTC-TRUNK-1.5A-24V-PROV-see-note | Fuse 1812 | solar_box | 1 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | none | yes |
| 42 | 18K\|R0402 | 18K | R0402 | sensor_pod_v2 | 1 | MISSING |  | none | no-sync-file |
| 43 | 18pF\|R0402 | 18pF | R0402 | sensor_pod_v2 | 2 | MISSING |  | none | no-sync-file |
| 44 | 1k\|R0402 | 1k | R0402 | hbs57_mux | 3 | MISSING |  | none | no-sync-file |
| 45 | 1uF\|R0402 | 1uF | R0402 | sensor_pod_v2 | 9 | MISSING |  | none | no-sync-file |
| 46 | 2.2K\|R0402 | 2.2K | R0402 | sensor_pod_v2 | 2 | MISSING |  | none | no-sync-file |
| 47 | 2.54-2*20 | Pico-Zero | Pico Zero 40-pin header (2x20, 2.54mm pitch) | pico_zero_carrier | 1 | HAS | hardware/cad/lib/components/pin_header_254.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | none | yes |
| 48 | 22R\|R0402 | 22R | R0402 | sensor_pod_v2 | 6 | MISSING |  | none | no-sync-file |
| 49 | 24MHz\|SOT-23-3 | 24MHz | SOT-23-3 | sensor_pod_v2 | 1 | MISSING |  | none | no-sync-file |
| 50 | 32.768kHz\|SOT-23-3 | 32.768kHz | SOT-23-3 | sensor_pod_v2 | 1 | MISSING |  | none | no-sync-file |
| 51 | 4.7K\|R0402 | 4.7K | R0402 | sensor_pod_v2 | 2 | MISSING |  | none | no-sync-file |
| 52 | 5.1K\|R0402 | 5.1K | R0402 | sensor_pod_v2 | 2 | MISSING |  | none | no-sync-file |
| 53 | 500mA PTC\|R0402 | 500mA PTC | R0402 | sensor_pod_v2 | 1 | MISSING |  | none | no-sync-file |
| 54 | 61400416021 | USB-A HOST | USB-A receptacle TH horizontal (Wurth 61400416021) | sensor_pod | 1 | MISSING |  | none | yes |
| 55 | AO3400A | AO3400 | SOT-23-3 | solar_box | 1 | HAS | hardware/cad/lib/components/pkg_discrete.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | none | yes |
| 56 | AO3407A | AO3407A | SOT-23-3 | solar_box | 1 | HAS | hardware/cad/lib/components/pkg_discrete.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | none | yes |
| 57 | AP63203WU-7 | AP63203-5to3V3 | SOT-23-6 (TSOT-23-6) | solar_box | 1 | HAS | hardware/cad/lib/components/pkg_discrete.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | none | yes |
| 58 | B-2100S02P-A110 | NTC-PACK | Pin header 2p r1 vert | solar_box | 1 | HAS | hardware/cad/lib/components/pin_header_254.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | none | yes |
| 59 | B-2100S06P-A110 | UART | Pin header 6p r1 | solar_box | 1 | HAS | hardware/cad/lib/components/pin_header_254.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | none | yes |
| 60 | B2B-XH-A(LF)(SN) | FAN | JST XH 2p TH | solar_box | 4 | HAS | hardware/cad/lib/components/jst_xh.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | none | yes |
| 61 | B4B-XH-A | CH0 | JST XH 4p TH | hbs57_mux | 6 | MISSING |  | none | no-sync-file |
| 62 | B560C-13-F | B560C-13-F | SMC | solar_box | 3 | HAS | hardware/cad/lib/components/pkg_discrete.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | none | yes |
| 63 | BME280\|Bosch BME280 LGA-8 2.5x2.5x0.93mm | BME280 | Bosch BME280 LGA-8 2.5x2.5x0.93mm | sensor_pod_v2 | 1 | MISSING | candidate lib/honey_tank_sensor.scad names a BME280 BREAKOUT pcb inside the honey-tank sensor assembly, not the LGA-8 2.5x2.5x0.93 chip | none | no-sync-file |
| 64 | BSMD1812-300-16V | PPTC-PACK-3A-16V-1812-DERATES-1A95-AT-60C | Fuse 1812 | solar_box | 1 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | none | yes |
| 65 | CC0603JRNPO9BN390 | 39pF | C0603 | solar_box | 1 | MISSING |  | none | yes |
| 66 | CC0603KRX7R9BB104 | 100nF | C0603 | solar_box | 4 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | none | yes |
| 67 | CKST0603-10uH/M | 10uH | CKST0603 Shielded Inductor | solar_box | 1 | HAS | hardware/cad/lib/components/pkg_xtal_l.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | none | yes |
| 68 | CL05A474KA5NNNC | 470nF | C0402 | solar_box | 1 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | none | yes |
| 69 | CL10A105KB8NNNC | 1uF | C0603 | solar_box | 1 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | none | yes |
| 70 | CL10B224KB8NNNC | 220nF | C0603 | solar_box | 1 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | none | yes |
| 71 | CL10B471KB8NNNC | 470pF | C0603 | solar_box | 1 | MISSING |  | none | yes |
| 72 | CL21A106KAYNNNE | 10uF | C0805 | solar_box | 8 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | none | yes |
| 73 | CN3722 | CN3722 | TSSOP-16 | solar_box | 1 | HAS | hardware/cad/lib/components/pkg_ic.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | none | yes |
| 74 | ESD\|TVS SOD-523 (TPD1E05U06, unidir ESD) | ESD | TVS SOD-523 (TPD1E05U06, unidir ESD) | sensor_pod_v2 | 2 | MISSING |  | none | no-sync-file |
| 75 | ESP32-S3-MINI-1-N8 | ESP32-S3-MINI-1 | ESP32-S3-MINI-1 15.4x20.5mm module (PCB antenna at top, EP=pin61) per Espressif DS v1.7 Table 3-1 + Fig 3-1/10-1/11-1 | sensor_pod | 1 | MISSING | esp32_s3.scad models the S3-WROOM-1 only; no S3-MINI-1 model | none | yes |
| 76 | ESP32-S3-WROOM-1U-N8R8 (DNP) | ESP32-S3-WROOM-1U-N8R8 | ESP32-S3-WROOM-1U | solar_box | 1 | HAS | hardware/cad/lib/components/esp32_s3.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | none | yes |
| 77 | FMF25FPJR010-LH | 10mR | R2512 | solar_box | 4 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | none | yes |
| 78 | FPC-22P\|FPC-22P 0.5mm bottom-contact | FPC-22P | FPC-22P 0.5mm bottom-contact | sensor_pod_v2 | 1 | MISSING |  | none | no-sync-file |
| 79 | FST-1230 | PIEZO-12 | Piezo 12mm SMD (2-pad) | sensor_pod | 1 | MISSING |  | none | yes |
| 80 | GRN\|C0603 | GRN | C0603 | hbs57_mux | 3 | MISSING |  | none | no-sync-file |
| 81 | GSC1230YB-3V4000 | PIEZO-12 | Piezo 12mm SMD (2-pad) | pico_zero_carrier | 1 | MISSING |  | none | yes |
| 82 | GX2512-2W-100mR-1% | 100mR | R2512 | solar_box | 1 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | none | yes |
| 83 | ICS-43434\|ICS-43434 LGA bottom-port I2S MEMS mic | ICS-43434 | ICS-43434 LGA bottom-port I2S MEMS mic | sensor_pod_v2 | 1 | HAS | hardware/cad/lib/components/ics43434_mic.scad:ics43434_mic — chip-level LGA-6 3.5x2.65 model; footprint sourced from the BOM, body height 0.98 and port flagged PROV in its own header | none | no-sync-file |
| 84 | INA219AIDR | INA219 | SOIC-8 | solar_box | 3 | HAS | hardware/cad/lib/components/pkg_ic.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | none | yes |
| 85 | INA226AIDGSR | INA226 | VSSOP-10 (MSOP-10) 3x3mm 0.5p | solar_box | 1 | HAS | hardware/cad/lib/components/pkg_ic.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | none | yes |
| 86 | JST-XH-2P\|JST XH 2p TH | JST-XH-2P | JST XH 2p TH | sensor_pod_v2 | 1 | MISSING |  | none | no-sync-file |
| 87 | KF301-5.0-2P | PV/24V-IN | Screw terminal 2p | solar_box | 2 | HAS | hardware/cad/lib/components/screw_terminal.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | none | yes |
| 88 | M8-P4A-GPF-nl | M8-P4A-GPF-nl C19108961 | CONN-TH_M8-P4A-GPFM8 | sensor_pod | 1 | MISSING |  | other | yes |
| 89 | M8-S4A-GPF-nl | M8-S4A-GPF-nl C19108966 | CONN-TH_M8-S4A-GPF-nutless | sensor_pod | 1 | MISSING |  | none | yes |
| 90 | ME6211C33\|SOT-23-5 (DBV) | ME6211C33 | SOT-23-5 (DBV) | sensor_pod_v2 | 1 | MISSING |  | none | no-sync-file |
| 91 | MF-MSMF110-2 | PPTC-POD-1.1A-PROV-see-note | Fuse 1812 | pico_zero_carrier | 1 | HAS | hardware/cad/lib/components/pkg_chip.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | none | yes |
| 92 | microSD\|microSD push-push TF-01A 9-contact | microSD | microSD push-push TF-01A 9-contact | sensor_pod_v2 | 1 | MISSING |  | none | no-sync-file |
| 93 | Pi GPIO 1x6\|Pin header 6p r1 vert | Pi GPIO 1x6 | Pin header 6p r1 vert | hbs57_mux | 1 | MISSING |  | none | no-sync-file |
| 94 | PNLS4030-100M 10UH | 10uH | Inductor 4030 SMD | solar_box | 1 | MISSING |  | none | yes |
| 95 | PPMT20V3 | P-FET-20V-SIG | SOT-23-3 | solar_box | 1 | HAS | hardware/cad/lib/components/pkg_discrete.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | none | yes |
| 96 | RECOVERY\|Tactile pushbutton 6x6mm THT (lid-plunger actuated) | RECOVERY | Tactile pushbutton 6x6mm THT (lid-plunger actuated) | sensor_pod_v2 | 1 | MISSING |  | none | no-sync-file |
| 97 | RESET\|Tactile pushbutton 6x6mm THT (lid-plunger actuated) | RESET | Tactile pushbutton 6x6mm THT (lid-plunger actuated) | sensor_pod_v2 | 1 | MISSING |  | none | no-sync-file |
| 98 | RV1106G3\|RV1106 QFN-128 12.3x12.3mm | RV1106G3 | RV1106 QFN-128 12.3x12.3mm | sensor_pod_v2 | 1 | MISSING | RV1106 is named only inside luckfox_pico_zero.scad (the whole Luckfox board) and imx219_camera.scad; no bare QFN-128 model | none | no-sync-file |
| 99 | SI2301 3A | P-FET-20V-3A-LOGIC | SOT-23-3 | solar_box | 1 | HAS | hardware/cad/lib/components/pkg_discrete.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | none | yes |
| 100 | Si2301CDS-T1-GE3 | P-FET-20V-3A-LOGIC | SOT-23-3 | pico_zero_carrier | 1 | HAS | hardware/cad/lib/components/pkg_discrete.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | none | yes |
| 101 | SMBJ26A | TVS-UNIDIR-26V-SMB | SMB | solar_box | 1 | MISSING |  | none | yes |
| 102 | SMBJ6.0A\|SMB | SMBJ6.0A | SMB | sensor_pod_v2 | 1 | UNSURE | hardware/cad/lib/components/pkg_discrete.scad (header names "smbj6") ; hardware/cad/lib/components/pkg_discrete.scad:pd_smbj6_0d_m3_h — auto-candidate, not reviewed | none | no-sync-file |
| 103 | SS34 | SS34 | SMA | solar_box | 2 | HAS | hardware/cad/lib/components/pkg_discrete.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | none | yes |
| 104 | TF-01A | TF-01A | microSD push-push TF-01A 9-contact | solar_box | 1 | HAS | hardware/cad/lib/components/microsd_tf_01a.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | none | yes |
| 105 | TMUX1308PWR | TMUX1308 | TSSOP-16 | hbs57_mux | 2 | MISSING |  | none | no-sync-file |
| 106 | TPD1E05U06DYAR | TPD1E05U06 | TVS SOD-523 (TPD1E05U06, unidir ESD) | hbs57_mux | 12 | HAS | hardware/cad/lib/components/pkg_discrete.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | none | no-sync-file |
| 107 | TPS54360DDAR | TPS54360 | HSOP-8 PowerPAD | solar_box | 1 | HAS | hardware/cad/lib/components/pkg_ic.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | none | yes |
| 108 | TPS62740\|SOT-23-5 (DBV) | TPS62740 | SOT-23-5 (DBV) | sensor_pod_v2 | 3 | MISSING |  | none | no-sync-file |
| 109 | USB-231-ARY | USB-A HOST (dongle) | USB-A receptacle TH horizontal (Wurth 61400416021) | solar_box | 1 | HAS | hardware/cad/lib/components/usb_a_231_ary.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | none | yes |
| 110 | USB-C\|USB-C 16-pin SMD | USB-C | USB-C 16-pin SMD | sensor_pod_v2 | 1 | MISSING |  | none | no-sync-file |
| 111 | USB-TTL 1x4\|Pin header 4p r1 vert | USB-TTL 1x4 | Pin header 4p r1 vert | hbs57_mux | 1 | MISSING |  | none | no-sync-file |
| 112 | VDD 3V3\|5V\|Pin header 3p r1 vert | VDD 3V3\|5V | Pin header 3p r1 vert | hbs57_mux | 1 | MISSING |  | none | no-sync-file |
| 113 | WJ500V-5.08-2P | Terminal 2p | Screw terminal 2p | pico_zero_carrier | 2 | HAS | hardware/cad/lib/components/screw_terminal.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | none | yes |
| 114 | WS2812B\|WS2812B-MINI 3.5x3.3mm | WS2812B | WS2812B-MINI 3.5x3.3mm | sensor_pod_v2 | 3 | MISSING |  | none | no-sync-file |
| 115 | XGL4030-222MEC | 2.2uH | Inductor 4030 SMD | solar_box | 1 | HAS | hardware/cad/lib/components/pkg_xtal_l.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | none | yes |
| 116 | XT60PW-M | XT60PW-M | XT60PW-M30 male right-angle power connector | solar_box | 1 | HAS | hardware/cad/lib/components/xt60pw_m.scad — declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file) | none | yes |
