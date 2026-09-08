// color() as a DIFFERENCE OPERAND. Verified at openscad 2026.08.07: this exports
// BYTE-IDENTICAL ASCII STL to the same program with the color() removed (28
// facets), so the wrapper does not change which operand is the minuend.
difference() {
  color([0, 0, 0, 1]) cube([10, 10, 10]);
  translate([0, 0, 5]) cube([4, 4, 4]);
}
