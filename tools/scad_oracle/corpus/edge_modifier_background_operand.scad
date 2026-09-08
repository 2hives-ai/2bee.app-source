// A `%` node as the FIRST OPERAND of a difference — where the next operand is
// promoted to first and the difference subtracts nothing.
//
// 🔴 THIS CASE GUARDS THE HARNESS, NOT THE PRODUCT, AND THAT IS WHY IT EXISTS.
// `canon.mjs` used to build a background node into an EMPTY node and leave it in
// its parent's child list; `normalise`'s `diff` arm then read an empty FIRST
// operand and returned `<nothing>` ("nothing to cut away from"). So this file
// canonicalised to nothing on the ORACLE's side while the binary's own STL — and
// ours — is the cylinder at 3061.4675 mm³. The instrument would have scored a
// CORRECT result as `DIVERGES` and sent somebody to fix code that was right.
//
// WHAT OPENSCAD ACTUALLY DOES, read at the source rather than inferred:
// `GeometryEvaluator::collectChildren3D` opens with `if (chnode->modinst->
// isBackground()) continue;`, so the background child is REMOVED from the list
// the operator receives and the cylinder becomes operand zero;
// `applyToChildren3D` then takes its `children.size() == 1 -> this is a noop`
// early return. Measured at 2026.08.07: 60 facets of cylinder.
//
// ⚠ REMOVED IS NOT THE SAME AS EMPTY, AND THE DISTINCTION IS LOAD-BEARING. A
// first operand that is genuinely empty but NOT background still yields nothing
// (`manifold-applyops.cc`: `if (op == DIFFERENCE && !foundFirst) { geom =
// nullptr; break; }`), and so does a `%` wrapped in a transform, because the
// transform node is not itself background — it stays in the list and evaluates
// to nothing. Measured: `difference(){ translate([0,0,0]) %cube(20);
// cylinder(...); }` prints "Current top level object is empty". A fix that
// dropped any empty child would make that case wrong in the other direction, so
// the removal is a child-list edit at the immediate parent and nowhere else.
//
// The control solid at x=40 is the convention from `6425ea855e`: without it, a
// regression that refused the whole difference would emit nothing and score
// `REFUSED`, which `CAD1` treats as safe.
//
// Decidability: the cylinder is r=5 about the origin, the control solid starts
// at x=40. The bounding boxes cannot touch.
//
// PLANTED AND WATCHED RED (throwaway copy of `tools/scad_oracle/canon.mjs`,
// md5-verified against the live file before the edit; openscad 2026.08.07):
//   · background built into EMPTY and left in the child list -> DIVERGES
//     (this case only, over the full 81-case corpus: SAME 63->62, DIVERGES 4->5.
//     The row reads `TREE differs / MESH same` — the solids agree because ours
//     were right all along, which is the whole complaint)
difference() {
  %cube(20);
  cylinder(h = 40, r = 5, center = true, $fn = 16);
}
translate([40, 0, 0]) cube([6, 5, 5]);
