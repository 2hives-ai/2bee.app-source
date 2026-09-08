# Design — TODO #12, Tier 1: the 2D kernel, and where it lives

**Written 2026-08-10.** This is a design document for the tier the OpenSCAD feature inventory
named as decisive:

> **Tier 1 — a 2D kernel plus `linear_extrude` / `rotate_extrude` — is the tier that decides
> whether this tab is useful to THIS lane at all**, because `2bee.cnc` consumes 2D outlines.
> (`docs/openscad-feature-inventory.md:502-516`)

**No code was written.** `web/src/cad/**` is held by a live agent auditing the tab; nothing under
`web/`, `core/`, `cli/`, `wasm/`, `gates/` or `tools/` was touched. Everything below was read, and
the two numeric claims that matter were **measured today** rather than quoted:
`tools/scad_oracle/oracle.mjs --hardware` was run over the 68-file selection, and a construct
census was run over the same 68 files and separately over the 13 `*_wcnc.scad` cut files.

---

## 0. Two corrections to the brief, made first because they change the argument

Both of these were true recently and are not true now. A stale premise is worse than a missing
one, because it argues.

### 0.1 🔴 The gates **can** see `web/src/cad/`. Two of them do, and they are HARD

The brief's framing — *"`web/src/cad/` is browser-only and the gates cannot see it"* — was correct
until this week. `node gates/slicer_gate_check.mjs --list` now reports **54 gates**, and two of
them are aimed at exactly this code:

```
CAD1  HARD  SCAD SUBSET vs OPENSCAD        a .scad source our CAD tab evaluates into a DIFFERENT PART …
CAD1H HARD  SCAD SUBSET vs OUR OWN MODELS  the same failure on the 68 .scad files this company actually cuts …
```

Both drive `tools/scad_oracle`, which imports `web/src/cad/scad.ts` and `web/src/cad/mesh.ts`
**directly and unmodified** under Node (`tools/scad_oracle/README.md`, "Run it"), compares them
against the real OpenSCAD 2026.08.07 binary on both an evaluated-tree leg and a solid leg, and
scores against a named baseline (`gates/slicer_gate_check.mjs:338` `CAD1_KNOWN`, `:368`
`CAD1H_BASELINE`) that fails on getting worse *and* on going stale.

⚠ **The residual gap is narrower than "cannot see it", and it is still real.** CAD1 measures the
**TypeScript source under Node**, not the **bundle the browser loads**. Gate `I1` (browser parity)
covers the CAM path — the browser and the CLI emitting identical G-code — and does not reach the
CAD tab at all, because the CAD tab does not go through the core. So the honest statement is:
*a 2D kernel written in TypeScript would be measurable against OpenSCAD by CAD1, and would still
have no check that the shipped browser build agrees with the measured source.* That is a smaller
argument against TypeScript than the brief assumed, and §5 does not lean on it.

### 0.2 🔴 The 2D boolean library this design needs is **already a dependency of `core/`**

`core/Cargo.toml:20` — `cavalier_contours = "0.7"`, locked at 0.7.0, with a recorded decision in
the manifest comment (`core/Cargo.toml:14-18`) explaining that it was chosen **over a Clipper
binding** because Clipper works in scaled integers and returns polygons, so every curve comes back
polylined — and polylined curves are the defect gate `G10` (BLOCK RATE) exists to catch.

What the manifest comment does not say, and what changes the build-or-adopt question, is that
`cavalier_contours` is not only an offsetter. Read at the crate source in the local registry cache:

- `polyline/traits.rs:1628` — `fn boolean<P>(&self, other: &P, operation: BooleanOp) -> BooleanResult<…>`
- `polyline/pline_types.rs:146-155` — `BooleanOp::{Or, And, Not, Xor}` — union, intersection,
  difference, symmetric difference
- `polyline/pline_types.rs:208-218` — `BooleanResult { pos_plines, neg_plines, result_info }`
- `polyline/pline_types.rs:191-204` — `BooleanResultInfo::{InvalidInput, Pline1InsidePline2,
  Pline2InsidePline1, Disjoint, Overlapping, Intersected}`
- `shape_algorithms/mod.rs:202` — `Shape::parallel_offset`, multi-loop offsetting with
  `ccw_plines` / `cw_plines` (material and holes)

It ships tests named `test_pline_boolean`, `test_pline_contains`, `test_pline_winding_number`,
`test_shape_parallel_offset` (`Cargo.toml:70-98` of the crate). It is **arc-preserving through the
boolean**, which no polygon library is. It builds for `wasm32-unknown-unknown` today, because
`core/` does.

**Licence, re-verified at the artefact today (2026-08-10):**
`~/.cargo/registry/src/index.crates.io-*/cavalier_contours-0.7.0/Cargo.toml:40` →
`license = "MIT OR Apache-2.0"`. Transitive `static_aabb2d_index-2.0.0/Cargo.toml:32` → the same.
This agrees with `docs/audit/2026-08-10-licence-and-deps.md` §4.2, which also records the one
wrinkle worth carrying forward: **the published crate ships no `LICENSE-*` text file of its own**,
only the SPDX declaration, so a distribution that reproduces the crate has only the declaration to
attribute from. Minor, upstream's, named so it is not discovered later as a surprise.

⇒ **The framing "build or adopt" is already half-answered by a decision this lane made and
recorded three weeks ago.** §4 still evaluates the alternatives properly, because a dependency
being present is not the same as it being sufficient, and it is not sufficient — see §4.3.

---

## 1. What a 2D kernel here actually has to do

Not "2D booleans" in the abstract. Nine concrete obligations, each with the OpenSCAD behaviour it
must match and the physical failure it guards.

### 1.1 A region type that can express a hole

Today it cannot. `web/src/cad/mesh.ts:1108-1112`:

```ts
interface Flat {
  outline: V3[];
  label: string;
  line: number;
}
```

One loop. No winding convention, no nesting, no holes, no arcs. A `square()` or `circle()` becomes
one of these and is drawn as a zero-thickness plate; `mesh.ts:1305-1320` refuses any boolean that
touches one, and says why:

> *"There is no 2D kernel here, and dropping the 2D operand would silently return the 3D one as
> though the operation had happened. The whole node was refused."*

The Rust core already has the right shape and has had it since the DXF importer was written —
`core/src/geometry.rs:353-357`:

```rust
pub struct Part {
    pub name: String,
    pub outer: Contour,
    pub inners: Vec<Contour>,
}
```

with `Contour { verts: Vec<Vertex>, closed: bool }` and `Vertex { x, y, bulge }` where bulge is
`tan(θ/4)` of the arc to the next vertex (`geometry.rs:28-50`), and a stated winding convention —
**counter-clockwise for material, clockwise for holes**, enforced by `normalise_winding()` on
import, with the module header stating that *"nothing downstream may assume a caller got it right"*
(`geometry.rs:11-15`).

**The design's first requirement is that there is exactly ONE such type in the app.** Two 2D
representations with two winding conventions and two tolerances is the seam where a hole becomes
an island, and an island under a profile cut is a part with its middle cut out.

### 1.2 Polygon booleans on closed paths with holes

`union()`, `difference()` (first child minus the union of the rest), `intersection()` — the same
semantics `mesh.ts` already implements in 3D, at one dimension lower, over **regions** rather than
over loops.

⚠ **This is not the same problem as a pairwise polyline boolean, and the gap is the expensive
part.** `cavalier_contours::boolean` operates on **two** polylines and returns
`pos_plines` / `neg_plines`. A region boolean has to:

