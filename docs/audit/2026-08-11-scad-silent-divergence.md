# Silent-divergence audit — `web/src/cad/scad.ts` + `web/src/cad/mesh.ts` — 2026-08-11

> ✅ **STATUS BANNER ADDED 2026-08-11 BY THE TIER-0 FIX. THE BODY BELOW IS
> UNCHANGED** — it is a dated measurement of commit `78f5f1e63c` and it is
> still an accurate one. This banner exists only because a reader who arrives
> tomorrow would otherwise read it as the live state, and a stale red lies
> exactly like a stale green.
>
> **CLOSED:** findings 1–7 (assignment order · `cylinder` positional `r2` ·
> `cylinder` positional `center` · `translate(scalar)` · `cube`/`square` size
> vectors · named-argument slot consumption · sibling-referencing defaults),
> §A (`$fa`/`$fs`, both forms), §B (`$fn` on a transform or a boolean), §C
> (`round` on negative halves), §D (`for`-range endpoint), §E (`PI`), §F (`^`),
> the `trust` note under the modifier table, and the `#` and `!` rows of that
> table. `%` keeps the same geometry with a corrected reason.
>
> **STILL OPEN, deliberately:** §G (`inf`/`nan`, dot product, lexical string
> comparison, fractional and string indexing) and §H (`assert` inverts the
> refusal contract). `rotate(a, v)` is unchanged and remains the one refusal no
> volume check can see.
>
> **Current behaviour is asserted in** `web/tests/scad-openscad-divergence.test.ts`
> (37 cases, every expectation taken from the binary, four planted defects
> watched go red) and summarised in `web/src/cad/scad.test-notes.md`.
>
> 🔴 **ADDENDUM 2026-08-11 — `color()` WAS THIS AUDIT'S OWN BLIND SPOT, AND IT IS
> NOT IN THE BODY BELOW.** It was **accepted, changed nothing, and warned nobody**
> — the exact class this file exists to enumerate — and it escaped the pass.
> Found the same day by a live model call, fixed the same day. **See §I at the
> end**, written *after* the frozen body because the body is a dated measurement
> of `78f5f1e63c` and this was found later; editing it in place would back-date a
> finding.
>
> 🔴 **SECOND ADDENDUM, SAME DAY — THE MODIFIER TABLE IS TRUE ONLY FOR A MODIFIER
> WRITTEN ALONE, AND THAT IS THE CAVEAT IT DOES NOT CARRY.** `## The four modifier
> characters, measured` says *alone* in its method sentence and not in its verdict
> column; §I.1's *"`!` — implemented"* row says it nowhere. The root modifier was
> wrong in **four interaction shapes** — one of them a **different object**, one an
> **empty viewport** — each with no error, no warning and no refusal. ⚠ **Also
> corrects a figure inside its own residual** (`93 %` sites → a measured **9**).
> **See §J at the end.**

**Scope:** not the refusals. The refusals work. This audit hunts the one class the
refusal rule cannot catch — a construct we **accept** and then interpret
**differently from OpenSCAD**, so the picture on screen is a shape the user never
wrote and no diagnostic says so.

**Method: measured, not reasoned.** Every claim below was taken by running the
same source through **OpenSCAD 2026.08.07** (`/usr/local/bin/openscad`, `-o *.csg`
for the evaluated tree, `-o *.echo` for expression semantics, `-o *.stl` for the
mesh) and through **our own modules bundled with esbuild and run in node**
(`parseScad` → scene tree; `meshScene` → triangles, bounds, audit verdict). Where
this file quotes OpenSCAD, that text is pasted from the run, not remembered.

**Anchored to** `78f5f1e63c789f238e8b4d852312814203c08e0e` — the last commit
touching `web/src/cad/` when this pass started (tree tip
`b852597fdabef43af164c86a2c3018f898f8d88b`, 2026-08-10 21:28 +1000). These are
measurements with a timestamp, not facts.

**Nothing was fixed.** This file is a report. No other file was edited.

---

## What was actually run

| Probe file | Question |
|---|---|
| `v1 a1 a2 a3 l1 n1` | variable assignment order, in a file / a module body / a `{}` block / an `if` condition / `$fn` itself |
| `c1 c2 c3 c4 j1 q2` | `$fn` inheritance, `$fn = 0`, default `$fa`/`$fs`, `$fa`/`$fs` as variables and as arguments, `$fn` on a transform |
| `b1 i1 i2 n1 q2` | argument binding — positional, named, mixed, defaults, extra, missing, `d`/`d1`/`d2` |
| `h1 h2` + 21 expression probes | `undef` arithmetic, `1/0`, `0/0`, `%0`, string+number, vector arithmetic, out-of-range and fractional indexing, `^`, `round` |
| `d1` | `rotate` scalar / vector / order / axis-angle, bounds compared vertex-set to vertex-set |
| `e1 e2 e3 e4 e5 e6 m3` | `for` ranges — 7 forms, plus float accumulation at 4 magnitudes, plus multi-binding order |
| `f1 f2 f3 f4` | the four modifier characters, each alone and each inside a `difference()` |
| `k1` | 10 degenerate / empty cases |
| `o1 o2` | cylinder and sphere tessellation, vertex set against vertex set |
| `g1` | primitive size coercion — short vectors, long vectors, scalars |

---

## The seven findings that change the part, worst first

### 1. 🔴 Assignment order — a dimension can be off by any amount, with no line-level signal

**Physical failure: the part is cut to a size that appears nowhere in the file the
user is reading.**

OpenSCAD variables are not imperative. The **last** assignment in a scope wins for
the **whole** scope, including every line above it. Ours assigns top-to-bottom.

```scad
w = 10;
module part() { cube([w,w,w]); }
part();
w = 50;
```

Real OpenSCAD:

```
WARNING: "w" was assigned on line 1 but was overwritten in file a2.scad, line 4
group() {
	cube(size = [50, 50, 50], center = false);
}
```

Ours: `cube size [10, 10, 10] mm`. **A 50 mm cube read as a 10 mm cube.**

It is the same in every scope, measured separately:

| Probe | OpenSCAD | Ours |
|---|---|---|
| `x=1; cube(x); x=2;` | `cube(size = [2,2,2])` | `cube size [1,1,1]` |
| module body: `t=s; cube([t,t,t]); t=40;` | `cube(size = [40,40,40])` | `cube size [5,5,5]` |
| `{ u=1; cube([u,1,1]); u=7; }` | `cube(size = [7,1,1])` | `cube size [1,1,1]` |
| `d=4; if (d>5) cube(100); else cube(1); d=9;` | `cube(size = [100,100,100])` | `cube size [1,1,1]` |

