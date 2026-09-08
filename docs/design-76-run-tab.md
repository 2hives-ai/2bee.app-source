# Design — TODO #76: the `Run` tab (execute and monitor the machine)

Founder, per `TODO.md` #76: *"1st tab cad, 2nd tab CNC, 3rd tab operation, this is
where I will execute and monitor the CNC router?"*

**This is a design memo and a research note. It changes no code, arms no gate and
marks nothing ✅.** Nothing in `web/src/` was written. Every controller claim below
was read at a primary source — grblHAL's own C, the grbl v1.1 interface documents
grblHAL descends from, the grblHAL wiki, the WICG Web Serial specification — and
each carries its URL and the date it was read (**2026-08-10**, the date this box
reports; several `TODO.md` entries around this one are dated 2026-08-11 and that
discrepancy is not mine to resolve). Where a claim would need a controller or a
browser to confirm, the memo says so and names the check.

Four things were settled before this memo and are **not reopened**: the controller
is grblHAL on a BTT SKR Pro (`hardware/bom/tools-bom.md:134`), the transport is
therefore Web Serial over USB CDC, the tab is called **`Run`**, and **the software
is not an emergency stop and must never be labelled as one.**

⚠ **Every `core/src/post_grblhal.rs` line number below is read at HEAD `cf90d08cb3`
and will drift.** That file moved 72 lines under me while this memo was being
written — other agents are live in `core/` — so each citation also carries the
function name or a quoted line, which is the part that survives. **Re-anchor on the
quote, not on the number.**

---

## 0. Findings against our own post — read these first

The brief says a contradiction between our emitted G-code and the controller
documentation outranks everything else in this report. There is one, and it is not
small. There are five more worth acting on, two of which are in this lane's
existing controller harness rather than in the post.

### 🔴 F1 — the Z probe seeks an ABSOLUTE work coordinate

**The finding, in full: the Z probe seeks to an absolute work coordinate, so the probe depends on the datum it exists to establish.**

`emit_probe` writes the X and Y passes **incrementally** and the Z passes
**absolutely**, and the Z values it writes are computed as *travels*.

Read off the program the post actually emits
(`target/probe-gate/xyz-front-left.nc`, produced by `post_grblhal` itself — the
same function the CLI and the browser call):

```
G17 G21 G90 G54 G94 G40          <- G90 set here and never cancelled except where bracketed
G0 Z5.000
M5
G49
G0 Z5.000
G0 X0.000 Y0.000
( Z from the plate top face )
G38.2 Z-30.000 F200.0            <- G90 IS IN FORCE. absolute target, value = probe_max_mm
G91
G0 Z2.000
G90
G38.2 Z-4.000 F25.0              <- G90 IS IN FORCE. absolute target, value = probe_retract_mm * 2
G10 L20 P1 Z1.600
G0 Z5.000
( X from the plate wall, front-left )
G91
G0 X-43.000
G90
G0 Z-1.400
G91
G38.2 X43.000 F200.0             <- G91. INCREMENTAL. value = wall + radius + probe_max
G0 X-2.000
G38.2 X4.000 F25.0               <- G91. INCREMENTAL. value = probe_retract_mm * 2
G90
G10 L20 P1 X-13.000
```

The source is `core/src/post_grblhal.rs`, `fn emit_probe` (`:583`): the Z block is
`:623-637`, the X/Y closure `axis_pass` is `:673-709`. **The only `G91` in the Z
block brackets the *retract* (`:628-630`), not either probe** — while `axis_pass`
opens with `G91`, keeps both its `G38.2` lines inside it (`:688`, `:694`), and only
returns to `G90` after them.

**grblHAL applies distance mode to probing motion.** Its parser converts axis words
to a target in one place for every motion mode, probes included:

> "At this point, the rest of the explicit axis commands treat the axis values as
> the traditional target position with the coordinate system offsets, G92 offsets,
> absolute override, and distance modes applied. **This includes the motion mode
> commands.**"
> — `grblHAL/core/gcode.c:3046-3050`, <https://github.com/grblHAL/core/blob/master/gcode.c> (read 2026-08-10)

So the post's own block comment is right that *"`G91` APPLIES TO `G38.2`"*
(`post_grblhal.rs:322-327`, the *`G91` APPLIES TO `G38.2`* note) — I re-verified that claim against grblHAL rather than
gnea/grbl and it holds. **The defect is that the Z half does not use it.**

**Why this is a defect and not a design choice.** The two Z values are `probe_max_mm`
and `probe_retract_mm * 2.0` — both *distances*, and both are used as distances by
the X and Y passes three lines later. The post's own refusal text calls them travel:
*"`probe_max_mm` is not positive — a G38.2 whose target is the current position is
rejected by the controller (STATUS_GCODE_INVALID_TARGET)"* (`post_grblhal.rs:741`, in `probe_travel_errors`).
A quantity computed as a travel and emitted as a coordinate is the same defect class
this lane has already recorded four times under *"assert on the emitted program,
never on the setting that was supposed to produce it"* (`AGENTS.md:190`) — except
here the plan and the output disagree about a *frame*, not a value.

**What it costs at the machine.** Write `Zp` for the work-Z at which the tip touches
the plate, and `r` for `probe_retract_mm` (2.0 by default,
`core/src/types.rs:793`, `Machine::default`):

| Pre-existing G54 Z | First seek (`G38.2 Z-30`, from Z=+5) | Slow re-probe (`G38.2 Z-4`, from `Zp+2`) |
|---|---|---|
| roughly right, `Zp ≈ 0` | descends 35 mm, contacts | descends ~6 mm, contacts. **Works.** |
| `Zp = -20` (old zero 20 mm high) | descends 35 mm, contacts at −20 | target −4 is **14 mm ABOVE** the tool → moves **up**, touches nothing → **`ALARM:5`**, datum unset, machine locked |
| `Zp = -45` | target −30 stops **15 mm short** of the plate → **`ALARM:5`** | never reached |
| `Zp + 2 == -4` exactly | contacts | start == target → **`error:33` `Status_GcodeInvalidTarget`**, program halted, datum unset |

`ALARM:5` is `Alarm_ProbeFailContact`, *"Probe fail. Probe did not contact the
workpiece within the programmed travel for G38.2 and G38.4"*
(`grblHAL/core/alarms.c`, id 5 per `alarms.h:35`).

None of these puts a cutter into the table — the failures are alarms and shallow
cuts, not crashes. But **all of them are silent about the real cause**: the operator
sees "probe failed", re-runs it, and gets the same failure until they happen to zero
Z near the plate by hand first — at which point the probe "works", which is exactly
the outcome that stops anyone from finding this.

The condition for the current code to be correct is *"the work-Z datum is already
approximately right"*, and the probe is the thing that makes it right. That is
circular, and it is the reason the whole XY sequence was deliberately written
incrementally: the block comment says so — *"The whole XY sequence below is
therefore INCREMENTAL, which is what lets it run from wherever the operator jogged
without the post knowing a single absolute coordinate"* (`post_grblhal.rs:326`, restated
at `:645-646`).
The Z half needs the same property and does not have it.

**Why no test caught it.** Every assertion in `mod probe_tests` reads the
`G10 L20 P1 <axis>` datum values (`fn datum`, `post_grblhal.rs:1473`, and the tests that use it) or the `G0 X.. Y..` stations. **Nothing asserts what frame a `G38.2` is issued
in.** Gate `PROBE` reads the same dumps. So the check and the defect never met.

**Recommended fix (this lane's, not mine to make):** bracket the Z passes in `G91`
exactly as the XY passes are, and add the assertion that would have caught it — for
every `G38.2` line in a program, the nearest preceding `G90`/`G91` must be `G91`.
That assertion is cheap, reads the emitted text, and is a negative control away from
being a gate. Plant it by removing one `G91` and watch `PROBE` go red.

⚠ **This must be settled before the `Run` tab is pointed at a controller**, because
the tab's first useful rung is exactly the probe: connect, jog, home, probe, air-cut.

### ⚠ F2 — `z_offset_mm` is applied to some Z words in the probe block and not others

In `emit_probe`, `opts.z_offset_mm` is added to `G0 Z<safe_z>`
(`post_grblhal.rs:591`, `let safe_z = machine.safe_z_mm + opts.z_offset_mm`, used at `:637`) and to `G0 Z<side_z_mm>` (`:683`), and **is not added**
to `G38.2 Z-<probe_max>` (`:624`), `G38.2 Z-<retract*2>` (`:632`) or
`G10 L20 P1 Z<top_mm>` (`:636`).

If F1 is fixed and the seeks become incremental, the offset correctly drops out of
them and two thirds of this disappears. **`G10 L20 P1 Z<top_mm>` remains an open
question I could not resolve from the code**: `z_offset_mm` is documented as *"Shifts
every Z word. Used when Z is zeroed on the spoilboard rather than on the stock top"*
(`post_grblhal.rs:18-20`, the `z_offset_mm` field doc), and the probe sets the datum from a plate on the
**workpiece**. Those two statements describe different origins, and the program
contains both. This is a question for the lane, not a finding — I am not asserting a
defect I could not derive.

### ⚠ F3 — every program's first motion is an absolute rapid

**The finding, in full: the first motion of every program is an absolute rapid, and only the `Run` tab can see whether it is safe.**

Every program this post emits opens with `G17 G21 G90 G54 …` then
`G0 Z<safe_z + z_offset>` (`post_grblhal.rs:844-853`). That is a **rapid to an
absolute work coordinate in whatever G54 the controller currently holds**, and G54
persists in the controller's non-volatile storage across power cycles.

If the stored G54 Z is stale — the previous job zeroed on a 50 mm block, this job is
18 mm ply — then `G0 Z5` is a rapid **downward**, at rapid rate, before anything has
been probed. The post cannot see this: it has no access to the machine's offsets, and
`check_machine_limits` (`post_grblhal.rs:205`) bounds program coordinates against
machine travel, which says nothing about where work-zero currently is.

**This is not a post defect. It is a `Run` tab requirement**, and it is the single
strongest argument for the tab existing at all: the tab is the only place in the
chain that knows both the program's first Z and the machine's current `WCO` and
`MPos`. §12 makes "the first move is a descent from where the tool is now" a
**refusal**, not a warning.

### ⚠ F4 — `M0` puts grblHAL into `Hold:0`, which is indistinguishable from an operator feed hold

Our tool-change sequence emits `G0 Z<safe>` → `M5` → comment → **`M0`**
(`MoveKind::ToolChange`, `post_grblhal.rs:1032-1049`). In grblHAL, `M0` is implemented as a feed hold:

```c
// gcode.c:4696-4701
} else if(gc_state.modal.program_flow == ProgramFlow_Paused || … ) {
    …
    system_set_exec_state_flag(EXEC_FEED_HOLD); // Use feed hold for program pause.
```

So the status report reads `<Hold:0|…>` and the program resumes **only** on a cycle
start (`~` / `0x81`). Two consequences for the tab:

1. `Hold:0` means "held" and nothing more. It does **not** say whether the operator
   pressed Hold or the program reached an `M0`. The tab must derive that from the
   line it last sent, not from the state word. Rendering a program pause as
   "operator hold" would let someone press Resume without changing the tool.
2. Our `M0` is preceded by `M5`, so the spindle is off across the pause. Good — and
   worth stating, because **a plain feed hold does not stop the spindle.** Only the
   parking/door path calls `spindle_all_off` (`grblHAL/core/state_machine.c:116`); a `!` leaves a
   2.2 kW cutter turning in the work.

We emit `M0`, **not `M6`**, so grblHAL's `$341` tool-change modes and the `0xA3`
tool-change-acknowledge protocol are **not on our path** (§9). That is a simpler
world and the tab should not implement the `Tool` state handshake as if it were.

### ⚠ F5 — `G4` drains the planner, and we emit one after every `M3`

`mc_dwell` calls `protocol_buffer_synchronize()` before delaying
(`grblHAL/core/motion_control.c:839-845`). Our post emits `G4 P<spinup>` after every
`M3` (`post_grblhal.rs:1022-1023`), for a documented and correct physical reason.

⇒ **The planner buffer legitimately empties at every spindle start.** A
buffer-starvation detector that alarms on "planner blocks free == max while
streaming" will false-fire there, and a control that false-fires gets muted
(`AGENTS.md`, and the `--plant` doctrine). §17 keys starvation on *the streamer
failing to write*, not on the controller's buffer being empty.

### 🔴 F6 — `tools/controller_probe.py --unlock` is wrong about what `$X` does on grblHAL

Its help text: *"send `$X` first (grblHAL boots into ALARM when homing is required
and no home has been done)"* (`tools/controller_probe.py`, the `--unlock` argparse help), and it sends `$X`
without reading the reply (`ctl.send("$X")`, `:699` — the return value is discarded).
⚠ **Still open after `5dc1b077f0`'s sibling fix landed in that file on 2026-08-11** — the
handshake was reordered, `--unlock` was not touched. Re-measured, not assumed.

On grblHAL, **`$X` is refused while homing is required.** `disable_lock` calls
`check_status(false)`, which returns `Status_HomingRequired` when
`limits_homing_required()` holds, and the unlock branch is never taken:

