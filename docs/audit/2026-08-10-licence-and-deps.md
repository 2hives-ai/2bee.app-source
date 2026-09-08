# Licence obligations and dependency surface — audit, 2026-08-10

**Scope:** AGPL-3.0-or-later obligations of `software/2bee.app/`, the §13 network source
offer, the `LICENSE` file and per-file notices, every dependency in both trees, vendored /
copied material, the OrcaSlicer derivation claim, and supply-chain hygiene.

**Method:** read at the artefact. Rust licences resolved from the local cargo registry cache
(`~/.cargo/registry/src/*/<crate>-<ver>/Cargo.toml`), npm licences from
`web/package-lock.json` cross-checked against each installed `node_modules/<pkg>/package.json`
and, for the six runtime packages, against the actual `LICENSE` file on disk. The box **has**
network: `https://github.com` returned 200, so the URL findings below are measured, not
inferred. Nothing was fixed, nothing was committed, the gate was not run, the dev servers on
5178/5179 were not touched.

⚠ **I am not counsel.** Every legal characterisation below is flagged for `legal`, not decided
here. Items marked **→ legal** are questions, not conclusions.

---

## 0. Headline

| # | Finding | Severity |
|---|---|---|
| 1 | **The §13 source-offer link is a dead URL.** `https://github.com/2bee-farm/2bee.slicer` returns **404** anonymously *and* **404 to an authenticated token holding `repo` scope on our own org**. The repo does not exist. | 🔴 **BLOCKING for any serving** |
| 2 | **The only real repo is private.** `2hives-ai/2bee.farm` exists and reports `"private": true`. Even a corrected link would not, today, deliver Corresponding Source to a user. | 🔴 **→ legal** |
| 3 | **The offer does not identify the version served.** The footer prints `core 0.1.0` (a static `CARGO_PKG_VERSION` that has never moved) and links a bare repo root. `BUILD_ID` — an exact fingerprint of `core/src` — exists and is exported to the browser but is never displayed. | 🟠 |
| 4 | **Nothing watches any of it.** 40 gate ids exist; none covers licence, the footer, or dependency licensing. No e2e test asserts the footer. The one obligation `AGENTS.md:169` calls "a licence obligation, not a nice-to-have" is the lane's only wholly uncovered claim. | 🟠 |
| 5 | **No incompatible dependency found.** 29 Rust crates and 127 npm packages, every one resolved to a permissive licence (MIT / Apache-2.0 / BSD-3 / ISC / Unlicense / CC-BY-4.0 on one dev-only package). **No proprietary, SSPL, BUSL, CC-NC or unlicensed dependency anywhere.** Zero UNKNOWN. | ✅ |
| 6 | **Supply chain is clean.** No git-revision dep, no `*` wildcard, no dep from outside crates.io / registry.npmjs.org, no vendored third-party source. | ✅ |
| 7 | **The OrcaSlicer derivation is narrower than the claim reads.** The one file that names a port source — `core/src/post_grblhal.rs:3` — was ported from `PostGrblHAL.cpp`, and that C++ file was **written by `2bee.farm`** (added 2026-08-07, author `2bee.farm`), not by OrcaSlicer upstream. No upstream OrcaSlicer/Slic3r code was found in this tree. | 🟠 **→ legal** |

**Is the §13 obligation currently met?** **No — but it has not yet been triggered.** See §1.

---

## 1. §13 — the network source offer

### 1.1 What state we are actually in: **not served over a network**

Three listeners exist and **all three are bound to loopback only** (`ss -ltnp`, read-only,
2026-08-10):

```
127.0.0.1:5178   node   (dev server — founder's, untouched)
127.0.0.1:5179   node   (dev server)
127.0.0.1:4173   node   (vite preview of web/dist)
```

`127.0.0.1` is not reachable from any other host. There is **no deployment**: no S3/CloudFront/
Pages target anywhere in `README.md`, `AGENTS.md` or `web/vite.config.ts`, and a repo-wide grep
of `software/backend/` + `facts/` for `2bee.app` returns nothing.

