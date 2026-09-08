# Full-gate run, 2026-08-27 — what it found and the order to fix it

**This is the first recorded FULL run in this lane's evidence.** Every gate run quoted in a
recent commit body was `--quick`, and `--quick` reports `I1` and `SPLNT` as *could-not-run*.
Those are exactly the two that fail. `54 passed, 0 failed, 5 could-not-run` and
`54 passed, 2 failed, 3 could-not-run` are the same tree measured through two different doors.

## What was run, and what it said

| Run | Result |
|---|---|
| `node gates/slicer_gate_check.mjs` (full) | **54 pass · 2 FAIL (`I1`, `SPLNT`) · 3 could-not-run (`RUN`, `CTRL`, `AGPL`) → `VERDICT: NO-GO`** |
| `cargo test -p twobee-cam --lib` | 693 passed, 0 failed |
| `npm run test:node` | 1119 passed, 0 failed, 55 files |
| `npx playwright test` (default workers) | 75 passed, **20 failed** of 95 |
| `npx playwright test --workers=1` | 83 passed, **12 failed** of 95, 5.2 min |
| `npx playwright test e2e/slicer.spec.ts:847` alone | **passes** |
| standalone preview + `plate.dxf` import probe | status **`runnable`** |
| `CAD1` corpus (87) | 74 SAME · 5 STRICTER · 2 REFUSED-BOTH · 4 DIVERGES · 2 PENDING |
| `CAD1H` our own models (72) | 16 SAME · 4 STRICTER · 9 DIVERGES · 1 ERROR · **42 PENDING** |

Binary `4ea5df358af5`, core `c5ddc8086b5b`, `K3` green (wasm and CLI from the same core).

⚠ **The tree was being written to while this ran.** Another session was editing
`software/2bee.app/` throughout (`web/tests/auth.test.ts` written 17:11:56, `web/debug-*.mjs`
last touched 18:12). Nothing here was committed, moved or swept. One of the two failures is
caused by that fact and is not a defect in the product — see §2.

---

## 1. `I1` — 20 red, of which 8 are the harness and 12 are real

`fullyParallel: false` is set; `workers` is **not**, so Playwright still runs FILES in parallel
across `cpus/2` workers against one preview server. Measured today, same tree, same commit:

```
default workers   20 failed / 95
--workers=1       12 failed / 95
```

**8 failures are produced by the run's own concurrency.** They are not in the product and they
are not in the tests — they are in the absence of a `workers` pin. Until it is pinned, `I1`'s
red count is not a defect count, and a green under one worker is not a green under N.
`slicer.spec.ts:847` fails in the suite and passes alone; the same import driven against a
standalone preview build returns `runnable` with the full notes panel.

### The 12 that survive `--workers=1`

| # | Test | Symptom |
|---|---|---|
| 1 | `cad-to-cnc.spec.ts:213` the saved CAD model persists across CNC tab switches | locator never attaches |
| 2 | `persistence.spec.ts:211` a stored setup naming things that no longer exist REPORTS each drop | `restore-dropped-count` **expected `4`, received `2`** |
| 3 | `slicer.spec.ts:479` the workpiece is adjustable and bounds the cut depth | `deepest` expected `-18 mm`, received `-18.0 mm` |
| 4 | `slicer.spec.ts:1384` a machine can be saved, reloaded and deleted | `machine-note` "saved" not found |
| 5 | `slicer.spec.ts:1496` a workpiece round-trips with its placement | `workpiece-note` "saved" not found |
| 6 | `slicer.spec.ts:1760` hiding every move class changes the picture and not one byte of the program | `hidden-indicator` expected 0, received 1 |
| 7 | `slicer.spec.ts:2102` hovering reports the object under the pointer | a hidden move class was still reported by the hover panel |
| 8 | `slicer.spec.ts:3719` the extruded-walls layer is dark without a drawing and lit with one | attribute expected `"true"`, received `""` |
| 9 | `slicer.spec.ts:4042` the cutter at the head has its own layer chip | attribute expected `"false"`, received `"true"` |
| 10 | `slicer.spec.ts:5002` a measured 250x900 board under a 17.8mm sheet strikes past the edge | `locator.click` timeout, 60 s |
| 11 | `slicer.spec.ts:5197` the clamps layer hides and re-shows, and a hidden clamp still blocks cuts | **the clamps layer chip is not offered even though a clamp was declared** |
| 12 | `storage.spec.ts:168` a saved machine is written to Chrome's own IndexedDB | `toContain` failed |

