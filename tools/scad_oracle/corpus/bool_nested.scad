difference() {
  union() {
    cube([24, 16, 8], center = true);
    translate([0, 0, 4]) cylinder(h = 8, r = 6, $fn = 32);
  }
  cylinder(h = 40, r = 3, center = true, $fn = 32);
}
