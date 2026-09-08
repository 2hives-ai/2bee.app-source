// $ variables are DYNAMICALLY scoped: $fn set at the call site must reach inside
module pin() {
  cylinder(h = 10, r = 3);
}
pin($fn = 20);
