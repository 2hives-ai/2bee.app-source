// cylinder() with POSITIONAL arguments, which the rest of the corpus never used.
//
// WHAT IT WOULD CATCH. `scad.ts` resolves five separate things here and the
// corpus wrote none of them: the positional order `h, r1, r2, center`, the
// third positional (`pos[2]`) being reachable at all, the fourth (`center`)
// being read, and — the one an audit missed — that an UNSPECIFIED radius
// defaults to **1, not to the other radius**. `cylinder(10, 5)` is a cone in
// OpenSCAD (r1 5, r2 1) and was drawn here as a straight 5/5 cylinder.
//
// WHY IT WAS CHOSEN. Every cylinder in the corpus passed `r`/`r1`/`r2`/`d1`/`d2`
// BY NAME, so the whole positional path — the one a human writes by hand — had
// zero coverage while its comment in `scad.ts` documents five measured defects
// in it. A cone drawn as a cylinder is a countersink cut as a straight bore and
// a draft angle silently removed; `center` ignored puts the part h/2 off datum.
//
// ⚠ THE MIDDLE CHILD IS THE SHARP ONE. `cylinder(10, 5)` looks like a
// well-formed cylinder in the source and is a cone in the reference
// implementation. A reader checking this file will want to "fix" it; do not.
//
// Spacing is the decidability constraint, not a style: overlapping top-level
// solids make the mesh leg UNDECIDABLE and a PENDING corpus case FAILS CAD1.
// Radii are 10, 5 and 4 at x = 0, 40, 80, so no two bounding boxes can touch.
//
// PLANTED AND WATCHED RED (throwaway copy of the harness, openscad 2026.08.07):
//   · an unspecified r2 defaulting to r1        -> DIVERGES
//   · pos[3] (center) not read                  -> DIVERGES
cylinder(20, 10, 4);
translate([40, 0, 0]) cylinder(10, 5);
translate([80, 0, 0]) cylinder(12, 4, 4, true);
