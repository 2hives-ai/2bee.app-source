// color() WITH MORE THAN ONE CHILD BEHAVES AS A GROUP. Verified at the binary:
// 24 facets, both cubes present.
color("blue") {
  cube([3, 3, 3]);
  translate([10, 0, 0]) cube([3, 3, 3]);
}
