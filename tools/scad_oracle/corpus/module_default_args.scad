module post(h = 10, d = 4) {
  cylinder(h = h, d = d, $fn = 16);
}
union() {
  post();
  translate([20, 0, 0]) post(h = 20);
}
