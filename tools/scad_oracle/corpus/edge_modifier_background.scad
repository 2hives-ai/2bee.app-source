// `%` is the background modifier: drawn in the preview, and NOT part of the
// render. OpenSCAD leaves it out of the STL, so contributing no geometry matches
// the exported solid exactly; what is genuinely missing here is the preview
// ghost, and that is what the refusal names.
//
// 🔴 THIS HEADER SAID `scad.ts` "refuses it by name and drops it too" UNTIL
// 2026-08-11, AND THE SECOND HALF IS NOW WRONG IN A WAY THAT MATTERS. The BODY
// is no longer dropped: since `d749b176c2` it is kept and evaluated into a
// throwaway sink, because a `!` written inside a `%` subtree still governs the
// whole model in OpenSCAD and a discarded body could never be searched for one.
// The refusal by name remains. ⚠ *Half a sentence going stale is the harder
// half to notice* — the first clause still reads true and carries the second.
//
// ⚠ ONE MODIFIER ON ONE STATEMENT AGAIN: this case scored `SAME` throughout the
// `%` defects fixed in `d749b176c2`. Its combinations are
// `edge_modifier_root_{in,on}_background` and `edge_modifier_background_operand`.
%sphere(r = 20, $fn = 16);
cube([10, 10, 10]);