🔴 **Do not fix these as one batch.** Three shapes are mixed in that table and only one of them
is safe to fix by editing the test:

* **(a) formatting/address drift** — `-18 mm` vs `-18.0 mm`, moved `data-*` publications.
  The `08-19→21` refactor series moved opening defaults into `store/cncStore.ts` and extracted
  panels into `panels/`; commit `bc08ca3708` already swept 20 node tests of exactly this class.
  Re-point the guard; do not weaken it.
* **(b) a changed rule the test did not learn** — #4 and #5. The page now says
  *"Nothing was saved. You are looking at X, but the panel holds a 1234 × 900 machine — select X
  first if you mean it."* Save-as gained a precondition. Decide whether the precondition is
  right; then move the test to it, or take the precondition out.
* **(c) candidate REAL regressions, and they are the ones that matter** — #2, #7, #11.
  * #2: a restore that drops 4 unknown things now reports **2**. Two drops are silent, and
    *"the restore is ANNOUNCED"* is the whole point of TODO #52.
  * #7: a hidden move class is still reported by the hover panel — TODO #25's explicit
    acceptance ("a hidden class is not pickable").
  * #11: the clamps chip is absent with a clamp declared — TODO #53's acceptance is that the
    chip is absent **only** when nothing is declared, precisely because *"a greyed chip reads as
    off and off reads as there are none."*

  Each of these three is a case of the app quietly telling the operator less than it knows.
  Prove the direction at the artefact before touching either side.

## 2. `SPLNT` — 25 problems, one cause, and it is not a control defect

Every one of the 25 reads *"also moved `CADT`, which its contract does not declare."*

`CADT`'s row prints the file set it DISCOVERED and its suite total. Measured in this run:

```
clean baseline   54 test file(s) DISCOVERED ... suite: 922 passed, 0 failed
every self-plant 55 test file(s) DISCOVERED ... suite: 926 passed, 0 failed
```

The extra file is `web/tests/auth.test.ts`, **untracked, mtime 2026-08-27 17:11:56** — written by
another session *between* SPLNT's clean baseline and its children. SPLNT compares row TEXT
against that baseline, so every plant that ran after 17:11:56 "moved" a gate nobody aimed at.

🔴 **SPLNT measures a live tree over ~45 minutes on a box where five sessions share one working
copy.** A green over a mutating input is not a green, and this red is its mirror image. The fix
is not narrowing the plants: it is making the comparison immune to a concurrent write —
snapshot the discovered set once and pass it to the children, or exclude the volatile fields
from the compared text and assert them separately.

## 3. `CTRL` is a stale red, and it denies work that exists

The gate says *"no controller transcript in the tree — nothing this lane emits has been offered
to a real board"*, and its own source comment says `gates/controller/` *"has never held one."*
On disk right now:

* `docs/cnc-controller-status.md` (2026-08-20): **"Board: ALIVE — grblHAL running,
  PROBE_ENABLE=1, accepting G38.2"**, SKR Pro v1.2 recovered over ST-Link, `/dev/ttyACM0`.
* `gates/ctrl-transcript-2026-08-20.json` — **untracked, and in the wrong directory.** Contains
  `"kind": "2bee.slicer controller acceptance"`, banner `GrblHAL 1.1f`, `[VER:1.1f.20260817:]`,
  `port /dev/ttyACM0`, a program sha256. `gates/controller/` holds a README and nothing else,
  so `CTRL` cannot see it.
* `grblhal/` — an untracked firmware source tree (`STM32F4xx`, `core`, `stm32f4.tar.gz`).
* `README.md` TODO #16 still reads **"SKR Pro bricked"**.

Three facts about the same board, from three days, disagreeing. Either rung 1 is climbed and
unfiled, or that transcript must never reach `gates/controller/`. **Only the session that ran it
can say which, and nobody else may file it** — a transcript is the evidence that a machine
answered, and moving one on a guess forges it.

## 4. A gouging program posts at exit 0

```
$ 2bee-slice job plate --plant gouge   # exit 0, full G-code on stdout
sim: cell=0.6mm gouge=2984 uncut=0 spoilboard=0
sim first finding: Gouge { x: 61.2, y: 117.6, depth_mm: 18.0 }
```

