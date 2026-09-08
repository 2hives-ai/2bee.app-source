// An ALL-2D boolean. OpenSCAD computes it for real — Clipper2, via
// `GeometryEvaluator::applyToChildren2D` — and draws the resulting outline. We
// have no 2D boolean kernel, so we draw nothing.
//
// ⚠ THIS IS THE MEMBER THAT WILL MATTER WHEN `linear_extrude` LANDS: an
// extruded profile is normally built as a 2D boolean first, so the construct
// that is merely invisible today becomes the input to a solid tomorrow.
//
// MEASURED, `openscad 2026.08.07 --export-format asciistl`, this exact file:
// exit 1, no file, "Current top level object is not a 3D object." — NOT the
// "empty" message. The two are different facts and the harness now reads which
// one it got:
//   · "empty"            -> the oracle produced nothing        -> REFUSED-BOTH
//   · "not a 3D object"  -> the oracle produced 2D geometry    -> STRICTER
//
// ✅ ~~AND HERE IS THE LIMIT OF THAT READING … `twoDimensionalOperandVerdict()`
// in web/src/cad/mesh.ts calls that one `agree` while calling this one
// `stricter` … Reported to the `web/` owner; not fixed here.~~
// 🔴 **STALE — IT IS FIXED, AND BOTH NOW READ `stricter`** (re-measured at the
// source 2026-08-12). `mesh.ts` routes every verdict through one table,
// `RELATION_OF`, in which BOTH `solid` and `outline` map to `stricter`; this
// file's node returns `outline` from the all-2D arm and
// `bool_2d_first_operand`'s returns `outline` from the emptied 2D-first arm. The
// two agree with each other and with this harness. Struck rather than deleted
// because a note that says "reported, not fixed here" is an open ticket in
// somebody's head, and it kept one open for a day after the fix landed.
//
// 🔴 AND THE OTHER HALF OF THE OLD NOTE WAS WRONG ON ITS OWN TERMS.
// ~~"Nothing observable at the binary separates them."~~ Measured 2026-08-12:
// the SVG door exits **0** for both and writes a file — **994 bytes,
// `Contours: 2`** here against **820 bytes, `Contours: 1`** for
// `bool_2d_first_operand` — and even at the STL door that file emits two extra
// `Mixing 2D and 3D objects` warnings this one does not. What is identical is
// the FINAL SENTENCE at the ONE door `openscad.mjs` opens. ⚠ The instrument's
// reach was written down as a property of the binary, which is the same error
// shape as the harness defects catalogued in the README: a limit measured
// against one instrument reads exactly like a limit of the world.
difference() {
  circle(r = 8);
  circle(r = 3);
}
