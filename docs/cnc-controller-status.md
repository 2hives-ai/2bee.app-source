# CNC Controller Status — 2026-08-20 (updated)

## Current state

**Board: ALIVE — grblHAL running, PROBE_ENABLE=1, accepting G38.2**

SKR Pro v1.2 (STM32F407VE) connected to RPi Zero 2 W at `cnc@cnc.local`.
USB at `/dev/ttyACM0` — enumerating as `STM32 Virtual ComPort`.

### Firmware update — 2026-08-20

Rebuilt with `PROBE_ENABLE=1` (was 0). Flashed via DFU (`$DFU` → `dfu-util -a 0 -s 0x08000000:leave -D firmware.bin`).

**Before:** G38.2 returned `error:20` (unsupported command).
**After:** G38.2 is accepted. Probe pin reads `Pn:P` (floating — no physical probe connected). With no probe wired, the board enters alarm on probe commands. This is expected behavior — once a touch plate is wired, G38.2 will execute.

**Build flags:** `PROBE_ENABLE=1`, `SAFETY_DOOR_ENABLE=0`, `CONTROL_ENABLE=0`, `ESTOP_ENABLE=0`.

SKR Pro v1.2 (STM32F407VE) connected to RPi Zero 2 W at `cnc@cnc.local`.
USB at `/dev/ttyACM0` — enumerating as `STM32 Virtual ComPort`.

### Recovery — 2026-08-20

1. ST-Link V2 connected to SWD pads (SWDIO, SWCLK, GND, 3.3V)
2. Firmware built with PlatformIO (`btt_skr_pro_1_2_stlink` environment)
3. Flashed via `st-flash write firmware.bin 0x08000000` (no-bootloader build)
4. EEPROM sector (`0x080E0000`) erased to apply clean defaults
5. Limit switch pins (X-, Y-, Z-) jumpered signal-to-GND
6. `CONTROL_ENABLE=0` added to build flags to disable floating EXP1 control inputs
7. Board boots to `Idle`, `$X` unlocks, G-code accepted

### First controller acceptance transcript — 2026-08-20

Gate **CTRL** exercised with `tools/controller_probe.py` against `rect-profile` fixture.
Result: **47/50 lines answered; the last 3 (M5, G0 Z5.000, M30) were never answered at all.**

⚠ **CORRECTED 2026-08-27 — this line read "3 rejected".** The transcript records
`replies: []` and `verdict: null` for all three. **A rejection and a silence are different
findings with different owners.** "Rejected by grblHAL" is a claim about *our dialect* and sends
the next reader into `post_grblhal.rs`; the board stopped talking. A headline outruns the
paragraph under it.