No `warning:`, no `error:` — 2984 gouged cells reach `stderr` as a `sim:` line and the program
prints anyway. In the browser the count renders red and `download` is disabled on
`!report.gcode` alone (`App.tsx:10966`), so the `.nc` saves.

That may be the right call: the height map has known blind spots (it counts gouges, not material
left standing — spec `H1`), and `simulate_and_check` walks the plan's arcs, so a degraded-arc
program is invisible to it. A false refusal on a tool an operator cannot override is its own
failure. But **nothing on that path makes a person answer the question**, and the lane's own
standing test is *would you stand next to the machine while this program runs?* Decide it, write
the decision down, and gate whichever answer wins.

## 5. `2bee.cad`'s index row still claims a completion the oracle contradicts

`TODO.md` index row #12: *"✅ **DONE** — Full OpenSCAD language implemented … Verified
2026-08-20."* Commit `194be8788a` corrected this **in §80** — *"'implemented' (08-20) was
parse/emit-level"* — and left the index row standing. A reader hits the table first.

What the oracle measures on our own 72 hive models: **16 SAME, 10 DIVERGES+ERROR, 42 PENDING.**
42 undecidable is not 42 passing, and `hull`, `minkowski`, `rotate_extrude`'s dropped `$fn`,
`polyhedron` winding and unmeshable `text` are named and open.

## 6. Lane hygiene, owned by whoever is mid-work

`web/playwright.config.ts` modified (blanks the Cognito triple for both e2e servers), 14
untracked `web/debug-*.mjs`, untracked `grblhal/`, untracked `web/tests/auth.test.ts`,
untracked `gates/ctrl-transcript-2026-08-20.json`. The config's own comment names the hole it
opens: *"NOTHING covers the gate itself — no e2e and no node test touches AuthGate, so a broken
login ships green."*

---

## The order, and why it is this order

1. **#126 `CTRL`** — a false "never happened" about a physical rung is the most expensive record
   in the lane, and it is 7 days old. Everything above it on the ladder is planned against it.
2. **#127 TODO #12** — one stale ✅ on the tab the founder asked for; cheap, and it is the row a
   reader lands on.
3. **#128 `SPLNT` immune to a concurrent write** — until this is fixed, no full run on this box
   produces a trustworthy SPLNT verdict, and the next reader will re-derive today's 45 minutes.
4. **#129 pin `workers`** — until this is fixed, `I1`'s red count is not a defect count and #130
   cannot be scoped.
5. **#130 the 12** — after #129, triage into (a)/(b)/(c) above and fix (c) FIRST.
6. **#131 the gouge decision** — a safety semantic, but it needs a ruling, not a patch.
7. **#132 replan the physical rungs** — depends entirely on #126's answer.
8. **#133 AuthGate is covered by nothing** — named in the config that opened it.
9. **#134 hygiene** — last, and coordinated: it is another session's live work.

---

# What was fixed, same day

Written after the work, against the artefacts rather than the plan above. Where the plan was
wrong, the plan is quoted and corrected rather than edited — three of its nine judgements did not
survive contact.

## Fixed

| # | Outcome |
|---|---|
| 126 | `CTRL` — probe now REFUSES to write an inadmissible transcript; four stale records corrected. Rung itself still blocked on the bench |
| 127 | TODO #12's index row now 🟡 PARTIAL with both oracle legs and all five named constructs |
| 128 | `SPLNT` survives a concurrent write — closing baseline **and** a per-child tree check |
| 129 | `workers` pinned, with the measurement and the residual both in the comment |
| 130 | **Browser suite 20 → 0.** The last three were one real defect, not stale tests |
| 131 | A gouging program now warns at severity in the CLI. Ruled: warn, do not refuse |
| 132 | Prose half corrected; the rungs need the bench and **ops** |
| 133 | **`AuthGate` failed OPEN on a partial config.** Fixed, tested, watched red, measured in the built app |
| 134 | Position taken: nothing swept. Every item is untracked, so none of it ships |

## The three judgements that did not survive

