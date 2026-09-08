// A 2D operand inside a 3D `difference` — the shape where OPENSCAD HANDS BACK A
// SOLID AND WE HAND BACK NOTHING.
//
// 🔴 THIS CASE EXISTS BECAUSE THE HARNESS USED TO BE UNABLE TO SCORE IT. Until
// the REFUSED split (2026-08-11) `oracle.mjs` awarded `REFUSED` as soon as we
// named a construct and emitted nothing — BEFORE either leg was compared — so
// the oracle's own answer was never consulted for a refusal, and a refusal that
// costs a capability was indistinguishable from one that costs nothing. The
// README's own blind-spot map said a case here "cannot go red" and left it out
// for that reason. It can now: the verdict is `STRICTER`, and `STRICTER` is a
// ledger entry, not a pass.
//
// ⚠ NO CONTROL SOLID, DELIBERATELY, AND IT IS THE ONE PLACE THE CONVENTION IS
// WRONG. Every other case whose construct GATES EMISSION carries an
// unconditional second solid so a partial loss is compared instead of scoring a
// safe-looking `REFUSED`. Adding one here would make the case emit geometry, so
// the refusal branch would never be reached and the case would stop testing the
// thing it is for — and it would land as a fresh `DIVERGES` against `CAD1`. The
// split IS the control the convention was standing in for.
//
// MEASURED, `openscad 2026.08.07 --export-format asciistl`, this exact file:
// exit 0, 12 facets — the plain cube, pocket not cut — with two warnings on the
// console ("Mixing 2D and 3D objects is not supported", "Ignoring 2D child
// object for 3D operation"). We refuse the whole node and draw nothing.
//
// 🔴 THE FIX IS NOT "DROP THE 2D OPERAND TO MATCH". That is right here and
// WRONG for `bool_2d_operand_intersection`, where the same edit emits a solid
// OpenSCAD does not emit at all. See `twoDimensionalOperandVerdict()` in
// web/src/cad/mesh.ts for the full measured table.
//
// Watched go red under `--plant drop-2d-operand`, which is that edit: the row
// moves off `STRICTER`, where before the split it could not move at all.
difference() {
  cube([10, 10, 10]);
  circle(r = 3);
}
