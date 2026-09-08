// `!` and `%` on the SAME statement — the node that becomes the root is
// background, and OpenSCAD ignores that.
//
// WHY IT WAS CHOSEN. It is the fourth corner of the `!`/`%` square:
// `edge_modifier_root` is `!` alone, `edge_modifier_background` is `%` alone,
// `edge_modifier_root_in_background` is `!` under `%`, and this is the two of
// them on one statement. All four corners score `SAME` today; only the two
// combinations ever scored anything else.
//
// WHAT IT WOULD CATCH, AND THE ASYMMETRY THAT MAKES IT NON-OBVIOUS.
// `GeometryEvaluator` skips a background CHILD — `collectChildren3D` opens with
// `if (chnode->modinst->isBackground()) continue;` — and nothing anywhere checks
// the background flag on the ROOT node itself. So `%` is honoured on a child and
// ignored on the root, from one rule, and guessing which way it goes gets it
// wrong half the time. Measured at openscad 2026.08.07: this file exports 12
// facets of cube, 125 mm³. We exported NOTHING.
//
// 🔴 THIS CASE CANNOT GO RED ON THE DEFECT IT WAS WRITTEN FOR, AND THAT IS
// MEASURED, NOT SUSPECTED. Planting "the `%`-on-the-root unwrap removed" — the
// exact pre-`d749b176c2` behaviour — scores **`REFUSED`**, not `DIVERGES`: the
// `%` names itself, the root sink stays empty, nothing is emitted, and `CAD1`
// treats a refusal as safe. The first draft of this header asserted `DIVERGES`
// for that plant and the plant said otherwise.
//
// ⚠ AND NO CONTROL SOLID CAN FIX IT, WHICH IS A PROPERTY OF `!` RATHER THAN OF
// THIS FILE. A working root modifier suppresses every sibling, so an
// unconditional control solid CANNOT COEXIST with the construct under test —
// the convention from `6425ea855e` is inapplicable here, not merely omitted.
// The sphere below is the weaker thing that is available: a control of the
// OPPOSITE polarity, suppressed when `!` works and released when it breaks.
//
// What that buys is real but narrower than "covered", so it is stated as a
// list rather than a claim. It goes red on a regression that RELEASES the
// sibling — `!*`'s annihilation guard wrongly generalised from `*` to `%` is a
// plausible one, and it is the plant below. It stays green on a regression that
// emits NOTHING. The second half is watched by
// `web/tests/cad-modifier-interactions.test.ts`, which asserts the geometry
// directly and does not have a refusal verdict to hide behind.
//
// ⚠ `%!cube(5);` — the same two characters the other way round — needs no case
// and no special handling: the `%` wrapper evaluates its body and the `!` inside
// uses its own sink, which is the path `edge_modifier_root_in_background`
// already exercises.
//
// Decidability: one solid, whichever side of the defect the run is on.
//
// PLANTED (throwaway copy of `web/src/cad/scad.ts`, md5-verified against the
// live file before the edit; openscad 2026.08.07; full 81-case corpus each run):
//   · the `*`-annihilation guard generalised from `*` to `%`  -> DIVERGES ✅
//     (this case only — SAME 63->62, DIVERGES 4->5)
//   · the `%`-on-the-root unwrap removed (the original defect) -> 🔴 REFUSED,
//     i.e. INVISIBLE TO `CAD1` (this case only — SAME 63->62, REFUSED 14->15)
!%cube(5);
sphere(20, $fn = 16);
