// `children(i)`, `children([a:b])` and an out-of-bounds index. The corpus tested
// only the bare `children()`, which is the one form that cannot be wrong about
// WHICH child it instantiates.
//
// WHAT IT WOULD CATCH. A selector that ignores its argument instantiates the
// children the source did not ask for — extra material, in a mechanism where the
// caller cannot see it, because the selection happens inside somebody's library
// module. An off-by-one in the range form drops or duplicates a whole part. And
// an out-of-bounds index must emit NOTHING and warn, not clamp to the last
// child: clamping turns a source bug into a plausible part.
//
// WHY IT WAS CHOSEN, WITH THE COUNT. `hardware/cad/` calls `children()` with an
// explicit index from 0 to 8 across its library modules. `module_children`
// covers the passthrough case and nothing else, so every indexed form — the ones
// with a number in them to get wrong — had no coverage at all.
//
// ⚠ THE SPHERE IN THE SECOND CALL IS THE ONE THAT MUST NOT APPEAR. `children([0:1])`
// selects the first two children; if the range form ever degrades to "all", the
// sphere arrives and the case reddens on both legs. It is sized and placed so
// that its arrival is unmistakable rather than marginal.
//
// The third call asks for child 5 of 1. OpenSCAD emits nothing and prints
// `WARNING: Children index (5) out of bounds (1 children)`; so does this file,
// in OpenSCAD's own wording, and nothing is drawn for it on either side.
//
// Decidability: the selected solids occupy x[20,26]y[0,6], x[0,4]y[30,34] and
// x[10,14]y[30,34]. No two touch, and the sphere a regression would add is
// centred at (0,30) with r 9, so it would overlap — the case is designed to
// redden on the TREE leg, which it does, before the mesh leg is asked.
//
// PLANTED AND WATCHED RED (throwaway copy, openscad 2026.08.07):
//   · `children(i)` ignoring its index and instantiating all -> DIVERGES
module pick() { children(1); }
pick() { cube([5, 5, 5]); translate([20, 0, 0]) cube([6, 6, 6]); }

module firsttwo() { children([0 : 1]); }
translate([0, 30, 0]) firsttwo() { cube([4, 4, 4]); translate([10, 0, 0]) cube([4, 4, 4]); sphere(r = 9, $fn = 12); }

module oob() { children(5); }
translate([0, 60, 0]) oob() cube([3, 3, 3]);
