// render() forces eager CGAL evaluation of a subtree. On the EXPORT path the
// whole tree is CGAL-evaluated anyway, so it changes nothing: verified at
// openscad 2026.08.07, `render() cube(3);` exports BYTE-IDENTICAL ASCII STL to
// `cube(3);`. OpenSCAD still writes it into the .csg as `render(convexity = 1)`.
render() cube([3, 3, 3]);