- classify a set of loops into (outer, holes) by containment and winding, not by bounding box —
  and note that `core/src/import.rs:815-820` currently does this containment test **by bounding
  box**, with a comment saying so and saying that for the flat parts this toolchain cuts it has
  never been the limiting factor. That is true for DXF intake and is **not** true for
  `difference()` output, where a hole's bbox routinely sits inside a sibling's;
- sequence N-way operations so intermediate results stay valid regions;
- carry `neg_plines` correctly — a difference that produces a hole must produce a *hole*, not a
  second outer loop with the wrong winding;
- refuse, by name, when `result_info` comes back `InvalidInput`.

Call it **a real algorithm on top of a real library**, not glue. §8 sizes it.

### 1.3 `offset(r | delta, chamfer)`

Outward and inward offset of a region. `r` rounds the outside corners, `delta` extends them to a
mitre; `chamfer` cuts the mitre off. Inward offset can **collapse** a region — a 3 mm-wide rib
offset by −2 mm is nothing, and OpenSCAD returns nothing.

The arc-preserving half already exists and is already correct at the vertex level:
`Contour::offset` (`core/src/geometry.rs:293`), whose header carries the one thing an
implementation gets wrong first —

> 🔴 *"It is the OPPOSITE of `cavalier_contours::parallel_offset`, which offsets to the left of
> travel"* — the flip lives in exactly one place and is pinned by tests that measure bounds. The
> header records that an earlier version of that comment claimed the two conventions agreed, and
> that the first two offset tests failed because of it.

Region-level offset (outer out, holes in, with self-intersection pruning) is
`Shape::parallel_offset` in the same crate.

### 1.4 A triangulator that can be audited

Needed twice: to draw a 2D region in the preview, and to cap an extrusion. Ear clipping with hole
bridging is the usual answer and is where the robustness argument lands hardest — an ear clipper
fed a self-intersecting loop produces triangles, quietly, with overlaps, and the resulting cap is a
surface whose closure audit can still pass.

⇒ **the triangulator must not be the thing that decides a region is valid.** Validity is decided
before it (§3) and the triangulator is allowed to assume it. A triangulator that "handles" bad
input is a triangulator that hides it.

### 1.5 `linear_extrude(height, center, convexity, twist, slices, scale)`

Binary-resolved defaults are in the inventory (`docs/openscad-feature-inventory.md:139-146`), and
the one the docs get wrong is worth restating because a wrong default here is a part at half its Z:
**`center` defaults to `false`** — the wiki's syntax line showing `center = true` is an example
call, not a default list, and the binary was probed.

- `twist` and `scale` turn a prism into a **lofted sweep**: each of `slices` rings is the profile
  rotated and scaled, and the side wall is the ruled surface between consecutive rings.
- 🔴 **A twisted or scaled extrusion of a non-convex profile can self-intersect**, and the result
  is a solid with no defensible inside. That is failure mode (3) in `mesh.ts`'s own header
  (`web/src/cad/mesh.ts:29-32`) — *"NO SELF-INTERSECTION REPAIR … the OUTPUT of a boolean need not
  be, and the output of a boolean is the input of the next one"* — arriving from a new producer.
  Extrusion output becomes CSG input immediately, so this is not hypothetical.
- `convexity` is a **renderer hint** in OpenSCAD and affects no geometry. It must be accepted and
  ignored, and the fact that it is ignored must be visible — an accepted-and-ignored parameter is
  precisely the `FLAG` gate's physical failure (*"a flag that is accepted and ignored reads to the
  operator, the script AND THE GATE as a setting that took effect"*).

### 1.6 `rotate_extrude(angle, start)`

`angle = 360` default; `start` defaults to **180** when `angle` is omitted and to **0** when it is
given — probed both ways in the inventory (`:147-150`). The 2D child must lie entirely on one side
of the Y axis (every vertex `x >= 0` or every vertex `x <= 0`); a profile crossing the axis is a
refusal, not a clamp.

### 1.7 `projection(cut)` — and this is the one that matters most here

**`projection()` is how a solid becomes an outline the CAM side can cut, and it is not a
compatibility item. It is the bridge this company already uses.**

Measured: `projection` appears **0 times** in the 68 `.scad` files the oracle covers. It appears in
`hardware/cad/2bee_hive/cnc_nest/cut_outline.scad`, `.../cnc_nest/nest_flat.scad` and
`hardware/cad/metal_nest/metal_outline.scad` — the three files that produce the DXFs the CAM side
eats. `cut_outline.scad` in full:

```scad
// cut_outline.scad — 2D outline of ONE real hive panel (projection of panel_geom,
// the SAME module the nest renders) for jagua-rs. -D kind="..." -D which="...".
use <../2bee_hive_panels_18mm.scad>;
kind = "super"; which = "front";
projection(cut = false) panel_geom(kind, which);
```

and `hardware/cad/dxf_gate_check.py:223` — `dxf_export()` — is the canonical emitter: it runs
`openscad -o out.dxf` on exactly that, then normalises the result to R2010 + mm-units + a framed
VPORT, *"because OpenSCAD's raw R12/no-units export fails in real CAM (2 vendors confirmed
2026-07-07)"*.

So the live chain is:

```
*_wcnc.scad  (a 3D SOLID)
   -> projection(cut = false)          <- cut_outline.scad / nest_flat.scad / metal_outline.scad
   -> openscad -o .dxf                 <- dxf_gate_check.dxf_export()
   -> fix_file()  (R2010, mm, VPORT)
   -> 2bee.cnc
```

**The two forms are very different problems and only one of them exists here today:**

| Form | What it is | Status in this repo |
|---|---|---|
| `projection(cut = true)` | the slice at Z = 0 — intersect the solid with a plane, chain the segments | **Already implemented, in Rust.** `core/src/mesh.rs:345` `pub fn section(mesh, z_mm, tol) -> Imported`, with the coplanar-face, open-chain and empty-plane refusals its header names (`core/src/mesh.rs:18-29`) |
| `projection(cut = false)` | the **silhouette** — every triangle projected onto XY and **unioned** | **Does not exist anywhere in this app**, and it is what the hive panels use |

`cut = false` on a real panel is an N-way 2D union of every triangle in the mesh. That is the
expensive operation in Tier 1 and the one whose robustness decides whether the tab is usable: the
input loops are thousands of triangles, most of them degenerate after projection (a vertical wall
projects to a zero-area sliver), many of them exactly coincident along shared edges. Every
condition §3 lists is present in the input **by construction**, not as an edge case.

### 1.8 The 2D operand path in the existing 3D kernel

`mesh.ts:1305-1320` refuses any boolean with a 2D operand. Once a 2D kernel exists, that refusal
does not simply go away — OpenSCAD's own behaviour is to warn twice and return the 3D result
(`docs/openscad-feature-inventory.md:359`), and this lane deliberately refuses instead, on the
stated ground that returning the minuend is *"the specific lie that puts an uncut pocket on a
machine"*. **Keep the refusal.** Tier 1 removes the reason a `square()` cannot be extruded; it does
not make `difference() { cube(10); circle(3); }` meaningful, and it should not start guessing.

### 1.9 A 2D audit, ranked with the 3D one

`mesh.ts` returns a `PartVerdict` per solid (`web/src/cad/mesh.ts:100-115`) and every part is
audited before it is drawn. For 2D, `MeshPart.audit` is `null` today with the note *"`null` only
for `dim === 2`, where closure is not a meaningful question"* (`mesh.ts:152`).

