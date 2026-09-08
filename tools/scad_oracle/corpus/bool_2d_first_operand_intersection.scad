// 🔴 THE ONE 2D NODE IN THIS FAMILY THAT GENUINELY PRODUCES NOTHING — the only
// member whose refusal is agreement rather than a capability gap, and it had no
// corpus file until 2026-08-12.
//
// It is the intersection of the two traps the other four cases carry, one from
// each: `bool_2d_first_operand` puts the 2D operand FIRST (so the node becomes
// 2D and every 3D child is replaced by an empty one), and
// `bool_2d_operand_intersection` uses the ONE operator that an empty operand
// annihilates rather than skips. Neither alone produces nothing — the first
// draws an outline, the second is 3D-first — and together they do.
//
// MEASURED, `openscad 2026.08.07`, this exact file, ALL THREE DOORS asked
// rather than the STL one alone:
//   · `--export-format asciistl` exit 1, no file, "Current top level object is
//                                empty."
//   · `--export-format svg`      exit 1, no file, "Current top level object is
//                                not a 2D object."
//   · `--export-format dxf`      exit 1, no file, same sentence.
// ⚠ ASKING BOTH DOORS IS THE POINT AND IS WHAT SEPARATES THIS CASE FROM
// `bool_2d_first_operand`, WHICH ANSWERS THE STL DOOR ALMOST THE SAME WAY. That
// one says "not a 3D object" at the STL door and then EXITS 0 WITH AN 820-BYTE
// SVG (1 contour); this one closes every door it has. A verdict taken from the
// STL door alone cannot tell "there is 2D geometry and you asked for a solid"
// from "there is nothing at all", and those are the two halves of REFUSED-BOTH
// vs STRICTER.
//
// `mesh.ts`'s own `twoDimensionalOperandVerdict()` reaches the same answer from
// the source rather than from the binary — the `op === 'intersection' &&
// emptied` branch, `nodeDim === 2` arm, which says in as many words that this is
// "the ONE shape in this family where a 2D node genuinely produces nothing".
// Two independent derivations, one measured and one read, agreeing — which is
// the only reason this case is allowed to be the family's single `REFUSED-BOTH`.
//
// ⇒ NOT ON THE `STRICTER_LEDGER`, deliberately: there is no capability gap here
// to name or date. If it ever appears on that ledger, either the binary changed
// or our refusal moved, and both are findings.
//
// Watched go red under `--plant drop-2d-operand`: `REFUSED-BOTH -> DIVERGES`.
// Dropping the 2D operand leaves `intersection(){ cube(10); }`, so we would hand
// back a 10 mm cube for a program that renders empty at every exporter — the
// dangerous direction, and the same one `bool_2d_operand_intersection` catches
// through the other trap.
intersection() {
  circle(r = 8);
  cube([10, 10, 10]);
}