⚠ **One canon fact has moved and should be recorded.** Root `CLAUDE.md` states, verified at RDAP
on 2026-08-08, that `2bee.app` is *"registered, status `inactive` = no nameservers delegated;
`dig NS` empty"*. **Measured today, `dig +short NS 2bee.app` returns four Route 53 nameservers**
(`ns-663.awsdns-18.net`, `ns-1950.awsdns-51.co.uk`, `ns-1089.awsdns-08.org`,
`ns-243.awsdns-30.com`). `dig +short A 2bee.app` is still **empty** — delegated, not serving.
The canon claim was true when written and is now stale in one limb; the operative conclusion
(**not served**) is unchanged. That is a note for `ceo`, not a finding against this lane.

> 🔴 **SUPERSEDED 2026-08-12 (2bee_app) — THE PARAGRAPH ABOVE IS LEFT AS WRITTEN because it is a
> dated measurement, and this is what is true now.** The delegation has **moved off Route 53**, and
> `dig +short A 2bee.app` is no longer *empty* — it fails.
>
> **Method, today, on this box:** `dig @<r> A 2bee.app` and `dig @<r> NS 2bee.app` for
> `r ∈ {1.1.1.1, 8.8.8.8, 9.9.9.9}` → **`status: SERVFAIL` on all six queries, 0 answers**.
> `dig +trace A 2bee.app` → the `.app` registry (`ns-tld1.charlestonroadregistry.com`) hands out
> **`christina.ns.cloudflare.com` / `rex.ns.cloudflare.com`** — **the same pair that serves
> `2bee.farm`** (control: `dig +short NS 2bee.farm` returns exactly those two). Querying that pair
> **directly** for `2bee.app` returns **`status: REFUSED`, no `aa` flag**, while the same servers
> answer `2bee.farm` **authoritatively** (`aa`, 4 A records). ⇒ **the name is delegated to
> nameservers that do not host the zone** — the zone is not in the Cloudflare account — so
> resolution dies at the authority rather than returning an absence.
>
> ⚠ **Why the distinction is worth a correction and not a silent edit: `empty answer` and
> `SERVFAIL` are different facts and only one of them is evidence.** A NOERROR/NODATA answer is the
> zone saying *"no such record"*; SERVFAIL is *"nobody could tell you"* — a resolver failure is not
> proof that a record is absent, and a check keyed on "the answer list is empty" reads the two as
> identical. The AGPL gate in `gates/slicer_gate_check.mjs` now measures this the careful way and
> reports it as *"DNS indefinite on every voting resolver"* rather than as an absence.
>
> ✅ **The operative conclusion of §7.1 and of finding #1 is UNCHANGED: `2bee.app` is not served,
> so §13 has not attached.** What changed is only the *shape* of the not-serving — and the shape
> matters, because the delegation moving to the live `2bee.farm` nameserver pair is the cheap half
> of the asymmetry this lane's AGPL gate exists to interrupt: publishing is now one zone-add and one
> record away, while the source offer is still a `legal` decision nobody has made.

⇒ **Today, §13 has no addressee.** The moment the first non-loopback listener appears — a
`--host` flag on the dev server, an S3 bucket, a laptop demo on a shop LAN — the offer becomes
live and is, as shipped, broken.

### 1.2 The offer exists in the UI, and it is dead

`web/src/App.tsx:4474-4485`:

```tsx
<footer className="foot">
  <span>core {ver.core} · G-code contract {ver.gcode_contract}</span>
  <span>
    AGPL-3.0-or-later ·{' '}
    <a href="https://github.com/2bee-farm/2bee.slicer" rel="noreferrer">source</a>
  </span>
  ...
```