That note is correct about *closure* and wrong about *auditability*. A region has its own
well-defined failure set, and it needs its own verdict, ranked the same way — including a
`pending`-equivalent for a check that ran out of budget, because **a check that could not run
reports PENDING, never PASS** is the lane's own rule and `PartVerdict`'s `'seams'` variant is
already an instance of it.

---

## 2. What our own corpus actually asks for — measured, today

Two censuses, because they answer different questions and give different answers.

### 2.1 The oracle's 68-file selection — re-run today, and it matches the banner

`node --experimental-transform-types --disable-warning=ExperimentalWarning
tools/scad_oracle/oracle.mjs --hardware`, run 2026-08-10, hardware leg only (68 files):

| Verdict | Files |
|---|---:|
| `DIVERGES` — geometry emitted, does not match | **27** |
| `REFUSED` — named, nothing emitted | **24** |
| `SAME` | **14** — *all 14 empty-on-both-sides library files* |
| `ERROR` | **3** |
| **Real (non-empty) agreements** | **0** |
| Files whose SOLID leg reads `same` | **1** — `lib/jzbz_cage.scad` |
| Files whose solid leg is `pending` | 15 |

These are the inventory banner's numbers exactly, re-measured rather than quoted. The whole run
(63 corpus + 68 hardware) is `SAME 55 · REFUSED 41 · DIVERGES 32 · ERROR 3 · PENDING 0`,
`VERDICT: NO-GO`.

**Construct census over the same 68 files** (comments stripped, sites and files):

| Construct | Sites | Files (of 68) |
|---|---:|---:|
| `color()` | 293 | **55** |
| `function` definitions | 77 | 16 |
| `is_undef` | 32 | **27** |
| **`linear_extrude`** | **31** | **16** |
| `offset(` | 22 | 8 |
| `use <>` | 20 | 8 |
| `mirror(` | 19 | 6 |
| `hull(` | 13 | 6 |
| `children(` | 13 | 4 |
| `polygon(` | 11 | 7 |
| `text(` | 6 | 5 |
| `include <>` | 6 | 6 |
| `[for` | 4 | 2 |
| `rotate_extrude` | 3 | 2 |
| `polyhedron(` | 1 | 1 |
| **`projection(`** | **0** | **0** |

### 2.2 The 13 `*_wcnc.scad` cut files — the ones the CAM chain actually eats

This is the census the tier decision should be made on, and it is **not** the one above.

| Construct | Sites | Files (of 13) |
|---|---:|---:|
| `module` | 15 | 12 |
| `use <>` | 24 | **10** |
| `difference(` | 11 | 10 |
| `color(` | 12 | 7 |
| `is_undef` | 6 | 5 |
| `intersection(` | 3 | 3 |
| `let(` | 3 | 3 |
| `include <>` | 3 | 3 |
| `function` definitions | 24 | 2 |
| **`linear_extrude`** | **2** | **2** |
| `text(` | 2 | 2 |
| `children(` | 1 | 1 |
| `polygon(` / `offset(` / `hull(` / `projection(` | 0 | 0 |

A representative file, in full (`hardware/cad/2bee_hive/2bee_hive_box_panel_wcnc.scad`):

```scad
use <2bee_hive_joinery.scad>;     // _super_endcomb/longcomb + _panel_slab
use <../lib/brand_corner.scad>;   // brand_corner()

module box_panel(which, l = 508, d = 406, h = 80, w = 19, brand = false)
    difference() {
        intersection() {
            if (which == "front" || which == "back") _super_endcomb(l, d, h, w);
            else                                     _super_longcomb(l, d, h, w);
            _panel_slab(which, l, d, h, w);
        }
        if (brand) brand_corner(which, l, d, h, w = w, hex_r = 5, corner = "lo_lo");
    }

box_panel("front");
```

### 2.3 🔴 What that census means, and it is not what the inventory assumed

The inventory says of Tier 1: *"It is also what `hardware/cad`'s `*_wcnc.scad` files are actually
made of."* **Measured, that is wrong.** The cut files are 3D solids built by `difference()` and
`intersection()` out of modules pulled in with `use <>`; `linear_extrude` appears in 2 of 13 and
`polygon` in none.

The correction does **not** weaken the tier — it relocates it. The one construct in Tier 1 that
every single one of those files depends on is **`projection()`**, because that is the step that
turns the solid into the DXF. Take it in order for one panel:

| Step | Blocked on |
|---|---|
| open `2bee_hive_box_panel_wcnc.scad` | `use <>` (Tier 5) |
| evaluate `box_panel()` | `module` ✅ already works |
| evaluate the joinery modules | `is_undef`, user `function`s, `let()` (Tier 5) |
| build the solid | `difference` / `intersection` ✅ already work, and agree with OpenSCAD to 4 dp |
| **turn it into an outline** | 🔴 **`projection(cut = false)` — Tier 1, and nothing else substitutes** |
| hand it to CAM | 🔴 no path exists (§6) |

⇒ **The decision-relevant reading:** Tier 1 is necessary and is not sufficient, and the slice of it
that this company's own geometry needs is `projection()` + the 2D region type + the N-way union
underneath the silhouette — **not** `linear_extrude`, which is what the tier is usually named
after. `linear_extrude` is needed for OpenSCAD compatibility and for 16 of the 68 library files; it
is not on the critical path from a hive panel to a toolpath.

⚠ **And Tier 1 alone gets zero of the 13 cut files to an outline**, because `use <>`,
`is_undef()`, user functions and `let()` all sit in front of it. Any plan that funds Tier 1 and not
that slice of Tier 5 buys a kernel with nothing to feed it. §7 stages accordingly.

---

## 3. Robustness — detect, never smooth

`web/src/cad/mesh.ts:9-32` names three failure modes of the BSP CSG kernel and states why they are
written down rather than hidden: *"a picture that lies about a shape is worse than no picture"*.
Every one of the three has a 2D analogue, and the consequence is worse at 2D, not better —
**a bad 3D artefact is a picture; a bad 2D artefact is a toolpath.**

### 3.1 The mapping, failure mode by failure mode

| `mesh.ts` 3D failure | 2D analogue | What it does to a cut |
|---|---|---|
| **(1) coplanar faces** — two operands sharing a face plane exactly | **collinear overlapping edges** — two loops sharing an edge segment exactly, which is the *normal* case for a projected mesh and for `difference()` of flush parts | the shared edge is kept twice or dropped; kept twice ⇒ the profile is cut twice, once in each direction, and the second pass is a full-depth cut into air or into the part; dropped ⇒ an open contour, which `plan_profile` refuses by name — the safe half |
| **(2) near-degenerate geometry** — an absolute `EPS = 1e-5` mm (`mesh.ts:66`) classifying a sliver by whichever side rounding fell on | **slivers and near-coincident vertices**. Note `Contour::POS_EQUAL_EPS = 1e-5` (`core/src/geometry.rs:113`) is the **same number**, and its comment explains why it must equal `cavalier_contours`' own `pos_equal_eps`: *"A looser value here would leave a 'repeat' the library still sees; a tighter one would leave one this module no longer sees. The two numbers have to be the same number."* | a zero-length segment reaches the offsetter, which divides by segment length ⇒ `NaN`. **This has already happened**, to this lane: `hardware/cad/dxf_gate_check.py:258-270` records 36 `G1 XNaN YNaN` blocks reported as `ok=true, tabs=0`, because Rust's `f64::min`/`max` return the other operand for `NaN` so the NaN moves never widened the bounding box and **every travel check was blind to them** |
| **(3) no self-intersection repair** — the output of a boolean is the input of the next | **a self-intersecting loop**, produced by an inward `offset()`, by a twisted `linear_extrude`'s cap, or by a silhouette union of near-tangent triangles | a self-intersecting profile has no defined inside. The offsetter still returns something, the post still emits it, the simulation still removes material along it, and the cutter follows a path that crosses itself — cutting the part it has just cut free |

