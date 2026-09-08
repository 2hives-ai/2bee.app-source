// $fa/$fs as VARIABLES — the form people actually write. `SAME` as of
// 2026-08-11; its `CAD1_KNOWN` entry is a stale exemption, reported rather than
// edited (`gates/` is another boundary).
//
// 🔴 THIS HEADER SAID "scad.ts stores the assignment and mesh.ts never reads
// it". `mesh.ts` reads both — `fragmentsRequested` takes them off the primitive
// — and `scad.ts` resolves them per call site. The hard-coded 12/2 the row was
// describing lived in **`canon.mjs`**, on the harness's side of the comparison,
// so the instrument printed a tessellation our kernel had stopped using and
// attributed the difference to the product. ⚠ *A true fact about the wrong
// artefact reads exactly like a finding.*
//
// WHAT IT STILL CATCHES, AND WHY IT IS THE MORE IMPORTANT OF THE PAIR: the
// assignment form is dynamically scoped, so it must reach a primitive that never
// mentions `$fa` or `$fs` at all. A regression that only honours the argument
// form leaves this file at 12/2 and 840 triangles against the oracle's 5180.
$fa = 5;
$fs = 0.5;
sphere(r = 10);
