#!/usr/bin/env python3
"""
Ask a REAL controller whether it accepts what this program emits.

This is the rung below an air cut, and it is the first rung this lane has ever
been able to climb: every dialect claim in `SLICER-GATES.md` gate G2 is measured
against grblHAL's *published reference*, never against a board. A board can
disagree with its own documentation — canned cycles (`G81`-`G89`) are a
compile-time option, so a build without them answers `error:20` to the `G83`
this post emits, and nothing upstream would have known.

What a green transcript from this script proves:

  * every line of the emitted program was ACCEPTED by that controller, that
    build, those settings.

What it does NOT prove, and must never be written up as proving:

  * that anything moved. Acceptance is a parse, not a motion.
  * that the feeds, depths or speeds are right for any material.
  * that a part came out. Air cut -> coupon -> ply are still unclimbed.

SAFETY — read before running on anything that can move.

  The controller does not know what is wired to it. On a bare board this
  streams harmlessly: the pins toggle and nothing is attached to them. On a
  wired machine THE SAME PROGRAM DRIVES THE GANTRY AND STARTS THE SPINDLE,
  because that is what the program says to do.

  So `--rig` is mandatory and is recorded in the transcript. `--rig bare`
  asserts: no motors, no drivers powered, no spindle/VFD. Anything else
  requires `--allow-motion` as well, which this script will not infer for you.

  🔴 THE SAME OPT-IN NOW COVERS THE HANDSHAKE, and until 2026-08-11 it did
  not. This script used to write `$I` and `$$` the moment the port opened —
  before anything had classified the firmware, and with the banner
  classification computed on the line above and then discarded. `--rig` exists
  because a write whose worst case is unbounded is opted into rather than
  defaulted, and the handshake writes are exactly that: `$` is not a universal
  no-op, and on some firmwares it prefixes a parameter WRITE. So the port now
  opens, listens, and writes nothing at all until either the board has
  identified itself unprompted or `--identify-probe` says otherwise.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

try:
    import serial  # pyserial
except ImportError:  # pragma: no cover - environment-dependent
    serial = None


# ───────────────────────────────────────────────────────────────────────────
# Identification — the same ladder the browser uses, in the same order
# ───────────────────────────────────────────────────────────────────────────
#
# 🔴 `"grbl"` AS A SUBSTRING IS NOT A TEST FOR grblHAL, and this file used to
# treat it as one. Every grblHAL banner contains it, and so does every grbl
# 1.1 banner: `GrblHAL 1.1f [...]` and `Grbl 1.1f [...]` both match, and the
# script then streamed a grblHAL program at whichever it was. The two are not
# interchangeable — RX buffer size, alarm codes and error persistence all
# differ — and a transcript recording "accepted" by the wrong one is evidence
# for a dialect claim that was never tested.
#
# The discriminator is `FW:grblHAL`, a field grbl 1.1 does not have, appended
# only to a FULL status report requested with `0x87` (`report.c:1538-1541`).
# This is the same ladder as `web/src/run/protocol.ts::identify`, in the same
# order, weakest evidence last:
#
#   1. `FW:grblHAL` in a `<...>` report   → grblHAL     (everything)
#   2. a `GrblHAL ` startup banner        → grblHAL     (everything)
#   3. Marlin markers                     → marlin      (nothing)
#   4. a `Grbl ` banner, or `[VER:`+`[OPT:` with no FW → grbl (read-only)
#   5. nothing recognised                 → unknown     (nothing)
#
# ⚠ Step 4 is where `[VER:`/`[OPT:` live, NOT step 1. They are what `$I`
# answers on both firmwares, so on their own they establish the family and not
# the member.
MARLIN_MARKERS = ("echo:", "marlin", "ok t:")
GRBLHAL_BANNER = re.compile(r"^grblhal\s", re.I)
GRBL_BANNER = re.compile(r"^grbl\s", re.I)


def report_fw(line: str) -> str | None:
    """
    The `FW:` field of a grblHAL status report, or `None`.

    Deliberately narrower than `protocol.ts::parseStatusReport`: this reads the
    one field the identification turns on and does not pretend to parse the
    report. It still requires the `<...>` envelope, because `FW:grblHAL`
    appearing in some other firmware's free text is not the controller
    answering a status request.
    """
    t = line.strip()
    if not (t.startswith("<") and t.endswith(">")):
        return None
    for f in t[1:-1].split("|"):
        if f.startswith("FW:"):
            return f[3:]
    return None


@dataclass(frozen=True)
class Identification:
    """
    What the board is, what that permits, and what it actually said.

    🔴 `heard` IS THE FIELD THAT USED TO BE MISSING, and its absence is why the
    refusal below could assert something untrue. There are THREE states, not
    two: the port was silent, the port spoke and was recognised, the port spoke
    and was not recognised. The first and third both used to render `unknown`
    with the sentence *"could not identify the firmware from the banner or
    `$I`"* — which claims `$I` was asked and answered when, on the silent
    branch, nothing had arrived and (after this change) nothing had been sent
    either. The received lines were held in `banner`/`blob` and thrown away.

    They send a human to completely different places: silence is a cable, a
    port, a baud rate or a controller that booted before this script opened the
    port; speech is a fact about the firmware.
    """

    verdict: str  # 'grblHAL' | 'grbl' | 'marlin' | 'unknown'
    heard: str  # 'silence' | 'speech'
    permits: str  # 'everything' | 'read-only' | 'nothing'
    evidence: str
    why: str
    received: tuple[str, ...] = field(default=())


def identify(lines: list[str], plant: str | None = None) -> Identification:
    """
    Classify the firmware from everything received so far.

    ⚠ **Absence of a banner is not evidence of anything.** grblHAL and Marlin
    both print theirs at power-on only, so a board that has been running for an
    hour says nothing at all. That is why silence gets its own branch and why
    it is the one state this script will not conclude from.

    :param plant: negative control, see ``PLANTS``.
    """
    received = tuple(lines)
    heard = "silence" if not lines else "speech"

    if plant == "accept-anything":
        return Identification("grblHAL", heard, "everything", "planted", "planted", received)

    for line in lines:
        fw = report_fw(line)
        if fw and "grblhal" in fw.lower():
            return Identification(
                "grblHAL",
                heard,
                "everything",
                f"FW:{fw} in a full status report",
                "The controller identified itself as grblHAL in a field grbl 1.1 does not have.",
                received,
            )

    lower = [l.strip().lower() for l in lines]

    if plant == "grbl-is-grblhal":
        # The defect this file shipped with: `"grbl"` anywhere in the reply
        # text, and grbl 1.1 is indistinguishable from grblHAL.
        if any("grbl" in l for l in lower):
            return Identification(
                "grblHAL", heard, "everything", "planted: the substring 'grbl'", "planted", received
            )

    if any(GRBLHAL_BANNER.match(l) for l in lower):
        return Identification(
            "grblHAL",
            heard,
            "everything",
            "a GrblHAL startup banner",
            "The controller announced itself as GrblHAL.",
            received,
        )

    if any(any(m in l for m in MARLIN_MARKERS) for l in lower):
        return Identification(
            "marlin",
            heard,
            "nothing",
            "Marlin markers (echo:/Marlin) in the reply",
            "This board answers as Marlin, not grblHAL. The post emits a grblHAL dialect; "
            "streaming it here would measure the wrong firmware and every rejection would be "
            "meaningless.",
            received,
        )

    has_ver = any("[ver:" in l for l in lower)
    has_opt = any("[opt:" in l for l in lower)
    grbl_banner = any(GRBL_BANNER.match(l) for l in lower)
    if grbl_banner or (has_ver and has_opt):
        return Identification(
            "grbl",
            heard,
            "read-only",
            "a Grbl banner with no FW:grblHAL" if grbl_banner else "[VER: and [OPT: with no FW:grblHAL",
            "This reports as grbl 1.1, not grblHAL. Our post targets grblHAL and the differences "
            "are not cosmetic — RX buffer size, alarm codes and error persistence all differ. "
            "A transcript of grbl 1.1 accepting these lines is not evidence about grblHAL, which "
            "is the only firmware gate G2's dialect claims are about.",
            received,
        )

    if plant == "merge-unknowns":
        # The defect this file shipped with: one label for two states, and a
        # sentence asserting `$I` was answered when nothing had arrived. `heard`
        # is forced to one value because that IS the defect — a silent port and
        # a board that spoke unrecognisably rendered identically.
        return Identification(
            "unknown",
            "silence",
            "nothing",
            "planted: one label for two states",
            "could not identify the firmware from the banner or $I",
            received,
        )

    if heard == "silence":
        return Identification(
            "unknown",
            heard,
            "nothing",
            "the port opened and NOTHING arrived — no banner, no report, not one byte",
            "Silence is not evidence about this board. grblHAL and Marlin both print their banner "
            "only at power-on, so a controller that has been running for hours says nothing until "
            "it is reset — and a dead cable, the wrong port and the wrong baud rate all look "
            "exactly like this too. Reset or power-cycle the controller and it will announce "
            "itself; nothing has been written to this port.",
            received,
        )

    quoted = " ".join(json.dumps(l) for l in received)
    return Identification(
        "unknown",
        heard,
        "nothing",
        f"nothing identifiable in the {len(received)} line(s) received: {quoted}",
        "This device spoke and none of it identifies the firmware. That IS a fact about the "
        "board, unlike silence. The raw bytes are above so a human can identify it.",
        received,
    )


# ───────────────────────────────────────────────────────────────────────────
# The probe, and why sending it is the OPERATOR'S decision
# ───────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class ProbeStep:
    """One thing the identification probe would put on the wire."""

    bytes_: str
    asks: str
    on_unknown_firmware: str


#: 🔴 THE THREE THINGS THIS SCRIPT USED TO SEND TO AN UNIDENTIFIED CONTROLLER.
#:
#: `$I` and `$$` went out unconditionally the moment the port opened, with the
#: banner classification computed above them and then ignored. They are still
#: the right probe. What changed is who decides: this list is PRINTED byte for
#: byte, and it goes on the wire only behind `--identify-probe`.
#:
#: ⚠ "Read-only" is a fact about grblHAL and about nothing else.
IDENTIFY_PROBE: tuple[ProbeStep, ...] = (
    ProbeStep(
        "$I\\n",
        "the build-info block — grblHAL answers [VER:…] and [OPT:…] then ok (report.c:868, 883).",
        "a `$` line of unknown meaning. On some firmwares `$` prefixes a SETTING WRITE, so this is "
        "the step whose worst case is not noise.",
    ),
    ProbeStep(
        "0x87 (ONE byte, no newline)",
        "a full status report, the only one that carries FW:grblHAL — the strongest positive "
        "identification there is, because grbl 1.1 has no such field (report.c:1543-1545).",
        "one byte in the 0x80–0xFF range. grblHAL treats that range as realtime commands; anything "
        "else may treat it as data, as a command of its own, or as a framing error.",
    ),
    ProbeStep(
        "$$\\n",
        "every setting, so $10 (report mask), $13 (units), $22 (homing) and $481 (auto-report) can "
        "be recorded in the transcript.",
        "a second `$` line, with the same worst case as the first.",
    ),
)


#: The probe itself, in wire order, matching ``IDENTIFY_PROBE`` step for step.
#:
#: ⚠ **A separate list from the one the operator reads, and the self-test
#: asserts they agree.** They have to be separate — one is prose about bytes,
#: the other is bytes — and the moment a step changes in only one of them, the
#: operator authorises one thing while another goes out. That is a worse
#: position than never having asked, so the agreement is checked rather than
#: maintained by care. ``'line'`` is written with a newline; ``'byte'`` is one
#: raw byte with none.
PROBE_WRITES: tuple[tuple[str, object], ...] = (
    ("line", "$I"),
    ("byte", 0x87),
    ("line", "$$"),
)


def describe_probe(probe: tuple[ProbeStep, ...] = IDENTIFY_PROBE) -> str:
    """
    🔴 Consent to bytes nobody listed is not consent.

    Rendered from ``IDENTIFY_PROBE`` rather than written beside it, so the text
    an operator reads cannot drift from what {@link PROBE_WRITES} puts on the
    wire — authorising one thing while another goes out is worse than never
    having asked.
    """
    out = [
        "Nothing has been written to this port. Asking this board to identify itself means",
        "writing to firmware nobody has classified, so here is exactly what would go out:",
    ]
    for s in probe:
        out.append(f"    {s.bytes_}  — {s.asks}")
        out.append(f"        on unidentified firmware: {s.on_unknown_firmware}")
    out.append(
        "🔴 'Read-only' above is a fact about grblHAL and about nothing else. `$` is not a "
        "universal no-op — on some firmwares it prefixes a parameter WRITE. The zero-risk "
        "alternative is to RESET or power-cycle the controller, which makes it announce itself "
        "and needs no bytes from us. Re-run with --identify-probe to send the three steps above."
    )
    return "\n".join(out)


def connect_writes(plant: str | None = None) -> list[str]:
    """
    🔴 **WHAT GOES ON THE WIRE WHEN THE PORT OPENS: NOTHING.**

    This returns an empty list and the emptiness is the fix. `--identify-probe`
    is what moves these bytes back onto the wire, and it is an argument a human
    types.

    :param plant: ``'probe-unasked'`` restores the pre-2026-08-11 behaviour.
    """
    if plant == "probe-unasked":
        return [f"{kind}:{payload}" for kind, payload in PROBE_WRITES]
    return []


PLANTS = ("accept-anything", "grbl-is-grblhal", "merge-unknowns", "probe-unasked")


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class Controller:
    def __init__(self, port: str, baud: int, timeout: float):
        if serial is None:
            raise SystemExit(
                "pyserial is not installed. On the control Pi:\n"
                "  sudo apt install python3-serial   # or: pip install pyserial"
            )
        self.ser = serial.Serial(port, baud, timeout=timeout)
        self.timeout = timeout

    def close(self) -> None:
        self.ser.close()

    def drain(self, seconds: float) -> list[str]:
        """Everything the controller says unprompted — the banner lives here."""
        out: list[str] = []
        end = time.time() + seconds
        while time.time() < end:
            line = self.ser.readline().decode("utf-8", "replace").strip()
            if line:
                out.append(line)
        return out

    def send(self, line: str, wait_ok: bool = True) -> dict:
        """
        Send one line and collect the reply.

        grblHAL answers each line with `ok` or `error:N`, and may interleave
        unsolicited `[...]` / `<...>` reports. Those are captured but are not
        the verdict — reading the first line back as the answer would score a
        status report as an acceptance.
        """
        self.ser.write((line + "\n").encode("ascii", "replace"))
        self.ser.flush()
        replies: list[str] = []
        verdict = None
        deadline = time.time() + self.timeout
        while wait_ok and time.time() < deadline:
            reply = self.ser.readline().decode("utf-8", "replace").strip()
            if not reply:
                continue
            replies.append(reply)
            low = reply.lower()
            if low == "ok" or low.startswith("error:") or low.startswith("alarm:"):
                verdict = reply
                break
        return {"sent": line, "replies": replies, "verdict": verdict}

    def send_realtime(self, byte: int, listen: float = 1.0) -> list[str]:
        """
        One raw byte, no newline, and no `ok` is expected.

        grblHAL's realtime commands are picked off the input stream and are not
        lines: they are never answered with `ok`, so waiting for one here would
        time out on a controller behaving perfectly. `0x87` answers with a full
        `<...>` status report instead, which is what {@link identify} reads.
        """
        self.ser.write(bytes([byte]))
        self.ser.flush()
        return self.drain(listen)


def code_lines(text: str) -> list[str]:
    """
    Motion lines only.

    Comment lines are dropped rather than streamed: they are legal G-code, but
    a controller that echoes or rejects a comment tells us nothing about the
    dialect, and the reply stream stays readable without them.
    """
    out = []
    for raw in text.split("\n"):
        line = raw.strip()
        if not line or line.startswith("("):
            continue
        out.append(line)
    return out


# ───────────────────────────────────────────────────────────────────────────
# The self-test — the half of this script a box with no controller can check
# ───────────────────────────────────────────────────────────────────────────
#
# 🔴 THE THREE DEFECTS THIS FILE SHIPPED WITH WERE ALL IN CODE THAT NEEDED NO
# HARDWARE, and none of them was reachable by any check. The ladder is a pure
# function of the reply lines and `connect_writes` is a pure function of a
# flag, so both are testable here, on a box with no USB cable — which is the
# box every one of those defects was written on.
#
# ⚠ Every case names the PLANT that must turn it red. A case no plant can fail
# is a case that proves nothing, and the plants are the reason this is a
# control rather than a formality.
#
#   (name, reply lines, expected verdict, expected heard, expected permits)
LADDER_CASES: tuple[tuple[str, list[str], str, str, str], ...] = (
    (
        "a full report carrying FW:grblHAL is grblHAL",
        ["<Idle|MPos:0.000,0.000,0.000|Bf:1024,100|FS:0,0|FW:grblHAL>"],
        "grblHAL",
        "speech",
        "everything",
    ),
    (
        "a GrblHAL banner is grblHAL",
        ["GrblHAL 1.1f ['$' or '$HELP' for help]"],
        "grblHAL",
        "speech",
        "everything",
    ),
    (
        # 🔴 THE CASE THE OLD SUBSTRING TEST COULD NOT SEE. `grbl-is-grblhal`
        # is the old behaviour verbatim, and it turns this row red.
        "a Grbl 1.1 banner is grbl, NOT grblHAL",
        ["Grbl 1.1f ['$' for help]"],
        "grbl",
        "speech",
        "read-only",
    ),
    (
        "[VER: and [OPT: without FW: establish the family, not the member",
        ["[VER:1.1f.20260811:]", "[OPT:VNS,35,1024,3,0]", "ok"],
        "grbl",
        "speech",
        "read-only",
    ),
    (
        "Marlin is refused",
        ["echo:Unknown command: \"$I\"", "ok"],
        "marlin",
        "speech",
        "nothing",
    ),
    (
        # 🔴 TWO REFUSALS, NOT ONE. `merge-unknowns` collapses this pair back
        # into the single label and turns both rows red.
        "a SILENT port is unknown/silence",
        [],
        "unknown",
        "silence",
        "nothing",
    ),
    (
        "a port that SPOKE unrecognisably is unknown/speech",
        ["BLACK_F407VE ready", "?!?"],
        "unknown",
        "speech",
        "nothing",
    ),
    (
        # 🔴 THE BOARD ON THE BENCH, in its own words (`TODO.md` #114): it
        # answered `M115` with `FIRMWARE_NAME:Marlin bugfix-2.0.x` and answers
        # both `$I` and `$$` with `echo:Unknown command:`. grblHAL was never
        # flashed on it. This is the one case in the table that is a
        # measurement of a real device rather than a constructed example —
        # and it is the case the old substring ladder got closest to getting
        # wrong, because `echo:Unknown command: "$I"` is what a REFUSAL of our
        # probe looks like and it must not read as a dialect failure.
        "the real bench board (Marlin) is refused, on the reply to our own probe",
        ["echo:Unknown command: \"$I\"", "ok", "echo:Unknown command: \"$$\"", "ok"],
        "marlin",
        "speech",
        "nothing",
    ),
)


def self_test(plant: str | None = None) -> int:
    """Run the ladder and the wire-silence property. 0 = green, 1 = red."""
    failures: list[str] = []

    for name, lines, verdict, heard, permits in LADDER_CASES:
        got = identify(lines, plant)
        actual = (got.verdict, got.heard, got.permits)
        want = (verdict, heard, permits)
        if actual != want:
            failures.append(f"{name}\n      wanted {want}, got {actual}")
        elif got.heard == "silence" and "$I" in got.why:
            # The sentence that used to assert `$I` was answered when nothing
            # had arrived — and, since 2026-08-11, when nothing had been sent.
            failures.append(f"{name}\n      the silent refusal still cites $I: {got.why!r}")
        elif got.heard == "speech" and got.permits == "nothing" and not got.received:
            failures.append(f"{name}\n      a refusal that shows none of what it heard")

    # 🔴 THE PROPERTY THE BROWSER FIX IS ABOUT: opening the port writes nothing.
    # `probe-unasked` restores the pre-fix behaviour and turns this red.
    wrote = connect_writes(plant)
    if wrote:
        failures.append(f"connect writes before any verdict: {wrote}")

    # And the consent text must be rendered FROM the probe, so it cannot
    # describe bytes other than the ones that go out.
    text = describe_probe()
    for step in IDENTIFY_PROBE:
        if step.bytes_ not in text:
            failures.append(f"the consent text does not list {step.bytes_!r}")

    # 🔴 THE TWO LISTS MUST AGREE, STEP FOR STEP. `IDENTIFY_PROBE` is what the
    # operator READS and `PROBE_WRITES` is what goes on the WIRE. Nothing about
    # the language forces them to match, and a consent screen that describes
    # different bytes from the ones sent converts an informed decision into a
    # mis-informed one. Checked here rather than trusted to care.
    if len(PROBE_WRITES) != len(IDENTIFY_PROBE):
        failures.append(
            f"the probe sends {len(PROBE_WRITES)} step(s) and describes {len(IDENTIFY_PROBE)}"
        )
    else:
        for (kind, payload), step in zip(PROBE_WRITES, IDENTIFY_PROBE):
            shown = step.bytes_.lower()
            wanted = f"{int(payload):#04x}" if kind == "byte" else str(payload).lower()
            if wanted not in shown:
                failures.append(
                    f"step sends {kind} {payload!r} and the operator is shown {step.bytes_!r}"
                )

    label = f" (plant={plant})" if plant else ""
    if failures:
        print(f"VERDICT: RED — {len(failures)} failure(s){label}", file=sys.stderr)
        for f in failures:
            print(f"  · {f}", file=sys.stderr)
        return 1
    print(f"VERDICT: GREEN — {len(LADDER_CASES)} ladder case(s) + 3 properties{label}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument(
        "program",
        type=Path,
        nargs="?",
        help="emitted G-code file to offer to the controller",
    )
    ap.add_argument("--port", default="/dev/ttyACM0", help="serial device (default /dev/ttyACM0)")
    ap.add_argument("--baud", type=int, default=115200)
    ap.add_argument("--timeout", type=float, default=10.0, help="seconds to wait for a reply per line")
    ap.add_argument(
        "--rig",
        choices=("bare", "motors", "spindle"),
        help="REQUIRED (except with --self-test). What is physically connected, RECORDED IN THE "
        "TRANSCRIPT. 'bare' = board only: no motors, no drivers powered, no VFD/spindle.",
    )
    ap.add_argument(
        "--allow-motion",
        action="store_true",
        help="required with --rig motors|spindle. The program WILL move the machine.",
    )
    ap.add_argument(
        "--identify-probe",
        action="store_true",
        help="authorise the three identification writes ($I, 0x87, $$) when the port opens and "
        "stays SILENT. Same shape as --allow-motion: a write with an unbounded worst case is "
        "opted into, never defaulted. Without it a silent port is refused and the bytes are "
        "printed so the decision can be made with them in view.",
    )
    ap.add_argument(
        "--self-test",
        action="store_true",
        help="run the identification ladder against recorded reply sets and exit. No serial port "
        "is opened and no byte is written — this is the half of the script that can be checked "
        "on a box with no controller on it.",
    )
    ap.add_argument(
        "--plant",
        choices=PLANTS,
        help="negative control: inject a named defect so --self-test is watched go RED. "
        "A control nobody has seen fail is not a control. Never use it on a real run.",
    )
    ap.add_argument("--unlock", action="store_true", help="send $X first (WARNING: grblHAL REFUSES $X with error:46 when homing is required — run $H instead)")
    ap.add_argument("--out", type=Path, help="write the transcript JSON here")
    ap.add_argument(
        "--program-command",
        default="",
        help="the 2bee-slice argv that produced this program, e.g. 'job pocket'. "
        "The gate re-emits it and compares hashes — a transcript for a program the "
        "build no longer emits is stale evidence, and stale evidence reads as proof.",
    )
    ap.add_argument("--operator", default="", help="who ran it — the transcript is evidence, evidence has an author")
    args = ap.parse_args()

    if args.self_test:
        return self_test(args.plant)

    # 🔴 A PLANT MAY NOT REACH A REAL RUN. `--plant probe-unasked` exists to
    # put bytes on a wire that must stay quiet; the only place it is allowed to
    # do that is a test with no serial port behind it.
    if args.plant:
        print(
            f"REFUSED: --plant {args.plant} is a negative control for --self-test and has no "
            "meaning against a controller. It would make this script do the thing it refuses.",
            file=sys.stderr,
        )
        return 2

    if args.program is None:
        print("REFUSED: no program given. (Use --self-test to check the ladder.)", file=sys.stderr)
        return 2
    if args.rig is None:
        print("REFUSED: --rig is required — it is recorded in the transcript.", file=sys.stderr)
        return 2
    if args.rig != "bare" and not args.allow_motion:
        print(
            f"REFUSED: --rig {args.rig} means this program can move the machine, "
            "and --allow-motion was not given.",
            file=sys.stderr,
        )
        return 2

    # ── THE TRANSCRIPT'S TWO UNSKIPPABLE FIELDS ────────────────────────────
    #
    # 🔴 THIS SCRIPT ONCE WROTE EVIDENCE ITS ONLY CONSUMER REFUSES TO READ, AND
    # SAID NOTHING. On 2026-08-20 a real grblHAL 1.1f board on a bare rig was
    # sent `fixture rect-profile` and answered 47 of 50 lines. The transcript
    # was written, cited in `docs/cnc-controller-status.md`, and is **unusable**:
    # `--program-command` was optional and was not passed, so `program_command`
    # is `""` — and gate CTRL's FIRST check is
    #
    #     if (!cmd) `${f}: no program_command — cannot re-emit, so cannot be
    #                checked for staleness`
    #
    # CTRL re-emits that argv and compares sha256 against the transcript,
    # because a transcript for a program the build no longer emits is stale
    # evidence and stale evidence reads exactly like proof. With the field empty
    # there is no way to ask the question, so the whole run cannot be counted —
    # a board was found, wired, flashed and driven, and the result is inadmissible.
    #
    # ⚠ AND IT IS NOT RECOVERABLE AFTERWARDS. The value can be *inferred* — the
    # 08-20 transcript's `program_sha256` matches `fixture rect-profile` from
    # this build byte for byte, measured 2026-08-27 — but writing an inferred
    # value into a record of what a machine said is forging custody, not fixing
    # a typo. The field has to be captured at the moment the bytes go out, which
    # is here, which is why this refusal is here and not a note in a README.
    #
    # `--operator` rides the same refusal for the same reason its own help text
    # already gives: *evidence has an author*. An optional author is an author
    # nobody supplies, and an unattributed transcript cannot be questioned by
    # the one person who could answer.
    #
    # Placed BEFORE the port opens: a run refused for a missing label must not
    # first put bytes on a wire.
    missing = [
        flag
        for flag, value in (("--program-command", args.program_command), ("--operator", args.operator))
        if not str(value).strip()
    ]
    if missing:
        print(
            f"REFUSED: {' and '.join(missing)} not given, and a transcript without "
            f"{'them' if len(missing) > 1 else 'it'} is evidence nothing can read.",
            file=sys.stderr,
        )
        print(
            "  --program-command  the 2bee-slice argv that produced this program (e.g. "
            "'fixture rect-profile'). Gate CTRL RE-EMITS it and compares sha256; with the "
            "field empty CTRL cannot tell current evidence from stale and refuses the file.",
            file=sys.stderr,
        )
        print(
            "  --operator         who ran it. A transcript is a claim about a physical event; "
            "the only way to check one is to ask the person who was standing there.",
            file=sys.stderr,
        )
        print(
            "  This is why gates/ctrl-transcript-2026-08-20.json — a real board, 47 of 50 "
            "lines answered — has never been admissible.",
            file=sys.stderr,
        )
        return 2

    program_bytes = args.program.read_bytes()
    program_hash = sha256(program_bytes)
    lines = code_lines(program_bytes.decode("utf-8", "replace"))

    ctl = Controller(args.port, args.baud, args.timeout)
    try:
        # ── STEP 1 OF §11 AND NOTHING ELSE: LISTEN. ────────────────────────
        # `connect_writes()` is empty and that emptiness is the point. The
        # firmware is established from what the board says UNPROMPTED; every
        # write below is behind either a verdict or an explicit flag.
        for probe_line in connect_writes():
            ctl.send(probe_line)  # empty by construction — see connect_writes
        banner = ctl.drain(2.0)
        probe_replies: list[str] = []
        heard_lines = list(banner)
        ident = identify(heard_lines)
        probed = False

        # ── The one state that permits asking: silence, and only once. ─────
        # Silence says nothing about the board — a grblHAL controller that
        # booted before this script opened the port is silent, and so is a dead
        # cable. Speech that was not recognised IS a fact about the firmware,
        # so it is refused rather than probed: writing to a board that has
        # already demonstrated it is not ours buys nothing.
        if ident.permits == "nothing" and ident.heard == "silence":
            if not args.identify_probe:
                print("REFUSED: the port opened and nothing arrived.", file=sys.stderr)
                print(describe_probe(), file=sys.stderr)
                return 3
            # Driven FROM `PROBE_WRITES`, not written out again beside it — the
            # printed consent and the wire have one source between them, and
            # the self-test asserts the two lists still agree.
            for kind, payload in PROBE_WRITES:
                if kind == "byte":
                    probe_replies += ctl.send_realtime(int(payload))  # type: ignore[arg-type]
                else:
                    probe_replies += ctl.send(str(payload))["replies"]
            probe_replies += ctl.drain(1.5)
            heard_lines += probe_replies
            probed = True
            ident = identify(heard_lines)

        firmware = ident.verdict
        if ident.permits == "nothing":
            print(f"REFUSED ({ident.verdict}): {ident.evidence}", file=sys.stderr)
            print(ident.why, file=sys.stderr)
            if probed and ident.heard == "silence":
                print(
                    "The probe went out and the port stayed silent. There is nothing further to "
                    "ask with.",
                    file=sys.stderr,
                )
            return 3
        if ident.permits == "read-only":
            # 🔴 NOT A STREAM. This script exists to record a controller
            # accepting the lines our post emits, and gate CTRL reads that
            # transcript as evidence about the grblHAL dialect. grbl 1.1
            # accepting them is a true fact about a different firmware, and a
            # transcript saying "accepted" without saying "by what" is exactly
            # the green this whole harness was built to remove.
            print(f"REFUSED ({ident.verdict}): {ident.evidence}", file=sys.stderr)
            print(ident.why, file=sys.stderr)
            return 3

        # ── AFTER THE VERDICT: the settings read. ─────────────────────────
        # `$$` is not dropped, it is re-ordered. It used to be step 2 of a
        # handshake that had already written to an unidentified board, so
        # nothing about its position was load-bearing; here it runs against
        # firmware that has been classified, which is the only state in which
        # "reading `$$` is safe" is a fact rather than a hope.
        # ⚠ SKIPPED ENTIRELY if the operator already authorised the probe. The
        # probe IS steps 2-4; re-running them would put two more `$` lines on
        # the wire to record facts already in hand, and "we only write what we
        # need to" is not a claim that survives writing the same thing twice.
        if probed:
            build_info = probe_replies
            settings_dump = probe_replies
        else:
            build_info = ctl.send("$I")["replies"]
            # `$$` answers with one line per setting and then `ok`; the
            # per-setting lines arrive as unsolicited traffic on the next reads.
            settings_dump = ctl.send("$$")["replies"] + ctl.drain(1.5)

        if args.unlock:
            # 🔴 grblHAL refuses $X with error:46 when homing is required
            # (system.c:446-460, `limits_homing_required()` guards the unlock).
            # After any error every subsequent line returns error:9 (alarm lock),
            # so a transcript taken in this state reads as total dialect failure
            # when the truth is one un-homed machine.
            #
            # ⚠ $X does NOT clear the boot alarm. On grblHAL with `$22` bit 2
            # (init_lock) set, `$X` returns error:46 ("Home machine to continue.")
            # and no amount of retrying changes that. Soft-reset clears the alarm
            # lock for OTHER alarm types (1, 3, etc.) where position may have been
            # lost — but for alarm 11 (HomingRequired) it does not, unless `$22`
            # bit 6 (override_locks) is also set, which is not the default.
            unlock_result = ctl.send("$X")
            v = (unlock_result["verdict"] or "").lower()
            if v and "ok" not in v:
                if "error:46" in v or "home machine" in v:
                    # Homing required — $X is refused, period. Do not retry.
                    print(
                        f"REFUSED: --unlock failed ({unlock_result['verdict']}). "
                        "This machine requires homing before $X can clear the alarm "
                        "(grblHAL error:46, Status_HomingRequired). Run $H first. "
                        "A transcript taken now would attribute every line to a dialect "
                        "rejection when the real cause is one un-homed machine.",
                        file=sys.stderr,
                    )
                    return 3
                # Other alarms — soft-reset clears the alarm lock on grblHAL
                # (position may have been lost; the transcript records this).
                ctl.send_realtime(0x18, listen=2.0)
                time.sleep(0.5)
                unlock_result = ctl.send("$X")
            if unlock_result["verdict"] and "ok" not in unlock_result["verdict"].lower():
                print(
                    f"REFUSED: --unlock failed ({unlock_result['verdict']}). "
                    "The controller is in alarm and $X cannot clear it — likely needs homing. "
                    "A transcript taken now would attribute every line to a dialect rejection "
                    "when the real cause is one alarm state.",
                    file=sys.stderr,
                )
                return 3

        results = []
        errors = []
        # 🔴 A LINE THE BOARD NEVER ANSWERED IS NOT A LINE IT REJECTED, and this
        # tool called both "rejected" until 2026-09-06.  The 2026-08-20
        # transcript records M5 / G0 Z5.000 / M30 with `replies: []` and
        # `verdict: null` — the board stopped talking — and reported them under
        # `rejections`.  AGENTS.md had to correct a doc that repeated the word,
        # saying: *"Rejected by grblHAL" reads as a dialect defect in OUR post
        # and would send the next reader into post_grblhal.rs; a dead link
        # mid-program is a wiring fault on the bench.*
        # ⇒ THE CORRECTION REACHED THE PROSE AND NOT THE PRODUCER, so the next
        # transcript would have said it again.  The two are now separate buckets
        # and separate counts; `rejected` means the board disagreed.
        unanswered = []
        alarm_poisoned = False
        for line in lines:
            r = ctl.send(line)
            results.append(r)
            v = (r["verdict"] or "").lower()
            if v != "ok":
                (unanswered if (v == "" and not r.get("replies")) else errors).append(r)
                # 🔴 grblHAL poisons every line after an error — the controller
                # returns error:9 (alarm lock) for all subsequent commands.  One
                # real rejection plus N copies of it overstates the failures and
                # misattributes the cause.  Detect the pattern: if we get a
                # non-ok verdict and the next line also fails, the controller is
                # in alarm, not rejecting the dialect.
                if not alarm_poisoned and (v.startswith("error:") or v.startswith("alarm:") or v == ""):
                    # Probe: send a no-op and check.  A timeout (v=="") may
                    # also indicate alarm state — grblHAL in alarm sometimes
                    # stops responding rather than returning error:9.
                    probe = ctl.send("$I")
                    probe_v = (probe["verdict"] or "").lower()
                    if probe_v != "ok":
                        alarm_poisoned = True
                        print(
                            f"ALARM POISONING detected after '{line}' — "
                            "grblHAL is in alarm lock; remaining lines will all fail. "
                            "Stopping to avoid misattributing alarm responses as dialect rejections.",
                            file=sys.stderr,
                        )
                        break

        transcript = {
            "kind": "2bee.slicer controller acceptance",
            "program_path": str(args.program),
            "program_command": args.program_command,
            "program_sha256": program_hash,
            "port": args.port,
            "baud": args.baud,
            "rig": args.rig,
            "operator": args.operator,
            "firmware": firmware,
            # 🔴 THE EVIDENCE, NOT JUST THE LABEL. `firmware` is a word this
            # script chose; these four are what it chose it from, and they are
            # what a later reader can disagree with.
            "identification": {
                "verdict": ident.verdict,
                "heard": ident.heard,
                "permits": ident.permits,
                "evidence": ident.evidence,
                "received": list(ident.received),
                "probe_authorised": bool(args.identify_probe),
                "probed": probed,
            },
            "banner": banner,
            "build_info": build_info,
            "settings": settings_dump,
            "lines_sent": len(lines),
            "lines_attempted": len(results),
            "accepted": sum(1 for r in results if (r["verdict"] or "").lower() == "ok"),
            # `rejected` is now strictly "the board disagreed".  See the note at
            # the classification above for why the two were ever one number.
            "rejected": len(errors),
            "unanswered": len(unanswered),
            "alarm_poisoned": alarm_poisoned,
            "rejections": errors,
            "unanswered_lines": unanswered,
            "results": results,
        }
        if args.out:
            args.out.write_text(json.dumps(transcript, indent=2) + "\n")

        print(f"firmware  : {firmware} ({ident.evidence})")
        print(f"probe     : {'authorised and sent' if probed else 'not sent — the board spoke first'}")
        print(f"rig       : {args.rig}")
        print(f"program   : {args.program} ({program_hash[:12]})")
        print(
            f"lines     : {len(lines)} sent, "
            f"{len(lines) - len(errors) - len(unanswered)} accepted, "
            f"{len(errors)} rejected, {len(unanswered)} unanswered"
        )
        for r in errors[:20]:
            print(f"  REJECTED   {r['verdict']}  <- {r['sent']}")
        for r in unanswered[:20]:
            # Deliberately a different word and a different meaning: nothing came
            # back, so this says nothing about whether our dialect is right.
            print(f"  UNANSWERED (no reply at all)  <- {r['sent']}")
        if unanswered:
            print(
                "\nAn UNANSWERED line is not a dialect finding — the board stopped replying.\n"
                "Look at the bench (cable, power, reset) before looking at the post."
            )
        if errors:
            print("\nA rejection is a FINDING, not a failure of the run: it names a word this")
            print("post emits that this build does not implement. Route it with the build info above.")
        return 0 if not errors else 1
    finally:
        ctl.close()


if __name__ == "__main__":
    raise SystemExit(main())
