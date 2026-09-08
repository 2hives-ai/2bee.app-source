# OpenSCAD, completely — and the gap matrix against `2bee.cad`

> ✅ **STATUS BANNER ADDED 2026-08-11 BY THE TIER-0 FIX. THE BODY BELOW IS
> UNCHANGED.** §1 (the OpenSCAD surface) is a description of the reference
> implementation and does not go stale with our code. §2's *"2bee.cad today"*
> column does, and §3 and §4's Tier 0 have now been actioned:
>
> - **§3, the systemic finding — DONE.** The evaluator has a distinct `FAILED`
>   sentinel that no `??` default can absorb, refused at one guard rather than
>   at five call sites. All five measured forms in the §3 table now draw
>   **nothing** instead of a 1 mm or 7 mm part, and none of them reports
>   `trust: trusted` any more: `trust` is computed from the parse result as well
>   as the mesh.
> - **§2.1 `DIVERGES` — closed:** positional `cylinder` `r2` and `center`,
>   variable re-assignment order, the `!` and `#` modifiers, `1/0`, and the
>   `undef`-defaults-to-1 chain. **Still open by design:** top-level siblings,
>   the `$fn` clamp, the 2D-operand refusal, `undef` in a size vector,
>   `cylinder(undef)`, string concatenation and comparison, vector `*` vector,
>   and undefined variables.
> - **§2.2 `ABSENT` — closed:** `$fa`/`$fs` as assignments **and** as arguments;
>   surplus positional arguments now warn. `$t` and `$preview` are defined; the
>   `$vp*` family is still deliberately undefined.
> - **§2.3 `REFUSED` — `color()` and `render()` are now PASS-THROUGHS**, and the
>   six refusal reasons that said *"needs a geometry kernel"* have been replaced
>   with what each one actually still needs. `^` and `PI` are implemented.
> - **§4 Tier 0 — complete.** Tiers 1–5 are untouched, and the headline in
>   *"The honest headline"* still stands: finishing Tier 0 does not make this an
>   OpenSCAD-alike.
>
> ⚠ **The one number in §5 that has now been measured:** *"how much of
> `hardware/cad`'s real corpus this subset parses"*. `tools/scad_oracle
> --hardware`, over its 68-file selection, run before and after:
>
> | | before | after |
> |---|---|---|
> | `REFUSED` — nothing emitted at all | **50** | **24** |
> | `DIVERGES` — geometry emitted and compared | 3 | 27 |
> | `ERROR` | 1 | 3 |
> | `SAME` | 14, **all** empty-on-both-sides | 14, **all** empty-on-both-sides |
>
> Read that honestly: **26 files moved from "nothing" to "something the oracle
> can compare", and the number of files whose SOLID agrees with OpenSCAD is
> still essentially zero.** 28 of the 32 `DIVERGES` trip on the harness modelling
> OpenSCAD's `color(...)` as an opaque node it does not descend into, not on our
> geometry — spot-checked at `lib/components/buck_converter.scad`, where the
> volume is **6118.1848 mm³ on both sides**, and `lib/jzbz_cage.scad` is the
> first hardware file the oracle rates `same` on the solid leg. The 3 `ERROR`s
> need `is_undef()` (2) and user-defined functions (1).
>
> **Tier 0 was necessary and is not sufficient, exactly as this document said.**
> What the corpus needs next, by refusal weight: user-defined **functions**,
> **`children()`**, the **`is_*` predicates**, **list comprehensions**, then
> `linear_extrude` and the 2D kernel under it.

**Written 2026-08-10.** Research for founder request: *"behave in the same way OpenSCAD, have the
same functionalities as OpenSCAD"* (TODO #12). This document is the research, not the plan.

**Primary source, and it outranks every web page below:** OpenSCAD **2026.08.07 (git fa8ff8916)**,
installed at `/usr/local/bin/openscad`, Manifold backend 3.5.1, CGAL 6.0.1, Clipper2 2.0.1.
Every behavioural claim marked *(probed)* was settled by running that binary and reading its output,
not by reasoning about it.

**Subject under audit:** `web/src/cad/scad.ts` (1661 lines — tokenizer, parser, evaluator, scene
tree) and `web/src/cad/mesh.ts` (1581 lines — tessellator, affine stack, BSP CSG kernel, manifold
audit), at the working tree of 2026-08-10.

---

## 0. Method, and what each verdict is worth

Three classes of evidence appear below, and they are not equal. The class is stated on every row
that carries a claim.

| Class | What it means | How it was obtained |
|---|---|---|
| **(probed both)** | The same `.scad` source was run through OpenSCAD **and** through our own `scad.ts`+`mesh.ts`, and the two outputs were compared numerically. | `openscad -o out.csg` / `-o out.stl` / `-o out.echo` for OpenSCAD; a node harness built with the repo's own `esbuild` over `web/src/cad/*.ts` for ours. Volumes compared by summing the signed tetrahedron volume of every triangle in both meshes. |
| **(probed OpenSCAD)** | Only OpenSCAD was run — the construct does not exist on our side at all, so there is nothing to run. | as above |
| **(source read)** | Read out of our TypeScript. Weakest class. Used only where a probe could not reach the behaviour. | — |

The harness is not committed; it is three files in the session scratchpad
(`harness.ts`, `verts.ts`, `vol.ts`) bundled with `web/node_modules/.bin/esbuild`. It imports
`parseScad` and `meshScene` directly, so it exercises **the same modules the browser loads** — not
a re-implementation.

**Secondary sources, all read 2026-08-10:**

- OpenSCAD CheatSheet — <https://openscad.org/cheatsheet/index.html>
- OpenSCAD User Manual, *Other Language Features* — <https://en.wikibooks.org/wiki/OpenSCAD_User_Manual/Other_Language_Features>
- OpenSCAD User Manual, *2D to 3D Extrusion* — <https://en.wikibooks.org/wiki/OpenSCAD_User_Manual/2D_to_3D_Extrusion>
- OpenSCAD User Manual, *Importing Geometry* — <https://en.wikibooks.org/wiki/OpenSCAD_User_Manual/Importing_Geometry>

**Where the docs and the binary disagree, the binary is the fact.** Two disagreements were found and
are recorded in §1.4 and §1.11 rather than quietly resolved.

---

## 1. The OpenSCAD surface, enumerated

Parameter lists below are taken from the binary wherever possible: `openscad -o out.csg in.scad`
dumps the **evaluated CSG tree with every parameter resolved to its default**, which is a stronger
source than a wiki signature. Those are marked *(binary-resolved)*.

### 1.1 3D primitives

| Construct | Signature (binary-resolved) |
|---|---|
| `cube` | `cube(size = [x,y,z] \| scalar, center = false)` |
| `sphere` | `sphere(r \| d, $fn = 0, $fa = 12, $fs = 2)` |
| `cylinder` | `cylinder(h, r1, r2, center = false, $fn = 0, $fa = 12, $fs = 2)` — accepts `r`, `d`, `r1`/`r2`, `d1`/`d2`. **Positional order is `h, r1, r2, center`** (probed OpenSCAD: `cylinder(10,5,3,true)` → `h=10, r1=5, r2=3, center=true`). |
| `polyhedron` | `polyhedron(points, faces, convexity = 1)` — explicit vertex + face list; `triangles` is the deprecated spelling of `faces`. |

`cylinder` precedence, probed: `cylinder(h=10, r=5, r1=2)` → `r1=2, r2=5` (the specific overrides the
general, per side) with `WARNING: Cylinder parameters ambiguous`. `cylinder(h=10, d=8, d1=2)` →
`r1=1, r2=4`. Diameters beat radii: `sphere(r=5, d=20)` → `r=10` with
`WARNING: Ignoring radius variable "r" as diameter "d" is defined too.`

### 1.2 2D primitives

| Construct | Signature (binary-resolved) |
|---|---|
| `square` | `square(size = [x,y] \| scalar, center = false)` |
| `circle` | `circle(r \| d, $fn = 0, $fa = 12, $fs = 2)` |
| `polygon` | `polygon(points, paths, convexity = 1)` — `paths` optional; multiple paths make holes |
| `text` | `text(text, size = 10, spacing = 1, font, direction = "ltr", language = "en", script = "latin", halign = "left", valign = "baseline", $fn, $fa, $fs)` |
| `import` | 2D side: DXF, SVG, PDF. See §1.9. |
| `projection` | `projection(cut = false, convexity = 0)` — 3D→2D |

Curiosity, probed: `text(script="latin")` is echoed back by the binary as `script = "Lati"` — the
field is truncated to four characters internally. Not a defect we inherit; recorded because it is
the kind of thing a compatibility test would trip over.

### 1.3 Booleans

`union()`, `difference()`, `intersection()`. `difference` is *first child minus the union of the
rest*. A group used as an operand is unioned first. All three take arbitrary children.

### 1.4 2D → 3D and 3D → 2D

`linear_extrude` (binary-resolved defaults): `height`, `center = false`, `convexity`, `twist`,
`slices`, `scale = 1`, `segments`, `v` (dev snapshots only), `$fn`/`$fa`/`$fs`.

> 🔴 **Docs-vs-binary disagreement #1.** The User Manual's *2D to 3D Extrusion* page shows
> `linear_extrude(height = 5, v = [0,0,1], center = true, …)` as the syntax line. Probed:
> `linear_extrude(10) square(5);` exports with a **Z range of 0 → 10**, so **`center` defaults to
> `false`.** The wiki line is an example call, not a default list, and it reads exactly like one.

`rotate_extrude` (binary-resolved): `angle = 360`, `start`, `convexity = 2`, `$fn`/`$fa`/`$fs`.
`start` defaults to **180** when `angle` is omitted and to **0** when `angle` is given — probed both
ways; the manual states this and the binary confirms it. The 2D child must lie entirely on one side
of the Y axis (every vertex `x >= 0` or every vertex `x <= 0`).

`projection(cut)`: `cut = false` projects the shadow of the solid; `cut = true` takes the slice at
Z = 0.

### 1.5 Transformations

`translate([x,y,z])` · `rotate([x,y,z])` · `rotate(a, v)` · `scale([x,y,z])` ·
`resize(newsize, auto = [1,1,1], convexity = 0)` · `mirror([x,y,z])` · `multmatrix(m)` ·
`color("name", alpha)` / `color("#rrggbb")` / `color([r,g,b,a])` · `offset(r | delta, chamfer)` ·
`hull()` · `minkowski(convexity = 0)`.

Rotation order, **probed and derived**: `rotate([10,20,30])` produces the matrix
`[[0.813798, -0.44097, 0.378522], [0.469846, 0.882564, 0.0180283], [-0.34202, 0.163176, 0.925417]]`,
which is exactly **Rz · Ry · Rx**. Confirmed by hand-multiplying the three elementary matrices.

`rotate([45])` — a one-element vector — is **rotation about X**, probed:
`[[1,0,0],[0,0.707107,-0.707107],[0,0.707107,0.707107]]`.

`scale(2)` — a scalar — scales uniformly, probed. `translate(5)` — a scalar — does **not** translate:
`WARNING: Unable to convert translate(5) parameter to a vec3 or vec2 of numbers`, and the emitted
matrix is the identity.

`mirror` and negative `scale` both emit a negative-determinant `multmatrix` and OpenSCAD handles the
winding flip internally (probed: `scale([-1,1,1])` → `multmatrix([[-1,0,0,0],…])`).

### 1.6 Flow control and list comprehensions

`for (i = range | list)`, several bindings in one `for` (nested loops), `intersection_for(...)`,
`if / else`, `let (...) { }`. `assign(...)` **has been removed from the language**: probed on
2026.08.07, `assign(b=3) cube(b);` gives `WARNING: Ignoring unknown module 'assign'` and emits
nothing. The cheatsheet still lists it.

List comprehensions (all probed): `[for (i=[0:3]) i*i]` → `[0,1,4,9]`;
`[for (i=[0:5]) if (i%2==0) i]` → `[0,2,4]`; `[each [1,2], 3]` → `[1,2,3]`;
`let(a=2,b=3) a*b` → `6`; and the C-style form
`[for (a=0, b=1; a<4; a=a+1, b=b*2) b]` → `[1,2,4,8]`.

Ranges: `[start:end]` and `[start:step:end]`, end-inclusive.

### 1.7 Modules and functions

`module name(params) { … }` with default arguments, positional and named call sites; `children()`,
`children(idx)`, `children([i:j])`, `$children`. Probed: `module pick() { children(1); }` picks the
second child. Modules are hoisted — visible before their textual definition.

`function name(params) = expr;` and **function literals** `f = function (x) x + x;` (2021.01+).
Probed: `f = function(x) x*2; echo(f(3));` → `ECHO: 6`.

Recursion is supported in both modules and functions.

### 1.8 Special variables

`$fa` (min angle, default 12) · `$fs` (min size, default 2) · `$fn` (segment count, default 0) ·
`$t` (animation step) · `$vpr` `$vpt` `$vpd` `$vpf` (viewport, readable **and writable**) ·
`$children` · `$preview`. Probed values at a bare invocation:
`$t = 0`, `$preview = true`, `$vpr = [55,0,25]`, `$vpt = [0,0,0]`, `$vpd = 140`, `$vpf = 22.5`.

`$`-prefixed names are **dynamically scoped** — set at a call site, they reach inside the callee.

The fragment count, quoted verbatim from the User Manual and matching the observed output:

```c
int get_line_segments_from_r(double r, double fn, double fs, double fa) {
  if (r < GRID_FINE) return 3;
  if (fn > 0.0) return (int)(fn >= 3 ? fn : 3);
  return (int)ceil(fmax(fmin(360.0 / fa, r*2*M_PI / fs), 5));
}
```

`$fn` is **not clamped** by OpenSCAD: probed `sphere(5, $fn=1000)` exports **999,996 triangles**.

### 1.9 Import, surface, export

`import(file, convexity, layer, origin, scale, center, dpi, id, $fn/$fa/$fs)`.
3D: **STL, OFF, OBJ, AMF (deprecated), 3MF**. 2D: **DXF, SVG, PDF**. Data: **JSON**.
`surface(file, center = false, invert = false, convexity, timestamp)` — reads a text heightmap
matrix or a PNG (`timestamp` is binary-resolved and undocumented on the wiki page read).

Export targets, from `openscad --help`: `stl, off, wrl, amf, 3mf, csg, dxf, svg, pdf, png, echo,
ast, term, nef3, nefdbg, param, pov`, plus `--export-format asciistl|binstl`. Per-format settings are
enumerated by `--help-export` (e.g. `export-3mf/unit`, `export-pdf/paper-size`,
`export-svg/stroke-width`) and set with `-O section/key=value`.

### 1.10 Modifier characters — language, not editor chrome

Probed against both the CSG tree and the exported STL:

| Modifier | CSG tree | Exported STL |
|---|---|---|
| `*` disable | absent | absent |
| `!` show-only | **only the marked subtree survives**; everything else is dropped | same |
| `#` highlight | present, marked `#` | **present** — it is real geometry |
| `%` background | present, marked `%` | **absent** — excluded from the render |

`!` is the one most likely to be mistaken for a comment: `!translate([50,0,0]) cube(5); cube(1);`
emits *only* the translated cube.

### 1.11 Built-in functions

Maths: `abs sign sin cos tan asin acos atan atan2 floor round ceil ln log pow sqrt exp min max
norm cross rands`. Trigonometry is in **degrees**.

Strings and lists: `str chr ord len concat lookup search`. Type tests: `is_undef is_bool is_num
is_string is_list is_function`. Meta: `version() version_num() parent_module(idx)`. Statements:
`echo(...)`, `assert(condition, message)`.

Probed values, all from one run: `lookup(2.5, [[0,0],[5,10]])` → `5`; `search("b","abc")` → `[1]`;
`chr(65)` → `"A"`; `ord("A")` → `65`; `version()` → `[2026, 8, 7]`; `version_num()` → `2.02608e+7`;
`cross([1,0,0],[0,1,0])` → `[0,0,1]`; `rands(0,1,2,42)` → `[0.796543, 0.183435]`.

Constants: `PI` (probed → `3.14159`), `undef`, `true`, `false`.

Operators: `+ - * / % ^ < <= == != >= > && || !` and the ternary `? :`.
**`^` is exponentiation** — probed, `2^10` → `1024`. Vector `*` vector is the **dot product** —
probed, `[1,2,3]*[1,2,3]` → `14`.

> 🔴 **Docs-vs-binary disagreement #2, in our favour for once.** The cheatsheet lists `assign (…) { … }`
> under *Other* with no deprecation marker. The binary has removed it (§1.6). A compatibility target
> taken from the cheatsheet would implement a construct the reference implementation no longer has.

### 1.12 Variable semantics — the one that surprises everybody

**Assignment is not imperative.** Within a scope, the *last* assignment to a name wins for the whole
scope, including lines textually above it.

Probed both ways:

```scad
x = 1;
cube(x);
x = 2;
```

OpenSCAD emits `cube(size = [2,2,2])` with
`WARNING: "x" was assigned on line 1 but was overwritten`.

Undefined values propagate rather than stopping: `cube(undef)` → `cube(size=[1,1,1])`, and
`cube([20,20,undef])` → `cube(size=[20,20,1])` with a warning. `1/0` → `inf`; `0/0` → `nan`.
`"a" + "b"` → `undef` with `WARNING: undefined operation (string + string)`.
`"a" < "b"` → `true` (lexical comparison).

### 1.13 The Customizer

Annotations in the source drive a parameter UI and a JSON parameter file:

```scad
/* [Dimensions] */
// width of the plate
width = 20;  // [10:50]
height = 5;  // [1:0.5:10]
/* [Options] */
style = "round"; // [round, square]
/* [Hidden] */
secret = 42;
```

`openscad -o out.param file.scad` emits, probed verbatim:

```json
{"parameters":[{"caption":"width of the plate","group":"Dimensions","initial":20.0,"max":50.0,
"min":10.0,"name":"width","step":1.0,"type":"number"}, …],"title":"cust"}
```

`/* [Hidden] */` members are excluded from that export. `-p file.json -P setname` applies a saved
parameter set (probed: `width` 20 → 40); `-D name=value` overrides one variable from the command
line (probed: `width` → 99).

### 1.14 Experimental features (`--enable`)

`openscad --help` lists exactly: `roof`, `input-driver-dbus`, `lazy-union`,
`vertex-object-renderers-indexing`, `textmetrics`, `import-function`, `object-function`,
`predictible-output` *(sic)*, `vector-swizzle`, `discretization-by-error`, `ai-features`.
These are **not the language** and are marked as such throughout §2.

Probed:

- `roof` — `roof(method="voronoi", convexity=1, $fn/$fa/$fs)` on a 2D child. Without `--enable roof`:
  `WARNING: Experimental builtin module 'roof' is not enabled` then `Ignoring unknown module 'roof'`.
- `textmetrics` — `textmetrics("Hi", size=10)` →
  `{ position = [1.1392, 0]; size = [11.0413, 10.0672]; ascent = 10.0672; descent = 0;
  offset = [0,0]; advance = [13.1158, 0]; }`, plus `fontmetrics()`.
- `import-function` — `import()` usable in an expression, returning data rather than geometry.
- `object-function` — `object(a=1,b=2)` → `{ a = 1; b = 2; }`, with `o.a` member access.
- `vector-swizzle` — **multi-component** access only. `v.x` works with the feature **off** (probed:
  `[1,2,3].x` → `1`); `v.xy` and `v.zyx` return `undef` off and `[1,2]` / `[3,2,1]` on.
- `lazy-union` — top-level siblings are **not** unioned. Probed: two overlapping 10 mm cubes export
  at volume **2000** with the flag and **1875** (the true union) without it.
- `discretization-by-error` — adds a `$fe` special variable to the resolved parameter list.

---

## 2. The gap matrix

Sorted worst-first, as instructed. `DIVERGES` and `ABSENT` are the findings; `REFUSED` and `SAME`
are the inventory.

### 2.1 `DIVERGES` — we accept it and quietly do something else

| construct | OpenSCAD behaviour (cited) | 2bee.cad today | verdict |
|---|---|---|---|
| `cylinder(h, r1, r2)` **positional** | `cylinder(10,5,3)` → `h=10, r1=5, r2=3`. A cone. *(probed OpenSCAD, §1.1)* | `scad.ts:1296-1297` resolves `r2` as `named.r2 ?? rAll ?? pos[2]`, and `rAll` is already `5` from `pos[1]`, so **`pos[2]` is never reached**. Probed both: ours emits `r1 5, r2 5` — a straight cylinder. **No refusal, no error, no warning.** | 🔴 **DIVERGES** |
| `cylinder(h, r1, r2, center)` **positional** | 4th positional is `center`. `cylinder(10,5,3,true)` → `center=true`, Z from −5 to +5. *(probed OpenSCAD)* | `scad.ts:1302` reads `center` from **named arguments only**. Probed both: our bounds are Z 0→10. Silent. | 🔴 **DIVERGES** |
| `rotate(a, v)` axis-angle | `rotate(a=90, v=[1,0,0])` → `multmatrix([[1,0,0,0],[0,0,-1,0],[0,1,0,0],…])`, i.e. Rx(90). *(probed OpenSCAD)* | `scad.ts:1198-1206` names the refusal **and still emits the subtree with `v = [0,0,0]`**. Probed both: a `[10,2,2]` bar comes out **unrotated**, volume 40, audit `closed`, trust `trusted`. The refusal text says so — but the picture is a solid the source never described. | 🔴 **DIVERGES** |
| variable re-assignment | Last assignment in a scope wins for the whole scope. `x=1; cube(x); x=2;` → `cube(2)`, with a warning. *(probed OpenSCAD, §1.12)* | Imperative, first-wins: probed ours → `cube(1)`, volume 1, no diagnostic. **Any file that sets a default at the top and overrides it at the bottom builds the wrong size.** | 🔴 **DIVERGES** |
| `!` show-only modifier | Emits **only** the marked subtree; everything else is dropped. *(probed OpenSCAD, §1.10)* | `scad.ts:487-495` refuses the modifier and **discards the marked subtree**, keeping everything else. Probed both: OpenSCAD draws the translated cube, we draw the other one. **Exact complement.** Named in the refusal list. | 🔴 **DIVERGES** |
| `#` highlight modifier | Real geometry — present in the CSG tree *and* in the exported STL. *(probed OpenSCAD, §1.10)* | Refused by name, subtree dropped. The part loses a feature. Named, so a reader can find it. | 🔴 **DIVERGES** |
| top-level siblings | Unioned on export. Two overlapping 10 mm cubes → volume **1875**. *(probed OpenSCAD)* | Kept separate: probed ours → **2000**, two `closed` parts with buried internal faces. Deliberate, documented at `mesh.ts:1387-1396`, and it is exactly OpenSCAD's `--enable lazy-union` behaviour — but not its default. Invisible in a viewport, wrong in any measurement or export. | 🔴 **DIVERGES** *(by design)* |
| `$fn` above 256 | Not clamped. `sphere(5,$fn=1000)` → 999,996 triangles, volume **523.5902**. *(probed OpenSCAD)* | `mesh.ts:74` clamps to `MAX_FN = 256` and raises a `warning`-severity issue. Probed ours: 65,532 triangles, volume **523.4674** — 0.023 % small. Disclosed. | 🔴 **DIVERGES** *(warned)* |
| 2D operand inside a 3D boolean | Warns twice (`Mixing 2D and 3D objects is not supported`, `Ignoring 2D child object`) and **returns the 3D result**. `difference(){cube(10); circle(3);}` exports the plain cube, 12 facets. *(probed OpenSCAD)* | `mesh.ts:1268-1284` refuses the **whole node** and draws nothing, on the stated ground that returning the minuend is the specific lie that puts an uncut pocket on a machine. Probed ours: `trust: nothing`. **We are deliberately stricter than the reference implementation here.** | 🔴 **DIVERGES** *(deliberate, safer)* |
| `undef` inside a size vector | Substitutes 1 for the undef component with a warning: `cube([20,20,undef])` → `[20,20,1]`. *(probed OpenSCAD)* | Errors (`cube() size must be a number or [x,y,z], got a vector`) and draws nothing. Safer direction, still a different program. | 🔴 **DIVERGES** *(safer)* |
| `cylinder(undef, undef)` | Defaults to `h=1, r1=1, r2=1`. *(probed OpenSCAD)* | Errors `cylinder() needs a numeric h`, draws nothing. Note `cube/sphere/circle/square(undef)` **do** match OpenSCAD's default-to-1 (probed both) — `cylinder` is the odd one out. | 🔴 **DIVERGES** *(safer)* |
| `x / 0`, `0 / 0` | `inf` and `nan`. `a=1/0; cube(a);` → `cube(size=[inf,inf,inf])`. *(probed OpenSCAD)* | `scad.ts:1430` returns `undefined` for a zero divisor. Probed ours: the `undef` then hits the primitive's `?? 1` default and emits a **1 mm cube, with no diagnostic at all.** | 🔴 **DIVERGES** |
| `"a" + "b"` | `undef`, with `WARNING: undefined operation (string + string)`. *(probed OpenSCAD)* | `scad.ts:1416` **concatenates**. We accept something OpenSCAD rejects. Harmless today (strings reach no geometry), a divergence in the permissive direction. | 🔴 **DIVERGES** |
| string comparison `<` `>` | Lexical. `"a" < "b"` → `true`; `cube("a"<"b" ? 3 : 7)` → `cube(3)`. *(probed OpenSCAD)* | Errors `cannot apply < to a string and a string` → the expression is `undef` → the ternary takes the **false** branch. Probed ours: `cube(7)`, volume 343 against OpenSCAD's 27. An error was printed and a wrong part was drawn. | 🔴 **DIVERGES** |
| vector `*` vector | Dot product. `[1,2,3]*[1,2,3]` → `14`, `cube(d)` → 14 mm. *(probed OpenSCAD)* | Errors, yields `undef`, and the primitive defaults: probed ours → **1 mm cube**. | 🔴 **DIVERGES** |
| undefined variable | Warns and continues with `undef`. | `scad.ts:1350` raises an **error**. Deliberate and documented in the source. Stricter, not wrong, but a valid OpenSCAD file can be all-red here. | 🔴 **DIVERGES** *(deliberate)* |

