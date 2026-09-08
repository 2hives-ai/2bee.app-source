# Every user-facing string against the terminology canon

**A read-only audit. Nothing in this pass changed a line outside `docs/`.** The canon audited
against is [`docs/terminology.md`](../terminology.md). Findings are **reported and routed**, not
fixed — the owning session writes its own copy.

---

## 0. What I measured, and against which bytes

🔴 **Five agents are live in this tree and it moved under me three times while I read it.**
`web/src/App.tsx` grew from 498,090 → 501,613 → 510,292 bytes inside forty minutes;
`web/src/machineSelection.ts` was deleted and `web/src/savedSelection.ts` appeared between two runs
of the same scanner. My first scan's line numbers were already wrong by the time I checked them.

So this audit was run against a **frozen copy** — 152 source files copied out of the lane at
`2026-08-11T13:48:33+10:00`, hashed, and never re-read from the live tree afterwards.

| Artefact | Identity |
|---|---|
| Repo HEAD at snapshot | `1bd54fcb017c5f0f73849afc8a217bc7446230be` (branch `hw-naming-cleanup-placement-audit`) |
| Snapshot taken | `2026-08-11T13:48:33+10:00` — **working tree, uncommitted changes included** |
| `web/src/App.tsx` | sha256 `04170e9cefc1170a…` · 510,292 B · 9,731 lines |
| `web/src/Viewport.tsx` | sha256 `30e272b2870a5eb7…` · 317,800 B · 6,353 lines |
| `web/src/workholding.ts` | sha256 `b5a59d9d3c076e8f…` · 37,610 B · 695 lines |
| `web/src/workholdingShape.tsx` | sha256 `341ce6ccf31b4c9b…` · 36,103 B · 897 lines |
| `web/src/touchplates.ts` | sha256 `ebee3da4702b7876…` · 36,788 B · 756 lines |
| `web/src/touchplateShape.tsx` | sha256 `05e32d56d474a0c4…` · 38,226 B · 861 lines |
| `core/src/sim.rs` | sha256 `571d37ae037e2140…` · 108,004 B · 2,194 lines |
| `docs/terminology.md` | sha256 `3689d8e25cd09a0d…` · 35,294 B · 539 lines |

⚠ **Every line number below is a line number IN THAT SNAPSHOT, and `App.tsx`'s were stale within
ten minutes** — I re-checked one finding at the end of the pass and it had moved 72 lines. **Find
each finding by its quoted text, not by its line number.** The text is quoted in full for exactly
this reason.

---

## 1. Method, and the tool that produced every number

**Tool: a hand-written character-level state machine in Python** (`termscan.py` /`scan2.py`, in the
session scratchpad; ~200 lines, no dependencies). It segments each file into
**CODE / COMMENT / STRING / JSXTEXT** spans and matches the needles **only inside
COMMENT, STRING, JSXTEXT and Markdown** spans. Pure-code occurrences — `sheet_id`, `below_sheet`,
`panel-stock`, `--sheet-x` as a parsed token — are dropped by construction, per canon §0.

Eleven needles, each as a **whole word or hyphen-joined** form, never a substring
(so `spreadsheet` and `stock_thickness` do not match):

```
sheet  bed  table  |  stock  board  fixture  workholding  bit  blank  waste board  sacrificial sheet
```

Three surfaces were checked **at runtime as well as at the source**, because a source scan cannot
tell you what actually prints:

* **the emitted G-code** — all four `fixture` targets and all six `job` targets;
* **the CLI's human-readable output** — `usage`, `report`, `job`, `recommend`, `fit`, `route`,
  `layout`, `import`;
* **the gate table** — `node gates/slicer_gate_check.mjs --list`.

### 1a. 🔴 Hazard 1 — grep does not skip `App.tsx` because it is big. It skips it because of ONE NUL BYTE.

The brief warned that `grep` silently skipped `web/src/App.tsx`. **It still does, and the reason
matters more than the fact**, because the stated reason ("490 KB, very long lines") would send the
next person to the wrong fix.

Reproduced this pass:

```
$ grep -c "sheet" web/src/App.tsx        →  (no output, exit 1)
$ python3 -c "print(open(...).read().count('sheet'))"  →  100
$ grep -rc "sheet" web/src --include=*.tsx   →  35 files listed, App.tsx NOT among them
```

`App.tsx` is **not** the file with the longest lines in this lane (longest line 238 chars;
`Viewport.tsx` has 420). It contains **exactly one 0x00 byte, at line 3252**, written as a literal
NUL inside a string:

```ts
const drawingInstanceKey = drawingInstanceIds.join('<NUL>');
```

The `grep` on this box is a shell function wrapping **ugrep 7.5.0 with `-I`** (ignore binary). One
NUL makes the whole file binary, so `-I` **drops it with no message, no error and no row in a
recursive listing**. `grep -a` restores it (95 matching lines). This is a
*safe-by-absence* failure: the file that matters most in this lane is the one file every
binary-aware tool silently declines to read.

