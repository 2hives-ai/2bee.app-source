// a fractional step: the range must produce the same iteration count on both sides
union() {
  for (x = [0 : 2.5 : 10]) translate([x * 3, 0, 0]) cube([6, 6, 6]);
}