### 2.2 `ABSENT` — neither implemented nor refused, and silent

| construct | OpenSCAD behaviour (cited) | 2bee.cad today | verdict |
|---|---|---|---|
| `$fa` / `$fs` **as assignments** | Govern tessellation whenever `$fn` is 0. `$fa=1; $fs=0.1; sphere(5);` → 99,536 triangles, volume **523.5123**. *(probed OpenSCAD)* | `$fa=1;` parses as an ordinary assignment, is stored, and **is never read**: `mesh.ts:78-79` hard-codes `DEFAULT_FA = 12` / `DEFAULT_FS = 2`. Probed ours: 252 triangles, volume **490.9169** — a **6.2 % volume error with zero diagnostic**. (`scad.ts:1241-1246` refuses `$fa`/`$fs` only when passed as an *argument*; the assignment form is the one people actually use.) | ⚫ **ABSENT** |
| every other `$` variable as an assignment | `$vpd = 500;` moves the camera; `$t = 0.5;` sets the animation step. *(probed OpenSCAD — the binary even warns `Viewall and autocenter disabled in favor of $vp*`)* | Stored and never read. No diagnostic. Harmless for geometry today; the pattern is what matters — **`$fn` is the only special variable our evaluator consumes.** | ⚫ **ABSENT** |
| unknown named args on `sphere`/`cube`/etc. that happen to be allowlisted | `sphere(center=true, r=3)` → `WARNING: variable "center" not specified as parameter`. *(probed OpenSCAD)* | `scad.ts:1276` lists `center` in `sphere`'s accepted keys, so it is swallowed silently. Same geometry, no warning. | ⚫ **ABSENT** *(cosmetic)* |
| args on booleans | `difference(convexity=5)` → `WARNING: variable "convexity" not specified as parameter`. *(probed OpenSCAD)* | `scad.ts:1178-1181` ignores every argument to a boolean without looking at it. Probed ours: correct geometry, no message. | ⚫ **ABSENT** *(cosmetic)* |
| surplus positional args to a user module | Warns. | Silently dropped (`scad.ts:1131-1139` iterates the *parameters*, not the arguments). Named arguments that do not match **are** refused; positional ones are not. *(source read)* | ⚫ **ABSENT** |