### 3.2 The checks the kernel must run, and what each refuses

Six, in the order a reader should worry about them. Each is a **detection**, and each produces a
named refusal or a named warning — never a repair.

1. **Self-intersection of a single loop.** Segment-segment intersection over the loop, arc-aware
   (`cavalier_contours::pline_seg_intersect` exists for this). A loop that intersects itself is
   **refused by name, with the parameter of the intersection** so the user can find it.
   *Not* repaired by splitting into sub-loops — the split is a guess about which sub-loop the user
   meant, and there are two answers.
2. **Zero-length and near-zero-length segments.** At `POS_EQUAL_EPS`, exactly. 🔴 **This one is
   allowed to be a silent drop, and only this one** — `Contour::remove_repeat_pos`
   (`core/src/geometry.rs:115-140`) states the condition under which the lane permits it: *"A
   zero-length segment removes no material at any tool radius, at any depth, in any direction — so
   removing it cannot change a single coordinate of what is cut"*, with a test that offsets the
   same rectangle written both ways and compares vertex by vertex. That reasoning transfers
   unchanged. Everything else in this list does not qualify and must not borrow the exemption.
3. **Slivers — nonzero length, near-zero area.** A loop whose area is below a stated threshold
   relative to its perimeter is reported, not dropped, because a sliver in a projection is usually
   a vertical wall and *is* a real feature of the model even when it is not a cuttable one.
   ⚠ The threshold is **relative** (`4πA / P²`, the isoperimetric ratio) and not an absolute area,
   because an absolute mm² threshold is the `EPS`-in-millimetres failure (2) wearing a new hat.
4. **Winding and nesting.** Every loop classified as material or hole by **signed area plus a
   point-in-polygon containment test**, not by bounding box. 🔴 The bbox shortcut in
   `core/src/import.rs:815-820` is documented as adequate *for DXF intake* and is explicitly not
   claimed beyond it; boolean and projection output is exactly where it stops being adequate, and
   inheriting it silently is how a hole becomes an island.
5. **Coincident-edge tally.** Count the collinear overlapping edge pairs in the operands **before**
   the boolean, and report the count. It is not a failure — it is the normal case — but it is the
   input condition under which failure mode (1) fires, and a result computed over 400 coincident
   edge pairs deserves a different amount of trust than one computed over none. This is the 2D
   equivalent of `MeshAudit.repairedTJunctions`, which `mesh.ts:124-126` already reports for
   exactly this reason.
6. **Budget.** Polygon count and wall clock, refusing the node in flight and **saying which budget
   it was**, so the user can tell "too big" from "wrong". `mesh.ts:60-72` already does this
   (`MAX_POLYS`, `MAX_MS`) and the same rule applies: *"half a subtraction is not a shape."*

### 3.3 The verdict type, and the one that must exist

By analogy with `PartVerdict` (`web/src/cad/mesh.ts:100-115`), ranked worst-first:

| Verdict | Means |
|---|---|
| `simple` | every loop closed, non-self-intersecting, correctly wound, nesting resolved |
| `unresolved` | 🔴 **a check ran out of budget.** Ranked WITH the failures, not below them — `PartVerdict`'s `'seams'` precedent, and the lane rule *"a check that cannot run reports PENDING, never PASS"* |
| `self-intersecting` | a loop crosses itself. The region has no defined inside |
| `open` | a chain did not close. Already a named refusal on the STL path (`core/src/mesh.rs:19-23`) and must stay one here |
| `degenerate` | the region reduced to nothing — an inward offset that collapsed, an intersection that is empty. **Distinct from `open`**, because "your offset was bigger than your rib" is actionable and "no contours" is not |

### 3.4 🔴 The rule that binds all of it

**Where a region cannot be established, the whole node is refused and nothing is drawn** — the same
rule `mesh.ts:39-53` states for 3D, unchanged:

> *"A refused node contributes no geometry and takes its subtree with it. It never falls back to
> one operand: 'difference returned the minuend' is the specific lie that puts an uncut pocket on a
> machine."*

The 2D form of that lie is **"the union returned the first operand"**, and it is worse, because a
2D artefact does not get audited by a closure check on the way out. There is no watertightness
test for an outline. The detection in §3.2 *is* the audit.

⚠ **And the trust word has to be recomputed.** `docs/audit/2026-08-11-scad-silent-divergence.md`
records that `trust` is computed at `mesh.ts:1561-1610` from `mesher.issues` only, so a model whose
only cut was refused by the *parser* still reports `trust=trusted`. Adding a second refusal
producer without adding it to that computation repeats the defect one term along.

---

## 4. Build or adopt

Every candidate below carries its licence, **the artefact the licence was read on, and the date**.
This app is AGPL-3.0-or-later (`Cargo.toml:8`, `LICENSE` verified verbatim in
`docs/audit/2026-08-10-licence-and-deps.md` §2.1), so a permissive licence is one-way compatible in
the ordinary understanding and a copyleft-of-a-different-family or proprietary one is not.

⚠ **I am not counsel.** The characterisations below are the same class the licence audit used and
are flagged the same way: a permissive/AGPL-inbound question that `legal` confirms, not one this
document decides.

### 4.1 The candidates

| Candidate | Licence | Read on | Date |
|---|---|---|---|
| **`cavalier_contours` 0.7.0** (Rust, already a dep) | `MIT OR Apache-2.0` | `~/.cargo/registry/src/index.crates.io-*/cavalier_contours-0.7.0/Cargo.toml:40` — on disk, this box | 2026-08-10 |
| `static_aabb2d_index` 2.0.0 (its transitive) | `MIT OR Apache-2.0` | `…/static_aabb2d_index-2.0.0/Cargo.toml:32` — on disk | 2026-08-10 |
| **Clipper2** (C++, what OpenSCAD itself uses — `--info` reports Clipper2 2.0.1) | **Boost Software License 1.0** | `https://raw.githubusercontent.com/AngusJohnson/Clipper2/main/LICENSE` — *"Boost Software License - Version 1.0 - August 17th, 2003"* | 2026-08-10 |
| `clipper2` crate 0.6.0 (Rust bindings over the above) | `MIT OR Apache-2.0` | `https://crates.io/api/v1/crates/clipper2` | 2026-08-10 |
| **`manifold`** (C++ solid modeller, OpenSCAD's current 3D backend) | **Apache-2.0** | `https://raw.githubusercontent.com/elalish/manifold/master/LICENSE` | 2026-08-10 |
| `manifold3d` crate 0.4.0 (Rust bindings) | `Apache-2.0 OR MIT` | `https://crates.io/api/v1/crates/manifold3d` | 2026-08-10 |
| **`csgrs` 0.23.0** | **MIT** | `https://raw.githubusercontent.com/timschmidt/csgrs/main/Cargo.toml` — `license = "MIT"` | 2026-08-10 |
| **`i_overlay` 8.0.0** (pure-Rust polygon boolean) | `MIT OR Apache-2.0` | `https://crates.io/api/v1/crates/i_overlay` | 2026-08-10 |
| **Re-derive in TypeScript** | ours, AGPL | n/a | n/a |
| **Boost.Polygon** *(the brief names its ideas, not the library)* | BSL-1.0, same as Clipper2 | not fetched — see below | — |

⚠ **Two honesty notes on that table, because "declared" and "verified" are different claims and
only one row got the stronger one.** The `cavalier_contours` and `static_aabb2d_index` rows were
read **on disk, in the crate that will actually be linked**. Every other row is the **declared**
licence read from the project's own canonical `LICENSE` file or crates.io metadata — the standard
basis, and the same basis `docs/audit/2026-08-10-licence-and-deps.md` §3.2 flags for its 121 dev
packages. **Any candidate that is actually adopted gets the on-disk check before it lands**, per
the standing rule in `AGENTS.md:185-186` and TODO #12.

**Boost.Polygon is listed for completeness and is not a real option here.** It is a
sweep-line/Voronoi library over *integer* coordinates with no arc support, distributed with Boost;
its ideas (the sweep-line event structure) are worth reading and the library is not shippable to
`wasm32` from cargo. No licence artefact was fetched because it is not a candidate.

### 4.2 What each one actually buys, and what it costs

**`cavalier_contours` — already here, arc-preserving, the only one that is.**
Booleans (`BooleanOp::{Or,And,Not,Xor}`), pairwise; multi-loop offsetting via `Shape`;
`f64` coordinates; `no_std`-friendly; already compiles to `wasm32` in this workspace; already
covered by this lane's gates because it is in the code path `G7` (ARC EMISSION) and `G10` (BLOCK
RATE) measure. **Cost:** pairwise-only booleans — the region layer in §1.2 is ours to write; and
`Polyline` has no notion of a region with holes outside of `Shape`'s offsetting path.