**1. "#126 is a gate-authoring job."** It is not. `CTRL`'s transcript reader already exists and is
complete — it re-emits `program_command`, compares sha256, refuses on `rejected > 0`. The
transcript is inadmissible on a **recording gap**: `--program-command` was an optional flag and
was not passed. A board was sourced, unbricked over SWD, flashed and driven, and the result cannot
be counted because of a missing argument. And the transcript is **not stale** — its
`program_sha256` is byte-identical to `fixture rect-profile` from the current build.

**2. "The two save failures are (b) — a rule changed and the test did not learn."** They were (c),
a real defect, and only driving the built app showed it. `ObjectPicker` makes **row 0** active on
open, the properties view follows the active row, and TODO #102's save-target guard read that as
the operator looking at a machine they never chose. The refusal's own escape hatch — *"close the
properties view"* — names a control that does not exist. **A hand-typed machine could not be saved
at all.** Reading the diff would have produced a test edit and shipped the defect.

**3. "#133 is adding coverage."** Writing the test found the defect. `readConfig()` returned
`null` when **any** of the three Cognito vars was missing, and `AuthGate` reads `null` as *gate
open*. Two vars set and one typo'd served the whole app **unauthenticated and silently**, looking
exactly like intended local-dev behaviour. The rule is *"only admins can log in"*; the failure
mode of a misconfiguration was *everyone can*.

## What the SPLNT control cost, and what it bought

The first plant was **vacuous** — it landed six minutes into the run, before the drive limb's own
opening baseline, so it proved nothing while looking exactly like a plant that worked. The second
was placed inside the window and fired. The run then exposed a **second** blind spot the ticket
had not predicted: `b1`-vs-`b3` cannot see drift that *reverts*, and four innocent plants were
reported as the blast radius of `STALE`, `K3`, `G2`, `MULTI`, `TOOL`, `DOOR` and `FLAG` after
another session rebuilt the wasm mid-pass. Hence the per-child check.

## Still open, and none of it is doable from this box

- **The controller rung** — re-run the probe with `--program-command`, and ground PG4 so the last
  three lines are answered. Bench + **pcb/ops**.
