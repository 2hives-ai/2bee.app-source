// AN EMPTY color() IS NOTHING, AND THAT IS THE CASE THE PASS-THROUGH COULD GET
// WRONG. Verified at the binary: `color("blue") { }` emits `color([0,0,1,1]);`
// into the .csg with NO children and exports no geometry. The canonical form
// maps it to `U([])`, which normalise() reduces to EMPTY — so a wrapper with
// nothing in it cannot become a wrapper that counts as something.
color("blue") { }