### 2.3 `REFUSED` — not implemented, and said so by name with the line

Every row below was **verified to fire** by running the construct through our evaluator, not by
trusting `KNOWN_REFUSED_MODULES`. One 18-line file containing `linear_extrude`, `rotate_extrude`,
`projection`, `offset` ×2, `text`, `polygon`, `polyhedron`, `hull`, `minkowski`, `resize`, `mirror`,
`multmatrix`, `color` ×2, `render` and `surface` produced **18 refusals, 0 triangles, `trust: nothing`.**

| construct | OpenSCAD behaviour (cited) | 2bee.cad today | verdict |
|---|---|---|---|
| `hull()` | convex hull of the children *(cheatsheet)* | refused, `scad.ts:318`; subtree dropped | REFUSED |
| `minkowski(convexity)` | Minkowski sum *(binary-resolved)* | refused, `scad.ts:317` | REFUSED |
| `offset(r \| delta, chamfer)` | 2D outward/inward offset *(binary-resolved)* | refused, `scad.ts:319` | REFUSED |
| `linear_extrude(...)` | §1.4 | refused, `scad.ts:320` | REFUSED |
| `rotate_extrude(...)` | §1.4 | refused, `scad.ts:321` | REFUSED |
| `projection(cut)` | 3D → 2D | refused, `scad.ts:331` | REFUSED |
| `polygon(points, paths)` | §1.2 | refused, `scad.ts:322` | REFUSED |
| `polyhedron(points, faces)` | §1.1 | refused, `scad.ts:323` | REFUSED |
| `mirror([x,y,z])` | negative-determinant transform *(probed OpenSCAD)* | refused, `scad.ts:324`; and `mesh.ts:1198-1216` independently refuses **any** transform with `det <= 0`, so `scale([-1,1,1])` and `scale([0,1,1])` are caught too — probed, both refused | REFUSED |
| `multmatrix(m)` | arbitrary 4×4 | refused, `scad.ts:325` | REFUSED |
| `resize(newsize, auto)` | rescale to a bounding box | refused, `scad.ts:326` | REFUSED |
| `color(...)` | **pass-through** — geometry survives *(probed OpenSCAD)* | refused, `scad.ts:327`, **subtree dropped**. Any model that wraps parts in `color()` loses them entirely. | REFUSED |
| `render(convexity)` | **pass-through** *(probed OpenSCAD)* | refused, `scad.ts:332`, subtree dropped | REFUSED |
| `import(...)` | §1.9 | refused, `scad.ts:328` | REFUSED |
| `surface(file, …)` | §1.9 | refused, `scad.ts:329` | REFUSED |
| `text(...)` | §1.2 | refused, `scad.ts:330` | REFUSED |
| `children()` / `children(idx)` / `$children` | §1.7 — probed, `children(1)` picks the second child | refused, `scad.ts:333`; and a user module called with a child block raises a second refusal (`scad.ts:1151-1156`). Probed: `module ring(n){for(...) children();} ring(4){...}` → **0 triangles**, 2 refusals. | REFUSED |
| `intersection_for(...)` | §1.6 — probed, produces a real `intersection()` of the iterations | refused, `scad.ts:515-525` | REFUSED |
| `let(...)` statement and `let(...)` expression | §1.6 | refused, `scad.ts:504-514` and `scad.ts:812-821` | REFUSED |
| `each` in an expression | §1.6 | refused, `scad.ts:812-821` | REFUSED |
| list comprehensions `[for …]`, `[if …]`, `[each …]` | §1.6 | refused, `scad.ts:842-855`, by name, without mis-parsing into a vector of the wrong length | REFUSED |
| `function name(...) = expr;` | §1.7 | refused at the **definition** (`scad.ts:565-580`) *and* at every **call** (`scad.ts:1450-1458`). Probed: `function sq(x)=x*x; cube(sq(3));` → 2 refusals. ⚠ but see §3 — it still drew a cube. | REFUSED |
| `echo(...)` | prints to console | refused, `scad.ts:334` — there is no console surface in the tab | REFUSED |
| `assert(cond, msg)` | halts on failure | refused, `scad.ts:335` | REFUSED |
| `include <…>` / `use <…>` | §2.4 | refused, `scad.ts:582-593` — no file system in the tab | REFUSED |
| `str chr ord search lookup version version_num parent_module cross rands is_*` | §1.11 | not in `MATH_FNS`, so refused generically by `scad.ts:1450-1458` — named, but with the generic "not a function this subset knows" text rather than a specific reason | REFUSED |
| `assign(...)` | **removed from OpenSCAD** *(probed)* | refused generically. Our refusal happens to match the reference implementation's own removal. | REFUSED |
| `%` background modifier | excluded from the render *(probed)* | refused, subtree dropped — which **matches OpenSCAD's exported geometry**, by a different route and with a different message | REFUSED |
| `^` exponentiation | `2^10` → `1024` *(probed)* | not in the tokenizer's operator set; probed ours → `unexpected character "^"` plus a cascading parse error. Diagnosed, but as a lexical error rather than by name. | REFUSED *(weakly)* |
| `PI` | `3.14159` *(probed)* | not predefined; probed ours → `variable PI is not defined here`, then the primitive defaults to 1 mm. Diagnosed. | REFUSED *(weakly)* |
| function **literals** `f = function(x) …` | §1.7 — probed, works | probed ours → `expected ";", found "x"`. The user is stopped, but the message names the wrong token and never says "function literals are not implemented". | REFUSED *(weakly — misattributed)* |
| `$t`, `$preview`, `$vpr/$vpt/$vpd/$vpf`, `$children` **read** | §1.8 | probed ours → `variable $t is not defined here; it evaluates to undef`, then `cannot apply + to undef and a number`. Diagnosed as a missing variable, not as a missing feature. | REFUSED *(weakly)* |
| `roof`, `textmetrics`, `fontmetrics`, `object()`, `import()`-as-function, `.xy`/`.zyx` swizzle | **experimental**, `--enable` only (§1.14) | all refused generically. Correctly out of scope — these are not the language. | REFUSED |
| Customizer annotations (§1.13) | drive a parameter UI, `-p`/`-P`/`-D`, `param` export | `/* [Section] */` and `// [10:50]` are **comments**, so they are stripped by the tokenizer and nothing is built from them. No parameter UI exists. Not a silent wrong shape — the model still evaluates with its literal defaults. | REFUSED *(by omission)* |

