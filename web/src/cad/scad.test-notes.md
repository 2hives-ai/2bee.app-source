# `scad.ts` — what the subset does, and what it refuses

Stage 1 of TODO #12 (`2bee.cad`). Written 2026-08-08.
**Revised 2026-08-11** after the silent-divergence audit
(`docs/audit/2026-08-11-scad-silent-divergence.md`) and the gap matrix
(`docs/openscad-feature-inventory.md`), both measured against **OpenSCAD
2026.08.07** at `/usr/local/bin/openscad`.

**The one property this file exists to protect:** the scene tree is always a
**subset** of what the source says, never a **guess** at it. Anything the parser
does not implement is reported by name with its line and contributes **nothing**
to the tree.

> 🔴 **THAT PROPERTY DID NOT HOLD, AND THIS FILE ASSERTED IT ANYWAY.** A refused
> expression evaluated to `undefined`, and `undefined` is exactly what an
> *omitted* argument looks like to `named.get('size') ?? pos[0] ?? 1`. So a
> refusal did not remove a node — it **resized** it: `cube(sq(3))` with `sq`
> refused drew a **1 mm³ cube where the source says 27**, audited `closed`,
> reported `trust: trusted`. Five such forms were measured. Fixed 2026-08-11 by
> giving the evaluator a distinct sentinel (`FAILED`) that no default can absorb
> and that every node builder refuses through one guard, rather than by patching
> the five call sites.

🔴 **There is no geometry kernel *in this file*.** `union` / `difference` /
`intersection` are parsed and represented as nodes with children; **no boolean is
computed here**. ⚠ *This section used to end "nothing this file produces can be
cut", which was written before `mesh.ts` existed.* `mesh.ts` now tessellates the
tree, computes the booleans for real and audits the result, and `CadTab.tsx` can
save a model into the drawings list the CNC tab cuts from. The seam is still
real; the sentence about what lies beyond it is not.

---

## Implemented, and exercised

**There are two test files**, both run with `npm run test:node`:
`web/tests/scad-openscad-divergence.test.ts` and — for the Stage 0 constructs
added 2026-08-11 — `web/tests/scad-stage0.test.ts`. Every expectation in both was
taken from the OpenSCAD binary (`-o out.csg` / `-o out.stl` / `-o out.echo`),
never from our own output, and defects were planted back to watch each suite go
red: four in the first (including one that came back **green** and forced a
missing probe to be written) and four in the second. Read the header of the
relevant file before trusting any row below.

## Where `use <...>` and `include <...>` resolve from

🔴 **The browser has no file system, so this file resolves nothing — it asks a
HOST.** `parseScad(src, { host, path })`, where `host.read(spec, from)` returns
`{ path, source }` or `null`. `spec` is exactly the text between the angle
brackets, taken from the SOURCE by character range rather than rebuilt from
tokens, so a path is never approximated into the file next to the one the source
names.

⚠ **With no host, every import is REFUSED — and the refusal carries the path.**
`use <../lib/brand_corner.scad>`, not `use <...>`. An unresolvable import is
**never** treated as an empty file: an empty file would turn every module it
defines into an "unknown module", which reads to the user as a typo in their own
source rather than as a file we could not open. The import's own detail says so.

Also refused, by name, and each says which: a **circular** import (the chain is
printed), a chain deeper than 16, and more than 128 files in one parse.

A diagnostic raised inside an imported file is reported at the line of the
`include`/`use` — the only line the reader has on screen — with the real file and
line in the name (`lib.scad:2 hull()`). A line number that indexes a different
file is worse than no line number.