And it reaches `$fn` too — `sphere(3); … $fn=8;` gets `$fn = 8` in OpenSCAD and no
`$fn` here (probe `n1`, lines 3–4 versus line 8).

**Source:** `scad.ts:1010-1012` — `case 'assign': env.vars.set(s.name, this.eval(s.value, env)); return;` executed inside the sequential loop at `scad.ts:999`.

**Already disclosed — but only in a banner.** `CadTab.tsx:71` carries
*"Variables assign in order here. OpenSCAD takes the last assignment in a scope
for the whole scope…"*, and `scad.test-notes.md` lists it as known divergence 1.
That is honest and it is why this is not the worst thing in the file. **It is
still ranked first, because the disclosure is a standing sentence about the tool
and OpenSCAD emits a per-line WARNING naming the variable and both lines.** A user
who reassigns one variable in a 200-line file gets a red banner they have already
read six times, and nothing pointing at the line. The banner tells them the class;
OpenSCAD tells them the instance.

---

### 2. 🔴 `cylinder(h, r1, r2)` — a cone comes out a cylinder

**The finding, in full: the third positional argument is silently read as `r1`, so a cone comes out a cylinder.**

**Physical failure: a taper that does not exist. A countersink cut as a straight
bore, or a draft angle silently removed.**

```scad
cylinder(20, 10, 4);
```

Real OpenSCAD:

```
cylinder($fn = 0, $fa = 12, $fs = 2, h = 20, r1 = 10, r2 = 4, center = false);
```

Ours: `cylinder h 20 mm, r1 10 mm, r2 10 mm` — **no refusal, no error, no
warning.** The top radius silently becomes the bottom radius.

**Source:** `scad.ts:1293-1297`.

```ts
const rAll = dd !== null ? dd / 2 : num(named.get('r') ?? pos[1] ?? undefined);
…
const r2 = d2 !== null ? d2 / 2 : (num(named.get('r2') ?? undefined) ?? rAll ?? num(pos[2] ?? undefined));
```

`rAll` is filled from `pos[1]`, and `rAll` is checked **before** `pos[2]`, so
`pos[2]` is unreachable whenever a second positional argument exists — which is
the only situation in which a third one can be written.