⚠⚠ **CORRECTED AGAIN, same day, on pcb's catch — the cause this file named was impossible.**
The paragraph below (and the correction above, until now) attributed the silence to
"AUXINPUT0 (PG4, safety door) floating". **It cannot be:** `SAFETY_DOOR_ENABLE=0` is in the
build (quoted two lines below, and at `grblhal/STM32F4xx/Inc/my_machine.h:153`), so grblHAL
never reads PG4 — a floating PG4 raises no alarm and grounding it would change nothing.
`CONTROL_ENABLE=0` rules out the EXP1 control inputs the same way. **The build flags and the
diagnosis sat in this one document, disagreeing, for a week.** And the signature was always
wrong for alarm: a controller in alarm still answers G-code with `error:9`; these three lines
got *silence*. Silence means the link stopped or the board reset. pcb records an **observed
hub-level USB dropout on this machine** (`usb usb1-port1: disabled by hub (EMI?)`,
`hardware/pcb/cnc-grblhal-pinmap-verification.md`) — a hypothesis, not a finding. What settles
it on the re-probe (#126): capture `dmesg -w` alongside and keep the raw serial log. If the
port drops, it is in dmesg; if not, the board reset and that is pursued properly. **Do not
ground PG4; the bench task is cancelled.**

🔴 **AND THIS TRANSCRIPT CANNOT BE COUNTED BY GATE `CTRL`.** `--program-command` was not passed,
so `program_command` is `""`, and CTRL's first check refuses any transcript it cannot re-emit and
hash-compare — a transcript for a program the build no longer emits is stale evidence, and stale
evidence reads exactly like proof. Measured 2026-08-27: this transcript's `program_sha256`
**matches `fixture rect-profile` from the current build byte for byte**, so the run really is
about today's program — but that has to be re-recorded by the probe at the moment the bytes go
out, not inferred into the file afterwards. `tools/controller_probe.py` now REFUSES to write a
transcript without `--program-command` and `--operator`. See TODO #126.

Firmware: grblHAL 1.1f (2026-08-17), STM32F407@168MHz, BTT SKR PRO v1.1.
Build: `btt_skr_pro_1_2_stlink`, `CONTROL_ENABLE=0`, `ESTOP_ENABLE=0`, `SAFETY_DOOR_ENABLE=0`, `PROBE_ENABLE=0`.

The 3 silent lines are **not dialect issues** — and the cause first written here
("AUXINPUT0/PG4 floating") was **impossible on this build** (`SAFETY_DOOR_ENABLE=0`; see the
double correction above, 2026-08-27, on pcb's catch). True cause UNKNOWN; the measured
signature is silence (no `error:`, no alarm reply), and the live hypothesis is a hub-level USB
dropout observed on this machine. Settled by the #126 re-probe with `dmesg -w` captured.
Transcript: `gates/ctrl-transcript-2026-08-20.json`.

### What happened

1. Board originally had Marlin firmware (3D printer firmware).
2. grblHAL core + STM32F4xx HAL driver cloned to `grblhal/` in this repo.
3. Firmware built with PlatformIO (`pio run -e btt_skr_pro_1_1`).
4. Flashed via SD card three times to disable floating signal pins:
   - First flash: ESTOP_ENABLE=0, SAFETY_DOOR_ENABLE=0, PROBE_ENABLE=0
   - Second: added DEFAULT_CONTROL_SIGNALS_INVERT_MASK=-1
   - Third: added DEFAULT_LIMIT_SIGNALS_INVERT_MASK=-1
5. Board always entered alarm state (`Pn:XYZHSEP` — floating limit switch + control pins).
6. Sent `$DFU` command to enter STM32 DFU bootloader for USB flashing.
7. `dfu-util` flashed `firmware.bin` to `0x08000000` — **WRONG ADDRESS**.
   - The BL32K linker script places `.isr_vector` at 0x08000000 but `.text` at 0x08008000.
   - The BTT SD bootloader (which lived at 0x08000000–0x08008000) was overwritten.
   - The chip boots, finds grblHAL's vector table at 0x08000000, jumps to 0x08008000
     where there's no code → crash, no USB enumeration.
8. **Board is unresponsive.** BOOT0 is tied to GND on the SKR Pro PCB, so the
   STM32 ROM bootloader cannot be entered. No way to recover without SWD.

### Recovery plan (HISTORY — this happened, 2026-08-20)

> ⚠ **MARKED AS HISTORY 2026-08-27. Read this section as a record, not as a plan.**
> It was written in the future tense while the board was bricked — *"**ST-Link v2
> ordered** (Amazon AU)"* — and it then carried no historical marker of any kind,
> so a reader landing here after the *"Board: ALIVE"* headline six lines from the
> top of this file finds an ordered part and an unexecuted flash and has to work
> out for themselves which of the two is current. **Every step below was carried
> out**, and the file already says so twice above: `### Recovery — 2026-08-20`
> records the ST-Link connected to the SWD pads, the `btt_skr_pro_1_2_stlink`
> build flashed at `0x08000000`, the EEPROM sector erased, and the board booting
> to `Idle`; and `### First controller acceptance transcript — 2026-08-20` records
> 50 lines sent to the recovered board. **Direction of the staleness: it read as an
> OPEN blocker on work that was already finished** — the same shape this file's
> own `## Known issues (from before bricking)` heading exists to prevent, which is
> the marker style copied here. Nothing below is edited.

**ST-Link v2 ordered** (Amazon AU). Connect to SWD pads on the SKR Pro:

| SKR Pro pad | ST-Link pin |
|---|---|
| SWD | SWDIO |
| SWC | SWCLK |
| GND | GND |
| 3.3V | 3.3V |
| RST | RST (optional) |

**New no-bootloader environment prepared:**
- `platformio.ini`: `[env:btt_skr_pro_1_2_stlink]`
- Linker script: `STM32F407VGTX_NO_BL_FLASH.ld` — firmware at 0x08000000, no bootloader offset
- Upload: `upload_protocol = stlink`
- No `HAS_BOOTLOADER` define (vector table at default address, no VTOR relocation)

**Flash command:**
```bash
cd grblhal/STM32F4xx
pio run -e btt_skr_pro_1_2_stlink -t upload
```

### Future firmware updates (after recovery) — the "after" ARRIVED, 2026-08-20

> ⚠ **MARKED 2026-08-27.** The heading's condition is discharged: *"Once grblHAL is
> running with the no-bootloader build"* — it is, and **this exact procedure has
> been used**. `### Firmware update — 2026-08-20` above records the
> `PROBE_ENABLE=1` rebuild flashed by precisely these two steps (*"Flashed via DFU
> (`$DFU` → `dfu-util -a 0 -s 0x08000000:leave -D firmware.bin`)"*). So the list
> below is **the live procedure**, not a contingency — which is the opposite
> reading its heading invited. Nothing below is edited.

Once grblHAL is running with the no-bootloader build:
1. Send `$DFU` over serial → board enters STM32 DFU mode
2. Flash with `dfu-util -a 0 -s 0x08000000:leave -D firmware.bin`
3. Board reboots with new firmware

No SD card or ST-Link needed for subsequent updates.

## grblHAL build configuration

> ⚠ **THE SNIPPET BELOW IS A 2026-08-20 PRE-REFLASH COPY AND NO LONGER MATCHES THE
> FILE IT NAMES** (found while marking the sections above; re-read at the source
> 2026-08-27). Two differences, and the first contradicts this document's own fifth
> line:
>
> | define | snippet below says | `my_machine.h` today | |
> |---|---|---|---|
> | `PROBE_ENABLE` | `0  // No probe connected` | **`1`** (`:150`, *"Enabled for controller acceptance — G38.2 probing"*) | the whole point of `### Firmware update — 2026-08-20`, and the reason the headline says `PROBE_ENABLE=1` |
> | `DEFAULT_CONTROL_SIGNALS_INVERT_MASK` | `-1` | **`0`** (`:122`, *"No inversion — floating pins with internal pull-ups read HIGH"*) | the inversion strategy changed |
>
> `DEFAULT_LIMIT_SIGNALS_INVERT_MASK` is no longer a single value either — it is
> `0` under `#ifdef BARE_TESTING` and `-1` otherwise (`:123-127`), so **no flat
> snippet can state it correctly**. `BOARD_BTT_SKR_PRO_1_2`, `USB_SERIAL_CDC 1`,
> `ESTOP_ENABLE 0` and `SAFETY_DOOR_ENABLE 0` are unchanged. **A copied config block
> is a value the code owns, restated where nothing checks it** — read
> `grblhal/STM32F4xx/Inc/my_machine.h`, not this snippet. Left in place rather than
> refreshed, because refreshing it would recreate the same defect one day later.

**File:** `grblhal/STM32F4xx/Inc/my_machine.h`

```c
#define BOARD_BTT_SKR_PRO_1_2
#define USB_SERIAL_CDC              1
#define ESTOP_ENABLE                0  // No e-stop connected
#define SAFETY_DOOR_ENABLE          0  // No safety door connected
#define PROBE_ENABLE                0  // No probe connected
#define DEFAULT_CONTROL_SIGNALS_INVERT_MASK -1  // Floating pins read as "not triggered"
#define DEFAULT_LIMIT_SIGNALS_INVERT_MASK   -1  // Floating limit switches read as "not triggered"
```

## Known issues (from before bricking)

- **Alarm state with floating pins:** The SKR Pro v1.2 has no pull-ups/pull-downs on
  the limit switch and control signal inputs. With nothing connected, they float and
  trigger alarm states. The invert masks should fix this, but it was never verified
  because the board was bricked during the DFU flash attempt.
- **No motors connected:** This is a bare controller test — no steppers, no spindle,
  no limit switches. Only USB serial communication is being tested.

## What needed to happen after recovery — ALL SIX DONE, 2026-08-20 (HISTORY)

> ⚠ **MARKED AS HISTORY 2026-08-27, and this was the most misleading of the three
> forward-looking sections** — it is a numbered to-do list, in the present tense,
> under a heading that reads as outstanding work, in a file whose fifth line says
> **Board: ALIVE**. Every step is already recorded above as having happened:
>
> | step | where this file already records it |
> |---|---|
> | 1. boots + enumerates as USB serial | `/dev/ttyACM0` as `STM32 Virtual ComPort` (top of file) |
> | 2. `$I` firmware version | `grblHAL 1.1f (2026-08-17), STM32F407@168MHz, BTT SKR PRO v1.1` |
> | 3. `$X` unlocks | `### Recovery` step 7: *"Board boots to `Idle`, `$X` unlocks"* |
> | 4. `?` shows `Idle`, not `Alarm` | same line — `Idle` |
> | 5. run `tools/controller_probe.py` | `### First controller acceptance transcript`: 50 lines sent, 47 answered |
> | 6. basic G-code accepted | `### Recovery` step 7: *"G-code accepted"* |
>
> ⚠ **Step 5 completing is NOT the same as gate `CTRL` counting it** — see the 🔴 in
> the transcript section: that transcript was written without `--program-command`,
> so `CTRL` refuses it, and `tools/controller_probe.py` now refuses to write a
> transcript without `--program-command` and `--operator` (TODO #126). **The step
> ran; the evidence it produced is not admissible.** A re-run for an admissible
> transcript is the one genuinely outstanding item on this list, and it is a
> *different* item from the six below.
>
> **Direction of the staleness: it rendered finished work as pending**, which is
> the mirror of the defect this lane usually hunts and reads just as convincingly.
> Nothing below is edited.

1. Verify grblHAL boots and enumerates as USB serial
2. Send `$I` to confirm firmware version and capabilities
3. Try `$X` to unlock (should work with inverted signal masks)
4. Send `?` to check status (should be `Idle`, not `Alarm`)
5. Run `tools/controller_probe.py` for full controller acceptance test
6. Test basic G-code: `G91 G1 X10 F1000` (no motors = no movement, but no errors)

## Relevant files

- `grblhal/core/` — grblHAL core source
- `grblhal/STM32F4xx/` — STM32F4 HAL driver + board maps
- `grblhal/STM32F4xx/Inc/my_machine.h` — build configuration
- `grblhal/STM32F4xx/boards/btt_skr_pro_v1_1_map.h` — SKR Pro pin map
- `grblhal/STM32F4xx/platformio.ini` — PlatformIO build environments
- `grblhal/STM32F4xx/STM32F407VGTX_NO_BL_FLASH.ld` — no-bootloader linker script
- `tools/controller_probe.py` — CLI probe for real controllers
- `web/src/RunTab.tsx` — Run tab UI
- `web/src/run/protocol.ts` — grblHAL protocol implementation