### 2.4 `SAME` — implemented, and the semantics were checked

| construct | OpenSCAD behaviour (cited) | 2bee.cad today | verdict |
|---|---|---|---|
| `cube(size, center)` | scalar or `[x,y,z]`; `center` default false | **probed both** on `cube(10)`, `cube([10,10,10])`, `cube(2,center=true)`, `cube(undef)` → identical size vectors and identical 12-triangle meshes | SAME |
| `sphere(r \| d)` tessellation | §1.8 formula, no pole vertex | **probed both, vertex-for-vertex.** `sphere(3)` → OpenSCAD 96 triangles / 50 unique vertices; ours 96 / 50; the two sorted vertex sets are **identical to 4 decimal places** (`diff` clean apart from a trailing newline). `sphere(r=5,d=20)` → both resolve `r=10`. | SAME |
| `cylinder(h, r1, r2, $fn)` tessellation | as above | **probed both, vertex-for-vertex.** `cylinder(h=7,r1=4,r2=2,$fn=9)` → OpenSCAD 32 triangles / 18 vertices; ours 32 / 18; identical sorted vertex sets. | SAME |
| `cylinder` **named** `r`/`d`/`r1`/`r2`/`d1`/`d2` precedence | `cylinder(h=10,r=5,r1=2)` → `r1=2,r2=5`; `cylinder(h=10,d=8,d1=2)` → `r1=1,r2=4` | **probed both** — our resolved radii match exactly. Only the *positional* form diverges (§2.1). | SAME |
| `square(size, center)`, `circle(r \| d, $fn)` | 2D outlines | **probed both** — same fragment counts; carried as `dim: 2` flats, never handed to the CSG kernel | SAME |
| `union()` | boolean OR | **probed both by volume.** `union(){cube(10); translate([5,5,5]) cube(10);}` → OpenSCAD **1875.0000**, ours **1875.0000**, audit `closed`. | SAME |
| `difference()` | first child minus the union of the rest | **probed both by volume.** `difference(){cube(20,center=true); cylinder(h=30,r=5,center=true,$fn=16);}` → both **6469.2663**. And the flush-face case the kernel header warns about, `difference(){cube(10); translate([5,5,0]) cube(10);}` → both **750.0000**, audit `closed`. | SAME |
| `intersection()` | boolean AND | **probed both by volume.** `intersection(){cube(10); translate([5,5,5]) sphere(6,$fn=20);}` → OpenSCAD **778.7081**, ours **778.7080** (332 triangles each). | SAME |
| `translate(v)` | vector translate | **probed both** | SAME |
| `rotate([x,y,z])` | Rz·Ry·Rx, degrees | **probed both.** `rotate([10,20,30])` matrix derived from OpenSCAD's CSG dump and hand-multiplied; `mesh.ts:262-271` composes `compose(compose(rz,ry),rx)` — the same order. `rotate([45])` → Rx(45) in both. `rotate(45)` scalar → about Z in both. | SAME |
| `scale(v)` | scalar or vector | **probed both.** `scale(2)` → uniform ×2 in both. Negative and zero components are refused by us (§2.3) where OpenSCAD accepts them. | SAME |
| `for (i = range \| vector)`, multiple bindings | nested loops, end-inclusive ranges | **probed both** on `[0:n-1]` and `[a:step:b]` — same iteration sets. `scad.ts:1038-1068`. | SAME |
| `if / else`, `else if` | — | source read + probed on the geometry side | SAME |
| `module` definition, defaults, positional + named args, hoisting | §1.7 | **probed both** — matching trees for every module case that does not use `children()` | SAME |
| `$fn` dynamic scoping | set at a call site, reaches inside a module | `scad.ts:925-936` walks a separate `dynamic` chain for `$` names and a `lexical` chain for the rest — the correct distinction. *(source read; the geometry consequence was probed via `$fn` on primitives)* | SAME |
| `*` disable modifier | subtree absent from the CSG tree | **probed both** — absent from both trees | SAME |
| ranges `[a:b]`, `[a:step:b]` | end-inclusive | probed via `for` | SAME |
| `abs sign sin cos tan asin acos atan atan2 sqrt pow exp ln log min max floor ceil round len norm concat` | degrees for trig | `scad.ts:1461-1524`. `len` handles strings and lists; `min`/`max` flatten a vector argument; `concat` flattens one level — all matching OpenSCAD's documented behaviour. *(source read against the cheatsheet; not probed value-by-value)* | SAME |
| `.x` / `.y` / `.z` member access | works **without** `--enable vector-swizzle` *(probed)* | `scad.ts:764-779`. Multi-component swizzles refused by name. | SAME |
| `// …` and `/* … */` comments | — | probed; an unclosed `/*` is an error rather than a swallowed file | SAME |
| tessellation fragment formula | §1.8 | `mesh.ts:340-346` reproduces `get_line_segments_from_r` including the `max(…, 5)` floor. One immaterial difference: our small-radius shortcut is `r < 1e-6`, OpenSCAD's is `r < GRID_FINE` (2⁻²⁰ ≈ 9.5367e-7). Only radii in that sub-micron band differ. | SAME |
| `include` vs `use` distinction | **probed OpenSCAD:** `include` runs the file's top-level geometry **and** imports its variables; `use` imports only modules/functions — `echo(shared)` after `use` gives `WARNING: Ignoring unknown variable "shared"` and the included file's own `cube(1)` is **not** emitted | both refused by us, so the distinction does not yet apply — recorded here because it is the part everyone implements wrongly first | *(REFUSED, see 2.3)* |

