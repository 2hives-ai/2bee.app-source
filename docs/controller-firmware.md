# Controller firmware — grblHAL build for the SKR Pro v1.2

A prepared grblHAL flash for the founder's BTT SKR Pro v1.2 lives **outside this repo** at
`/home/gbacs/apps/grblHAL/build-2bee/` — binary, procedure, recovery images and the exact
Web Builder request that produced it. Read `FLASH-PROCEDURE.md` there.

🔴 **NOT FLASHED. Nothing in this chain has run on a controller** — the air-cut / coupon / ply
rungs remain unclimbed and this does not climb any of them.

The binary is deliberately **not committed**: it is a build artefact of GPLv3 source in an AGPL
tree, the §13 source-offer question with `legal` is unresolved, and a binary with no reproducible
provenance is what this lane refuses elsewhere. `evidence/webbuilder-request.json` is the
provenance; resubmitting it to the grblHAL Web Builder reproduces the configuration.

⚠ **Owner is `pcb`**, not this lane (see `AGENTS.md` lane boundaries) — controller facts come from
there. Two settings in that build are **build-time, not `$$`**: the spindle is PWM+direction (a
Modbus VFD needs a rebuild), and the reset input is Reset, not E-Stop.

## Why this exists

The board on the bench runs **Marlin bugfix-2.0.x configured as a 3-extruder printer**, built for
the **wrong variant** (`BLACK_F407VE` = 100-pin/512 KB on a 144-pin/1 MB part). It answers `$I` and
`$$` with `echo:Unknown command:`. `hardware/bom/tools-bom.md` records
**`CONTROLLER LOCKED (founder 2026-07-14): grblHAL on BTT SKR Pro`** — a **decision** that was
being read as a **description**. See `handover/bom/2026-08-11-2bee_app-the-board-runs-MARLIN-*`.

## What was verified, and how

**Route: the maintainer's Web Builder**, which succeeded first try — so the PlatformIO env that
upstream marks *"Untested and might not boot"* was **never used**. Its catalogue carries
`BTT SKR PRO v1.2 (Bootloader)` as a first-class entry and has **no v1.1 entry at all**.

`242,884 bytes · sha256 4d0815fcca87b4a85ab6a65d6f853d133b8f9e07cd7254e892a06dd614f25a15`, a bare
`.bin` confirmed by magic.

⚠ **Size alone proves nothing here** — 237 KiB is smaller than 512 KiB, so it cannot discriminate
between a correct 1 MB build and a wrong 512 KB one. **The decisive check is where the binary
points:** it carries **two literal references to `0x080E0000`**, the EEPROM-emulation base at the
896 KiB mark — **an address that does not exist on a 512 KiB part.** SP `0x20020000`, reset vector
`0x080375B5` (above the 32 KiB bootloader). The string `BTT SKR PRO v1.2` is **in the binary**;
under the v1.1 define it would read otherwise. Build stamp `20260811` matches the local checkout.

✅ **Vendor-independent confirmation of the bootloader offset, obtained without hardware:** BTT's
own three factory Marlin images were downloaded and their vector tables read — **all three sit
behind a 32 KiB bootloader**, same as ours.

## 🔴 Recovery — read before flashing, not after

**The founder's current Marlin does not exist anywhere on this box.** Searched: no saved
`firmware.bin`, no `FIRMWARE.CUR`, no Marlin tree or config. **That build is unrecoverable
byte-for-byte.**

Two things soften it factually: `Cap:EEPROM:0` means there are **no settings to lose**, and the
current firmware is built for the wrong variant anyway. And **BTT's three factory Marlin images are
downloaded and hash-recorded** in `recovery/` — those restore *a* working Marlin, **not his**
(the 3-extruder config would be gone).

**Structurally, "failed to boot" and "bricked" are different things.** A firmware flash writes at
`0x08008000`+; **the bootloader lives below that and is never a target**, so a bad flash recovers
from the SD card in minutes. 🔴 **A true brick needs SWD — and BOOT0 is grounded, so DFU is
unavailable. We have no ST-Link and that path is not prepared.**

## The flash itself

From **BTT's own SKR Pro V1.2 user manual** (PDF pulled and extracted, not recalled): copy
`firmware.bin` to the SD root, reset, **wait ~10 s**. The manual is explicit that
*"The firmware file name in the SD card cannot be changed, including capitalization."*
⇒ The file is shipped **already named `firmware.bin`** so there is no rename step to get wrong.

⚠ **The rename-after-flash convention is NOT documented in the manual** — treat it as
expected-but-unconfirmed. **The reliable test is `$I`**, which should return
`[BOARD:BTT SKR PRO v1.2]`. The filename is only useful in the negative: **if `firmware.bin` is
still there untouched, the bootloader never ran and nothing was written.**

## What was NOT verified

**The binary could not be tested, because testing a binary requires the hardware, and no hardware
was touched.** Unverified: that it boots at all — **upstream's *"Untested and might not boot"*
stands at full strength** — that the bootloader accepts the file, that USB CDC enumerates, the
`J49` jumper position, any pin behaviour, and byte-for-byte local reproducibility (the server built
it; the matching build stamp is consistency, not reproduction).

⚠ **And `$$` will exist but be WRONG.** Steps/mm, travel limits, homing direction and spindle
configuration are facts about the founder's machine that **nobody has measured**. They must be set
before anything is connected.