Styled deliberately at `web/src/styles.css:410-417` ("*The AGPL §13 source offer lives in this
footer. It is a licence obligation, so it is held to the same AA bar as any other text*"). The
intent is real and the placement is right. The URL is not.

**Measured, three ways:**

| Probe | Result |
|---|---|
| `curl -I https://github.com/2bee-farm/2bee.slicer` (anonymous) | **404** |
| `gh api repos/2bee-farm/2bee.slicer` (token: `gbacskai`, scopes `repo, read:org, gist, workflow`) | **404 Not Found** |
| `gh api repos/2hives-ai/2bee.farm` (the actual remote) | **200**, `"private": true`, `license: null` |
| `curl -I https://github.com` (control) | **200** — the box is online, so the 404s are real |

An authenticated token that can see our own private monorepo still gets 404 on
`2bee-farm/2bee.slicer`. **The repo does not exist.** The org name is wrong (`2bee-farm` vs
`2hives-ai`), the repo name is wrong (`2bee.slicer` vs `2bee.farm`), and the lane was renamed to
`2bee.app` on 2026-08-09 (`AGENTS.md:9-11`) without this link moving.

**The same dead URL is in the crate metadata** — `Cargo.toml:9`
`repository = "https://github.com/2bee-farm/2bee.slicer"` — which would be published verbatim
if any of these crates ever went to crates.io.

**And it is already baked into a built artefact.** `web/dist/assets/index-CAOoc7K_.js` (built
2026-08-10 17:49) contains exactly one github URL: `github.com/2bee-farm/2bee.slicer`. The
`AGPL-3.0-or-later` string ships; the full licence text does **not** (`grep -c "GNU AFFERO"` on
the bundle = 0).

### 1.3 The offer cannot identify the version it is offered for

The footer prints `core {ver.core}` from `wasm/src/lib.rs:21-27`, which returns
`env!("CARGO_PKG_VERSION")` — **`0.1.0`, workspace-wide, and it has never moved**
(`Cargo.toml:6`). A user who followed a working link would land on a repo root with no way to
know which commit produced the WASM in their browser.

**The exact thing needed already exists and is not wired to the screen.** `wasm/src/lib.rs:39`
exports `build_id()` → `twobee_cam::BUILD_ID`, a 12-hex fingerprint of every `.rs` under
`core/src`, baked in by `core/build.rs` and already compared across hosts by gate K3. `grep -rn
"build_id" web/src/` finds it **only inside the generated glue** (`web/src/wasm/twobee_cam_wasm.js:180`)
— no application code calls it. The footer could name the served build in one line and does not.

⚠ Note the shape: `BUILD_ID` fingerprints `core/src` **only**. It says nothing about `web/src`,
`wasm/src` or `cli/src`, so it identifies the engine, not the whole Corresponding Source. Useful,
not sufficient. → **legal** should say what identifier the offer needs; this lane should not guess.

### 1.4 One state of the served app carries no offer at all

`web/src/App.tsx:1961-1968` — when the CAM core fails to load, the component returns early:

```tsx
if (loadError) {
  return (
    <div className="fatal" data-testid="fatal">
      <h1>The CAM core did not load</h1>
      ...
```

No footer, so **no licence line and no source link**, in a state where the JS bundle has already
been delivered to the user. Small, real, and one line to fix.

### 1.5 Nothing checks any of this

`gates/slicer_gate_check.mjs` registers 40 ids —
`B2 B4 BRND C6 CTRL DINV DOC F1 FLAG G0…G14 I1 K3 LEAD MARK MOVE P1…P9 PLANT REL RPRB SPEC TECH` —
and a grep for `licen|agpl|dependenc|npm audit|cargo deny` across the whole gate file returns
**nothing**. `web/e2e/*.ts` never mentions the footer, and the footer element carries no
`data-testid`.

This is the lane's own recurring shape, stated in its own words at `AGENTS.md:199-203`: *"a
stated caveat reads as a handled one."* `AGENTS.md:169` and `README.md:5-9` both assert the §13
link as an owned obligation; both assertions have been true-in-intent and false-in-fact for as
long as the link has been wrong, and no control could ever have said so.

---

## 2. `LICENSE` and per-file notices

### 2.1 The licence file is correct

`LICENSE`, 661 lines, `sha256 57c8ff33…99d6`. Verified against the canonical text fetched from
`https://www.gnu.org/licenses/agpl-3.0.txt` today: **identical apart from three `http://` →
`https://` URL changes** the FSF made to its own published rendering (line 4 fsf.org, line 646
and 661 gnu.org). It carries §13 *Remote Network Interaction* at line 540 and the *How to Apply
These Terms* appendix at line 621. **Verbatim AGPL-3.0 — correct.**

⚠ Provenance, for the record: the file is **byte-identical (same sha256)** to
`/home/gbacs/build/OrcaSlicer/LICENSE.txt`. It was copied from the fork tree. For a licence text
that is the right thing to do — it must be verbatim — so this is a note, not a defect.

### 2.2 `-or-later` is declared consistently

- `Cargo.toml:8` — `license = "AGPL-3.0-or-later"`, inherited by all three members
  (`core/Cargo.toml:6`, `cli/Cargo.toml:6`, `wasm/Cargo.toml:6` all `license.workspace = true`).
- `README.md:5` and `AGENTS.md:4,183`.
- `core/src/lib.rs:3-4` — *"Copyright (C) 2026 2BEE FARM PTY LTD. Licensed under the GNU Affero
  General Public License v3 or later."*

### 2.3 Per-file notices are the thin spot

**6 of 51 tracked source files** (`*.rs *.ts *.tsx *.mjs *.py *.css`) carry a copyright or
licence line: `core/src/lib.rs`, `core/src/optimise.rs`, `core/src/post_grblhal.rs`,
`web/src/toolShape.tsx`, `web/src/touchplateShape.tsx`, `web/src/workholdingShape.tsx` — and
three of those six only mention AGPL while reasoning about *image* licensing, not as a file
notice. `cli/src/main.rs`, `wasm/src/lib.rs`, `web/src/App.tsx` and the other 42 carry none.

The AGPL appendix ("How to Apply These Terms", `LICENSE:621`) asks for a notice per file. There
is a single top-level `LICENSE`, a declared SPDX id in every manifest and a notice in the crate
root — whether that satisfies the appendix is **→ legal**. No SPDX identifiers
(`// SPDX-License-Identifier: AGPL-3.0-or-later`) are used anywhere; adding them would be one
mechanical pass and would make a gate trivial to write.

**`web/package.json` has no `license` field at all** (it is `"private": true`, so npm does not
warn). Every other manifest in the lane declares AGPL; this one is silent.

---

## 3. Every dependency, both trees

### 3.1 Rust — 29 locked packages, all permissive, no UNKNOWN

Resolved from `Cargo.lock` and read out of the local registry cache. Every non-workspace entry
is `source = "registry+https://github.com/rust-lang/crates.io-index"`.

| Crate | Ver | Licence | Note |
|---|---|---|---|
| `cavalier_contours` | 0.7.0 | **MIT OR Apache-2.0** | the offsetting engine — see §4.2 |
| `static_aabb2d_index` | 2.0.0 | MIT OR Apache-2.0 | transitive of the above |
| `serde` / `serde_core` / `serde_derive` | 1.0.229 | MIT OR Apache-2.0 | |
| `serde_json` | 1.0.151 | MIT OR Apache-2.0 | |
| `wasm-bindgen` (+ `-backend`, `-macro`, `-macro-support`, `-shared`) | 0.2.100 | MIT OR Apache-2.0 | exact-pinned |
| `syn` | 2.0.119 **and** 3.0.3 | MIT OR Apache-2.0 | two majors in one graph |
| `proc-macro2` 1.0.107 · `quote` 1.0.47 · `unicode-ident` 1.0.24 | | MIT OR Apache-2.0 (`unicode-ident`: `(MIT OR Apache-2.0) AND Unicode-3.0`) | |
| `num-traits` 0.2.19 · `autocfg` 1.5.1 · `cfg-if` 1.0.4 · `once_cell` 1.21.4 · `log` 0.4.33 · `itoa` 1.0.18 · `bumpalo` 3.20.3 · `rustversion` 1.0.23 | | MIT OR Apache-2.0 | |
| `memchr` | 2.8.3 | **Unlicense OR MIT** | dual, MIT limb available |
| `zmij` | 1.0.23 | MIT | |
| `twobee-cam`, `twobee-cam-wasm`, `twobee-slice` | 0.1.0 | AGPL-3.0-or-later | ours |

**No copyleft, no proprietary, no SSPL/BUSL, no "no licence field", no UNKNOWN.** Every one is a
permissive licence that is one-way compatible with AGPL-3.0 in the ordinary understanding
(**→ legal** to confirm the framing; `unicode-ident`'s `AND Unicode-3.0` limb in particular).

### 3.2 npm — 127 packages, all permissive, no UNKNOWN

Every entry in `web/package-lock.json` has a `resolved` field and **all 127 point at
`https://registry.npmjs.org/`**. Licence histogram:

```
114  MIT
  5  Apache-2.0     @playwright/test, playwright, playwright-core, typescript, baseline-browser-mapping   (all dev)
  5  ISC            electron-to-chromium, lru-cache, picocolors, semver, yallist                          (all dev)
  2  BSD-3-Clause   @webgpu/types, source-map-js                                                           (all dev)
  1  CC-BY-4.0      caniuse-lite@1.0.30001809                                                              (dev)
```

**The six packages that actually ship to a browser are all MIT**, and their MIT text was verified
**on disk**, not just declared: `react` 18.3.1, `react-dom` 18.3.1, `three` 0.170.0,
`scheduler` 0.23.2, `js-tokens` 4.0.0, `loose-envify` 1.4.0 — each has a real `LICENSE` file
(Facebook / three.js authors / Andres Suarez).

**Attribution survives the build**, which is the part that would ordinarily be missed:
`web/dist/assets/index-CAOoc7K_.js` contains 5 `Copyright` occurrences and `@license` banners —
`Copyright (c) Facebook, Inc. and its affiliates` (React ×4) and
`Copyright 2010-2024 Three.js Authors`. esbuild preserved the legal comments. MIT's notice
requirement is met in the shipped bundle.

⚠ **One flag, not a block: `caniuse-lite` is CC-BY-4.0.** A content licence on a data package.
It is **dev-only** (pulled in by `browserslist` ← `@babel/…` ← `@vitejs/plugin-react`) and its
data does not reach `web/dist`. CC-BY-4.0's interaction with GPL-family copyleft is a known
grey area and I am not resolving it. **→ legal**, low urgency, with the mitigating facts that it
is dev-only and not distributed.

⚠ **Honest caveat on method:** for the 121 dev packages the licence is the **declared SPDX id**
read from the lockfile / installed `package.json`, not a diff of each package's LICENSE text
against its declaration. That is the standard basis for this kind of audit and it is what tools
like `license-checker` do; it is stated here because "declared MIT" and "verified MIT" are
different claims and only the six runtime packages got the second.

### 3.3 Version-pinning drift worth noting

`web/package.json` uses caret ranges throughout; the lock has drifted well past them —
`@playwright/test ^1.47.0 → 1.62.1`, `typescript ^5.6.3 → 5.9.3`, `vite ^5.4.11 → 5.4.x`,
`@vitejs/plugin-react ^4.3.4 → 4.7.0`. The lock is the real pin, which is fine, but it means
**a fresh `npm install` on another box resolves a different licence surface than the one audited
here.** A licence gate that reads the lock would inherit that; one that reads `package.json`
would be checking nothing.

`@rolldown/pluginutils@1.0.0-beta.27` (MIT) rides in via `@vitejs/plugin-react` — a **beta**
transitive dev dependency. Hygiene note only.

---

## 4. Vendored / copied material

Full sweep of every tracked non-source file, plus a grep for third-party copyright lines across
all 51 source files. **The only `Copyright` lines in this lane's own source are
`2026 2BEE FARM PTY LTD`.** No third-party code or asset was found without provenance.

| Item | Provenance | Recorded where | Watched? |
|---|---|---|---|
| `web/src/assets/2bee-farm-mark-{mono-black,reversed-white}.svg` | copies of `brand/brand-kit/logos/*` | in-file header + `Source sha256:` | ✅ gate **BRND**, `gates/slicer_gate_check.mjs:3930-4010` |
| `web/src/samples/{hive-super-end,hive-box-prototype,metal-nest-a1}.dxf` | copies from `hardware/cad/` | `web/src/samples/index.ts:9-16` | 🔴 no |
| `web/src/samples/{schools-kit-solar,marker-triangle,entrance-tray-plate}.stl` | copies from `hardware/cad/stl/fleet/` | `web/src/samples/index.ts` (mesh block) | 🔴 no |
| `web/src/samples/hive-super-end.stl` | **generated**, OpenSCAD render of `hardware/cad/2bee_hive/…_wcnc.scad` | same block | 🔴 no |
| `gates/fixtures/{plate,overlap,spline}.dxf`, `plate.svg` | hand-authored synthetic (34–59 lines each; the SVG is four circles and a rect) | self-evident | n/a |
| `web/src/wasm/twobee_cam_wasm{.js,_bg.wasm}` | wasm-bindgen output, committed | the `wasm` script in `web/package.json:12` | ✅ gate K3 (build id) |

**Licence-wise all of it is ours** — `cad`'s files and `brand`'s files are 2BEE FARM PTY LTD
property, so no third-party term rides in. **The BRND hashes were re-checked by hand today and
both MATCH** their masters (`838c8853852a`, `f6505e373e76`).

The samples' un-watched status is a **staleness** gap, not a licensing one, and
`web/src/samples/index.ts` already names it as such and names the fix ("record the source sha256
and re-compare in a gate. Not built."). Recorded here for completeness; it is not a §3-family
finding.

### 4.1 One thing that IS a licence question, and is not recorded anywhere

The two brand marks are **2bee.farm's trademarks**, shipped inside a program the lane offers
under AGPL-3.0-or-later. Anyone who accepts the §13 offer receives the logo files under those
terms. AGPL §7(e) contemplates trademark restrictions as an additional term, and the copies'
own header says *"Owner: the `brand` session. This lane does not edit the source"* — which is an
internal ownership statement, not a licence grant to a downstream recipient. **→ legal + brand.**
No conclusion offered.

### 4.2 `cavalier_contours` — checked as asked

`core/Cargo.toml:20` `cavalier_contours = "0.7"`, locked at 0.7.0 from crates.io.
**Licence: `MIT OR Apache-2.0`**, read from
`~/.cargo/registry/src/*/cavalier_contours-0.7.0/Cargo.toml`. (That crate directory ships no
`LICENSE-*` files of its own; its transitive `static_aabb2d_index-2.0.0` does, and both declare
the same dual licence.) A dual MIT/Apache-2.0 permissive crate linked into an AGPL binary is the
ordinary, well-trodden direction. **No compatibility problem found.** The choice is a documented
decision at `core/Cargo.toml:10-18` and the reasoning is technical (arc preservation vs Clipper's
scaled-integer polygons), not licensing.

⚠ Note for the record: `cavalier_contours` 0.7.0 shipping **no licence text file in the published
crate** means a distribution that reproduces the crate would have only the SPDX declaration to
attribute from. Minor, upstream's issue, mentioned so it is not discovered later as a surprise.

---

## 5. The OrcaSlicer derivation claim

**Claim under audit** — `AGENTS.md:183`, `README.md:6-7`, `core/src/lib.rs:5-6`:
*"Derived in part from the 2bee CNC fork of OrcaSlicer, itself AGPL"* / *"Portions derived from
the 2bee CNC fork of OrcaSlicer (AGPL-3.0), itself derived from PrusaSlicer/Slic3r."*

### 5.1 What is actually in this tree

**No OrcaSlicer, PrusaSlicer or Slic3r source code is present in `software/2bee.app/`.** Every
mention (`README.md:7,249`, `AGENTS.md:58,183`, `SLICER-GATES.md:198`, `core/src/tech.rs:10`,
`FUNCTIONAL-SPEC.md:159`) is prose *about* the fork. Exactly one file names a port source:

`core/src/post_grblhal.rs:3-5`
> *"Ported from the 2bee OrcaSlicer CNC fork (`src/libslic3r/CNC/PostGrblHAL.cpp`, AGPL-3.0)."*

**That port is real and it is line-level, not conceptual.** The C++ ancestor exists at
`/home/gbacs/build/OrcaSlicer/src/libslic3r/CNC/PostGrblHAL.cpp` (315 lines) and the Rust
carries its structure and its magic numbers across verbatim:

| C++ (`PostGrblHAL.cpp`) | Rust (`core/src/post_grblhal.rs`) |
|---|---|
| `if (std::fabs(v) < 5e-7) v = 0.0;` | `:55` `let v = if v.abs() < 5e-7 { 0.0 } else { v };` |
| `bool near_eq(a,b) { fabs(a-b) < 1e-6; }` | `:59-61` same name, same epsilon |
| `check_machine_limits(path, machine)` | `:133` same name, same signature shape |
| `"move outside " << axis << " travel: "…"(allowed "…" .. "…")"` | `:157` `"move outside {axis} travel: {got} (allowed {lo} .. {hi})"` — identical string |

### 5.2 Who wrote the ancestor — and this is the part that changes the claim

`git log` in `/home/gbacs/build/OrcaSlicer`:

- The whole `src/libslic3r/CNC/` directory was **ADDED** by commits `4c434520` and `1d5a4931`,
  both **authored `2bee.farm`, dated 2026-08-07**.
- Every commit touching that directory is authored `2bee.farm`.
- `PostGrblHAL.cpp` opens `///|/ 2bee.farm CNC extension for OrcaSlicer`.
- `PostGrblHAL.{cpp,hpp}` include only `CNCTypes.hpp`, which in turn includes libslic3r's
  `../ExPolygon.hpp` and `../Point.hpp`. (Its siblings go further: `CNCModel.cpp` and
  `CNCToolpath.cpp` include `../ClipperUtils.hpp`, `../TriangleMeshSlicer.hpp`, `../libslic3r.h`.
  **Nothing from those siblings was ported here** — the Rust does its own sectioning in
  `core/src/mesh.rs`, which carries no derivation note, and its own offsetting via
  `cavalier_contours`.)

⇒ **The port source is our own code that lived inside an AGPL tree, not OrcaSlicer's code.**
Whether the C++ extension is itself a derivative work of libslic3r (it compiled against
libslic3r headers and types) and whether that property travels through a clean-room-adjacent
re-implementation in a different language is **precisely a legal question**, and I am not
answering it. → **legal.**

### 5.3 Two facts `legal` will want and would not otherwise be told

1. **The fork is not published and is not in this repo.** It lives at
   `/home/gbacs/build/OrcaSlicer` on this box, its only git remote is upstream
   `https://github.com/OrcaSlicer/OrcaSlicer.git`, and the 2bee CNC commits exist **locally
   only**. So the "2bee CNC fork" that `core/src/lib.rs:5` cites as the origin of our code is an
   artefact **no third party can obtain**, and a §13 recipient asking for the lineage would find
   nothing. (`README.md:249` records that a C++→Emscripten port of the fork was *rejected*, so
   the fork was never a shipping component — but the derivation sentence reads as if it were.)
2. **The claim as written is broader than what is in the tree.** "Derived in part from … itself
   derived from PrusaSlicer/Slic3r" invites a reader to assume upstream GPL/AGPL code is present.
   None was found. If the true relationship is *"a re-implementation of our own C++ extension,
   which was written against an AGPL codebase"*, that is a different fact with different
   obligations — and it should be `legal` who decides the wording, not this lane. **Do not edit
   the notice on the strength of this audit alone**: weakening a licence notice is exactly the
   kind of change that must not be made by whoever benefits from it.

---

## 6. Supply-chain hygiene

| Check | Result |
|---|---|
| Git-revision dependency (`git = …`, `rev = …`) | **none**, either tree |
| Wildcard version (`*`) | **none** |
| Path dependency outside the workspace | **none** — only `twobee-cam = { path = "../core" }` |
| Alternative / private registry | **none** — 29/29 crates from crates.io, 127/127 npm from registry.npmjs.org |
| Tarball or URL dependency in `package-lock.json` | **none**; every entry has a `resolved` |
| Exact pins | `wasm-bindgen = "=0.2.100"` (`wasm/Cargo.toml:17`) — deliberate, correct for the ABI-coupled glue |
| Loose pins | `wasm/Cargo.toml:18-19` `serde = { version = "1" }` / `serde_json = "1"` — broad but not wildcards, and `Cargo.lock` is committed. `core/Cargo.toml:21-22` pins the same crates to `1.0.229` / `1.0.151`, so the two members disagree in tightness for no stated reason. Cosmetic. |
| `Cargo.lock` committed | ✅ |
| `package-lock.json` committed | ✅ |
| Automated licence/vuln check (`cargo-deny`, `npm audit`, `license-checker`) in any gate or CI | **none.** GitHub Actions were removed fleet-wide 2026-07-24, so there is no CI leg either. |

---

## 7. What should go to `legal`

1. **Is the §13 obligation live at all today?** The app is served to `127.0.0.1` only, with no
   deployment and no A record on `2bee.app`. <sup>🔴 **SUPERSEDED 2026-08-12** — *"no A record"* was
   right in its conclusion and wrong in its evidence: there is no A record **and there is also no
   answer**. All three public resolvers now return **SERVFAIL**, because the name is delegated to
   `christina`/`rex.ns.cloudflare.com` (the pair serving `2bee.farm`) and **those servers REFUSE the
   zone**. See the superseded block in §1 for the full method. **The question below is unaffected —
   nothing is served either way.**</sup> Separately: does *conveying* the JS+WASM bundle to a
   browser (§4/§6) trigger a source-offer obligation independently of §13's server limb? That
   answer determines whether finding #1 is "fix before deploying" or "already breached the first
   time a colleague opened it over a LAN".
2. **The Corresponding Source is in a private repo.** `2hives-ai/2bee.farm` is `private: true`
   and holds this lane inside a monorepo of unrelated proprietary material. What is the intended
   mechanism — a public mirror of `software/2bee.app/` only, a source tarball served alongside the
   app, or something else? This lane cannot choose that and should not guess. It is also the
   **only** finding here that cannot be fixed by editing a string.
3. **The OrcaSlicer derivation wording** (§5). Facts supplied above; the characterisation and any
   change to `core/src/lib.rs:5-6` / `AGENTS.md:183` / `README.md:6-7` is legal's call.
4. **Trademark vs AGPL on the shipped brand marks** (§4.1) — with `brand`.
5. **`caniuse-lite` CC-BY-4.0** (§3.2) — dev-only, not distributed, flagged for completeness.
6. **Per-file notices** (§2.3) — 6 of 51 files; is the top-level `LICENSE` + manifest SPDX +
   crate-root notice sufficient, or should an SPDX header pass be run?

## 8. What this lane can fix without legal (recorded, not done — this audit edits nothing)

- The footer URL and `Cargo.toml:9`, once legal has named the correct public location.
- Show `build_id()` (already exported, `wasm/src/lib.rs:39`) next to the source link so the offer
  names the build it is offered for.
- Render the footer, or at minimum the licence line, in the `loadError` branch
  (`web/src/App.tsx:1961`).
- Add `license` to `web/package.json`.
- **A gate.** The obligation currently has zero mechanical coverage while `AGENTS.md:169` asserts
  ownership of it. The honest minimum is a check that (a) the footer link is present and
  non-empty in the built bundle, (b) it matches a value declared in one place, and (c) *fails*,
  not passes, when it cannot verify the URL resolves — a licence gate that silently skips its
  network leg would be the exact "green that means unchecked" this lane's own rules forbid, so
  the offline case must report **PENDING**, never PASS.

---

*Audited 2026-08-10. Nothing in this lane was modified; no commit was made; the gate was not run;
the dev servers on 5178/5179 were not touched. Network probes were read-only GET/HEAD to
github.com, gnu.org and DNS.*