**Clipper2 (or the `clipper2` crate) — what OpenSCAD uses, and the one this lane already rejected.**
Mature, fast, handles N-way clipping and holes natively via `PolyTree`, well-tested. **Cost, and
`core/Cargo.toml:14-18` already wrote it down:** *"Clipper works in scaled integers and returns
polygons, so every curve comes back as a polyline. That is the exact defect we are fixing:
polylined curves flood the planner (gate G10)."* Adopting it for the CAD side would mean the app
holds two 2D kernels with two coordinate models, and every arc that crosses from the CAD tab to the
CAM tab would already have been destroyed. **Rejected, for the reason this lane recorded before
this document existed.**

**`manifold` / `manifold3d` — the wrong dimension, and a bigger answer than the question.**
Manifold is a *3D* solid modeller. It is genuinely better than `mesh.ts`'s BSP kernel at the exact
things `mesh.ts`'s header admits it is bad at — it is what OpenSCAD replaced CGAL with. It is not a
2D kernel and does not answer Tier 1. It is also a C++ library reached through bindings that build
via CMake, which is a different build story from a pure-cargo dependency and a real question for
`wasm32`. **Worth a separate evaluation as a Tier-2/3 replacement for the 3D kernel; not this
tier, and not this document's recommendation.**

**`csgrs` — TODO #12 step 3 already names it, and it is the wrong shape for step 3's own reason.**
MIT, Rust, CSG over meshes. Its own `Cargo.toml` shows a large dependency surface (`hypercurve`,
`hyperlattice`, `hypermesh`, `hyperreal`, `hypertri`, plus optional STL/DXF/OBJ/glTF/font/image
features). This lane's stated dependency policy is *"every dep must build for
`wasm32-unknown-unknown` with no shims, and each one is a recorded decision"* (`core/Cargo.toml:10-12`),
and 29 locked crates today is the whole surface a licence audit had to walk. Pulling a
dependency tree of that size to obtain a 2D kernel it does not primarily provide is a poor trade.
**Not recommended for Tier 1**; it remains a candidate for the 3D kernel question alongside
`manifold`.

**`i_overlay` — the strongest pure-Rust alternative, and the one to keep in reserve.**
MIT-or-Apache, pure Rust, no C++ toolchain, N-way boolean with hole support, actively developed
(8.0.0). **Cost:** polygon-only — arcs are lost, the same objection that rules out Clipper2, but
without Clipper2's maturity to compensate. **Adopt only if `cavalier_contours`' pairwise boolean
turns out to be inadequate for the silhouette union in §1.7**, which is the one place where the
number of operands is in the thousands and pairwise sequencing may not hold up. That is a
measurable question and §7's spike answers it.

**Re-derive in TypeScript — the `mesh.ts` precedent, and it does not transfer.**
`mesh.ts` re-derived csg.js (MIT) in TypeScript, added no dependency, and vendored nothing —
`mesh.ts:3-7` says so, and it was the right call: a BSP CSG kernel is ~400 lines of well-understood
algorithm and the alternative was an npm dependency in a lane that has six runtime packages total.
A **robust 2D polygon boolean is not that.** Martinez-Rueda or Vatti is 800-1500 lines before
robustness, the robustness *is* the work (§3), and an arc-aware version — which is what this lane
needs, because of `G7`/`G10` — has essentially no reference implementation to re-derive from.
**This is the option that looks cheapest and is most likely to be the expensive one.**

### 4.3 Recommendation on build-or-adopt

**Adopt `cavalier_contours` for segment intersection, pairwise boolean and offset. Build the region
layer, the audit and the extrusions ourselves.**

It is already a dependency, already licence-cleared on disk (twice, three weeks apart), already
`wasm32`, and it is the only candidate that preserves arcs — which is not a preference here but a
gate requirement, because `G7` and `G10` name the physical failures that polylining causes.

⚠ **What is NOT claimed:** that adopting it makes Tier 1 small. The region layer, the N-way
sequencing, the silhouette union, the triangulator, the two extrusions and the audit are all ours
regardless of which library sits underneath. The library buys the two hardest *numerical* pieces
(arc-aware segment intersection, and offset) and none of the *structural* ones.

---

## 5. 🔴 The fork: TypeScript, or the Rust core

This is the architectural decision and it should be **ruled on, not defaulted into**. It is the
lane owner's call with founder sign-off on the cost, because the two arms differ by weeks and by
what the tab is allowed to claim afterwards. Below is the argument, both costs, and a
recommendation.

### 5.1 The doctrine, and what it is actually about

`AGENTS.md:124-127`:

> **One core, three hosts.** `core/` builds native (gates, CLI) *and* `wasm32` (browser worker).
> **A gate that exercises a different build than the product ships is not a gate** — K3
> (browser-vs-CLI byte parity) is the check that keeps that honest.

Note what that sentence is really about: not "Rust is better", but **"the thing that is verified is
the thing that ships."** With CAD1/CAD1H now wired (§0.1), a TypeScript kernel is not unverified —
it is verified *as Node-imported TypeScript*, and shipped *as an esbuild bundle*. That is a smaller
gap than the doctrine's headline suggests, and it is not zero.

### 5.2 Arm A — TypeScript, in `web/src/cad/`

**What it costs to build**

- No wasm marshalling. `parseScad` → `meshScene` stays one process, one memory space, one language.
  The 2D kernel is a peer of the BSP kernel and shares its budget/issue machinery directly.
- The CAD tab stays **wasm-independent**. It is today: `CadTab.tsx:1-6` imports only `./scad`,
  `./mesh`, `./preview`, `./record`, `../store`. That matters more than it sounds — `App.tsx`
  has a fatal early-return when the CAM core fails to load, and the CAD tab currently survives it.
- Immediately measurable by CAD1/CAD1H, because the oracle imports the `.ts` directly.
- No new dependency, no lockfile change — *if* the kernel is re-derived, which §4.2 argues is the
  expensive path. If instead an npm polygon library is adopted, the lockfile changes and the arcs
  are gone.

