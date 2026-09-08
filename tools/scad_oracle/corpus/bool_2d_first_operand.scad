// A boolean whose FIRST operand is 2D. The node's dimension is fixed by the
// first child that has any geometry (`GeometryEvaluator::applyToChildren` ->
// `isValidDim`), so the whole node becomes 2D and every 3D child is replaced by
// an empty one — "Ignoring 3D child object for 2D operation".
//
// 🔴 THE SECOND TRAP. Asked for an STL, OpenSCAD writes NO FILE here, so the
// tempting "drop the 2D operand and hand back the 3D one" edit would emit a
// 10mm cube for a program that exports nothing at all.
//
// MEASURED, `openscad 2026.08.07 --export-format asciistl`, this exact file:
// exit 1, no file, two warnings, "Current top level object is not a 3D object."
//
// ⚠ SCORED `STRICTER`, AND THE BRIEF THAT ASKED FOR THIS PASS SAID IT SHOULD
// NOT BE. The brief's reason was "OpenSCAD produces no solid there either" —
// true, and equally true of `bool_2d_all_operands`, which the same brief lists
// as a live member because "OpenSCAD draws the outline and we draw nothing".
// Both are true of BOTH files. `STRICTER` is the right verdict for both.
//
// 🔴 ~~"The binary's answer is byte-for-byte the same for the two, so no consult
// of the oracle can separate them."~~ **FALSE, AND MEASURED FALSE 2026-08-12.**
// Struck rather than deleted, because this sentence was copied verbatim into the
// `STRICTER_LEDGER` entry for this case and read for a day as a property of the
// world. Two doors separate them, and the harness asks neither:
//   · THE SVG DOOR. `--export-format svg` exits **0** for both and writes a
//     file: **820 bytes, `Contours: 1`** here, **994 bytes, `Contours: 2`** for
//     `bool_2d_all_operands`. Different outlines, on disk, from the binary.
//   · THE STL DOOR WAS NEVER BYTE-IDENTICAL EITHER. This file emits two extra
//     lines the all-2D file does not — `WARNING: Mixing 2D and 3D objects is not
//     supported` and `WARNING: Ignoring 3D child object for 2D operation`. Only
//     the FINAL sentence matches; `diff` of the two stderrs is 2 lines.
// ⚠ The evidence was already in the tree: `mesh.ts`'s own measured table carries
// the SVG column with `1 contour` against `2 contours` on adjacent rows. The
// claim was not unfalsifiable, it was unchecked — and it asserted a limit of the
// INSTRUMENT ("no consult can separate them") from a limit of the ONE DOOR the
// instrument happens to open. `openscad.mjs` asks for `asciistl` and nothing
// else, so "the harness cannot separate them" was true and "no consult can" was
// not, and the second is what got written down.
//
// ⇒ WHAT DOES NOT CHANGE: both stay `STRICTER`, because both draw geometry we do
// not. Separating them would refine the REASON, not the verdict. That is why
// this is a corrected note and not a new case.
difference() {
  circle(r = 8);
  cube([10, 10, 10]);
}
