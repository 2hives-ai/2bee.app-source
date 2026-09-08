// The classic trap: the subtrahend is flush with the minuend on z=0 and z=10.
// mesh.ts names coplanar faces as failure mode (1) in its header; this case is
// here to MEASURE that, not to avoid it.
difference() {
  cube([20, 20, 10]);
  translate([5, 5, 0]) cube([10, 10, 10]);
}