**What it costs afterwards, permanently**

- 🔴 **Arcs die at the boundary.** No TypeScript option preserves them. Every circle, fillet and
  rounded corner leaving the CAD tab arrives at the CAM side as a polyline, and `G7`/`G10` exist
  because that floods the planner and stutters the finish. `core/Cargo.toml:14-18` chose a whole
  library on this basis.
- 🔴 **Two 2D kernels in one application.** The CAM side offsets with `cavalier_contours` at
  `POS_EQUAL_EPS = 1e-5`; the CAD side would offset with its own code at its own epsilon. A part
  can then be valid on one side of the seam and not the other, and *the seam is where the toolpath
  is planned*. This is the same shape as the `Contour::offset` sign-convention defect
  (`geometry.rs:17-22`) — two conventions, one flip, one place — except with no single place to
  put the flip.
- The kernel is not reachable from the CLI, so it cannot be driven by `2bee-slice`, cannot have a
  golden-file determinism check under `G1`, and cannot have a `--plant` on the CLI surface the way
  every other HARD gate's negative control does.

### 5.3 Arm B — the Rust core, in `core/src/`

**What it buys**

- `cavalier_contours` is already there. Arcs survive the boolean and the offset and reach the post
  as real `G2`/`G3`.
- **One kernel.** The region type is `Part { outer, inners }` — the type the DXF importer, the
  nester, the layout checker and the toolpath planner already speak (`core/src/geometry.rs:353`).
  `projection(cut = true)` is `core/src/mesh.rs:345` `section()`, which already exists, already has
  its three refusals, and already reports its unit assumption on every call.
- Gate-testable at the artefact, through the door a real caller uses: a `2bee-slice` subcommand,
  golden files under `G1` (determinism), a `--plant` negative control, `K3` covering the wasm
  fingerprint, and `I1` extended to cover the CAD path's browser-vs-CLI parity — which today it
  does not, because there is no CAD path through the core.
- The CAM side's own 2D operations (`pocket.rs`, `layout.rs`, `toolpath.rs`) get a region boolean
  they currently do not have, which is a real second consumer rather than a speculative one.

**What it costs**

- 🔴 **The CAD tab's evaluator is 4,058 lines of TypeScript** (`scad.ts` 2,405 + `mesh.ts` 1,653)
  and stays there. Only the *2D* subtree crosses to the core, so the evaluator has to marshal.
  Doing that per boolean node is chatty and slow; the workable shape is to **lower the whole 2D
  subtree to a small IR** — a flat list of `{op, operands, params}` over region handles — and
  evaluate it in **one** wasm call per 2D root. That IR is a new interface with its own version
  and its own drift risk, and it is real work, not a detail.
- 🔴 **The CAD tab becomes wasm-dependent.** Today it is not, and today the tab survives a core
  load failure that kills the rest of the app. After this it does not, and `App.tsx:3402-3406`'s
  fatal path — which `docs/audit/2026-08-10-licence-and-deps.md` §1.4 already flags for carrying no
  licence footer — becomes the CAD tab's failure mode too.
- 🔴 **CAD1 goes partially blind.** The oracle imports `web/src/cad/*.ts` under Node and compares
  against OpenSCAD. Move the 2D kernel into Rust and the oracle can no longer evaluate a
  `linear_extrude` case by importing TypeScript — it would need to load the wasm, or the harness
  would need a Node-side path to the core. **This is a control losing coverage as a side effect of
  a design change, which is exactly the class this lane keeps a register of.** It must be solved in
  the same change, not after: either the oracle gains a wasm path, or `2bee-slice` gains a
  `scad-eval` subcommand the oracle drives instead of importing TypeScript. The second is cleaner
  and is the one I would build.

### 5.4 Recommendation

**Arm B — the Rust core — for the 2D kernel and the extrusions. Recommended, not decided.**

Three reasons, in order of weight:

1. **Arcs.** This is not a style preference. `G7` and `G10` are HARD gates naming physical failures
   caused by polylined curves, and every TypeScript option destroys arcs at the boundary. A design
   that knowingly feeds the CAM side the input two of its own gates exist to reject is a design
   arguing with the gates.
2. **One region type.** `Part { outer, inners }` with a stated winding convention and a single
   `POS_EQUAL_EPS` already exists and is already what every downstream consumer speaks. A second
   one in TypeScript creates a seam at the precise point where a hole can become an island.
3. **The output gets cut.** The brief asks whether a kernel the gate harness cannot test is
   acceptable for geometry that gets cut. With §0.1's correction the honest answer is *"it can be
   tested, but only as source, and only against OpenSCAD — never against the post, the simulator or
   the controller"*. For a picture that would be enough. For a toolpath it is not.

⚠ **The cost of that recommendation, stated plainly so it is not discovered later:** it is the
**more expensive arm by roughly two to three weeks** (§8), it makes the CAD tab depend on the wasm
core, and it requires fixing CAD1's coverage in the same change. **Anyone choosing Arm A on
schedule grounds is making a defensible trade** — provided they write down that arcs are being
given up at the seam, and that the region type is duplicated, so the next person finds the decision
rather than the consequence.

**Whose decision:** the `2bee_app` lane owner, with the founder informed of the schedule difference,
because Tier 1 is weeks either way and the arms differ by weeks again. It is not a decision this
document should make silently by starting to write code on one side.

---

## 6. The seam to the CAM side

TODO #12 step 5: *"Hand geometry straight to the CNC tab. That is the entire point of one app."*

### 6.1 What exists today, and what it actually delivers

`web/src/cad/record.ts` writes a `2bee.cad model` record into the `drawings` collection — the list
the CNC tab picks parts from. It stores **both** the SCAD source (the truth) and an evaluated
**STL** (a cache), each with an FNV-1a checksum so a reader can tell when they have diverged, and
it refuses to save any model whose mesh audit did not return `closed`. That file's header is the
best statement of the trade-off in this lane and should be read before changing any of it.

The CNC tab then takes that STL through `plan_import_bytes` (`wasm/src/lib.rs:316`) with a
`z_section_mm`, and `core/src/mesh.rs:345` sections it — **one flat outline at one Z**.

🔴 **What that delivers, precisely:** the operator gets a *section*, not the part. `record.ts` and
`core/src/mesh.rs`'s headers both say the word *section* on every import for exactly this reason —
*"an operator imports a 3D part, expecting the shape they modelled, and receiving a flat slice
through it — which posts, simulates, gates green and cuts a plausible-looking wrong part."*

For the hive panels this is not merely lossy, it is **wrong in a way the operator cannot see**. A
`box_panel` is a slab with finger joints cut through it and a countersink pocket that does not go
through. A section at mid-height gives the fingers and the through-features; it **omits every
blind feature above or below that Z** and it gives no way to ask for the silhouette. The current
DXF chain uses `projection(cut = false)` — the silhouette — and that is a different answer from any
single section.

### 6.2 What the contract should be

**A `Region` — closed loops with arcs, an outer and its holes, in millimetres, with a stated
winding — plus the provenance of how it was derived from the solid.**

Concretely, three additions:

**(a) The geometry.** The core's own vocabulary, serialised:

```jsonc
{
  "kind": "2bee.cad region",
  "version": 1,
  "units": "mm",
  "parts": [{
    "name": "box_panel_front",
    // CCW for material, CW for holes — geometry.rs's convention, stated in the payload
    // and not assumed, because normalise_winding() exists precisely because callers get it wrong
    "outer": { "closed": true, "verts": [[x, y, bulge], ...] },
    "inners": [ { "closed": true, "verts": [...] }, ... ]
  }],
  ...
}
```