| Construct | Notes |
|---|---|
| `cube(size, center)` | `size` as a scalar or a vector of **exactly 3** numbers; positional or named. A 2- or 4-vector falls back to **1 mm** and is named, which is what OpenSCAD does |
| `sphere(r \| d, $fn, $fa, $fs)` | `d` converted to `r` |
| `cylinder(h, r1, r2, center, $fn, $fa, $fs)` | ⚠ **positional order is `h, r1, r2, center` — all four.** An unspecified radius defaults to **1, not to the other radius**: `cylinder(10,5)` is a cone 5→1, in both tools. `r`/`d` set both sides, then `r1`/`r2`/`d1`/`d2` override per side |
| `square(size, center)` | 2D, flagged as 2D in the tree; `size` scalar or exactly 2 numbers |
| `circle(r \| d, $fn, $fa, $fs)` | 2D |
| `scale(v)` | scalar or vector; a scalar fills all three axes, as in OpenSCAD |
| `translate(v)` | vector only. ⚠ **A scalar is a NO-OP**, as in OpenSCAD — `translate(5)` translates by nothing and is named. It used to expand to `[5,5,5]` |
| `rotate(a)` | scalar `a` is a rotation about Z; `[x,y,z]` is taken as degrees |
| `union()` `difference()` `intersection()` | represented here, **computed in `mesh.ts`** |
| `color(c, alpha)` | **implemented as of 2026-08-11** — CSS Color 4 names (148, case-insensitive), `#rgb`/`#rgba`/`#rrggbb`/`#rrggbbaa` hex, `[r,g,b]`/`[r,g,b,a]` vectors, and `alpha` applied after and independently of `c`. ⚠ **The OUTERMOST `color()` wins**, and a partially-stated one is replaced *whole* by an inner one — both are OpenSCAD's rule and both are the opposite of the obvious guess. `xkcd:` names are **refused by name**. Named gaps (alpha floor, per-operand colour in a boolean, STL export) are in `docs/audit/2026-08-11-scad-silent-divergence.md` §I. *(This row said **"pass-through — the colour is discarded"** until 2026-08-11, which was true and made `color()` the one construct that was accepted, changed nothing, and warned nobody.)* |
| `render(...)` | **pass-through.** Geometry survives; there is one evaluation path here, so there is nothing to force |
| `group()` and bare `{ ... }` blocks | own scope |
| variables, arithmetic, comparison, `&&`, `\|\|`, `!`, `? :`, **`^`** | `^` is exponentiation: right-associative, binding tighter than unary minus (`-2^2` = −4, `2^3^2` = 512) |
| `PI` | predefined; a user assignment to the name still wins |
| `$t`, `$preview` | `$t = 0`; **`$preview = true`** — see the note in `rootEnv()`, it is a choice |
| vectors, indexing `v[i]`, `.x` `.y` `.z` | |
| ranges `[a:b]` and `[a:step:b]` | item count computed OpenSCAD's way, to the last ulp — see divergence note 6 |
| `module name(params) { ... }` and calls | defaults, positional and named args. A named argument **consumes** the positional slot it overrides; a default is evaluated where the module was **defined** |
| `function name(params) = expr;` and calls | **hoisted** (`cube(g(2)); function g(x)=x*4;` is an 8 mm cube); **recursive** (`fact(5)` = 120); a **user function shadows a builtin** (`function sin(x)=999`); a default is evaluated where the function was **defined**, so it does not see an earlier parameter. Depth limit 256, and hitting it is an **error naming recursion**, never a value |
| `children()` `children(i)` `children([a:b])` `children([i,j])` `$children` | the child is evaluated in the **caller's** scope; a `for` handed as one child is **one** child; an out-of-range index is OpenSCAD's own `Children index (i) out of bounds (n children)` warning and emits nothing; a child block that is never instantiated emits nothing |
| `is_undef` `is_bool` `is_num` `is_string` `is_list` `is_function` | ⚠ `is_undef(<a bare name>)` is a **special form** — see divergence note 1. `is_function` is `false` for every value this subset can produce, because it has no function literals |
| `let(...)` — expression **and** statement form | bindings are **sequential** (`let(a=5, b=a+1)`: `b` sees the new `a`); the statement form is a scope and the binding does not escape it |
| `use <path>` / `include <path>` | resolved through a host the caller supplies (`parseScad(src, { host, path })`) — see the section below. **`include` is textual** (its top-level geometry runs, its variables join this scope); **`use` imports only modules and functions**, and they keep **their own file's scope** |
| `for (i = range \| vector)`, several bindings in one `for` | |
| `if (cond) ... else ...` | a condition that FAILED takes **neither** branch |
| `$fn` `$fa` `$fs` | all three dynamically scoped, as arguments **and** as assignments, and honoured on a **transform or a boolean** as well as on a module call. `$fa`/`$fs` below 0.01 are clamped with OpenSCAD's own warning |
| `*` `!` `#` `%` modifiers | see the table below — they are language, not editor chrome |
| math functions | `abs sign sin cos tan asin acos atan atan2 sqrt pow exp ln log min max floor ceil round len norm concat`. Trig in degrees. **`round` rounds a half AWAY FROM ZERO** (C's rule), not toward +∞ |
| `//` and `/* */` comments | an unclosed `/*` is an error, not a swallowed file |

### The four modifier characters

Settled on what each does to the **exported geometry**, probed both ways.

| Modifier | OpenSCAD | Here | Was |
|---|---|---|---|
| `*` disable | absent from the tree | absent, exactly | same |
| `!` show-only | **only** the marked subtree survives, **without its ancestors**; a second `!` warns and the first wins | same | 🔴 the marked subtree was dropped and **everything else kept** — the exact inverse, `!cube(); sphere();` drew the sphere |
| `#` highlight | real geometry, present in the export | **pass-through** — the geometry is there, the highlight is not | 🔴 subtree dropped: `difference(){cube(20); #cyl;}` was an **uncut block** |
| `%` background | in the tree, **excluded** from render and export | subtree dropped — which matches the exported geometry — and named, because the ghost OpenSCAD shows in preview is genuinely missing | same geometry, stale reason |

## Refused by name, with the line

Each of these produces an entry in `unsupported[]` and **no scene node**. Its
children are not evaluated either, so a refused wrapper takes its subtree with
it.

> ⚠ **That is a much bigger blade than it reads as, and `color()` proved it.**
> Measured by `tools/scad_oracle` over `hardware/cad/` — the 68 `.scad` files
> this company actually cuts — `color()` alone was **198 of 360 refusal sites,
> across 36 files**. A refused `color()` did not lose the colour, it **deleted
> the model**. Before deciding a construct is "safer refused", ask what its
> subtree is.

`minkowski` · `hull` · `offset` · `linear_extrude` · `rotate_extrude` ·
`polygon` · `polyhedron` · `mirror` · `multmatrix` · `resize` · `import` ·
`surface` · `text` · `projection` · `echo` · `assert` ·
list comprehensions `[for (...) ...]` · `each(...)` in an expression ·
function **literals** (`f = function(x) …`) · multi-component swizzles (`v.xy`) ·
the `%` modifier · `rotate(a, v)` axis-angle · an unknown named parameter on a
supported primitive · any module or function name the subset does not know
(`str`, `chr`, `ord`, `search`, `lookup`, `version`, `cross`, `rands`, …) ·
**and `use`/`include` when the host cannot resolve the path** — see below.

⚠ **`children`, `let`, user-defined `function`, and `use`/`include` were on this
list until 2026-08-11 and are implemented now.** They are named here rather than
silently dropped because this file is the thing a reader uses to decide what the
tool would have to grow, and a refusal list that overstates the gap sends
somebody to build what is already there.

⚠ **`$fa` and `$fs` were on this list and were never on it in the code.** The
refusal branch sat below an allowlist that always matched first, so it was
**unreachable from anywhere in the file**, and the assignment form never reached
it at all. Both are implemented now. *(This line is kept rather than deleted
because two documents — this one and `mesh.ts` — asserted a refusal that did not
exist, and a reader who trusted either got a 6.2 % volume error with no
diagnostic.)*

⚠ **`color` and `render` were on this list and should not have been.** Both are
pass-throughs and neither needs anything that did not already exist.

Three refusals are worth their own line:

- **`rotate(a, v)`** keeps the subtree but leaves it **unrotated**, and says so.
  🔴 It is the one refusal no volume check can catch: volume and surface area
  agree with OpenSCAD to 1.6e-16 and only the tree and the bounding box differ.
  It now costs the model its `trusted` verdict, which it did not before.
- **`assert()`** is the refusal that **inverts**. Every other one makes the
  picture a *subset* of the model; this one makes it a *superset*, because
  OpenSCAD emits **nothing** when an assertion fails and we draw the model with
  the source's own safety check switched off.
- **an unknown named parameter** is refused rather than dropped. In OpenSCAD it
  is a warning; here the argument was **not applied** and the tree says so.

## Known divergences from OpenSCAD

Real differences in behaviour, not missing features. Every one below has been
measured on both sides; the ones the 2026-08-11 pass **closed** are listed after.

1. **Undefined variables are an error, and now stop the node.** OpenSCAD warns
   and continues with `undef`, and substitutes 1 for an `undef` inside a size
   vector (`cube([20,20,undef])` → `[20,20,1]`). Here it is an error and
   **nothing is drawn**. Deliberate: a dimension the user did not write is the
   one thing that must not reach a spindle quietly.

   ✅ **RESOLVED 2026-08-11 — the cost this note used to predict did not have to
   be paid, and the fix is worth reading because the obvious one was wrong.**
   This note said: *"the common OpenSCAD idiom `X = is_undef(X) ? 1 : X;` cannot
   work here even once `is_undef()` is implemented — the self-reference is a
   failed value, not an `undef`."* It is 32 sites in **27 of the 68** files
   `hardware/cad` cuts, so it decides whether those files evaluate at all.

   🔴 **The tempting fix is the forbidden one.** Making an unbound name evaluate
   to real `undef` would make the idiom work in one character — and `undef` is
   exactly what `named.get('size') ?? pos[0] ?? 1` reads as *"the argument was
   omitted"*, so it would re-open the 1 mm-cube defect at the top of this file.
   Planted and watched go red (`scad-stage0.test.ts`, PLANT D).

   ✅ **What was done instead: `is_undef(<a bare name>)` is a SPECIAL FORM.** It
   asks the environment whether the name is BOUND, and never evaluates it — so
   nothing is asked of the sentinel and the sentinel does not move. This is what
   the reference implementation does too: probed, `is_undef(nosuchname)` emits
   **no** warning while `b = nosuchname;` emits `WARNING: Ignoring unknown
   variable`. *Asking whether a name is defined and reading it are two different
   operations there as well, and only the second is an error here.* Making
   `&&`/`||` short-circuit (which OpenSCAD does, probed) covers the other written
   form, `if (is_undef(_x) || _x)`.

   ⚠ **The residual, named so it is not discovered later:**
   `is_undef(<any other expression>)` evaluates that expression, so
   `is_undef(str(1))` is a refusal rather than `true` — we do not know what the
   value would have been, so we cannot say it is not `undef`. No file in
   `hardware/cad/` writes that form; all 32 sites pass a bare name.
2. **No `inf`/`nan` — FROM DIVISION.** `1/0` is `inf` in OpenSCAD and carries
   into geometry. Here it is an error and nothing is drawn. (It used to be
   `undef` with **no diagnostic at all**, which then became a 1 mm cube.)

   ⚠ **CORRECTED 2026-08-11 — the heading over-claimed, and the over-claim was
   load-bearing.** Non-finite values are *not* absent: `sqrt(-1)`, `acos(2)` and
   `log(-1)` all produce `nan`, and `1e308*10` produces `inf`, with no
   diagnostic — division is simply the one route that is closed. That mattered
   at `$fn`, where "nan cannot get here" was written down as the reason a
   fall-through to `$fa`/`$fs` was safe: `circle(r=10,$fn=sqrt(-1))` is **3**
   points in OpenSCAD and was **30** here. `$fn` now carries `nan`/`inf` exactly
   as OpenSCAD does (`isnan || isinf` ⇒ 3); `$fa`/`$fs` substitute the default
   and **say so**, because OpenSCAD's own answer there is undefined behaviour
   (a `nan` `$fa` measures **one** SVG point). See
   `web/tests/cad-fragment-count.test.ts`.
3. **Strings.** `"a" < "b"` is a lexical comparison in OpenSCAD; here it is an
   error, and the ternary above it takes **neither** branch rather than the
   false one.
4. **Vector `*` vector** is a dot product in OpenSCAD; here it is an error.
5. **Line attribution inside modules.** A primitive inside a user module reports
   the line where the **primitive is written**, not the line of the call.
6. **Error recovery discards a span.** On a syntax error the parser skips to the
   next `;` or `}`. The tokens in between are **not** reported one by one, so a
   file with an error can hide a second construct inside the skipped span. This
   now costs the model its `trusted` verdict as well as showing an error count.
7. **`use`/`include` resolve nothing in the shipped tab.** `parseScad` takes an
   optional `{ host, path }`; **`CadTab.tsx` passes neither**, so in the app
   every import is refused — by path, with a detail saying that the "unknown
   module" that follows is the import's fault and not the user's typo. The
   evaluator half is done and tested against an in-memory host; the tab half is
   another lane's file and is not written.
8. **Top-level siblings are not unioned** (`mesh.ts`), matching OpenSCAD's
   preview rather than its export.
9. **`$fn` above 256 is clamped** by `mesh.ts`, with a warning. OpenSCAD does
   not clamp. The clamp now reports itself whether the count came from `$fn` or
   from `$fa`/`$fs`.

### Closed on 2026-08-11 — these USED to be divergences

Kept visible because a stale entry in this list is exactly as misleading as a
stale claim of support, and note 1 below was the file's own headline divergence
for three days.

- ~~**No `$children`, no child passing.**~~ `children()`, `children(i)`,
  `children([a:b])` and `$children` are implemented, and a `{ ... }` block handed
  to a user module is no longer refused. *(Closed 2026-08-11 with the rest of
  Stage 0.)*
- ~~**Assignment order.**~~ OpenSCAD's rule is implemented: the **last**
  assignment in a scope governs the whole scope, and a re-assigned name keeps
  the **position** of its first assignment and takes the **expression** of its
  last. It was first-wins-in-sequence, and a 50 mm cube read as 10 mm.
  Overwrites are now reported per line, naming the variable and both lines.
- ~~`cylinder`'s third and fourth positional arguments.~~
- ~~`translate(scalar)` expanding to `[v,v,v]`.~~
- ~~`cube`/`square` padding and truncating a size vector.~~
- ~~A named argument not consuming its positional slot.~~
- ~~A module default evaluated in the call frame instead of the definition scope.~~
- ~~`round()` on negative halves.~~
- ~~`$fn` dropped on a transform or a boolean.~~
- ~~`for`-range endpoint off by one item.~~
- ~~`PI` reported as an undefined user variable; `^` as an unexpected character.~~

## Limits, and what happens at them

Evaluation stops and says so; it never returns a truncated tree that looks
finished.

| Limit | Value | Reported as |
|---|---|---|
| scene nodes | 20000 | error: nothing after that line was evaluated |
| module call depth | 64 | error: naming recursion as the likely cause |
| total loop iterations | 200000 | error |

`for (i = [0:1000000]) cube(1);` hits the node limit and reports it. A recursive
module with no base case hits the depth limit. Neither hangs the tab.

## What is next

Not a kernel — `mesh.ts` is the kernel and it consumes this tree rather than
being bolted into the evaluator. The four items this section named on 2026-08-11
— **user-defined functions**, **`children()`**, **`is_undef`/`is_num`/`is_list`**
and (with `let` and `use`/`include`) the rest of Stage 0 — are done. What is
left, counted by refusal sites over the 68 `hardware/cad/` files rather than by
guesswork: **list comprehensions**, then the 2D kernel behind `linear_extrude`,
`offset`, `polygon`, `rotate_extrude` and `projection`, then `hull()`.
**Any kernel candidate must be licence-checked against AGPL-3.0-or-later before
it is added**, per the lane rule, and the check belongs in the commit that adds
it.

### 🔴 Two things Stage 0 MADE VISIBLE rather than caused, handed on deliberately

Both files were `REFUSED` before Stage 0 — they stopped at line 1 — so neither
could be measured at all. Each is a real disagreement with OpenSCAD, in code this
change did not touch:

- **`hardware/cad/lib/honey_tank_sensor.scad` — 2.3 % under on volume
  (20243.7 vs 20714.2), 1.4 % under on area, ZERO refusals, and `trust:
  trusted`.** That combination is the exact failure this lane's controls exist to
  catch: a complete-looking model, a green verdict, and a solid that is not the
  source's. The file sets no `$fn`/`$fa`/`$fs`, so the tessellation defaults are
  doing the work. **Not diagnosed here** — it is a kernel/tessellation question,
  not an evaluator one.
- **`hardware/cad/lib/inwall_cover_box.scad` — 1.3e-4 relative on volume**, also
  zero refusals and `trusted`. Its tree difference is a rotation matrix printing
  `6.12323e-17` where OpenSCAD prints an exact `0`, i.e. `rotate([90,…])`.