⇒ **Two consequences, both routed below:** the NUL is a one-character fix in `web/src/` (use the
`'\0'` escape — same value, no NUL in the file), and until it lands, **any lane tool using
`grep -I`, `ripgrep` defaults, or a `git grep` on this path is blind to `App.tsx`.** A future TERM
gate written with grep would go green on the file with the most findings in it.

⚠ Note also that `grep -c` counts **lines**, Python counts **occurrences** — `Viewport.tsx` reads
120 vs 129, `store.ts` 15 vs 17. Two tools disagreeing by 7% is not a hazard; a tool returning
**zero** is.

### 1b. 🔴 Hazard 2 — a scanner matches the prose that discusses what it scans for

Of **5,215** in-span occurrences tree-wide, **528 (10.1%) are in files whose subject is the ban
itself** — `docs/terminology.md` (187) and `docs/audit/*` (341). `docs/terminology.md` alone would
be the third-worst file in the repo if counted naively. Those are stripped out of every finding
number in this report and appear only in §5 as records.

### 1c. What this method does NOT reach — measured, not asserted

| Gap | Size | How I measured it |
|---|---|---|
| **Multi-line JSX text nodes** (a `>…<` run whose first character is a newline) | **5 occurrences of `sheet`/`bed`** | Re-ran with a permissive `>([^<>{}]{3,})<`; 5 hits my tokenizer had not recorded. **All 5 are listed as findings below** — none is lost. |
| **Rust `'` swallowing** — a `'static` or lifetime in code opens a string span until the next `'` | over-includes, never under-includes | Produces false positives on code lines (counted against me in §3), cannot hide a real string. |
| **A claim that avoids the term** | **not covered at all** | See §7. This is the structural limit, not a bug. |
| **Untracked/new files** | covered at snapshot time | `savedSelection.ts` (untracked) is included; anything created after 13:48 is not. |

---

## 2. Counts — raw and de-duplicated, separately

**Raw, whole-file, including identifiers and code (the number a naive grep would give): 6,146.**
**Inside comment / string / JSX / markdown spans: 5,215.** **Dropped as pure code: 931.**

| Bucket | total | string | jsx | comment | md |
|---|---:|---:|---:|---:|---:|
| `web/src/` | 1,589 | 391 | 18 | 1,176 | 4 |
| `docs/` (design + research) | 928 | — | — | — | 928 |
| `core/src/` | 904 | 283 | 0 | 621 | — |
| repo-root `*.md` (`TODO`, `SLICER-GATES`, `FUNCTIONAL-SPEC`, `README`, `AGENTS`) | 554 | — | — | 2 | 552 |
| `web/e2e/` + `web/tests/` (assertions, test names) | 458 | 240 | 0 | 218 | — |
| **`docs/audit/` — records** | **341** | — | — | — | 341 |
| **`docs/terminology.md` — the canon quoting the ban** | **187** | — | — | — | 187 |
| `gates/` | 130 | 65 | 0 | 64 | 1 |
| `cli/src/` | 91 | 52 | 0 | 39 | — |
| `wasm/src/` | 18 | 10 | 0 | 8 | — |
| `tools/` | 8 | 5 | 0 | 3 | — |
| `web/src/wasm/` (**GENERATED**, do not hand-edit) | 7 | — | — | 7 | — |
| **TOTAL** | **5,215** | 1,046 | 18 | 2,136 | 2,015 |

**De-duplicated to the population this audit is actually about** — one row per
(file, line, needle), live user-facing text only (`string` + `jsxtext` in `web/src/` excluding the
generated wasm shim, `core/src/`, `cli/src/`, `wasm/src/`, `gates/`, `tools/`; tests excluded):

| | raw hits | de-duplicated rows | adjudicated findings |
|---|---:|---:|---:|
| `sheet` + `bed` | 182 | **178** | **102** (+5 recovered from the multi-line JSX gap = **107**) |
| `table` | 66 | **64** | **24** (also adjudicated exhaustively) |
| `stock`,`board`,`fixture`,`bit`,`blank`,`workholding` | 576 | 552 | **order-of-magnitude ~100**, sampled not enumerated; **10 hand-confirmed** and listed in §4h/§4i |

### 2a. Against `terminology.md` §13d's own carry-forward measurement

§13d measured `web/src/**` on 2026-08-11 as **707 lines carrying a retired term, 296 non-comment**.
Like-for-like today (needles `sheet`+`bed`+`table` only, which is closest to what §13d counted):
**691 lines, 188 non-comment**. Across all eleven needles: **1,425 lines, 377 non-comment.**

⚠ **Do not read 296 → 188 as progress.** I did not reproduce §13d's exclusion rules, and my needle
set differs; the two numbers are *comparable in magnitude*, which is the only honest claim.
The substantive finding is the one §13d itself predicted: **`web/**` is still unactioned**, and
every specific line §13d listed as "start here" is still present, at a different line number.

---

## 3. 🔴 False-positive rate — hand-checked

Three tiers, three different methods, three different answers. **Do not average them.**

**Tier A — `sheet` + `bed`, live user-facing text: adjudicated EXHAUSTIVELY, not sampled.** All 178
de-duplicated rows were read at the artefact. **102 survived · 76 were exempt · 0 were tokenizer
artefacts.** ⇒ **precision 57%, false-positive rate 43%.** (The 5 recovered in §1c are additional
and all survived, giving **107** findings.) Every one of the 76 rejections is an §10 exception, an
identifier, or a record — i.e. **the needle worked; the canon's exception list is simply large.**

