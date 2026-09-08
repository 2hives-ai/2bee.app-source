// `is_undef()` and the `||` short-circuit — the two halves of the single most
// common idiom in the files this company actually cuts, and the corpus had
// neither.
//
// WHY IT WAS CHOSEN, WITH THE COUNT AND ITS DENOMINATOR. `is_undef` appears in
// **100 of the 246 non-archive `.scad` files** under `hardware/cad/`, and in
// **27 of the 68** that `--hardware` actually covers (32 sites, every one of them
// passing a bare name). The corpus called it **zero** times. Both forms below are
// the ones those files write:
//   · `X = is_undef(X) ? <default> : X;`      — the parameter-default idiom
//   · `if (is_undef(_flag) || <read _flag>)`  — the library-guard idiom, which
//     decides whether a library file draws itself when opened alone
//
// WHAT IT WOULD CATCH. Two independent mechanisms, each of which has already
// been wrong here:
//   1. `is_undef(<bare name>)` is a SPECIAL FORM: it asks the ENVIRONMENT
//      whether the name is bound and never evaluates it. An unbound name
//      evaluates to the poison value `FAILED` in this evaluator (deliberately —
//      it is what stops a refused expression being absorbed as an omitted
//      argument), so a predicate that simply evaluated its argument would refuse
//      the whole line. The self-referential first line is exactly that case.
//   2. `||` SHORT-CIRCUITS, and it is not an optimisation. Both operands used to
//      be evaluated, so the guard idiom reported an undefined variable, poisoned
//      the condition, and the `if` was refused — a library file that draws
//      itself when opened alone drew NOTHING, for a name the source is
//      deliberately asking about rather than reading.
//
// 🔴 THE THIRD SOLID IS A CONTROL AND MUST NOT BE DELETED. Without it, a
// regression that refuses BOTH constructs leaves the file emitting nothing at
// all, which scores `REFUSED` — a verdict `CAD1` treats as safe. An
// unconditional solid means any partial loss is compared and scores `DIVERGES`
// or `ERROR` instead. A refusal that keeps geometry is not a refusal, and this
// case is built so the harness gets to say so.
//
// Decidability: 40 mm apart in y, footprints at most 12 x 5 mm.
//
// PLANTED AND WATCHED RED (throwaway copy, openscad 2026.08.07):
//   · the `is_undef` special form removed (argument evaluated) -> ERROR
//   · `||` evaluating both operands                            -> ERROR
depth = is_undef(depth) ? 12 : 3;
cube([depth, 5, 5]);
translate([0, 20, 0]) if (is_undef(alsonone) || alsonone) cube([8, 5, 5]);
translate([0, 40, 0]) cube([6, 5, 5]);
