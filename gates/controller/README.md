# Controller transcripts

Evidence that a REAL controller accepted a program this build emits. Produced by
[`tools/controller_probe.py`](../../tools/controller_probe.py), committed here,
read by gate **CTRL**.

```bash
# on the control Pi, with the USB cable to the SKR:
./target/release/2bee-slice job pocket > /tmp/pocket.nc
# 🔴 capture the kernel log alongside — the 2026-08-20 transcript's last 3
# lines got SILENCE (not error:, not alarm), and the live hypothesis is a
# hub-level USB dropout observed on this machine ('usb1-port1: disabled by
# hub (EMI?)'). If the port drops, it is in dmesg; without this capture the
# next silence is undiagnosable a second time.
dmesg -w > /tmp/probe-dmesg.log & DMESG_PID=$!
python3 tools/controller_probe.py /tmp/pocket.nc \
    --port /dev/ttyACM0 --rig bare --unlock --identify-probe \
    --program-command 'job pocket' \
    --operator '<who ran it>' \
    --out gates/controller/acceptance-<board>-<date>.json
kill $DMESG_PID
```

## 🔴 If it exits 3 saying REFUSED, that is the script working

**Opening the port now writes NOTHING** (`ef63920dc5`, 2026-08-11). The three
identification steps — `$I`, `0x87`, `$$` — used to go out before anything had
classified the firmware, which is writing to a board that has not said what it
is. They now sit behind an explicit `--identify-probe`, the same opt-in shape as
`--allow-motion`.

So the command above has **three outcomes, not two**, and the middle one is new:

- **the board speaks when the port opens** (it was reset or power-cycled into a
  banner) — it identifies itself, nothing extra is written, and the run proceeds;
- **the port opens and stays SILENT** — `--identify-probe` authorises the three
  identification writes (`$I`, `0x87`, `$$`). The script sends them and re-reads
  the reply. If the board still says nothing, the script **refuses, exits 3, and
  prints the exact bytes it sent**, so the decision is made with them in view;
- **the board speaks and is not ours** — refused outright. Speech that was not
  recognised is a fact about the firmware; probing it further buys nothing.

If the identification writes are not wanted (e.g. a board that has not been read
about yet), omit `--identify-probe` and reset or power-cycle the controller
instead — it announces itself on boot and needs nothing from us.

⚠ *"Read-only"* is a fact about **grblHAL and nothing else** — `$` prefixes a
parameter **write** on some firmwares, which is exactly why the flag exists on a
board nobody has classified yet. The transcript records `probe_authorised`
either way, so a reader can tell a board that announced itself from one we asked.

## What a transcript here does and does not say

✅ **Says:** every line of that program was ACCEPTED by that controller, that
build, those `$$` settings, on that date.

🔴 **Does not say:** that anything moved, that feeds or depths suit any material,
or that a part exists. `--rig bare` means no motors and no spindle were even
connected. **Acceptance is a parse.** Air cut → foam/MDF coupon → real ply are
still unclimbed, and a green CTRL must never be written up as any of them.

## Why the gate re-emits the program

A transcript is evidence about **one program**. If the build no longer emits
those bytes, the transcript is evidence about something else — so CTRL re-runs
`program_command`, hashes the output, and goes **red on a mismatch** rather than
quietly vouching for code that has since changed. A transcript with no
`program_command` cannot be checked for staleness and is rejected on those
grounds alone.

## A rejection is a finding, not a run failure

`error:20` on a `G83` line means this build has no canned cycles — a fact about
the controller that gate G9 could never have seen, because G9 measures against
grblHAL's published reference. Route it to **pcb** (owner of controller facts)
with the `$I` build string and `$$` dump from the transcript; do not "fix" it by
weakening the post until pcb says which build is the one we ship against.
