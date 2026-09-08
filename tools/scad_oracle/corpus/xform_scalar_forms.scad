// The SCALAR form of all three transforms, which the corpus never wrote — every
// transform case in it passes a vector.
//
// WHAT IT WOULD CATCH. The three scalars mean three different things, and only
// one of them is "expand it to a vec3":
//   · `translate(5)` is a **no-op**. OpenSCAD cannot convert a scalar to a vec3
//     or vec2, warns, and emits the IDENTITY with the children kept. Expanding
//     it — the obvious thing to do, and what a shared `vec3()` helper does —
//     displaces the part diagonally on all three axes from a line the reference
//     implementation ignores.
//   · `rotate(45)` is a rotation about **Z**.
//   · `scale(2)` is **uniform** on all three axes.
// A single helper cannot serve all three, and the corpus could not tell.
//
// WHY IT WAS CHOSEN, WITH THE COUNT. `hardware/cad/` writes the scalar forms
// ~20 times — `rotate(90)`, `rotate(-90)`, `rotate(180)`, `rotate(30)`,
// `scale(.1)`, `scale(.8)` — and the corpus exercised none of them.
//
// ⚠ THE THIRD CHILD IS A SCALAR AT A QUADRANT MULTIPLE, deliberately.
// `xform_rotate_quadrant` pins exact-90 rotation through the VECTOR form only;
// `rotate(-90)` reaches the same degree trigonometry down a different branch of
// `grouping()`, and a scalar path that built its own matrix would keep the
// `6.12323e-17` that case exists to forbid.
//
// ⚠ AND THE FIRST CHILD IS A REFUSAL THAT KEEPS ITS GEOMETRY AND IS CORRECT —
// the only case in this corpus of that shape. `translate(scalar)` is named in
// the refusal list and the subtree is still drawn, unmoved, because that is what
// OpenSCAD does. The row reads `SAME` with a refusal printed in it; that is not
// a contradiction and should not be "cleaned up".
//
// Decidability: after rotation the four solids occupy x[0,10]y[0,10],
// x[36.5,54.1]y[0,17.7], x[0,5]y[20,40] and x[0,10]y[80,90]. No two touch.
//
// PLANTED AND WATCHED RED (throwaway copy, openscad 2026.08.07):
//   · `translate(scalar)` expanded to [5,5,5]   -> DIVERGES
//   · `rotate(scalar)` applied about X not Z    -> DIVERGES
translate(5) cube([10, 10, 10]);
translate([40, 0, 0]) rotate(45) cube([20, 5, 5]);
translate([0, 40, 0]) rotate(-90) cube([20, 5, 5]);
translate([0, 80, 0]) scale(2) cube([5, 5, 5]);