```c
// system.c:446-460
FLASHMEM static status_code_t disable_lock (sys_state_t state, char *args)
{
    if(state & (STATE_ALARM|STATE_ESTOP)) {
        if((retval = check_status(false)) == Status_OK) {
            state_set(STATE_IDLE);
            …
// system.c:439-441
        else if(limits_homing_required())
            status = Status_HomingRequired;
```

`Status_HomingRequired` is **46** (`errors.h:79`), text *"Home machine to
continue."* (`errors.c:76`). The grblHAL wiki says the same thing in prose:
*"If homing is enabled and set as required on startup it is no longer possible to
continue after a reset if homing fails. grblHAL will reissue the homing required
message until homing is successful."*
(<https://github.com/grblHAL/core/wiki/Changes-from-grbl-1.1>, read 2026-08-10)

⇒ On a machine configured the way a router should be configured, `--unlock` does
nothing, the board stays in `Alarm`, and every G-code line that follows is refused
with `error:9` (`Status_SystemGClock`, *"G-code commands are locked out during alarm
or jog state"*, `protocol.c:255-263`). **A transcript from that run would show 100%
rejection and read exactly like a total dialect failure.** The `Run` tab must not
inherit this belief, and the harness should be corrected: read `$X`'s reply, and on
`error:46` refuse to proceed with the reason *"this machine requires homing; run
`$H`"*.

### 🔴 F7 — `controller_probe.py` continues past the first rejection

**The finding, in full: `controller_probe.py` deliberately continues past the first rejection, and grblHAL poisons everything after it.**

```python
# tools/controller_probe.py:707-710 (still present after the 2026-08-11 handshake fix)
            if v != "ok":
                errors.append(r)
                # Keep going. Stopping at the first rejection would report one
                # unsupported word and hide the other four.
```

The stated reason is sound for grbl 1.1 and **false for grblHAL**:

> "**Error handling** — When a GCode results in an error this will persist for all
> subsequent GCodes processed until a reset, an empty line or system command
> (`$` command) is issued. This change is for reducing the risk of dangerous moves
> following the error."
> — <https://github.com/grblHAL/core/wiki/Changes-from-grbl-1.1> (read 2026-08-10)

Confirmed at the source: the g-code branch is guarded on the *previous* line's
result, so a poisoned line is never parsed at all —

```c
// protocol.c:265-272
#if COMPATIBILITY_LEVEL == 0
                else if(gc_state.last_error == Status_OK || gc_state.last_error == Status_GcodeToolChangePending) {
#else
                else {
#endif
                    if((gc_state.last_error = gc_execute_block(line)) != Status_OK)
                        eol = '\0';
                }
                …
                    grbl.report.status_message(gc_state.last_error);   // :286
```

Every line still gets exactly one reply (so character counting does not deadlock —
see §2), but after the first `error:N` the reply is **the same `error:N` repeated**,
about a line the parser never looked at.

⇒ **The `errors` list in a CTRL transcript is not a list of unsupported words.** It
is one real finding followed by N copies of it. A transcript showing five errors
would be written up as five dialect defects. The evidence class gate `CTRL` rests on
is corrupted in exactly the direction that manufactures work.

Two fixes, and they are different decisions: stop at the first error and report one
honest finding (safe, loses breadth), or send an **empty line** between blocks to
clear `last_error` and keep going (regains breadth — but note the same wiki sentence
says an empty line clears the error, so **a sender that "syncs" with a blank line
silently un-poisons a stream and resumes executing motion after a rejected block**,
which is precisely the dangerous move grblHAL added the behaviour to prevent). For
the `Run` tab, §12 takes the first option: **the first `error:` aborts the job.**

### ✅ What verified clean

Checked against grblHAL rather than assumed, and correct as emitted:

| Post claim / emission | Verified at | Verdict |
|---|---|---|
| `G41`/`G42` absent; offsets must be host-side; `G40` accepted only so a program header does not error | `gcode.c:2777-2780` — *"G41/42 NOT SUPPORTED … grblHAL supports G40 only for the purpose to not error when G40 is sent with a g-code program header"* | ✅ exactly as the preamble comment says |
| `G38.2`, never `G38.3` | `alarms.c` / `alarms.h:35` — `Alarm_ProbeFailContact = 5` | ✅ |
| `G10 L20 P1 <axes>` sets the named coordinate system from the current position | `gcode.c:2949-2954` — `WCS = MPos - G92 - TLO - WPos`; `P` is 0..9 (`:2875`) | ✅ and `P1` = G54 explicitly, as intended |
| `G91` applies to `G38.2` | `gcode.c:3046-3050` | ✅ the claim holds — see F1 for where it is not used |
| Zero-length probe is `error:33`, no axis word is `error:26` | `errors.h:66, :59` | ✅ |
| `G49` before probing cancels any tool length offset | `gcode.c:2782` — *"G43.1 and G49 are always supported"* | ✅ |
| `G4 P<n>` takes **seconds** | `motion_control.c:839` `void mc_dwell (float seconds)` | ✅ |
| `G81/G82/G83/G98` canned cycles parse | `gcode.c:1559` `case 73: case 81: case 82: case 83: …` — no compile guard in current master | ✅ ⚠ note below |
| One-line preamble `G17 G21 G90 G54 G94 G40` | six different modal groups (2, 6, 3, 12, 5, 7) | ✅ no `error:21` modal-group violation |
| `%` stripped from comments (`fn sanitize`, `:142`) | `CMD_PROGRAM_DEMARCATION '%'`, `grbl.h:110` | ✅ and load-bearing: a bare `%` toggles file demarcation |
| Max line length | `LINE_BUFFER_SIZE 257` = 256 chars + terminator (`protocol.h:36`) | ✅ our longest lines are far under; note grbl classic is 80 |

⚠ **One note to route to `pcb`, not a finding:** gate `CTRL`'s stated premise is
*"a build without canned cycles answers `error:20` to the `G83` this post emits"*.
In grblHAL master today the canned cycles are parsed unconditionally. Whether the
build we ship against differs (older build, `COMPATIBILITY_LEVEL`, driver options)
is a controller fact and belongs to `pcb`. Do not weaken `G9` or `CTRL` on the
strength of this line — it is one reading of one tree on one day.

---

## Part 1 — the research

## 1. The transport

**Web Serial, and there is no alternative.** The SKR Pro is an STM32F407: no
ethernet PHY, no radio. grblHAL's STM32F4xx driver carries the board maps
`BOARD_BTT_SKR_PRO_1_1` and `BOARD_BTT_SKR_PRO_1_2`
(<https://raw.githubusercontent.com/grblHAL/STM32F4xx/master/Inc/my_machine.h>,
lines 29-30, read 2026-08-10) and streams over USB CDC
(`Src/usb_serial.c`). So the browser's only route is `navigator.serial`.

From the specification (<https://wicg.github.io/serial/>, read 2026-08-10) and MDN
(<https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API>, read 2026-08-10):

- **Secure context required.** Both `Navigator.serial` and `WorkerNavigator.serial`
  are `[SecureContext]`. HTTPS or `localhost`.
- **Permissions policy** feature name `"serial"`, default allowlist `'self'` — a
  cross-origin iframe cannot open a port unless the embedder grants it.
- **`requestPort()` requires transient activation**: *"If the relevant global object
  of this does not have transient activation, reject promise with a
  `SecurityError`."* One click, every session, until the port is remembered.
- **`getPorts()`** returns already-permitted ports with no gesture — which is how a
  reconnect avoids a second click.
- **`forget()`** revokes the grant and moves the port to state `"forgotten"`.
- **`open(options)`**: `baudRate` (required), `dataBits`, `stopBits`, `parity`,
  `bufferSize` (**default 255**), `flowControl`. For USB CDC the baud rate is
  nominal — the STM32 CDC class ignores it — but it must still be supplied.
- **Exposed in dedicated workers.** `Serial` is `[Exposed=(DedicatedWorker,Window)]`
  and `WorkerNavigator` carries the attribute. This matters — see §17.
- **Disconnection:** on physical removal the readable stream errors with a
  `NetworkError` `DOMException` and `[[readFatal]]` is set; the writable side
  rejects with `NetworkError`, `[[writeFatal]]` is set, and it closes. `Serial` fires
  a `disconnect` event and the port's `[[connected]]` flag goes false.

**Browser reach.** caniuse (<https://caniuse.com/web-serial>, read 2026-08-10) lists
Chrome/Edge from 89 and Opera from 76; **Safari and iOS Safari unsupported at every
version**, with WebKit's standards position recorded as *opposed*
(<https://github.com/WebKit/standards-positions/issues/199>). Mozilla's position is
recorded as *neutral*
(<https://github.com/mozilla/standards-positions/issues/336>) and caniuse now shows
recent Firefox rows, but the reported Firefox rollout is Nightly-only behind an
add-on gate. ⚠ **I did not confirm the Firefox rows in a browser and they contradict
each other**, so the design does not depend on Firefox.

⇒ **Feature-detect, never version-detect.** The only honest gate is
`'serial' in navigator`. A UA sniff would both wrongly exclude a browser that ships
it tomorrow and wrongly admit one that lists it and gates it behind a flag. When the
check fails, the tab renders **why** — "this browser does not implement the Web
Serial API; the Run tab needs Chrome or Edge on a desktop" — and does not render a
Connect button that cannot work.

**`.app` is HSTS-preloaded at the TLD.** If this is ever served from `2bee.app`, a
valid certificate is a precondition of the first request, not a follow-up, and the
secure-context requirement is satisfied for free. Served from anywhere else, check it.

## 2. Streaming: which protocol, and the buffer size is not 128

### The two protocols

Both are documented by grbl and both are implemented in its reference streamer
(<https://raw.githubusercontent.com/gnea/grbl/master/doc/script/stream.py>, read
2026-08-10):

- **Simple send-response.** Send one line, wait for `ok` or `error:N`, send the next.
  Correct, trivially safe, and **guarantees the planner is starved**: the controller
  can hold at most one un-acknowledged block, so between every pair of moves there is
  a full serial round trip. On a job of short segments the machine decelerates to a
  stop at the end of every move.
- **Character counting.** Track the number of characters the controller has in its RX
  buffer: add `len(line)+1` on send, subtract the oldest entry on every `ok`/`error`,
  and only send while `sum < RX_BUFFER_SIZE`. This keeps the RX buffer and therefore
  the planner full, which is what lets grblHAL look ahead and blend corners.

`stream.py` implements exactly this, with `RX_BUFFER_SIZE = 128` (line 55) and the
send gate at line 164.

### The number is wrong for grblHAL

**grblHAL's default RX buffer is 1024 bytes, not 128:**

```c
// grblHAL/core/stream.h:51-60
#ifndef RX_BUFFER_SIZE
#define RX_BUFFER_SIZE 1024 // must be a power of 2
#endif
#ifndef TX_BUFFER_SIZE
#define TX_BUFFER_SIZE 512  // must be a power of 2
#endif
```

<https://github.com/grblHAL/core/blob/master/stream.h> (read 2026-08-10). The
STM32F4xx USB CDC stream computes its free space from the same constant
(`Src/usb_serial.c:50-55`, `usbRxFree`), so on our board it is that buffer we are
counting against — **unless a driver or board map overrides the define**, which is
exactly the kind of thing that is true until it isn't.

The planner is deeper too: `DEFAULT_PLANNER_BUFFER_BLOCKS 100` (`config.h:893`),
runtime-settable as `$398` (`settings.h:273`, range 30–1000), against classic grbl's
16.

### ⇒ Do not hard-code either number. Measure them at connect.

grblHAL reports both in the status report when `$10` bit 1 is set:

```
|Bf:<block buffers free>,<RX characters free>
```

— `report.c:1289-1294`, and the wiki's own grammar
(<https://github.com/grblHAL/core/wiki/Report-extensions>, read 2026-08-10).

So the connect handshake asks the machine rather than a table: while `Idle` with
nothing sent, request a full report and read `Bf` — the second number **is** the RX
buffer size and the first **is** the planner depth, for this build, on this board,
today. Store them. If `Bf` is absent (bit 1 of `$10` clear), that is not a reason to
guess: it is a reason to **set** `$10` or to refuse the character-counting path and
fall back to send-response with the reason on screen. *A streamer counting against a
number nobody measured is the same defect as a feed nobody derived.*

### Which one a real job needs

Our programs are exactly the case character counting exists for. A profile with arcs
degraded to chords, a pocket, or a nested sheet is thousands of short blocks; gate
`G10` (`BLOCK RATE`) already exists in this lane because *"segments shorter than the
planner can consume stall the feed"*. Send-response makes that stall unconditional.

⚠ **And the physical consequence is the one the brief names.** A streamer that stalls
mid-cut does not pause the job — it leaves a turning cutter stationary in the
material. It burns the edge, work-hardens nothing useful, and on a small cutter it
snaps. **This is why the transport choice is a safety property and not a performance
one.**

⇒ **Character counting, against a measured buffer size, with send-response available
as a declared fallback** that says on screen that it is in use and why.

### The reply grammar, exactly

Per line, the controller emits exactly one of `ok` or `error:N`
(`protocol.c:286`, `grbl.report.status_message(gc_state.last_error)`), and **that is
true even for poisoned lines** (F7) — so character counting cannot deadlock on an
error. Interleaved and unsolicited, it may also emit `<…>` status reports, `[…]`
messages (`[MSG:…]`, `[GC:…]`, `[PRB:…]`, `[VER:…]`, `[OPT:…]`), and `ALARM:N`.

🔴 **`ALARM:N` is not a line reply.** It arrives asynchronously and does not
decrement the character count. A streamer that treats the first line back as the
answer will score a status report as an acceptance —
`tools/controller_probe.py:370-377` (`Controller.send`) already documents this trap
and handles it; the tab must do the same.

## 3. The realtime commands, byte for byte

Realtime commands are picked out of the byte stream before the line parser and are
**not** line-buffered. From `grblHAL/core/grbl.h:103-156`
(<https://github.com/grblHAL/core/blob/master/grbl.h>, read 2026-08-10):

| Byte | Name | Safe when? | What it does |
|---|---|---|---|
| `0x18` ctrl-X | `CMD_RESET` | **any time — but it costs position** | §10 |
| `?` (0x3F) / `0x80` | `CMD_STATUS_REPORT` | any time | Queues one report. **Ignored while auto-reporting is on** (`protocol.c:872-874`) |
| `0x87` | `CMD_STATUS_REPORT_ALL` | any time | Report **with every element**, including the change-only ones |
| `~` (0x7E) / `0x81` | `CMD_CYCLE_START` | any time; only means something in `Hold`/`Door`/`Tool` | Resume |
| `!` (0x21) / `0x82` | `CMD_FEED_HOLD` | any time | Controlled decel to `Hold`. **Does not stop the spindle** |
| `0x83` | `CMD_GCODE_REPORT` | any time | Same as `$G` |
| `0x84` | `CMD_SAFETY_DOOR` | any time | Forces the door state — **not a stop button** |
| `0x85` | `CMD_JOG_CANCEL` | 🔴 **only when jogging** | Cancels the jog **and flushes the RX buffer** |
| `0x88` / `0x89` | optional-stop / single-block toggle | any time | |
| `0x8C` | `CMD_AUTO_REPORTING_TOGGLE` | any time | Toggles auto reports; only acts if `$481 != 0` (`protocol.c:936-939`) |
| `0x90` | feed override → 100% | any time | |
| `0x91` / `0x92` | feed ±10% | any time | `FEED_OVERRIDE_COARSE_INCREMENT 10` |
| `0x93` / `0x94` | feed ±1% | any time | `FEED_OVERRIDE_FINE_INCREMENT 1` |
| `0x95` | rapid → 100% | any time | |
| `0x96` / `0x97` | rapid → 50% / 25% | any time | `RAPID_OVERRIDE_MEDIUM 50`, `RAPID_OVERRIDE_LOW 25` |
| **`0x98`** | — | — | 🔴 **NOT SUPPORTED.** Commented out in grblHAL: `// #define CMD_OVERRIDE_RAPID_EXTRA_LOW 0x98 // *NOT SUPPORTED*` |
| `0x99` | spindle override → 100% | any time | |
| `0x9A` / `0x9B` | spindle ±10% | any time | |
| `0x9C` / `0x9D` | spindle ±1% | any time | |
| `0x9E` | `CMD_OVERRIDE_SPINDLE_STOP` | 🔴 **`Hold` only** | `protocol.c:726-727`: *"Spindle stop override allowed only while in HOLD state."* |
| `0xA0` / `0xA1` | flood / mist coolant toggle | any time | |
| `0xA3` | `CMD_TOOL_ACK` | `Tool` state only | §9 — **not on our path** |

Override limits (`grbl.h:189-212`): feed 10–200%, rapid 25/50/100% only, spindle
10–200%.

🔴 **The brief's range `0x90`–`0x9A` is short at both ends.** `0x98` inside it does
nothing, and the spindle set runs to `0x9E`. Implement from the table, not from the
range.

🔴 **Encoding hazard, and it is the easiest way to get this silently wrong.** Every
grblHAL realtime command above `0x7F` lives in 0x80–0xBF (the header says so
explicitly: *"All realtime commands must be in the extended ASCII character set,
starting at character value 128 (0x80) and up to 191 (0xBF)"*, `grbl.h:112-114`).
**A `TextEncoder` will encode `0x90` as UTF-8 — two bytes, `0xC2 0x90`** — and the
controller receives a byte it does not recognise followed by one it does. Every
realtime write must go out as a `Uint8Array` of the literal byte. This is worth a
one-line unit test with a real negative control, because the failure looks like "the
override button doesn't work sometimes".

⚠ **`0x85` jog-cancel flushes the input buffer.** `protocol.c:894-897`:
`char_counter = 0; … hal.stream.cancel_read_buffer();`. If a job were streaming, that
would discard queued G-code **and** desynchronise the sender's character count from
the controller's buffer. ⇒ jog-cancel is refused unless the machine is in `Jog`
(§12).

## 4. The status report

The grammar, from grblHAL's own wiki
(<https://github.com/grblHAL/core/wiki/Report-extensions>, read 2026-08-10) and
cross-checked against `report.c:1204-1545`:

```
<state{:substate}|<MPos:|WPos:>x,y,z{|Bf:blocks,rxfree}{|Ln:n}{|FS:feed,rpm{,actual}}
 {|Pn:signals}{|WCO:x,y,z}{|WCS:Gn}{|Ov:feed,rapid,spindle}{|A:accessories}
 {|MPG:0|1}{|H:0|1{,mask}}{|D:0|1}{|Sc:axes}{|TLR:0|1}{|FW:grblHAL}{|In:n}{|SD:…}>
```

### States, and which of them mean the machine may move again on its own

| State | Reported as | Will it move again unprompted? |
|---|---|---|
| `Idle` | `Idle` | No |
| `Run` | `Run`, or `Run:1` (feed hold pending) / `Run:2` (probing) with `$10` bit 11 | **YES — it is moving now** |
| `Hold` | `Hold:0` complete, `Hold:1` decelerating (`report.c:1228`) | **`Hold:1` YES — still decelerating.** `Hold:0` no, until `~` |
| `Jog` | `Jog` | **YES — a queued jog is still running** |
| `Alarm` | `Alarm`, or `Alarm:N` with `$10` bit 10, **always** with `Alarm:N` when requested via `0x87` | No |
| `Door` | `Door:0`…`Door:3` (parking state) | **YES — `Door:2`/`Door:3` are retract/restore motions** |
| `Check` | `Check` | No — nothing moves in check mode |
| `Home` | `Home` | **YES — the homing cycle is running** |
| `Sleep` | `Sleep` | No — but the steppers are disabled, so **position is not guaranteed** |
| `Tool` | `Tool` | Waiting for `0xA3`; **not on our path** (F4) |

🔴 **`Idle` does not mean "the program finished".** It means the planner is empty. A
streamer that has stopped feeding produces `Idle` in the middle of a job, and that is
the starvation case, not the completion case. **Completion is proved by the sender's
own accounting — every line sent and every reply received — never by the state word.**

### What `$10` does, and why a UI that assumes one value misreads the other

`$10` is the status report mask. **In grbl v1.1 it has two bits; in grblHAL it has
fourteen** (`settings.h:634-653`):

| Bit | Value | Field | grbl 1.1 | grblHAL default |
|---|---|---|---|---|
| 0 | 1 | position type: **set = `MPos:`**, clear = `WPos:` | ✔ | On |
| 1 | 2 | `Bf:` buffer state | ✔ | On |
| 2 | 4 | `Ln:` line numbers | — | On |
| 3 | 8 | `FS:` feed and speed | — | On |
| 4 | 16 | `Pn:` input pin state | — | On |
| 5 | 32 | `WCO:` work coordinate offset | — | On |
| 6 | 64 | `Ov:` overrides | — | On |
| 7 | 128 | probe coordinates (`[PRB:…]`) | — | On |
| 8 | 256 | sync on WCO change | — | On |
| 9 | 512 | `$G` parser state in the report | — | Off |
| 10 | 1024 | `Alarm:<code>` substate | — | Off |
| 11 | 2048 | `Run:<1\|2>` substate | — | Off |
| 12 | 4096 | report while homing | — | Off |
| 13 | 8192 | `DTG:` distance to go | — | Off |

⇒ **grbl v1.1 ships `$10=1`** (its own settings dump,
<https://raw.githubusercontent.com/gnea/grbl/master/doc/markdown/settings.md>, line
39) — machine position, no buffer, no feed, no overrides. **grblHAL's compiled
defaults set bits 0–8, i.e. `$10=511`** (`settings.c:165-178` against
`config.h:600-750`).

🔴 **This is the concrete "a UI that assumes one `$10` misreads the other".** Under
`$10=1` there is no `Bf:` (so character counting cannot be calibrated and buffer
occupancy cannot be shown), no `FS:` (so the feed/speed readout is blank), no `Ov:`
(so the override buttons have no readback and the UI would be asserting an override
it cannot see), and no `WCO:` — with bit 0 set, positions are `MPos` and **the DRO
would silently show machine coordinates labelled as work coordinates**. Under
`$10=511` all of it arrives and positions are still `MPos`. Under a hand-edited
`$10=510` positions arrive as `WPos` and `WCO` is still sent, and a UI that subtracts
`WCO` from `WPos` would double-count the offset.

⇒ **The tab reads `$10` at connect, keys every reader on the field that actually
arrived, and names the missing capability rather than rendering a blank.** "Buffer:
not reported (`$10` bit 1 clear)" is a true statement; an empty box is not.

⚠ Note also `$10` bits 10 and 11 are documented in grblHAL's own config as *"Enabling
this option may break senders"* (`config.h:712, 725`). Our parser must accept both
`Alarm` and `Alarm:5`, both `Run` and `Run:2` — that is one regex, and writing it
defensively costs nothing.

### The change-only elements, and why `0x87` exists

`WCO`, `Ov`, `WCS`, `H`, `D`, `Sc`, `TLR`, `In` and `MPG` are **sent on change and on
a refresh counter, not every report.** The counters (`config.h:233-244`):
`REPORT_WCO_REFRESH_BUSY_COUNT 30`, `..._IDLE_COUNT 10`,
`REPORT_OVERRIDE_REFRESH_BUSY_COUNT 20`, `..._IDLE_COUNT 10`.

> "Since some of the elements are only sent on changes an additional real time
> request character, `0x87`, has been added for getting the complete status."
> — Report-extensions wiki

⇒ **A tab that connects mid-job and only ever sends `?` may wait 30 reports for a
`WCO`, and may never see `Ov` or `H` at all if nothing changes.** The connect
handshake sends `0x87`. So does any resync after a reconnect. And until a `WCO` has
arrived, the DRO says so (§5).

### Auto-reporting — `$481`

`Setting_AutoReportInterval = 481` (`settings.h:312`), *"Autoreport interval"*, ms,
range 100–1000, 0 = off, **reboot required** (`settings.c:2426`). With it non-zero
the controller pushes reports on its own timer, and `?` becomes a no-op
(`protocol.c:872-874`). `0x8C` toggles it at runtime.

⇒ This is a genuine mitigation for a throttled tab's *polling* (§17), and it is
**not** a mitigation for a throttled tab's *writing*. It also means the tab's
link-alive watchdog must be "a report arrived within N ms", never "my `?` was
answered" — under auto-reporting nothing answers a `?` in particular.

## 5. `MPos`, `WPos` and `WCO` — the classic wrong DRO

One equation, per axis, and grbl states it directly
(<https://raw.githubusercontent.com/gnea/grbl/master/doc/markdown/interface.md>,
read 2026-08-10):

```
WPos = MPos - WCO
```

grblHAL computes it the same way and applies the tool length offset into the same
term (`report.c:1274-1280`: for a `WPos` report it subtracts `gc_get_offset(idx,
true)` per axis; `gcode.c:2951` spells the full relation as
`WPos = MPos - WCS - G92 - TLO`).

**A report contains `MPos` or `WPos`, never both** — bit 0 of `$10` selects which
(`report.c:1285`). `WCO` is the sum of the active work coordinate system offset, the
`G92` offset and the tool length offset.

The three ways this goes wrong, and all three are silent:

1. **`WCO` has not arrived yet.** It is a change-only element (§4). On a fresh
   connection under `$10` bit 0 set, the first reports carry `MPos` and no `WCO`.
   Computing `WPos` with `WCO = 0` displays machine coordinates in a box labelled
   "work" — and on a homed router those differ by the entire table.
   ⇒ **Until a `WCO` has been received, the work DRO renders `—` and a note saying
   the offset has not been reported yet.** Never a zero. A zero is a number and reads
   as a measurement.
2. **`WCO` goes stale.** It is refreshed every 10–30 reports, and *immediately* when
   it changes — but only if `$10` bit 5 is set. If bit 5 is clear, `WCO` never
   arrives at all and the work DRO is **permanently underivable**; say so rather
   than deriving it from a stale copy.
3. **Double-subtraction.** If the controller is sending `WPos` (bit 0 clear) the
   offset is *already applied*, and subtracting `WCO` again displaces the DRO by the
   whole offset. ⇒ the parser must branch on which key arrived, and the branch must
   be exercised in both directions by a test — this is precisely the shape of defect
   that a fixture built for one `$10` value cannot see.

⇒ **Show both.** Machine and work, side by side, each labelled, with the active
coordinate system (`WCS:G54`, when reported) next to the work column and the `WCO`
itself visible. An operator debugging a wrong datum needs the offset, not just its
consequence. And `TLR:0|1` (tool length reference set) next to it, because a Z that
is wrong by a tool length looks exactly like a Z that is wrong by a plate thickness.

## 6. Alarms, errors, and what `$X` really does

### The alarm list, verbatim from the controller

`grblHAL/core/alarms.c` with ids from `alarms.h:29-53` (read 2026-08-10):

| # | Identifier | grblHAL's own text |
|---|---|---|
| 1 | `Alarm_HardLimit` | Hard limit has been triggered. **Machine position is likely lost due to sudden halt. Re-homing is highly recommended.** |
| 2 | `Alarm_SoftLimit` | Soft limit alarm. G-code motion target exceeds machine travel. **Machine position retained. Alarm may be safely unlocked.** |
| 3 | `Alarm_AbortCycle` | Reset/E-stop while in motion. **Machine position is likely lost due to sudden halt. Re-homing is highly recommended.** |
| 4 | `Alarm_ProbeFailInitial` | Probe fail. Probe is not in the expected initial state before starting probe cycle… |
| 5 | `Alarm_ProbeFailContact` | Probe fail. Probe did not contact the workpiece within the programmed travel for G38.2 and G38.4. |
| 6 | `Alarm_HomingFailReset` | Homing fail. The active homing cycle was reset. |
| 7 | `Alarm_HomingFailDoor` | Homing fail. Safety door was opened during homing cycle. |
| 8 | `Alarm_FailPulloff` | Homing fail. Pull off travel failed to clear limit switch… |
| 9 | `Alarm_HomingFailApproach` | Homing fail. Could not find limit switch within search distances… |
| 10 | `Alarm_EStop` | EStop asserted. Clear and reset |
| 11 | `Alarm_HomingRequired` | Homing required. Execute homing command ($H) to continue. |
| 12 | `Alarm_LimitsEngaged` | Limit switch engaged. Clear before continuing. |
| 13 | `Alarm_ProbeProtect` | Probe protection triggered. Clear before continuing. |
| 14 | `Alarm_Spindle` | Spindle at speed timeout. Clear before continuing. |
| 15 | `Alarm_HomingFailAutoSquaringApproach` | Homing fail. Could not find second limit switch for auto squared axis… |
| 16 | `Alarm_SelftestFailed` | Power on selftest (POS) failed. |
| 17 | `Alarm_MotorFault` | Motor fault. |
| 18 | `Alarm_HomingFail` | Homing fail. Bad configuration. |
| 19 | `Alarm_ModbusException` | Modbus exception. Timeout or message error. |
| 20 | `Alarm_ExpanderException` | I/O expander communication failed. |
| 21 | `Alarm_NVS_Failed` | Non Volatile Storage (EEPROM) failure. |

🔴 **Alarms 10 through 21 do not exist in grbl v1.1** — a UI built from grbl's
9-entry table renders "unknown alarm 17" for a motor fault. Ship grblHAL's table,
sourced from `alarms.c`, and render an unrecognised code as
*"alarm N — this build reports an alarm this UI does not know; run `$EA` for the
controller's own list"* rather than swallowing it.

### The error list

`errors.c` / `errors.h:31-91` carries **74+ codes** against grbl v1.1's 34, and the
overlap is not total — grblHAL adds 45–75 (`Status_LimitsEngaged 45`,
`Status_HomingRequired 46`, `Status_EStop 50`, `Status_MotorFault 51`,
`Status_GCodeCoordSystemLocked 56`, `Status_UnexpectedDemarcation 57`,
`Status_AuthenticationRequired`, the expression/flow-control family, …). The ones a
`Run` tab will actually meet:

| # | Meaning | Why the tab meets it |
|---|---|---|
| 1, 2, 3 | bad word / bad number / unknown `$` | typed console input |
| 8 | `Status_IdleError` — *"'$' command cannot be used unless controller state is IDLE"* | a `$` sent mid-job |
| 9 | `Status_SystemGClock` — *"G-code commands are locked out during alarm or jog state"* | **streaming into an `Alarm`** — see F6 |
| 11 | `Status_Overflow` — line > 256 chars | never, for us |
| 15 | `Status_TravelExceeded` — *"Jog target exceeds machine travel. Jog command has been ignored."* | jogging past a soft limit — **an error, not an alarm** |
| 16 | `Status_InvalidJogCommand` | a malformed `$J=` |
| 20 | `Status_GcodeUnsupportedCommand` | the canned-cycle case gate `CTRL` exists for |
| 33 | `Status_GcodeInvalidTarget` | a zero-length probe — see F1 |
| 40 | `Status_GcodeToolChangePending` | motion while a tool change is pending |
| 46 | `Status_HomingRequired` — *"Home machine to continue."* | `$X` on a machine that must home — **F6** |

⇒ The tab ships both tables **as data extracted from the controller's own source**,
and renders code + the controller's own sentence + what the operator can do. Not a
paraphrase: grblHAL's sentences are already the right length and already say the
dangerous part.

### What `$X` really does

grbl's own documentation, on `$X`:

> "**The position has likely been lost**, and Grbl may not be where you think it is."
> — <https://raw.githubusercontent.com/gnea/grbl/master/doc/markdown/commands.md> (read 2026-08-10)

grblHAL's implementation (`system.c:446-461`) clears the lock, sets `STATE_IDLE`,
emits `Message_AlarmUnlock`, and — deliberately — **does not run the startup script**
(*"Don't run startup script. Prevents stored moves in startup from causing
accidents."*). It **restores nothing**: no position, no homing, no offsets.

And it **refuses** in four situations, via `check_status(false)`
(`system.c:413-443`): a failed power-on self test, an asserted e-stop, an ajar safety
door, an asserted reset signal, engaged limit switches at init, or **homing required**
(F6, `error:46`).

⇒ 🔴 **The brief's warning is exactly right and the design must carry it in the UI,
not only in this document.** A button labelled "Clear alarm" offers to resume a
machine whose position may be unknown. So:

- The control is labelled **`Unlock ($X)`**, never "clear" or "reset" or "fix".
- The confirmation names the alarm's own consequence sentence. For alarm 1 or 3 that
  sentence *is* "Machine position is likely lost due to sudden halt. Re-homing is
  highly recommended" — quote it.
- **After `$X` following alarm 1, 3, 6, or any alarm while `$22` homing is enabled,
  the tab marks position as UNTRUSTED and refuses to start a job until `$H` has
  completed.** `$X` is permission to jog and to home. It is not permission to cut.
- After alarm 2 (soft limit) the controller itself says *"Machine position retained.
  Alarm may be safely unlocked"* — so that one alarm, and only that one, may return
  to a trusted state without re-homing. **Encode the distinction from the alarm code,
  not from a habit.**

## 7. Homing, `$H`, soft limits, hard limits

### The settings

`$22` in grblHAL is not a boolean; it is a bitfield
(`settings.h:693-709`): bit 0 `enabled`, 1 `single_axis_commands`, 2 `init_lock`,
3 `force_set_origin`, 4 `two_switches`, 5 `manual`, 6 `override_locks`,
7 `keep_on_reset`, 8 `use_limit_switches`, 9 `per_axis_feedrates`,
10 `nx_scripts_on_homed_only`. `$20` soft limits, `$21` hard limits, `$23`–`$27` the
homing mechanics, `$40` (`Setting_JogSoftLimited`) *"Limit jog commands to machine
workspace for homed axes."*

### What happens to a job streamed at a machine that has never homed

`limits_homing_required()` (`grblHAL/core/machine_limits.c:668-673`):

```c
return settings.homing.flags.enabled && settings.homing.flags.init_lock &&
        (sys.cold_start || !settings.homing.flags.override_locks) &&
          sys.homing.mask && (sys.homing.mask & sys.homed.mask) != sys.homing.mask;
```

When that holds, `protocol_main_loop` raises `Alarm_HomingRequired` at boot
(`protocol.c:137-145`) with the comment *"Alarm locks out all g-code commands,
including the startup scripts, but allows access to settings and internal commands.
Only a successful homing cycle '$H' will disable the alarm."*

⇒ **Streaming a job at an unhomed machine so configured produces `error:9` on line 1
and on every line after it** (`protocol.c:255-263`, the `STATE_ALARM` branch), and
`$X` will not help (F6). The failure is loud, and it is loud in a way that reads like
a dialect failure rather than a machine-state one.

⚠ **And with the lock off it is silent, which is worse.** If `$22` bit 2 (`init_lock`)
is clear, or bit 6 (`override_locks`) is set and this is a warm start, then
`limits_homing_required()` is false, the machine boots to `Idle` — and the job
streams into a controller whose machine coordinates are **whatever they were when it
powered on**. Soft limits then bound against a fictional origin, hard limits are the
only real protection, and `G53` moves go somewhere arbitrary.

🔴 ⇒ **The tab must not delegate "has this machine homed?" to the controller.** It
reads `|H:<0|1>` when present (§4) and, since `H` is change-only, requests `0x87` at
connect to force it. **No homing evidence ⇒ streaming refused** (§12). This is the
one refusal most likely to be argued with, and it is the one that protects the
operator from a configuration they did not choose.

### Soft vs hard limits, and they fail differently

- **Soft limits (`$20`)** — checked in software against machine travel. Violation
  produces `Alarm_SoftLimit` (2) with a **controlled** stop: *"Machine position
  retained. Alarm may be safely unlocked."* Requires homing to mean anything; grbl's
  settings doc notes `$20` cannot be enabled without homing (`error:10`,
  `Status_SoftLimitError`).
- **Hard limits (`$21`)** — physical switches. `Alarm_HardLimit` (1), immediate halt,
  *"Machine position is likely lost due to sudden halt."* Steppers stop dead and lose
  steps.
- **A jog** past a soft limit is neither: it returns `error:15`
  (`Status_TravelExceeded`, *"Jog target exceeds machine travel. Jog command has been
  ignored."*) — the jog is simply not executed, no alarm. §8.

⇒ The tab renders these three as three different things. "Limit hit" collapses a
recoverable software refusal, a recoverable software alarm and an unrecoverable
mechanical one into one word.

## 8. Jogging — `$J=` is not a `G1`

From grbl's jogging document
(<https://raw.githubusercontent.com/gnea/grbl/master/doc/markdown/jogging.md>, read
2026-08-10) and confirmed against grblHAL's parser:

- Syntax `$J=` followed by axis words and a **mandatory, non-modal `F`**, always
  units/min.
- Accepts `G20`/`G21`, `G90`/`G91`, `G53` and `N` **for that command only**. Every
  other G-code, M-code, `S` and `T` is rejected with `error:16`.
- 🔴 **It does not alter the parser state.** A `G91` inside a `$J=` does not leave the
  machine in incremental mode. This is the whole point: a jog cannot corrupt the
  modal state a paused program will resume into.
- The machine reports state **`Jog`** while executing, so the tab can tell a jog from
  a program move — which a `G1` would not allow.
- A jog past a soft limit is **not executed** and returns `error:15`. No alarm.
- 🔴 **G-code is locked out during `Jog`.** `protocol.c:255` blocks g-code in
  `STATE_ALARM|STATE_ESTOP|STATE_JOG` with `error:9`. So a jog in flight blocks the
  job, which is one more reason jogging and streaming are mutually exclusive states.

### Jog cancel — `0x85`

`CMD_JOG_CANCEL = 0x85` (`grbl.h:120`). It sets `char_counter = 0` and calls
`hal.stream.cancel_read_buffer()` (`protocol.c:894-897`) — **it flushes the input
buffer**, then decelerates the queued jog motion to a stop. grbl's document: it
*"automatically flush[es] Grbl's internal buffers of any queued jogging motions"* and
returns the machine to idle.

### How to build a button that stops when it is released

The pattern grbl documents, and the only one that does not queue metres of motion:

1. On press, begin a loop sending **short incremental jogs**:
   `$J=G91 G21 X<step> F<feed>`, with `step` chosen so each jog takes ~50–100 ms at
   `feed`.
2. **Wait for the `ok` before sending the next one.** Never fire them from a timer.
   The reply *is* the flow control; a timer-driven loop under a throttled tab either
   starves (jerky) or, if it ever ran fast, over-queues.
3. Keep at most 2–3 jogs outstanding: enough to keep the planner fed and blend the
   motion, few enough that the queued distance is small.
4. On release, **send `0x85` immediately** and stop the loop. Queued jogs are flushed
   and the current one decelerates.
5. On release, also **reset the character-count accounting to zero**, because `0x85`
   emptied the controller's RX buffer and any count carried over is now a lie.

⚠ The latency of the button is `outstanding_jogs × per_jog_time`. That is the
*design parameter*, and it is a trade against smoothness. Choose it explicitly, show
it in the settings, and do not let the step size be derived from a frame rate.

⚠ **Continuous jog is refused while streaming, and while in `Alarm`.** In `Alarm`
even `$J=` is blocked (`error:9`) — the operator must `$X` first, and the tab must
then say that position is untrusted (§6).

## 9. Tool changes and probing mid-program

### What grblHAL does with `M6` — and why it is not our problem

grblHAL has a native manual-tool-change protocol
(<https://github.com/grblHAL/core/wiki/Manual-tool-change-protocol>, read
2026-08-10): on `M6` it enters state **`Tool`**, suspends the input stream, and waits
for the sender to send realtime **`0xA3`** (`CMD_TOOL_ACK`). Only then does it flush,
accept jogs and `$` commands, reject motion with `error:40`, and finally reinstate
the saved buffer on a cycle start. `$341` selects the mode: 0 normal/basic, 1 manual
touch off, 2 manual touch off @ G59.3, 3 automatic touch off @ G59.3, 4 ignore
(`settings.h:836-841`,
<https://github.com/grblHAL/core/wiki/Manual,-semi-automatic-and-automatic-tool-change>).

🔴 **Our post does not emit `M6`.** `MoveKind::ToolChange` emits
`G0 Z<safe>` / `M5` / `( TOOL CHANGE -> … )` / **`M0`**
(`post_grblhal.rs:1032-1049`). So:

- **`$341` is irrelevant to our programs.** Do not implement the `0xA3` handshake and
  do not show a `Tool`-state UI as though we would reach it. If a `Tool` state ever
  *does* appear, that means a program from somewhere else is running, and the tab
  should say so plainly rather than half-handling it.
- What we actually get is `Hold:0` (F4), resumed with `~`.
- The tab must show **which tool** — the post writes it into the comment immediately
  above the `M0`, and the tab is streaming the file so it knows the line. Rendering
  "PAUSED" without the tool name makes the operator guess, and the post's own comment
  block says exactly why that is unacceptable (`post_grblhal.rs:1035-1038`).

### Probing mid-program

Our post emits `G38.2` in two places: the preamble datum probe, and a Z re-reference
after every tool change (`MoveKind::Probe`, `post_grblhal.rs:1057`, gate `RPRB`). During a stream the
controller executes them like any other block — with two behaviours the tab must
handle:

- `Run:2` substate while probing, **if `$10` bit 11 is set** (off by default). Do not
  depend on it.
- `[PRB:x,y,z:success]` is pushed on completion when `$10` bit 7 is set (on by
  default). The tab should surface it: it is the only direct evidence that the datum
  was actually taken, and `success` = 0 is a *failure that did not alarm*.
- On no contact: **`ALARM:5`**, the stream dies, and everything after it is
  `error:9`. ⇒ the abort path (§12) must handle an alarm arriving *between* line
  replies, not only as a reply.
- `G10 L20` writes to non-volatile storage. So a probe that ran and then a job that
  was aborted leaves a **persisted** datum. That is correct and it is also a trap: the
  next run's `G0 Z<safe>` (F3) is measured from it.

⚠ **And what the operator must do.** After an `M0` tool change the program's *next*
probe re-references Z for the new tool. Between the `M0` and the `~`, the operator
changes the tool and **must not jog Z into the plate**. The tab should say this at
the pause, from the program's own comment, and should show `TLR` and the live Z.

## 10. Disconnection, and what a reset costs

### Soft reset `0x18`

`mc_reset()` (`grblHAL/core/motion_control.c:1170-1204`):

```c
    // Kill steppers only if in any motion state, i.e. cycle, actively holding, or homing.
    if((sys.position_lost = (state_get() & (STATE_CYCLE|STATE_HOMING|STATE_JOG)) ||
                            sys.step_control.execute_hold || sys.step_control.execute_sys_motion)) {
        if(state_get() != STATE_HOMING)
            system_set_exec_alarm(Alarm_AbortCycle);
        else if(!sys.rt_exec_alarm)
            system_set_exec_alarm(Alarm_HomingFailReset);
        st_go_idle(); // Force kill steppers. Position has likely been lost.
    }
```

⇒ Two outcomes, and they are completely different:

- **Reset while stationary** (`Idle`, `Hold:0`, `Alarm`) — nothing is killed, no alarm
  is raised, **position is retained**. grbl's own documentation says the same:
  *"If reset while stationary, position is retained and re-homing is not required."*
- **Reset while moving** (`Run`, `Home`, `Jog`, or mid-hold) — **steppers are killed
  with no deceleration**, `sys.position_lost` is set, and `ALARM:3`
  (`Alarm_AbortCycle`) is raised. Steps are lost. **Re-home before cutting again.**

🔴 **This is the reason `0x18` is not a stop button** (§16). It is an *abort* that
trades position for immediacy, and the immediacy it buys is roughly one serial byte's
worth over `!`.

Also: a soft reset does **not** stop the spindle by itself in the general case — the
spindle is switched off via the reset path's handlers, and on a cold start explicitly
(`protocol.c:189-195`). Do not build a safety story on it.

One more, and it is subtle: after a warm reset, if `$22` bit 6 (`override_locks`) is
set, `limits_homing_required()` becomes false and `protocol_main_loop` **clears a
stale `Alarm_HomingRequired`** (`protocol.c:163-164`). ⇒ on such a configuration, a
soft reset drops the homing lock, and the machine will accept a job unhomed. The tab
must track homing itself (§7) and must not read "not in Alarm" as "homed".

### USB drop mid-job

The controller does not know. USB CDC has no application-level heartbeat: grblHAL
keeps executing whatever is already in its planner and RX buffer, then runs out and
sits at `Idle` with the spindle **still running** (nothing turned it off) and the tool
wherever the last buffered move left it — most likely down in the cut.

The browser side, per the spec: the read errors with `NetworkError`, the write side
errors and closes, `navigator.serial` fires `disconnect`, `port.connected` goes false.
Position in the controller survives (nothing was reset); the *sender's* idea of which
line is executing does not — up to a full RX buffer (≈1024 characters ≈ 40–70 of our
lines) may have been consumed after the last byte the tab wrote.

🔴 ⇒ **A disconnected job cannot be resumed from a line number.** The tab's model of
"where we are" was never better than "somewhere in the last buffer-full", and after a
drop it is not even that. §17 says what the UI does instead.

⚠ On reconnection, the port is a *new* stream. grblHAL will not have reset — so it may
still be `Idle` with a stale planner state and the spindle turning. **Reconnect must
not auto-resume.** It must show the machine's state and hand the decision to a human.

---

## Part 2 — the design

## 11. The connection lifecycle

```
        ┌── 'serial' in navigator? ──no──> BLOCKED: named, with the reason and the browsers that work
        │yes
   [ Disconnected ]
        │  getPorts() → previously granted ports, listed, no gesture needed
        │  Connect (user gesture) → requestPort()  [ SecurityError without transient activation ]
        ▼
   [ Opening ]  port.open({ baudRate: 115200 })
        │  start the reader loop FIRST, then write anything
        ▼
   [ Identifying ]  ── LISTEN ONLY. Nothing is written. ──
        │                                    ├─ grblHAL  → [ Connected ]
        │                                    ├─ grbl 1.1 → [ Connected, DEGRADED ] (banner says "Grbl", not "GrblHAL")
        │                                    ├─ spoke, unrecognised → [ REFUSED ] port closed
        │                                    └─ SILENCE → [ Asking ]
        ▼
   [ Asking ]  the probe is shown byte for byte and nothing goes out until an
        │      explicit action. Offered ONCE — a second ask after a probe that
        │      answered nothing is a loop, not a question.
        │   ├─ authorised → probe on the wire → back to [ Identifying ]
        │   └─ still silent after the probe → [ REFUSED ] port closed
        ▼
   [ Connected ] → the state machine in §12
```

### The handshake — one step, and three the operator may authorise

🔴 **CORRECTED 2026-08-11 (`5dc1b077f0`), and the correction is the ordering, not the
bytes.** This section used to describe four steps that all ran unconditionally: the tab
sent `$I`, `0x87` and `$$` the moment the port opened, waited two seconds, and only then
asked what it was talking to. **Three writes to firmware nobody had classified.** Steps
2–4 below are still the right probe and are still in the right order — what changed is
that **step 1 is the whole handshake**, and 2–4 are an offer.

⚠ **The reason the old ordering looked safe was *"they are harmless"*, and that is an
assumption rather than a measurement.** It is true of grblHAL and of Marlin. It is not a
property of `$`: on some firmwares `$` prefixes a parameter **write**, and `0x87` is an
arbitrary byte whose meaning belongs to whatever is actually running. The board on the
bench identifies itself over USB as `BLACK_F407VE CDC in FS Mode` — the string the
**Arduino core for STM32** emits, where grblHAL's `usbd_desc.c` hardcodes a different
literal — so what it does with `$I` is not something this lane knows. **It was also the
one place our code did to a machine exactly what a human inspector was forbidden from
doing by hand.**

**A UI that assumes it is talking to grblHAL and is actually talking to something else
is a UI that sends bytes with unknown meaning to a motion controller.** An SKR Pro
ships with Marlin, and this lane's own `controller_probe.py` refuses on that basis
(`tools/controller_probe.py`, `identify()` — the same ladder in the same order, and it
had the same handshake defect until 2026-08-11). The tab does the same, harder.

1. **Listen, and speak only if invited to.** Open, attach the reader, wait ~2 s
   (`LISTEN_WINDOW_MS`) for an unsolicited banner. **Nothing is written** —
   `connectCommands()` returns an empty list, and that emptiness is the design.
   grblHAL prints, on reset and at boot:
   ```c
   // report.c:307-314
   write(ASCII_EOL "GrblHAL " GRBL_VERSION " ['$' or '$HELP' for help]" ASCII_EOL);
   // …or, at COMPATIBILITY_LEVEL >= 1:
   write(ASCII_EOL "Grbl " GRBL_VERSION " ['$' for help]" ASCII_EOL);
   ```
   `GRBL_VERSION` is `"1.1f"` and `GRBL_BUILD` a date integer (`grbl.h:41-45`).
   ⚠ A board that has been running for an hour sends no banner. **Absence of a banner
   is not evidence of anything** — which is why silence goes to the offer below and
   not to a conclusion, and why **speech that was not recognised does NOT** go there:
   *that* is a fact about the board, and a board which has already shown it is not
   ours is refused rather than asked.

**Steps 2–4 are `IDENTIFY_PROBE`: shown to the operator byte for byte, and on the wire
only after an explicit action that has read them.** They are offered on silence, once.

2. **Ask, with a question that is read-only *on grblHAL*.** Send `$I`. grblHAL answers
   `[VER:1.1f.<build>:]` and `[OPT:…]` (`report.c:868, 883`) then `ok`. Marlin answers
   `echo:` lines or nothing.
   🔴 **`$I` moves nothing is a fact about grblHAL — the firmware this question exists
   to establish.** That is the whole trap, and it is why the ordering changed rather
   than the bytes: on unidentified firmware `$` is not a universal no-op, and on some
   firmwares it prefixes a parameter **WRITE**. *"It is read-only"* is a conclusion
   that requires the answer to the question being asked. It is still the right first
   probe — a better one does not exist — but it is a **write**, and it is consented to
   as one.
3. **Ask for the firmware, from the report itself.** Send `0x87`. grblHAL appends
   `|FW:grblHAL` to a full report — *"only added to full report requested by `0x87`
   … always reported as `|FW:grblHAL` and only when COMPATIBILITY_LEVEL is less than
   2"* (Report-extensions wiki; `report.c:1538-1541`). This is the **strongest
   positive identification available**, because it is a field grbl 1.1 does not have.
   ⚠ Off grblHAL it is one byte in `0x80`–`0xFF` whose meaning belongs to whatever is
   running — data, a command of its own, or a framing error. **No board has ever
   answered it here** (`TODO.md` #115).
4. **Read the settings that change how the UI reads everything else**: `$$` for
   `$10` (report mask), `$20`/`$21`/`$22` (limits and homing), `$13` (units — 🔴 if
   `$13=1` every position in the report is in **inches** and a millimetre DRO is
   wrong by 25.4), `$30`/`$31` (spindle range), `$481` (auto-report), `$398`
   (planner depth), `$40` (jog soft-limited). And read `Bf` from a full report while
   `Idle` to measure the RX buffer and planner depth (§2).
   ⚠ **Step 4 also runs UNPROMPTED after a verdict** (`afterVerdictCommands`), which is
   the only state in which *"reading `$$` is safe"* is a fact rather than a hope. It was
   step 4 of a handshake whose steps 2 and 3 had already written to an unidentified
   board, so nothing about its position was ever load-bearing. A consequence handled
   rather than hidden: **`$481` is now read after the verdict**, so the first poll plan
   is always the safe one and the code retunes when `$481` actually arrives — the old
   path raced `$$`'s answer against a two-second timer.

**Classification, and what each verdict permits** (`protocol.ts::identify`, strongest
evidence first):

| Verdict | Evidence | Permitted |
|---|---|---|
| **grblHAL** | `FW:grblHAL` in a `0x87` full report, or a `GrblHAL` banner | everything |
| **grbl-family, degraded** | a `Grbl` banner, or `[VER:` **and** `[OPT:`, with no `FW:grblHAL` | read-only: DRO, status, `$$`. **No streaming, no jogging.** Banner says why: "this reports as grbl 1.1, not grblHAL; our post targets grblHAL and the differences are not cosmetic (buffer size, alarm codes, error persistence)." |
| **unknown — spoke, unrecognised** | the port produced lines and none of them identify the firmware | **nothing.** Port closed. The raw bytes are shown so a human can identify it. |
| **unknown — silent** | nothing arrived at all: no banner, no report, not one byte | **nothing**, and **no conclusion either.** Steps 2–4 are offered, once. |

⚠ **`[VER:` + `[OPT:` is `grbl-family`, not `grblHAL`** — this table said the latter
until 2026-08-11 while the code said the former. They are what `$I` answers on **both**
firmwares, so on their own they establish the family and not the member. **And both are
required**: `[VER:` alone is not the evidence.

🔴 **TWO REFUSALS, NOT ONE, and neither permits anything.** They are separated because
they send a human to completely different places: *silent* is a cable, a port, a baud
rate, or a controller that booted before the tab opened the port — **the zero-risk fix
is to reset it and let it announce itself, which needs no bytes from us.** *Spoke and
was not recognised* is a fact about the firmware. Until 2026-08-11 both rendered the one
string `'nothing was received'`, which is safe and useless for diagnosis.

🔴 **On either `unknown`, close the port.** Leaving it open with a console is a loaded
gun: someone types `G0 Z-50` into a Marlin board that will happily execute it.

⚠ **Nothing in the handshake writes a motion command, and nothing writes a `$` setting.**
Reading `$$` is safe; writing `$10=511` to "make the UI work" would be the tab
silently reconfiguring a machine somebody else set up. **If a setting is missing, the
tab reports the missing capability and offers the exact command for a human to run.**

## 12. The state machine, and the refusals

States (tab states, distinct from the controller's — the mapping is many-to-one):

```
 Disconnected ──connect──> Identifying ──ok──> Idle
                                │
                                └──refused──> Disconnected

 Idle ──$H──> Homing ──done──> Idle(homed)
 Idle ──jog──> Jogging ──0x85 / done──> Idle
 Idle(homed, program loaded, preflight passed) ──start──> Streaming
 Streaming ──!──> Held ──~──> Streaming
 Streaming ──stop──> Stopping ──> Idle(position untrusted)
 Streaming ──error:/ALARM──> Aborted ──> Alarm
 Streaming ──M0 in program──> Paused(tool change) ──~──> Streaming
 any ──door open──> Door
 any ──alarm──> Alarm ──$X──> Idle(position untrusted) ──$H──> Idle(homed)
 any ──usb drop──> DisconnectedMidJob
```

### The refusal set — this is the interesting part

| # | Refuse | Because |
|---|---|---|
| R1 | **Start a job when the tab has no homing evidence** (`H:1` never seen, or `$22` bit 0 clear) | §7. Machine coordinates are fictional; soft limits bound nothing; and with `init_lock` off the controller will *accept* the job. This refusal exists precisely because the controller's is optional. |
| R2 | **Start a job while position is UNTRUSTED** — set after `$X` on alarms 1/3/6/…, after any `0x18` while moving, after `Sleep`, after a mid-job disconnect | Alarms 1 and 3 say so in their own text. Cleared only by a completed `$H`. **Alarm 2 (soft limit) does not set it** — grblHAL says *"Machine position retained. Alarm may be safely unlocked."* |
| R3 | 🔴 **Start a job whose first motion is a descent from the tool's current position** | **F3.** Compute it: the first `G0 Z` in the program is a work coordinate; the tab knows `WPos` (or `MPos` and `WCO`). If `program_first_z < current_work_z`, the first rapid goes **down** at rapid rate. Refuse, show both numbers, and offer `Jog to safe Z` or `Re-zero`. If `WCO` has never arrived, that comparison **cannot be made** — and an unmakeable comparison is also a refusal, not a pass. |
| R4 | **Start a job while the controller is not `Idle`** | Streaming into `Run`, `Hold`, `Jog`, `Door` or `Tool` interleaves with something already in the buffer. |
| R5 | **Start a job with unsaved changes to the program in the CNC tab** | The tab streams *bytes*; if the bytes on screen and the bytes being sent can differ, the picture is not the program. Hash the program at Start and display the hash. |
| R6 | **Jog while `Streaming`, `Held` or `Paused`** | `$J=` during a hold does execute on grblHAL, but `0x85` flushes the RX buffer (§3) and destroys the stream. Jogging at a tool-change `M0` is a legitimate need — so **at `Paused` only, jog is permitted and jog-cancel is implemented as "stop sending, wait for the queue to drain", never as `0x85`.** State that in the code, or someone will wire the same button. |
| R7 | **Send `0x85` outside `Jogging`** | as above |
| R8 | **Send `0x9E` (spindle stop) outside `Hold`** | `protocol.c:726-727` — it is silently ignored elsewhere, and a control that silently does nothing is worse than one that is greyed out |
| R9 | **`$X` while the controller would refuse it** (`error:46`, e-stop, door ajar, limits engaged) | **F6.** Show the refusal and the actual next step (`$H`, close the door, clear the switch) instead of a button that appears to fail. |
| R10 | **Resume (`~`) after an `Aborted` or `Alarm`** | there is nothing to resume; the buffer is gone |
| R11 | **Auto-resume after a reconnect** | §10 — the sender's line position was never better than "within the last buffer-full", and after a drop it is worse |
| R12 | **Any streaming when `$13=1` (inch reporting) and the UI is in mm**, until acknowledged | a DRO wrong by 25.4× reads as a catastrophic position error and would provoke exactly the wrong reaction |
| R13 | **Start with no `Bf` and no measured buffer size, in character-counting mode** | §2. Fall back to send-response *with the reason on screen*, or refuse. Never guess 128 or 1024. |

⚠ **Every refusal names the setting or the fact.** `AGENTS.md:37-40` — *"Refuse rather
than approximate"* — and the post's refusals already model the register: name the
field, say what the operator can measure or run, and never offer a "continue anyway"
that is one click from the same click that starts a cut.

### Transitions that must be allowed even though they look dangerous

- **`!` from `Streaming`, always.** A hold must never be gated on anything.
- **`0x18` from any state, always**, behind one confirmation (§16).
- **Status polling in every state**, including `Alarm` and `Door`. A UI that stops
  reading when things go wrong stops reading exactly when it matters. ⚠ grbl notes `?`
  is not answered during a homing cycle; grblHAL adds `$10` bit 12 (*report while
  homing*, default **off**). ⇒ **during `Home`, expect silence and say "homing —
  reports suppressed by `$10` bit 12", not "connection lost".**

## 13. What is shown

Top band, always visible, never scrolled away:

- **Machine state**, as the controller's own word plus substate — `Run`, `Hold:1`,
  `Alarm:5`, `Door:2` — with a plain sentence underneath for the ones that mean the
  machine may still move (§4).
- **Two DROs, side by side: Machine and Work.** Each labelled, three axes, three
  decimals. `WCS` (`G54`…) next to the work column. Under it, `WCO` itself, and `TLR`.
  🔴 **When `WCO` has not been received, the work DRO renders `—` and the reason.**
  Never zero.
- **Feed and speed** from `FS:`: *commanded* feed, *programmed* rpm, and *actual* rpm
  where the third value is present. With the **overrides beside them**, from `Ov:`,
  as three numbers and as the applied result: "F1200 × 80% = 960 mm/min". An override
  slider that shows its own position rather than the controller's readback is a
  control asserting a state it has not confirmed.
- **Buffer occupancy** from `Bf:`, as two figures: planner blocks free / total, and RX
  characters free / measured size. Rendered as *headroom*, because that is what
  starvation looks like. When `$10` bit 1 is clear: "not reported".
- **Line**: `Ln:` from the controller if present, and separately **the sender's own
  count** — sent / acknowledged / total. 🔴 **These are different numbers and both are
  true**: `Ln:` is the line the *planner* is executing, the sender's count is what has
  been *transmitted*. The gap between them is the buffer, and showing only one hides
  it. Label them "executing" and "sent".
- **Elapsed**, from a wall clock started at the first byte.
- **Remaining** — see the next section, because this is where a prediction can be
  mistaken for a measurement.
- **Pin state** `Pn:` decoded to words (limit X/Y/Z, probe, door, e-stop, feed hold,
  cycle start, motor fault…) using the wiki's letter table (§4 sources). A probe shown
  as triggered when it should not be is the thing that turns a probe into a crash.
- **The link**: last report age in ms, and whether auto-reporting is on.

Below: the toolpath canvas (§14), the controls (§15), and a **console** — every line
sent and every line received, with realtime bytes rendered by name (`[0x85 jog
cancel]`), timestamped, copyable. The console is how a controller fact gets routed to
`pcb`, and `gates/controller/README.md` already says a rejection is a finding, not a
run failure.

⚠ **`Remaining` is not `total − elapsed`.** See §14.

## 14. Progress on the canvas — the prediction and the measurement must not be the same picture

`#70` animates *predicted* progress by walking the program at its own feeds. This tab
knows *actual* position from the DRO. The brief's rule:
**a prediction and a measurement must never be rendered identically.** Concretely:

### Two independent things, two visual languages

| | #70 prediction | this tab's measurement |
|---|---|---|
| Source | program feeds × lengths, computed in the core (`#70` option 1) | `MPos`/`WPos` from the status report |
| Rate | ~30–60 fps, smooth | the report rate: 5–10 Hz typical, `$481` floor 100 ms |
| What it knows | the whole future | only now, and only to report resolution |
| Rendering | **outline / ghost** — the path drawn as an unfilled stroke, in the *inactive* tier of the instrument palette | **solid** — the cut path drawn in the *cut* colour, at full weight |
| Label | "predicted" | "cut" |

The toolpath is drawn once. **Measured-cut** segments are solid. **Not-yet-cut**
segments are the base colour. The **prediction** is not a third colour on the same
geometry — it is a **single marker**: a ghost outline of the tool at the predicted
position, distinct in shape from the solid tool marker at the DRO position.

⇒ The operator sees two tool markers. When they coincide, the picture reads as one.
When they separate, the separation is the information.

⚠ **Colour alone must not carry it.** These are the six move-class instrument colours
brand explicitly ruled out of the palette as *"instrument/safety colours"*
(`AGENTS.md:134-139`), and a machining legend is a safety surface. Prediction is
distinguished by **fill vs outline** as well as hue, so it survives a colourblind
operator and a sunlit shed.

### When they disagree

**The disagreement is information, not an error to hide.** Three causes, and they are
distinguishable:

1. **Overrides.** Feed override at 60% makes the machine slower than the prediction by
   exactly that factor, and `Ov:` says so. ⇒ the tab shows *"machine is behind the
   prediction — feed override 60%"*, and offers a prediction recomputed at the current
   override.
2. **Starvation.** The machine is behind and `Ov:` is 100% and `Bf:` shows the planner
   near-empty ⇒ **the streamer is not keeping up**, which is the failure that leaves a
   cutter sitting in the work (§2). This is a warning, prominently, with the buffer
   figures beside it.
3. **Neither.** The machine is somewhere the program does not go, or is ahead. ⇒
   something is wrong with the model — a wrong `WCO`, a `G92`, a resumed job, a
   pendant (`MPG:1`) driving the machine. 🔴 **Show it and stop asserting progress.**

⇒ **The tab always renders the disagreement as a signed number** — "machine is 4.2 s
/ 31 mm behind prediction" — never by quietly snapping one to the other.

### `Remaining`, honestly

`Remaining` is computed **from the program**, forward from the *measured* position:
sum of the remaining moves' lengths over their feeds, scaled by the current feed
override. It is labelled **"estimated"** and shows its basis on hover
(*"remaining program length ÷ programmed feeds × 80% override; rapids at the machine's
rapid rate"*).

⚠ **Rapids advance the clock and cut nothing** — `#70` already records this, and it
applies identically here: the *time* bar and the *cut* geometry advance at different
rates, and merging them makes the bar read as "nearly finished" when a long link move
is running. Two indicators, not one.

🔴 **When the DRO cannot be mapped onto a program move — the machine is somewhere the
path does not go — `Remaining` renders `—`.** A time estimate derived from a position
we could not locate is a number invented in TypeScript and rendered as a measurement,
which is the defect class this lane has recorded four times (`AGENTS.md:190-198`).

### Mapping the DRO onto the path

Nearest point on the polyline, **constrained forward** from the last matched position
so a path that crosses itself does not snap backwards, with a distance tolerance. If
the nearest point is further than the tolerance, the match **fails** — and a failed
match is state 3 above, not a snap to the nearest thing available.

⚠ **A matched position colours the path up to that point — it does not prove material
was removed there.** The DRO is where the *controller thinks* the tool is. After a
hard limit or a killed reset it is wrong and says nothing about it. So the legend
reads **"tool has passed here"**, not "cut". `P9` (material removal sim) is the thing
that reasons about removal, and it is a different claim.

## 15. The controls

| Control | Sends | Allowed in | Notes |
|---|---|---|---|
| **Connect / Disconnect** | — | Disconnected / any | Disconnect closes the port. It does **not** stop the machine — say so on the button's confirmation if a job is running |
| **Hold** | `!` (0x21) | any | Controlled decel. 🔴 **The spindle keeps turning** — the label says "Hold (feed)". Safe at any time |
| **Resume** | `~` (0x7E) | `Hold`, `Door` (once closed), `Paused` | 🔴 **Never enabled in `Alarm`** — nothing to resume |
| **Stop** | see §16 | `Streaming`, `Held`, `Jogging` | §16 |
| **Spindle stop** | `0x9E` | 🔴 **`Hold` only** | greyed elsewhere with the reason |
| **Feed override** | `0x90` reset, `0x91`/`0x92` ±10, `0x93`/`0x94` ±1 | any | Range 10–200%. Readback from `Ov:` — the slider follows the controller, not the finger |
| **Rapid override** | `0x95`/`0x96`/`0x97` | any | 🔴 **Three positions only: 100 / 50 / 25.** Not a slider. `0x98` does not exist in grblHAL |
| **Spindle override** | `0x99` reset, `0x9A`/`0x9B` ±10, `0x9C`/`0x9D` ±1 | any | Range 10–200%. ⚠ Meaningless on a machine with no spindle PWM — and our post already warns about exactly that case (`post_grblhal.rs:1008`). If `Machine::spindle_pwm` is false, **grey the control and say the VFD dial is the only speed control** |
| **Jog** | `$J=G91 …` + `0x85` | `Idle`, `Paused` (with the caveat in R6) | §8 |
| **Home** | `$H` | `Idle`, `Alarm` | 🔴 `$H` **is** allowed from `Alarm` (`system.c:486` permits `STATE_IDLE` or `STATE_ALARM`) — which is the whole recovery path. It is a **long blocking motion**: expect no status reports during it (§12) |
| **Zero X / Y / Z / all** | `G10 L20 P1 <axis>0` | `Idle` only | 🔴 **Writes to non-volatile storage**, survives a power cycle, and every later coordinate is measured from it. Confirm, and show the before/after `WCO`. ⚠ Prefer `G10 L20` over `G92`: `G92` is volatile-ish, invisible in `WCS`, and is the classic source of a mystery offset |
| **Unlock** | `$X` | `Alarm` | 🔴 §6. Labelled `Unlock ($X)`. Confirmation quotes the alarm's own consequence sentence. Sets position UNTRUSTED for alarms 1/3/6/… |
| **Soft reset** | `0x18` | any | §16 |
| **Console** | free text | `Idle` for `$`; g-code **refused** | ⚠ A console that accepts arbitrary g-code is a motion control surface with no preflight. Restrict it to `$` commands and realtime bytes; anything starting with `G` or `M` is refused with "load a program instead" |

## 16. The stop control

🔴 **This software is not an emergency stop.** Written here, in the file the
implementer reads, because the brief requires it and because a label is the whole
risk.

### What ships

**One button, labelled `Stop`.** Not `E-STOP`, not `EMERGENCY`, not red-and-yellow
hazard striping, not the largest thing on screen. It is a normal control in the
control row, styled as a destructive action.

Pressing it runs a two-step sequence:

1. **`!` (feed hold, `0x21`)** — a *controlled deceleration*. The machine ramps down
   along the path, position is retained, nothing is lost.
2. **Stop feeding the stream**, and once the state reads `Hold:0`, offer two
   explicit choices:
   - **`Resume`** → `~`, the job continues from the buffer. Clean.
   - **`End job`** → send `M5` and `G0 Z<safe>` if the machine is `Hold:0` and the
     tab can prove the retract is upward (F3's comparison, applied again), then
     `0x18`. Position is retained because the machine is stationary (§10). Job is
     marked ended, not resumed.

A **separate, smaller** control — `Abort (soft reset)` — sends `0x18` immediately,
behind one confirmation that states the cost verbatim from grblHAL:
*"Reset/E-stop while in motion. Machine position is likely lost due to sudden halt.
Re-homing is highly recommended."* After it, position is UNTRUSTED (R2) and the tab
says so until `$H` completes.

### What `Stop` does NOT guarantee — the section an implementer must not delete

- **It does not cut power to anything.** Not the spindle, not the drivers, not the
  VFD. `!` leaves the spindle turning (§3, §10) and the tool in the work.
- **It requires the USB link to be alive.** In the emergency where it is most wanted —
  a cable pulled, a hub reset, a laptop asleep, a crashed tab — the byte is never
  sent. **The failure mode of the software stop is correlated with the emergency.**
- **It requires the browser to be scheduled.** A backgrounded, throttled or
  garbage-collecting tab may take hundreds of milliseconds to issue a write (§17).
- **It requires grblHAL to be alive and its main loop running.** A firmware hang, a
  brownout or a locked-up USB stack is a controller that is still moving and no longer
  listening.
- **It requires the controller to be able to stop the machine.** Steppers that have
  already lost steps against a jammed gantry do not un-lose them.
- **`0x18` does not decelerate.** It kills the steppers. Whatever the gantry's inertia
  does after that is not controlled by anything.
- **Nothing here stops the spindle at the wall.** A VFD commanded off still spins down
  over seconds.

🔴 **The safety device is a physical emergency stop that removes power** — to the
spindle/VFD and to the stepper drivers — **wired into the machine, reachable from
where the operator stands, and tested.** That is `ops`/`pcb`'s to specify and install;
this tab's job is to never let anyone believe it is a substitute. Whether one is
fitted to the 6090 is a fact this lane does not hold.

⇒ **The tab renders a persistent line under the control row:**
*"`Stop` asks the controller to stop. It is not an emergency stop and does not cut
power. Use the machine's physical e-stop."* Not a tooltip. Not a modal that gets
dismissed once. A line that is always there.

⚠ **And a corollary for whoever writes the copy:** do not describe `Hold` as "pause"
in a way that implies safety. The tool is still in the cut, the spindle is still
turning, and a hand going near it during a `Hold` is a hand going near a running
cutter. The `Paused (tool change)` state — the only one where the post has emitted
`M5` — is the only one whose copy may say the spindle is off, and it may say it only
because the tab watched `A:` lose its `S`.

## 17. Failure modes, and what the UI does about each

| Failure | Detection | Response |
|---|---|---|
| **Tab backgrounded / throttled** | `document.visibilityState`, plus report age | 🔴 See below — this is the big one |
| **USB unplugged mid-job** | reader rejects `NetworkError`; `serial` fires `disconnect`; `port.connected` false | Stop the streamer. State `DisconnectedMidJob`. **Loud**: "the machine may still be moving; it will stop when its buffer empties, with the spindle running and the tool in the cut. Use the physical e-stop if that is not acceptable." Freeze the last known DRO **and mark it stale with its age**. Offer Reconnect, never auto-resume (R11) |
| **Controller reset mid-job** (watchdog, brownout, someone pressed the board's reset) | a `GrblHAL …` banner arrives unsolicited mid-stream; or state jumps to `Alarm:3`; or replies stop matching sent lines | Abort the stream immediately. Position UNTRUSTED. Re-run the §11 handshake — the settings may have reverted |
| **Buffer starvation** | 🔴 **keyed on the sender**: time since the streamer last successfully wrote, and the write queue's own depth. **Not** on `Bf` planner-free, because `G4` legitimately drains it (**F5**) | Warn at a threshold; at a longer one, `!` automatically and say why. ⚠ Auto-`!` is itself a motion decision — make it a setting, default on, and log it in the console |
| **Status reports stop arriving** | report age > N × expected interval (expected = `$481` if set, else the poll period) | Do **not** assume the machine stopped. Show "no report for X s — machine state unknown"; keep streaming for a short grace (the link may be congested), then `!` and stop. 🔴 During `Home` this is **expected** (`$10` bit 12 off) — the grace must be state-aware or it will `!` every homing cycle, and a control that false-fires gets muted |
| **The browser refuses the port** | `requestPort()` rejects: `NotFoundError` (user cancelled), `SecurityError` (no transient activation), `NotAllowedError` (permissions policy) | Distinguish them. "Cancelled" is not an error; "blocked by policy" needs the deployment fixed; "no user gesture" is our bug and should never reach a user |
| **Port opens but the device is silent** | nothing at all within `LISTEN_WINDOW_MS` — and **nothing was sent**, so this is not "no reply to `$I`" | `unknown — silent` (§11), which is the one verdict the tab does **not** conclude from. Offer `IDENTIFY_PROBE` byte for byte, once, and wait. Reset the controller is the zero-risk answer and is named first. If the operator authorises it and the port stays silent through it, close |
| **Another tab holds the port** | `open()` rejects with `InvalidStateError`/`NetworkError` | Say it: "the port is open in another tab or application (gSender, CNCjs, a serial monitor). Close it." This is the most common real failure and the least obvious message |
| **A pendant takes the stream** | `MPG:1` in the report | Per the wiki: *"pendant has taken over input stream, senders should disable UI but still update controls."* Do exactly that — disable every control, keep the DRO live, say who has control |
| **Inch reporting** | `$13=1` | R12 |
| **First `error:` mid-stream** | any non-`ok` reply | 🔴 **Abort on the first one** (F7). Every subsequent reply is a copy. Show the line, its number, the code and grblHAL's own sentence, then `!` + stop feeding |
| **`ALARM:` mid-stream** | an `ALARM:N` line arriving between replies | Abort. It is asynchronous and is not a line reply — a parser that only inspects replies will miss it entirely |

### The throttled tab, in detail — and the architecture it dictates

Chrome throttles **`setTimeout` and `setInterval`** in hidden tabs: ~1 s for a hidden
page, and ~1 min under "intensive throttling" once the page has been hidden >5 min
with a timer chain ≥5, silent for >30 s and no WebRTC
(<https://developer.chrome.com/blog/timer-throttling-in-chrome-88>, read 2026-08-10).
Exemptions include a visible page, audio in the last 30 s, and an active WebRTC
connection.

🔴 **A streamer built on a timer pump stalls the moment the tab is hidden. That leaves
a turning cutter stationary in the work.**

⇒ **Three structural consequences, in order of importance:**

1. **The streamer is not timer-driven.** It is driven by `await reader.read()` and by
   `ok` replies. Reads resolve when bytes arrive; that is an I/O completion, not a
   timer, and the Chrome documentation names only timers as throttled. ⚠ **I have not
   measured this and neither should the implementer take it on faith** — it is the
   single assumption the whole design rests on, and §18 makes measuring it a
   first-class test.
2. **Run the streamer in a dedicated worker.** Web Serial is exposed on
   `WorkerNavigator` (§1), so the port can be opened and driven entirely off the main
   thread. That removes the whole class of "the UI thread was busy rendering the
   toolpath and the write was late". The worker owns the port, the character count and
   the line cursor; the window owns the picture and posts commands.
   ⚠ The window↔worker boundary must be **command/event**, never shared mutable
   state, and the realtime bytes must be sendable *ahead of* queued g-code — a `!`
   that waits behind 400 buffered lines is not a hold.
3. **Prefer `$481` auto-reporting to a `?` poll**, and fall back to a poll when
   `$481=0`. It removes the status timer entirely. It does **not** remove the write
   path, so it is a mitigation for the DRO going stale, not for starvation.

**And the honest belt-and-braces:** while `Streaming`, the tab acquires a
a Screen Wake Lock if available, and **on `visibilitychange` to hidden it does not
stop** — but it does start a stricter watchdog on write latency, and if writes fall
behind the threshold it issues `!` and reports *"the browser stopped scheduling this
tab; the job was held"*. That is a true statement and a safe outcome.

⚠ **What must NOT be built:** a `Start` button that refuses unless the tab is visible
and then does nothing when it is hidden. A machine that stops when someone alt-tabs is
a machine that scraps parts, and a rule people cannot follow is a rule they defeat.
Build the streamer so backgrounding is survivable, and measure it (§18).

## 18. How it gets tested without a machine

**There is no router on the floor.** `TODO.md` #76 records no purchase record in
`business/financials/`, and `AGENTS.md:73` is unambiguous: *"NOTHING HERE HAS CUT
ANYTHING."* So everything below is a test of the **sender**, and none of it is a test
of the machine.

### The fake: a grblHAL responder behind the same seam

Build `web/src/run/transport.ts` with one interface — open, a byte sink, a byte
source, close, plus the disconnect event — and two implementations:

- `WebSerialTransport` — the real one.
- `FakeGrblHalTransport` — a byte-level responder implementing the protocol, **not**
  the UI's model of it.

🔴 **The fake sits at the byte boundary, not above the parser.** If it hands the UI
parsed objects, then the parser — where `$10` variants, `WCO` absence, `Alarm:5`
substates and `error:` poisoning actually live — is never exercised, and the fake
vouches for the one layer it replaced.

The responder must reproduce, because these are the behaviours the tab is built
against:

1. The banner `\r\nGrblHAL 1.1f ['$' or '$HELP' for help]\r\n` on connect and after
   `0x18`; `$I` → `[VER:…]` `[OPT:…]` `ok`; `$$` → a real settings dump.
2. **A configurable `$10`**, and reports that genuinely omit the fields the mask
   clears — including a `WPos`-reporting profile and an `MPos`-with-no-`WCO`-yet
   profile.
3. **Change-only elements**, with `WCO` withheld until the refresh counter fires or
   `0x87` arrives.
4. A **finite RX buffer** of configurable size that reports its true free space in
   `Bf`, and that **stops sending `ok` when overrun** — so an over-eager streamer
   deadlocks against the fake instead of at the machine.
5. **`error:` poisoning**: after the first error, every subsequent line gets the same
   `error:N` and is not "executed"; an empty line or a `$` clears it (F7).
6. `!`/`~` with a `Hold:1` → `Hold:0` transition that takes real time.
7. `0x18`: banner, and `ALARM:3` **only if it was moving**.
8. `$H` with a multi-second silence and no reports (`$10` bit 12 off), then `H:1`.
9. `$J=` accepted, `Jog` state, `error:15` past a soft limit, `0x85` flushing.
10. `M0` → `Hold:0` until `~`.
11. `G38.2` → `[PRB:…:1]` and `ok`, or **`ALARM:5`** on a configured no-contact.
12. A **Marlin persona** and a **grbl-1.1 persona**, so the §11 refusals are exercised
    in the direction that matters.
13. Injectable faults: mid-stream disconnect, mid-stream reset, a report gap, garbage
    bytes, a partial line split across two reads.

⚠ **Item 13's last one is not decoration.** A serial read boundary falls anywhere.
A parser that assumes one read is one line works perfectly against a naive fake and
fails against a real CDC endpoint under load.

### Gate `RUN`

| Field | Value |
|---|---|
| **Id** | `RUN` |
| **Class** | HARD |
| **Guards** | *a sender that stalls mid-cut leaves a turning cutter stationary in the material, and a sender that misreads the machine's state resumes a machine whose position is unknown* |
| **PENDING budget** | `when: 'always'`, `why: 'the browser-vs-machine half needs a real controller on the USB cable; evidence is a committed transcript in gates/controller/, not a run on this box'` |

Branches, all of which run against the fake and **all of which must fail on demand**:

| Branch | What it asserts | `--plant` |
|---|---|---|
| `RUN-1` | Character counting never exceeds the responder's buffer, over a 5,000-line program, and the responder never reports an overrun | `overcount` |
| `RUN-2` | Every line gets exactly one reply; `<…>`/`[…]`/`ALARM:` are not counted as replies | `count-status-as-ok` |
| `RUN-3` | The first `error:` aborts the stream; no further lines are sent (F7) | `keep-going-past-error` |
| `RUN-4` | Realtime bytes go out as single bytes — assert `0x90` on the wire, not `0xC2 0x90` (§3) | `utf8-realtime` |
| `RUN-5` | With `$10` bit 0 set and no `WCO` yet, the work DRO is `—`, not `0.000` (§5) | `assume-zero-wco` |
| `RUN-6` | With `$10` bit 0 **clear** (`WPos` reported), `WCO` is not subtracted again | `double-subtract-wco` |
| `RUN-7` | `0x85` is never emitted outside `Jog` (R7) | `cancel-while-streaming` |
| `RUN-8` | Streaming is refused with no homing evidence (R1), and refused while position is UNTRUSTED (R2) | `stream-unhomed` |
| `RUN-9` | 🔴 Streaming is refused when the program's first Z is below the current work Z (**F3/R3**), **and** refused when `WCO` is unknown so the comparison cannot be made | `descend-first` |
| `RUN-10` | `$X` on `error:46` does not clear the UI's alarm state (F6) | `unlock-optimism` |
| `RUN-11` | After `$X` on alarm 1/3, `Start` stays refused until `$H` completes; after alarm 2 it does not (§6) | `trust-after-hardlimit` |
| `RUN-12` | Mid-stream disconnect ⇒ no auto-resume, DRO marked stale (R11) | `auto-resume` |
| `RUN-13` | An `ALARM:` arriving between replies aborts the stream | `ignore-async-alarm` |
| `RUN-14` | Alarm and error codes render from the extracted grblHAL tables; an unknown code renders as unknown, not swallowed | `swallow-unknown-code` |
| `RUN-15` | A Marlin persona and a grbl-1.1 persona are both refused/degraded per §11, and the port is closed on `unknown` | `accept-anything` |
| `RUN-16` | A line split across two reads parses as one line | `assume-read-is-line` |
| `RUN-17` | The prediction marker and the measured marker are distinguishable **without colour** (fill vs outline) in the rendered DOM/canvas (§14) | `same-marker` |
| `RUN-18` | 🔴 **Throughput survives `document.visibilityState === 'hidden'`** — driven in Playwright with the page hidden, asserting bytes-per-second stays within a factor of the visible run (§17) | `timer-pump` |

🔴 **`RUN-18` is the branch that decides the architecture.** If throughput collapses
when hidden, the timer-free reader/worker design is wrong and the tab must instead
refuse to start unless it can hold the machine safely — which is a different product.
Measure it before writing the streamer, not after.

### 🔴 And what a green RUN does NOT say

**A green against a simulated port is not a green against a machine.** The fake is
this lane's model of grblHAL, written from grblHAL's source by the same person who
wrote the tab — so it can only ever confirm that the tab agrees with our reading. It
cannot discover that our reading is wrong. `RUN` proves the sender is
self-consistent; `CTRL` and the physical rungs are what prove anything else.

⇒ Two things must be true in the gate's own output, or the budget is doing harm:

- `RUN` prints, on every run, that its transport was the fake — with the fake's
  configuration (buffer size, `$10`, persona) in the line. *A green whose subject is
  unnamed is a green nobody can audit.*
- The controller half of `RUN` **PENDS** until a transcript exists in
  `gates/controller/`, and per this lane's rule a check that cannot run reports
  **PENDING, never PASS** — so the run reads INCOMPLETE (exit 3), never GO.

⚠ And the pairing hazard `PLANT` exists for: **every `--plant` above must be verified
to actually plant.** `PLANT`'s own row records ten of eighteen plants being inert on
most targets. A plant that changes nothing announces `PLANTED:` and proves nothing.

## 19. The rungs to a first real cut

**In order. None is skipped, and each names the evidence the next one needs.**
The physical rungs are `ops`/`depot`'s to run with an operator present — this lane
cannot self-certify any of them (`AGENTS.md:166`).

| # | Rung | Evidence required before the next rung |
|---|---|---|
| **0** | **Fix F1** (the absolute Z probe) and add the `G38.2`-must-be-incremental assertion, with its red watched | The red run, in the commit body per `SLICER-GATES.md` |
| **1** | **Gate `RUN` green against the fake**, all 18 branches, all plants verified to plant | The gate transcript, and `RUN-18`'s measured hidden-tab throughput |
| **2** | **Connect to a bare board.** No motors powered, no drivers, no VFD. Handshake only: banner, `$I`, `0x87`, `$$` | A transcript showing `FW:grblHAL`, the `$$` dump, the measured `Bf` buffer size, and the `$10` value. Route the `$$` dump to `pcb` as the record of what we ship against |
| **3** | **Stream one program to a bare board** — this is exactly gate `CTRL`, which exists and pends today. Use the tab, not `controller_probe.py`, so the tab's own streamer is what is measured. ⚠ Fix **F6** and **F7** in the harness first, or the transcript will be wrong in both directions | A `gates/controller/` transcript with `--rig bare`; `CTRL` green; the `program_command` recorded so staleness can be detected |
| **4** | **Motors powered, spindle DISCONNECTED, cutter OUT of the collet.** Jog each axis; watch the DRO track. Home. Watch `H:1`. Trip a limit switch by hand and watch `ALARM:1` render, then `$X`, then the tab refusing to start a job until `$H` | A recorded session: DRO vs a rule on each axis, the homing cycle completing, the alarm rendered with grblHAL's own sentence, the refusal observed |
| **5** | **Probe against the touch plate**, spindle still disconnected, with a **gauge pin or a dowel** in the collet rather than a cutter | `[PRB:…:1]` in the console, and the `G10 L20` datum verified by jogging to a known point. 🔴 **This is where F1 gets proven at the machine.** Run it deliberately with a *deliberately wrong* pre-existing G54 Z, and confirm the probe still works — that is the negative control for the fix |
| **6** | **Air cut.** Spindle connected but **OFF at the VFD**, work Z zeroed **50 mm above** the bed so every cutting move runs in air. Full program, start to finish, from the tab | The complete program streamed with zero errors, no starvation warnings, prediction-vs-measurement divergence within the override-explained band, and the tab's own timing against a stopwatch |
| **7** | **Foam or MDF coupon.** Spindle on. A small test part with a pocket, a profile, tabs and a dogbone | The part, measured. And the first honest statement this lane will ever have made about material removal |
| **8** | **Real ply** | The part, measured, against the CAD |

🔴 **Nothing above rung 6 may be described as validating the CAM.** Rungs 2–5 validate
the *sender*. Rung 6 validates the program's motion. Only 7 and 8 say anything about
material, and until 7 exists, `AGENTS.md:73` stands exactly as written.

⚠ **Rung 4 needs a physical e-stop within reach before it is attempted** (§16). That
is a precondition, not a nice-to-have, and it is `ops`' call whether it is satisfied.

---

## 20. Sources

All read **2026-08-10**.

**grblHAL — source of truth for controller behaviour** (<https://github.com/grblHAL/core>)
- `grbl.h` — realtime command bytes (`:103-156`), override limits (`:185-212`), version/build (`:41-45`)
- `stream.h` — `RX_BUFFER_SIZE 1024`, `TX_BUFFER_SIZE 512` (`:51-60`)
- `report.c` — status report construction (`:1204-1545`), init banner (`:307-314`), `$I` (`:868-886`), `FW:grblHAL` (`:1538-1541`), WCO/override refresh (`:1396-1428`)
- `protocol.c` — main loop and boot alarms (`:120-200`), line handling and **error persistence** (`:236-300`), realtime dispatch (`:840-975`), `LINE_BUFFER_SIZE` via `protocol.h:36`
- `system.c` — `$X` (`disable_lock`, `:446-461`), `check_status` (`:413-443`), `$H` (`go_home`, `:480-510`, state check at `:486`)
- `machine_limits.c` — `limits_homing_required()` (`:668-673`)
- `motion_control.c` — `mc_reset()` (`:1170-1204`), `mc_dwell()` (`:839-845`)
- `gcode.c` — target vs distance mode (`:3046-3050`), `G10 L20` (`:2864-2956`), `M0` → feed hold (`:4696-4701`), G41/G42 absent (`:2777-2780`), canned cycles (`:1559`)
- `alarms.c` / `alarms.h` — the alarm table and its numbering
- `errors.c` / `errors.h` — the error table and its numbering
- `settings.h` / `settings.c` / `config.h` — `$10` mask (`settings.h:634-653`), `$22` bits (`:693-709`), setting ids, defaults (`config.h:600-750`, `:225-244`, `:892-893`)

**grblHAL wiki** (<https://github.com/grblHAL/core/wiki>)
- `Report-extensions` — the realtime report grammar, `Pn`/`A` letters, `0x87`
- `Changes-from-grbl-1.1` — **error persistence**, homing, tool changes, compatibility levels
- `Manual-tool-change-protocol` — the `Tool` state and `0xA3`
- `Manual,-semi-automatic-and-automatic-tool-change` — `$341` modes

**grbl v1.1** (<https://github.com/gnea/grbl>) — the interface grblHAL descends from
- `doc/markdown/interface.md` — report structure, states, `WPos = MPos - WCO`
- `doc/markdown/commands.md` — `$X`, `$H`, `?`, ctrl-X semantics
- `doc/markdown/settings.md` — `$10`/`$13`/`$20`-`$27`, and grbl's `$10=1` default
- `doc/markdown/jogging.md` — `$J=`, jog cancel, the incremental-jog UI pattern
- `doc/script/stream.py` — the two streaming protocols, `RX_BUFFER_SIZE = 128`

**grblHAL STM32F4xx driver** (<https://github.com/grblHAL/STM32F4xx>)
- `Inc/my_machine.h:27-30` — `BOARD_BTT_SKR_PRO_1_1` / `_1_2`
- `Inc/driver.h:146-163` — board map selection
- `Src/usb_serial.c:50-55` — USB CDC RX free space

**Web platform**
- <https://wicg.github.io/serial/> — secure context, transient activation, `NetworkError` on disconnect, `bufferSize` default 255, worker exposure, `forget()`
- <https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API> — interfaces, events, worker availability
- <https://caniuse.com/web-serial> — support table ⚠ read with the caveat in §1
- <https://github.com/WebKit/standards-positions/issues/199> — WebKit: opposed
- <https://github.com/mozilla/standards-positions/issues/336> — Mozilla: neutral
- <https://developer.chrome.com/blog/timer-throttling-in-chrome-88> — timer throttling tiers and exemptions

**This repo**
- `core/src/post_grblhal.rs` — the post
- `core/src/types.rs:766, :792-793` — `safe_z_mm 5.0`, `probe_max_mm 30.0`, `probe_retract_mm 2.0`
- `target/probe-gate/xyz-front-left.nc` — the emitted probe program F1 was read off
- `tools/controller_probe.py`, `gates/controller/README.md` — the existing controller harness (F6, F7)
- `gates/slicer_gate_check.mjs:198-253` — the gate table and the PENDING budget
- `SLICER-GATES.md` — the verdict contract, and why a PENDING must not read as a GO
- `AGENTS.md` — the standing rules this memo is written under
