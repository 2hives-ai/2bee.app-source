// A `!` buried INSIDE a `%` subtree. It still governs the whole model.
//
// WHY IT WAS CHOSEN. `edge_modifier_background` is one `%` on one statement and
// stayed `SAME` through the defect below. The two characters only interact when
// one is inside the other, and no corpus case put them there.
//
// WHAT IT WOULD CATCH — and this one produced A DIFFERENT OBJECT, not a missing
// one. `find_root_tag` walks the instantiated tree and does not care what its
// ancestors are tagged with, so a root modifier written inside a background
// subtree wins exactly as if it had been written at the top. Measured at
// openscad 2026.08.07: this file exports the CUBE, 12 facets, 125 mm³. We used
// to discard the `%` body at PARSE time, never saw the `!` inside it, and
// exported the SPHERE at 31418 mm³ — the wrong part, silently, with the file's
// only refusal being the one that names `%` for a missing preview ghost.
//
// 🔴 THE SPHERE IS THE CONTROL AND IT IS THE WRONG ANSWER ON PURPOSE. A working
// root modifier suppresses it; every regression in this family releases it. That
// is the opposite polarity to a control solid that must always be emitted, and
// it is the polarity this construct allows — `!` exists to suppress siblings, so
// a sibling that is always emitted cannot be written here. It converts a lost
// capability into `DIVERGES` all the same: emit the sphere and the tree leg has
// a 20 mm bounding-box difference to report, rather than a `REFUSED` that `CAD1`
// reads as safe.
//
// ⚠ THE RESIDUAL THIS CASE DOES NOT REACH. The `!` is found by EVALUATING the
// `%` body into a throwaway sink, under the node and iteration budgets. A `!`
// buried deep enough that the search halts on budget before reaching it is not
// honoured, and nothing says so. This file is far under any budget, so it proves
// the mechanism and not its limit. See `docs/audit/2026-08-11-scad-silent-
// divergence.md`.
//
// Decidability: one solid on both sides in the correct run; in a planted run the
// sphere replaces it rather than joining it. Never two overlapping solids.
//
// PLANTED AND WATCHED RED (throwaway copy of `web/src/cad/scad.ts`, md5-verified
// against the live file before the edit; openscad 2026.08.07):
//   · the `%` body discarded at parse time (pre-`d749b176c2` behaviour) -> DIVERGES
//     (this case only, over the full 81-case corpus: SAME 63->61, DIVERGES 4->5
//     — the other move is `edge_modifier_root_on_background` going SAME->REFUSED,
//     which is the blind spot that case's own header records)
%union() {
  !cube(5);
}
sphere(20, $fn = 16);
