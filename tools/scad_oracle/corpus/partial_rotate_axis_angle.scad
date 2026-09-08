// 🔴 scad.ts REFUSES rotate(a, v) BY NAME and still emits the subtree UNROTATED.
// A refusal that keeps geometry is not a refusal; this case is here to measure it.
rotate(45, [1, 1, 0]) cube([20, 6, 6]);