⚠ **`scad.test-notes.md:33` states the opposite** — *"`cylinder(h, r | d | r1/r2
| d1/d2, center, $fn)` — positional order `h, r1, r2`"*. The documented behaviour
is not the coded behaviour, and the doc is what a reader checks.

---

### 3. 🔴 `cylinder(h, r1, r2, center)` — the part sits off datum

**The finding, in full: the fourth positional argument is dropped, so the part sits half its height off datum.**

**Physical failure: every feature referenced to a centred cylinder is out by
`h/2` in Z. On a through-pocket that is a cut that misses the material or one
that runs into the spoilboard.**

```scad
cylinder(20, 10, 4, true);
```

OpenSCAD: `… r1 = 10, r2 = 4, center = true` (spans Z −10 … +10).
Ours: `cylinder h 20 mm, r1 10 mm, r2 10 mm` — **not centred** (spans Z 0 … 20),
and again no diagnostic.

**Source:** `scad.ts:1302` — `const center = truthy(named.get('center') ?? false);`
reads only the **named** map. `cube` (`scad.ts:1272`) and `square`
(`scad.ts:1313`) both accept `pos[1]` for `center` and both agree with OpenSCAD
when probed; `cylinder` is the odd one out.

---

### 4. 🔴 `translate(5)` — a scalar becomes `[5,5,5]` here and *nothing* in OpenSCAD

**Physical failure: the part is displaced diagonally by the same amount on all
three axes, from a line OpenSCAD treats as a no-op.**

```scad
translate(5) cube(1);
```

Real OpenSCAD:

```
WARNING: Unable to convert translate(5) parameter to a vec3 or vec2 of numbers in file g1.scad, line 3
multmatrix([[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]) {
```

Ours: `translate [5, 5, 5] mm`.

**Source:** `scad.ts:1220-1221` — `vec3()` expands any scalar to `[v,v,v]` for all
three of `translate`, `rotate` and `scale`. That is correct for `scale` (probed:
`scale(2)` → `[2,2,2]` in both) and correct for `rotate` (probed: `rotate(45)` →
Z-rotation in both). It is wrong for `translate`, where OpenSCAD rejects a scalar
outright.

---

### 5. 🔴 `cube()` with a 2- or 4-element size vector — we build a part, OpenSCAD builds a 1 mm cube

**Physical failure: a stock blank silently sized `[10, 20, 1]` instead of being
rejected, or a 4-vector typo quietly truncated to its first three components.**

| Source | OpenSCAD | Ours |
|---|---|---|
| `cube([10,20]);` | `WARNING: Unable to convert cube(size=[10, 20], …)` → `cube(size = [1,1,1])` | `cube size [10, 20, 1] mm` |
| `cube([10,20,30,40]);` | `WARNING: Unable to convert …` → `cube(size = [1,1,1])` | `cube size [10, 20, 30] mm` |

**Source:** `scad.ts:1225` — `return [nums[0] ?? fill, nums[1] ?? fill, nums[2] ?? fill];`
pads short vectors and truncates long ones, with `fill = 1` for `cube`/`square`.
Neither length is checked and neither is reported.

Note the direction: **OpenSCAD's fallback is loud and tiny (1 mm), ours is quiet
and plausible.** A 1 mm cube is obviously wrong on screen; `[10, 20, 1]` is not.

---

### 6. 🔴 A named argument does not consume its positional slot

**The finding, in full: a named argument after a positional one does not consume its slot, so the *next* parameter takes the positional value.**

**Physical failure: a wall thickness, a depth or a count receives a number the
user wrote for a different parameter.**

```scad
module m(a=1,b=2,c=3) { cube([a,b,c]); }
m(10, a=99);
```

Real OpenSCAD:

```
WARNING: argument "a" overrides positional argument in file i1.scad, line 7
	cube(size = [99, 2, 3], center = false);
```

Ours: `cube size [99, 10, 3] mm`. The `10` was written for `a`, was overridden by
`a=99`, and then **slid down into `b`** — which keeps its default `2` in OpenSCAD.
No refusal, no warning.

**Source:** `scad.ts:1131-1139`. The positional cursor `pi` only advances in the
`else if (pi < positional.length)` branch, so a parameter satisfied by name never
consumes the positional it shadows.

The other seven binding forms probed in the same file **agree** — see the ✅
section.

---

### 7. 🔴 A default referencing a sibling parameter evaluates here

**The finding, in full: a module parameter default that references a sibling parameter evaluates here and is `undef` in OpenSCAD.**

**Physical failure: a derived default (`b = a*2`, `depth = thickness+1`) produces
a real dimension here and a fallback dimension there.**

```scad
module n(a, b=a*2) { cube([a,b,1]); }
n(4);
```

Real OpenSCAD:

```
WARNING: Ignoring unknown variable "a" in file i2.scad, line 1
WARNING: undefined operation (undefined * number) in file i2.scad, line 1
WARNING: Unable to convert cube(size=[4, undef, 1], …) parameter to a number or a vec3 of numbers
```

STL bounds from that run: `[0,0,0] … [4,1,1]`.
Ours: `cube size [4, 8, 1] mm`. **8× in Y.**

**Source:** `scad.ts:1137` — `else if (p.def) env.vars.set(p.name, this.eval(p.def, env));`
evaluates the default in `env`, the frame already being filled, so earlier
parameters are visible to it. OpenSCAD evaluates defaults where the module was
*defined*, where `a` does not exist.

This one is the mirror image of the others: **ours is the more useful
behaviour.** It is still a divergence, and the user gets a part 8 mm deep from a
file that produces a 1 mm part in the tool the file was written for.

---

## ⚠ ABSENT — neither implemented nor refused

### A. `$fa` and `$fs` are ignored in both forms

**The finding, in full: `$fa` and `$fs` are silently ignored in both forms, and the refusal that would have named them is dead code.**

**Physical failure: every curve in the file is tessellated at a resolution the
source did not ask for. A bored hole is undersize by the chord sagitta.**

Probed both ways:

```scad
$fa = 1;  $fs = 0.2;  cylinder(h=10, r=5);     // as variables
cylinder(h=10, r=5, $fa=1, $fs=0.2);           // as arguments
```

OpenSCAD, both forms: `cylinder($fn = 0, $fa = 1, $fs = 0.2, …)`, **628 STL
facets ⇒ 158 sides**.
Ours, both forms: **60 triangles ⇒ 16 sides**, and the refusal list is **empty**.

At r = 5 that is a flat-to-arc error of `5·(1 − cos(180°/n))` = **0.096 mm** at
n = 16 against **0.001 mm** at n = 158 — a bore ~0.1 mm undersize relative to what
the source specifies. In the other direction (`$fa` raised to coarsen
deliberately) the preview is smoother than the part.

**Source, and why the refusal never fires** — `scad.ts:1238-1255`:

```ts
const accept = (allowed: string[]): void => {
  for (const key of named.keys()) {
    if (allowed.includes(key)) continue;          // ← this wins
    if (key === '$fa' || key === '$fs') {         // ← unreachable
      this.refuse(key, line, 'tessellation by angle or size is not implemented; …');
```

Every one of the five `accept()` call sites — `scad.ts:1265, 1276, 1286, 1306,
1317` — passes `'$fa'` and `'$fs'` in its allowed list, so the `continue` on the
line above always fires first. **The branch that names the refusal cannot be
reached from anywhere in the file.** As a variable (`$fa = 1;`) it never reaches
`accept()` at all: it is stored by `case 'assign'` and read by nothing.

⚠ **Two documents assert this refusal exists.** `mesh.ts:75-77` — *"`$fa`/`$fs`
are refused by the parser as ARGUMENTS, but their default values still govern a
bare `sphere(10)`"* — and `scad.test-notes.md:61`, which lists `$fa` and `$fs`
among the constructs *"refused by name, with the line"*. Both are false as
measured. This is the shape the lane already knows: **a guard built in the callee
and never armed by the caller reads as protected.**

`DEFAULT_FA = 12` / `DEFAULT_FS = 2` at `mesh.ts:78-79` are hard-coded and are the
only values `fragments()` (`mesh.ts:340-346`) can ever see.

### B. `$fn` passed to a transform or a boolean is dropped

```scad
translate([0,0,0], $fn=6) cylinder(h=5,r=3);
union($fn=6) { cylinder(h=5,r=3); }
```

OpenSCAD gives `$fn = 6` to the cylinder in both. Ours emits a cylinder with **no
`$fn`** in both, and reports nothing — the default 10 sides instead of 6. A
hexagonal boss or a hex-socket pocket comes out round-ish.

**Source:** `scad.ts:1087-1099`. `grouping()` reads only the first positional /
`v` / `a` argument; `$`-prefixed arguments on a transform or a boolean are never
inspected and the child environment (`newEnv(env, env)`, `scad.ts:1090`) is not
given them. The same argument on a **user module** call **is** honoured
(`scad.ts:1141`) — probed, agrees — so the gap is specific to the built-in
grouping nodes.

### C. `round()` disagrees on negative half-values by a full unit

| Expression | OpenSCAD | Ours |
|---|---|---|
| `round(-0.5)` | `-1` | `0` |
| `round(-1.5)` | `-2` | `-1` |
| `round(-2.5)` | `-3` | `-2` |
| `round(0.5) round(1.5) round(2.5)` | `1 2 3` | `1 2 3` |

**Source:** `scad.ts:1494-1495` — `Math.round(n(0))`. JS rounds half toward `+∞`;
C's `round()`, which OpenSCAD uses, rounds half **away from zero**. A `round(-x/2)`
centring idiom is 1 mm out. `floor`, `ceil`, `sign`, `abs`, `%`, `pow`, `atan2`
were probed alongside and all agree.

### D. `for` range endpoints — accumulated sum versus exact division

```scad
for (i = [1:0.05:1.2]) translate([i,0,0]) cube(1);
```

OpenSCAD: **4** iterations — `1, 1.05, 1.1, 1.15` (it computes
`floor((end−begin)/step)` and then `begin + i·step`).
Ours: **5** — it also emits `1.2`.

**Source:** `scad.ts:1560-1561` — `for (let x = r.start; x <= r.end + 1e-12; x += r.step)`.
The running sum reaches `1.2000000000000002`, which the `1e-12` slack admits;
OpenSCAD's division gives `3.9999999999999996 → floor 3 → 4 values`.

Probed at four magnitudes: `[0:0.1:0.3]` (4 = 4), `[0:0.1:1]` (11 = 11),
`[1000:0.3:1300]` (1001 = 1001) agree; only the case above diverges. The
consequence is **one extra hole / boss at the end of a patterned row** — the kind
of extra feature that is easy to miss on a preview and impossible to miss in the
material.

### E. `PI` is reported as a user error

`cube([PI,1,1])` → OpenSCAD `cube(size = [3.14159, 1, 1])`. Ours:
`L1 variable PI is not defined here; it evaluates to undef` and then a second
error on the cube. This is **loud**, so nothing wrong is cut — but the message
blames the user for a typo when the truth is that a language builtin is not
implemented. That is the difference the header calls out between a **named
refusal** and an **unknown name**, landing on the wrong side.

### F. `^` (exponentiation) is not a character the lexer knows

`2^3` → `L1 unexpected character "^"` followed by `expected "]", found "3"`, and
then the parser's recovery **discards the rest of the statement**
(`scad.ts:438-450`). OpenSCAD: `8`. Loud, but reported as a lexing accident rather
than as an operator the subset does not implement — and the discarded span can
hide a second construct, which is known divergence 4 in the test notes.
`ONE_CHAR_OPS` is at `scad.ts:150`.

### G. Smaller expression differences, all of which surface as an error here

Each of these is `undef` in our evaluator where OpenSCAD has a defined answer.
None is silent — every one produced a visible error line when fed to a
coordinate — so they are listed for completeness rather than ranked:

| Expression | OpenSCAD | Ours |
|---|---|---|
| `1/0`, `-1/0`, `0/0`, `5%0` | `inf, -inf, nan, nan` | `undef` (`scad.ts:1430-1432`) |
| `[1,2,3] * [1,1,1]` | `6` (dot product) | error: *cannot apply \* to a vector and a vector* |
| `[1,2] + [1,2,3]` | `[2, 4]` | `[2, 4, undef]` |
| `[1,2,3][1.7]` | `2` | `undef` (`scad.ts:1380`) |
| `"abc"[1]` | `"b"` | `undef` |
| `undef + 1`, `"a" + 1` | `undef` + WARNING | error line |

`[1,2,3][5]`, `[1,2,3][-1]`, `len([0:5])`, `len("abc")` all agree.

### H. `assert()` is refused, so we render a model OpenSCAD refuses to produce at all

```scad
assert(1 == 2, "boom");
cube(10);
```

OpenSCAD: `ERROR: Assertion '(1 == 2)' failed: "boom"` and **no output**.
Ours: the assert is named in the refusal list and the **cube is drawn**.

This is a correctly-named refusal, so it is not in the 🔴 section. It is worth its
own line because the consequence is inverted from every other refusal in the file:
a refusal normally makes the picture a *subset* of the model, and this one makes
the picture a *superset* — specifically, it is the source's own safety check being
switched off. `echo()` is refused the same way and costs nothing.

---

## The four modifier characters, measured

`* ! # %` were each probed alone and each as a subtrahend inside a `difference()`,
comparing final STL facet counts.

| Modifier | OpenSCAD | Ours | Verdict |
|---|---|---|---|
| `*` disable | subtree absent from the CSG entirely | subtree absent (`scad.ts:482-485`, `1071`) | ✅ **AGREES**, exactly |
| `%` background | kept in the tree marked `%`, **excluded from the render** — `difference(){cube(20); %…}` → **12 facets**, an uncut cube | subtree dropped, refusal named → **12 facets**, an uncut cube | ✅ **AGREES on geometry** |
| `#` highlight | **kept as real geometry** — `difference(){cube(20); #cylinder(…)}` → **80 facets**, the hole is cut | subtree dropped → **12 facets**, **the hole is missing** | 🔴 wrong part, but **named** at `scad.ts:487-495` |
| `!` show-only | the root becomes **only** that subtree — everything else vanishes | that subtree is dropped and **everything else is kept** — the exact inverse | 🔴 wrong part, but **named** |

Neither `#` nor `!` is a silent divergence: both produce
`modifier #: preview modifiers change what is shown, and this tab shows no
geometry` in the refusal list, and `CadTab.tsx:277` renders that list. They are
recorded here because the header's stated contract is that a refused construct
*"contributes NOTHING"*, and for `!` what it contributes is the removal of the
only thing OpenSCAD would have shown.

⚠ **One thing the `#` case exposes about the trust word.** Running `f4` through
`meshScene` returns:

```
s0@1 difference dim3 tris=12 verdict=closed
[warning] L1 difference(): this difference has only ONE operand in the scene tree…
trust=trusted
```

`trust` is computed in `mesh.ts:1518-1564` from `mesher.issues` only. Parser
refusals live in `parseScad`'s `unsupported[]` and are invisible to it, so **a
model whose only cut was refused by the parser still reports `trust=trusted`**.
The two lists are shown in different panels of the same tab, and the refusal count
is on screen (`CadTab.tsx:108-110`), so the information is present — but the
single-word verdict the UI puts on the picture is computed from half the evidence.
Same shape as `mesh.ts:1246-1262`'s own note, which says the parser's refusal list
"is the other half of this sentence".

---

## ✅ AGREES — checked by running both, not by reading ours

Stated with what was probed, because "no divergence found" is only a result if the
probe set is named.

**`rotate()` — all four forms, and the order.** `rotate([90,0,0]) translate([0,0,10]) cube([1,2,3])`,
`rotate([30,40,50]) cube([1,2,3])`, `rotate(45) cube([10,1,1])` compared as STL
vertex **bounding boxes** against our mesh bounds: `[0,−13,0]…[1,−10,2]`,
`[−0.9137,0,−0.6428]…[2.7149,2.5077,2.7563]`, `[−0.7071,0,0]…[7.0711,7.7782,1]` —
identical to float precision in all three. The `Rz·Ry·Rx` order at `mesh.ts:262-271`
is correct. `rotate(a=[0,0,90])` also agrees. The axis-angle forms
`rotate(a=90, v=[0,1,0])` and `rotate(90,[0,1,0])` are **refused by name**
(`scad.ts:1198-1206`) and the subtree is kept unrotated, exactly as
`scad.test-notes.md:66-68` documents.

**Default `$fn` from `$fa=12` / `$fs=2`.** `cylinder(h=10,r=5)` with nothing set:
OpenSCAD **60 STL facets** ⇒ 16 sides; ours **60 triangles** ⇒ 16 sides.
`fragments()` (`mesh.ts:340-346`) reproduces `get_fragments_from_r` for the default
case. `$fn = 0` correctly falls back to the defaults (`sphere(4,$fn=0)` under a
top-level `$fn=8` → 13 sides in both).

**`$fn` dynamic scoping.** `$fn=8; module ring(){cylinder(h=5,r=3);} ring(); ring($fn=32);`
→ OpenSCAD `$fn = 8` then `$fn = 32`; ours 28 and 124 triangles ⇒ 8 and 32 sides.
A module setting its own `$fn` internally overrides an outer one in both
(probe `n1` line 8 → `$fn = 4`).

**Tessellation geometry, vertex for vertex.** `cylinder(h=4,r=10,$fn=6)`: both
produce the same 12 vertices, same angular phase (first vertex at +X, not offset
by half a step). `sphere(r=10,$fn=8)`: both produce the same **32** vertices,
including the half-step latitude placement that gives small n-gon caps rather than
a pole vertex. The comment at `mesh.ts:365-367` claiming this matters and matches
is correct.

**`for` ranges — 7 forms.** `[0:3]` (4), `[10:-2:4]` (4, descending),
`[0:-1:5]` (empty), `[5:1:0]` (empty), `[0:0.3:1]` (4), `[1:0:3]` (empty),
`[0:2:5]` (3, endpoint excluded) — every count and every value matches, including
OpenSCAD's own warnings for the two contradictory-step cases. Multi-binding
`for (i=[0:1], j=[0:1])` iterates in the same order (i outer) in both. A range
held in a variable and iterated later works in both. The only range divergence is
item D above.

**Degenerate and empty geometry — 10 forms.** `cube(0)`, `cube(-5)`,
`cube([10,0,10])`, `cylinder(h=0,r=5)`, `cylinder(h=10,r=0)`, `sphere(0)`,
`union()` with no children, `intersection()` of two disjoint cubes, and
`difference(){cube(10); cube(10);}` all produce **no geometry** in both.
`difference(){cube(10);}` produces **12 facets** in both. Ours names each
degenerate primitive as a refusal (`mesh.ts:1132-1176`); OpenSCAD reports
`Current top level object is empty`. Same answer, ours more specific.

**Argument binding — the forms that do agree.** `m(10,20,30)`, `m(b=20)`,
`m(10,c=30)`, `m(c=30,10)`, `m(10,20,30,40)` (extra positional ignored by both;
OpenSCAD warns and we do not), `m(zz=5)` (unknown named parameter — OpenSCAD warns,
we refuse by name), `cube(10,true)`, `cube(10,true,99)`, `square([10,20],true)`,
`square(7)` — all identical trees. `translate(v=[1,2,3])`, `scale(v=[2,2,2])`,
`translate([1,2])` → `[1,2,0]`, `scale([2,3])` → `[2,3,1]` all agree.

**Diameter forms.** `cylinder(h=20,d=10)` → r 5/5; `cylinder(h=20,d1=10,d2=4)` →
r 5/2; `cylinder(h=20,r=10,r1=2)` → r1 2, r2 10 (OpenSCAD warns *"Cylinder
parameters ambiguous"* and resolves it the same way we do);
`cylinder(h=20,r=10,d=4)` → r 2/2 with `d` winning; `sphere(r=5,d=20)` → r 10;
`circle(r=5,d=20)` → r 10; `circle(d=8,$fn=6)` → r 4. **Every `d` form is read as
a diameter, none is read as a radius.** The failure the brief names as the one
that matters most — `d` read as `r`, a part at double size — **does not exist
here**, in any of the seven forms probed.

**`.x` / `.y` / `.z`.** OpenSCAD 2026.08.07 does support these;
`v=[3,4,5]; translate([v.x,v.y,v.z]) cube(1)` gives `[3,4,5]` in both.

**Math functions.** `floor(-1.5) ceil(-1.5) sign(-3) abs(-3) pow(2,10) atan2(1,1)
min([4,2,9]) max(1,7,3) norm([3,4]) concat([1,2],3,[4]) len("abc") 3%2 -3%2 3.5%2`
— all identical. Trig is in degrees in both. Only `round` diverges (item C).

**Categories with nothing found.** *Argument binding:* eleven forms probed, two
diverge (findings 6 and 7); nine agree. *Numeric coercion into coordinates:* every
divergence found produces a visible error line rather than a wrong coordinate,
except `round()`. *`center=` and the origin:* `cube`, `square`, `sphere`, `circle`
all agree in every form probed; only `cylinder`'s **positional** `center` is lost
(finding 3) — its named `center=true` is correct.

---

## What this means for the tab, in one paragraph

The refusal machinery is sound and the geometry that is implemented is
**bit-comparable to OpenSCAD** where it matters most — rotation order, sphere and
cylinder tessellation, default facet counts, range iteration, degenerate handling.
What leaks through is not the geometry, it is the **language**: assignment order,
one gap in each of positional binding and named binding, three coercions
(`translate` scalar, short/long `cube` vectors, `round` on negatives), and a
tessellation control (`$fa`/`$fs`) that is neither implemented nor refused while
two documents say it is refused. Every 🔴 in this file is a construct a reasonable
OpenSCAD file contains, none produces a diagnostic, and six of the seven make the
part **larger, taller, offset or straighter** than the source says.

---

# §I. ADDENDUM, 2026-08-11 — `color()`: the one this audit missed

**Added after the body above was frozen.** Everything from here down is a later
measurement and says so; nothing above it was edited, because a finding written
into a dated pass would be back-dated rather than recorded.

## I.1 What was true, and what it cost

**`color()` was ACCEPTED, contributed no diagnostic of any kind, and silently
discarded its argument.** `parseScad('color("red") cube(3);')` returned **0
errors, 0 unsupported, 0 warnings**, and `meshScene` returned `trust: 'trusted'`
over a mesh with no colour anywhere in it.

That is precisely the class this document was written to enumerate — *accepted,
and means something else* — and it is **not in the body above.** Two reasons, and
the second is the one worth keeping:

1. The pass was organised around constructs that change the **part**. Colour does
   not, so nothing in the method would have surfaced it.
2. 🔴 **`color()` had been made a pass-through EARLIER THE SAME DAY, as a fix.**
   Refusing it had been the expensive choice — a refused node takes its whole
   subtree with it, so `color("red") part();` did not lose the colour, it deleted
   the part, and `color()` alone accounted for **198 of 360 refusal sites across
   36 of the 68 `hardware/cad/` files**. Turning it into a pass-through was
   correct and it converted a **loud** wrong answer into a **silent** one. **An
   audit run before a change cannot see the class the change creates**, and
   nobody re-ran this one against it.

**The cost was not hypothetical.** The founder asked a model, through the tab's
own `Ask` panel, to *"change the objects to red"*. `ask.tsx`'s system instruction
listed `color` among constructs *"NOT implemented and refused by name"*. The
model obeyed and returned the file **completely unchanged — zero diff lines**.
A control run with `color` removed from that list returned a correct, idiomatic
edit on the first attempt. **The model was capable and obedient; every obstacle
was ours.**

⚠ **And the instruction was wrong about five constructs, not one.** Measured by
running each through `parseScad` on 2026-08-11:

| Named as refused | Actually |
|---|---|
| `color` | pass-through, and now implemented |
| `render` | pass-through |
| `#` | pass-through carrying **real geometry**, as in OpenSCAD's export |
| `!` | **implemented** — the subtree becomes the whole model |
| `*` | **implemented**, byte-exact with OpenSCAD |
| `%` | ✅ genuinely refused — the only correct one of the six |

**A ban costs a capability silently; a missing entry costs a refusal that is at
least reported.** The list is now `FORBIDDEN_CONSTRUCTS` in `ask.tsx` — data, not
prose — and `web/tests/cad-ask.test.ts` runs every entry through the real parser
in both directions.

## I.2 What was built, and against what

`color(c, alpha)` now resolves at evaluation, rides the scene tree on
`GroupNode.colour`, is inherited down `mesh.ts` onto each `MeshPart`, and is
painted by `preview.tsx`.

**Every rule was read at OpenSCAD 2026.08.07 in `/home/gbacs/apps/openscad`, not
guessed**, and every value was checked against `openscad -o out.csg`:

| Source | OpenSCAD prints | Ours | Note |
|---|---|---|---|
| `color("red")` | `color([1, 0, 0, 1])` | same | 148 CSS Color 4 names, transcribed whole from `src/core/WebColors.h` |
| `color("RED")` | same | same | names are case-insensitive |
| `color([1,0,0])` | `[1, 0, 0, 1]` | same | **a short vector pads with 1.0** — it STATES an alpha |
| `color([1,0])` | `[1, 0, 1, 1]` | same | so a 2-vector is **magenta**, not "red, two channels missing" |
| `color("#00ff0080")` | `[0, 1, 0, 0.501961]` | same | `#rgb` `#rgba` `#rrggbb` `#rrggbbaa` |
| `color(alpha=0.25)` | `[-1, -1, -1, 0.25]` | `rgb: null, alpha: 0.25` | alpha is applied **after and independently of** `c` |
| `color([2,-1,0])` | kept + 2 warnings | kept + the **same two warning strings** | not clamped in the parser |
| `color("notacolour")` | `WARNING: Unable to parse color "notacolour"` | same string | colour left unset, geometry untouched |
| `color("red") color("blue")` | **red** | **red** | see below |

🔴 **THE OUTERMOST `color()` WINS.** `CSGTreeEvaluator::visit(ColorNode)` is one
line — `if (!state.color().isValid()) state.setColor(node.color);` — so a nested
`color()` is **ignored**, which is the opposite of what CSS-shaped intuition
predicts. And `isValid()` means **all four channels**, so a partially-stated outer
colour (`color(alpha=0.5)`) is **replaced whole** by an inner one, alpha included,
rather than merged. Both are asserted in `web/tests/cad-colour.test.ts`.

## I.3 🔴 NAMED GAPS — what this does NOT do

Recorded here rather than left undocumented, because *an undocumented gap is the
defect being fixed in this addendum.*

| Gap | What happens | Why |
|---|---|---|
| **`xkcd:` colour names** | 🔴 **REFUSED BY NAME**, geometry unaffected | OpenSCAD also accepts ~950 XKCD names. Carrying them is ~30 kB of table in a bundle with no other data of that size. A refusal is reported; "silently no colour" would not be. |
| **Per-operand colour inside a boolean** | the **first operand's** colour is used, and a **WARNING** names the loss when the operands disagreed | The kernel destroys it, not the choice: `csgSubtract` returns one polygon soup with no memory of which operand a face came from. ⚠ OpenSCAD's *preview* does better (it keeps each CSG leaf and paints them separately); its *render* does worse (`applyToChildren3D` returns a fresh geometry with the default `Color4f`, so a multi-child boolean loses colour entirely). This file computes real CSG like the render and draws one picture like the preview, so **neither answer is inherited for free.** |
| **Alpha, at the low end** | floored at **0.12** | 🔴 **A DELIBERATE DIVERGENCE.** `color("red", 0) cube(3)` still exports 12 facets in OpenSCAD — the solid is entirely there — and OpenSCAD's preview draws it invisible. This tab reserves "you can see nothing here" for **REFUSED**, i.e. no geometry exists. Drawing a present part exactly as an absent one is the one confusion this lane cannot afford. |
| **Transparency sorting** | per **object**, back-to-front, not per triangle | three.js sorts transparent meshes as wholes, so a **concave** translucent part can show its own far faces in front of its near ones. Real artefact of drawing translucency this way; named so it is not read as a geometry fault. |
| **A part whose audit is not `closed`** | drawn in the **error colour**, `color()` **ignored**, and the override **printed on the overlay** | A failing audit is meant to be the loudest thing on screen; the source must not be able to switch it off. The override would otherwise be a silent disagreement between the picture and a line the operator wrote. |
| **STL export** | **carries no colour, and says so at export** | Binary STL is a triangle soup. The 16-bit per-face attribute some tools abuse for colour is a vendor extension no two readers agree on and our own reader ignores. `web/tests/cad-colour.test.ts` asserts a coloured and an uncoloured model produce **byte-identical** STL, so "says so" is true rather than defensive. ⚠ The notice is a **note, not an alarm**: `color()` is in 36 of the 68 hardware files, so a red banner would fire on nearly every export and stop being read. |

## I.4 What did not move

**Colour is appearance and nothing else**, asserted rather than claimed:
`web/tests/cad-colour.test.ts` compares a coloured and an uncoloured run of the
same source and requires **identical vertices, identical triangle counts,
identical audit verdicts and identical exported bytes.**

**The oracle, before and after** (`--hardware`, 2026-08-11): `SAME 66 · REFUSED 16
· DIVERGES 33 · ERROR 0 · PENDING 21` → `SAME 67 · REFUSED 16 · DIVERGES 33 ·
ERROR 0 · PENDING 21`. **No case changed verdict**; the single extra `SAME` is a
new corpus case (`corpus/xform_rotate_quadrant`) added by another lane during the
run. ⚠ **The `REFUSED` count deliberately did not move** — `color()` was already a
pass-through when the before-run was taken, so this change could not have
converted a refusal into anything, in either direction.

---

# §J. ADDENDUM, 2026-08-11 (later) — the modifier table is true only for a modifier written ALONE

**Appended after §I, which was itself appended after the frozen body.** Nothing
above this line was edited. §I's own opening sentence is the rule being followed:
*a finding written into a dated pass would be back-dated rather than recorded.*

## J.1 The caveat the table does not carry

Two places in this file report on the modifier characters, and **both are true and
both are incomplete in the same way**:

- **`## The four modifier characters, measured`** — *"`* ! # %` were each probed
  **alone** and each as a subtrahend inside a `difference()`."* The word *alone* is
  in the method sentence and the verdict column does not repeat it.
- **§I.1's instruction table** — the row *"`!` — **implemented** — the subtree
  becomes the whole model"*, and *"`*` — **implemented**, byte-exact with
  OpenSCAD"*.

🔴 **Every one of those verdicts holds for a modifier written on its own and fails
where two of them meet.** `d749b176c2` probed **54 sources** through
`openscad 2026.08.07` and through `parseScad` + `meshScene` and found the root
modifier wrong in **four interaction shapes**, each with **no error, no warning
and no refusal**:

| Source | OpenSCAD 2026.08.07 | We produced | Class |
|---|---|---|---|
| `!*cube(5); sphere(20,$fn=16);` | the **sphere**, 252 facets — `*` deletes the instantiation so the `!` has nothing to tag and the file has no root modifier at all | **nothing** | an empty viewport from a valid file |
| `!union(){ !cube(5); translate([20,0,0]) sphere(3,$fn=16); }` | **both** children, 231.0381 mm³ | the sphere alone at 106.0381 — **the cube vanished** | half the model, silently |
| `%union(){ !cube(5); } sphere(20,$fn=16);` | the **cube**, 125 mm³ | the **sphere**, 31418 mm³ | 🔴 **a different object** |
| `!%cube(5); sphere(20,$fn=16);` | the **cube**, 12 facets | **nothing** | as row 1 |

⚠ **The interaction rules are not derivable from the single-character ones, and
two of the three read the opposite way round from the obvious guess.** They were
taken from OpenSCAD's source, not inferred:

- `src/core/parser.y` — `'*' module_instantiation { delete $2; $$ = NULL; }` and
  `'!' module_instantiation { $$ = $2; if ($$) $$->tag_root = true; }`. **The
  `if ($$)` guard IS the whole `*`/`!` interaction rule.**
- `src/core/node.cc`, `find_root_tag` — walks the **instantiated** tree and
  **never consults an ancestor's tag**, which is why a `!` inside a `%` still
  governs the whole model.
- `src/geometry/GeometryEvaluator.cc` — `collectChildren3D`/`collectChildren2D`
  skip a background **child**; nothing anywhere checks the background flag on the
  **root node itself**. So `%` is honoured on a child and ignored on the root,
  from one rule.

⇒ **The correction to the table is one word and it belongs in the verdict column,
not the method sentence:** every ✅ and every "implemented" above is *for that
character written alone*. Current behaviour is asserted in
`web/tests/cad-modifier-interactions.test.ts` (13 interaction probes plus the 41
single-modifier ones, four plants watched red).

## J.2 🔴 The corpus was blind to exactly this class, and said so as a green

`tools/scad_oracle/corpus/edge_modifier_{disable,root,highlight,background}.scad`
were **one modifier and one statement each**, and **all four scored `SAME` before
AND after all four defects above.** The question *"does a corpus case exercise
this modifier?"* returned **yes** for all four characters and was worth nothing —
⚠ ***construct presence is not coverage; the axis was the combinations.*** This is
the second time in one week that the missing axis was inside a construct the
corpus already had (the first was `rotate()` at quadrant angles).

Five cases now close it, each watched go red under a defect planted in a
**throwaway md5-verified copy** of the file it guards — never the live tree:

| Case | Watched red under | Verdict |
|---|---|---|
| `edge_modifier_root_on_disabled` | the `*`-annihilates-`!` guard removed | `DIVERGES` |
| `edge_modifier_root_nested` | the nested/sibling distinction removed · **and** `!` refused by name | `DIVERGES` ×2 |
| `edge_modifier_root_in_background` | the `%` body discarded at parse time | `DIVERGES` |
| `edge_modifier_root_on_background` | the `*`-annihilation guard generalised to `%` | `DIVERGES` |
| `edge_modifier_background_operand` | the pre-fix `canon.mjs` (see J.4) | `DIVERGES` |

🔴 **One of the five cannot go red on the defect it was written for, and that is
recorded in its own header rather than smoothed.** Planting the *original*
`!%` defect into `edge_modifier_root_on_background` scores **`REFUSED`** — the
`%` names itself, the root sink stays empty, nothing is emitted, and `CAD1`
**treats a refusal as safe**. ⚠ **No control solid can fix it**: a working `!`
suppresses every sibling, so the convention from `6425ea855e` — *a case whose
construct gates emission carries an unconditional control solid* — is
**inapplicable to `!`, not merely omitted.** The available substitute is a control
of the opposite polarity (a sibling that is suppressed when the modifier works and
released when it breaks), and it catches one failure direction of two. The other
direction is watched by the unit tests, which assert geometry and have no refusal
verdict to hide behind.

✅ **The convention itself was proved rather than assumed**, on
`edge_modifier_root_nested`: the same plant, the same binary, run against the file
as shipped → **`DIVERGES` (NO-GO)**, and against a byte-copy with the control solid
deleted → **`REFUSED` (GO)**. One line of `.scad` is the difference between a gate
that goes red and a gate that does not.

## J.3 🔴 THE RESIDUAL, named because nothing else will name it

**A `!` buried inside a `%` subtree that the budget-capped search cannot reach is
not honoured, and nothing says so.** The fix keeps the `%` body and evaluates it
into a throwaway sink to find a `!` inside it — a syntactic scan is not enough,
because the `!` can be reachable only through a module call (`module m(){ !cube(5);
} %m();` exports the cube). That search runs under the node and iteration budgets,
and a `Halt` is swallowed, because a search that ran out of budget must not abort
the model. So a `!` deep enough to exhaust the budget first is silently not found:
**the file renders as though the `!` were not there.** It is a gap, not an
impossibility, and it is the one thing in this family that still has no
diagnostic.

⚠ **It is unreachable on anything we hold — and the figure previously given for
that is wrong.** `d749b176c2` said `hardware/cad/` has *"93 `%` sites and zero
`!`"*. **Re-measured with the real parser** (a counter in the `%` and `!` parse
branches of a throwaway copy, run over every file directly):

| Set | files | `%` background sites | `!` root sites |
|---|---:|---:|---:|
| the 68 files `--hardware` covers | 68 | **9**, in 6 files | **0** |
| all non-archive `hardware/cad/` | 246 | **33**, in 17 files | **0** |

**93 does not reproduce by any counting method available**: the 68 files hold 65
raw `%` characters, **56 of them inside comments**, leaving exactly the 9 the
parser sees; the 246 files hold 201 raw. ⚠ *A count taken with `grep` over a
language where `%` is also the modulo operator is a count of a character, not of a
construct* — and the count that was wrong is the denominator of the reassurance,
which is the half nobody re-checks. **The conclusion survives and is stronger:
zero root modifiers exist in any file this company cuts, so the residual cannot
produce a wrong part today.**

⚠ **What makes it live rather than theoretical: it becomes reachable the first
time anyone writes a `!` in a file that already has a `%`** — and 17 non-archive
files already have the `%`.

✅ **One residual from `d749b176c2` has since CLOSED and is struck here so it is
not swept again**: *"`ScadResult.warnings` IS RENDERED BY NOTHING"*. `console.tsx`
now renders `parse.warnings` and is mounted in `CadTab.tsx` as a pinned bottom
tab, so the *"More than one Root Modifier (!)"* warning this fix makes correct does
reach an operator. **A stale red lies exactly like a stale green.**

## J.4 Two defects in the INSTRUMENT, found while closing the above

Both would have scored a **correct** result as `DIVERGES`, and ⚠ **a false red is
the more expensive direction**: it sends someone to fix code that is right, and
the instrument's output *is* the evidence they would check against.

**1 — `canon.mjs` built a `%` node into `EMPTY` and left it in its parent's child
list.** `normalise`'s `diff` arm reads an empty first operand as *"nothing to cut
away from"*, so `difference(){ %cube(20); cylinder(h=40,r=5,center=true,$fn=16); }`
canonicalised to `<nothing>` on the **oracle's** side while the binary's own STL —
and ours — is the cylinder at **3061.4675 mm³**. OpenSCAD *removes* the child
(`collectChildren3D`'s opening `continue`), so the next operand is **promoted to
first** and `applyToChildren3D` returns it unchanged via its one-child early
return. ⚠ **Removed is not empty, and the boundary was probed:** a `%` wrapped in a
transform leaves a non-background node in the list, so
`difference(){ translate([0,0,0]) %cube(20); cylinder(…); }` genuinely **is**
empty — *"Current top level object is empty"* at 2026.08.07. A fix phrased as
*"drop empty children"* would have been wrong in the other direction.

**2 — `canon.mjs` printed our `$fa`/`$fs` from a hard-coded `OUR_FA = 12` /
`OUR_FS = 2`.** This is **§A of the frozen body, inverted**: §A recorded that
`$fa`/`$fs` were *"ignored in both forms"*, which was true of commit `78f5f1e63c`
and was fixed on 2026-08-11 — after which the only thing still tessellating at
12/2 was **the harness**. Two of `CAD1`'s four accepted divergences,
`partial_fa_fs_args` and `partial_fa_fs_global`, read `TREE differs / MESH same` on
that alone. Both are now `SAME`.

🔴 **The comment above the constant is the part worth carrying out of this.** It
read *"AND THAT IS NOT A CHEAT — `scad.ts` refuses `$fa`/`$fs` as primitive
arguments and never reads them as variables"*, and it went on vouching for the
constant after the premise died the same day. ⚠ ***A comment explaining why a
control is right is the least-audited thing in the repo.*** The same dead sentence
had been copied into both corpus headers, and into two `CAD1_KNOWN` `why` texts,
where it still points at `mesh.ts` for a defect that lived in `canon.mjs`.
⚠ And the `args` half was **never** true: the refusal it named sat below an
allowlist `continue` and was unreachable from anywhere in the file — the measured
run reports **`refusals 0`** on that case.

**Verified at record level before anything was removed**, because *"the solids
happen to agree"* was a phrase from a transcript rather than a measurement:
`sphere(r=10,$fa=5,$fs=0.5)` is **5180 triangles on BOTH sides** (12/2 would give
840), volume 4175.517851 vs 4175.517816 (rel 8.4e-9), area rel 5.6e-9, bounding box
±9.990482 both sides — the 72-fragment inradius, not the 30-fragment 9.945.

## J.5 What did not move

**`hardware/cad/` is unmoved and it was checked case by case, not by the summary
line.** All 68 files: `29 DIVERGES · 21 PENDING · 2 REFUSED · 16 SAME`, the
tracked baseline exactly. Every one of the 142 pre-existing case records in the
`--json` output is **byte-identical** before and after both harness fixes and all
five new cases; the only two records that differ are
`corpus/partial_fa_fs_{args,global}`, which is the intended change. ⚠ That
comparison also spans `b739cbc53b` (`mesh.ts`: `ceil` not `floor`, `GRID_FINE` not
`1e-6`), so it independently confirms that commit's own claim of an unmoved oracle
rather than taking it.

**Corpus, 76 → 81 cases:** `SAME 58 → 65 · REFUSED 14 → 14 · DIVERGES 4 → 2 ·
ERROR 0 · PENDING 0`. **No `REFUSED` became a `DIVERGES` and no case became
`PENDING`.** All three harness plants remain SENSITIVE and SPECIFIC at the new
size (`mesh-scale` 60/21, `tree-fa` 22/59, `drop-child` 10/71).

🔴 **`CAD1_KNOWN` now holds two stale exemptions** — `corpus/partial_fa_fs_args`
and `corpus/partial_fa_fs_global` — and `CAD1`'s RATCHET limb exists to fail on
exactly that. `gates/` is outside this pass's boundary, so they are **reported and
not edited**; the same report names the two `why` texts that point at the wrong
file. ⚠ *A stale exemption **reason** is the same defect class as a stale
exemption*, and it is the half that survives a routine baseline tidy.
