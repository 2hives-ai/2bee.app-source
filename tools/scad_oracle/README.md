# `scad_oracle` — how far `2bee.cad` is from OpenSCAD, as a number

The founder's target for the `2bee.cad` tab is *"the same functionalities as OpenSCAD"*. Until now
that was an aspiration nobody could check. **OpenSCAD 2026.08.07 is installed on this box**, so it
does not have to stay one: the real implementation is the oracle, and the difference is measurable.

This harness runs the real binary and our own `web/src/cad/scad.ts` + `web/src/cad/mesh.ts` over the
same source, twice — once for the **evaluated program**, once for the **solid** — and reports a
verdict per file.

---

## Run it

```bash
node --experimental-transform-types --disable-warning=ExperimentalWarning \
  tools/scad_oracle/oracle.mjs
```

| Flag | Effect |
|---|---|
| `--hardware` | also run `hardware/cad/` — 68 real files, **read only** |
| `--plant <name>` | negative control; runs the suite twice and prints what the plant moved |
| `--list-plants` | what each plant corrupts and which leg of the comparison it proves |
| `--only <substring>` | filter cases by name |
| `--json <path>` | every number from every check, machine-readable |
| `--timeout <ms>` | per-`openscad`-invocation wall clock (default 120000) |
| `OPENSCAD_BIN=…` | env; point at a different binary |

**The two Node flags are not decoration.** `ours.mjs` and `canon.mjs` import `web/src/cad/*.ts`
**directly and unmodified**, so the harness exercises the file the browser actually loads rather than
a copy that could drift. Node's default strip-only TypeScript mode rejects `scad.ts`'s constructor
parameter properties (`constructor(private toks: Token[])`); full transform mode accepts them. Run
without the flag and the harness **exits 2 and says exactly that** — it does not fall back to
anything, because a fallback would be a harness testing itself. (There is no vitest in
`web/package.json`, and nothing here adds a dependency or touches the lockfile.)

> 🔴 **`canon.mjs`'s import was added 2026-08-11 and it is the one this README has to justify**, because
> a harness importing the product is normally the thing to be suspicious of. `canon.mjs` used to build
> our side's rotation matrix itself, from `Math.cos(deg * π/180)` — a faithful second copy of what
> `mesh.ts` did. When `mesh.ts` was fixed to OpenSCAD's degree trig, the copy did not move with it, so
> the harness kept printing `6.12323e-17` where the product computes an exact `0` and attributed it to
> our evaluator. **The rows were not merely wrong, they were unfalsifiable**: no change to the product
> could move them, so a real fix left the oracle number byte-identical, which is indistinguishable from
> a fix that did nothing.
>
> ⚠ **Consuming the product's implementation is not the same as teaching the harness to agree.** The
> comparison is untouched — still our tree against the tree the real binary emitted, at the oracle's own
> six significant figures, with no tolerance added anywhere. Only OUR side of it is now actually ours.
> **Consume, never port**: a second copy is what produced the defect, and a re-port would rebuild it
> under a new name. The full argument, including the corner where the two sides now format a NaN
> differently, is in the comment above `rotateM`.
>
> ⚠ **2026-08-14 — "no tolerance added anywhere" stopped being true of the tree leg.** The .csg's
> matrices are pre-rounded to six significant figures and `normalise` *composes* them, while our side
> composes full doubles — a 1e-6 rounding straddle (`fan_40mm`, `vent_fan`) read as "trees differ"
> under exact-string compare. The tree comparison is now numeric at rel 1e-5 (`canon.mjs`
> `serialiseEq`), with the non-numeric structure still compared byte for byte; what that cannot
> absorb (a `$fn` disagreement, a structural difference, the `6.12323e-17`-vs-`0` quadrant epsilon)
> is listed in `canon.mjs`'s header. The mesh leg's tolerance is untouched.
>
> ⚠ **And the corpus could not have caught it.** It rotated by `[15,25,35]` and `[0,0,30]` and by
> nothing else, so no quadrant multiple ever reached `rotateM` and CAD1 stayed green through the entire
> defect. The epsilon was only ever **visible** in the `--hardware` output, and even there **no gate
> failed on it** — CAD1H is a tracked count against a baseline, and those rows were inside the count.
> An agent reading the report found it; nothing mechanical did.
> `corpus/xform_rotate_quadrant.scad` closes that,
> and it was watched go red under both the naive matrix **and** the snapping "fix" #97 refused.

> ⚠ **A sibling mechanism landed in this tree while this was being written** — `web/tests/` with a
> `node --test` runner and a `register.mjs` resolve hook (`npm run test:node`), solving the same
> "run our `.ts` under Node" problem a different way. Two mechanisms for one problem is a thing to
> converge, not to leave; the lane session should pick one. This harness stayed on the flag because
> it must run from the repo root against `tools/`, not from `web/`, and because a resolve hook owned
> by another lane's test dir is a dependency this measurement should not acquire.

---

## The two comparisons, and why neither substitutes for the other

### TREE — does our evaluator understand the same *program*?

`openscad -o out.csg in.scad` emits the **evaluated CSG tree**: what the language means after
variables, modules, `for`, `if` and `$fn` have all been resolved. Both sides are then reduced to a
canonical form and compared as text.

The canonical form is **OpenSCAD's own vocabulary**, not ours — `multmatrix` for every transform,
`$fn`/`$fa`/`$fs` spelled out on every curved primitive. Reducing to *our* vocabulary would have
tested whether OpenSCAD can be expressed in our subset, which is a question we already know the
answer to.

Three normalisations are applied to both sides, and each is a theorem about the CSG algebra rather
than a convenience:

1. an affine transform distributes over union / difference / intersection, so every transform is
   pushed down to the leaves — this is what lets our `translate()` node and OpenSCAD's
   `multmatrix()` compare at all;
2. union and intersection are associative and commutative, so nested containers flatten and children
   sort — this is what lets our single `for` group compare with OpenSCAD's group-per-iteration;
3. `difference(a,b,c) == difference(a, union(b,c))`, so every difference is binary.

**Deliberately NOT done:** no distribution of intersection over union, no de-duplication of identical
children, no dropping of a subtrahend that cannot reach the minuend. Each would make more programs
compare equal, and each would do it by *reasoning about geometry* — which is the thing under test.

Numbers are compared at **six significant figures, because that is all the oracle emits.** OpenSCAD's
CSG writer is `%g` at default precision; measured against the binary, `1234.56789` comes back as
`1234.57`, `1/3` as `0.333333`, `cos(30)` as `0.866025`. Comparing more finely than the oracle can
speak is not a stricter test, it is a test of a printf format.

⚠ **2026-08-14 — and exact-string is not how they are compared any more.** Six figures is what the
oracle *prints*, but `normalise` then composes parent·child matrices from those pre-rounded values
while our side composes full doubles, so a legitimate tree can straddle a `%g` boundary
(`7.0822` vs `7.08221`, measured on `fan_40mm`). The serialised trees are now compared **numerically
at rel 1e-5** (`serialiseEq` in `canon.mjs`), with everything that is not a number still compared
byte for byte. The bound behind 1e-5: the composition carries a few times the %g rounding (5e-7
relative per value); a real difference — `corpus/fn_clamped`'s 400 vs 256, or the
`6.12323e-17`-vs-exact-`0` quadrant regression — sits orders of magnitude outside it.

### MESH — does our kernel produce the same *solid*?

`openscad --export-format asciistl -o out.stl in.scad`. **STL bytes are never compared** — vertex
order, triangulation and float formatting all differ legitimately, and on the standard example
OpenSCAD emits 144 triangles where we emit 272 for the same solid. Triangle count is *reported* and
decides nothing.

What is compared: **volume**, **surface area**, **axis-aligned bounding box** (6 numbers) and the
**volume-weighted centroid** (3 numbers).

> The format is passed explicitly because `openscad --help` warns the default STL flavour is planned
> to change; relying on it is a defect with a release date on it. It is **ascii**, not `binstl`,
> because binary STL is float32 and round-tripping the *oracle* through float32 would put ~2e-7 of
> volume error on the side we are treating as ground truth — within 5× of the tolerance. ASCII
> carries full double precision (`-3.325878449210181`), so the only float32 in the system is on our
> side, where it belongs: `MeshPart.positions` really is a `Float32Array`.

Both legs run on every case. A tree divergence is reported even when the solids agree, and the
harness says so in the row — `partial_rotate_axis_angle` below is exactly that case, and it is the
argument for doing both.

---

## Where the tolerance came from

`REL_TOL = 1e-5`, one constant, in `invariants.mjs` with the full derivation. Summary:

