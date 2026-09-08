// How many items a fractional-step range has, at the two step values that
// separate every plausible counting rule from OpenSCAD's.
//
// WHAT IT WOULD CATCH. One extra or one missing item at the end of a patterned
// row — an extra boss, or a missing hole, easy to miss on a preview and
// impossible to miss in the material. `scad.ts` used to accumulate (`x += step`)
// with a 1e-12 slack and ran the first loop below FIVE times where OpenSCAD runs
// it four.
//
// 🔴 THE TWO LOOPS FAIL IN OPPOSITE DIRECTIONS, WHICH IS THE WHOLE POINT.
// `(end-begin)/step` lands just under an integer for most decimal steps, and the
// rounding rule decides whether the last item exists. Measured against OpenSCAD
// 2026.08.07: 1 ulp below an integer always rounds UP, 2 ulps below never does.
//   · `[1 : 0.05 : 1.2]` is 2 ulps below 4 and OpenSCAD emits **4** items
//   · `[0 : 0.1 : 0.3]`  is 1 ulp  below 3 and OpenSCAD emits **4** items
// A plain `Math.trunc` gets the second wrong; a plain `Math.round` gets the
// first wrong; an absolute or relative epsilon fitted to one breaks the other.
// One loop alone cannot tell those apart, so both are here.
//
// WHY IT WAS CHOSEN. The corpus's only stepped range was `[0 : 2.5 : 10]`, whose
// quotient is exactly 4 — the one value at which every counting rule agrees. So
// `control_for_step` looked like coverage of fractional steps and could not see
// this defect. `hardware/cad/` writes real non-exact steps (`[0.4:0.2:0.8]`,
// `[0:0.01:1+EPSILON]`).
//
// Decidability: 5 mm cubes at 10 mm pitch in the first row and 30 mm pitch in
// the second, the rows 40 mm apart in y, so no two bounding boxes can touch —
// including the spurious fifth cube a wrong rule would add at x = 240.
//
// PLANTED AND WATCHED RED (throwaway copy, openscad 2026.08.07):
//   · `Math.trunc(span)` without the one-ulp nudge  -> DIVERGES
//   · `Math.round(span)`                            -> DIVERGES
for (i = [1 : 0.05 : 1.2]) translate([i * 200, 0, 0]) cube([5, 5, 5]);
for (j = [0 : 0.1 : 0.3]) translate([j * 300, 40, 0]) cube([5, 5, 5]);