`bulge` is `tan(θ/4)` to the next vertex, `0` for a straight segment — `Vertex`
(`core/src/geometry.rs:28-44`) unchanged. **An arc that starts as an arc stays an arc all the way
to `G2`/`G3`.**

**(b) The derivation, always present.** This is the field that stops the failure `record.ts` and
`core/src/mesh.rs` are both built around:

```jsonc
"derivation": {
  "how": "projection_shadow" | "projection_cut" | "section" | "native_2d",
  "z_mm": 12.5,              // present for projection_cut and section, absent otherwise
  "note": "SILHOUETTE of the solid — the outline of its shadow on XY, not a slice. Blind
           features that do not reach the outline are NOT in this outline."
}
```

🔴 **`how` is not optional and has no default.** `"projection_shadow"` and `"section"` produce
outlines that are both real contours of the same real solid, that look equally plausible, and that
are different parts. The whole reason `core/src/mesh.rs` puts the word *section* and its Z into
every import note is that nothing downstream can tell them apart. A contract that lets `how` be
omitted re-opens that exact hole, one layer up.

**(c) The refusals and the audit verdict, carried.** `record.ts` already carries `unsupported`,
`issues`, `parse_errors` and a `complete` flag, and `describeCadRecord` puts them **above the
numbers** in the properties panel so they are read at selection time in the other tab. A region
record carries the same, plus the §3.3 verdict. **Only `simple` may be handed to the planner** —
the same rule `record.ts` applies to `closed`, for the same reason and with the same boundary: a
*refused construct* is not a refused save; an *unestablished region* is.

### 6.3 What changes on the CAM side

Less than it looks, because the destination type already exists.

| Change | Where | Size |
|---|---|---|
| A `format: "regions"` arm on the import path, taking the JSON above, producing `Vec<Part>` directly — no parse, no chaining, no unit guess | `core/src/import.rs` beside `parse_dxf` / `parse_svg` / `parse_bytes` (`:169`, `:375`, `:764`) | small — the output type is already `Imported`/`Vec<Part>` |
| A wasm entry point that takes it. 🔴 **Today there is none:** `plan_import` (`wasm/src/lib.rs:370`) takes text + `"dxf"`/`"svg"`; `plan_import_bytes` (`:316`) takes bytes + a format; `plan_import_many` (`:973`) takes a descriptor list + one concatenated blob. **Every door into the planner is a file.** | `wasm/src/lib.rs` | small–medium; `plan_import_many`'s byte-length invariant (`wasm/src/lib.rs:993-1003`) is the pattern to copy |
| `derivation.how` surfaced on the loaded-object line and in the job note, **always**, exactly as the STL section note is today | `core/src/mesh.rs`'s note pattern; the UI's loaded-object line | small, and non-negotiable |
| Nothing else | — | the planner, the offsetter, the nester, the layout checker and the post already consume `Part` |

⚠ **The alternative — emit DXF from the CAD tab — deserves naming and rejecting.** It reuses a path
that already exists and is already gated (`F1`, DXF/SVG intake) and it needs **no new wasm entry
point at all**. It loses on two counts: DXF is a lossy round-trip through a text format with no
unit declaration (`core/src/import.rs:19-22` reports the unit assumption for exactly this reason),
and it re-introduces the zero-length-closing-segment class that `hardware/cad/dxf_gate_check.py`
had to add a gate for. Handing a `Part` to a function that wants a `Part` by first serialising it
to DXF and parsing it back is a lossy identity function. **But it is a legitimate first cut** — see
§7 stage 3.

---

## 7. Staging — the smallest useful first cut

The target for "smallest useful" is the brief's: **one real `hardware/cad/*.scad` file produces a
cuttable outline.** §2.3 shows what that costs, so the stages below are ordered by what unblocks
that sentence, not by what completes Tier 1.

### Stage 0 — the enabling slice of Tier 5, and it comes first

**Nothing in Tier 1 helps until this lands**, because 10 of the 13 cut files stop at line 1.
Measured over the 68-file corpus and the 13 cut files:

| Construct | 68-file corpus | 13 cut files | Notes |
|---|---|---|---|
| `use <>` / `include <>` | 8 + 6 files | **10 + 3 files** | needs a virtual file system in the tab. The distinction (`include` runs top-level geometry and imports variables; `use` imports only modules and functions) is probed in `docs/openscad-feature-inventory.md:447` and is *"the part everyone implements wrongly first"* |
| user `function` definitions and calls | 16 files | 2 files (24 sites) | parser + evaluator, no geometry |
| `is_undef()` and the `is_*` predicates | **27 files** | 5 files | ~20 lines, and it is the single highest file-count blocker in the corpus |
| `let()` | 1 file | 3 files | already refused by name at `scad.ts:797` (statement form) and `:1119` (expression form) |
| `children()` / `$children` | 4 files | 1 file | a child-passing mechanism in the evaluator |

**Size: days, not weeks.** No kernel, no dependency, no geometry. `is_undef()` alone reaches 27 of
68 files. This stage is the highest measured value per hour available anywhere in TODO #12 and it
is independent of the §5 fork — it is evaluator work and lives in TypeScript either way.

### Stage 1 — the region type, its audit, and `projection(cut = true)`

The type from §1.1 with the six checks from §3.2 and the verdict from §3.3, plus the *easy* half of
`projection` — which on the Rust arm is `core/src/mesh.rs:345` `section()`, already written, and on
the TypeScript arm is a re-derivation of it.

**Deliverable:** a `.scad` file containing solids evaluates to a region, and the region is audited
and named. Still no boolean, no offset, no extrusion.

**Why this order:** the audit must exist before the producers do. Building the silhouette union
first and the audit afterwards means the first thing anyone sees is an outline nothing has checked,
which is the shape this lane keeps writing down.

**Negative control from day one:** a `--plant` that corrupts a region — reverse one loop's winding,
inject one self-intersection, insert one zero-length segment — and a check that each is caught and
named. Per `AGENTS.md:122-123`, this is what `--plant` is for and it is not optional on a HARD gate.

### Stage 2 — the booleans, offset, and `projection(cut = false)`

Region union / difference / intersection (§1.2), `offset()` (§1.3), and the silhouette (§1.7).
This is the bulk of the kernel work and where the §5 fork bites.

**The measurable question this stage must answer first, in a spike, before the rest is written:**
does a pairwise `cavalier_contours::boolean` sequenced over the ~2,000–10,000 projected triangles
of one real hive panel produce a correct silhouette in a browser-acceptable time? If yes,
`cavalier_contours` carries Tier 1. If no, `i_overlay` (§4.2) is the fallback for the union
specifically, and arcs are lost **for the silhouette only** — which is defensible, because a
projected triangle mesh has no arcs in it to begin with. **Answer that before committing weeks to
either.** It is a day's work and it is the difference between one library and two.

**Deliverable, and this is the first one that means anything to the founder:**
`2bee_hive_box_panel_wcnc.scad` evaluates, projects, and produces an outline that can be compared —
against OpenSCAD via the oracle, and against `hardware/cad/export/`'s existing DXF for the same
panel. **Two independent oracles for the same artefact**, which is better evidence than either.

### Stage 3 — the seam

Two ways, and taking the cheap one first is correct here.

**3a (cheap, days):** the CAD tab emits **DXF text** through the existing `plan_import(text,
"dxf")`. No new wasm export, no new contract, and `F1` (DXF/SVG intake) already covers the door.
It is lossy (§6.3) and it proves the whole chain end to end. **Do this one first**, and write down
in the code that it is a bridge.

