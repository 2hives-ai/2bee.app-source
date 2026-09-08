// 🔴 THE TRAP CASE. Same 2D operand, same 3D first operand, DIFFERENT OPERATOR —
// and here OpenSCAD emits NOTHING AT ALL, so our refusal costs nothing and the
// verdict is `REFUSED-BOTH`.
//
// WHY IT IS DIFFERENT: the 2D child is replaced by an EMPTY 3D operand in place
// (not removed — that is what `%` does, and the two are different doors). An
// intersection with an empty operand is empty: `manifold-applyops.cc:70-84`
// breaks the loop with `geom = nullptr` for INTERSECTION and `continue`s for
// everything else.
//
// MEASURED, `openscad 2026.08.07 --export-format asciistl`, this exact file:
// **exit 1, no file written, "Current top level object is empty."**
//
// ⇒ THIS IS THE CASE THAT REFUTES "MATCH OPENSCAD BY DROPPING THE 2D OPERAND".
// That edit would hand back the cube here, where OpenSCAD hands back nothing —
// a solid emitted for a program that renders empty, which is the plausible-
// looking wrong part this lane exists to stop. So the corpus carries the shape
// where the tempting fix is right (`bool_2d_operand_difference`) AND the shape
// where it is dangerous, and they differ by one operator name.
//
// Watched go red under `--plant drop-2d-operand`: `REFUSED-BOTH -> DIVERGES`,
// which is the direction that matters — we produce a solid the oracle does not.
intersection() {
  cube([10, 10, 10]);
  circle(r = 3);
}