- **Air cut → coupon → ply** — a machine and **ops**. This lane may not self-certify them.
- **AGPL §13** — the offer target is `legal`'s decision. 🔴 **And a second copy of the dead URL is
  live in `web/src/AuthGate.tsx`, outside the gate's field of view** — the gate reads only
  `App.tsx`'s `<footer>`. It is on the **login screen**, which is the only page an unauthenticated
  visitor of a Cognito-configured deployment ever sees. This is the exact defect this README
  already records once ("fixing the footer alone would have turned it green with a stale copy
  still in the tree"), in a worse place.

## What "production ready" cannot mean here

Nothing this lane emits has cut anything. One board has parsed one program once, on a bare rig,
with nothing connected — and that is rung 1 of four. **Air cut → foam/MDF coupon → real ply are
unclimbed**, they need a machine and an operator, and they are a joint run with **ops**. No amount
of green in this repository changes that, and a reader who takes "97 passed, 0 failed" as
readiness to cut has been misled by a true number.

---

# Round two — what auditing the fixes found

Three read-only agents were run over the first round's work. They found more than the round did,
which is the finding: **every one of these had been shipped hours earlier by someone who believed
they had checked it.**

## The fixes were defective

| Found in | What |
|---|---|
| my #130 fix | **Still reachable.** `onPointerMove` armed "chosen"; the save box is mouse-only and the mouse path crosses rows, so every mouse user hit the refusal. My two tests stayed green because `fill()` moves no pointer and `click()` jumps |
| my #128 fix | Per-child fingerprint sampled **before** the child and never re-baselined — off by one in the wrong direction (the corrupted child read clean, its successor wore it) and **sticky**, so one write at minute 2 disabled the undeclared-move detector for the rest of the run while SPLNT still went red |
| my #131 fix | Wired on **one of three doors**. `import` and `nest` — the two a user actually drives — stayed silent |
| my #133 fix | `.env.example` shipped a **partial** config, so after the fix `cp .env.example .env && npm run build` produced a build that refuses to open |

**The pattern:** a fix verified by the test written alongside it is verified against the author's
own model of the defect. Every one of these was caught by someone approaching it from outside.

## Defects that predate today

- 🔴 **The clamp keepout disagreed with its own picture**, on a steel clamp at 43 HRC, with the
  axes transposed. Two hand-keyed tables; nothing in `gates/` read either; `App.tsx` asserted in
  a comment that they *"cannot disagree"* — the sentence that stopped the next reader checking.
- 🔴 **The AGPL gate read one surface of two.** The login screen's copy of the dead §13 link was
  invisible to it — and `README.md` already recorded that exact failure mode as *retired*.
- 🔴 **The operator's spindle RPM was scraped by regex from a note that does not exist.** Not
  reading the plan instead of the output — reading *prose about* the plan.
- 🔴 **The terminology sweep covered 10 of 63 files** while its own header wrote the rule nothing
  enforced. `AuthGate.tsx` was outside it. One real defect inside: a refusal an operator reads
  used `bed`, the term canon S1 retires, meaning neither of the two things it is ambiguous
  between.
- 🔴 **Nine documented blockers the code had already discharged**, including a safety claim in a
  *"Read this first"* block: `design-68` said the keepout tests move endpoints only; it has
  walked swept segments since 2026-08-10.
- 🔴 **`clearance_z` "lifts every rapid"** in two documents. It **refuses** one. A lift means the
  machine gets itself out of the way; a refusal means the program does not come out.

## What that says about the method

Every fix here landed with a test, and **four of them were still wrong**. The tests were not
weak — they were written by whoever wrote the fix, so they encode the same understanding. What
caught these was a second party with a different question, and the cheapest version of that is
what this file is: write down what was measured, and let someone else read it.

The corollary is uncomfortable and worth stating: **this round's fixes have not had that
treatment either.** They are watched-red, which is better than green, and it is not the same
thing.

---

# Rounds three and four — the method, now that it has run four times

Four review passes over one day's work. Each one found the previous round's fixes defective. The
counts, so the trend is a measurement rather than an impression:

| Round | What the review found in the round before it |
|---|---|
| 1 → 2 | 4 of the round's fixes were wrong, incl. one still fully reachable in the built app |
| 2 → 3 | 8 findings, 2 of them operator-facing strings contradicting a correction made hours earlier |
| 3 → 4 | 4 criticals + 8 warns, incl. an SVG leader stating a threshold **2 mm below** the one enforced |

**It has not converged, and pretending otherwise would be the same mistake in a new place.**
What has changed is the *kind* of finding: round two's were "the fix does not work", round four's
are "the fix works and something adjacent to it does not". That is progress and it is not
completion.

## The one transferable lesson

**A correction's own sweep misses the paraphrase.** Three of round four's four criticals were the
retracted claim *"clearance_z lifts every rapid"*, surviving as:

- *"Every rapid must clear it"* — an operator-facing warn caption
- *"why every rapid over this must be **lifted**"* — a catalogue note **seventy lines below that
  same file's correction**, rendered in the picker's property pane
- *"rapid must clear this — {height − stock} mm"* — an SVG leader, which also had the arithmetic
  wrong

The sweep that retracted the claim grepped the retracted **sentence** (`on every rapid`) and
found the two copies that used those exact words. **Grep the claim, not the wording**: `lift`,
`every rapid`, `must clear`.

## Two things that took a second attempt, recorded because the first attempt is the lesson

**A plant that fires is not a plant that fires correctly.** The negative control for the
draft-data-loss fix fired on the *save helper* instead of the data-loss assertion — it went red,
which is what a careless reading calls success. Rebuilt until it failed on
`the unsaved edit was destroyed by looking at another row`.

**Two false reds from two numeric rules mean the question was never numeric.** The guard against
prose restating a derived figure was first written as "within 20%" (fired on a clamp clearance
vs the stock thickness), then "same to 2 significant figures" (fired on a 17.8 mm dog under an
18 mm workpiece). Both are real captions whose whole point is the contrast. The rule that works
asks whether the panel states the derived value *at all* — and the hole that leaves is named in
the test rather than closed, because no numeric rule separates those sentences.

## What is still true at the end of it

Nothing here has cut anything. One board has parsed one program once, on a bare rig, and that
transcript is still inadmissible. **Air cut → foam/MDF coupon → real ply are unclimbed.** Three
gates cannot run on this box and their reasons are a bench, a bench and a legal decision.

The suites are green — 693 + 22 Rust, 1151 node, 99 browser, 54 gate under `--quick` — and after
four rounds the honest reading of that is: *green means no one has found the next one yet*.