**3b (the real one, ~a week):** the `Region` contract from §6.2 with a `format: "regions"` arm and
its wasm entry point, and `derivation.how` on the screen. Arcs survive. This is what makes the CAD
tab a real producer for the CAM tab rather than a DXF generator with extra steps.

### Stage 4 — `linear_extrude` and `rotate_extrude`

Last, deliberately, and this will read as wrong to anyone who took the tier's usual name at face
value. Measured: `linear_extrude` is in **2 of 13** cut files and **16 of 68** library files;
`rotate_extrude` is in 2 of 68 and none of the cut files. They are needed for the tab to be
honestly described as reading OpenSCAD, and they are **not** on the path from a hive panel to a
toolpath. Stages 0–3 deliver that path; Stage 4 delivers the language.

### Stage 5 — the gates

`CAD1`/`CAD1H` already exist and their baselines will move as stages land — that is the mechanism
working, and `CAD1H_BASELINE` ratcheting **down** is the evidence. Two additions:

- 🔴 **A `REFUSED → DIVERGES` transition on the hardware leg is a REGRESSION, and the gate already
  says so** in its own row: *"a REFUSAL is safe (nothing is emitted); a DIVERGENCE is a wrong part
  with no warning — so the tracked number is DIVERGES+ERROR, and REFUSED→DIVERGES counts as getting
  WORSE even though it looks like new capability."* Every stage above converts refusals into
  geometry. **Expect the gate to go red on progress, and do not treat that as the gate being
  wrong.** Each conversion has to be *shown* to be an agreement, not assumed to be one because the
  file now draws something.
- A new gate for the region audit itself — the §3.3 verdict, with the §3.2 plants as its negative
  controls, naming the physical failure: *a self-intersecting or mis-wound profile handed to the
  offsetter produces a toolpath that crosses itself, and every check downstream passes because
  every coordinate is a real coordinate.*

---

## 8. Size, honestly

The inventory's headline stands and this document does not soften it: **`2bee.cad` cannot be called
an OpenSCAD-alike today, Tier 0 did not change that, and Tier 1 will not change it either.** After
everything below, the tab will read a *larger* subset of OpenSCAD and will be able to hand a real
outline to the CAM side. That is a different and more useful claim than the one the tier's name
invites.

Estimates are **engineer-weeks of focused work**, with the ratio between them more reliable than
any absolute. They include the tests and the negative controls, because in this lane a gate without
a witnessed red is not a gate and shipping one is not "done".

| Stage | Arm B (Rust core) | Arm A (TypeScript) | Note |
|---|---:|---:|---|
| 0 — `use`/`include`, functions, `is_*`, `let`, `children` | **1–1.5 wk** | 1–1.5 wk | identical; evaluator work, no kernel |
| 1 — region type + the six checks + verdict + `projection(cut=true)` | **1.5–2 wk** | 2–2.5 wk | Rust reuses `Part`, `Contour`, `section()` |
| 2 — booleans, offset, silhouette union | **3–4 wk** | 4–6 wk | Rust reuses `cavalier_contours`; TS re-derives or adopts npm |
| — of which: the pairwise-vs-N-way spike | 0.2 wk | 0.2 wk | do this first; it can change stage 2 entirely |
| 3a — DXF bridge | **0.5 wk** | 0.5 wk | identical |
| 3b — `Region` contract + wasm entry + `derivation.how` on screen | **1 wk** | 1.5 wk | TS must also serialise a foreign region type |
| 4 — `linear_extrude` (twist/slices/scale) + `rotate_extrude` | **1.5–2 wk** | 1.5–2 wk | similar; the triangulator dominates |
| 5 — gates, plants, oracle corpus, baseline moves | **1 wk** | 1 wk | identical |
| **Arm-specific: the 2D IR + wasm marshalling seam** | **1.5–2 wk** | — | Arm B only |
| **Arm-specific: restoring CAD1 coverage (a `scad-eval` CLI subcommand for the oracle)** | **0.5–1 wk** | — | Arm B only; must land in the same change |
| **Arm-specific: nothing — arcs are simply lost** | — | **0** | Arm A's cost is permanent, not up-front |
| **TOTAL** | **~11.5–15.5 wk** | **~10.5–14 wk** | |

**Read that honestly, three ways:**

1. **Tier 1 is a quarter of engineering time, not a sprint.** The inventory said *"weeks, not
   days"* and *"the largest single item on this list"*; measured against the corpus and the seam,
   both are right and the number is at the top of what "weeks" usually means.
2. **The two arms are much closer in up-front cost than the doctrine suggests** — roughly a week
   apart, not a month. Arm B's marshalling and CAD1 costs very nearly cancel Arm A's kernel cost.
   **The recommendation in §5.4 therefore does not rest on schedule at all.** It rests on arcs, on
   one region type, and on the output being cut. Anyone arguing Arm A on schedule is arguing over
   about a week.
3. **Stage 0 alone is 1–1.5 weeks and moves 27 of 68 files off a single refusal.** If the founder
   wants the largest measurable movement for the smallest spend, it is Stage 0, and it can be
   funded on its own without committing to any of the rest.

⚠ **An optimistic number here is worse than a large one.** These estimates assume the spike in
Stage 2 comes back positive. If it does not, add 1–2 weeks for a second library, its licence check
on disk, and a second set of tolerance reconciliations between two kernels.

---

## 9. What this document does not settle

Named, because a limit nobody wrote down becomes a claim.

- **The §5 fork.** Recommended (Arm B), not decided. It is the lane owner's ruling with the founder
  informed of the schedule. This document does not start writing code on either side.
- **Whether `cavalier_contours`' pairwise boolean scales to the silhouette union.** The single
  highest-leverage unknown in Tier 1, and the cheapest to answer. **Settled by:** a one-day spike
  projecting one real hive panel's triangles and sequencing a union, measuring wall clock and
  correctness against OpenSCAD's own `projection(cut = false)` DXF for the same panel.
- **Whether `mesh.ts`'s BSP kernel is adequate as a consumer of extrusion output.** The inventory
  raised this (`:600-604`) and it is still open. All four boolean cases probed to date were built
  from our own primitives; extruded and imported operands are the inputs the kernel header names as
  its weakness. Not resolved here. **Settled by:** building the audit fixtures alongside Stage 4,
  not after it. And note that if the answer is "no", the `manifold` evaluation in §4.2 stops being
  a long-tail question.
- **Whether `legal` agrees with the permissive-into-AGPL framing** for any newly adopted crate. The
  licence audit flagged the same question for the existing 29 and it is not this document's to
  close. `cavalier_contours` is already in the tree and already in that audit, so adopting it more
  heavily raises no *new* question — adopting `i_overlay` would.
- **What identifier the AGPL §13 source offer must carry** once the CAD tab ships geometry that
  gets cut. `docs/audit/2026-08-10-licence-and-deps.md` §1.3 records that `BUILD_ID` fingerprints
  `core/src` **only** — it says nothing about `web/src`, which on Arm A is where the entire kernel
  would live. **A useful identifier for Arm B is a misleading one for Arm A**, and that is a
  consequence of the §5 fork that nothing else in this document reaches. → `legal`.
- **The unit and provenance question on a region handed between tabs.** §6.2 puts `units: "mm"` and
  `derivation` in the payload. Whether the CAM side should *refuse* a payload without them or
  assume mm is a decision with the same shape as the STL unit assumption, and it should be made
  deliberately rather than inherited.