**What does *not* set it — tessellation.** The textbook term ("a curve can never match exactly") is
**common mode here and cancels**: `mesh.ts`'s `fragments()` is a port of OpenSCAD's own
`get_fragments_from_r`, with the same `$fa=12`/`$fs=2` defaults, the same meridian count and the same
half-step ring latitudes on a sphere. Both sides tessellate the *same polygon*, not two
approximations of the same circle. For scale, if the two ever disagreed on `$fn` the error would be
enormous by comparison — an inscribed n-gon understates a circle's area by `1 − (n/2π)·sin(2π/n)`,
which is `6.4e-3` at n=32. That is a useful signature, and the harness prints it next to a failing
volume so a `$fn` disagreement is not mistaken for float noise.

**What does set it — float32, and it is measured rather than bounded.** Rather than bound the
float32 term analytically with a worst case that is never approached, the harness takes **the
oracle's own double-precision mesh, rounds it through float32, and recomputes**. That difference is
the instrument's resolution for that case, measured on the oracle's own data.

Measured across the corpus:

| Quantity | Value |
|---|---|
| float32 quantisation floor, worst case (`xform_nested`) | **9.04e-8** |
| largest residual on any case that AGREES | **9.04e-8** |
| smallest genuine divergence found (`fn_clamped`) | **5.93e-5** |
| a 0.01 mm dimensional error on a 20 mm feature | 1.5e-3 |
| one triangle dropped from a cube face | 1.25e-1 |
| the `mesh-scale` plant | 3.0e-2 |

**🔴 The claim that the placement is not load-bearing was checked, not asserted.** Replaying every
recorded measurement at `1e-6`, `3e-6`, `1e-5` and `3e-5` gives **identical verdicts on every case** —
a 30× band with the constant inside it. At `1e-4` it stops being identical: the `fn_clamped` finding
is absorbed and disappears. That is why the number is not at `1e-4`, and it is a measured reason.

**🔴 A case that the tolerance cannot decide is reported, never absorbed.** If a case's *measured*
float32 floor reaches `REL_TOL`, that case is **PENDING with the number printed** — the constant is
not widened to accommodate it. (No case in this corpus hits that path; it exists so that the first
one that does is visible.)

---

## Verdicts

| Verdict | Means |
|---|---|
| **`SAME`** | tree and solid both agree within tolerance |
| **`REFUSED-BOTH`** | ≥1 construct was **named**, **nothing was emitted**, **and OpenSCAD produces nothing here either.** The refusal costs nothing but the reason. Counts refusals from *either* stage: `scad.ts` names what it cannot parse, `mesh.ts` names what it cannot mesh (a determinant ≤ 0 transform, a 2D operand in a boolean, a budget overrun). |
| **`STRICTER`** | 🔴 we named a construct and emitted nothing **and OpenSCAD produces geometry** — a solid it exports (`openscad=solid`) or a 2D outline it draws (`openscad=outline`). A capability we do not have. **Every one is a named, dated `STRICTER_LEDGER` entry in `oracle.mjs`; unlisted is a NO-GO.** |
| **`DIVERGES`** | 🔴 we produced geometry and it does not match. The serious one. |
| **`ERROR`** | our evaluator reported errors, or our code threw |
| **`PENDING`** | could not be decided — binary missing, timeout, unreadable source, unparseable CSG, a comparison the precision cannot settle, a refusal whose cost could not be measured because the oracle could not be asked, **or a solid OUR OWN KERNEL audits as `open` / `seams` / `non-manifold`: volume and area have no referent on a surface that is not closed, so the invariant comparison is undecidable rather than disagreeing** |

Classification order (each rule is tried in turn):

1. our code threw → `ERROR`
2. both sides evaluate to nothing → `SAME`, tagged `empty` and **counted separately in the summary**,
   so a run of module-only library files cannot read as agreement
3. refusals ≥ 1 **and** we emitted nothing → **ask the oracle**, then `REFUSED-BOTH` / `STRICTER` /
   `PENDING` (a refusal explains any cascading errors)
4. our evaluator reported errors → `ERROR`
5. otherwise compare both legs

