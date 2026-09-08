// ALPHA ZERO IS STILL GEOMETRY. Verified at the binary: `color("red", 0) cube(3);`
// exports 12 facets, the same as a bare cube. Alpha is appearance, so there is no
// "invisible therefore absent" case for a pass-through to wrongly resurrect.
color("red", 0) cube([3, 3, 3]);
