// A 2D and a 3D object at top level. Measured against openscad 2026.08.07: it
// does NOT refuse the export — it writes the 3D object (12 triangles) and drops
// the 2D one silently. We keep the square as a flat part, so this case agrees on
// both legs and the divergence in what happens to the 2D object is invisible to
// both. Kept, and said out loud in the README, rather than deleted.
cube([10, 10, 10]);
translate([20, 0, 0]) square([5, 5]);
