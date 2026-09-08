module lvl3() { cube([4, 4, 4]); }
module lvl2() { union() { lvl3(); translate([6, 0, 0]) lvl3(); } }
module lvl1() { union() { lvl2(); translate([0, 6, 0]) lvl2(); } }
union() { lvl1(); translate([0, 0, 6]) lvl1(); }