**Tier A′ — `table`, also adjudicated exhaustively.** 64 rows, **24 survived** ⇒ **precision 37.5%**.
The 40 rejections are dominated by product/technique names that are genuinely called tables
(`vacuum table`, `grid table`), data tables (`tool table`, `truth table`, the grblHAL alarm table),
X10 (`2bee CNC table`), and one verbatim vendor quote.

**Tier B — `stock`, `board`, `fixture`, `bit`, `blank`, `workholding`: a seeded random sample of 40,
adjudicated one by one.** **8 survived. 32 were false positives.** ⇒ **precision 20%,
false-positive rate 80%.** *(The sample was drawn before `table` was split out, so a handful of its
rows were `table`; the tier-B-only precision is if anything lower than 20%, not higher.)*

The 32 rejections break down as: correct use of `board` for the **spoilboard**, which genuinely is
a board (11) · verdict keys and ids — `board-depth-unknown`, `inside-board`,
`blank-or-number-string`, `vacuum-table-full` (7) · serde/JSON config fragments in Rust tests (4) ·
gate/test fixture paths and names (5) · different words that collide — `significant bits`,
`truth table`, `data sheets` (3) · X7/X10 exceptions (2).

⇒ **The honest reading: `sheet` and `bed` are worth mechanising; `board`, `stock` and `fixture`
are not.** A gate built on the wide needle set would fire four times per real defect and be turned
off inside a week — which is precisely what `terminology.md` §11.1 predicts.

---

## 4. Category A — WRONG TERM IN LIVE USER-FACING TEXT

**These are the actionable findings.** Owning tree is `web/src/**` unless stated; all of it is
the `2bee_app` lane, but the file split is what makes it dispatchable to whoever is live in each.

### 4a. 🔴 Highest priority — the founder's own example is still on screen, verbatim

| File:line (snapshot) | Exact string | Violates |
|---|---|---|
| `web/src/Viewport.tsx:1824` | ``Axes — the sheet is TURNED: its X runs along ${sx} and its Y along ${sy}. Part X / Part Y are millimetres measured on the board`` | §3 `sheet` → **workpiece**; and `measured on the board` → **on the workpiece** (§3, "the board" reads as the spoilboard) |
| `web/src/Viewport.tsx:1818` | `'Axes — the sheet is laid square, so its X and Y run with the machine\'s. Part X / Part Y are millimetres measured on the board.'` | same, both limbs |
| `web/src/Viewport.tsx:1833` | `'Axes — the sheet is turned to an angle that is not a quarter turn, …'` | §3 |

This is the sentence the 2026-08-10 ruling was made about — *"Axes: The sheet is TURNED … there is
no sheet!"* — **rendered in the axes note, unchanged.** `terminology.md` §13d listed it at
`Viewport.tsx:1406`; it is now at `:1824` and nothing has moved.

### 4b. 🔴 Two strings that reach the operator but do NOT look like sentences

Both are bare word constants that get **interpolated into a refusal at a distance**. A reviewer
reading either line sees a key, not a message.

| File:line | The constant | Where it surfaces | Violates |
|---|---|---|---|
| `web/src/Viewport.tsx:3079` | `out.push({ label: 'sheet', … })` | `Viewport.tsx:3094–3095` renders **`🔴 OVERLAPS sheet — cutting one destroys the other`** and **`🔴 4.2mm to sheet, 6.0mm required — the cutter does not fit between them`** | §3 — inside a **refusal**, the highest-consequence surface in the app |
| `web/src/Viewport.tsx:3802` | `publishSnap('sheet', out)` | `publishSnap`'s first argument is display text, not a key — `Viewport.tsx:3088` builds **`` `${what} snapped: …` ``**, and the only other call site passes the human phrase `` `clamp ${c?.name}` `` (`:3710`). The rendered string is **`sheet snapped: …`**, published via `setSnapNote`. | §3 |

🔴 **The second one is currently EXEMPTED BY CANON, and the exemption is wrong.**
`docs/terminology.md:483` states: *"the snap key `publishSnap('sheet', …)` at `2913` are
**identifiers — do not move**"*. It is not an identifier — it is the label. See §6.

### 4c. `web/src/workholding.ts` + `web/src/workholdingShape.tsx` — 46 findings

§13d called this pair "the highest-risk file pair in the web tree" and it still is: **25 + 23
findings**, almost all `bed`, on strings that describe **how high a clamp stands** and **what a
rapid must clear**. Per §13's own arithmetic (`clearance_z = tallest − stock_thickness`), the datum
is the workpiece's underside ⇒ the spoilboard's top face, so **most of these are `spoilboard`, not
`machine`** — and the §13 warning applies in full: *mapping a `bed` to `spoilboard` where the
sentence meant the machine asserts sacrificial material where there is bare frame.* **Each one
needs reading, not replacing.**

Representative — the full 48 are in the scan output, all quoted by text:

| File:line | Exact string | Should be |
|---|---|---|
| `workholding.ts:136` | `'42mm above the bed against a 5mm default safe Z is why every rapid over '` | spoilboard |
| `workholding.ts:184` | `'ARITHMETIC: 5.6mm above the material + 18mm ply = 23.6mm above the bed. '` | spoilboard (the arithmetic proves it) |
| `workholding.ts:684` | `'no keepout" with "I looked and the bed is clear". Those are different '` | **machine** (matches `Fixturing::confirmed_clear`'s core wording, moved in pass 2) |
| `workholding.ts:362` | `'rapid over a pod is completely safe (the pod is below the sheet), but '` | workpiece |
| `workholding.ts:431` | `'geometry: THE LAST SMALL PART CUT FROM A SHEET IS HELD BY THE LEAST '` | workpiece |
| `workholdingShape.tsx:875` | `'heights are from the BED, not the stock top'` | **both limbs wrong** — spoilboard + workpiece |
| `workholdingShape.tsx:215` | `'The sheet sits ON it. 50 mm of obstruction UNDER the stock, none beside it.'` | **both limbs wrong** — workpiece twice |
| `workholdingShape.tsx:387` ⚠ | `bed / spoilboard — the datum every height is measured from` — **a visible SVG caption naming both** | the `bed /` half is retired; the `spoilboard` half is correct |
| `workholdingShape.tsx:369`, `touchplateShape.tsx:342` ⚠ | `PLAN — looking down at the bed` | spoilboard |

⚠ The three rows marked ⚠ are the **multi-line JSX** cases my primary tokenizer missed (§1c) —
they are on screen, in the drawing, and are recovered here.

### 4d. `web/src/touchplates.ts` + `web/src/touchplateShape.tsx` — 23 findings

These describe **what a datum is referenced to**, which is S6/S7 territory — the distinction
between a device that moves with the workpiece and one that does not. Getting the noun wrong here
gets the *physics* wrong.

| File:line | Exact string | Should be |
|---|---|---|
| `touchplateShape.tsx:488` | `text="hooked over the workpiece corner — it MOVES when the sheet moves"` | **one sentence, both words** — `workpiece` correct, `sheet` retired, same object |
| `touchplateShape.tsx:683` | `text="nothing on the bed and nothing on the sheet"` | machine + workpiece |
| `touchplateShape.tsx:684` | `text="the datum is the table, so it does not move when the sheet does"` | machine + workpiece |
| `touchplateShape.tsx:784` | `'it is bolted to the TABLE — heights are from the bed'` | machine + **spoilboard** — the S1 pair in one line |
| `touchplateShape.tsx:786` | `'no device at all: Z is zeroed on the bed'` | **spoilboard** |
| `touchplateShape.tsx:643` | `text="bolted to the table. It never touches the work."` | machine (core's identical sentence moved in pass 2) |
| `touchplates.ts:501` | `'workpiece-referenced: its datum is the top face of THIS sheet.'` | workpiece |
| `touchplates.ts:665` | `'the DATUM can. Zero Z on the bed and the cut depth stops inheriting the '` | spoilboard |
| `touchplates.ts:684` | `'nothing to subtract. Machine-referenced because the bed does not move '` | machine |
| `touchplates.ts:557` | `'Bolted to the table and never touches the work. This is the device '` | machine |

### 4e. `web/src/App.tsx` — 17 `sheet`/`bed` + 11 `table` findings

| File:line | Exact string | Violates |
|---|---|---|
| `App.tsx:9394` | `<span>Below the sheet</span>` — **a panel label** | §3 |
| `App.tsx:9438` | `'No spoilboard is declared on this machine, so the below-the-sheet cells were judged on DEPTH ALONE.'` | §3 |
| `App.tsx:6195` | `travel envelope; it is no board at all. Below-the-sheet cells on this` | §3 |
| `App.tsx:6835` / `:6843` | `title="Turn the sheet a quarter turn anticlockwise"` / `…clockwise` | §3 — **the founder's example, as a control tooltip** |
| `App.tsx:5424` | `'the WORKPIECE, so it follows the sheet'` / `'the MACHINE, so it stays with the table'` | §3 + §1 — **one ternary, both rectangles named with retired words** |
| `App.tsx:5530` / `:5531` | `' It is fastened to the TABLE, so it does not follow the sheet…'` / `' It hooks over the WORKPIECE, so it follows the sheet.'` | §1 `TABLE` → machine · §3 `sheet` → workpiece |
| `App.tsx:7766` ⚠ | `I have checked the bed is clear` — **a live checkbox label**, beside `data-testid="confirmed-clear"` and a live `onChange` | §1 → **machine** |
| `App.tsx:7769` | `No clamps declared is <em>not</em> the same as a bed confirmed clear.` | §1 → machine |
| `App.tsx:9519` | `'No work holding declared, and nobody has confirmed the bed is clear.'` | §1 → machine |
| `App.tsx:6118` ⚠ | `every emitted coordinate is in — measured the way you measure the sheet` / `datum.` | §3 — `sheet datum` → **workpiece datum**, verbatim in the retired-terms table. *(The `board's lower-left corner` on the line above is CORRECT — it is the spoilboard.)* |
| `App.tsx:7591` / `:7592` / `:7596` / `:7710` | `…${w.heightMm} mm above the bed…`, `…on the bed…`, `'takes no bed area…'`, `'…publishes no bed footprint…'` | §1 → **spoilboard** (height datum) |
| `App.tsx:7618` | `{ label: 'Height above the bed', … }` — **a field label** | §1 → spoilboard |
| `App.tsx:5736` | `label: 'Does it fit the machine TABLE?'` | §1 → **the machine's travel** |
| `App.tsx:5741` | `'Measure your table.'` | §1 → **frame / rails** (X5 — this one is about the physical structure) |
| `App.tsx:5786` | `'below, not a caliper reading of the board bolted to your table, '` | `board` correct (spoilboard); `your table` → machine |
| `App.tsx:1006` / `:1052` / `:4040` / `:6974` / `:7264` | `'not asked (not on the table…)'`, `'…is not on the table…'`, `` `— on the table as` ``, `title="Take this drawing off the table."` | §13c precedent — the English idiom *"on the table"* reads as a machine surface in this tool. §13c already retired `"a drill is on the table for it"` in `core/`; **the same idiom survives untouched in `web/`, five times.** |

⚠ **`App.tsx:7766` is worth a second look by whoever owns it, and NOT by me.** The comment at
`App.tsx:2270` says *"This checkbox says 'I have checked the bed is clear'. Restoring it would…"*
and `App.tsx:4922` renders *"Not restored, deliberately"* — while `:7766` renders that exact label
for real, wired to `setConfirmedClear`. Either these are two different checkboxes or one of the
three statements is stale. **That is
a UI-honesty question, not a terminology one**, and I am reporting the tension rather than
resolving it.

### 4f. `web/src/cam.ts`, `store.ts`, `jobMaterial.ts`, `materials.ts`, `samples/index.ts`, `cad/record.ts`

| File:line | Exact string | Should be |
|---|---|---|
| `cam.ts:1262` | `` `${ids.length} drawing(s) are on the table and the report carries no imported geometry ` `` | the idiom, §13c |
| `cam.ts:1292` | `` `${empty.length} drawing(s) on the table (${empty.join(', ')}) appear nowhere in the ` `` | same |
| `store.ts:960` | `'the sheet is empty rather than partly the one you left'` | workpiece |
| `store.ts:1667` | `` `these numbers were chosen for "${rec.material}" and the sheet is "${current.material}". Feeds and ` `` | workpiece |
| `store.ts:1352` | `` `different table of the same model is somewhere else. Check the corner before you cut.` `` | machine |
| `jobMaterial.ts:158` | `` why: `the sheet "${workpiece!.name}" says it is ${wp.why}` `` | **workpiece — the variable is literally named `workpiece`** |
| `jobMaterial.ts:164` | `'the sheet was typed rather than picked, so it states none'` | workpiece |
| `materials.ts:238` | `'Oversize Baltic sheet. Longer than any AU table this lane has facts about — check travel before selecting it.'` | `sheet` is **X1 (keep)**; `any AU table` → **travel** |
| `materials.ts:274` | `'Long AU MDF sheet, confirmed stocked. Exceeds most hobby-class table travel — check the machine envelope.'` | `sheet` **X1 (keep)**; `table travel` → **travel** |
| `samples/index.ts:44` / `:308` | `'…so it lands outside the table until the datum is moved — '` | travel |
| `cad/record.ts:471` | `'symptom until it is on the bed. Fix the model (flush and coplanar faces between operands are '` | machine — CAD-tab refusal, S5-adjacent |

### 4g. `web/src/Viewport.tsx` — the remaining 9

| File:line | Exact string | Should be |
|---|---|---|
| `Viewport.tsx:3157` | `return { title: 'Sheet', rows };` — **an inspector panel title** | **Workpiece** (§13d listed this at `:2402`) |
| `Viewport.tsx:1166` | `` …so the sheet thickness stands in… a 6mm pocket drawn to an 18mm sheet shows a hole through a board that keeps 12mm `` | **three defects in one string**: `sheet` ×2 → workpiece, **and `board` here means the WORKPIECE, not the spoilboard** (§3, the one direction that inverts S1) |
| `Viewport.tsx:895` | `'…(a 600×900 sheet at the simulation's own 0.6mm cell is 8.0MB of base64)…'` | workpiece |
| `Viewport.tsx:2461` | `'…nothing on this sheet to measure it against…'` | workpiece |
| `Viewport.tsx:3356` | `'…a short height map read row-major draws a plausible sheet on a slant.'` | workpiece |
| `Viewport.tsx:3274` | `` ['Height', `${mm(c.height_mm)} from the bed`] `` | spoilboard |
| `Viewport.tsx:6133` | `'…the edges of the other things on the bed — within …mm. '` | spoilboard |

### 4h. `core/` and `gates/` — the reviewer-facing surfaces

🔴 **The `brand` ruling exempting core diagnostics from the em-dash rule does NOT exempt them from
this canon, and I applied the canon in full.** The result is a genuinely short list, because pass 2
(`terminology.md` §13) already did `core/`, `cli/` and `wasm/`:

| File:line | Exact string | Violates |
|---|---|---|
| `gates/slicer_gate_check.mjs:224` (gate `RUN`'s description, **printed by `--list` and in every report**) | `…or rapids DOWNWARD through the stock because the stored G54 Z belonged to the last job.` | §3 — `stock` in prose → **workpiece** |
| `core/src/feeds.rs:404` | `'…the tool is being driven into solid stock on the one part of it that…'` | §3 — `stock` in prose (weak: "solid stock" is machining idiom; the owning session may decide it earns an exception) |

**Everything else found in `core/`, `cli/`, `wasm/` and `tools/` — 76 rows — is exempt**: X1
catalogue labels, X2 `sheet basis`, X4 identifiers (`ONE_SHEET`, `--sheet-x`, `sheet-quarter-turn`,
`board-depth-unknown`), X8 plant ids (`bed-anchored-sim`), X9 collisions (`M140 bed temperature`,
`tool table`), X10 (`2bee CNC table`), and test-only fixture names. **Pass 2 held.**

### 4i. Tier-B needles — sampled, not enumerated

Given the 80% false-positive rate (§3) I did **not** produce a full `stock`/`board`/`fixture` list;
a list nobody trusts is worse than a short one. **Estimated true findings in that pool: ~128.**
**Hand-confirmed and listed, so the owning session has somewhere to start:**

`web/src/App.tsx:5458` — `'Conductive stock'` (a **material picker label**) · `web/src/workholding.ts:291`
`'NOT PUBLISHED: holding force, maximum stock thickness, and the reach '` · `:640`
`'⚠ THE 0.7in DOG IS 17.8mm AND THE STOCK IS 18mm, so it sits 0.2mm BELOW '` ·
`web/src/workholdingShape.tsx:201` `'Resists nothing in Z. Stock 2 mm undersize is loose and looks clamped.'` ·
`:872` `'the obstruction is UNDER the stock'` · plus the `Viewport.tsx:1166` `board`-means-workpiece
case in §4g and the two `gates`/`core` `stock` cases in §4h.

---

## 5. Category B — RECORDS. Correct as written. **Must not be rewritten.**

**A sweep that rewrites a record destroys the evidence of what was true.** These carry retired
terms and are right to.

| Record | Count | Why it must stand |
|---|---:|---|
| `docs/audit/2026-08-10-*.md`, `2026-08-11-*.md` (8 files) | **341** | Dated audits. Each quotes the string as it stood on the day it was measured. `2026-08-11-spoilboard-vs-machine.md` alone holds 167 — it is *about* the board-versus-machine collapse and cannot discuss it without naming it. |
| `docs/terminology.md` retired-terms tables | **187** | X3 — *"a prohibition has to quote the wrong form in order to ban it."* |
| `SLICER-GATES.md` recorded FAIL transcripts (~L748, ~L1003–1004, ~L1095) | — | X12. `:1095` still reads `square to the bed` while the live message reads `square to the machine's axes`. **That divergence is deliberate**, recorded in §13b, and re-confirmed correct this pass. |
| `SLICER-GATES.md:1664` + `gates/slicer_gate_check.mjs:921` — founder quotes verbatim | 2 | X11. Correcting a quotation misattributes it. |
| `web/src/App.tsx:4922` — `Not restored, deliberately: “I have checked the bed is clear”` | 1 | **Quotes a retired label in order to say it was withdrawn.** Rewriting it would make the sentence describe a control that never existed. |
| `web/src/workholding.ts:629` — `Published verbatim: "Above the table…"` (Woodpeckers 2096) | 1 | A vendor quotation with its source and read-date. |
| `docs/tool-gap-long-reach-small-cutter.md:212` — `"the candidates are this core's STOCK LIBRARY…"` | 1 | ⚠ **Confirmed stale this pass**: the CLI now prints `BUILT-IN LIBRARY` (verified by running `recommend`). §13c predicted this. **It is a record of what the tool said — it earns a dated note, never a rewrite.** |
| `TODO.md` (324), `FUNCTIONAL-SPEC.md` (89), `README.md` (22) | 435 | Mixed. TODO rows that *record* a past state are records; live spec prose is not. **Not adjudicated line-by-line — out of proportion to its risk, and `TODO.md` is read-only to me.** Flagged, not counted as findings. |

---

## 6. Category C — DELIBERATE USES. **Do not report these again.**

| Use | Count | Authority |
|---|---:|---|
| `--sheet-x` / `--sheet-y` CLI flags; `ONE_SHEET`; `"sheet-quarter-turn"` failure id; `board-depth-unknown` / `inside-board` / `through-board` verdict keys; `"stock":` serde keys; `rowId('sheet', …)` / `parseRowId(…, ['sheet','saved'])`; `data-testid`s; `Kind = … \| 'bed'` and `kind: 'bed'`; CSS classes `tps-bed`, `whs-bed` | ~90 | §0 + X4. **Persistence and wire contracts — renaming orphans every saved store and every e2e test.** `web/src/store.ts` says so in place; I did not report its keys. |
| `web/src/materials.ts` `SHEET_SIZES` — 23 of its 25 `sheet` hits: labels, ids, supplier URLs, `sheet goods`, `full sheet` | 23 | X1. *"MDF workpiece 2400 × 1200"* would be a claim the source page does not make. **The two exceptions (`:238`, `:274`) are `table`, not `sheet`, and are in §4f.** |
| `core/src/spoilboards.rs` catalogue labels + notes | 5 | X1 |
| `sheet basis` (`wasm/src/lib.rs:807`, `AGENTS.md`) | 1 | X2 — a cross-lane term owned by `bom` + `ops` |
| `web/src/App.tsx:6343–6365` — *"a researched sheet size"*, the `sheet` row kind, *"the shipped sheets"* | 10 | §10a. **The app already draws the sheet-vs-workpiece line correctly, per row.** |
| `bed-anchored-sim` plant id + the assertions that name it (`core/src/fixtures.rs`, `gates/`) | 9 | X8 |
| `M140 bed temperature` (`core/src/tech.rs:87`), `tool table` (`core/src/fixture.rs:2529`), `controller board` (`core/src/post.rs:265`) | 3 | X9 — different words that happen to collide |
| `2bee CNC table` / `2bee-cnc-table-mdf-18` | 9 | X10 — the product name of the machine `cad` designs |
| `vacuum table`, `grid table` (`web/src/workholding.ts`, `core/src/fixture.rs`) | ~14 | **Proposed new exception.** These are product/technique category names at real vendors (Schmalz, CNCCookbook), same family as X1. Not this audit's to grant — flagged for the lane. |
| `data sheets` (3M, Onsrud), `cheat sheet` (OpenSCAD), `significant bits`, `truth table` | ~8 | Different words entirely |
| `web/src/wasm/twobee_cam_wasm.js` (7) | 7 | **GENERATED** from `wasm/src/lib.rs` doc comments. Updates on the next `wasm-pack` build. Do not hand-edit. |

---

## 7. 🔴 The inverse — the right word about the wrong rectangle

**My method cannot see this, by construction.** A term sweep matches vocabulary; S1 is a claim about
*which rectangle a sentence is about*, and `terminology.md` §11 says so outright: *"S1 is not a
vocabulary property and no term scan can reach it."* **Everything in §4 is a vocabulary finding.
Nothing in §4 is evidence that the remaining strings name the right object.**

⇒ **Treat this section as "what I noticed while reading", not as coverage.** A message reading
*"The workpiece is turned"* passes every needle above and may still be about the spoilboard.

Instances I noticed by reading:

1. **`web/src/Viewport.tsx:1166` — the inverted `board`.** *"a 6mm pocket drawn to an 18mm sheet
   shows a hole through a **board** that keeps 12mm."* Everywhere else in this tree `board` means
   the **spoilboard**; here it means the **workpiece**. This is the S1 collapse **in the reassuring
   direction** — a reader who takes `board` at its usual value reads a sentence about the
   sacrificial layer where the material being cut is meant. **A term sweep that mapped `sheet` →
   `workpiece` here and left `board` alone would leave the sentence more confusing, not less.**
   *(It is listed in §4g, but it was found by reading, not by the needle — the needle only told me
   `sheet` was on that line.)*

2. **`web/src/workholdingShape.tsx:387` names both rectangles at once** — the visible caption
   *"bed / spoilboard — the datum every height is measured from"*. The `spoilboard` half is
   correct and load-bearing; the `bed` half is retired. Deleting the wrong half is right; deleting
   the wrong one collapses S1.

3. **`core/src/fixtures.rs:1517`, `:3878`, `core/src/job.rs:75`, `core/src/types.rs:1272` — *"the
   workpiece is laid on the machine"*.** Correct vocabulary (§13's coordinate-frame mapping) and,
   read literally, the wrong rectangle: the workpiece is physically laid on the **spoilboard**.
   Low risk — it fails in the safe direction (§13's *"when in doubt this pass chose `machine`"*,
   which costs a false red, not the frame) — but it is exactly the shape a future reader would
   "fix" into `spoilboard` and thereby assert sacrificial material where there is bare frame.
   **Recorded so it is not silently changed.**

4. **`web/src/App.tsx:7618` — `'Height above the bed'`.** Vocabulary finding (§4e), but the
   *substantive* risk is the correction: `bed` here must become **spoilboard**, not `machine`.
   `Workholding.heightMm`'s datum is the surface the clamp stands on. Mapping it to `machine`
   would be the right word about the wrong rectangle, and it would pass any TERM gate.

**What no scan in this lane covers, stated rather than left to be discovered:** every message that
uses `workpiece`, `spoilboard`, `travel` or `machine` **correctly as vocabulary and wrongly as
reference**. That set is held only by the type system (`Spoilboard` / `Stock` / `TravelEnvelope`)
and by the checks in `core/src/sim.rs` — and `docs/audit/2026-08-11-spoilboard-vs-machine.md`
already records fourteen findings in exactly that space, of which **three are `UNCHECKED` in the
over-declaring direction**. That audit, not this one, is where S1 is measured.

---

## 8. Two corrections to `docs/terminology.md` itself

I am reporting these, not applying them. Both are in §13d's carry-forward list.

1. 🔴 **`docs/terminology.md:483` exempts a live user-facing string as an identifier.** It says the
   snap key `publishSnap('sheet', …)` is an *"identifier — do not move"*. It is not: the first
   argument is interpolated into `` `${what} snapped: …` `` and published to the UI via
   `setSnapNote`, and the only other call site passes the human phrase `` `clamp ${name}` ``.
   **A wrong exemption in canon is worse than a missing finding** — it survives every future sweep
   and gets quoted as authority. It also missed the neighbouring `label: 'sheet'` at `:3079`, which
   reaches an overlap **refusal**.

2. ⚠ **§13d's line numbers are all stale** (`Viewport.tsx:1406` → `:1824`, `:2402` → `:3157`;
   `App.tsx:4119` → `:5424`, `:7097` → `:9394`). Not an error — the tree moves — but the list is
   navigable only by text, and it does not say so. Two of its entries (`Viewport.tsx:2028`,
   `App.tsx:4655`) I could not locate by text at all; they may have been actioned or reworded.

---

## 9. What is CLEAN — verified by running, not by reading

* ✅ **The emitted G-code carries no retired terminology.** All four `fixture` targets and all six
  `job` targets emit only: the program name, the fixed post banner, `tool:`, the touch-plate lines,
  and the `op:` / `drill:` banner (§7 — **frozen, machine-readable, correctly untouched**). The
  `comment!()` surface in `core/src/post_grblhal.rs` is closed and I enumerated it.
* ✅ **The CLI's human-readable output is clean.** Across `usage`, six `report`s, six `job`s,
  `recommend`, `fit`, `route`, `layout` and `import`, every needle hit is an identifier being named
  on purpose — `Stock::rotation_deg`, the `"stock":` serde key in the report JSON — or a data
  table. **Zero prose findings.**
* ✅ **`gates/ --list` yields exactly one finding** (§4h, gate `RUN`'s `stock`) out of 37 gate rows.
* ✅ **`core/`, `cli/`, `wasm/` are substantially done.** 76 of 76 `sheet`/`bed` rows there are
  exempt. Pass 2 (`terminology.md` §13) held under an independent scan with a wider needle set.

---

## 10. Routing

Everything below is inside `software/2bee.app` and therefore the `2bee_app` lane's; the split is by
file so it can go to whoever is live in each.

| Owner surface | Findings | Priority |
|---|---:|---|
| `web/src/Viewport.tsx` | 12 `sheet`/`bed` + the two interpolated constants | 🔴 **First** — the axes note is the founder's verbatim example, and `:3079` is inside a refusal |
| `web/src/workholding.ts` + `workholdingShape.tsx` | 48 (incl. 3 recovered from multi-line JSX) | 🔴 Highest volume; **each `bed` needs reading** — spoilboard vs machine is not mechanical |
| `web/src/touchplates.ts` + `touchplateShape.tsx` | 23 (incl. 1 recovered from multi-line JSX) | 🔴 S6/S7 — the noun *is* the physics here |
| `web/src/App.tsx` | 17 `sheet`/`bed` + 11 `table` (incl. 5 × the *"on the table"* idiom §13c already retired in core) | 🔴 Panel labels and a live checkbox label |
| `web/src/cam.ts`, `store.ts`, `jobMaterial.ts`, `samples/index.ts`, `cad/record.ts` | 10 | ⚠ |
| `web/src/materials.ts` | 2 (`table` → travel; the other 23 are X1 and must stand) | ⚠ |
| `gates/slicer_gate_check.mjs:224`, `core/src/feeds.rs:404` | 2 | ⚠ |
| `web/src/App.tsx:3252` — **the literal NUL byte** | 1 | 🔴 **Not a terminology finding — a tooling one.** One character, and it un-blinds every `grep -I`-based tool in the lane, including any future TERM gate. |
| `docs/terminology.md:483` | 1 wrong exemption | 🔴 A wrong exemption in canon outlives every sweep that trusts it |

**Not routed, deliberately:** replacement wording. §4 names the *distinction* violated and, where
the arithmetic settles it (heights → spoilboard; bolted-to → machine; `outside the table` →
travel), the destination. **The sentences are the owning session's to write** — and §13's own
warning applies: the two directions are not symmetric, and mapping a `bed` to `spoilboard` where
the machine was meant asserts sacrificial material where there is bare frame.

---

## 11. Reproducing this

The scanner is two files in the session scratchpad (`termscan.py`, `scan2.py`) and has no
dependencies. It is **not** committed — it is a measuring instrument, not a control, and canon §11
is explicit that a real TERM gate needs four legs this has only two of (it has scope-by-artefact-class
and one-needle-per-term; it has **no exception allowlist** and **no negative control**). Shipping it
as a gate without those would produce a green nobody has watched go red.

**If it is turned into a gate, the false-positive numbers in §3 are the design constraint:**
`sheet` and `bed` at 57% precision are gateable behind an allowlist; `board`, `stock` and `fixture`
at 20% are not, and a gate that fires four times per real defect gets switched off.