---

## 3. The systemic finding

Three of the rows above are the same defect wearing three costumes, and it deserves to be stated
once, plainly, because it contradicts this lane's own stated contract.

`scad.ts` opens with: *"The tree is therefore always a SUBSET of what the source says, never a guess
at it."* `scad.test-notes.md` repeats it. **That property does not hold today.** Measured cases:

| source | OpenSCAD | ours | what we drew |
|---|---|---|---|
| `function sq(x)=x*x; cube(sq(3));` | 27 mm³ | **1 mm³** | a 1 mm cube, plus 2 refusals |
| `a = "a"<"b" ? 3 : 7; cube(a);` | 27 mm³ | **343 mm³** | a 7 mm cube, plus 1 error |
| `d=[1,2,3]*[1,2,3]; cube(d);` | 2744 mm³ | **1 mm³** | a 1 mm cube, plus 1 error |
| `a = 1/0; cube(a);` | infinite | **1 mm³** | a 1 mm cube, **no diagnostic at all** |
| `rotate(a=90,v=[1,0,0]) cube([10,2,2]);` | rotated bar | 40 mm³ **unrotated** | the bar in the wrong orientation, plus 1 refusal |

The mechanism is the same every time: a refused or failed **expression** evaluates to `undef`, and
`undef` is then indistinguishable from *"the argument was not supplied"* at the primitive, because
`scad.ts` uses `??` against a literal default (`named.get('size') ?? pos[0] ?? 1`). A named refusal
therefore does not remove a node from the tree — it **resizes** it. And in the ternary case, an
error does not stop evaluation, it silently selects the other branch.