> 🔴 **STEP 3 USED TO END AT `REFUSED`, AND THAT IS THE DEFECT THIS SPLIT REPLACES.** The verdict was
> awarded *as soon as* we named a construct and emitted nothing — **before either leg was compared** —
> so the oracle's own answer was never consulted for a refusal, and "we refuse and OpenSCAD refuses
> too" was reported with the same word as "we refuse and OpenSCAD hands the user a part". Measured
> at `d1d953317c`: an agent planted the real behaviour change (drop the 2D operand of a boolean, "to
> match OpenSCAD") and ran the full hardware leg over 103 files — **the output was byte-identical
> except one informational note.** No corpus case could have fixed that; the verdict algebra was
> what was blind, because a case that emits nothing never reached a comparison.
>
> 🔴 **What the split found on its first run: of the SIXTEEN refusals scored as safe on 2026-08-11,
> SIXTEEN are capability gaps and ZERO are agreement.** The only `REFUSED-BOTH` in the whole suite is
> a case written for this pass. That number is the answer to "what does refusing cost", and the
> harness had been unable to ask it.
> *(Standing at 18 `STRICTER` / 2 `REFUSED-BOTH` on 2026-08-12 — the second `REFUSED-BOTH` is
> `bool_2d_first_operand_intersection`, also written rather than found. **Both agreements in this
> suite are cases somebody wrote on purpose; not one turned up in the corpus by itself.**)*

The consult is three-valued, and the binary says which one **in words** (measured, 2026.08.07):

| What `openscad --export-format asciistl` does | Verdict |
|---|---|
| exit 0, facets > 0 | `STRICTER` (`openscad=solid`) |
| exit 1, *"Current top level object is not a 3D object."* | `STRICTER` (`openscad=outline`) — 2D geometry, drawn there, not drawn here |
| exit 1, *"Current top level object is empty."* | `REFUSED-BOTH` |
| absent binary, timeout, truncated export | `PENDING` — a check that cannot run is not a check that passed |

⚠ **`empty` and `not a 3D object` used to be one bucket in `openscad.mjs` and they are three
different facts.** The old `notSolid` regex matched only the second while its own doc comment claimed
it covered "2D (or empty)", so an empty top-level object fell through to the generic arm and was
scored as *an oracle that could not be asked*. Collapsing them loses the only evidence that separates
the safe refusal from the expensive one.

> ⚠ **A partial refusal is deliberately NOT `REFUSED`.** If we name a construct and still emit
> geometry, the case is compared like any other and will normally come out `DIVERGES` — with the
> refusal printed in the row. That is the honest scoring: a refusal that keeps geometry is not a
> refusal, and three of the eight divergences below are exactly that shape.

🔴 **`PENDING` is not a pass.** A run containing one reports **`INCOMPLETE`**, never `GO`.

**Exit codes**, matching `SLICER-GATES.md`: `0` GO · `1` NO-GO (a `DIVERGES`, an `ERROR`, **or a
`STRICTER` row that is not on the ledger**) · `3` INCOMPLETE (a `PENDING`) · `2` the harness could not
start. The gap verdict is `INCOMPLETE`, not `GO-WITH-GAPS`, so `grep 'VERDICT: GO'` cannot match it.

### The `STRICTER` ledger

Same shape as `CAD1_KNOWN` in `gates/slicer_gate_check.mjs`: `{ since, openscad, why }` per case name,
validated at start-up (a malformed entry is **exit 2**, not a failed verdict — a run scoring against
something nobody wrote a sentence about should not produce a verdict at all). Four limbs, each
watched go red:

| Limb | Corpus | `hardware/cad/` |
|---|---|---|
| a `STRICTER` row that is **unlisted** | 🔴 NO-GO | 🔴 NO-GO — it is new exposure either way |
| an entry whose `openscad` **kind is wrong** (`solid` ↔ `outline`) | 🔴 NO-GO | 🔴 NO-GO |
| an entry that is **no longer `STRICTER`** (stale) | 🔴 NO-GO — a ledger that keeps headroom it has stopped needing is the slack that absorbs the next gap | ⚠ warning only |
| an entry naming a case that **did not run** | 🔴 NO-GO | ⚠ warning only |

⚠ **The asymmetry is not laziness and it is not free.** `hardware/cad/` is the `cad` lane's tree,
where a file may legitimately be renamed or deleted, and failing on that trains exactly the
"just edit the list" habit the ledger exists to prevent. The hole it leaves is stated rather than
hidden: **a hardware file that stops being `STRICTER` because it stopped being *read* is invisible
here.** Only the `CAD1H` count in `gates/` would notice.

⚠ **The stale limb cannot run under `--only`**, because a filtered run has not seen the cases it
would score. It says so on the line rather than reporting "nothing stale" for a check it never
performed. The *unlisted* limb still runs under a filter — an unnamed gap is real exposure however
few cases were selected.

🔴 **AND A `PENDING` CASE IS NOT EVIDENCE THAT A GAP CLOSED — found by a negative test on the first
cut of this limb, not by review.** With `OPENSCAD_BIN` pointed at nothing, `corpus/refuse_hull` went
`PENDING` and the ledger demanded its entry **be removed**: *a false red instructing someone to
delete a true record because the instrument was absent.* Every ledger entry whose case is undecided
this run is now reported as undecided, by name, and scores nothing. **This file's own catalogue of
defects arrived inside the control written to close one** — which is the argument for running the
negative controls on a new control, not only on the thing it guards.

🔴 **A ledger entry is not permission to keep the gap.** `refuse_hull` being listed does not mean
`hull` is out of scope; it means the cost of refusing it is *measured* — OpenSCAD hands the user 100
facets, we hand them nothing — and recorded, so the next reader argues with a fact instead of
discovering one.

PENDING paths were exercised, not assumed:

```
$ OPENSCAD_BIN=/nonexistent/openscad … --only prim_cube
corpus/prim_cube  PENDING  -  -  openscad binary not found at /nonexistent/openscad
VERDICT: INCOMPLETE                                                  (exit 3)

$ … --only bool_difference --timeout 1
corpus/bool_difference  PENDING  -  -  openscad timed out after 1 ms
VERDICT: INCOMPLETE                                                  (exit 3)

$ node tools/scad_oracle/oracle.mjs          # no flag
🔴 scad_oracle could not load our own pipeline, so NOTHING was measured.
                                                                     (exit 2)
```

---

## The negative controls

🔴 *A comparison nobody has watched go red is not evidence of agreement; it is evidence of nothing.*
**Seven** plants, **each aimed at one leg**, so the legs are proved independently — a single plant
that reddened all of them would leave it unknown whether any works alone. Each plant corrupts **our
side only**, after the real code has run.

| `--plant` | What it does | Leg |
|---|---|---|
| `mesh-scale` | scale our triangles by 1.01 (3.0e-2 of volume, three orders past `REL_TOL`) | MESH only — the tree is untouched |
| `tree-fa` | our canonical leaves claim `$fa=11` instead of the 12 `mesh.ts` assumes | TREE only — no vertex moves |
| `drop-child` | drop the last child of the first boolean — the un-subtracted pocket | BOTH — boolean cases only |
| `drop-2d-operand` | drop every 2D operand out of a boolean **before meshing only**, so we stop refusing and hand back the 3D operand — the "match OpenSCAD" change | REFUSAL leg — `bool_2d_*` cases only |
| `drop-face` | delete one triangle, after the kernel and before the audit | **AUDIT leg** — must land `PENDING`, never `DIVERGES` |
| `duplicate-face` | duplicate one triangle — three faces on one edge | **AUDIT leg** |
| `flip-face` | reverse one triangle's winding — two faces traversing an edge the same way | **AUDIT leg** |

🔴 **The last three are NOT this harness's plants: they are `mesh.ts`'s own `MESH_PLANTS`, exported by
the product for exactly this purpose and passed by nothing until 2026-08-12.** `meshScene(scene,
plant)` has always taken the second argument and `ours.mjs` has always called it with one. They are
imported rather than re-declared, and `ours.mjs` **throws at import** if `mesh.ts` exports a plant
this table does not drive — a second copy of a list is how every other drift in this harness started.

⚠ **They are the only plants whose target is `PENDING`, and that is the assertion rather than a
weakening of it.** An unclosed mesh does not *disagree* with the oracle; it makes volume and area
undefined, so the comparison is undecidable and this lane's rule is that a check which cannot run
reports PENDING. It is also a verdict **no other plant can produce**, so a `SAME → PENDING` movement
cannot be confused with any other control.

🔴 **`drop-2d-operand` corrupts the MESH INPUT AND NOT THE CANON, and that asymmetry is the whole
control.** A change made in `mesh.ts` cannot move the tree leg — `scad.ts` still parses the same
program — so a plant that corrupted both would move the tree, land as `DIVERGES` for the wrong
reason, and prove nothing about whether the refusal leg can see anything. The five `bool_2d_*` cases
read `tree same` precisely because the refusal is a **kernel** refusal; that is the property under
test.

⚠ **Each plant now declares where its cases may land (`PLANT_TARGETS` in `ours.mjs`), and a plant
with no declaration is fatal.** The old check hard-coded *"moved → `DIVERGES`, or the plant is
broken"*. True of the three geometry plants, which corrupt a solid we were already emitting. **Not
true of `drop-2d-operand`**, whose point is that "match OpenSCAD" is *right* for `union`/`difference`
and *catastrophic* for `intersection` — it moves cases to `SAME` **and** to `DIVERGES`, and a check
that called the `SAME` half a broken control would have hidden the measurement. `mustHit` is what
stops a plant declaring its way out of firing.

**Measured, 87-case corpus, 2026-08-12 (audit-leg pass), each run exits 1. Every one prints
`✅ SENSITIVE … and SPECIFIC`:**

| Plant | fired (moved) | reached `mustHit` | unchanged | outside targets |
|---|---|---|---|---|
| `mesh-scale` | 60 | 60 `DIVERGES` | 27 | 0 |
| `tree-fa` | 22 | 22 `DIVERGES` | 65 | 0 |
| `drop-child` | 13 | 13 `DIVERGES` | 74 | 0 |
| `drop-2d-operand` | **6** | **3** `DIVERGES` | 81 | 0 |
| `drop-face` | **61** | **61 `PENDING`** | 26 | 0 |
| `duplicate-face` | **61** | **61 `PENDING`** | 26 | 0 |
| `flip-face` | **61** | **61 `PENDING`** | 26 | 0 |

The four older plants are unmoved by this pass except where the 87th case reaches them:
`drop-2d-operand` gains `bool_2d_first_operand_intersection` (`REFUSED-BOTH → DIVERGES`), and the
others gain one `unchanged`.

⚠ **The 26 unchanged rows are the specificity half, and the composition is the argument** — counted
from the run, not estimated: **18 `STRICTER` + 2 `REFUSED-BOTH`** (refusals, nothing emitted),
**3 empty-on-both-sides** library files, **2 flats-only** cases (`prim_circle`, `prim_square`) and
**1 `DIVERGES`**. **25 of the 26 have no solid to corrupt and each says so per row**
(`plant drop-face had nothing to corrupt here`) rather than looking like a plant that failed to fire.
🔴 **The 26th is the one to read: `partial_rotate_axis_angle` DOES have a solid, the plant DID corrupt
it, and the verdict did not move** — because its tree differs and `decide()` settles a tree divergence
before the mesh leg is consulted. A plant that fired and changed nothing, correctly.

🔴 **And one movement is a loss, named rather than counted as a win: `fn_clamped` goes
`DIVERGES → PENDING`.** The corpus's smallest genuine divergence (5.93e-5) becomes undecidable once
its own mesh is corrupted. That is inherent to any plant that corrupts our geometry, and `mesh-scale`
hides the same finding more quietly: it leaves the verdict at `DIVERGES` while replacing the row's
reason — *"worst is volume, rel 5.93e-5"* becomes *"worst is bbox.max.z, abs 1.00e-1"* — so the case
looks untouched in the verdict column and the real measurement is gone from the line. ⇒ **the baseline
run is the one that scores**, and a planted run is evidence about the instrument only.

`drop-child` moved 10 → 13: the three new `bool_2d_operand_*` cases each hold a boolean with two
children. `drop-2d-operand`'s five are the whole `bool_2d_*` family — three to `SAME` (the edit
really does match the binary for `union`/`difference`, and for the all-2D case both sides end up
with no solid) and **two to `DIVERGES`: `bool_2d_operand_intersection` and `bool_2d_first_operand`,
where the edit invents a solid OpenSCAD does not export.**

🔴 **The A/B that proves the split is doing the work — same corpus, same plant, old verdict algebra
against new** (the old `oracle.mjs` restored from `d1d953317c` into a throwaway copy, since deleted):

```
OLD   bool_2d_operand_intersection  REFUSED -> PENDING    "oracle mesh unavailable"
NEW   bool_2d_operand_intersection  REFUSED-BOTH -> DIVERGES
        "OpenSCAD produces NO GEOMETRY AT ALL here and we produced a solid
         — the dangerous direction: a part that exists only in our pipeline"
```

and on the **unplanted** run, where the difference is starker still: the old algebra reported all
five as one word, `REFUSED`, with nothing to distinguish the four gaps from the one genuine
agreement.

