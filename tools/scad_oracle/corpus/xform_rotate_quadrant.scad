// rotate() at exact multiples of 90, which the rest of the corpus never did.
//
// 🔴 THIS CASE EXISTS TO GO RED, AND IT IS THE ONLY CORPUS CASE THAT CAN.
// OpenSCAD's degree trig returns an exact 0 and +/-1 at quadrant multiples;
// `Math.cos(deg * PI/180)` returns 6.12323e-17. Until 2026-08-11 BOTH sides of
// this harness computed the naive value -- `mesh.ts` did, and `canon.mjs` kept
// its own copy that did -- so the epsilon was printed by the instrument about
// itself and no change to the product could move it. Both are fixed; this file
// is what would notice if either regressed.
//
// ⚠ The corpus rotated by [15,25,35] and [0,0,30] and by nothing else, so the
// epsilon could not appear in it and CAD1 would have stayed green through the
// whole defect. The hardware leg caught it, which is a worse place to catch it:
// CAD1H is a tracked count with a baseline, not a pass/fail.
//
// ⚠ THE LAST TWO CHILDREN GUARD THE WRONG FIX, NOT THE DEFECT. A quadrant test
// with any tolerance -- "if it is close to 90, snap it" -- makes the exact rows
// agree while silently straightening a part the operator drew at an angle.
// 89.9999 and 90.0001 are real angles on both sides; if either starts matching
// its neighbouring quadrant, the snap is back.
//
// Spacing is 40mm on x. Every child fits inside a sphere of radius 11.5 about
// its own origin, so no two bounding boxes can touch -- which matters, because
// overlapping top-level solids make the mesh leg UNDECIDABLE and a PENDING
// corpus case FAILS CAD1 rather than passing it quietly.
translate([  0, 0, 0]) rotate([-90,   0,   0]) cube([10, 4, 4]);
translate([ 40, 0, 0]) rotate([  0,  90,   0]) cube([10, 4, 4]);
translate([ 80, 0, 0]) rotate([  0,   0, 180]) cube([10, 4, 4]);
translate([120, 0, 0]) rotate([270,  90, 180]) cube([10, 4, 4]);
translate([160, 0, 0]) rotate([ 89.9999, 0, 0]) cube([10, 4, 4]);
translate([200, 0, 0]) rotate([ 90.0001, 0, 0]) cube([10, 4, 4]);
