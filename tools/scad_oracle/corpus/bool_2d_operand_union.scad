// The same 2D-operand shape as `bool_2d_operand_difference`, on a `union`.
//
// ⚠ IT IS A SEPARATE CASE BECAUSE IT IS A SEPARATE CODE PATH IN OPENSCAD, not
// because two examples read better. `union` filters empty operands out before
// the boolean runs (`GeometryEvaluator.cc:175-181`) while `difference` carries
// the empty into `manifold-applyops.cc` and `continue`s past it. The two arrive
// at the same answer by different routes, and a regression in one of them is
// invisible in a corpus that only exercises the other. `mesh.ts` collapses both
// into `op !== 'intersection'`; that collapse is a claim, and this is the case
// that holds it up.
//
// MEASURED, `openscad 2026.08.07 --export-format asciistl`, this exact file:
// exit 0, the plain cube. ⚠ TWO DIFFERENT FACET COUNTS ARE BOTH CORRECT and it
// is worth naming which is which, because the harness prints one and the console
// prints the other: the console reports **6** (a convex PolySet, quads) and the
// ASCII STL carries **12** (triangles). We refuse the whole node and draw
// nothing ⇒ `STRICTER`.
//
// No control solid, for the reason written out in `bool_2d_operand_difference`.
union() {
  cube([10, 10, 10]);
  circle(r = 3);
}