**Superseded by the 87-case table above; kept because a dated record is evidence
of what was measured. Measured, 81-case corpus, 2026-08-11 (second pass), each
run exits 1** (the 63-case figures were `35 / 16 / 8`, the 68-case ones
`45 / 16 / 9`, and the 76-case ones `53 / 17 / 9`; the corpus gained five
`passthrough_*` cases, then seven from the blind-spot pass, then the five
`edge_modifier_*` interaction cases below, then the five `bool_2d_*` cases of the
refusal-split pass):

| Plant | fired → `DIVERGES` | unchanged | moved anywhere else |
|---|---|---|---|
| `mesh-scale` | **60** | 21 | 0 |
| `tree-fa` | **22** | 59 | 0 |
| `drop-child` | **10** | 71 | 0 |

⚠ **`tree-fa` moved 17 → 22 and only THREE of the five are new cases.** The other
two are `partial_fa_fs_args` and `partial_fa_fs_global`, which were permanently
`DIVERGES` until the `OUR_FA` fix and so had nothing left for a plant to move —
**a case pinned red by an instrument defect is a case with no negative control**,
and that was invisible in the old table as an unremarkable 17. Of the five new
cases, `edge_modifier_root_{on_disabled,nested}` and
`edge_modifier_background_operand` carry a curved primitive and move; the other
two are cube-only and are structurally invisible to this plant, as
`xform_scalar_forms` and its five siblings are. `drop-child` moved 9 → 10, the
extra being `edge_modifier_root_nested`'s union.

⚠ **Only ONE of the seven blind-spot cases moved `tree-fa`, and that is the
number to read.** `prim_cylinder_positional` is the only one carrying a curved
primitive; a cube has no `$fa`, so the other six are structurally invisible to
that plant. They are proved instead by the per-case plants listed in their own
headers — `tree-fa` is a control on the harness's leaf vocabulary, not on the
corpus.

`drop-child`'s extra case is `corpus/passthrough_color_difference` — which matters
more than the count: the new `color()`-as-a-difference-operand case is the one that
would silently pass if the pass-through ever swallowed a subtrahend, and it has a
negative control that says so.

**The opposite direction was checked too, and it is the half that gets skipped.** None of the four
reddens everything: `mesh-scale` leaves every refusal and both 2D cases alone; `tree-fa` leaves every
straight-edged case alone (a cube has no `$fa`); `drop-child` leaves the cases with no boolean alone
and *says so per row* (`plant drop-child had nothing to corrupt here`) rather than looking like a
plant that failed to fire; `drop-2d-operand` touches only the five cases that put a 2D shape inside a
boolean and leaves the other 81 exactly where they were. The harness asserts both directions itself
and prints

```
✅ the plant is SENSITIVE (it fired) and SPECIFIC (it did not redden everything)
```

only when `reached-mustHit > 0 && unchanged > 0 && outside-declared-targets == 0`.

`tree-fa` is the cleanest single-leg demonstration — the row reads `TREE differs / MESH same`:

```
corpus/prim_cylinder  SAME->DIVERGES  differs  same   the trees differ (the solids happen to agree)
   · tree line 1: openscad "I cylinder(h=20,r1=6,r2=6,center=false,$fn=32,$fa=12,$fs=2)"
   ·              ours     "I cylinder(h=20,r1=6,r2=6,center=false,$fn=32,$fa=11,$fs=2)"
```

---

## 🔴 Two defects in THIS HARNESS, found 2026-08-11 — read before the figures below

⚠ **Two MORE were found the same day and are in the next section, and a FIFTH in
the section after that; there are five.** This heading is left at "two" and
pointed forward rather than renumbered, because a count in a heading is the thing
that goes stale silently.

The results section that follows is dated **2026-08-10** and was taken with both of
these live. It is kept as written; the current figures are in `SLICER-GATES.md`
under *"RE-TAKEN AFTER CAD STAGE 0 AND AFTER A HARNESS FIX"*.

**1 — `color()` and `render()` were mapped to OPAQUE nodes.** `buildCsg` sent
anything it did not recognise to `other`, and OpenSCAD writes both of these into
the `.csg`. So a model wrapped in `color("black")` diverged **on the tree leg by
construction** the moment our side implemented the pass-through correctly: **46 of
51 hardware divergences had their first tree difference at an `OPAQUE color(...)`
node.** The harness was reporting its own vocabulary as a defect in the thing it
measures. Fixed by asking **the binary**, not either implementation — `color("red")
cube(3);` / `cube(3);` export byte-identical ASCII STL, likewise a `color()`-wrapped
difference minuend, likewise `alpha = 0`; with several children it is a group; empty
it emits nothing. `render()` is byte-identical too. Both now map to a union, and
six `passthrough_*` corpus cases pin every one of those properties.

**2 — a TRUNCATED export could be read as ground truth, and was.** The only
integrity check was `vertices % 9`, and its comment claimed it stopped a short
write being "silently rounded down to a shorter valid mesh". **It did not.** An
ASCII STL facet is exactly three `vertex` lines, so a file cut at *any facet
boundary* still passes — only a cut landing mid-facet was caught. On this box
(`/tmp` is a 62 GB tmpfs at **89%**, another lane's `openscad` running
concurrently) a full `--hardware` run returned a **partial** mesh for
`sphere(r=8)`: oracle `bbox.min.z = +5.30` against our correct `-7.94`, with
`openscad` exiting **0**. Gate `CAD1` then went red naming three innocent cases
(`bool_union`, `bool_nested`, `prim_sphere_default_fn`), each of which is clean and
byte-stable when re-run in isolation.

> ⚠ **This is the failure a differential harness must not have**, and it is worth
> more than the fix: the instrument manufactured a red *about the product* out of a
> defect *in itself*, and nothing downstream could tell the difference, because the
> instrument's output **is** the evidence. It failed loud in this instance only by
> luck of direction — a partial oracle mesh makes invariants disagree, so it
> produced a false RED. Nothing about the mechanism guarantees that direction.

`parseAsciiStl` now asserts completeness structurally, and every check is an exact
property of the format rather than a threshold: `endsolid` must be present, `facet`
count must equal `endfacet` count, and the vertex count must be exactly 3× the
facet count. A file failing any of them is an **unusable oracle** (`PENDING`), never
compared. Controlled directly: a cube truncated at a facet boundary, mid-facet and
mid-vertex are all rejected; a complete file and a legitimately empty solid are
accepted. **A short read is now loud. It is not thereby impossible.**

---

## 🔴 A THIRD AND FOURTH DEFECT IN THIS HARNESS, found 2026-08-11 (second pass)

**Same class as the two above, and that is the point of grouping them: every one
of the four is the instrument reporting its own vocabulary as a defect in the
thing it measures.** Two of them produced a `DIVERGES` on a case where the
product was RIGHT — ⚠ **a false red is more expensive than a miss**, because it
sends somebody to fix correct code and the instrument's output *is* the evidence
they check against.

**3 — a `%` node was built into `EMPTY` and LEFT IN ITS PARENT'S CHILD LIST, so a
difference whose first operand was background canonicalised to nothing.**
`normalise`'s `diff` arm reads an empty first operand as *"nothing to cut away
from"* and returns `EMPTY` — which is correct for a genuinely empty operand and
wrong for a removed one. Measured: for `difference(){ %cube(20);
cylinder(h=40,r=5,center=true,$fn=16); }` the oracle side canonicalised to
`<nothing>` while **the binary's own STL is the cylinder at 3061.4675 mm³, and so
is ours** (60 facets both sides).

Fixed by reading OpenSCAD rather than guessing it. `GeometryEvaluator::
collectChildren3D` — and `collectChildren2D` — open with `if (chnode->modinst->
isBackground()) continue;`, so the background child is **removed** from the list
the operator receives and **the next operand is promoted to first**;
`applyToChildren3D` then takes its `children.size() == 1 -> this is a noop` early
return. `canon.mjs` now filters background nodes out of every child list (one
helper, used at both sites) and `buildCsg` **throws** if one reaches it, so a
missed call site is a `PENDING` rather than a quiet return to the old behaviour.

⚠ **THE BOUNDARY WAS PROBED, NOT ASSUMED, AND IT IS NARROW.** *Removed* is not
*empty*: a non-background first operand that evaluates to nothing still yields
nothing (`manifold-applyops.cc`: `if (op == DIFFERENCE && !foundFirst) { geom =
nullptr; break; }`), and so does a `%` wrapped in a transform, because the
transform node is not itself background — `difference(){ translate([0,0,0])
%cube(20); cylinder(...); }` prints *"Current top level object is empty"* at
2026.08.07. A fix phrased as *"drop empty children"* would have been wrong in the
other direction on both. `corpus/edge_modifier_background_operand` pins it, and
was watched go red under the pre-fix `canon.mjs`.

