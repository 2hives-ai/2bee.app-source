// A second `!` NESTED INSIDE the first — which is a different case from a
// second `!` that is a SIBLING of the first, and conflating them deleted half
// the model.
//
// WHY IT WAS CHOSEN. `edge_modifier_root` is one `!` on one statement and stayed
// `SAME` through the whole defect. `src/core/node.cc`'s `find_root_tag` walks
// the INSTANTIATED tree and never consults an ancestor's tag, so the outer `!`
// is found first and the inner one is simply an ordinary child of the subtree
// that won. OpenSCAD warns ("More than one Root Modifier (!)") and renders the
// outer subtree WHOLE — measured at 2026.08.07: 231.0381 mm³, 264 facets, both
// children present.
//
// WHAT IT WOULD CATCH. Our evaluator's "am I already inside a chosen root?" and
// "has a root been chosen?" used to be the same flag. While the outer body was
// still running the root was not yet recorded, so the inner `!` was taken for
// the FIRST root: it stole its own subtree out of the outer body's sink, and
// the now-empty outer sink then overwrote it. We drew the sphere alone at
// 106.0381 mm³ and 🔴 THE CUBE VANISHED, with no diagnostic of any kind.
//
// 🔴 THE THIRD SOLID IS A CONTROL AND MUST NOT BE DELETED, AND IT IS THE ONE
// THING THIS CASE HAS THAT THE OTHER THREE ALREADY HAD. Everything under test
// here sits INSIDE the `!`, so a regression that refuses `!` by name and drops
// its statement would leave the file emitting nothing at all — `REFUSED`, which
// `CAD1` treats as safe, because nothing was emitted and nothing can be a wrong
// part. A capability silently LOST is exactly what a corpus exists to notice.
// The sibling at y=40 is suppressed by a WORKING root modifier and emitted by a
// broken one, so the loss is compared and scores `DIVERGES` instead of
// disappearing into a green. (Confirmed at the binary: adding it does not change
// what OpenSCAD exports — still 264 facets, still the union alone.)
//
// Decidability: the cube is 0…5 in x, the sphere is 17…23, and the control
// solid — in the run where a defect lets it out — is 40 mm away in y. No two
// bounding boxes can touch, so the mesh leg can always decide.
//
// PLANTED AND WATCHED RED (throwaway copy of `web/src/cad/scad.ts`, md5-verified
// against the live file before the edit; openscad 2026.08.07):
//   · the nested/sibling distinction removed (pre-`d749b176c2` behaviour) -> DIVERGES
//   · `!` refused by name and its statement dropped                       -> DIVERGES
//
// 🔴 THE CONTROL SOLID WAS PROVED, NOT ASSUMED. The second plant was run twice:
// against this file as shipped -> `DIVERGES` (NO-GO), and against a byte-copy of
// it with the last line deleted -> `REFUSED` (GO). Same defect, same plant, same
// binary; the only difference is the control solid, and it is the difference
// between a gate that goes red and a gate that does not.
!union() {
  !cube(5);
  translate([20, 0, 0]) sphere(3, $fn = 16);
}
translate([0, 40, 0]) cube([6, 5, 5]);
