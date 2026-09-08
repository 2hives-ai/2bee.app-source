// `round()` on a negative half, which is the one place JavaScript's rounding and
// C's disagree — and the only exercise this corpus has of ANY math builtin
// except `sqrt`.
//
// WHAT IT WOULD CATCH. `Math.round` rounds a half toward +infinity
// (`round(-0.5)` is `-0`); C's `round()`, which OpenSCAD calls, rounds a half
// AWAY FROM ZERO (`round(-0.5)` is `-1`). The three heights below are 6, 6 and 7
// in OpenSCAD and were 10, 8 and 8 here. The standard `round(-x/2)` centring
// idiom is therefore a full millimetre out **on the negative side only**, which
// is why nobody notices: the same expression is exact on the positive side.
//
// WHY IT WAS CHOSEN. `scad.ts` implements 23 math builtins and the corpus called
// exactly one of them (`sqrt`, in `variables_expr`). Rather than 23 thin cases,
// this is the one whose defect is a REAL NUMBER OF MILLIMETRES rather than a
// type error — a wrong `len()` or `norm()` fails loudly, a wrong `round()`
// produces a plausible part of the wrong size.
//
// ⚠ THE MAGNITUDES ARE DELIBERATE. `-0.5`, `-1.5` and `-2.5` are the halves at
// three different exponents; a rounding rule that special-cased one of them
// would still be caught by the other two.
//
// Decidability: three 10 mm-square footprints at x = 0, 20, 40. No two bounding
// boxes can touch at any of the heights either implementation produces.
//
// PLANTED AND WATCHED RED (throwaway copy, openscad 2026.08.07):
//   · `Math.round(x)` in place of `sign(x) * round(abs(x))` -> DIVERGES
translate([ 0, 0, 0]) cube([10, 10, 10 + round(-0.5) * 4]);
translate([20, 0, 0]) cube([10, 10, 10 + round(-1.5) * 2]);
translate([40, 0, 0]) cube([10, 10, 10 + round(-2.5)]);
