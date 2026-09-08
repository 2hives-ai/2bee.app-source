// scale with a negative component flips winding. scad.ts has no mirror() and
// mesh.ts refuses a transform whose determinant is <= 0 — measure what happens.
scale([-1, 1, 1]) translate([5, 0, 0]) cube([10, 10, 10]);
