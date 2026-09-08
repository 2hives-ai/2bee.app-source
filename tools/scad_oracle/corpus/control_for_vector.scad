union() {
  for (v = [[0, 0], [15, 0], [0, 15]]) translate([v[0], v[1], 0]) cylinder(h = 8, r = 4, $fn = 16);
}
