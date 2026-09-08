// `!` and `*` written on the SAME statement — the root modifier annihilated by
// the disable modifier.
//
// WHY IT WAS CHOSEN. The corpus had `edge_modifier_{disable,root,highlight,
// background}`, one modifier and one statement each, and 🔴 ALL FOUR SCORED
// `SAME` BEFORE AND AFTER ALL FOUR DEFECTS FIXED IN `d749b176c2`. Every
// character was exercised; not one combination was. Asking "does a case cover
// this modifier?" returned yes and meant nothing — the entire defect class lived
// where two of them meet.
//
// WHAT IT WOULD CATCH. `src/core/parser.y` is the whole rule, in two lines:
//     '*' module_instantiation  { delete $2; $$ = NULL; }
//     '!' module_instantiation  { $$ = $2; if ($$) $$->tag_root = true; }
// `*` DELETES the instantiation, so the `!` has nothing left to tag and the file
// ends up with no root modifier at all — the rest of it renders normally.
// Measured at openscad 2026.08.07: this file exports the sphere (252 facets),
// and its `.csg` contains no `cube` at all. Until `d749b176c2` we treated the
// `!` as chosen, set the root sink to an empty subtree and emitted NOTHING — an
// empty viewport from a valid file, with no error, no warning and no refusal.
//
// ⚠ WHAT THIS CASE CANNOT SEE, NAMED SO IT IS NOT MISTAKEN FOR COVERAGE. The
// sphere IS the expected output here, so a regression that goes back to refusing
// `!` BY NAME and dropping its statement would emit exactly the same sphere and
// score `SAME` — correct by accident. That regression is visible in
// `edge_modifier_root_in_background` and `edge_modifier_root_on_background`,
// where the sibling is the wrong answer rather than the right one. Read the four
// as one set, not as four independent guards.
//
// Decidability: one solid, so the mesh leg cannot be undecidable here.
//
// PLANTED AND WATCHED RED (throwaway copy of `web/src/cad/scad.ts`, md5-verified
// against the live file before the edit; openscad 2026.08.07):
//   · the `*`-annihilates-`!` guard removed (pre-`d749b176c2` behaviour) -> DIVERGES
//     (this case only, over the full 81-case corpus: SAME 63->62, DIVERGES 4->5)
!*cube(5);
sphere(20, $fn = 16);
