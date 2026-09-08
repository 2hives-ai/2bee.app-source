// $fa/$fs passed as ARGUMENTS. This case is `SAME` as of 2026-08-11 and its
// `CAD1_KNOWN` entry is a stale exemption — reported to the lane, not edited
// here, because `gates/` is another boundary.
//
// 🔴 WHAT THIS HEADER USED TO SAY, AND WHY IT IS WORTH KEEPING THE CORRECTION.
// "$fa/$fs passed as ARGUMENTS are refused by name, and the sphere is still
// emitted at the default tessellation." BOTH clauses were false by the time the
// row was read: the refusal branch that named them sat below an allowlist
// `continue` and was unreachable from anywhere in `scad.ts` (the measured run
// reports `refusals 0` on this case), and the sphere is emitted at the
// tessellation the source asked for.
//
// ⚠ THE DIVERGENCE THAT REMAINED WAS THE INSTRUMENT'S. `canon.mjs` printed our
// `$fa`/`$fs` from a hard-coded `OUR_FA = 12` / `OUR_FS = 2`, so the tree leg
// compared 12/2 against the oracle's 5/0.5 and reported it as ours. Measured
// when it cleared: 5180 triangles on BOTH sides (12/2 gives 840), volume
// 4175.517851 vs 4175.517816, bbox +/-9.990482 both sides.
//
// WHAT IT STILL CATCHES: a `$fa`/`$fs` argument that stops reaching the
// tessellator moves the triangle count, the volume and the bounding box at once
// — this file is `sphere(r=10)` with nothing else, so any of the three is loud.
sphere(r = 10, $fa = 5, $fs = 0.5);
