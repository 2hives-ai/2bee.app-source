// `!` is the root modifier: only that subtree renders. OpenSCAD resolves it
// before the CSG is written, so its `.csg` holds the cube and nothing else.
//
// 🔴 THIS HEADER SAID `scad.ts` "refuses it by name and drops the subtree" UNTIL
// 2026-08-11, AND THAT STOPPED BEING TRUE AT `fbfe2738f1`. `!` is implemented:
// the marked subtree becomes the whole model, stripped of its ancestors, and the
// sphere below is dropped exactly as OpenSCAD drops it. The sentence was copied
// out of the harness README's dated results table, where it was true when
// written — ⚠ *a dated measurement quoted without its date becomes a claim about
// the present*, and this one described the product to anyone who read the case
// before reading the code.
//
// ⚠ WHAT THIS CASE COVERS IS ONE MODIFIER ON ONE STATEMENT, AND THAT WAS NOT
// ENOUGH. It scored `SAME` before AND after all four interaction defects fixed
// in `d749b176c2`. The combinations are `edge_modifier_root_{on_disabled,nested,
// in_background,on_background}`; read the set, not this file alone.
!cube([10, 10, 10]);
sphere(r = 20, $fn = 16);