**4 — `$fa`/`$fs` were printed from a hard-coded `OUR_FA = 12` / `OUR_FS = 2`.**
Two of `CAD1`'s four accepted divergences — `partial_fa_fs_args` and
`partial_fa_fs_global` — read `TREE differs / MESH same` on this alone. `scad.ts`
now carries `{fn, fa, fs}` as a triple on every curved primitive and `mesh.ts`
tessellates with it, so the harness was **diverging from itself and naming the
product.** Fixed in two places, and the second is the one that made the first
look ineffective: `sceneToCanon` reads `p.fa`/`p.fs`, **and `ours.mjs` stopped
passing `{ fa: OUR_FA }` on every run** — an override supplied unconditionally
pinned the whole tree to 12 no matter what the primitives said. The override is
kept ahead of the primitive values because the `tree-fa` plant is the only thing
that needs one.

🔴 **The comment above the constant is the part worth carrying forward.** It read
*"AND THAT IS NOT A CHEAT — `scad.ts` refuses `$fa`/`$fs` as primitive arguments
and never reads them as variables"*, and it went on vouching for the constant
after the premise died. ⚠ ***A comment explaining why a control is right is the
least-audited thing in the repo*** — nobody re-reads a justification, and this one
was the whole argument for two accepted divergences. Both corpus headers had
inherited the same dead sentence and are corrected too; the `args` one was
**never** true — the refusal it named sat below an allowlist `continue` and was
unreachable, and the measured run reports `refusals 0`.

**Verified before removing anything, at record level rather than in aggregate:**
`sphere(r=10,$fa=5,$fs=0.5)` is **5180 triangles on BOTH sides** (12/2 would give
840), volume 4175.517851 vs 4175.517816 (rel 8.4e-9), area rel 5.6e-9, bounding
box ±9.990482 on both sides — which is the 72-fragment inradius, not the
30-fragment 9.945. *"The solids happen to agree"* was another agent's phrasing
from a transcript; the numbers say they agree because they are the same
tessellation.

⇒ **Both entries are now stale exemptions in `CAD1_KNOWN`.** `gates/` is outside
this pass's boundary, so they are **reported, not edited** — see the run report.

---

## 🔴 A FIFTH DEFECT IN THIS HARNESS, found 2026-08-11 (refusal-split pass)

**5 — a whole verdict was awarded before anything was compared.** `REFUSED` was
returned as soon as we named a construct and emitted nothing, so **the oracle's
own answer was never consulted for a refusal.** Every refusal scored identically
whether OpenSCAD exported a solid, drew an outline, or produced nothing.

⚠ **This one is a different shape from the other four and worth separating.**
Defects 1–4 were the instrument reporting *its own vocabulary* as a defect in the
thing it measures, and each produced a wrong answer. This one produced **no
answer at all, in a word that reads like a good one.** Nothing was ever red about
it; the harness simply could not be asked the question, and the summary line's
`REFUSED 16` was read for weeks as sixteen safe cases.

**How it was found — not by reading this file.** An agent planted the real
behaviour change in `web/src/cad/mesh.ts` (drop the 2D operand of a boolean, to
match OpenSCAD) and ran the **full hardware leg over 103 real files**. The output
was **byte-identical** except one informational note. A plant that changes
nothing is not a plant that passed.

**Fixed by consulting the oracle the harness already had** — see *Verdicts* — and
the first measurement is the finding: **of the sixteen refusals, sixteen are
capability gaps and zero are agreement.** The one `REFUSED-BOTH` in the suite is a
case written during this pass.

✅ ~~🔴 **AND THE FIX HAS NO CONSUMER YET.** `gates/slicer_gate_check.mjs` counts
`verdict === 'REFUSED'` (now always 0), scores only `DIVERGES|ERROR`, and reads
this harness's **exit code for `=== 2` alone** — so a `STRICTER` row that is not
on the ledger makes the oracle exit 1 and `CAD1` still passes.~~ **STALE — the
gate consumed it before this paragraph was next read** (re-measured 2026-08-12 at
`gates/slicer_gate_check.mjs`): it reads `j.stricterLedger`, derives
`ledgerFindings(hwLeg)` from it, fails `CAD1`/`CAD1H` on those findings, fails on
the ledger object being **absent** as a BROKEN INSTRUMENT, and carries a
`cad1-ledger-absent` self-plant to prove that limb. The ledger's answer is in the
JSON as `stricterLedger`, which is what made that a one-line change. **`gates/` is
still another boundary: reported, not edited** — including this correction, which
is a correction to THIS file about that one.

---

## 🔴 A SIXTH DEFECT IN THIS HARNESS, found 2026-08-12 (audit-leg pass)

**6 — the harness reported agreement about a solid its own kernel says is not
closed.** `ours.mjs` computed `audits` and `trust` on every single run since it
was written, and **`oracle.mjs` read neither** — not in `decide()`, not in
`meshLeg()`. So a part `mesh.ts` itself calls `open` or `non-manifold`, with
`trust: 'untrusted'`, was compared on volume and area like any other and could
come back **`SAME — tree and solid both agree`**.

**Measured under `--plant drop-face`, before the fix:**

| case | audit under the plant | old verdict |
|---|---|---|
| `corpus/prim_sphere_default_fn` | `open`, `trust: untrusted` | 🔴 **`SAME`** |
| `corpus/partial_fa_fs_args` | `open`, `trust: untrusted` | 🔴 **`SAME`** |
| `corpus/partial_fa_fs_global` | `open`, `trust: untrusted` | 🔴 **`SAME`** |

**Why exactly those three, and why no tolerance would have helped.** On a
high-triangle curved primitive one face is a vanishing fraction of the solid.
Measured against the unplanted run: `prim_sphere_default_fn` (672 triangles)
moves volume **1.71e-2 mm³, rel 8.18e-6**; the two `partial_fa_fs_*` cases (5180
triangles, `$fa=5,$fs=0.5`) move **2.10e-4 mm³, rel 5.03e-8** — the second pair is
**below the 9.04e-8 float32 quantisation floor**, i.e. beneath the instrument's
own resolution, so this was never a question of where `REL_TOL` sits. The other
59 solid cases are cubes and low-`$fn` cylinders where one face is 1.3e-1 to
3.3e-1 of the volume, and they reddened loudly — 🔴 **which is what hid the
three: a plant that fires on 59 of 62 cases reads as a working control.**

⚠ **`flip-face` is the sharpest of the three and for a reason worth keeping:** it
moves **no area at all** (rel 0, exactly — the triangle is still there and still
the same size), so half the invariants are blind to it by construction.

**The fix, in the order it had to be done.** First the consumer: `meshLeg()`
consults `ours.audits` **before `compareInvariants`**, and any `dim === 3` part
whose verdict is not `closed` returns **`PENDING`** with the audit's own word in
the reason. 🔴 **`PENDING`, not `DIVERGES` — an unclosed mesh is an undecidable
comparison, not a measured disagreement.** Only then the plants: `MESH_PLANTS` is
imported from `mesh.ts` and its three values passed through to
`meshScene(scene, plant)`. **Wiring the plants first would have produced a plant
that proves nothing**, which is this lane's most-filed defect.

**The A/B, same corpus and same plant, old verdict algebra against new** (the
pre-change `oracle.mjs` restored from `HEAD` into a throwaway copy in this
directory, since deleted):

```
                         (both legs re-run on the SAME 87-case corpus, after the
                          87th case was added, so the two lines are comparable)
OLD  --plant drop-face   SAME 8 · DIVERGES 59 · PENDING 0
     corpus/prim_sphere_default_fn  SAME->SAME  same same  "tree and solid both agree"
NEW  --plant drop-face   SAME 5 · DIVERGES 1  · PENDING 61
     corpus/prim_sphere_default_fn  SAME->PENDING  same pending
       "our kernel audits this solid as open; volume and area are not defined on an
        open or non-manifold surface, so the invariant comparison cannot decide it"
```

