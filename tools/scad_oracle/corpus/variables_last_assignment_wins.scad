// Scope semantics: the LAST assignment in a scope governs the WHOLE scope,
// including the lines textually above it. The corpus had no case on this at all.
//
// WHAT IT WOULD CATCH. OpenSCAD is not imperative. `scad.ts` used to execute
// assignments in the same top-to-bottom sweep as the geometry, so the first
// assignment governed every line above the second one: the first three lines
// below were a **10 mm cube here and a 50 mm cube in OpenSCAD** — a dimension
// that appears nowhere in the file the user is reading, with no diagnostic.
//
// ⚠ AND IT IS NOT "EVALUATE THE LAST ONE", WHICH IS THE HALF A REWRITE GETS
// WRONG. The name keeps the POSITION of its FIRST assignment and takes the
// EXPRESSION of its LAST, and everything is then evaluated once in that order.
// So `a = 1; b = a + 1; a = 5;` gives `b == 6`, not 2 and not undef. The second
// solid is that probe: a rule that merely moved `a` to the bottom of the scope
// would give `b == undef` and draw nothing.
//
// WHY IT WAS CHOSEN. Every variable case in the corpus (`variables`,
// `variables_expr`, `variables_function_def`) assigns each name exactly once, so
// the entire re-assignment rule — which is the one that decides what a
// dimension MEANS — was unexercised. OpenSCAD warns about both overwrites and
// this file expects those warnings; they are not errors and change no geometry.
//
// Decidability: the 50 mm cube sits at the origin and the 6 mm cube at x = 80,
// so the two bounding boxes cannot touch.
//
// PLANTED AND WATCHED RED (throwaway copy, openscad 2026.08.07):
//   · the FIRST assignment's expression kept instead of the last -> DIVERGES
w = 10;
module part() { cube([w, w, w]); }
part();
w = 50;

a = 1;
b = a + 1;
a = 5;
translate([80, 0, 0]) cube([b, b, b]);