Every one of those runs reported `trust: trusted` and an audit verdict of `closed`, because the audit
in `mesh.ts` asks whether the **mesh** is watertight, not whether the **model** is the one the source
describes. It is a correct answer to a different question, and on these inputs it is reassuring about
a wrong part.

This is cheap to fix and does not need a kernel: give the evaluator a distinct "this argument failed"
value that a primitive must refuse rather than default, and stop emitting a transform node whose
parameters were refused. It should be done **before** any of the tiers below, because every tier adds
more expressions that can fail.

---

## 4. Sizing — what is left, grouped by what it costs

Counted honestly: of the constructs enumerated in §1, **`2bee.cad` implements 5 primitives, 3
transforms, 3 booleans, `for`/`if`, modules, 22 built-in functions and the `*` modifier.** Everything
else in §1 is refused, absent or divergent. That is a real subset — the CSG core of the language is
genuinely there and, where it is there, it is **numerically identical to OpenSCAD** (§2.4). It is not
close to the language.

### Tier 0 — correctness of what already exists

**Needs:** no new kernel, no new dependency. Roughly a day.
**Contains:** every `DIVERGES` row in §2.1 that is not marked *deliberate*, plus §3.
Positional `cylinder` `r2`/`center`; last-assignment-wins scoping; `$fa`/`$fs` as assignments
(≈ 6 % volume error, silent); the `undef`-defaults-to-1 chain; `^` and `PI`.
**Breaks without it:** files that are valid OpenSCAD build the wrong part with a green audit.
**This tier is not optional and it is not "polish".** Nothing above it is safe while it is open.

