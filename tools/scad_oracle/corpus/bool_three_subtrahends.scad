// difference(a, b, c) == difference(a, union(b, c)); both sides must agree
difference() {
  cube([30, 20, 10], center = true);
  translate([-8, 0, 0]) cylinder(h = 30, r = 3, center = true, $fn = 24);
  translate([8, 0, 0]) cylinder(h = 30, r = 3, center = true, $fn = 24);
}