⚠ **`mesh-scale` cannot reach this state** — it moves every vertex and the
surface stays closed — **so no plant that existed before this pass could have
found it**, and the README filed the hole as an accepted limit ("volume is
meaningless on an open surface … the harness does not separately assert
closure"). ***A limit written down as a division of labour stops being read as a
gap.*** The audit did run, independently and correctly, and its verdict went into
a JSON file nobody consulted: **a control with no consumer accrues the authority
of one.**

🔴 **AND THE UNPLANTED RUN DID NOT MOVE, WHICH IS THE HALF THAT MATTERS.**
87 corpus cases: 0 rows changed verdict. 68 `hardware/cad/` files: every solid
they produce audits `closed` (probed part-by-part as well as through the
harness), so the `CAD1H` tracked count is untouched. **If a case had gone PENDING
unplanted, that would have been a finding about our kernel and not about this
harness** — it did not, and that is a measurement, not a reassurance.

---

## Results — real numbers from a real run

⚠ **These figures are from 2026-08-10 and predate both harness fixes above** — in
particular the corpus was 63 cases, not 68, and the `color()` refusal analysis is
the state of a `web/src/cad/` that has since changed. Current figures:
`SLICER-GATES.md`, CAD1H section.

`openscad 2026.08.07`, `REL_TOL 1e-5`, all runs `2026-08-10`.

### Corpus — 63 hand-written cases, one construct each

```
SAME 39 (of which 2 are empty-on-both-sides) · REFUSED 19 · DIVERGES 5 · ERROR 0 · PENDING 0
VERDICT: NO-GO                                                                       (exit 1)
```

**37 real agreements.** Every one of the five primitives, all three transforms (including the
`Rz·Ry·Rx` order that is easy to get backwards), all three booleans, `difference` with three
subtrahends, modules with default / named / positional arguments, variables and expressions, `for`
over an integer range, a fractional-step range and a vector of vectors, `if`/`else`, `$fn` as a
global, `$fn` dynamically scoped through a module call site, the `*` disable modifier, and — notably —
**the coplanar-face difference agreed to 1.5e-16 of volume**, which is the failure mode `mesh.ts`'s
own header warns about hardest.

**19 clean refusals**, each named: `hull`, `minkowski`, `linear_extrude`, `rotate_extrude`, `polygon`,
`polyhedron`, `mirror`, `offset`, `text`, `color`, `resize`, `projection`, `children()`, a user
`function` definition, a list comprehension, `let()`, `intersection_for`, the `#` modifier, and a
negative `scale` (refused by the **kernel**, for determinant ≤ 0 — this is the one that proves the
harness sees mesh-stage refusals as refusals, not divergences).

**5 divergences** — ⚠ **three of the five have since CLEARED, and the struck rows are kept because a
dated record is evidence of what was measured, not a claim about today.** The live set is two:
`fn_clamped` and `partial_rotate_axis_angle`.

| Case | What we do wrong |
|---|---|
| ✅ ~~`edge_modifier_root`~~ | *(CLEARED at `fbfe2738f1`, which implemented `!` rather than refusing it. ⚠ The row's wording — "we refuse `!` and drop its subtree" — survived into two corpus file headers and stayed there until 2026-08-11, which is the whole reason a struck row beats a deleted one.)* |
| ✅ ~~`partial_fa_fs_global`~~ | *(2026-08-11: **CLEARED, and it was never this.** The row said `scad.ts` stores the assignment and `mesh.ts` "never reads it and tessellates at the hard-coded 12/2". `mesh.ts` reads both, and has since `b739cbc53b`; the 12/2 was **`canon.mjs`'s** — `OUR_FA`/`OUR_FS`, printed on our side unconditionally. The harness was diverging from itself and naming the product. Now `SAME`: **5180 triangles on both sides**, volume rel 8.4e-9. See "A THIRD AND FOURTH DEFECT IN THIS HARNESS" above.)* |
| ✅ ~~`partial_fa_fs_args`~~ | *(2026-08-11: **CLEARED, and the row's premise was already false when written.** "Refused by name" — the refusal branch that named `$fa`/`$fs` as arguments sat below an allowlist `continue` and was unreachable from anywhere in the file; the measured run reports **`refusals 0`** on this case. Same root cause and same fix as the row above.)* |
| 🔴 `partial_rotate_axis_angle` | `rotate(45,[1,1,0])` is refused by name and the subtree is kept **unrotated**. `scad.ts` says so in its own comment. The instructive part: **volume and area match to 1.6e-16** — only the tree and the bounding box (10 mm out) catch it. This case alone justifies comparing bbox and centroid rather than volume alone. |
| 🔴 `fn_clamped` | `$fn = 400`; `mesh.ts` clamps to `MAX_FN = 256`. Tree agrees (it carries 400), solid is 5.93e-5 light. The smallest real defect in the corpus, and the reason `REL_TOL` is not at 1e-4. |

### `hardware/cad/` — the hive models this company actually cuts

⚠ **The brief said 41 files (6 top-level, 35 under `lib/`). Measured: 68** — 6 top-level and **62**
under `lib/` (27 directly, 30 in `lib/components/`, 5 deeper). The wider tree holds 250 non-archive
`.scad` files and 516 including `archive/`. The 68 are what this run covers.

```
SAME 14 (all 14 empty-on-both-sides) · REFUSED 50 · DIVERGES 3 · ERROR 1 · PENDING 0
```

🔴 **Zero of the 68 files produce a solid our pipeline agrees with.** The 14 `SAME` rows are
module-only library files that evaluate to nothing on *both* sides — they are counted separately
precisely so that "14 SAME" cannot be read as 14 agreements. **Only 3 of 68 files reached the mesh
leg at all**, and all three had already failed the tree leg.

Five of the six top-level files — `2bee_cables`, `2bee_connectors`, `2bee_scnc`, `hive_context_viz`,
`hive_top_assembly` — are `REFUSED`; the sixth, `_trigger_test.scad`, is empty on both sides.
*(2026-08-22: `_trigger_test.scad` was deleted by cad in their scratch-file sweep — fine
gate-wise, no code read it; this sentence is historical and the file is gone.)*

**What the gap costs, by construct** — 360 refusal sites across the 68 files:

| Family | Sites | Files |
|---|---:|---:|
| `color()` | **198** | 36 |
| user-defined `function` definitions | 76 | 15 |
| other OpenSCAD builtins (`is_undef` 26, `str` 4, `assert` 3, `echo` 1, `mirror` 1) | 35 | 27 |
| `include <>` / `use <>` | 26 | 12 |
| calls to user-defined functions | 23 | 4 |
| `%` modifier | 2 | 2 |

**`color()` alone is 55% of the sites and appears in 36 of 68 files.** It is refused because "nothing
here renders" — but the refusal takes the *subtree* with it, so a component model wrapped in
`color("black")` loses its geometry. That is the cause of all three hardware divergences:

| File | Tree divergence |
|---|---|
| 🔴 `lib/components/adxl345_accel.scad` | OpenSCAD has `color([0,0,0,1])` where we have a bare `cylinder` — parts of the model survived the refusal and parts did not |
| 🔴 `lib/components/ina219_gy219.scad` | same shape |
| 🔴 `lib/components/nrf9151_feather.scad` | OpenSCAD's root is a `union`, ours is a `diff` — the refusal removed a boolean's operand |
| 🔴 `lib/sc133_load_cell.scad` (`ERROR`) | `is_undef()` is refused → `_sc133_lib_only` evaluates to undef → the library-guard `if` takes the wrong branch and we emit geometry OpenSCAD does not |

**The honest reading:** the subset is *correct* on what it implements — 37 of 37 real corpus
agreements, including the coplanar boolean — and *does not reach* the real files. The single
highest-value change measurable from here is `color()` as a pass-through container (198 sites, 36
files), then user-defined functions (99 sites), then `is_undef()` and `include`/`use`.

---

## Proposed gate — **not wired**, for the lane session to wire

⚠ **STALE HEADING, KEPT AS A DATED RECORD: `CAD1` AND `CAD1H` HAVE BEEN WIRED
SINCE 2026-08-10** and live in `gates/slicer_gate_check.mjs` with a name-exact
`CAD1_KNOWN` and a `CAD1H_BASELINE` count. Read this section as the proposal it
was, not as the state of the gate. 🔴 **What it still does not cover is the
`REFUSED` split**: the gate scores `DIVERGES|ERROR`, counts a `REFUSED` verdict
that no longer exists, and ignores this harness's exit code except for `2` — so
an unlisted `STRICTER` is a NO-GO here and a PASS there. The JSON now carries
`stricterLedger` so that is a one-line change; it belongs to whoever owns
`gates/`.

`gates/slicer_gate_check.mjs` is deliberately untouched. Proposal:

**Gate id `CAD1` — "our OpenSCAD subset means what OpenSCAD means".**

*Physical failure guarded:* a `.scad` source that our tab evaluates into a **different part** from
the one the author wrote and OpenSCAD renders — cut to a shape the code never described. The
`edge_modifier_root` and `partial_rotate_axis_angle` findings are that failure, already present.

| Outcome | Condition |
|---|---|
| `GO` | every corpus case is `SAME` or `REFUSED` |
| `NO-GO` | any `DIVERGES` or `ERROR`; **or any PENDING outside the budget** |
| `INCOMPLETE` | only budgeted PENDINGs |

Suggested `PENDING_BUDGET` entries, each naming the condition and the failure it stops detecting:

- **`CAD1` when `openscad` is absent** — the binary is not a build dependency of this lane and CI
  boxes may not carry it. Cost: the entire comparison, so a box without it detects nothing here.
- **`CAD1` under `--quick`** — measured, the 63-case corpus run is **3.2 s** wall clock, so this
  entry is probably not needed; measure again before adding it rather than budgeting a PENDING for a
  cost that turned out not to exist. (⚠ Adding a `PENDING_BUDGET` entry is a decision, not a
  cleanup — `SLICER-GATES.md` §4.)

⚠ **`--hardware` must NOT be in the gate as a pass/fail input** at wiring time. It is 8 divergences
and 1 error *today*, all of them known and none of them regressions, so gating on it would ship a
permanently-red gate — and `SLICER-GATES.md` §4 records why a permanently-red verdict stops being
read. Wire it as a **tracked number** (`REFUSED 50 / DIVERGES 3 / ERROR 1 / SAME-real 0`) that fails
when it gets *worse*, and re-scope it to pass/fail once the `color()` gap closes.

---

## Files

```
oracle.mjs       CLI, orchestration, verdicts, STRICTER_LEDGER, the plant check,
                 the report
openscad.mjs     drives the real binary; ASCII STL parse; every failure carries a
                 reason, and `empty` / `notSolid` / unavailable are three of them
canon.mjs        the .csg parser, the canonical CSG form, both sides' reductions, %g-at-6;
                 CONSUMES mesh.ts's rotationMatrixDegrees for our side rather than
                 re-deriving it — see the 🔴 under "Run it"
invariants.mjs   volume / area / bbox / centroid, the tolerance and its derivation
ours.mjs         imports web/src/cad/*.ts unmodified; FOUR plants of its own, plus
                 mesh.ts's three MESH_PLANTS imported and passed through — seven
                 `--plant` values, one table, and an import-time throw if the
                 product exports an audit plant this file does not drive
corpus/          one construct per case, named after the construct. NO COUNT HERE
                 ON PURPOSE — it was written as 63, has been 68, 69, 76, 81 and
                 86, and is 87 since the audit-leg pass. `oracle.mjs` prints
                 `cases N`.
```

## The blind-spot map — what the corpus does NOT reach (2026-08-11)

🔴 **`xform_rotate_quadrant` was found by accident.** An agent reading a report
noticed that the corpus rotated by `[15,25,35]` and `[0,0,30]` and by nothing
else, so `CAD1` stayed green through the entire epsilon defect. **Nothing
mechanical found it, and nothing mechanical would have.** This section is the
result of going looking on purpose: `web/src/cad/scad.ts` and `mesh.ts` were read
construct by construct **and parameter by parameter**, and every gap is listed —
including the ones deliberately left open, because *a gap nobody wrote down
becomes coverage in the next reader's head.*

**The method that matters is the second half of that sentence.** The quadrant
defect was in a construct the corpus DID exercise, at a **parameter value** it
never used. So the axis is value classes, not construct presence: boundaries
(0, negative, exactly-at-a-limit), quadrant and axis-aligned angles, degenerate
inputs, the scalar form of something usually written as a vector, and the
positional form of something usually written by name.

### Seven cases added, each with the plant it was watched go red under

Every one is `SAME` today and every one has been **watched go red** in a
throwaway copy of this harness with the defect it guards planted into a copy of
`web/src/cad/*.ts` — never into the live tree, because another agent could have
run the oracle mid-plant. Details are in each file's header.

| Case | Value class it opens | Watched red under |
|---|---|---|
| `prim_cylinder_positional` | positional argument slots; an unspecified radius defaulting to **1, not to the other radius** | r2-defaults-to-r1 → `DIVERGES`; `pos[3]` (center) unread → `DIVERGES` |
| `variables_last_assignment_wins` | scope semantics — last assignment governs the whole scope, first position / last expression | first-assignment-wins → `DIVERGES` |
| `control_for_range_ulp` | loop-count boundary: 1 ulp below an integer rounds up, 2 ulps below never does | `Math.trunc(span)` → `DIVERGES`; `Math.round(span)` → `DIVERGES` |
| `expr_round_negative` | math-builtin semantics — C rounds a half away from zero, JS toward +∞ | `Math.round(x)` → `DIVERGES` |
| `expr_is_undef_guard` | the `is_undef` special form + `\|\|` short-circuit — **`is_undef` is in 100 of the 246 non-archive `hardware/cad/` files (27 of the 68 `--hardware` covers) and the corpus called it 0 times** | special form removed → `ERROR`; `\|\|` evaluating both operands → `ERROR` |
| `xform_scalar_forms` | the scalar form of all three transforms — `translate(5)` is a **no-op**, `rotate(45)` is about **Z**, `scale(2)` is **uniform**; ~20 sites in `hardware/cad/` | scalar translate expanded to `[5,5,5]` → `DIVERGES`; scalar rotate about X → `DIVERGES` |
| `module_children_index` | `children(i)` / `children([a:b])` / out-of-bounds — real files index children 0…8 | index ignored → `DIVERGES` |

### 🔴 Three properties of the INSTRUMENT, found while building those

**1 — `CAD1` cannot see a `SAME` → `REFUSED` regression, and two plants proved
it.** Removing the `is_undef` special form, and removing `^` from the tokenizer,
each turn a correct case into a *refusal*. A corpus file whose only content is
the construct under test then emits nothing at all and scores `REFUSED` — which
the gate treats as safe and which it is, for the material. **But a capability we
silently lost is invisible**, and a corpus exists to notice exactly that.
⇒ **Convention, applied in `expr_is_undef_guard` and to be applied to any future
case whose construct GATES EMISSION: include an unconditional control solid.**
With one, a partial loss is compared and scores `DIVERGES`/`ERROR`; without one it
disappears into a green.

**2 — a case that is empty on the ORACLE's side cannot be compared at all.**
`openscad --export-format asciistl` exits 1 with *"Current top level object is
empty"*, which this harness correctly reports as `PENDING` — and a `PENDING`
FAILS `CAD1`. So a case built entirely from degenerate primitives reddens the
gate **with a message about the oracle rather than about the defect.** Measured,
not reasoned: a three-degenerate-primitive case went `PENDING` under its plant and
`SAME` once a control solid was added. Same fix as (1).

**3 — `include`/`use` are structurally untestable here, and this is the largest
single hole.** `ours.mjs` calls `parseScad(src)` with **no `ScadFileHost` and no
`path`**, while the product always passes one (`CadTab.tsx` →
`makeLibraryHost(library)`). A corpus case containing `use <lib.scad>` would
therefore measure the **no-host refusal**, not the import semantics — and
`include` being textual while `use` is not is a difference that ADDS OR DROPS
GEOMETRY (probed and written up in `scad.ts`). 26 refusal sites across 12
`hardware/cad/` files are imports. Two things would have to change together: the
harness would have to build a host, and `scadFilesIn(corpus, false)` is
non-recursive, so a library file would have to sit *beside* the case and would
become a case in its own right. **Not attempted here — it is a change to
`ours.mjs`, which is outside this pass's boundary.**

### Measured and deliberately NOT added

- ✅ ~~**A 2D operand inside a boolean cannot go red, and the reason is a
  finding.**~~ 🔴 **CLOSED 2026-08-11, and the entry was right about the binary
  and wrong about the instrument.** It said a case here "would pin behaviour that
  cannot regress into a red", which was true *of the verdict algebra of the day*
  and was recorded as if it were a property of the problem. **The algebra was the
  defect** (see the split, above): the case cannot go red *while a refusal is
  scored without asking the oracle*, and it can the moment the oracle is asked.
  ⚠ ***A limit measured against a broken instrument reads exactly like a limit of
  the world*** — and this one then discouraged the corpus case that would have
  exposed the instrument. Five cases added (`bool_2d_operand_{difference,union,
  intersection}`, `bool_2d_first_operand`, `bool_2d_all_operands`), four
  `STRICTER` and one `REFUSED-BOTH`, all five watched go red under
  `--plant drop-2d-operand`. **A sixth landed 2026-08-12:**
  `bool_2d_first_operand_intersection` — `intersection(){ circle(8); cube(10); }`,
  the 2D-first trap and the annihilating operator in one node, and the only
  member of the family that produces nothing at **every** door (STL *"is empty"*,
  SVG and DXF *"not a 2D object"*, no file from any of them). ⇒ a second genuine
  `REFUSED-BOTH`, not on the ledger because there is no gap to name; watched go
  red under the same plant, `REFUSED-BOTH → DIVERGES`.
  ⚠ **And the entry's own example was the safe half of a two-sided rule.**
  `difference(){cube; circle;}` does export the plain cube — but
  `intersection(){cube; circle;}` exports **nothing at all**, so the "drop the 2D
  operand to match" reading the entry implied would emit a solid where OpenSCAD
  emits none. **38 non-archive `hardware/cad/` files call `circle()`/`square()`.**
- **Degenerate primitives** (`cube(0)`, `sphere(r=0)`, `cylinder(h=0)`) — built,
  decidable with a control solid, and watched red under *"the zero-height guard
  removed"* → `DIVERGES` (the kernel emits two zero-volume discs; bbox 10 vs 25).
  Left out only to keep the corpus small; it is the sole path to the kernel's
  degenerate-primitive refusals and is the first thing to add back.
- **The `^` operator** — built and watched red three ways (`^` removed from the
  tokenizer → `ERROR`; left-associative → `DIVERGES`; binding looser than unary
  minus → `ERROR`). Left out on exposure: 3 files, and its worst failure mode is
  loud.
- **Modifier characters (`*`, `!`, `#`, `%`)** — ✅ **CLOSED 2026-08-11, and the
  answer to the deferred question was NO.** This entry said four cases existed
  and that whether they covered the modifiers' parameter space was the other
  agent's question. It was, and 🔴 **all four scored `SAME` before AND after all
  four defects `d749b176c2` fixed** — one modifier and one statement each, so the
  entire defect class lived in the combinations and not one case could see it.
  ⚠ ***"A case exercises this construct" is not a coverage statement***, and this
  is the second time in one file that the axis turned out to be inside a
  construct the corpus already had. Five cases added:
  `edge_modifier_root_{on_disabled,nested,in_background,on_background}` and
  `edge_modifier_background_operand`.
  🔴 **One of the five cannot go red on its own defect and says so in its header**
  — `edge_modifier_root_on_background`, because a working `!` suppresses every
  sibling, so the control-solid convention below is *inapplicable* there rather
  than merely skipped.
- **Nested `color()`** (the outermost wins, which is the opposite of CSS) — **not
  a gap, a permanent blind spot.** `canon.mjs` maps `color()` to a union and colour
  moves no vertex, so a regression in the inheritance rule is invisible to BOTH
  legs of this harness. It belongs to `tests/cad-colour.test.ts`, and that is
  where it is.

### Still uncovered, in rough priority order

Named rather than fixed, so the next pass starts from a list instead of a re-read:

- **Booleans:** an empty `union() { }`; a single-operand boolean (the *"only ONE
  operand"* warning path); a `difference()` whose first operand produced nothing;
  an `intersection()` with one empty operand (refused whole); the `MAX_POLYS` /
  `MAX_MS` budget refusals.
- **Primitives:** `sphere(d=)`, `cylinder(d=)`, positional `sphere(5)`/`circle(5)`;
  `cube([10,20])` (a wrong-length vector — refused to a 1 mm fallback, which is
  what OpenSCAD does); a non-numeric size component; `square`/`circle` `center`
  and `d`.
- **Tessellation boundaries:** `$fn = 0`, `1`, `2` (the floor of 3); `$fs < 0.01`
  and `$fa < 0.01` (clamped with OpenSCAD's own wording); `r < 1e-6` → 3
  fragments — ⚠ and note our threshold is `1e-6` where OpenSCAD's `GRID_FINE` is
  `9.5367e-7`, a real 5% window in which the two disagree about a primitive nobody
  can cut.
- **`for`:** a negative step; an empty range; **multiple bindings**
  (`for (x = …, y = …)`); `MAX_LOOP_ITERATIONS`.
- **Modules:** a positional argument occupying its slot even when a named one
  overrides it (`m(10, a=99)` — a measured defect); a default that references an
  earlier parameter (`module n(a, b = a*2)`, which is `undef` in OpenSCAD);
  `$children`; `MAX_CALL_DEPTH`.
- **Expressions:** the other 22 math builtins; `PI`; `$t`; `$preview` (⚠ this file
  chooses `true`, so a source writing `if ($preview) stand_in();` gets the
  STAND-IN); division by zero (OpenSCAD carries `inf` into the geometry, we draw
  nothing — likely a real `DIVERGES` and worth measuring); vector arithmetic;
  `.x`/`.y`/`.z`; a user function shadowing a builtin; a function closing over its
  DEFINING scope; `MAX_FN_DEPTH`.
- ✅ ~~**`mesh.ts`'s own audit verdicts.** `open`, `non-manifold` and `seams` are
  never produced by any corpus case. `mesh.ts` exports `MESH_PLANTS`
  (`drop-face`/`duplicate-face`/`flip-face`) for exactly this and **`ours.mjs`
  never passes one** — the audit's negative controls exist and this harness does
  not drive them.~~ 🔴 **CLOSED 2026-08-12: all three are driven, and driving
  them found a defect rather than filling a gap.** The entry read as a coverage
  hole in the CORPUS — "no case produces an `open` verdict" — and the corpus was
  never the problem: **nothing read the verdict at all.** The three plants are
  now `--plant` values, `meshScene(scene, plant)` is passed the value it has
  always accepted, and each moves 61 of 87 cases `SAME → PENDING`. ⚠ **`seams`
  is still never produced** — it needs a T-junction repair that exhausts its
  budget, which no plant here can force — so that third of the entry stands.

## Known limits — named, because a limit nobody wrote down becomes a claim

- **`hardware/cad/` is READ ONLY here.** The harness reads the sources and hands their paths to
  `openscad`, which writes only into a per-call temp dir. Nothing in this tool has a write path into
  another lane's tree.
- **A case whose top-level solids overlap cannot be decided on the mesh leg.** `mesh.ts` deliberately
  does not union top-level siblings (it matches OpenSCAD's F5 preview, not the F6 render that the STL
  export performs), so summed invariants are not the union's. The harness detects the overlap by
  bounding box and reports **PENDING with that reason** rather than comparing the wrong quantities.
  No corpus case currently hits it.
- **2026-08-14 — the same limit one notch down: top-level solids that merely TOUCH make AREA
  undecidable, and only area.** The CGAL union deletes the coincident contact faces (proved against
  the binary: stacked cubes union to area 1000 vs 1200 summed; partial contact removes exactly
  2×contact), while volume, bbox and centroid are untouched by a zero-volume contact — so those are
  still compared and must pass, and only an area-sole disagreement reads **PENDING**. Detected by
  bounding-box contact at a relative epsilon (`boxesTouch` in `invariants.mjs`); ten hardware files
  sat in `DIVERGES` on exactly this instrument artefact until today.
- **2026-08-14 — a source that references `$preview` is undecidable BY CONSTRUCTION here.** The two
  oracle legs straddle it: `-o csg` runs `$preview=true` (F5) and `-o stl` runs `$preview=false`
  (F6), so the tree leg and the mesh leg would be measured against *different* solids and the oracle
  disagrees with itself. `meshLeg` reports **PENDING** before any number is compared. Our kernel is
  deliberately self-consistent at `$preview=true` (`scad.ts`); following OpenSCAD to F6 is a deferred
  product decision this instrument may not pre-empt. A tree divergence still decides the case first —
  both tree legs run at `$preview=true`.

- **The mesh leg compares 3D solids only.** Measured on `edge_2d_and_3d`: for a model with both a
  2D and a 3D object at top level, `openscad 2026.08.07` exports the 3D object and **drops the 2D one
  silently**, while we keep it as a flat part. Neither leg sees that — the tree matches (both carry
  the `square`) and the mesh leg only compares solids. A real hole in the coverage, named here rather
  than left to be discovered.
- ✅ ~~**Volume is meaningless on an open surface**, and the harness does not separately assert closure —
  `mesh.ts`'s own audit does that, independently, and its verdict is carried in the JSON.~~
  🔴 **CLOSED 2026-08-12 — and this bullet is why it stayed open: it filed a live hole as a division of
  labour.** "The audit does that, independently" was true and irrelevant; a verdict computed by `ours.mjs`
  and read by nobody is not a second opinion, it is a number in a JSON file. `meshLeg()` now consumes
  `ours.audits` **before** `compareInvariants`, and any `dim === 3` part whose verdict is not `closed`
  returns **`PENDING`** — not `DIVERGES`, because an unclosed surface does not *disagree* with the oracle,
  it makes volume and area undefined, and a check that cannot run reports PENDING. Watched go red under the
  three `MESH_PLANTS`; see *A SIXTH DEFECT*.
- **The tree comparison is syntactic after three algebraic normalisations.** Two programs that build
  the same solid by genuinely different means (a `hull` of two cylinders vs. an explicit polyhedron)
  will read as different trees. That is intended: the tree leg asks whether we *understood the
  program*, and the mesh leg is the one that asks about the solid.
- **A `SAME` on an empty-vs-empty case is not an agreement about geometry.** It is counted and
  reported separately for that reason, in every summary line the harness prints.