### Tier 1 — the 2D kernel and extrusion

**Needs:** a real 2D polygon kernel — boolean ops, offsetting, and a robust triangulator — under
`polygon()`, plus the extrusion sweeps on top of it. OpenSCAD itself uses **Clipper2** for exactly
this (`--info` reports Clipper2 2.0.1). AGPL-compatible options exist; the licence check that TODO
#12 already demands applies here first.
**Contains:** `polygon`, `offset`, `linear_extrude` (with `twist`, `slices`, `scale`, `center`,
`convexity`), `rotate_extrude` (with `angle`, `start`), `projection`, and 2D booleans as first-class
operations rather than a refused node.
**Size:** the largest single item on this list. Weeks, not days.
**Breaks without it:** ⚠ **this is the tier that decides whether the tab is useful to this lane at
all.** The CNC side of `2bee.app` consumes **2D outlines**. Without extrusion and a 2D kernel,
`2bee.cad` cannot produce the one artefact `2bee.cnc` eats, and TODO #12 step 5 — *"hand geometry
straight to the CNC tab, that is the entire point of one app"* — is unreachable. It is also what
`hardware/cad`'s `*_wcnc.scad` files are actually made of.

### Tier 2 — `hull()` and `minkowski()`

**Needs:** a convex-hull routine (3D quickhull, ~300 lines, no dependency) for `hull()`.
`minkowski()` is a different order of problem: the general solid case is convex-decomposition plus a
pairwise sum, and it is the single most expensive operation in OpenSCAD.
**Size:** `hull()` days; `minkowski()` weeks, and honestly should be **left refused** until something
needs it.
**Breaks without it:** rounded-corner idioms (`hull()` of four cylinders) are ubiquitous in real
`.scad` files. `minkowski()` is rarer and slower and nobody misses it in CAM work.

### Tier 3 — `polyhedron` and `import`

**Needs:** for `polyhedron`, only a face-list reader plus the existing manifold audit — it is
genuinely small, and the audit already in `mesh.ts` is the right gate for user-supplied faces.
For `import`, an STL/OFF/3MF reader and a browser file surface; the repo **already has an STL reader
in `core/src/mesh.rs`** on the CNC side, so the work is plumbing, not parsing.
**Size:** days each.
**Breaks without it:** no way to bring in a bought part or a scanned fixture. A CAD tab that cannot
open a file is a toy.

### Tier 4 — text and fonts

**Needs:** a font stack in the browser — font loading, shaping, and glyph-outline extraction to
polygons — then Tier 1's kernel to make the outlines into geometry. OpenSCAD uses freetype +
harfbuzz + fontconfig (all three are in `--info`). In a browser this means shipping an OpenType
parser and a shaper, or accepting a much smaller subset than `text()` promises.
**Size:** weeks, and it drags in a licensing question about any bundled font.
**Breaks without it:** engraved labels and part numbers. Common in signage work, uncommon in the
hive-part geometry this lane actually cuts.

### Tier 5 — the long tail

Cheap, and mostly independent of any kernel:
`color()` and `render()` are **pass-throughs** — refusing them drops geometry for no technical
reason at all, and both are a few lines.
`multmatrix()` needs nothing new: `mesh.ts` already carries a full affine stack.
`intersection_for()` needs nothing new either: the 3D kernel that would implement it **already
exists** and its refusal text (`scad.ts:336`, *"needs a geometry kernel"*) is **stale** — written for
stage 1, before `mesh.ts`.
`resize()` needs a bounding box, which `mesh.ts` already computes.
`mirror()` and negative `scale()` need one honest fix — flip the winding when the determinant is
negative — rather than the current blanket refusal.
`echo`/`assert` need a console pane, which the tab does not have.
`children()`/`$children` need a child-passing mechanism in the evaluator: a real but contained job,
and the one whose absence hurts most, because module-with-children is *the* OpenSCAD idiom.
User-defined **functions** and **list comprehensions** are a parser-and-evaluator job with no
geometry in them at all — and they are what most real `.scad` files are built out of.
`include`/`use` need a virtual file system in the browser.
The **Customizer** is a parser over comment annotations plus a UI; it is self-contained and it is
the feature most likely to make the tab pleasant.

Also unbuilt and not in any tier above: **the tab has no export at all.** `CadTab.tsx` renders an
editor, a scene tree and a preview. There is no STL, no DXF, no path into `2bee.cnc`.

### The honest headline

**`2bee.cad` cannot be called an OpenSCAD-alike today, and finishing Tier 0 will not change that.**
It is a correct, well-audited implementation of the CSG *core* — and the numeric evidence for that is
strong: identical vertex sets on curved primitives, and boolean volumes matching OpenSCAD's Manifold
backend to four decimal places on four separate cases including the flush-face case its own header
warns about. That is a genuinely good foundation and it should be said as clearly as the gaps.

But a user typing ordinary OpenSCAD into this tab today will hit a refusal or a divergence on
almost any real file, because real files use `linear_extrude`, `children()`, user functions and list
comprehensions on nearly every page.

- **Tier 0 is required before anything else** — it is where the silent wrong parts are.
- **Tier 1 + the `children()`/functions/comprehensions slice of Tier 5 are the minimum** before the
  phrase "an OpenSCAD-alike" is defensible outward. Below that line the honest description is
  *"a browser CSG previewer that reads a subset of the OpenSCAD language"* — which is a true and
  useful thing to be, and is what the README should keep saying until the line is crossed.
- **Tiers 2, 4 and `minkowski` are long-tail.** A refusal is better than an approximation, and a
  named refusal for `minkowski()` will cost this lane nothing for a long time.

---

## 5. UNKNOWN — what this research did not settle

- **Which 2D kernel is AGPL-compatible and shippable to WASM.** Clipper2 is what OpenSCAD uses;
  whether its licence, its Rust ports and its WASM footprint suit this lane is a licence-and-build
  question, not a language question. **Settled by:** a licence review plus one spike compiling a
  candidate into the existing `core/` WASM target and measuring the bundle delta.
- **Whether `mesh.ts`'s BSP kernel is adequate for Tier 1 output.** The four boolean cases probed
  here matched OpenSCAD exactly, but all four were built from our own primitives. Extrusion output
  and imported meshes are the inputs its header names as its weakness (self-intersection, coplanar
  faces). **Settled by:** running the audit over extruded and imported operands once they exist —
  which is a reason to build the audit's fixtures alongside Tier 1, not after it.
- **How much of `hardware/cad`'s real `*_wcnc.scad` corpus this subset already parses.** Nothing in
  this document measures that, and it is the single most decision-relevant number available.
  **Settled by:** running `parseScad` over every `.scad` file in `hardware/cad/` and counting
  refusals per file. That is a half-hour job and it would turn this tier list into a priority order
  driven by our own geometry instead of by the language's shape. **Recommended as the immediate next
  step.**
- **Whether OpenSCAD's `$fn` has any upper clamp at all.** 1000 was probed and honoured; no clamp was
  found in the range tested. **Settled by:** reading `get_fragments_from_r`'s caller in the source, or
  probing upward until something gives.
