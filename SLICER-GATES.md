# 2bee.app Gate Requirements

Shared definition of "done" for the web CNC slicer — the CAM companion to
[`software/frontend/FRONTEND-GATES.md`](../frontend/FRONTEND-GATES.md),
[`hardware/pcb/PCB-GATES.md`](../../hardware/pcb/PCB-GATES.md) and
[`hardware/cad/CAD-GATES.md`](../../hardware/cad/CAD-GATES.md).

Machine-checkable items are enforced by [`gates/slicer_gate_check.mjs`](gates/slicer_gate_check.mjs).

```
node gates/slicer_gate_check.mjs          # full gate (rebuilds release)
node gates/slicer_gate_check.mjs --quick  # skip the rebuild AND the browser
node gates/slicer_gate_check.mjs --list   # the gate table, what each guards, the PENDING budget
node gates/slicer_gate_check.mjs --self-plant <name>   # negative control for the HARNESS itself
```

🔴 **Those four are the WHOLE vocabulary, and anything else is REFUSED — exit 2,
empty stdout, before the runner builds, spawns or writes anything.** There is no
`--help` and there is **no `--only`**; a run is every gate or none. Until
2026-08-11 an unrecognised argument was silently swallowed and **started a full
pass, which regenerates the committed `web/src/wasm`** — so a typo rewrote a
tracked build product. Gate **FLAG** limb 5 holds the harness to the same
contract it holds the CLI to; see its section below.

**Three exit codes, because there are three answers:**

| Exit | Verdict | Means |
|---|---|---|
| 0 | `GO` | every gate ran and answered |
| 3 | `INCOMPLETE` | nothing failed; a **budgeted** gate could not run here. **Not a pass.** |
| 1 | `NO-GO` | a gate ran and did not pass — **or was disarmed into PENDING** |

## Why this file reads differently to a normal test plan

**Output from this program moves a 2.2 kW spindle.** A defect here is not a bad
render — it is a broken cutter, a gouged spoilboard, or a part thrown out of a
fixture. So three rules bind, and they are not negotiable:

1. **Every check names the physical failure it guards.** If you weaken one, say
   in the commit which physical failure you are choosing to stop guarding.
2. **Every HARD gate carries a negative control** — a planted defect that must
   make it go red. *A gate nobody has watched fail is not a gate.* The control
   asserts the **VERDICT** line, not the gate's own message; those are different
   questions and only the first one blocks a ship.

   **The red run goes in the COMMIT BODY. Here is how — this is the step that
   keeps getting missed:**

   ```bash
   cat > /tmp/msg.txt <<'EOF'
   slicer: <subject>

   <the pasted RED transcript>
   EOF
   ./gcommit -F /tmp/msg.txt <path> [<path>...]
   ```

   🔴 **`gcommit` DOES take a body — `-F <file>` — and its own usage line says
   so:** `gcommit [--session=…] "<msg>"|-F <file>|- <path>…`. Three separate
   commits have now shipped with only a subject and recorded the transcript in
   THIS FILE instead, and at least one author concluded the tool could not do it
   and filed a tooling defect. **It is not a tooling defect, it is an unwritten
   mechanism** — the rule said what to produce and never said how, so each
   author rediscovered the gap and worked around it the same way.

   ⚠ Recording the transcript here instead is a reasonable fallback and NOT a
   silent failure — but it separates the evidence from the change it proves, so
   a later reader auditing one commit cannot see the red that armed it. Prefer
   the body. *(`-` also works, reading the message from stdin.)*
3. **A check that cannot run reports PENDING, never PASS.** A green that means
   "unchecked" is worse than a red.

4. 🔴 **AND A PENDING MUST NOT READ AS A GO.** Rule 3 was honoured in every gate
   and broken in the one line that decides what the run *says*. Measured
   2026-08-10, **same tree, same binary, minutes apart**:

   ```
   $ node gates/slicer_gate_check.mjs
   ================ 46 passed, 1 failed, 1 pending ==========
   VERDICT: NO-GO                                            (exit 1)

   $ node gates/slicer_gate_check.mjs --quick
   ================ 46 passed, 0 failed, 2 pending ==========
   VERDICT: GO                                               (exit 0)
   ```

   `--quick` had not skipped a check. **It converted the only FAILING gate into a
   PENDING one and flipped the verdict.** The cause was one line: `pending` was
   counted, printed in a NOTE, and then discarded — `failed === 0 ? 'GO' : 'NO-GO'`.

   Why that is structural and not cosmetic: **rule 2 says a negative control
   asserts the VERDICT line.** So every control in this suite was blind to any
   defect that *disarms* a gate instead of failing it. Delete `web/src/wasm` and
   K3 pends; move brand's master and BRND pends; take `rotation_deg` out of
   `ClampCfg` and P7R pends; break the probe dump and PROBE pends. **All of them
   read GO.** BRND's own comment records watching exactly this happen — *"the one
   edit that permanently disarms this check was the one edit it waved through"* —
   and the fix made **that one branch** FAIL. The hole was one gate narrower, not
   closed.

   **How it is closed, and the choice that was NOT made.** The tidy fix is
   `GO requires failed === 0 && pending === 0`. It is wrong: `CTRL` cannot pass
   on any box without a controller on the USB cable, so every full run would read
   NO-GO forever, and **a verdict that is permanently red stops being read** —
   which is how a real red gets missed. The honest distinction is between *"could
   not run HERE"* and *"ran and did not pass"*, and the wording and the exit code
   both have to carry it.

   So PENDING is **budgeted**. `PENDING_BUDGET` in the gate file names each gate
   allowed to decline, the condition, and the reason; today it is eight entries
   (`CTRL`, `RUN`, `AGPL` always; `CAD1`, `CAD1H`, `BRND` always; `I1`, `SPLNT`
   under `--quick` only). **A PENDING outside that budget is scored as a FAIL**, so a disarmed
   gate reads NO-GO through the same line every control asserts on. A budgeted
   PENDING gives `INCOMPLETE`, exit 3 — not a pass, not a failure, and **not a
   string a negative control may accept**.

   ⚠ **The third verdict is deliberately not called `GO-WITH-GAPS`.**
   `grep 'VERDICT: GO'` matches that. Whatever a gap verdict is named, it must
   not be a prefix-match for the string a clean run prints, or every control that
   greps for a pass keeps passing.

   ⚠ **Adding a `PENDING_BUDGET` entry is a decision, not a cleanup.** It moves a
   gate from *must answer* to *may decline*, and the only thing between that and
   a suite where everything declines is that the list is short, dated, and read
   in review. If you add one, say in the commit which failure you have chosen to
   stop being able to detect.

5. **`--self-plant` is the negative control for the HARNESS.** `--plant` puts a
   defect in the **product** and stays the right tool whenever the product is
   what is under test. It cannot reach three things this file now asserts:

   - **the scoring itself** — nothing a plant does to the core can make the
     verdict line mis-report a PENDING, because the verdict is computed in the
     harness;
   - **a staleness check** — planting `STALE` means editing `core/src`, which is
     another lane's tree on most days;
   - **non-vacuity of a comparison** — `P8` asserts emitted positions against an
     expectation computed in the harness, and perturbing the **expectation** is
     what proves the comparison is live. No product defect does that.

   Two properties keep it from becoming a way to make a bad tree look good: every
   entry can only **remove** greens, and **a self-planted run may never print
   `VERDICT: GO`** — if the plant leaves the run clean, that is the finding (the
   control planted nothing) and the run exits 1 saying so.

   | `--self-plant` | Restores / corrupts | Must go red |
   |---|---|---|
   | `verdict-go-on-gaps` | the pre-2026-08-10 verdict rule verbatim — `pending` counted, printed, discarded | `VERD` |
   | `pend-unbudgeted` | a gate outside the budget forced to PENDING | that gate, converted to **FAIL** |
   | `pend-budgeted` | a budgeted gate forced to PENDING | nothing — it must survive as a **gap**, which is the paired positive: without it, "unbudgeted pends fail" could be satisfied by "everything fails" |
   | `stale-core` | the recomputed core digest, salted | `STALE` |
   | `p4-count-all` | the pre-fix relief counter — every canned cycle counted as a relief | `P4`, on the plate leg |
   | `p8-expect-shift` | `P8`'s own expectation, moved 1mm | `P8` |
   | `doc-roster` | a gate id that has no row in this file | `GDOC` |
   | `cad1-oracle-plant` | drives `tools/scad_oracle` under **its own** `mesh-scale` plant | `CAD1` only — **measured INERT on `CAD1H`**, see the note under CAD1H |
   | `cad1-baseline-slack` | gives each CAD baseline **one entry of slack** — a case that is not diverging, and `max + 1` | `CAD1` on the **ratchet-down** limb, `CAD1H` on the **doc-disagreement** limb — the halves that stop a baseline being quietly raised |
   | `cad1-verdict-unknown` | one oracle row's **verdict word**, corrupted to something this file does not model | **both** `CAD1` and `CAD1H`, naming the word — never counted as a silent zero |
   | `cad1-ledger-unlisted` | one **corpus** name and one **hardware** name added to the oracle ledger's `fresh` list | `CAD1` on the corpus name and `CAD1H` on the hardware one, **separately** — the two legs must not fail for each other's file |
   | `cad1-ledger-absent` | the oracle's `stricterLedger` object, **deleted from its JSON** | **both**, as a BROKEN INSTRUMENT — an absent ledger must not read as a ledger with nothing to say |
   | `cad1-ledger-bookkeeping` | a ledger failure in a **category this gate does not model** | **both** — the enumeration limb watching itself |
   | `cad1-undecided-unlisted` | one **hardware** oracle row, PENDING with a reason none of the ruled undecidable classes carry | `CAD1H` — the narrowed UNDECIDED limb must still fail an unlisted reason, and this is the watch that it does |

   ⚠ **The salt in `stale-core` is an XOR, and the first draft was not.** It set
   the leading hex digit to `f`, which is **vacuous one time in sixteen** — on a
   tree whose digest already began with `f` the plant would have produced an
   identical id, the gate would have stayed green, and the control would have
   read as passing. A negative control with a 1-in-16 silent failure is exactly
   what gate `PLANT` exists to find in other people's work.

   ⚠ **`p8-expect-shift` also caught a defect in its own gate's message**: the
   diagnostic recomputed the comparison *without* the bias, so the planted run
   failed correctly and then reported *"first disagreement at index -1"* — a true
   red whose message said nothing disagreed. The assertion and the diagnostic now
   share one predicate. **Running the plant is what found it; reading the code
   would not have.**

## Stage ladder

Each `→` is an audit/fix loop: run the gate, record findings, fix **in the
source**, re-run. Gates are strictly ordered; no skipping.

```
Spec → Geometry-intake → Offset/Toolpath → Post/dialect → Physical-safety
  → Determinism/golden → UI-smoke → E2E(browser) → Controller-acceptance
  → Air-cut → Coupon → Ply
```

The last three rungs are physical and are **never skipped**:
**air cut → foam/MDF coupon → real ply.**

**Controller-acceptance** was added 2026-08-08, when a Raspberry Pi Zero 2 W and
an SKR — board only, no motors, no spindle — first became available. It sits
below the air cut because **it needs no machine**: it asks a real controller
whether it accepts the program, and nothing moves. Gate **CTRL**; harness
`tools/controller_probe.py`; transcripts in `gates/controller/`.
⚠ **It is a parse, not a motion.** A green CTRL says the words were accepted by
that build. It says nothing about feeds, depth, holding or a part, and it must
never be quoted as an air cut.

## HARD gates — implemented and armed

🔴 **"Each has been seen going red" — CORRECTED 2026-09-04, and this sentence had
been false for a while rather than wrong on arrival.** It was true when this file
listed **29** gates. The table is **61** now, and `gates/promise_audit.mjs`
measures **40 with at least one declared plant, 21 with none — 17 of those a
genuine gap** (the other 4 are judged, with reasons recorded in the tool).

⚠ **Nobody re-checked it as the suite doubled, because ADDING A GATE NEVER FAILS
A SENTENCE THAT CLAIMS EVERY GATE HAS A CONTROL.** A per-item promise written as
prose does not notice new items.

⚠ **And the unplanted set is not a random 17:** it is disproportionately the gates
guarding a PHYSICAL failure — `ENT`, `G9`, `G11`, `LEAD`, `DOC`, `P7R` — and
`G13`, whose own subject is failing closed. **That distribution has a mechanism,
printed by the audit tool on every run: every product plant corrupts an INPUT,
while those gates measure the ENGINE, so the plant framework cannot currently
express them.**

`--plant <name>` on the CLI produces the defect on demand for the 40 that have
one; that flag exists for this and nothing else. **Run `node
gates/promise_audit.mjs` for the live split — never read the numbers above as
current.**

| # | Gate | Physical failure it guards | Negative control |
|---|---|---|---|
| G0 | Build + unit tests | a core that will not compile cannot be reasoned about | build break |
| G1 | Determinism | golden files are worthless if identical input drifts | 3-run hash compare |
| G2 | Dialect | an FFF word in a CNC program is a command the controller may obey | banned-word scan over **five** programs; `--self-plant g2-input-narrow` (the set narrows back to one fixture) · `--self-plant g2-comment-escape` (the post's paren sanitiser regresses) |
| G3 | Travel limits | a move past the travel drives the gantry into its own frame | `--plant offbed` |
| G4 | Spoilboard | cutting past the workpiece puts the cutter in the spoilboard | `--plant deep` |
| G5 | Comment injection | a paren in a name ends the comment; the rest executes | `--plant paren` |
| G6 | Spindle | feeding a stationary cutter into ply snaps it | `--plant spindle-off` |
| G7 | Arc emission | polylined curves flood the planner and stutter the finish | `--no-arcs` |
| G8 | Arc precondition | an arc with no known start has undefined I/J — a wild move | `--plant arc-first` |
| G9 | Peck cycle | a drill with no peck packs the flutes and burns the hole | drill fixture |
| G10 | Block rate | segments shorter than the planner can consume stall the feed | median-segment math |
| G11 | Z-zero setting bites | a setting consumed by nothing reads as configured | `--spoilboard-zero` diff |
| G12 | Feeds from chipload | a feed not derived from the tool burns the edge | exact `rpm x flutes x chipload` |
| G13 | Fail closed | a rejected program that still prints G-code gets run anyway | stdout must be empty |
| G14 | Binary stability | a build mid-gate compares two different programs | hash at start and end |
| STALE | Binary currency | the suite answers about a binary older than the source: 47 true answers to a question nobody asked. **`--quick` opens this and nothing detected it** — `cargo test` compiles today's source while every other gate drives a binary built whenever someone last rebuilt. G14 hashes the same stale file twice; K3 compares CLI to wasm and two equally stale artefacts agree perfectly | `--self-plant stale-core` (salts the recomputed digest, so a genuinely current tree must go red). The digest is `core/build.rs`'s FNV-1a/64 + splitmix, recomputed independently in the harness and **verified byte-exact against a real build**: snapshot `core/src`, `cargo build --release`, digest the snapshot → `d7a8e68f6e4e` = `2bee-slice buildid` |
| VERD | The verdict itself | every other gate here guards the product; this one guards **the sentence**, and rule 2 makes every negative control assert on that sentence. The line could not tell *"48 gates answered"* from *"47 answered and one was switched off"*, so a defect here is not one gate going quiet — it is all of them at once | `--self-plant verdict-go-on-gaps` restores the pre-2026-08-10 rule verbatim (`failed === 0 ? 'GO' : 'NO-GO'`) and VERD must go red. The truth table is asserted on **every pass** and includes the `INCOMPLETE` branch, which matters because this box cannot currently reach a zero-failure run — without the table that branch would be one nobody had ever seen behave. Plus the prefix limb: no verdict may be a prefix of another (`grep 'VERDICT: GO'` matches `GO-WITH-GAPS`), only `GO` may exit 0, and neither non-GO **line** may contain the string a control greps for |
| GDOC | This document's own claims | **SLICER-GATES.md says which gates are armed and where their reds are, and nothing read it.** SPEC parses `FUNCTIONAL-SPEC.md` only. That is how MOVE's row promised four witnessed reds, *"below"*, with no MOVE section and no transcript anywhere in the tree, and how `DINV`, `BRND` and `CTRL` ran on every pass with no row here at all. ⚠ Note the wording of this very cell: limb B's needle is the claim phrase, so a row **discussing** the claim matches it — this gate went red on its own table row and on the MOVE correction on their first run, which is [a scanner matching the text that discusses what it scans for] and is the same defect G2 and G12 both hit. The needle stays narrow and the prose steps around it; do not widen one without re-reading the other — a gate absent from this table reads as a gate that does not exist | `--self-plant doc-roster` for limb A. Limbs B and C are planted the way SPEC's is — an edit to the document under test, because that edit **is** the defect |
| DISC | The disclosures are still printed | 🔴 **The self-limiting caveats are the one artefact nothing guarded.** `pnp` measured it fleet-wide and ceo ruled it (`0ez`, 2026-09-06): a caveat inside a **PASS** branch can be deleted, reworded into meaninglessness, or silently stop firing and **no control moves** — their sweep classified runs on a `FAIL` prefix, so text inside a pass is invisible to it by construction and the output was **byte-identical** after a deletion. ⚠ Unlike a broken check, removing a caveat makes a control read **stronger**: nothing reddens and the verdict looks better, which is why it is the last thing anyone re-checks. This lane held one of the three largest populations. **11 caveats are pinned and each must appear in the message its gate EMITTED** — asserted on the emitted text, never on the constant meant to produce it — and the list length is pinned too, because removing an entry would otherwise silence its caveat and leave this gate green. Reachability is separate and loud: a caveat pinned to pass-branch text is legitimately absent when its gate could not run, so that reports **PENDING by name**, never a pass. ⚠ **What it does NOT cover:** whether a caveat is still TRUE, or still the right caveat — this proves it was printed, which is a different fact from it being earned; and a caveat deleted from a gate that is ALREADY red or unrunnable here goes unnoticed, because the deletion and the gate's own silence are indistinguishable from this side. **Witnessed red below.** |
| SPLNT | The self-plants still plant | ⚠ **COUNT CORRECTED 2026-08-27: it is 34 `--self-plant` controls, not 31 — and the correction that said 33 was already wrong when it was committed: `agpl-surface-divergent` was added 31 seconds earlier in the same batch. ⚠ **That is the point of this row, not a footnote to it** — a count re-derived by hand on a shared working tree is stale on arrival. Count it — and this cell already disagreed with ITSELF, saying "31" in one clause and "33 children" in the next.** Counted by parsing the `SELF_PLANTS` object literal (grep `const SELF_PLANTS`): **34** keys. **Understated by three**, so the DRIVE limb was doing more work than the row credited it with. **Count by running `--self-plant ''`**, which prints the whole registry — one line per control, name and reason — to **stderr** and exits `2` (grep `--self-plant ''` in the runner; it happens before any build, so it is cheap and safe to run against a busy tree). Never read this cell for the number — the number moved twice this month and will move again. The wording below is left as written. **`PLANT` audits the 20 `--plant` PRODUCT plants; the `--self-plant` HARNESS controls were audited by nothing.** A self-plant is a negative control on a *gate* — apply it and a named gate must go red — so one whose branch was refactored away, whose needle was absorbed, or whose target moved **applies, reports success, and reddens nothing**, which reads as *"the gate is fine"* when the truth is *"the control is dead"*. 🔴 **The one guard that existed was blind here.** The runner refuses `VERDICT: GO` under a self-plant, comparing against an **absolute** rather than against the clean baseline — so on a tree where anything is already red (`CAD1H` and `CADT`, for days) a plant that planted nothing printed the same `NO-GO` as the clean run. Measured 2026-08-12: **31/31 self-planted runs print `NO-GO`, and so does the clean one** | **Two limbs, and the gate names the subset each covers.** STATIC, every pass, milliseconds: a contract per entry, every contracted gate present in `GATES`, a **literal** `selfPlanted('<name>')` call site per entry and no call site without an entry — keyed to code, so a deleted branch or a renamed gate goes red by itself. DRIVE, **full pass only, measured 22.8 min for 33 children**: every plant driven as a `--quick` child against **two** clean baselines, and every declared target must move. `--self-plant splant-orphan` is the in-band control on STATIC. 🔴 **DRIVE has no in-band control** — one would need a child that itself runs DRIVE — and is witnessed on copies below |
| DOC | Depth + chip ceiling | a pass deeper than this machine class supports deflects the cutter into an out-of-tolerance wall, burns the glue line, and leaves the tool buried when the part lets go — **and the first failure is silent**: a joint that does not fit and gets blamed on the CAD | revert a `max_doc_ratio()` / `chipload_factor()` arm to its pre-#38 value + rebuild; **plus an in-gate control that runs on every pass** |
| K3 | Core fingerprint | a stale wasm agrees with itself, so I1 passes on output neither host should still be emitting | edit a `core/src` file, do NOT rebuild the wasm |
| SPEC | Spec citations | a spec row naming a gate that does not exist reads as gated and is not — nobody re-derives the coverage, they read the ✅ | add a row citing `G-NONSENSE` to `FUNCTIONAL-SPEC.md` |
| CAD1 | Our SCAD subset vs real OpenSCAD | a `.scad` source the `2bee.cad` tab evaluates into a **different part** from the one the author wrote and OpenSCAD renders. **Nothing downstream can notice** — every contour is a real contour of a real solid, so the wrong part posts, simulates, gates green and gets cut. The `!` root modifier emitted **the opposite object** until it was fixed on the day this gate was wired | `--self-plant cad1-oracle-plant` drives the oracle's own `mesh-scale`; `--self-plant cad1-baseline-slack` proves the ratchet-down limb; four more — `cad1-verdict-unknown`, `cad1-ledger-unlisted`, `cad1-ledger-absent`, `cad1-ledger-bookkeeping` — drive the limbs added when the oracle's refusal went three-valued. **Eight witnessed reds below**, one of them unplanted |
| CAD1H | The same, against the models we cut (**72**, not 73 — see the correction in this cell) | 🔴 **NUMBERS CORRECTED 2026-08-27 — every figure in this cell is stale, and the cell had ALREADY been corrected once for exactly this, in a parenthesis that is still sitting in it.** The authority is the gate's own constant `CAD1H_BASELINE` (`gates/slicer_gate_check.mjs:889-896`), read at the source on 2026-08-27: **`max: 7`, `since: '2026-08-27'`**, against a corpus of **72** real hive models. **(a) The corpus is 72, not 73.** The `why` chain records why: 12 untracked `_*.scad` scratch slices had entered the scan set on 08-17 and `cad` deleted them on 08-22, *"restoring the 72-file set"*. ⚠ **`gates/slicer_gate_check.mjs:5852` still says "73 real hive models" in a comment** — a third copy, not fixed here because this lane does not edit the runner in this pass. **(b) The tracked count is 7, not 16** — ratcheted 31 → 16 (08-14) → 10 (08-22) → 7 (08-27); the last move was the KERNEL (`scad.ts` carrying `$fn` on `rotate_extrude`/`linear_extrude`), not the instrument. **(c) `UNDECIDED` is 45**, per the same `why` (*"UNDECIDED rose 42 -> 45 in the same step: three files left the tracked count and ZERO became agreements"*), so the ratchet down is **not** all progress and the constant says so itself. **(d) The `Two of 73 … produce a solid we agree with` claim is REPLACED BY NOTHING, deliberately.** `CAD1H_BASELINE` tracks `DIVERGES + ERROR`; it does **not** track agreements, so no agreement count can be read out of the gate — and this row has already published one wrong agreement count once. Subtracting (72 − 7 − 45 = 20) would be a number nobody measured wearing the authority of one that was, which is the defect the cell's own parenthesis below was written about. **Take the tracked figure from `CAD1H_BASELINE`, and get an agreement count by running the oracle** (`tools/scad_oracle`), not from this document. **Direction: OVERSTATED severity** — the cell reports more than twice the divergences the gate now baselines, and a red that overstates trains the reader to discount it. Everything after this bracket is the pre-2026-08-27 text, kept as the record. — the same failure where it is not hypothetical. **Two of 73 real hive models produce a solid we agree with** *(corrected 2026-08-14 — this cell said "zero of 68" long after `93b83a472c` made it two; a stale 🔴 misleads exactly like a stale ✅)*. A **tracked number**, not pass/fail — §4's reasoning about a permanently-red verdict applies here too. The number is `DIVERGES + ERROR`, so `REFUSED → DIVERGES` counts as **worse** even though it looks like new capability: a refusal emits nothing, a divergence emits a plausible wrong part. 2026-08-14: the tracked count is **16** after the oracle-instrument fix (15 of the 31 were measurement artefacts — see the UNDECIDED-class section), and the **38 UNDECIDED** ride in every message, each inside a named, ruled class | the **doc-disagreement**, **ratchet-down** and **worse** limbs, each watched red — **transcripts below** — plus `cad1-undecided-unlisted` (2026-08-14) on the narrowed UNDECIDED limb's unlisted half. ⚠ This cell used to call `cad1-oracle-plant` **INERT here**; the dated note below retired that on 2026-08-12, and today the plant moves the touching-area files PENDING→DIVERGES so the **worse** limb fires |
| RUN | The Run tab's sender | a sender that stalls mid-cut leaves a **turning cutter stationary in the material** — it burns the edge and on a small cutter it snaps, which is why the transport choice (character counting against a **measured** buffer) is a safety property and not a performance one. And a sender that misreads the machine's state starts a job on a machine whose position is unknown, or rapids **downward** through the stock because the stored `G54` Z belonged to the last job. 🔴 **Every green here is about OUR OWN READING of grblHAL** — `web/src/run/fake.ts` was written from grblHAL's C by this lane, so it can prove the sender self-consistent and can never discover the reading is wrong. ⚠ Until 2026-08-11 the 147 assertions about this tab were driven by **no gate at all**: `npm run test:node` sat in `web/package.json` and nothing invoked it | three `--self-plant` controls, one per limb — `run-needle-drift`, `run-plant-inert`, `run-persona-instrument` — **three witnessed reds below**. The sixteen protocol plants are additionally driven **through the real modules** on every pass, clean and planted, and an INERT one fails the gate |
| CADT | The CAD tab's own suite | **`npm run test:node` runs `tests/*.test.ts`; gate RUN drives two of those files and NOTHING drove the other 27** — 509 assertions covering the SCAD parser and its import host, the degree trigonometry, the mesh/record round trip, the store's schema and collections, the preview's stale banner, the model-proposal path and the no-WebGL degradation. A suite nobody schedules is a file that agrees with itself whenever somebody remembers to look at it. 🔴 The failure class is the one CAD1 names — a source that evaluates into a **different part**, arriving through a wrong-unit rotation, a construct skipped instead of named, an import resolved out of the wrong folder, a stale mesh cut as current, or a model's text applied instead of proposed. ⚠ **14 branches are NAMED and the other ~440 assertions are not**, deliberately: a branch list nobody maintains rots into renamed tests all reporting the same green, so a name is spent only where a rename silently unguards a wrong part. The file set is **discovered, never enumerated**, and RUN's two exclusions are asserted to exist — a stale exclusion drops a file out of both gates while both still look complete | three `--self-plant` controls, one per limb — `cadt-needle-drift`, `cadt-file-blind`, `cadt-summary-blind` — **three witnessed reds below**, plus a **transient unplanted red** that is the reason the `cad-src` digest is printed at all — see the section below |

| TSC | The tree still compiles | 🔴 **committed code that does not compile was green through the whole suite.** Measured 2026-08-28: `a1efde7d92` landed three type errors in `web/e2e/run18.spec.ts`; `npm run typecheck` failed, `npm run build` therefore failed, and the full 59-gate run reported **56 passed, 0 failed, 3 budgeted pendings** over it — **no gate in the runner ran a compiler**. The physical chain is one step removed and real: a tree that does not compile cannot be built, so the **browser host of a two-host tool cannot ship**, and comparing the two hosts' bytes is the entire job of `K3` and `I1`. ⚠ **The two checks that look like they cover this do not, and BOTH ARE RIGHT NOT TO** — which is why the fix is a new gate rather than an edit to either. `web/tests/typecheck-coverage.test.ts` asks the compiler *which files are in its program* and says in its own 🔴 NOT ASSERTED block that it deliberately does not assert the tree is clean, so a real error produces one red and not two — and that one red was nobody's. `I1`'s Playwright `webServer` runs `vite build`, **not** `npm run build`, by a deliberate ruling recorded at `web/playwright.config.ts:159`: chaining the typecheck there made one lane's in-flight type error a precondition for another lane's suite (~40 min lost over four attempts, and two agents independently wrote the same bypass). esbuild strips types without checking them, so a **bundle builds green over code that does not compile** | three limbs — DOOR (the configs compiled are parsed out of `package.json`'s own `typecheck` script, never hardcoded beside it, so this gate cannot drift into testing a door nobody types), CLEAN (zero diagnostics per config), RAN (`--extendedDiagnostics` prints `Files: N` on success as well as failure, and a count below a floor of 50 is a mis-rooted program). Two `--self-plant` controls, one per limb that can carry one — `tsc-error-blind` writes a REAL type error into a REAL file in `web/src` (the defect, not the message; removed in a `finally`, and the gate fails if it survives), `tsc-runner-blind` swaps the compiler for a process that exits 0 in silence — **two witnessed reds below** |
| HOST | The two hosts' opening defaults | **the browser and the CLI hand the SAME core a DIFFERENT MACHINE when nobody has declared one.** Measured 2026-08-11 in `158658175e`: `job plate` exits 0 with four `G38.2` moves at the CLI's default and exits 1 with **zero bytes** at the browser's, on one core, one job, one afternoon. 🔴 **No gate could see it, and not by oversight** — `K3` compares the CORE and both hosts agree on it; `I1` compares one program planned from **one** config, which is the substitution that makes a host difference invisible; `PROBE` and `RPRB` are green because they only ever drive the CLI, whose default has the probe on. ⚠ **This gate does NOT assert the two defaults are equal** — and since the founder's 2026-08-14 ruling (*"keep all 5 divergences as-is"*) that is no longer a decision nobody has taken: equalising would now move AWAY from a ruling. It asserts the divergence is **declared**: every field the two hosts open differently on is in `DECLARED_HOST_DIVERGENCE` with a reason, and every field in that list **still diverges** | three `--self-plant` controls, one per limb — `host-undeclared`, `host-stale-entry`, `host-extract-blind` — **three witnessed reds below** |

### Gates that ran on every pass with NO ROW IN THIS FILE (added 2026-08-10)

Found by the gate-integrity audit and by gate `GDOC`'s first run. Each of these
had been live and scored for days or weeks; none of them appeared here, so a
reader taking this document as the roster — which is what it is for — would have
counted 45 gates and missed three. **The table was not wrong about them, it was
silent, and silence in a roster reads as absence.**

| # | Gate | Physical failure it guards | Negative control |
|---|---|---|---|
| DINV | Sim datum invariance | a verdict that changes when the workpiece is moved is an answer about a part nobody is cutting — an operator told a clean program is dirty, or worse, that a dirty one is clean | `--plant bed-anchored-sim`, driven at a MOVED datum because it is vacuous at 0 (where the machine-origin anchor and the placed geometry coincide), and the byte-identical-program half is asserted rather than assumed — if the plant ever starts changing the motion it has stopped being a control for the CHECK and become one for the cut |
| AGPL | Source offer (§13) | This lane is **AGPL-3.0-or-later**, and `AGENTS.md` calls the network source offer *"a licence obligation, not a nice-to-have"*. The footer link IS that offer. Measured 2026-08-10: it points at `https://github.com/2bee-farm/2bee.slicer`, which returns **HTTP 404** (control: `github.com` → 200, so the box is online and the 404 is real) — wrong org, wrong repo, and the lane renamed to `2bee.app` without the link moving. The only real repository is **private**, so even a corrected link delivers nothing. ⚠ **STALE CLAIM REMOVED 2026-08-12:** this cell used to add *"The same URL is in `Cargo.toml`"* — it is not, and has not been since 2026-08-11, when the `repository` key was deleted; the string survives there only inside the comment explaining its own removal, where it asserts nothing. **The live copy is ONE**, `web/src/App.tsx`. ⚠ The gate does NOT choose the fix: naming the target IS the Corresponding Source mechanism (public mirror / tarball / open the monorepo) and that is `legal`'s open decision. It refuses only to let a broken offer ship **unnoticed** — and since 2026-08-12 it also refuses to let a link that merely CHANGED read as one that works | **Rebuilt 2026-08-12. SEVEN WITNESSED REDS BELOW**, plus the one PASS branch and two PENDING paths — ten branches, every one driven, in the section *AGPL — three defects, and the ten branches now witnessed*. 🔴 **The 2026-08-10 witnessed PASS is now UNPRODUCIBLE and that is the fix, not a loss:** *"Pointing it at a DIFFERENT url: PASS — proving the gate keys on the known-dead link"* was a green awarded for the link having **changed**, which a different 404 satisfies. That branch is now a **FAIL** (`NO RULING NAMES IT`). The green now requires a target `legal` has ruled on **and** a live answer from it, and the ruling table ships **empty**. 🔴 The *"must become a FAIL the day a deploy target exists"* obligation was carried **by this sentence and by a comment, in no code at all** — it is now a probe, watched red both by `--self-plant agpl-published` and by a copy pointed at a name that really resolves. It still PENDS today, budgeted, because nothing is served **yet** — and the probe says which of *served* / *not served* / *UNCHECKED* it measured, because an offline box must not be able to render as compliance. 🔴 **2026-08-14: the *yet* is a ruling, not a guess** — founder, verbatim *"@software/2bee.app/ will served here"*: the domain is served-intent, not defensive, so the broken offer is **live-duty** and this budgeted pending is a deadline, not a contingency. What the ruling is NOT: publish-now (no DNS/deploy without a further word), and not `legal`'s mechanism ruling, which still blocks the offer itself. The ruling changes no branch — published with a dead or unruled offer was already a FAIL in code; what changed is what the pending means. ⚠ **ROUTABILITY FILTER ADDED 2026-08-28** — the publish probe discards private/loopback/link-local/CGNAT/documentation answers on both the target and the control name, closing the false-red class a hijacking resolver produced. `--self-plant agpl-hijack-blind` is its control: **one witnessed red below** |
| BRND | Vendored brand mark | `web/src/assets/2bee-farm-mark-*.svg` are COPIES of brand's masters. Each copy's header says so in capitals and records the source sha256 — an honest comment, and not a control: nothing compared the hash to the master again, so the day brand edits the mark this app renders the old one and the copy's own header is the only artefact claiming it is current | stripping the recorded `Source sha256` line. **Watched red, and the watching is what found the verdict defect**: it first turned the gate PENDING and the run still said `VERDICT: GO`, so the one edit that permanently disarms this check was the one edit it waved through. That branch now FAILs; the structural half is in `PENDING_BUDGET` |
| CTRL | Controller acceptance | canned cycles are a compile-time option in grblHAL, so a build without them answers `error:20` to the `G83` gate G9 is proud of — and G9 stays green | **cannot pass from this box and is not written so that it can.** With no transcript in `gates/controller/` it reports PENDING, which is the true state of *"no controller has ever seen our output"*. It is the one gate budgeted PENDING `always`, so a full run here reads **INCOMPLETE**, never GO |

### HOST — the two hosts' opening defaults (armed 2026-08-11)

`158658175e` chased fourteen failing browser expectations down to a cause and
found it was not a regression. The core is right. `App.tsx` opens with
`probeEnabled ?? false`, deliberately, dated 2026-08-09, with the reasoning on
the record: **if a plate thickness cannot be defaulted, the thing that requires
one must not be defaulted either.** `core/src/fixtures.rs::machine()` opens with
`probe_enabled: true` and a declared 1.6mm plate, equally deliberately, because
a reference job needs something to probe against. `plate` is multi-tool, a tool
change inserts a Z re-reference, and the core refuses a re-reference on a
machine with no probe — so the same job, the same core and the same day give:

```
$ ./target/release/2bee-slice job plate | wc -c
11708
$ ./target/release/2bee-slice job plate --config '{"machine":{"probe_enabled":false}}'
error: a Z re-reference was requested but the machine has no probe -
       Z would stay referenced to the previous tool's length
   exit 1, 0 bytes
```

**The failure this guards is not that a default is wrong.** It is that a program
which runs on one host and is refused on the other **reads as a regression** to
everyone who meets it, so the cause is looked for in the core — where it is not.
That search cost this lane a wasm rebuild that cured nothing before the seam was
found.

**Why no existing gate reaches it.** `K3` hashes the wasm's baked-in core digest
against the CLI's: both hosts agree on the core, and K3 has no way to express a
disagreement about the *machine they hand it*. `I1` compares one program the two
hosts emit — for a job it drives with the **same config on both sides**, which is
exactly the substitution that makes a host default invisible. `PROBE` and `RPRB`
are green on the CLI default. Three green gates, one live seam.

**What it refuses to assert, and why that is the design.** Not that the defaults
are equal. The CLI's `job <fixture>` is a reference setup this crate wrote, with
a machine declared; the browser opens before anybody has described a machine at
all. **A gate that forces an unruled decision gets reverted, and a reverted gate
guards nothing.** So it asserts the weaker, defensible property: the divergence
is *declared*, with a reason, and the declaration is still true.

**2026-08-14 — the equality question is now RULED, and the answer is keep them.**
Founder (ceo ticket `2026-08-14-ceo-FOUNDER-cadt10-yes-host-yes-cad1h-defer.md`):
**keep all five divergences as-is** — declared + safe-direction is the correct
end state; do not equalise. So `DECLARED_HOST_DIVERGENCE` is no longer a list
awaiting a decision: an entry leaving it is a change *away* from a ruling, and
this gate's limb D is what watches exactly that.

**Four limbs:**

| Limb | Asserts | Dies how, if unwatched |
|---|---|---|
| A EXTRACTION | the browser's opening `JobConfig` is read out of `App.tsx` **plus `web/src/store/cncStore.ts`** (the 2026-08-20 Zustand migration moved the `useState` opening values there; an App-only reader sees every key as absent, which emits jobs the browser refuses — measured live 2026-08-22 as 38 problems with the anchor reporting exit 0 where exit 1 is the recorded truth), every key resolves to a value, and every `...(cond ? A : B)` spread is declared with the branch the page opens on **and its condition hashed** | the reader silently returns nothing and the gate reports "0 divergences" — an extractor that reads nothing and two hosts that agree produce the same number of findings |
| B ANCHOR | that extracted config, handed to the CLI, **reproduces the browser's measured behaviour** — `job plate` exit 1, zero bytes, that sentence | the parse drifts from what the page opens with, and every comparison below is about a config nobody ships |
| C SWEEP | each field sent to the CLI **alone**, at the browser's opening value, against the CLI's own opening run — exit code, stdout **and stderr** | a divergence that moves only the report is read as agreement (this gate's own first pass did exactly that), or an agreement is banked on a fixture that could never have told the two values apart |
| D ROSTER | every divergence is in `DECLARED_HOST_DIVERGENCE`; every entry in it still diverges | an undeclared seam ships, or an exemption outlives the thing it exempts — and a stale exemption reads exactly like a live one |

**It compares programs, not literals, and that is load-bearing.** `op.entry`
diverges while both sides read `Ramp`: the browser sends **one** `op` block for
the whole job, so `Ramp` reaches operations the fixture built with their own
params — `plate`'s engraved part-number marks, which plunge — and the program
goes 11708B to 12588B. A source-level diff of the two defaults would have called
that field equal.

**And an agreement is only worth something if the fixture could have told.**
Every agreeing field is additionally driven at other values until one moves the
run; a field no value can move is reported `INERT` and **fails**, because that
is a setting consumed by nothing reading as configured — `G11`'s class arriving
through a host. On the first pass `clamps: []`, `material`, `drawing_offset` and
`spindle_max_rpm` all read INERT, and every one of them was a **harness fault**:
an empty-array "alternative" identical to the value under test, `MDF` and
`Plywood` giving byte-identical programs for a 6mm cutter, and a stdout-only
comparison that could not see the spindle-band warning at all.

#### The five divergences, as measured

| Field | Browser opens | Reaches | Fixtures |
|---|---|---|---|
| `machine.probe_enabled` | `false` | the program itself — `plate` REFUSES with 0 bytes; the others lose their probe block | all six |
| `tool_ids` | one cutter, `End Mill - Down-cut 6mm 2F` | `plate` S18000 to S24000 and drill feed F3600 to F4800; `pocket` refused outright | all six |
| `clamps` | `[]` — no workholding declared | the hold-down check goes from an answer to `PENDING (this is NOT a pass)` | `clamped` |
| `op.entry` | `Ramp` — **same value as the core default** | the marking ops acquire ramping moves, 11708B to 12588B | `plate` |
| `op.depth_per_pass_mm` | `4` | **byte-identical G-code**; eleven `depth per pass reduced from 4.00 to 1.59mm` notes the CLI operator never sees | `plate`, `pocket` |

🔴 **The first row is the open one.** Whether `App.tsx` or the fourteen e2e
expectations are the wrong half is a founder/owner decision and is deliberately
**not** taken here. The entry records that it is *known*, not that it is fine.

**Reach — this is not a fixture artefact.** `import` builds its job through the
same `fixtures::machine()`, so the divergence is on the DXF path a person
actually uses. Asserted as a program, not as a claim about the source: `import
gates/fixtures/plate.dxf` probes at the CLI default (`G38.2` present, 9430B) and
comes back 9224B at the browser's.

**Not covered, said rather than implied:** the CLI flags (`--collet`,
`--machine-x`, …), which are a caller's declaration and not a default; `nest`;
the browser's React state itself, since the opening values are read out of
`App.tsx` as **text** — which proves *unchanged*, never *true*, and is why every
conditional key carries a hash that must be re-decided rather than re-hashed.

**Three witnessed reds, one per limb.** Each was driven, not reasoned about:

```
$ node gates/slicer_gate_check.mjs --quick --self-plant host-undeclared
  SELF-PLANTED FAIL    HOST  THE TWO HOSTS' OPENING DEFAULTS 1 problem(s): UNDECLARED HOST
  DIVERGENCE on `machine.probe_enabled`: the browser opens with false and handing the core
  that ALONE changes the CLI's own opening run on plate, pocket, socket, multi-tool, clamped,
  two-part. Either it is intended - put it in DECLARED_HOST_DIVERGENCE with a reason and what
  the operator sees - or one of the two hosts is wrong
VERDICT: NO-GO
```

```
$ node gates/slicer_gate_check.mjs --quick --self-plant host-stale-entry
  SELF-PLANTED FAIL    HOST  THE TWO HOSTS' OPENING DEFAULTS 1 problem(s): STALE DECLARATION
  on `machine.safe_z_mm`: it is listed as an intended host divergence and it does NOT diverge
  any more (AGREES). A stale exemption reads exactly like a live one - delete the entry, or
  find out which host moved
VERDICT: NO-GO
```

```
$ node gates/slicer_gate_check.mjs --quick --self-plant host-extract-blind
  SELF-PLANTED FAIL    HOST  THE TWO HOSTS' OPENING DEFAULTS 11 problem(s): the browser's
  opening config extracted EMPTY - a dead instrument, not two hosts that agree. Every
  comparison below would pass vacuously | DECLARED_HOST_DIVERGENCE names
  `machine.probe_enabled` and the browser does not send that key at all - the declaration
  outlived the field it exempts ... | ...+8 more
VERDICT: NO-GO
```

⚠ The third one is the important control. A reader who only sees limbs C and D
would take "0 undeclared divergences" as the good outcome, and `host-extract-blind`
is what proves this gate can tell that from **having read nothing at all**.


### DISC — the disclosures are still printed (armed 2026-09-07)

🔴 **The class:** `pnp` measured it fleet-wide and `ceo` ruled it (`0ez`, 2026-09-06). A
self-limiting caveat inside a **PASS** branch can be deleted, reworded into meaninglessness, or
silently stop firing and **no control moves** — their sweep classified runs on a `FAIL` prefix, so
text inside a pass is invisible to it by construction, and the output was **byte-identical** after a
deletion. ⚠ Unlike a broken check, removing a caveat makes the control read **stronger**.

**Witnessed red, driven not reasoned about.** The plant DELETES a caveat out of a real emitted
message rather than announcing a synthetic problem — *a plant that pushes its own failure message
proves the FAIL branch renders and says nothing about detection:*

```
$ node gates/slicer_gate_check.mjs --quick --self-plant disclosure-deleted
  SELF-PLANTED FAIL    DISC  THE DISCLOSURES ARE STILL PRINTED 1 disclosure problem(s):
  CAD1 passed WITHOUT its caveat: "NOT CLEAN BY ABSENCE". A caveat that stops printing removes
  the only thing standing between this gate's number and a reader who over-reads it, and nothing
  else in this suite would have moved.
```

**And the clean run, which is the half that proves it is not simply always on:**

```
$ node gates/slicer_gate_check.mjs --quick
  PENDING DISC  THE DISCLOSURES ARE STILL PRINTED 9 of 11 caveat(s) confirmed in the text their
  gate emitted; 2 COULD NOT BE CHECKED because the gate did not pass here: AGPL did not run —
  "that what it serves is the Corresponding Source" untested. UNCHECKED IS NOT ABSENT and it is
  not present either.
```

⚠ **Four of the eleven pins were WRONG on the first pass** — the gate ids were derived by taking the
nearest preceding emit call in the source, which is a proxy rather than a measurement, and these
messages are multi-line template literals where another gate's call can sit between a caveat and its
own. The first clean run accused `TECH`, `MARK`, `PROBE` and `GDOC` of dropping caveats they were
printing perfectly. ⇒ ***A check that names the wrong owner does not fail safe — it manufactures a
defect in correct work.*** The ids are now read off the **emitted report**, which is the artefact the
check asserts on.

🔴 **What a green here does NOT say:** that a caveat is still TRUE, or still the right caveat — this
proves it was **printed**, which is a different fact from it being **earned**. And a caveat deleted
from a gate that is already red, or unrunnable on this box, goes unnoticed: the deletion and the
gate's own silence are indistinguishable from this side, which is why the PENDING names the
unchecked caveats rather than reporting a count.


### RUN — the Run tab's sender (armed 2026-08-11)

`docs/design-76-run-tab.md` §18 specified this gate with **18 branches** and a
named `--plant` per branch, and it did not exist. What watched the Run tab was
`web/tests/run.test.ts` and `web/tests/run-protocol.test.ts` — **147 assertions
about the only tab that talks to a motion controller, driven by nothing.**
`npm run test:node` was in `web/package.json` and no gate invoked it, so the
suite could have gone red in a commit and stayed red.

**Three limbs, because the three ways this coverage dies are unrelated:**

| Limb | Asserts | Dies how, if unwatched |
|---|---|---|
| A BRANCHES | every branch names test titles that must each match **exactly once** and pass | a test is renamed and the branch silently loses its assertion — indistinguishable, from inside the suite, from a test that was deleted |
| B PLANTS | all sixteen protocol plants are driven **through the real modules**, clean and planted, and the two answers must differ | a plant goes inert and its branch becomes decoration. This is gate `PLANT`'s founding failure (`wrong-drill` announced `PLANTED:` while changing nothing) arriving in the Run modules |
| C SUBJECT | which fake answered, **instrumented** at `FakeController.onData`/`.write`, printed with the fake's configuration line | the gate prints a green whose subject is unnamed. §18: *"a green whose subject is unnamed is a green nobody can audit"* |

⚠ **Limb C is instrumented, not scanned, and the difference is the point.** A
grep for `new FakeController('…')` in the test source answers *which personas
are written*; the design asks *which persona answered*. `gates/run_fake_probe.mjs`
is `--import`-ed ahead of the suite and wraps two prototype methods, so a persona
constructed in a branch that never executes does not appear. All **14** personas
in the registry are driven today, and a registered persona that no test drives
fails the gate.

🔴 **`RUN` is PENDING on this box, and it is not a pass.** Two conditions, both
in `PENDING_BUDGET` and both **tripwired** — if either becomes runnable while the
budget still claims it is not, the gate goes **red** and says the declaration is
stale:

1. **The controller half.** Nothing this lane emits has ever been offered to a
   board. `gates/controller/` holds a `README.md` and no transcript, and **this
   gate reads no transcript at all** — there is deliberately no arm in it that
   could pass quietly on an absent file.
2. **`RUN-18`** (throughput survives `document.visibilityState === 'hidden'`) —
   the branch the design calls *"the branch that decides the architecture"*. It
   needs a browser **and** a transport seam reachable from the served page;
   `App.tsx` hands `RunTab` a program and no transport, so there is nothing in
   the page to measure.

⚠ The design writes this budget entry with the **controller condition alone**.
The second is added here because `RUN-18` cannot run either, and a budget entry
naming one of two gaps is a pending that reads as narrower than it is.

🔴 **AND WHAT A GREEN HERE WOULD NOT SAY.** `web/src/run/fake.ts` is this lane's
model of grblHAL, written from grblHAL's own C **by this lane**. It can show the
sender is self-consistent with that reading; it **cannot discover the reading is
wrong.** `CTRL` and the physical rungs are what prove anything else. That
sentence is in the gate's own output on every run, not only here.

**Three witnessed reds, one per limb** (`--quick --self-plant <name>`, 2026-08-11).
⚠ The `did not pass` counts include unrelated reds from other lanes' live work in
`core/src` at the time — `RUN` is the `SELF-PLANTED FAIL` line, not the count:

```
##### run-needle-drift   (limb A: one branch's needles no longer match anything)
  SELF-PLANTED FAIL    RUN   THE RUN TAB'S SENDER   3 problem(s): RUN-9: no test matches
  "R3 - a first move that descends is refused ZZTOP" - the branch has lost its assertion.
  A renamed test is indistinguishable from a deleted one from inside the suite, and this
  is the only place that can tell | RUN-9: no test matches "R3 - an unmakeable comparison
  is a refusal ZZTOP" - ... | RUN-9: no test matches "first Z is read off the EMITTED TEXT
  ZZTOP" - ...
VERDICT: NO-GO - 5 gate(s) did not pass, and 3 could not run (I1, CTRL, AGPL).

##### run-plant-inert   (limb B: a plant that stops planting)
  SELF-PLANTED FAIL    RUN   THE RUN TAB'S SENDER   1 problem(s): plant `overcount` is
  INERT: clean and planted both answer {"overruns":0,"state":"done","wrote":5000,
  "stalled":false}. Its gate branch is decoration until it bites again - this is the
  failure gate PLANT was written for, arriving in the Run modules
VERDICT: NO-GO - 5 gate(s) did not pass, and 3 could not run (I1, CTRL, AGPL).

##### run-persona-instrument   (limb C: the instrument, not the measurement)
  SELF-PLANTED FAIL    RUN   THE RUN TAB'S SENDER   1 problem(s): the persona instrument
  recorded NOTHING. That is indistinguishable from a suite that drove no fake at all, and
  the safe reading is that the instrument is dead - check that gates/run_fake_probe.mjs is
  still --import-ed and still wrapping FakeController.prototype
VERDICT: NO-GO - 6 gate(s) did not pass, and 3 could not run (I1, CTRL, AGPL).
```

⚠ **Limb C's red is the one worth reading twice.** An empty persona log and *"no
fake was driven"* are the **same file**. Only one of those readings is safe, so
the gate takes the unsafe one as a dead instrument and fails — it never reports a
quiet zero.

**NOT COVERED by this gate, said rather than left to be found:** that any byte we
write is understood by grblHAL; that `navigator.serial` behaves as specified;
that a hidden tab keeps streaming; and, for limb B, that a planted answer is the
*specific* historical defect rather than merely a different answer — the plant
probes prove the switch still moves the product, and the tests carry the specific
assertions.

### CADT — everything under `test:node` that RUN does not drive (armed 2026-08-11)

Gate `RUN` was armed earlier the same day and closed **two files** of
`web/tests/`. It did not close the hole; it measured it. `npm run test:node`
runs `tests/*.test.ts`, and after RUN landed, **27 of the 29 files were still
driven by nothing** — 509 assertions covering the SCAD parser and its import
host, the degree trigonometry, the mesh/record round trip, the store's schema
and collections, the menu, the preview's stale banner, the model-proposal path
and the no-WebGL degradation. A suite nobody schedules is a file that agrees
with itself whenever somebody remembers to look at it.

**Why this is its own gate and not more branches on RUN.** RUN's verdict is
`PENDING` by budget and can never read `PASS` on this box — two of its branches
need a controller and a browser. Folding 509 assertions behind a permanent
pending would leave every one of them unable to say green, which is the same as
not gating them. CADT is fully runnable here and is deliberately **not** in
`PENDING_BUDGET`: it passes or it fails.

**Three limbs, because the three ways this coverage dies are unrelated:**

| Limb | Asserts | Dies how, if unwatched |
|---|---|---|
| A SUITE | the runner produced a TAP summary **and** `# fail 0` | the runner dies before it starts, emits zero `not ok` lines, and zero reds reads as a clean suite to anything that only counts reds |
| B BRANCHES | 14 named branches over 44 needles, each matching **exactly once** and passing | a test is renamed and the branch silently loses its assertion — from inside the suite a renamed test and a deleted one are the same thing |
| C DISCOVERY | the file set is read with `readdirSync`, and RUN's two exclusions are asserted to **exist** | a new test file lands outside the gate, or a stale exclusion drops a file out of *both* gates while both still look complete |

**How big the named list is allowed to get.** RUN names a branch per grblHAL
protocol property because each is a distinct safety property over a closed
vocabulary — eighteen, and finished. This suite is three times the size and
most of it is not safety-bearing: a menu that opens, a picker that sorts, a
resizable split. Naming all 509 would produce a gate nobody maintains, and an
unmaintained branch list rots into renamed tests all reporting the same green.
So a name is spent **only** where a rename silently unguards a wrong part that
looks right: a rotation in the wrong angular unit (CADT-1), a construct skipped
instead of named (CADT-2), an import resolved out of the wrong folder
(CADT-3/4/5), a mesh stored without verifying or cut while stale
(CADT-6/7/8/9), a model's applied reply losing the cautions it arrived with
(CADT-10) or describing a different part without saying so (CADT-11), a
credential shipped in an AGPL tree (CADT-12), an empty picture presented as an
empty part (CADT-13), and a collection dropped without being named (CADT-14).
Everything else is held by *"the suite is green"* — which is a hard condition of
this gate, not a soft one.

**Three witnessed reds, one per limb.** Each was driven, not reasoned about:

```
$ node gates/slicer_gate_check.mjs --quick --self-plant cadt-needle-drift
  SELF-PLANTED FAIL    CADT  THE CAD TAB'S OWN SUITE 3 problem(s): CADT-7: no test matches
  "an edited source with an unrefreshed mesh reports STALE, and names which half moved ZZTOP"
  - the branch has lost its assertion. A renamed test is indistinguishable from a deleted one
  from inside the suite, and this is the only place that can tell | CADT-7: no test matches
  "a stale record leads its descr...
```

```
$ node gates/slicer_gate_check.mjs --quick --self-plant cadt-file-blind
  SELF-PLANTED FAIL    CADT  THE CAD TAB'S OWN SUITE 10 problem(s): CADT-10: no test matches
  "a reply - however clean - produces no application" - the branch has lost its assertion.
  ... | CADT-10: no test matches "a BLOCKED proposal cannot be accepted, whatever the caller
  does" | CADT-10: no test matches "a whole round trip produces a reviewed proposal and NOT
  an application" | ...
```

```
$ node gates/slicer_gate_check.mjs --quick --self-plant cadt-summary-blind
  SELF-PLANTED FAIL    CADT  THE CAD TAB'S OWN SUITE 44 problem(s): the CAD suite produced no
  TAP summary - it did not run (exit 1). Zero failing tests and a dead runner are the same
  output to anything that only counts reds: (no output at all) | CADT-1: no test matches
  "sin and cos in degrees are exact where OpenSCAD is exact" | ...
```

**And an unplanted red that could not be reproduced an hour later — which is
the reason this gate prints a `cad-src` digest.** Measured at 13:0x on
2026-08-11, before the gate existed, by running the suite by hand:

```
$ node --import ./tests/register.mjs --test --test-reporter=tap tests/*.test.ts
# tests 656
# pass 654
# fail 2
not ok 209 - a file exported today carries the collection list and the warning for an older build
  location: 'web/tests/cad-record.test.ts:317:1'
    + actual - expected
      [ 'machines', 'workpieces', 'drawings', 'spoilboards', 'operations',
    +   'jobs',
        'inventory' ]
not ok 295 - the store file declares the new collection, so an older build reports it rather
             than dropping it silently
```

🔴 **And by the gate's first real run those two were green, with no commit
between.** `web/src/store.ts` is at its 12:50 committed state, `git status` is
clean, and the file contains no `jobs` collection at all. The only reading that
fits is that the failures were measured over **another session's uncommitted
working copy** — a `jobs` collection that existed in the tree for part of an
afternoon and was reverted before it was ever committed.

**Do not read this as "the gate found a defect", and do not read it as "there
was nothing there" either.** Both are stronger than the evidence. What was
observed is real — the control that makes an older build *report* an unknown
collection rather than silently drop it did not hold against that working copy —
but it is **not reproducible at any commit**, so it cannot be cited as a tree
defect and no ticket is raised from it. What it does prove is the thing the note
exists for: in a shared tree, a suite result is an answer about **bytes**, not
about a repository, and a green that does not name the bytes it was taken over
cannot be compared with tomorrow's. That is why every CADT run prints
`cad-src <digest> (working copy — not a commit)`, and why RUN and CAD1 print
theirs.

**NOT COVERED by this gate, said rather than left to be found:** that the DOM
agrees with the modules — these run in node under `tests/register.mjs` against
this lane's own fakes, and the browser is `I1`'s subject; that our reading of
OpenSCAD is right, which is `CAD1`/`CAD1H` against the real binary; and that an
unnamed assertion is a *good* assertion — limb A proves only that it is green.

### CADT-10 — decided twice: the property was removed on purpose, and the founder ruled the needles follow (2026-08-14)

🔴 **This was NOT contention, and it was reported as contention three times before
anybody traced it.** The gate was armed 2026-08-11 at 13:39 with all 14 branches
matching; `dcf4adeea6` at **15:02** renamed four tests in `web/tests/cad-ask.test.ts`
and `CADT-10` was red from then until the ruling below. Limb B did precisely what
it was built to do — from inside a suite, a renamed test and a deleted one are the
same thing, and the branch list is the only place that can tell them apart.

**The honest options were never *"restore the names"* or *"re-point the needles"*,
because the property did not survive the rename. It was removed on purpose.**
`dcf4adeea6` implemented a founder item — *"Enter sends, reply applies"* — and the
accept step this branch was named for went with it:

| old needle | what happened to it |
|---|---|
| `a reply — however clean — produces no application` | inverted: *"a clean reply applies itself, with no action in between"* |
| `a whole round trip produces a reviewed proposal and NOT an application` | inverted: *"…reviews the reply AND hands it to the editor, unpressed"* |
| `accept from any phase other than "proposed" produces nothing` | **deleted with its subject** — *"there is no accept control left to be dead"* |
| `a BLOCKED proposal cannot be accepted, whatever the caller does` | **survives**, renamed to *"a BLOCKED reply does not reach the editor, and does not vanish either"* |

**2026-08-14 — the founder RULED: update the needles** (ceo ticket
`2026-08-14-ceo-FOUNDER-cadt10-yes-host-yes-cad1h-defer.md`). The ruling's
substance: the old *"no application whatever the caller does"* world is gone on
purpose, and the needles must guard **the operator-reads-cautions risk**, not the
vanished auto-apply one. So the branch was re-stated — not weakened into silence:
the risk it guards moved from *"text reaches the editor without a human accept"*
to *"text reaches the editor and the cautions that came with it do not"*, because
the apply is now where the operator reads them. The new needle set:

| new needle | what it guards |
|---|---|
| `a clean reply applies itself, with no action in between` | the intended new behaviour exists at all — a regression here means the feature silently stopped applying |
| `applying does not throw away the review — it is the only thing left that can warn` | the cautions survive the apply |
| `a BLOCKED reply does not reach the editor, and does not vanish either` | the one refusal the contract still has, and its surfacing |
| `cautions do not stop an apply — only \`blocked\` does` | the `mayApply` door itself, in both directions |
| `“the evaluated geometry is IDENTICAL” survives the apply, and is not a grey note` | the loudest caution stays loud — prominent, not a footnote |

**What replaced the press is narrower than the old row, and it is not nothing:**
`mayApply` is the only door into the editor; a blocked reply **surfaces** rather
than applying or vanishing; the review survives the apply and is the only thing
left that can warn; and the tab owns exactly one put-back, which
`cad-replace.test.ts` exercises on the auto-applied path.

**The red's `why` did its job.** It held the branch red for three days with the
cause printed *after* the truncated problem list — never inside it, because the
sentence explaining a red must not be the thing that gets cut at four — and it
refused the one fix that must not be made from inside a gate (re-pointing needles
to clear a red) until the decision existed. The historical transcript, kept:

```
  FAIL    CADT  THE CAD TAB'S OWN SUITE 5 problem(s): … | CADT-10: no test matches "a whole
  round trip produces a reviewed proposal and NOT an application" — the branch has lost its
  assertion … | …+1 more ⚠ CADT-10: THE PROPERTY WAS REMOVED, NOT RENAMED, so do NOT
  re-point these needles. Traced 2026-08-11 to `dcf4adeea6` (15:02), a founder item —
  "Enter sends, reply applies" — which deletes the human accept this branch is named for …
  RED IS THE CORRECT STATE until that decision is recorded.
```

⚠ **A red that misdescribes its own cause is a stale red, and a stale red
misleads exactly like a stale green** — this one was read as contention for half
a day, which is time spent on the wrong question with a real capability change
sitting underneath it.

### MARK — repointed from the plan at the emitted program (2026-08-28)

The gate was green for weeks on `report.render`. `render` is real and is not the
program: `core/src/fixtures.rs` builds it from `r.path.moves`, which is the
planned toolpath **before the post runs**. Everything the post does — dropping a
move, rounding a coordinate, reordering, emitting a dialect that says something
else — was invisible here.

**Clean run, reading the emitted text:**

```
  PASS    MARK  PART MARKING   32 marking move(s) at engraving depth READ OUT OF THE EMITTED
  G-CODE (modal Z tracked; -1 < Z < -0.001), attributed by the ( op: … [tool] ) banner to 1
  marking op-tool(s) [End Mill - Down-cut 3.175mm 2F] distinct from the 1 other cutter(s)
  [End Mill - Down-cut 6mm 2F] over 17 banner(s). NOT COVERED: whether the mark is LEGIBLE or
  says the right thing — this checks that it is shallow, present and cut with its own cutter
```

**Witnessed red 1 — `--self-plant mark-depth-window`**, on `P8`'s precedent:
perturb the EXPECTATION, because there is no product defect that makes a gate
stop reading the Z it claims to read. The window is narrowed to a band no move
can occupy.

```
  SELF-PLANTED FAIL    MARK  PART MARKING   1 problem(s): 0 cutting move(s) attributed to a
  marking op at engraving depth (-1 < Z < -0.9) in the EMITTED text — a mark at full depth is
  a cut-out
```

**Witnessed red 2 — `--self-plant mark-banner-blind`**: strip every `( op: … )`
banner from the text the gate parses. It must go red because the marking moves
can no longer be attributed to an operation or to a cutter — **a gate that keeps
answering after its subject disappears has widened to an easier question**, which
is exactly how the plan-side version stayed green.

```
  SELF-PLANTED FAIL    MARK  PART MARKING   4 problem(s): no `( op: <name> [<tool>] )` banner in
  the emitted program — the marking moves cannot be attributed to an operation OR to a cutter,
  so a shallow move anywhere would answer for them | no operation whose name says it marks —
  nothing in this program claims to be a mark | 0 cutting move(s) attributed to a marking op at
  engraving depth (-1 < Z < -0.001) in the EMITTED text — a mark at full depth is a cut-out |
  the marking op(s) do not name their own cutter: mark=[] other=[] — an 8mm-tall mark cut with
  the profiling cutter is illegible
```

**What MARK does NOT cover**, said rather than implied: whether the mark is
LEGIBLE, and whether it says the right thing. It checks that a mark is present,
shallow, and cut with a cutter the profile ops do not use.

### Where the fixtures make RIGHT and WRONG agree — the map, so it is not re-derived (2026-08-30)

**Eight real defects in two days came from one question**, and it is cheaper to
write the question down than to rediscover it: *what does the fixture behind this
gate never vary?* A control exercised only where the correct and the incorrect
implementation give the same answer is untested, and it reports green either way.

That is not a criticism of the fixtures. A fixture is chosen to be
representative, and "representative" and "discriminating" are different
properties — the first is what makes a gate readable and the second is what makes
it a gate. **What follows is what the fixtures do NOT contain**, measured rather
than remembered.

**`gates/fixtures/plate.dxf`** — `LWPOLYLINE ×1`, `CIRCLE ×4`. That is all.

| absent | found because of it |
|---|---|
| any `ARC`; any **bulge** (code 42) | #154 — arc sweep past 180° and through 0°, and a bulge on the closing segment, were correct and had nothing holding them |
| any `INSERT` | **#153** — a mirrored block bulged its arcs the wrong way; a mirror did not preserve area. Every block path was reached only at scale 1 |
| any `POLYLINE`/`VERTEX` | **#151** — a polyface mesh read as a 2D outline, 10,399 bytes of runnable G-code; a stray `VERTEX` grafted onto the previous entity |
| any `TEXT`/`MTEXT`/`DIMENSION` | **#152** — a title block machined out of the sheet at full depth |
| `$INSUNITS` | the inch/mm assumption is stated on every import and nothing in the gate drives the inch branch |
| a part name containing `-hole`/`-inner` | **#146** — the release-order split was a substring match on a filename |
| more than one winding direction | #159 — offset direction is winding-independent, and nothing held it |

**`gates/fixtures/plate.svg`** — `<svg>`, `<rect>`, `<circle>`. No `transform`,
no `<path>`, no `<line>`. **Its `height="900"` equals the reference workpiece's
900 mm.**

| absent | found because of it |
|---|---|
| any `transform` | **#149** — a `<g transform>` imported every child at its untransformed coordinates |
| a height ≠ the workpiece height | **#150** — the Y flip used the WORKPIECE height, so changing the sheet moved the part 50 mm with `ok: true` |

**The job fixtures and the machine presets**

| absent | found because of it |
|---|---|
| a machine with `supports_canned_drill: false` | #157 — the hand-expanded peck ladder was driven by nothing at all |
| a tab spec that holds nothing | **#156** — `enabled: true, height 0` emitted a program byte-identical to tabs off |
| a self-intersecting outline | **#158** — cut a runnable program; the symmetric case was refused only because its lobes cancel to zero area |
| a non-finite machine or workpiece field | **#147** — a NaN thickness REMOVED the spoilboard clamp |

⚠ **Two of these were refused by ACCIDENT before they were refused on purpose**,
and that is the most misleading state a defect can be in. #151's polyface mesh
was rejected because its coordinates happened to fall outside the machine's
travel; #158's symmetric bowtie because its signed area cancelled to ~0. Both
looked handled on the first probe. **A refusal you did not ask for is not the
refusal you think you have** — move the input inside the sheet, or make it
asymmetric, before believing it.

⚠ **The map is a snapshot and will rot.** Re-measure it rather than trusting this
table: `python3 -c` over a fixture counting its `0`-code entity names took under a
minute and is what every row above came from.

### TSC — the tree still compiles (armed 2026-08-28)

**The defect it was written for, and the day it went unseen.** On 2026-08-28 an
end-to-end review re-ran `npm run typecheck` against committed code and found it
red: three type errors in `web/e2e/run18.spec.ts` from `a1efde7d92`. `npm run
build` chains the typecheck, so the build was red too. The **full 59-gate suite
had passed over it** — 56 passed, 0 failed, 3 budgeted pendings — because no gate
in the runner ran a compiler.

⚠ **Both checks that look like they cover this are correct, and neither covers
it.** That is why the fix is a new gate and not an edit to either:

- `web/tests/typecheck-coverage.test.ts` asks the compiler **which files are in
  its program** and compares that to the files on disk. Its own header says, in
  the 🔴 NOT ASSERTED block, that it deliberately does **not** assert the tree is
  clean — so a real error produces one red and not two. That one red was nobody's.
- `I1`'s Playwright `webServer` runs `vite build`, **not** `npm run build`, by a
  deliberate ruling recorded at `web/playwright.config.ts:159` — chaining the
  typecheck there made one lane's in-flight type error a precondition for another
  lane's suite. esbuild strips types without checking them, so **a bundle builds
  green over code that does not compile**.

**Three limbs.** DOOR: the configs compiled are parsed out of `package.json`'s
own `typecheck` script rather than hardcoded beside it, so this gate cannot drift
into testing a door nobody types. CLEAN: zero diagnostics per config. RAN:
`--extendedDiagnostics` prints `Files: N` on success as well as on failure, and a
count below a floor of 50 is a mis-rooted program.

**Clean run, same box, after the three errors were fixed:**

```
  PASS    TSC   THE TREE STILL COMPILES door: 2 config(s) read from package.json `typecheck` —
  tsconfig.json tsconfig.browser.json. tsconfig.json: clean over 712 files.
  tsconfig.browser.json: clean over 380 files. NOT COVERED: whether the code is CORRECT (every
  other gate), and the .mjs/.js files — `checkJs` is off, so they are read and not checked
```

**Witnessed red 1 — `--self-plant tsc-error-blind`.** Writes a REAL type error
into a REAL file inside `web/src`, in the program of both configs. It plants the
**defect**, not the message. The file is removed in a `finally`, removed again
before any write in case a killed run left one, and the gate fails if it survives
— checked on this run, `web/src/__tsc_selfplant__.ts` was gone afterwards.

```
  SELF-PLANTED FAIL    TSC   THE TREE STILL COMPILES 2 problem(s): `tsconfig.json`: 1 type
  error(s) — src/__tsc_selfplant__.ts(2,14): error TS2322: Type 'string' is not assignable to
  type 'number'. | `tsconfig.browser.json`: 1 type error(s) — src/__tsc_selfplant__.ts(2,14):
  error TS2322: Type 'string' is not assignable to type 'number'.
VERDICT: NO-GO — 2 gate(s) did not pass, and 5 could not run (RUN, I1, CTRL, AGPL, SPLNT).
```

**Witnessed red 2 — `--self-plant tsc-runner-blind`.** Replaces the compiler with
a process that exits 0 saying nothing. This is limb RAN's control and the reason
limb RAN exists: a silent exit 0 and a compiler that never started are the same
output to anything that only reads the exit code.

```
  SELF-PLANTED FAIL    TSC   THE TREE STILL COMPILES 2 problem(s): `tsconfig.json`: the compiler
  produced no `Files:` line — it did not run (exit 0). A silent exit and a clean tree are the
  same thing to anything that only reads the exit code: (no output at all) | `tsconfig.browser.json`:
  the compiler produced no `Files:` line — it did not run (exit 0). A silent exit and a clean tree
  are the same thing to anything that only reads the exit code: (no output at all)
```

⚠ **GDOC caught this section's absence before it was written**, which is worth
recording because it is the mechanism working on its author: the TSC row was
committed citing *"two witnessed reds below"* while this section did not exist,
and GDOC failed the run naming the line. A row citing evidence that does not
resolve is exactly what `SPEC` exists to stop, arriving in the document `SPEC`
does not read.

**What TSC does NOT cover**, said rather than implied: whether the code is
**correct** — that is every other gate in this file — and the `.mjs`/`.js` files,
which `allowJs` puts in the program while `checkJs` leaves them unchecked.

### AGPL — a lying resolver is not a publication (routability filter, 2026-08-28)

**The false-red class documented 2026-08-11 and left open until now.** The
publish probe counted ANY `A`/`AAAA` answer for `2bee.app` as evidence that the
domain is served, and `published` + a broken §13 offer is a **FAIL**. A captive
portal, a filtering ISP resolver or a corporate DNS box answers an unregistered
name with an address of its own — `10.0.0.1`, `192.168.1.1`, an NXDOMAIN-hijack
landing page. On such a box this gate failed for a domain nobody served.

🔴 **A false red on THIS gate is worse than on any other**, because its job is to
hold a real red visible until `legal` rules the §13 mechanism. **A false red
silently edits the thing it protects**: the cheapest way to make it stop is to
weaken the gate.

The filter is on **routability**, not on a blocklist of known portals — an
address in a private, loopback, link-local, CGNAT, documentation or multicast
range cannot be a host serving this work to the public internet, whatever
produced it. An rdata this probe cannot parse is also not counted: an answer it
cannot read is not an answer it may rely on. ⚠ **It is applied to the CONTROL
name too** — a resolver that hijacks `2bee.farm` proves nothing about
`2bee.app`, so it loses its vote rather than casting one from a lie.

**Witnessed red — `--self-plant agpl-hijack-blind`**, which removes the filter
AND supplies the lie, so the branch it reaches is the branch a hijacking resolver
would have reached. This IS the false red, on demand:

```
  SELF-PLANTED FAIL    AGPL  SOURCE OFFER (§13)   🔴 §13 HAS ATTACHED AND THE OFFER IS THE
  KNOWN-DEAD ONE. … 🔴 2bee.app IS PUBLISHED — §13 HAS ATTACHED [1.1.1.1: control ok (4
  answers), 2bee.app SERVFAIL / 1 routable answer(s); 8.8.8.8: control ok (4 answers),
  2bee.app SERVFAIL / 1 routable answer(s); 9.9.9.9: control ok (4 answers), 2bee.app
  SERVFAIL / 1 routable answer(s)]
```

With the filter in place the same box reports the honest PENDING — *"DNS
indefinite on every voting resolver and `https://2bee.app/` unreachable while the
HTTPS control answered 206"*. ⚠ **This control proves the filter is
load-bearing; it does not prove the filter is COMPLETE.** A hijacker answering
with a routable address it happens to own is still read as a publication, and
nothing here can tell that apart from a real one. The HTTPS probe below is what
would then be asked, and it is asked already.

### AGPL — three defects, and the ten branches now witnessed (rebuilt 2026-08-12)

The gate was **written for the right failure and asserted something else**. All three defects are the
gate believing its own prose, and the third is the one that would have bitten hardest.

**D1 — the green meant CHANGED, not WORKS.** The pass branch was `url !== KNOWN_DEAD` and its message
said the quiet part out loud: *"not the known-dead link, so a human changed it deliberately"*. Nothing
fetched anything. **Point the footer at a different 404 and the gate went green** — which is exactly the
outcome the gate's own preamble calls worse than what it was catching (*"a link that 404s is bad; a link
that LOOKS compliant and delivers nothing is worse"*). The verdict string outran the check.

**D2 — the flip was carried by a comment.** *"IT MUST BECOME A FAIL THE DAY A DEPLOY TARGET EXISTS"* sat
in the PENDING message, in the budget entry and in this document, and **in no code anywhere**. So the
flip depended on a human remembering, on the side of an asymmetry where the cheap step (one DNS record)
is available before the compliant one (a repo decision).

**D3 — the extractor presupposed the answer.** The regex was `href="(https://github\.com/…)"`. The whole
reason this gate does not fix the link is that the mechanism is **undecided and may not be GitHub** — a
tarball beside a release, a mirror, the monorepo opened. Under that regex a *correct non-GitHub offer*
read as `the served UI carries NO source-offer link at all`, **the message for a deleted link**. A gate
whose extractor can only see one candidate answer reports every other answer as an absence.

#### What replaced them

The green now needs **two independent things**: the target must be in `SOURCE_OFFER_RULED` — a table of
mechanisms `legal` has actually ruled on, each entry carrying `why` / `since` / `ruling`, **FATAL if
malformed** — *and* the target must answer an anonymous request. **The table ships empty**, so no string
edit can make this gate green; and membership alone is not enough, because a ruling naming a URL that is
dead (or goes dead later) delivers nothing to the user §13 is written for.

**2026-08-14 — the serving question is RULED, and the pending is now a deadline.** Founder, verbatim:
*"@software/2bee.app/ will served here"*. The domain is no longer maybe-defensive: it will be served,
and what is served is this code — so the §13 offer is **live-duty**, not a contingency that might never
fire. Two things the ruling is NOT: it is not publish-now (no DNS or deploy action without a further
word), and it is not `legal`'s mechanism ruling, which remains the blocker on the offer itself. No
branch above changes: published with a dead or unruled offer was already a FAIL in code (D2); what the
ruling changes is what the budgeted pending means while it stands.

The serving premise is **probed, not asserted**, and both probes are **controlled and three-valued**:

- the DNS probe queries `2bee.app` and the control `2bee.farm` **through the same resolver**, on three
  resolvers, and a resolver whose control returns no answer record **gets no vote**. *"The control
  answered" is not "the answer is meaningful"* — the control must return a record, not a response.
- 🔴 **no equality test across resolvers.** `2bee.farm` answered with **three different address sets**
  from 1.1.1.1 / 8.8.8.8 / 9.9.9.9 on 2026-08-12, all correct, because CloudFront is anycast. A check
  that compared resolvers would go blind to **exactly the shape a publish is most likely to take** — a
  CNAME onto a CDN. This one counts answers, never compares them, and takes the union.
- 🔴 **the offer probe is anonymous, permanently.** The obligation is to a user of the served page, who
  holds none of our credentials. An authenticated 200 on a private repository is the textbook green
  through a door no real caller uses — and it is the live case: the only repository holding this source
  returns **404 anonymously and 200 to `gh`**.
- when a control does not answer, the result is **UNCHECKED**, which reports PENDING and says which
  question went unanswered. **An offline box cannot render as compliance**, and it cannot certify a
  ruled offer either.

**NOT COVERED, said rather than implied:** an answering URL is not proof that what it serves *is* the
Corresponding Source of the running build. This gate sees that the offer resolves, answers, and was
ruled on; it cannot read the bytes. That is a human review at the ruling, not a check.

⚠ **And the not-served verdict names only the limb it measured.** The message used to read *"nothing is
served (every listener loopback; 2bee.app does not resolve)"* — the **loopback half was an assertion**,
because nothing in the gate enumerates a listener. It now says `2bee.app does not resolve, so it is not
served under that name`, and marks the other limb NOT MEASURED. That is the same defect as D2, one
clause along, and it was in the sentence written to replace D2.

#### 🔴 `2bee.app` does not have "no A record" — measured 2026-08-12

This document and the gate both said *"`2bee.app` has no A record"*. **What is actually true is worse and
more useful.** All three public resolvers return **SERVFAIL**, because the domain **is delegated**: the
`.app` registry hands out `christina.ns.cloudflare.com` / `rex.ns.cloudflare.com` — **the same pair that
serves live `2bee.farm`** — and those nameservers answer **REFUSED**, i.e. the zone is not (yet) in the
account. So publishing is not "add a record to a zone that does not exist"; the delegation is already
pointed at our own Cloudflare account and the remaining step is smaller than the sentence implied.

`dig +short` prints nothing for SERVFAIL, prints nothing for NXDOMAIN, and prints nothing when the box is
offline. **Three different worlds, one empty string** — which is why the probe reads the header STATUS
rather than the emptiness, and escalates an indefinite DNS answer to an HTTPS request rather than
treating "the recursors cannot say" as "nothing is there".

#### The ten branches, all driven

Four negative controls could not exist as `--plant` (which puts a defect in the *product*): the publish
state is a fact about the world this lane must not create in order to test it, and "the box has no
network" cannot be arranged by editing a file. Three are self-plants; the rest were driven against
**synthetic `App.tsx` roots** and **copies of the gate file**, never by neutering the live one. ⚠ The
green branch has **no negative control by construction** — a self-plant may only *remove* greens — so it
is witnessed on a copy, with a URL that really answers.

```
the live tree, no plant                     PENDING  known-dead link, premise measured not-served
--self-plant agpl-published                 FAIL     🔴 §13 HAS ATTACHED AND THE OFFER IS THE KNOWN-DEAD ONE
--self-plant agpl-offer-ruled               FAIL     🔴 THE OFFER IS RULED AND DEAD — … HTTP 404 (control github.com -> 206)
--self-plant agpl-offline                   PENDING  ⚠ UNCHECKED, NOT PASSED … an offline box does not get to certify a source offer
synthetic root, no <footer> at all          FAIL     DEAD INSTRUMENT: … cannot tell a missing offer from a moved one
synthetic root, footer with no link         FAIL     the served UI carries NO source-offer link at all
synthetic root, footer with TWO links       FAIL     … will NOT guess which one is the §13 offer
synthetic root, a DIFFERENT unruled url     FAIL     … and NO RULING NAMES IT      ← was PASS before today
copy + a ruled url that really answers      PASS     … and it ANSWERS: anonymous ranged GET -> HTTP 206
copy + a ruled url that is dead             FAIL     🔴 THE OFFER IS RULED AND DEAD — … HTTP 404
```

And the probe's own limbs, driven on copies against the real internet — the point being **which** limb
answered, not merely that the gate went red:

```
resolvers -> 192.0.2.1 (unreachable)   [no resolver answered the CONTROL name, so nothing here measures 2bee.app … NO VOTE]
target -> a name that NXDOMAINs        [definite negative on every voting resolver — … NXDOMAIN / 0 answers]
target -> a name with no A record      [definite negative on every voting resolver — … NOERROR / 0 answers]
target -> a name that really resolves  [1.1.1.1: control ok (4 answers), … NOERROR / 4 answers]   -> FAIL, §13 attached
live target, HTTPS control killed      [DNS indefinite and the HTTPS control did not answer either, so "unreachable" here means nothing]
```

The ruling table's validator was planted in both directions too: ruling the **known-dead URL** good is
refused at parse time (`FATAL … do not rule the dead link good`) — the laziest possible bypass, closed on
the plane that cannot come back UNCHECKED — as are a missing `since`, a missing `ruling`, and a non-https
target; a well-formed entry does not fatal.

⚠ **The offer's TARGET is still `legal`'s open decision and this lane still does not guess it.** What
changed is that the gate now asserts against a *decision* and a *live answer*, instead of against a diff.

### Notes on specific gates

**G2 / G12 — scan CODE lines, never raw text.** Both false-failed on their first
run: the preamble comment legitimately *names* what G2 bans (`G41/G42 absent from
grblHAL core`) and legitimately contains `F2` meaning *two flutes*, which G12 read
as a feed. **A scanner matches the text that discusses what it scans for.** Every
scan goes through `codeLines()`.

**G2 — the input set widened, and the obvious fix would not have worked
(2026-08-12).** `6860da1777` added an `off material:` line to the **emitted
program** and closed with the residual in its own commit body: *"gate G2 cannot
see this comment — G2 reads the fixtures' programs and no fixture cuts off the
material, so a banned word introduced here would ship past the dialect gate
unread."* It checked the one ban free prose can plausibly trip — the extruder `E`
word — **inside a Rust unit test, by hand**, and said so.

🔴 **The stated reason is half the reason.** Measured before this was touched:
`codeLines()` **drops every comment**, so G2 could not have seen that line on any
input — *a fixture that cut off the material would have changed nothing here.* And
that exclusion is not an oversight to be reversed: it is the paragraph directly
above. A comment-scanning G2 goes red on its own preamble, on every program in the
tree, forever.

⇒ **And a new fixture costs two more things besides.** The four fixtures live in
`cli/src/main.rs`'s `FIXTURES` table and in `core/src/fixtures.rs` — **not this
lane's files** — and they are what `2bee-slice fixtures` offers an operator as
**worked examples**, so a deliberately-wrong program would sit permanently in the
demo set to reach one comment. ⚠ **It would NOT enter `DOOR`'s matrix, and the
first version of this paragraph said it would.** `DOOR` sweeps the six `jobs`
(6 × 51 tools = 306 pairs); these four are a different set, reached by a different
subcommand, and nothing in the gate file enumerates them — every reference is a
hard-coded name. **The true reasons are the two above and the `codeLines` one; the
one that sounded most convincing was wrong, and it is corrected here rather than
deleted.** So the input set widened instead — four fixtures **plus a `plate` job
driven through `--config` onto a workpiece smaller than the part**, which reaches
the same emitted program without adding a corpus member.

**Three limbs, and the second is what makes the first sound:**

1. **banned / required / M30**, over the CODE LINES of all five programs.
   Unchanged in meaning; five inputs instead of one.
2. **comment containment.** A banned word inside a comment is not a command the
   controller may obey **provided the comment cannot end early** — grblHAL does
   not nest comments and ends one at the first `)`, parsing the rest as code, and
   `post_grblhal.rs::sanitize` is the only thing stopping that. So this limb
   asserts the premise limb 1 rests on, over every comment of every program:
   one open, one close, no parenthesis surviving inside a body, nothing
   executable after the close. `G5` asserts the same shape under `--plant paren`
   on one program; this is it **unplanted, over the set**, because *a premise
   nobody checks is an assumption.*
3. **reach.** The set must actually contain a program carrying `off material:`.
   A widening that silently stops reaching what it was widened for reads exactly
   like a widening that passed.

⚠ **Two things this set is the first to see, and NEITHER is asserted.** The
off-material comment is **200 characters** and carries a **U+2014 em-dash**; every
fixture line is ≤86 characters and pure ASCII. grblHAL's line-buffer size and what
its parser does with a byte >`0x7F` inside a comment are **`pcb`'s facts and this
lane has verified neither**, so both are measured and printed on every pass rather
than gated on a threshold nobody checked. `post_grblhal.rs::sanitize` rewrites
`(`, `)`, newline and `%` and touches neither.

**G5 — model grblHAL's normaliser, not our own line structure.** The first version
had a limb (`strayMotion`) that could never fire: our line filter drops anything
starting with `(`, so a scan of "code lines" cannot see code injected *inside* a
comment line, which is the entire hazard. It measured `0` with the sanitiser
deliberately disabled. It now splits at the first `)` and treats the remainder as
code, exactly as grblHAL does — and measures `2` on the same plant.

**P4 — a count is not a check, and this paragraph was a stale claim about its own
fix (corrected 2026-08-10).** Corner relief was computed, reported as "4 reliefs"
in the summary, and **never cut**. The gate passed on the number the whole time.

🔴 **This note then said the gate "now counts relief bores in the EMITTED G-code,
and the reported figure is derived from the moves rather than from the plan."
Both halves were false for the gate as written**, for eight weeks:

```js
if (socket.dogbones === 4 && plate.dogbones === 0 && bores >= 8) {
```

- `socket.dogbones` / `plate.dogbones` were scraped from `dogbones: N` on stderr,
  emitted by `eprintln!("dogbones: {}", built.dogbones.len())` — `BuiltJob::
  dogbones`, **the plan**. The 4-and-0 assertion, the entire substance of the
  gate, never touched a program.
- `bores` counted **every** `G98 G8[123]` line. The socket emits 8 canned cycles
  — 4 drill holes at `F300` **and** 4 reliefs — so `>= 8` could not tell a relief
  from a hole, and the drills supplied half the threshold. A socket that gained
  four holes and lost every relief satisfied it.

**A stale claim about a fix is worse than the original defect**: the original was
visible in the code, and the claim sent every subsequent reader past it. It is
the same shape as the ✅ rows SPEC was built for, written in prose.

**What it does now.** Counts canned cycles **by the `( … )` section that heads
them** — `( 4 corner reliefs )` versus `( drill: <name> [...] )`, the same
mechanism REL uses on `( op: … )`. The socket must emit exactly 4 reliefs **at
the four corners of a rectangle** (two distinct X, two distinct Y, four distinct
points — four bores stacked on one corner satisfies a count and not this), the
plate must emit **zero** reliefs while emitting 4 canned cycles, and the plan is
read only to assert that it **agrees** with the program. The plate leg is the
discriminating control on every pass: the old counter scores 4 there.
`--self-plant p4-count-all` restores the old counter and this gate goes red.

**P3 — a gate that was listed as armed while no such gate existed.** P3 was
dropped from the PENDING list when the pocket engine landed, and no P3 was
written to replace it. For four commits this file listed it under *"all now
armed"* and `FUNCTIONAL-SPEC.md` carried a ✅ on **G-3 Pocket floor depth**
citing it — a row whose named gate could not go red because it was not there.
The floor was *incidentally* covered: an under-deep pocket raises `uncut` cells,
which P2 would have noticed. **Incidental coverage under another gate's name is
not the same fact as a gate** — P2's plant is an outlined pocket, its message
talks about islands, and nobody reading a P2 failure would look at the floor.
P3 now reads the deepest Z inside the `( op: pocket-… )` blocks of the EMITTED
program and compares it to the design floor the fixture reports.
The witnessed red — the plant neutered in `fixtures.rs` so `shallow-floor` cuts
to the design depth, i.e. the defect the gate exists to catch made harmless:

```
  FAIL    P3   POCKET FLOOR DEPTH     design=-6 cut=-6 planted=-6 — the floor is not held to the design depth
================ 29 passed, 1 failed, 1 pending ==========
VERDICT: NO-GO
```

🔴 *That transcript belongs in the commit body per the rule below, and the commit
that armed P3 (`5fc067b7f`) carries only a subject line. Recorded here instead
rather than force-pushed onto the shared trunk — the evidence is in the tree,
which is the point, but the rule was missed and this line says so.*

⚠ *Its first run went red for the wrong reason: the drill cycles are headed
`( drill: … )`, not `( op: … )`, so the scan kept the pocket region open across
them and read the through-hole `Z-18.000` as the pocket floor. A section scanner
must close on **every** section header, not the one kind it was written for.*

**SPEC — the Gate column was 33 gate ids that do not exist.** `FUNCTIONAL-SPEC.md`
named `G-OFF`, `G-DEP`, `G-ENT`, `E2E-U1`… across **35 rows** marked ✅ "done and
gated". None of those ids is in this file or in the gate runner: **a reader
following the Gate column found nothing in every single case**, including on the
13 rows that turned out to be genuinely well covered. The ids survived four
audits because they *looked* like gate ids — the same failure mode as P3 below,
at 33x the scale. Row-by-row re-audit in `docs/spec-citation-audit.md`;
21 rows lost their ✅ (15 → 🟡, 6 → 🔴).

The spec is now **parsed, not trusted**: every Gate token must resolve to a gate
id in the runner's `GATES` table, a `fn <name>` under `core/src/**.rs`, a
`test('<title>'` in `web/e2e/*.ts`, or the literal `none`. `none` is accepted
deliberately — **an uncovered row that says so is honest** — and SPEC prints the
count of them on every run, because a number allowed to grow silently is just the
next version of this defect. The witnessed red, all four limbs planted at once:

```
  FAIL    SPEC SPEC CITATIONS         4 dangling citation(s): A99 (line 69): `G-NONSENSE` is not a gate id, not core:<fn>, not e2e:"<title>", not none | A98 (line 70): no `fn no_such_test_fn` in core/src | A97 (line 71): no Playwright test titled "no such playwright test" | A96 (line 72): Gate cell cites nothing — use `none` and say so in Status
================ 29 passed, 3 failed, 2 pending ==========
VERDICT: NO-GO
```

🔴 *The commit that armed SPEC (`9576c585f`) carries **another session's subject
line and `Session: frontend` trailer** — a concurrent `gcommit` picked up these
three staged paths and committed the whole index under its own message. The
content is correct and verified on origin; the attribution and the commit body
are not. Recorded here rather than force-pushed onto the shared trunk, exactly as
the P3 note below does, because **the evidence belongs in the tree** and rewriting
another session's commit is the worse defect. If you are auditing who wrote what,
the log will mislead you on this one.*

⚠ **What SPEC does NOT check: that the cited check actually covers the row.** It
proves the citation resolves to a real, runnable thing — not that the thing
asserts the acceptance. That judgement is the audit's, is written into each row's
Status cell, and **goes stale the moment a test is weakened without being
renamed.** A resolving citation is a floor, not a coverage claim.

**G-DIR — a setting consumed by nothing.** Climb vs conventional was stored in
the config, shown in the UI, and read by no code. Reversing it now reverses the
sense of travel — and the first attempt reversed the contour BEFORE offsetting,
which flipped the winding and cut the part undersize by a full tool diameter.
The gate asserts the swept area changes sign and the envelope does not.

**G6 — deliberate divergence from the OrcaSlicer fork.** The fork made
"cutting move while the spindle is off" a *warning*. Here it is **fatal**: it
snaps the tool or stalls the gantry. A process that legitimately cuts without a
spindle (drag knife, laser) is a different post, not a warning on this one.

**Spindle rpm out of range stays a WARNING, deliberately.** grblHAL clamps an
over-range `S` word, so the program still runs — it is wrong, not unrunnable.
What we are choosing not to guard: the resulting feed/chipload mismatch when the
controller clamps. Revisit if a burned edge ever traces back to it.
**SPIN is the gate that finally reads that warning.** `--plant rpm`
(`Plant::RpmOutOfRange`) was built, wired through the CLI, and **fired by no gate
and no test** — a negative control armed by nobody, which reads as protection and
is not.

**ENT asks the emitted program, because the plan and the program disagreed.**
Spec row G-9 is *"no vertical plunge in a through-cut"*. Ramping was implemented
and was the default, so `params.entry == Ramp` was true — and a ramped pass **with
a lead-in still emitted a full-depth vertical descent at the lead point**, then
rose and re-ramped over air. A check on the enum would have been green for that
program. ENT walks the G-code and looks for a descent with no XY component ending
below the workpiece top; the descent that stops at Z0 is the tool arriving at the
surface and is not a plunge. Drill sections are excluded by name — a drill is
built to cut on its end — and marking passes fall out because a section only
counts when its own deepest Z passes half the workpiece thickness.
⚠ **The tests nearest this behaviour deselected it:** both toolpath entry tests
and gate LEAD set `entry: Plunge` deliberately, because they are testing leads.
The default path had no assertion of any kind.

**`EntryMode::Helix` is REFUSED, not implemented.** It had no distinct behaviour
— it was matched together with `Ramp`, so a job asking for a helical bore got a
linear ramp along the wall and nothing said so. It now reports that it is not
implemented, on the precedent of `Technology::Fdm`. A helix needs its own descent
geometry (pitch per turn, a clearance circle inside the bore, a gouge check
against the finished wall) and none of it exists; implement that or keep
refusing, but never alias it again.
🔴 **Residual, named rather than left to be discovered:** `core/src/rect_profile.rs`
— the *fixture generator*, not the engine — still matches `Ramp | Helix` in its own
entry block, so the `fixture` CLI path would still ramp for a Helix request. That
file was outside the change that armed ENT. Every real job goes through
`toolpath::plan_profile` and is refused there; the generator needs the same
treatment.

✅ **CLOSED — CORRECTED 2026-08-27. The paragraph above is stale, and it was the
worst of the three copies because it stated a live CONSEQUENCE**: *"the `fixture`
CLI path would still ramp for a Helix request."* **It does not, and it cannot.**
`core/src/rect_profile.rs::build` now returns `Result` and refuses Helix at
`:128-130`, **before any move is built** — `if job.op.entry == EntryMode::Helix
{ return Err(HELIX_REFUSAL.to_string()); }`. Nothing downstream posts, because
nothing is produced: the refusal replaces the toolpath, it does not annotate one.

**How the alias is stopped from coming back**, which is the part worth reading:
the `match` on `job.op.entry` at `:207` keeps `EntryMode::Helix =>
unreachable!("helical entry is refused before any move is built")` **as its own
arm rather than folding into a `_`** — so adding a fourth entry mode is a COMPILE
ERROR in this file, and a wildcard can no longer let a new mode inherit the ramp's
behaviour without anyone choosing it. That is the defect this arm was split to end.

**Three tests, and the third is the one that would have caught this residual**
(`core/src/rect_profile.rs`, `mod tests`):

| test | what it holds |
|---|---|
| `helix_is_refused_here_and_produces_no_toolpath` (`:296`) | a refusal comes back and **no toolpath does** — not a ramp, and not an empty program, which reads downstream like a job with no cuts |
| `ramp_and_plunge_still_build` (`:308`) | the paired positive: a refuse-everything "fix" fails here |
| `the_generator_refuses_helix_in_the_engines_own_words` (`:328`) | **byte-equality** between `build()`'s `Err` and `plan_profile`'s own `refusals[0].why`. Nothing anywhere compared the two before, which is precisely why `toolpath.rs` was corrected and this file was not. The next divergence is a red test rather than a discovery |

**Direction of the staleness: UNDERSTATED — this document denied a control that
exists.** ⚠ It is *also* where the line-number style fails: the row and the two
sibling documents all cited `rect_profile.rs:160`, and the refusal now sits at
`:128`. Verified 2026-08-27 by reading `core/src/rect_profile.rs` at the source;
**nothing was run** (another lane held a full gate run against this tree).
**What is still NOT covered:** no *gate* asserts the two refusal strings are equal
— only `G0` running that unit test does. `ENT` still asserts on the engine's
emitted program and does not read this file.

**PROBE gained the #43 limb — the datum nobody declared (2026-08-09).** The seven
refusals this gate already carried were all on the **XYZ** path, which is opted
into. The eighth is on the **Z-only** path, which is what every existing machine
definition takes, and until now it could not be refused because the setting could
not be absent: `Machine::touch_plate_mm` was a bare `f64` defaulting to an
unsourced `1.6`. `G10 L20 P1 Z<top>` is emitted at the moment of contact, so that
number decides where work-zero lands and therefore how deep **every** cut in the
program runs.

Two things about how the limb is built:

- **It is a PAIR, and the second half is the point.** `job plate` declares a
  plate and must still emit `G38.2`; the same job under
  `--plant undeclared-plate` must be refused. Without the first half, a post that
  simply stopped probing would pass the second and look like a working refusal.
- **It asserts empty stdout, not a message.** The refusal has to mean *no program
  exists* (gate G13's property), not *a warning was printed above the program*.

The witnessed red — the fix neutered in `fixed_z_probe()` by restoring the old
fallback (`machine.touch_plate_mm.or(Some(1.6))`), i.e. exactly the behaviour
that shipped until 2026-08-09:

```
  FAIL    G0   BUILD + UNIT TESTS     cargo test failed:  test result: FAILED. 289 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out
  FAIL    PROBE XYZ TOUCH PLATE        … unrefused=[refuse-no-plate-thickness.nc] wallStatesDistinct=true zOnlyClean=true plateThickness=false(declaredProbes=true undeclaredRefused=false exit=0 stdout=11975B) …
================ 35 passed, 3 failed, 2 pending ==========
VERDICT: NO-GO
```

⚠ Read `stdout=11975B` rather than the boolean: with the fallback back in place
the planted job **emitted a complete 11,975-byte program**, datumed on a
thickness nobody had measured, and exited `0`. That is not a gate detecting a
missing message — it is the gate detecting a runnable file.

**REL — the hazard was never the tool grouping, it was which group went first.**
`toolpath::group_by_tool` builds groups in **first-appearance** order, so which
tool ran first was decided by how the caller happened to build the operation
vector. The same three operations, the same two tools and **the same single tool
change** were safe or lethal depending on nothing anybody chose. TODO #33 asked
the founder to buy safety with machine time; the research
(`docs/decision-33-tool-grouping-vs-part-restraint.md`) found there was nothing
to buy — `optimise_route` now topologically sorts the tool **groups** on the edge
`tool(interior of P) → tool(release of P)`, ties broken by first appearance so
the order stays deterministic for K3. **Zero extra tool changes on every job
shape this lane produces**, and REL asserts that count is unmoved as part of the
control.

The gate reads the section order out of the **emitted G-code**
(`( op: … )` / `( drill: … )`), never off the plan — the fifth time this lane has
been told that lesson (P3, P4, ENT, `JobSummary`). The one plan-derived input is
*which operation belongs to which part*, which the G-code does not carry; the
core states it on a `route-parts: <release><-<interior>|<interior>` note so the
gate never has to re-derive part attribution from a naming convention the core
deliberately does not use.

🔴 **And the ordering half alone would have been a control that covers less than
it claims.** `verify_interior_before_outer` still runs on the final order and its
findings are now **refusals**, not warnings — `job::report_route` pushes them into
`JobResult::refusals`, so `is_runnable()` is false and **no G-code is emitted at
all**. The residue it catches is real: a precedence **cycle** between two tools has
no correct grouped order, and *"release is `CutSide::Outside`"* is a heuristic that
misses a small part freed by a LARGER part's hole (the Estlcam failure). Deleting
the check because the ordering "fixed" the bug would have removed the only cover
for the case the ordering cannot reach.

The witnessed red — the group sort neutered in `optimise.rs` so the loop walks
`0..group_names.len()` again, i.e. the pre-2026-08-09 first-appearance order
restored:

```
  FAIL    G0   BUILD + UNIT TESTS     cargo test failed:  test result: FAILED. 292 passed; 4 failed; 0 ignored; 0 measured; 0 filtered out
  FAIL    REL  RELEASE ORDERING       import two-part drawing: REFUSED for release ordering (part2: it is cut before 4 of its own interior features (part2-hole1, part2-hole2, part2-hole3, pa) and emitted no G-code. The refusal is correct; being refused is not — this drawing HAS a safe grouped order (drill then end mill, one tool change), so the group ordering in optimise_route did not run or did not work
================ 36 passed, 2 failed, 2 pending ==========
VERDICT: NO-GO
```

⚠ **Read that red carefully, because it shows both halves at once.** With the
ordering removed, the refusal fired and the program was suppressed — so REL saw
*no sections at all*. An unexplained "no sections" reads as a harness fault, so
the gate distinguishes the two cases by name: a job refused for release ordering
is the refusal half working, and being refused **on a drawing that has a safe
grouped order** is the ordering half not working.

✅ **`--plant release-order` LANDED 2026-08-09, and REL now carries TWO controls.**
The in-gate one is kept — it goes red if the pre-fix order turns out to be safe,
i.e. if the gate is proving nothing — but it rebuilds the hazardous order **in
JavaScript** from the core's own note, so it is asserting on this file's
arithmetic rather than on a program the core emitted. The plant asserts on the
program.

**What the plant is.** `optimise::GroupOrder` (`ReleaseSorted` | `FirstAppearance`)
carried on `Job::group_order` and read by `plan_job`. `FirstAppearance` restores
the pre-2026-08-09 group order exactly. It is reachable from **no config file, no
CLI flag and no UI control** — only `JobPlant::ReleaseOrder` sets it, and only
gate REL drives that. A hazard a user can switch on is not a control.

🔴 **The debt was owed for three measured reasons, and the second is the one that
made it hard — it is now closed by construction rather than by care:**

1. **The knob did not exist.** `optimise_route` called `order_groups`
   unconditionally. Now `optimise_route_with(ops, GroupOrder)` takes it, plumbed
   through `Job::group_order` → `plan_job`. `optimise_route` is kept as the plain
   entry point so no ordinary caller can choose the wrong value.
2. 🔴 **No fixture JOB exercised the hazard, so a plant on one would have been
   VACUOUS.** Measured across all five: `plate`, `pocket`, `socket`, `multi-tool`
   and `clamped` produce **zero** `tool groups reordered` notes — their
   first-appearance order is already safe, and `--plant release-order` on each of
   them still exits **0** today. Fixture **`two-part`** closes it: a plain blank
   the 6mm end mill releases, plus a drilled part whose four holes need the
   3.175mm cutter, laid out left to right. **Nothing in it is written backwards
   on purpose** — the end mill is simply the first-appearing tool, which is the
   whole accident.
3. ~~**And that case is reached through `import`, which has no `--plant`.**~~
   Still true and no longer in the way: the control is driven through `job`,
   which honours the registry. `import` cannot APPLY a plant (the core's import
   path takes no plant argument) and refuses one **with the reason** — gate
   **FLAG**.

🔴 **THE PLANT SAYS WHETHER IT PLANTED ANYTHING, and that is the load-bearing
part.** Under `FirstAppearance` the core still computes the sorted order — it
just does not apply it — and then reports
`planted-difference: YES|NO` (`optimise::PLANT_DIFFERENCE_KEY`). `NO` means the
two orders are identical, i.e. the plant neutered a sort that was never going to
fire, and any control hung on it would run clean and **read as a passing
control**. The gate asserts `YES`. *Every one of the five reference fixtures
reports `NO`* — so the vacuous control this whole ticket was about is not
something REL is trusted to avoid, it is something the core refuses to hide.

**The plant control asserts four things, and "the exit code moved" is not one of
them** — an exit code moves for a typo in a flag name:

1. `planted-difference: YES` — the plant applied AND changed the order here;
2. the order it **kept** is byte-for-byte the `before` list of the CLEAN run's
   own reorder note, and the order it **declined** is that note's `after` — two
   independent runs agreeing on which order is the pre-fix one;
3. the refusal names the released part and **every** interior feature the clean
   run's `route-parts:` line attributes to it — the hazard enumerated, not a
   message that merely mentions ordering;
4. **stdout is EMPTY.** G13's property: the refusal must mean *no program
   exists*, not *a warning was printed above one*.

Witnessed red **A** — the fix itself reverted (`optimise.rs` made to hand
`order_groups`' answer back as plain first appearance), rebuilt. Both product
limbs and both controls fire:

```
  FAIL    G0   BUILD + UNIT TESTS     cargo test failed:  test result: FAILED. 333 passed; 9 failed; 0 ignored; 0 measured; 0 filtered out
  FAIL    REL  RELEASE ORDERING       job two-part: REFUSED for release ordering (drilled: it is cut before 4 of its own interior features (drilled-hole1, drilled-hole2, drilled-hol) and emitted no G-code. The refusal is correct; being refused is not — this drawing HAS a safe grouped order (drill then end mill, one tool change), so the group ordering in optimise_route did not run or did not work | import two-part drawing: REFUSED for release ordering (part2: …) | the two-part drawing did not exercise the group reorder at all (no "tool groups reordered" note) — this gate would be green on a job that never had the problem | NEGATIVE CONTROL VACUOUS: `--plant release-order` on `two-part` reports `planted-difference: NO` … | CONTROL: the unplanted `job two-part` emitted no reorder note, so the plant has nothing to be checked against
================ 37 passed, 3 failed, 2 pending ==========
VERDICT: NO-GO
```

🔴 Witnessed red **B — the one that proves the control cannot go quietly vacuous,
and it is the more important of the two.** The `two-part` fixture was edited so
its own input order is already safe (the blank's outline moved to the end, which
is what a nest re-order or a tooling tweak would do by accident). Nothing about
the plant, the knob or the gate changed. The engine is CORRECT throughout — and
the control detects that it has stopped proving anything:

```
  FAIL    G0   BUILD + UNIT TESTS     cargo test failed:  test result: FAILED. 341 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out
  FAIL    REL  RELEASE ORDERING       NEGATIVE CONTROL VACUOUS: `--plant release-order` on `two-part` reports `planted-difference: NO` — it neutered a sort that was never going to fire on this job, so it would run clean and read as a passing control. The job it is driven on stopped exercising the reorder; fix that, do not move the plant | CONTROL: the unplanted `job two-part` emitted no reorder note, so the plant has nothing to be checked against | CONTROL: the planted job was NOT refused for release ordering — the group order was restored to the pre-fix one and nothing objected, which means the refusal half is not covering the case the ordering half was built to remove | CONTROL: the planted job emitted 32914B of G-code. A part released before its own holes must produce NO program — a warning printed above a runnable file is a file that gets run
================ 37 passed, 3 failed, 2 pending ==========
VERDICT: NO-GO
```

⚠ **Read `32914B`, not the word VACUOUS.** With the fixture made safe by accident
the planted run **emitted a complete 32,914-byte program and exited 0** — the
negative control running clean, which is precisely how a plant stops being a
plant without anybody noticing. ~~*Every other plant in this file could fail the
same way and only DOC and TOOL currently check for it.*~~ ✅ **CLOSED 2026-08-09 by
gate PLANT** — and that sentence was an **understatement**, which is why it is
struck rather than deleted. Three plants were consumed by no gate at all, one of
them (`wrong-drill`) **planted nothing whatsoever** while announcing that it had,
and ten of the eighteen are inert on most targets. See *PLANT — the gate on the
gates* below.

⚠ **What the earlier version of this note got WRONG, kept because the correction
travels further than the fix.** It said the blocker was that the plant registry
lives in `core/src/fixtures.rs` and that file was held by another lane —
*"belongs in `fixtures.rs` the next time that file is free"*. **`fixtures.rs` came
free and the plant still could not be written**, because the registry was never
the blocker: the knob and the fixture were. *A blocker naming the wrong obstacle
sends the next attempt at exactly the file that was never in the way — the same
shape as a stale ✅, in the direction nobody re-reads.*

**TOOL — the cutter was the one undeclared fact that got GUESSED (2026-08-09).**
Every other undeclared quantity in this program refuses or reports UNCHECKED: an
undeclared collet is its own `ColletVerdict`, an undeclared touch plate is
refused (#43 P0), an undeclared fixture warns on every export. The **tool** was
the exception, and it is the one every other number is derived FROM.

`core/src/fixtures.rs` resolved it with `.unwrap_or_else(|| end_mill(6.0))`, and
**two different failures fell into that one line**:

| | Measured at HEAD, before the fix |
|---|---|
| Nothing chosen | `import plate.dxf` planned a complete **9,390-byte** program on a Ø6mm end mill and exited **0** |
| A mistyped id | `report plate --config '{"tool_id":"endmill-6"}'` emitted **11,976 bytes**, on a cutter that is not the one asked for, with nothing in `notes`, `warnings`, `errors` or `refusals` saying so |

Four things about how this one is built:

- **The two refusals are kept APART, and the gate asserts that they are.**
  *"You chose nothing"* and *"what you chose does not exist"* have different
  fixes — the picker versus the spelling — and a shared message sends half the
  operators to the wrong one. The check is not that the strings differ: neither
  may contain the other's key phrase, so a host keying on one cannot match the
  other. This lane already keeps such pairs distinct everywhere else (`undefined`
  vs `null` vs *"row states no diameter"* in the viewport; blank vs `0` for plate
  thickness; ABSENT vs UNPARSEABLE for `--z`).
- 🔴 **THE SIBLING SITE WAS THE MORE DANGEROUS ONE, and it was found by grepping
  for the pattern rather than by fixing the report.** `JobConfig::apply` looked
  the id up with `if let Some(t) = lib.iter().find(…)` and **had no `else`**, so
  the miss fell out of the `if let` and the operations kept the cutter they were
  *built* with. That is the path the reference fixtures run. **An `if let` with
  no `else` is how a lookup failure becomes a silent success** — fixing only the
  reported call site would have been the *"verifying one limb launders the
  others"* failure, with the launder pointing at the fixtures.
- ⚠ **The substitution was MASKING a second bug, so refusing naively would have
  broken a legitimate flow.** The import path resolved against a bare
  `default_library()`, not against the config's `extra_tools`, so a shop tool
  selected by id **was never found there** — it took the substitute branch and
  `apply` silently corrected the operations further down. Both sites now share
  `JobConfig::merged_library`. *Two lookups against two different libraries was
  the defect; one function is the fix.*
- ⚠ **The refusal is pushed AFTER `apply_tool_set`, and that ordering is load-
  bearing.** `assign_tools_from_set` does `job.tool_set_refusals =
  out.refusals.clone()` — an **assignment, not an extend** — so a refusal
  recorded before it is silently deleted by any config carrying both `tool_id`
  and `tool_ids`. A safety refusal that a later assignment erases is worse than
  one never written, because the code still reads as though it is there. The
  gate drives that exact config shape as its own limb.

**The plant's polarity is INVERTED, and that is why it is a pair.** Every other
plant here puts a defect INTO a good job and the gate asserts a refusal;
`--plant tool-substitute` takes the refusal OUT, so the planted run must produce
a **runnable program**. Both halves run on every pass: unplanted must refuse,
planted must emit. Without the second half a plant that quietly stopped planting
would be indistinguishable from a codebase that is clean — the same reasoning as
DOC's in-gate control.

**It is driven through `report`, not `import`, deliberately.** `report plate
--plant no-such-plant` exits **2**, and the gate asserts that too, because a flag
that is honoured is a precondition of the control meaning anything. ⚠ **The
REASON recorded here was correct when written and is now half stale, so it is
corrected rather than deleted:** it said `import` *"does not parse `--plant` at
all and ignores it silently"*. The silence is fixed (gate **FLAG**, 2026-08-09) —
`import … --plant <x>` now exits 2 — but `import` still cannot **apply** a plant,
because the core's import path takes no plant argument. So the control stays on
`report`, for a narrower reason than the one written here. 🔴 **Also found and
NOT fixed here: `job <name>` accepts `--config` and ignores it entirely**
(`run_job` never constructs a `JobConfig`). ✅ **CLOSED 2026-08-09 — `run_job`
now calls `JobConfig::apply`, the same call `plan_report_with_surface` makes for
`report`.** Gate **FLAG** asserts it on the emitted program; all five reference
fixtures are byte-identical under a default config, verified before the change
landed.

⚠ **Thirteen existing tests and gate F1 went red on the fix, and every one of
them was importing with no tool at all** — asserting on programs planned with the
substituted Ø6mm cutter. They were not testing the substitution, they were
unknowingly **depending** on it, which is precisely why the suite could never
have caught it. All were given an **explicit tool id**, never an exemption for
the test or gate path: exempting them would have re-opened the hole in the only
places that look at it. The id resolves to the cutter the old fallback returned,
so no assertion moved. **The five reference fixtures name no tool and are
untouched** — they build their own cutters in Rust, so "no `tool_id`" is not an
undeclared choice there; that is asserted explicitly rather than carved out in
the refusing code.

The witnessed red — the fix reverted in `core/src/fixtures.rs` (the
`unwrap_or_else` restored on the import path, the `else` removed on the fixture
path), rebuilt:

```
  FAIL    G0   BUILD + UNIT TESTS     cargo test failed:  test result: FAILED. 325 passed; 9 failed; 0 ignored; 0 measured; 0 filtered out
  FAIL    TOOL TOOL SELECTION         noToolRefused=false(9390B) unknownIdRefused=false(9390B) fixturePathRefused=false(11976B) survivesToolIds=false(11976B) distinguishable=false namesId=false offersNear=false cliExitContract=false stillPlans=true CONTROL[plantEmits=true(11976B) unknownPlantErrors=true] absent="" unknown=""
================ 36 passed, 3 failed, 2 pending ==========
VERDICT: NO-GO
```

⚠ **Read the byte counts, not the booleans.** With the fallback back in place the
unplanted jobs **emitted 9,390- and 11,976-byte programs** and exited `0`. That
is not a gate detecting a missing message — it is the gate detecting a **runnable
file**. And note `stillPlans=true` and `CONTROL[plantEmits=true]` stayed green
through the revert: the regression limb and the control limb **cannot see this
defect by themselves**, which is exactly why the refusal limbs are asserted
separately rather than inferred from a working program.

**`spindle_reverse` and `spindle_pwm` now reach the output, and are covered by
unit tests rather than by SPIN.** `spindle_reverse` is **refused**: this post
emits `M3` only, and a reversed spindle would also invert every climb/conventional
decision already baked into the coordinates. `spindle_pwm == false` warns once
that the S word cannot be honoured and the VFD must be set by hand. Neither is
reachable from a CLI flag, so the assertions live in
`core/src/post_grblhal.rs::spindle_tests` — where the dwell also has its own
negative control (spin-up set to 0 must REMOVE the `G4`, so the test is vouching
for the setting and not for a constant).

**FLAG — the defect was not two flags, it was that NOTHING rejected a flag it
did not read (2026-08-09).** `flag_value` scans the argument list for a name; a
typo, a flag belonging to a sibling subcommand, and a flag that was never
implemented are **all indistinguishable from "not given"**. So the fix is not two
patches — it is a per-subcommand list of the flags each command READS
(`flags_for`) and a refusal for anything else (`check_flags`), which is the rule
`--entry`, `--material` and `--tool` already applied to their *values*, applied
one level up to the flag *names*.

Measured at HEAD before the fix:

| | |
|---|---|
| `import <dxf> --plant <known or unknown>` | exit **0**, program **byte-identical** to the unplanted run |
| `job plate --config <tiny machine>` | exit **0**, **11,978 bytes** — the same program as with no config. `report` with that same file REFUSES |
| `job plate --config /no/such/file` | exit **0** — a config that does not exist read as a clean run |
| `job plate --no-such-flag`, `report … --json`, `fixture … --sim-cell`, `fit … --plant`, `route <job> --tool` | all exit **0**, all silently ignored |

Four things about how it is built:

- **Every limb is a PAIR, and that is the whole design.** A limb asserting only
  *"exit code is 2"* passes when the binary is broken some other way — and passes
  **completely** for a checker written to refuse everything, which would take the
  CLI down while scoring green. So each refusal is asserted **beside a valid
  invocation on the same path** that must still succeed, plus a `stillReads` limb
  driving the flags each subcommand genuinely takes.
- **It asserts on the EMITTED PROGRAM, not on the message.** `job --config`'s
  limb requires `stdout` to be **empty** on the refusal — the pre-fix job posted
  11,978 bytes and exited 0, so *"a warning was printed"* is not the property;
  *"no program exists"* is. The seventh time this lane has written that sentence
  (P3, P4, ENT, `JobSummary`, REL, TOOL).
- 🔴 **`job --config` is HONOURED, not refused, and the byte-parity was checked
  BEFORE the change landed rather than assumed.** All five reference fixtures —
  `plate`, `pocket`, `socket`, `multi-tool`, `clamped` — emit **byte-identical**
  G-code and byte-identical stderr under a default config, so nothing any gate
  compares has moved. Had one differed, the correct action was to stop and report
  it: a config path that alters fixture output is a much bigger decision than
  closing a silent flag.
- 🔴 **`import --plant` is REFUSED, not honoured, and the two cases are told
  apart.** An *unknown* plant exits 2 exactly as `report` does, so a control
  written against either path means the same thing. A *known* plant also exits 2,
  **with the reason**: the core's import path takes no plant argument, so
  accepting it would report a defect that was never planted — the vacuous control
  this gate exists to prevent. "Refuse rather than approximate", and the message
  names the core change that would let the flag bite.

The witnessed red — all four arms of the fix reverted in `cli/src/main.rs` (the
`check_flags` call removed from `main`, `cfg.apply` removed from `run_job`, the
`--plant` block removed from `import`, and `route`'s two branch refusals removed),
rebuilt:

```
  FAIL    FLAG FLAG ACCEPTED + DISCARDED import: unknown plant exit=0 stdout=9390B | job: unread flag exit=0 stdout=11976B | report: unread flag exit=0 stdout=57007B | fixture: unread flag exit=0 stdout=947B | fit: unread flag exit=0 stdout=1538B | route: unread flag exit=0 stdout=2762B | import --plant gouge exit=0 stdout=9390B — a known plant must be refused with the reason, not swallowed | job --config discarded: plain=11976B tiny=11976B(exit=0) — a config that cannot hold the sheet must leave NO program
================ 39 passed, 1 failed, 2 pending ==========
VERDICT: NO-GO
```

⚠ **Read the byte counts, not the exit codes.** `tiny=11976B(exit=0)` is a job
told it has 10×10mm of travel **posting a complete program for a 600×900mm
workpiece**. That is not a gate detecting a missing message — it is the gate
detecting a runnable file planned against a machine that cannot hold the work.

🔴 **And the most useful measurement of the night: `cargo test` passed 343/343
with that plant in place.** The unit tests exercise `check_flags` directly, so
they cannot see that `main()` stopped calling it — **a guard built in the callee
and never armed by the caller reads as protected**. Only the gate, which drives
the real binary, went red. Any future "the tests cover it" claim about this
family is wrong for the same reason.

🔴 **FLAG, limb 5 — and the harness kept a LOWER standard than the thing it
gates (2026-08-11).** Everything above is about the CLI. `gates/slicer_gate_check.mjs`
itself read its three flags with `process.argv.includes(...)` and **ignored every
other argument**, so a typo, a flag from the CLI, a flag that never existed and a
stray word were all indistinguishable from *"no flags given"* — and each one
**started a full pass**. Found by accident, by an operator typing:

```
$ node gates/slicer_gate_check.mjs --help
   … not refused. A full run began, rebuilt the release binary, and regenerated
   web/src/wasm before anyone had asked for a rebuild. Killed part-way through.
```

⚠ **That is not merely embarrassing. `web/src/wasm` is a COMMITTED artefact**, and
`c4db1a5d8a` is the record of what a silent rewrite of it costs: three different
core digests in play at once — CLI `5b912ecd4e3b`, disk `de7d9f0d917d`, git
`e6a8dbaacc6b` — with **no diff signature anywhere but the digest**, because the
glue regenerates byte-identical. A typo is a real way to produce exactly that.

Measured at HEAD before the fix, all five with `--list` appended so the probe
itself could not rebuild anything:

| | |
|---|---|
| `--help` | exit **0**, 15,172B — the gate table, i.e. the flag vanished |
| `--quik` | exit **0**, 15,172B |
| `--only G0` | exit **0**, 15,172B — **and `--only` has never existed** |
| `--self-plant=doc-roster` | exit **0**, 15,172B — the `=` form is scanned for by nothing |
| `nonsense` | exit **0**, 15,172B |

🔴 **`--only` is REFUSED BY NAME rather than implemented, and that was a choice.**
It was passed in the session that found this, appeared to be accepted, and ran
the whole suite. **A flag that is silently ignored is worse than one that is
refused**, because the operator reads the result as a subset of the gates when it
is all of them — the same family of harm as the discarded `--config` this gate
was founded on. Implementing it was the alternative; it was declined because
nothing here wants a scoped gate run, and a half-run that reports a verdict is a
verdict about a suite nobody ran.

**Four things about how limb 5 is built:**

- 🔴 **ORDERING IS THE PROPERTY, NOT THE EXIT CODE.** Exit 2 *after* the wasm
  rebuild satisfies an exit-code check and has already done the damage — the
  damage **is** the rebuild. Two independent witnesses are asserted. **(1) stdout
  must be EMPTY.** The first bytes the runner ever prints are the banner, three
  lines above `cargo build --release`, so an empty stdout means execution never
  reached the banner and therefore cannot have reached the build. **(2) the
  artefacts a full pass moves** — the release binary and both `web/src/wasm`
  files — must be identical by mtime and size across the refused call.
- ⚠ **The no-mutation assertion has a CONTENTION CONTROL, because other lanes are
  live in `web/`.** If a watched artefact moves, the limb takes an **idle window
  of the same length** before concluding anything: an artefact that also moves
  while this gate runs *nothing* is another lane's and is not evidence about the
  refusal. When that happens the limb reports the assertion as **NOT TAKEN** in
  its own message rather than banking a green — a check that could not run says so.
- **PAIRED, like every other limb here.** `--list`, `--quick --list` and
  `--self-plant <known> --list` must all still be **accepted**, and an unknown
  `--self-plant` NAME must still exit 2. A checker "fixed" by refusing everything
  would take this whole lane down while scoring green, and **`--quick` is what
  every session in this tree actually runs**. The `--self-plant <known>` arm is
  also the arity arm: if the value were not consumed it would be refused as a
  stray positional.
- **The probe cannot become the thing it is testing for.** The bogus flag rides
  with `--quick` so a regressed guard cannot reach the wasm rebuild while the
  limb is proving that it would; the child is given `SLICER_GATE_NO_SELF_SPAWN=1`
  and the limb skips itself when that variable is set, capping recursion at one
  level. Without that, a broken guard would have every generation spawn the next.

⚠ **Why it is a LIMB OF `FLAG` and not a gate of its own** — the honest question,
answered rather than assumed. The contract is the same sentence, the failure is
the same sentence, and the harm is the same sentence one level up: an operator, a
script **or a gate** believing a flag took effect. FLAG's own row already names
all three believers. A separate gate id would let the harness's contract drift
away from the product's, and those are the two things that must never disagree
here. Gate-on-harness is well precedented in this suite — `VERD` scores the
verdict rule, `PLANT` scores plant registration, `GDOC` scores this document.

**Witnessed red 1 — `--self-plant flag-harness-unguarded`**, which writes a copy
of the runner with the `checkRunnerFlags(...)` call **stripped out** into a temp
directory and points the limb at it. The pre-fix runner reconstructed by deletion,
not described:

```
  SELF-PLANTED FAIL    FLAG  FLAG ACCEPTED + DISCARDED THE HARNESS ITSELF accepted an unknown flag: `slicer_gate_check.mjs --quick --no-such-flag` exit=2 stdout=144B — a non-empty stdout means it printed the banner, and the banner sits three lines above `cargo build --release` — this gate requires exit 2 with empty stdout of every path in the CLI | the harness accepted --help, the invocation that found this: exit=0 stdout=15066B | the harness accepted --quik, a one-letter typo of the flag this session runs: exit=0 stdout=15066B | the harness accepted --only, which does not exist and looked like it scoped the run: exit=0 stdout=15066B | the harness accepted --self-plant=<name>, the = form nothing here scans for: exit=0 stdout=15066B | the harness accepted a bare positional: exit=0 stdout=15066B
================ 50 passed, 3 failed, 4 could-not-run ==========
VERDICT: NO-GO
```

⚠ **Read the first arm, not the count.** `exit=2 stdout=144B` is the copy
**exiting 2 for a completely different reason** — it reached the banner, then
fatal'd on a missing binary because its ROOT is a temp directory. An exit-code
check alone would have called that a refusal. **Only the empty-stdout witness
tells the two apart**, which is the whole reason the ordering is asserted through
stdout rather than through the exit code.

⚠ **And the residual this plant named in its own work is closed (2026-08-12).**
The temp directory was removed after the last arm that drives it — deliberately,
because that is where the removal can report itself into the pass message — but
**it was not in a `finally`**, so any throw between `mkdtempSync` and that line
left **a copy of this runner with its argument guard removed** in a world-readable
`os.tmpdir()`, on a box nothing sweeps. Measured both ways with the same injected
throw at the same point, on the HEAD runner and on the fixed one:

```
leftover before any probe: 0
=== PRE-FIX runner (HEAD), throw injected ===
leftover after PRE-FIX: 1
/tmp/slicer-flag-plant-H7HYo5
=== FIXED runner, same throw ===
leftover after FIXED: 0
```

The eager removal stays where it is; the `finally` is a second removal that does
nothing on any run that completes. **Both, not one** — a cleanup moved into
`finally` alone would have run before `harnessNote` was built and quietly emptied
the sentence that says the cleanup happened.

**Witnessed red 2 — the no-mutation assertion driven to fire**, because a
sub-assertion nobody has watched go red is decoration. A one-off copy of the
runner was given a line that touches a watched artefact **inside** the refused
run's window; the idle control window stayed clean, so the limb correctly
attributed the change to the refusal rather than to another lane:

```
  FAIL    FLAG  FLAG ACCEPTED + DISCARDED a REFUSED run moved a build artefact — before[…/target/release/2bee-slice=1786436646104.1104/1671080 …/web/src/wasm/twobee_cam_wasm_bg.wasm=1786438481346.5496/1202629 …] after[…/target/release/2bee-slice=1786439795680.999/1671080 …/web/src/wasm/twobee_cam_wasm_bg.wasm=1786438481346.5496/1202629 …]. Exit 2 after the rebuild is not a refusal: the damage IS the rebuild, and web/src/wasm is committed
================ 50 passed, 3 failed, 4 could-not-run ==========
VERDICT: NO-GO
```

⚠ **And the first cut of this limb produced a FALSE RED in both directions at
once, which is the cheap kind and is recorded rather than tidied away.**
`spawnSync` returns `status`, not `code`; the limb read `.code`, got `undefined`,
and `undefined !== 2` in **both** comparisons — so every refusal arm reported the
harness had *accepted* the flag and every acceptance arm reported it had *refused*
a flag it must take, on a tree where all eleven were behaving correctly. A harness
bug that fails loudly in both directions costs one run. The same bug written the
other way round — defaulting the missing field to the value the assertion wants —
would have been a permanent green over an unread exit code.

**DOC — the first gate on a number that was never wrong, only unsourced.**
`Material::max_doc_ratio()` returned `1.00` for plywood, MDF and softwood and
`0.75` for hardwood from the day it was written. Nothing was broken; the values
were inherited from a **tooling-chart header** — and on the Soft Plywood page
that header sits above a page with **no row at all** for the 1/4" up- or
down-cut, which is the tool class we actually use. Decision #38 replaced them
with 0.50×D for all four woods, sourced against machines in our class
(Carbide 3D 0.24, Shapeoko community 0.50, a review of our own C-Beam/ACME
architecture 0.51, ToolGrit's slotting rule 0.50), and cut three chipload
multipliers back inside their published bands. **Every change is a reduction.**

Three things about how this gate is built, each of them a lesson this file
already records:

- **It measures the EMITTED PROGRAM, not the constant.** The depth comes out of
  the pass-floor Z values in the G-code (`entry: Plunge`, `lead_mm: 0` — a ramp
  writes intermediate Z into the section and the floors stop being separable),
  and the chip multiplier out of the emitted `F` and `S` words normalised
  against plywood, so **no library constant is copied into the gate**. A check
  that read `max_doc_ratio()` would be green about `max_doc_ratio()`.
- **It asserts CEILINGS, not equalities.** A later reduction stays green; only
  an increase goes red. Raising any of these is **coupon-gated** (#38 §B1) and
  no output of this program has ever cut anything.
- **The compression-cutter warning is measured in the SAME gate, not a later
  one.** A compression spiral only compresses when its up-cut section spans the
  material in one pass; capping the depth at 0.50×D forces six passes on an
  18 mm through-cut, and from pass two down the tool is a plain up-cut that
  **tears the top veneer — the face the operator bought that cutter to
  protect.** So the depth reduction *creates* this failure, and shipping A1
  without A3 would have been a silent defect behind a green gate. Two controls
  sit beside it: the same cutter in **one** pass must be silent, and an up-cut
  at the same depth and pass count must be silent.

⚠ **What this gate does NOT cover.** It reads the `recommend` path and the
`report`/`job` clamp on the plate fixture; a job assembled some other way is
covered only insofar as it goes through the same clamp. And the ratio itself is
the wrong *shape* of rule at the top of the library — chip area grows as **D²**,
so a ⌀12 at any given ratio asks for far more chip than a ⌀6 does. #38 §B3
proposes a chip-area cap and **explicitly does not propose a number for it**;
nothing here caps chip area today.

The witnessed red — the pre-#38 values put back into `core/src/tools.rs` and the
release rebuilt, i.e. the exact revert this gate exists to catch:

```
  FAIL    DOC  DEPTH + CHIP CEILING   5 material(s) cut deeper or thicker than #38 §A defends: Plywood doc=1.000xD (max 0.5) chip=x1.000 (max x1) | MDF doc=1.000xD (max 0.5) chip=x1.000 (max x1) | Softwood doc=1.000xD (max 0.5) chip=x1.100 (max x1.1) | Hardwood doc=0.750xD (max 0.5) chip=x0.800 (max x0.8) | Acrylic doc=0.500xD (max 0.5) chip=x1.150 (max x0.75)
================ 34 passed, 4 failed, 2 pending ==========
VERDICT: NO-GO
```

🔴 **And a second control that runs on EVERY pass, not once at arming time.**
The negative control above is a source edit, so it proves the gate could go red
*on the day it was written* and says nothing about tomorrow. The gate therefore
also feeds its own checker the pre-#38 table as data and **fails if the checker
calls those values acceptable** — `the in-gate control is blind: the pre-#38
table should breach 5 materials, it named […]`. A checker that has gone blind is
otherwise indistinguishable from a codebase that is clean.

⚠ **One of the three new unit tests would NOT have caught the revert, and that
is deliberate rather than an oversight.**
`nothing_in_the_38_change_permits_a_more_aggressive_cut_than_before` compares
against the pre-#38 table with `<=`, so the plant — which *is* that table —
passes it. It is a **monotonicity** invariant ("no cut got more aggressive"),
not a value assertion; `no_material_permits_a_deeper_cut_than_the_research_defends`
and `no_material_permits_a_bigger_chip_than_the_published_band` are the two that
went red. Recorded because a reader scanning test names would reasonably assume
the first one is the guard, and building on that belief is how a gate ends up
watched by nothing.

**PLANT — the gate on the gates (2026-08-09).** Every row above rests on an
assumption nobody was checking: *that its plant still injects the defect it
names.* REL's note ended with the sentence that became this ticket — *"every
other plant in this file could fail the same way and only DOC and TOOL currently
check for it."* It was an understatement. Three plants were driven by **no gate
at all**, one of them **planted nothing whatsoever**, and ten of the eighteen are
**inert on most targets**.

**The audit. Eighteen plants, driven through the real binary on every job and
fixture, byte-compared.** `proves` = the gate asserts a consequence the plant
must have caused · `infers` = the gate observes a difference, which something
else could produce · `cannot tell` = the gate would run clean if the plant
stopped planting.

| Plant | Host | Consuming gate (before) | Before | Consuming gate (now) | Now |
|---|---|---|---|---|---|
| `offbed` | `fixture` | G3 | ⚠ infers | G3 + **PLANT** | ✅ proves |
| `deep` | `fixture` | G4 | ⚠ infers | G4 + **PLANT** | ✅ proves |
| `paren` | `fixture` | G5 | ⚠ infers | G5 + **PLANT** | ✅ proves |
| `spindle-off` | `fixture` | G6 | ⚠ infers | G6 + **PLANT** | ✅ proves |
| `rpm` | `fixture` | SPIN | ⚠ infers | SPIN + **PLANT** | ✅ proves |
| `arc-first` | `fixture` | G8 | ⚠ infers | G8 + **PLANT** | ✅ proves |
| `no-tabs` | `job` | P1 | ⚠ infers | P1 + **PLANT** | ✅ proves |
| `outline-only` | `job` | P2 | ⚠ infers | P2 + **PLANT** | ✅ proves |
| `cut-clamp` | `job` | P7 | ⚠ infers | P7 + **PLANT** | ✅ proves |
| `gouge` | `job` | P9, DINV | ⚠ infers | P9, DINV + **PLANT** | ✅ proves |
| `oversize-shank` | `job` | P6 | ⚠ infers | P6 + **PLANT** | ✅ proves |
| `shallow-floor` | `job` | P3 | ⚠ infers | P3 + **PLANT** | ✅ proves |
| `undeclared-plate` | `job` | PROBE | ✅ proves | PROBE + **PLANT** | ✅ proves |
| `tool-substitute` | `job` | TOOL | ✅ proves | TOOL + **PLANT** | ✅ proves |
| `release-order` | `job` | REL | ✅ proves | REL + **PLANT** | ✅ proves |
| 🔴 `no-reprobe` | `job` | **NONE** | 🔴 cannot tell | **RPRB** (new) + **PLANT** | ✅ proves |
| 🔴 `wrong-drill` | `job` | **NONE** — P5 *named* it and drove `drill-check` | 🔴 cannot tell, **and it planted nothing** | P5 (2nd limb) + **PLANT** | ✅ proves |
| 🔴 `bed-anchored-sim` | `job` | **NONE** — its own doc said *"it exists to arm gate DINV"* | 🔴 cannot tell | DINV (2nd control) + **PLANT** | ✅ proves |

Three findings, in order of how badly they read as covered:

1. 🔴 **`wrong-drill` was a note and nothing else.** Its entire body was
   `notes.push("PLANTED: a 5.2mm hole with no matching drill")`. No hole, no
   operation, no motion — the emitted program was **byte-identical to the clean
   one on all six jobs**, at exit 0. It announced an injection it had never
   made, and this file cited it as P5's negative control the whole time while P5
   drove the `drill-check` helper and **never passed the flag**. *A named control
   that is not driven, pointing at a plant that does not plant* — and neither
   half was visible from the other, because each made the other look covered.
   It now plants a real 5.2mm hole (no drill within 0.1mm, and narrower than the
   6mm cutter, so it cannot be contoured either) and P5 gained a second limb on
   the product path.
2. 🔴 **`bed-anchored-sim`'s own doc comment claimed a gate that never drove
   it.** DINV used `--plant gouge` for its silence control. And the plant is
   **vacuous at datum 0** — which is what every fixture defaults to, so the one
   state anyone would naturally test it in is the one where both halves of the
   defect it restores are inert. DINV now drives it at a **moved** datum and
   asserts the program stays byte-identical while the verdict moves.
3. 🔴 **`no-reprobe` was covered by unit tests only** (`FUNCTIONAL-SPEC.md` D4),
   which is precisely the evidence class that scored **343/343 with a plant live
   in `main()`**. Gate RPRB now drives it through the binary.

**How PLANT is built, and the one thing it deliberately refuses to assert.**

- **The registry comes out of the binary** — `2bee-slice plants` prints
  `core/src/fixtures.rs::PLANT_CONTRACTS`. A hand-kept list in the gate file
  would be a second place for a plant to exist, and *a plant existing in one
  place and consumed in none* is the entire finding.
- **Each contract names the ONE target the plant is non-vacuous on.** Not "a job
  it runs on" — ten of the eighteen exit 0 with an unchanged program on most
  targets, so the pairing is the load-bearing fact. Two plants also carry the
  `--config` without which they are inert.
- **The declared effect is a CONSEQUENCE observed from outside the core**:
  `program-differs`, `refuses` (with **empty stdout** — G13's property),
  `emits` (the inverted polarity, for a plant that removes a refusal), or
  `verdict-differs` (the program is byte-identical *by design* and that half is
  asserted, so a check-plant that starts moving the cutter is caught becoming a
  different kind of control).
- 🔴 **The core's own `PLANT DISARMED` verdict is read on every planted run, and
  the key is taken out of `core/src/fixtures.rs` rather than typed here.** Since
  `ea6cf254f0` a plant that is not in force refuses with empty stdout — which is
  what a *correct* refusal also looks like — so the four effect arms alone cannot
  separate them and the `refuses` arm in particular passes anything that refuses.
  A copy of the constant in the gate file would be a second place for it to live,
  and a rename in core would blind the gate silently; read from source, a rename
  goes **red**. Unreadable is a **problem**, never a default — a check that cannot
  run has not passed.
- ⚠ **It does NOT assert that the plant's branch was reached**, and that is a
  decision rather than an omission. "The injection code ran" is an *intent*
  signal, and asserting on intent is the defect this lane has now been bitten by
  **six** times (P3, P4, ENT, `JobSummary`, REL, and `wrong-drill`).
  `wrong-drill`'s note was a perfect intent signal and it was **true** while the
  plant did nothing. Red **E** below shows the same shape live: with the
  `no-reprobe` plant neutered, `skipAcknowledged=true` — *the announcement
  survived the plant*.
- ⚠ **`cargo test` is not evidence for any of this.** The Rust tests beside the
  contract prove the three registries agree on which plants *exist*; only the
  gate, driving the real binary, proves they still bite. This is failure 5 of
  the six: 343/343 green with a plant in place, because the tests called the
  callee while the caller had stopped calling it.
- ⚠ **A convention PLANT enforces, named so it is not discovered as a false
  red:** plants must be driven by **literal name** (`'--plant', 'no-tabs'`). A
  gate that builds the argument dynamically is invisible to limb 2 and will be
  reported as an orphan. That is the trade for being able to answer *"does
  anything drive this plant?"* by reading the file.

**Ten witnessed reds (A · B · C · C1 · C2 · C3 · C4 · D · E · F). Each is a
defect planted in the NEW checks themselves** — ⚠ **C is the one exception and it
is labelled as such: it was genuinely witnessed on 2026-08-09 and the CLI can no
longer produce that line**, because `ea6cf254f0` removed the signature it keys on.
C1–C4 are the re-witnessed replacements, taken 2026-08-12 against a settled core.
The stale transcript is kept rather than deleted, because a witnessed red that
quietly becomes unproducible is the same class of lie as a stale green —
the trap being that a control tested only in the state where it cannot fail is
failure 3 of the six.

🔴 *The commit that armed PLANT and RPRB (`c99b44aed`) carries only a subject
line, and the audit-loop rule below requires the red run in the commit **body**.
Recorded here rather than force-pushed onto the shared trunk, exactly as the P3
(`5fc067b7f`) and SPEC (`9576c585f`) notes above do — the evidence belongs in the
tree, and rewriting a pushed commit on a branch every session commits to is the
worse defect. **Third time this lane has made the same miss**, which makes it a
tooling problem rather than a discipline one: `gcommit` takes a subject and the
rule wants a body, so the rule loses every time somebody is in a hurry.*

**A — `wrong-drill` reverted to the note-only version it shipped as.** Both the
new P5 limb and PLANT fire, and the byte count is the thing to read:

```
  FAIL    G0   BUILD + UNIT TESTS     cargo test failed:  test result: FAILED. 348 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out
  FAIL    P5   HOLE SIZING            helper=true(exact=0 none=1) productPath=false(planted exit=0 stdout=11976B) namesFeature=false — a hole with no matching drill was given one
  FAIL    PLANT THE PLANTS STILL PLANT wrong-drill (job plate): declared `refuses` and the planted run EXITED 0 emitting 11976B — the plant is INERT here and any control on it runs clean
================ 38 passed, 4 failed, 2 pending ==========
VERDICT: NO-GO
```

⚠ Read `stdout=11976B`, not the booleans: the "planted" job emitted a **complete
11,976-byte program** and exited 0. That is the state P5 was in for its whole
life.

**B — a plant orphaned** (`gate: ""` on the `no-reprobe` contract), i.e. a
control registered, reachable and run by nobody:

```
  FAIL    PLANT THE PLANTS STILL PLANT no-reprobe: registered and NO GATE CONSUMES IT — a control nobody runs
================ 39 passed, 3 failed, 2 pending ==========
VERDICT: NO-GO
```

🔴 **C — the checker itself made blind** (`vacuityProblem` returns `null`
unconditionally). This is the red that matters most, because it is the failure
mode arriving *in the meta-check*: limb 3 finds nothing, and without limb 4 the
gate would go **green while proving nothing**.

🔴 **C IS RE-WITNESSED, AND THE ORIGINAL TRANSCRIPT IS KEPT BELOW BECAUSE THE
GATE CAN NO LONGER PRODUCE IT.** The 2026-08-09 red read *"`cut-clamp` driven on
`plate` is inert (**it applies, exits 0 and changes nothing**)"*. `ea6cf254f0`
(2026-08-12, `core/` lane) made a disarmed plant **REFUSE** — exit 1, `gcode`
cleared, empty stdout, `PLANT DISARMED` on stderr — so *"exits 0 and changes
nothing"* stopped being a state the CLI can reach. **The probe's premise was
falsified by a core change three commits away, and the probe said so by going
red** rather than by quietly passing. It was then left red for a day rather than
re-pointed mid-change, on the grounds that picking a pairing which happens to be
green is choosing a needle to make a gate pass.

⚠ **The general lesson, which is sharper than the fix:** for a `refuses`-effect
plant, **a vacuous run and a genuine refusal are now byte-for-byte identical from
outside** — same exit code, same empty stdout. Measured over the full
20-plant × 105-pairing matrix on 2026-08-12: **18 pairings are vacuous refusals
that limb 3's `refuses` arm called fine**, because every test that arm applies is
satisfied by a refusal the plant did not cause. That was a live blind spot on all
**9** `refuses`-effect plants, not only in the probe. The only channel that
separates the two is the core's own `PLANT_DISARMED_KEY` token, which the gate now
reads on every planted run — **taken out of `core/src/fixtures.rs` by regex, never
typed into the gate**, so a rename in core goes red here instead of blinding it.

**The original red, 2026-08-09** (kept as the record of what was witnessed then;
this exact line is no longer producible):

```
  FAIL    PLANT THE PLANTS STILL PLANT IN-GATE CONTROL BLIND: `cut-clamp` driven on `plate` is inert (it applies, exits 0 and changes nothing) and the checker called it fine. Limb 3 is not detecting vacuous plants, so every green above it means nothing
================ 40 passed, 2 failed, 2 pending ==========
VERDICT: NO-GO
```

**C1 — the same defect, re-witnessed 2026-08-12** against the re-pointed probe
(`vacuityProblem` returns `null` unconditionally). **All four probes fire, one
per checker arm** — the old single-pairing probe only ever entered the `refuses`
arm, so an arm whose body went permissive was invisible to it:

```
  FAIL    PLANT THE PLANTS STILL PLANT IN-GATE CONTROL BLIND: `cut-clamp` driven on `plate` is a `refuses`-effect plant that is not in force … Limb 3 is not detecting vacuous plants through its `disarmed` path | IN-GATE CONTROL BLIND: `spindle-off` driven on `drill-peck` … through its `refuses` path | IN-GATE CONTROL BLIND: `gouge` driven on `clamped` … through its `program-differs` path | IN-GATE CONTROL BLIND: `bed-anchored-sim` driven on `clamped` … through its `verdict-differs` path
================ 51 passed, 3 failed, 4 could-not-run ==========
VERDICT: NO-GO
```

🔴 **C2 and C3 are the ones that prove the four probes are not four copies of one
probe.** A set of controls that all fire together is one control with four
messages. Each was planted separately and **only its own probe fired**:

```
  (C2 — the disarm-token fallthrough deleted, the four arms left intact)
  FAIL    PLANT THE PLANTS STILL PLANT IN-GATE CONTROL BLIND: `cut-clamp` driven on `plate` is a `refuses`-effect plant that is not in force … through its `disarmed` path
================ 48 passed, 6 failed, 4 could-not-run ==========

  (C3 — one arm made permissive: `case 'refuses'` returns null immediately)
  FAIL    PLANT THE PLANTS STILL PLANT IN-GATE CONTROL BLIND: `spindle-off` driven on `drill-peck` … The `refuses` arm must object to a planted run that emitted … through its `refuses` path
================ 47 passed, 7 failed, 4 could-not-run ==========
```

⚠ In **C3** the `cut-clamp` probe stayed **quiet** and that is correct, not a
miss: with the `refuses` arm dead, the token fallthrough still catches it. The
two mechanisms are independent, which is the property C2 and C3 together
establish. *(C2 and C3 also reddened `STALE`, `G0`, `PROBE`, `HOST` and `K3` —
**another session was editing `core/src/job.rs` while these ran**, which `STALE`
named by hash. Unrelated to the plant, and recorded rather than trimmed out.)*

🔴 **C4 — the token unreadable** (the constant renamed in the gate's own regex,
so `PLANT_DISARMED_KEY` cannot be resolved out of `core/src/fixtures.rs`). It
does **not** default to "no token found, so nothing is disarmed" — that would be a
check reporting a pass it never ran:

```
  FAIL    PLANT THE PLANTS STILL PLANT IN-GATE CONTROL: `PLANT_DISARMED_KEY` could not be read out of `core/src/fixtures.rs`, so the token that separates a vacuous plant from a genuine refusal is unknown on this pass — every `refuses`-effect plant below is checked by a test a refusal it did not cause would also satisfy | IN-GATE CONTROL BLIND: `cut-clamp` driven on `plate` …
```

🔴 **RESIDUAL, NAMED:** the `emits` arm has **no token-free inert pairing on this
tree** — `tool-substitute` bites on all six jobs, and `overlap-unchecked` off its
declared drawing is caught by the token before its arm is reached. So `emits` is
covered through `disarmed` and **not** through its own branch. If that arm goes
permissive, these probes will not see it.

**D — a gate stops driving the plant it is credited with** (RPRB's literal
invocation replaced by a variable). ⚠ **RPRB itself stayed GREEN** — it still
ran, it still passed, and only PLANT noticed the plant was no longer named:

```
  FAIL    PLANT THE PLANTS STILL PLANT no-reprobe: the contract says gate RPRB drives it, but no literal `--plant 'no-reprobe'` invocation exists in this file
================ 40 passed, 2 failed, 2 pending ==========
VERDICT: NO-GO
```

**E — the `no-reprobe` plant neutered in the core** (`probe_after_toolchange`
forced true). Both RPRB and PLANT fire — and note `skipAcknowledged=true`:

```
  FAIL    RPRB RE-PROBE AFTER A TOOL CHANGE cleanReprobesAfterChange=true plantedSkips=false skipAcknowledged=true — a new tool ran on the old tool's Z datum
  FAIL    PLANT THE PLANTS STILL PLANT no-reprobe (job multi-tool): declared `program-differs` and the programs are BYTE-IDENTICAL (24823B) — the plant is INERT here and any control on it runs clean
================ 39 passed, 3 failed, 2 pending ==========
VERDICT: NO-GO
```

⚠ **`skipAcknowledged=true` is the whole argument for asserting consequences.**
The note still said the re-probe had been skipped while the program re-probed.
An intent signal is exactly as trustworthy as the intent.

**F — the `bed-anchored-sim` plant neutered**, i.e. the one whose defect is in
the check rather than in the cut:

```
  FAIL    DINV SIM DATUM INVARIANCE   the bed-anchored control proves nothing: sameProgram=true verdictMoved=false (sim: cell=0.6mm gouge=0 uncut=0 spoilboard=0 vs sim: cell=0.6mm gouge=0 uncut=0 spoilboard=0) — a plant that changes neither the program nor the verdict is not planting
  FAIL    PLANT THE PLANTS STILL PLANT bed-anchored-sim (job plate): declared `verdict-differs` and the verdict did not move (sim: cell=0.6mm gouge=0 uncut=0 spoilboard=0) — the plant is INERT here
================ 38 passed, 4 failed, 2 pending ==========
VERDICT: NO-GO
```

🔴 **What PLANT does NOT cover, stated so nobody reads its green as more than it
is:**

- **It proves a plant still CHANGES something, not that the change is still the
  RIGHT defect.** `no-tabs` could start removing lead-ins instead of tabs and
  PLANT would stay green — the programs still differ. What each plant injects is
  its own gate's question, and PLANT only guarantees that question is being
  asked of a program that actually moved.
- **It covers the CLI plants only.** The browser has its own instruments
  (`?fixtures=1`) and failure 3 of the six — a probe-clear control checked on a
  fresh navigation, where there was nothing to go stale from — was a **browser**
  control. Nothing here reaches it, and `I1` compares fixtures that carry no
  plant.
- **It cannot see a plant that is vacuous for a reason the contract does not
  model.** Failure 4 of the six is the case: decision #38 lowered
  `max_doc_ratio` to 0.50, the "drifted" `depth_per_pass_mm: 4` clamped to the
  same 3.0 as the original, and a negative control three commits away stopped
  drifting. PLANT would have caught that **only if** that control were a
  registered plant driven through the binary; it was neither. **Negative
  controls written inline inside a test are outside this gate entirely**, and
  that is the largest remaining hole.
- **`import` still cannot APPLY a plant** — the core's import path takes no
  plant argument, so no contract targets it and gate FLAG's refusal is the whole
  coverage there.

## P7R — a clamp that is TURNED, checked where it is (TODO #57, armed 2026-08-09)

`Clamp` gained `rotation_deg` in `1e4d60dbe`: `contains()` and `contour()` are
both computed from `corners()`, so the keepout and the picture come from **one
number**. That landed in the core and **no host could ask for it** — `ClampCfg`
had no such field and is `#[serde(deny_unknown_fields)]`, so a config requesting
one was refused at the door. P7R keyed on exactly that refusal and reported
**PENDING**, which is the honest state for a capability nothing can reach.

Armed by three edits in `core/src/fixtures.rs`: the field on `ClampCfg`
(`serde(default)` = `0.0` = square to the machine's axes, so every pre-existing config still
means what it meant), `JobConfig::apply` passing it to `Clamp::rotated`, and the
**report echo** in `report_of` — the seam the viewport draws clamps from.

**Four limbs, and the pair that runs at 0° is not scaffolding.** A `clear-square`
off the part must RUN and a `hit-square` across the profile pass must REFUSE with
`CutsClamp` and **empty stdout**; a 180° turn about the anchor maps each onto the
other's footprint, so if either stopped behaving the rotated limbs would be
measuring nothing and the gate goes red rather than green on a meaningless pair.
Limb **E** then asserts the report echoes the angle back at **37°** — not 180,
because a dropped field reads `0` and a field wired to the wrong constant reads
`180`, and only an angle that is neither catches both.

🔴 **The gate could not go green, and only running it said so.** The branch that
catches "the rotated config was refused for some OTHER reason" tested
`b.code !== 0` and sat **ahead** of the armed branch — but for limb B a non-zero
exit **is the correct answer**. The moment the field landed, P7R went STUCK RED
on its own success and the armed branch was unreachable by construction. The
header's *"this gate ARMS ITSELF … nobody has to remember"* was therefore an
untestable claim for as long as it was PENDING. Narrowed to refusals that are
**not** the keepout speaking; the armed assertions are untouched.

**Witnessed red 1 — the field accepted and DISCARDED** (`.rotated(c.rotation_deg)`
removed from `JobConfig::apply`, field left on `ClampCfg`). This is gate FLAG's
failure arriving on the one path that ends in steel:

```
  PASS    P7   FIXTURE KEEPOUT        a cut into a clamp is refused; clamps clear of the work still run
  FAIL    P7R  TURNED-CLAMP KEEPOUT   turnedClampBites=false(exit=0 stdout=9388B) turnedClampReleases=false(exit=1 stdout=0B) — the picture and the keepout are not computed from the same number. A false GREEN here is a cutter into a clamp; a false RED is a keepout that gets muted
```

⚠ **Read the byte count, not the boolean.** `stdout=9388B` is not a missing
message — it is a **runnable G-code file** that drives the cutter through a
clamp, exit `0`. And **P7 stayed green through it**: the un-turned keepout is
still perfectly correct, which is exactly why P7 cannot see this.

**Witnessed red 2 — the echo dropped** (`rotation_deg: 0.0` in `report_of`, the
rest wired correctly). Run FIRST with only limbs B and D, where it was **green**:

```
  PASS    P7R  TURNED-CLAMP KEEPOUT   a clamp turned 180 degrees about its anchor is checked WHERE IT IS: ...
  PASS    FLAG FLAG ACCEPTED + DISCARDED ...
```

**That green is why limb E exists.** The emitted program is untouched by this
defect, so no program-side check could ever have seen it — while the browser,
which draws clamps from that report and not from the config it posted, would
render a clamp **square to the machine's axes over a keepout that turned**. With limb E
added, the same plant:

```
  FAIL    P7R  TURNED-CLAMP KEEPOUT   the keepout turns but the PICTURE does not: the report echoed rotation_deg=0 for a clamp declared at 37 (exit=0). The browser draws clamps from this report, so it would render a clamp square to the bed over a keepout that is not — an operator looking at a clear bed while the checker is refusing, or worse, at a clamp that is not where the steel is
```

**Witnessed PENDING — the reachability probe is live, not dead code.** Observed
on this same session's baseline run, before the field existed: `exit=2`, stdout
empty, `unknown field \`rotation_deg\``. The branch is kept, so removing the field
returns the gate to PENDING **and says so**, instead of quietly scoring A and C
and calling the row covered.

⚠ **What P7R does NOT cover:** that the browser actually **uses** the echoed
angle when it draws. Limb E proves the number leaves the core; it cannot prove
three.js turns the box. That leg is `I1`'s, and this row does not imply it.
The core-side controls (`contains` reverted to the axis-aligned test; widened to
the rotated clamp's **bounding box**) live in
`core/src/fixture.rs::rotated_clamp_tests`, where the second also caught the
first mirror control being vacuous.

## Previously PENDING — all now armed

Every gate below was PENDING while its engine did not exist, and each was armed
only once a plant could be watched making it go red.

| # | Gate | Physical failure it guards | Negative control |
|---|---|---|---|
| P1 | Tabs | untabbed parts break loose into a 2.2 kW spindle | `--plant no-tabs` |
| F1 | DXF/SVG intake | a dropped entity cuts a part that is missing a feature | a SPLINE that must be named |
| I1 | Browser/CLI parity | the two hosts must run the same code, not agree by luck | byte compare, both hosts |
| P2 | Pocket clearing | an outlined pocket leaves an island standing | `--plant outline-only` |
| P3 | Pocket floor depth | a pocket short of its floor looks right and will not seat a tenon | `--plant shallow-floor` |
| P4 | Dogbone relief | a square peg will not seat in a round-cornered socket | relief bores in the G-code |
| P5 | Hole sizing | a drill makes a hole its own diameter, not the design's | `--plant wrong-drill` |
| P6 | Collet vs shank | an oversize shank will not enter; an undersize one is thrown | `--plant oversize-shank` |
| P7 | Fixture keepout | a toolpath through a clamp destroys both | `--plant cut-clamp` |
| P7R | Turned-clamp keepout | a clamp the VIEWPORT turns and the CHECK does not is drawn where it is and checked where it is not, and it fails in **both** directions: a cut into the real clamp passes because the axis-aligned box misses the steel, or a sound program is refused because that box covers empty area. Only the first breaks a cutter; the second is what gets a keepout muted. **P7 is green through all of it** — the un-turned keepout is still correct | three source-level plants on three layers, all watched red: `Clamp::rotated` dropped in `JobConfig::apply` (limb B emits a 9388B runnable program **into** the clamp, exit 0); the `report_of` echo dropped (invisible to B/D — it was **green** — which is why limb E asserts the angle comes back at 37°); and `Clamp::contains` reverted / widened to the bounding box in `core/src/fixture.rs`. See the section above |
| P8 | Nest transform | nest polygons drop internal holes and still look right | 🔴 **REWRITTEN 2026-08-10 — it had none.** In full, it was `nest-check 30 500 400` and `nest-check 0 0 0`, asserting **two exit codes and the substring `4 holes`** against `core/src/fixtures.rs::nest_check`, a core function whose doc comment opens `/// Gate P8:` and which **nothing else calls**: P8 re-implemented the transform on `plate()` and checked its own arithmetic. The `identity` limb was decoration (at `rot=dx=dy=0` the expected position equals the original by construction) and `/4 holes/` also matches `14 holes`. No plant, no failing input, **no product path** — the closest thing in the file to a gate that can only pass, on the gate this document calls the highest-consequence one. It now drives **`nest`**, the path an operator uses, and asserts the EMITTED program: **T** a pure drag moves all 363 emitted positions by exactly the offset (not just the holes — a holes-only check cannot see its own mirror image); **R** the 4 interior holes are the clean set turned by exactly the angle asked for, matched as a SET with a bijection required and **no knowledge of the rotation anchor**, so a core that turns about the wrong point cannot satisfy it; **RT** offset composes AFTER rotation, in machine coordinates — measured, then asserted; **N** exactly 4 canned cycles, not `>= 4`. `nest-check` is kept as corroboration with the count anchored (`\b4 holes\b`). Non-vacuity: `--self-plant p8-expect-shift` moves this gate's own expectation by 1mm and it must go red |
| P9 | Material-removal sim | gouges are invisible until the part is scrap | `--plant gouge` |

### Armed later still — the settings and seams these guard did not exist yet

| # | Gate | Physical failure it guards | Negative control |
|---|---|---|---|
| B2B4 | Datum + material | a datum or material setting consumed by nothing reads as configured | datum shift + material bounds diff |
| TECH | Technology seam | ~~an unimplemented process posted as CNC drives a spindle through an FDM plan~~ 🔴 **HONESTLY DOWNGRADED 2026-08-10: THAT FAILURE CANNOT OCCUR, so this gate could not go red for the reason it existed.** `Technology::Fdm` is reachable from exactly one place in the whole CLI — the `dialect-rules` **reporting** subcommand (`cli/src/main.rs:899`). No `job`, `report`, `import`, `nest` or `fixture` path takes a technology, so no job can be posted as the wrong one. Every assertion the gate made was on a **metadata dump** (`implemented`, `has_post`, two substrings out of the `why` fields), which is the exact shape `AGENTS.md` bans, and its declared control (*"`Technology::Fdm` must refuse"*) was a restatement of one of its own limbs | ~~`Technology::Fdm` must refuse~~ — that was the check written twice, not a control. **What it holds now, smaller and true:** (1) the declaration, labelled as a declaration; (2) **an unknown technology must be REFUSED, not approximated** — the limb that gives this gate a reachable red, **and it is RED today**: `dialect-rules no-such-technology` exits 0 and returns the CNC ruleset, because `cli/src/main.rs:900` matches `Some("fdm") \| Some("FDM")` and falls through `_ =>` to `Cnc`, so every typo, every future technology name **and a missing argument** are answered as CNC — this gate's own headline failure on the one path that can reach it, owned by `cli/`; (3) the FDM ban list is run over a **real emitted CNC program** and must HIT, because a list that never fires is indistinguishable from an empty one and G2 asks the core for exactly this kind of list. ⚠ **Still uncovered, and it is the original claim:** nothing posts a job as a technology. This row arms the day a product path takes one |
| C6 | Tool library I/O | a tool fed at somebody else's numbers burns the edge | an invalid tool refused by name |
| MARK | Part marking | 36 identical blanks cannot be sorted without an ID. 🔴 **AND THIS GATE READ THE PLAN, NOT THE PROGRAM, UNTIL 2026-08-28** — it asserted on `report.render`, the move list `core/src/fixtures.rs` builds by walking `r.path.moves` one step BEFORE the post. One doctrinal violation sitting inside the harness that enforces the doctrine: *assert on the emitted program, never on the setting that was supposed to produce it* is this lane's standing rule, and it has been bitten by that shape five times (`ENT`'s vertical plunge under `EntryMode::Ramp`, `EntryMode::Helix` aliased to `Ramp`, `P4`'s dogbone counts, `P3`'s `pocketFloorZ` helper, a `JobSummary` walked off `path.moves`). A post that dropped, rounded or reordered the marking moves would have left it green. ⚠ Blast radius is small and is not zero: marking is cosmetic, which is why this was carried as TODO #145 rather than fixed under the safety work — and then fixed | **reads `gcode` and nothing else.** DEPTH: cutting moves at engraving depth in the emitted text, with **modal Z tracked line by line** because a `G1` carrying no Z word is still cutting at the last Z stated. TOOL: attribution from the `( op: <name> [<tool>] )` banner the core writes and `parse_banner` reads back — the only place the emitted program says which cutter a move belongs to, since this post emits no `T` word and no `M6` (the change is a banner, a collet note and M5/M3). The marking ops must name a cutter the profile ops do not. Two `--self-plant` controls, one per limb — `mark-depth-window`, `mark-banner-blind` — **two witnessed reds below** |
| LEAD | Lead in/out | entering along the wall leaves a witness mark on the finished edge | arc count with and without leads |
| ENT | Entry into the cut | a cutter dropped straight to depth loads the ends of the flutes, which do not cut axially — it snaps the tool or lifts the work off the spoilboard | `--config {"op":{"entry":"Plunge"}}` must produce the plunge the default must not |
| SPIN | Spindle band + spin-up | cutting before the spindle is at speed, or at an rpm it cannot deliver, is a chipload the cutter is not rated for | `--plant rpm` |
| REL | Release ordering across tool groups | a part whose outline is cut by one tool group and whose holes are cut by a LATER one is held by its tabs alone while that later tool works on it — **it breaks loose into a 2.2 kW spindle.** This is P1's physical failure arriving through the *ordering* rules instead of through a missing tab, which is exactly why P1 cannot see it: every tab is present and correct on a part that is nonetheless loose | **TWO controls.** (1) `--plant release-order` — `optimise::GroupOrder::FirstAppearance`, driven through `job two-part`, the one fixture whose first-appearance order is genuinely unsafe. It must be REFUSED with **empty stdout**, the refusal must name the released part and every stranded interior feature, and the core must report `planted-difference: YES` — *a plant that stopped planting is asserted against, not assumed away* (all five other fixtures report `NO`). (2) in-gate: the same emitted program re-sorted into the **pre-fix first-appearance group order** (rebuilt from the core's own "tool groups reordered: A, B -> B, A" note) must be caught by the same checker. Two witnessed reds below |
| TOOL | Tool selection | a program whose feeds, depth per pass, pass count, ramp lengths, tab heights, collet check and every clearance were derived from a cutter that is **not in the spindle**. It renders correctly, posts, downloads and cuts — the only thing wrong with it is the tool. **Two distinct failures landed in one silent fallback:** nothing chosen, and a MISTYPED id whose `find()` missed. The second is the worse: an absent id at least corresponds to a choice nobody made, while an unresolvable one is a program that silently **contradicts an explicit instruction** | `--plant tool-substitute` — the pre-fix swallow restored, driven through `report`, and its polarity is **inverted**: the planted run must EMIT a runnable program. Witnessed red below |
| DOOR | The two tool doors agree (armed 2026-08-11) | `tool_id: X` and `tool_ids: [X]` name the same one cutter and are **two different code paths into the planner**. `tool_ids` runs `assign_tools_from_set` → `recommend()` per feature, and every rejection becomes a `tool_set_refusals` entry that reaches the check at `job.rs:1140`. `tool_id` sets the tool on every operation and **returns** — `apply_tool_set` receives `None`, the refusal list stays empty, and the check has nothing to refuse. ⇒ **the one-tool run was never PASSING the per-feature check, it was SKIPPING it.** `pocket` with a 6mm down-cut through the singular door emits **962 lines, `ok: true`, `refusals: []`** while the simulator **on that same run** reports 6.0mm of material standing at (120.6, 90.6); the set door refuses the same job with *"6mm does not fit inside this loop"*. `Drill - Brad Point 6mm 2F` clears the singular door on `plate`, `pocket`, `socket` and `clamped` and emits **profile contours cut with a drill bit**, which the set door refuses in as many words — *"its cutting geometry is on the point, not the flank"*. The physical failures are P2's and P9's arriving through a door neither of them watches | **no allowance list, and it will not be given one.** Some divergences look like the *set* door being right rather than the singular door being wrong — on `plate` the set door re-decides Profile→Drill at `job.rs:2081-2098` and the singular door does not — but a gate that permits *some* disagreement cannot tell the benign direction from the dangerous one, which is the entire question. Three `--self-plant` controls, one per limb — `door-same-door` (both sides driven through the SET door: the divergence vanishes to **0/306** and the gate must report a **dead instrument**, not a pass), `door-library-blind` (the 51-tool sweep narrowed to 5) and `door-inject` (one extra disagreement, which the gate must count and NAME). Plus a six-case classifier control on every pass, because the byte-comparison branch is not reachable from any agreeing pair on this tree. **Five witnessed reds below** |
| FLAG | A flag accepted and DISCARDED — **in the CLI and in this harness** | the operator, the script **and the gate** all believe a setting took effect. `import <dxf> --plant <x>` exited **0** having done nothing — so a negative control driven that way runs clean and **reads as a passing control**, which turns this lane's core safety mechanism into decoration. `job <name> --config <file>` built no `JobConfig` at all, discarding every machine, workpiece, clamp, tool and op setting in the file — including when the path did not exist — on the host that prints the program an operator sends to the machine. 🔴 **And limb 5, added 2026-08-11: `gates/slicer_gate_check.mjs` ITSELF ignored every argument it did not read**, so `--help`, `--quik`, `--only G0`, `--self-plant=<name>` and a bare word each **started a full pass and regenerated `web/src/wasm` — a committed artefact**. The harness enforcing this contract kept a lower standard than the thing it gates, and `c4db1a5d8a` records what a silent rewrite of that artefact costs | **every limb is a PAIR**: the refusal is asserted beside a VALID invocation on the same path that must still succeed. For limb 5 the property is **ORDERING, not the exit code** — exit 2 after the rebuild is not a fix — asserted through an **empty stdout** (the banner sits three lines above `cargo build --release`, so nothing printed means nothing built) *and* the mtime+size of the three artefacts a full pass moves, with an **idle control window** so another lane writing `web/` cannot be misread as our mutation. `--self-plant flag-harness-unguarded` reconstructs the pre-fix runner by deleting the guard call. **Three witnessed reds below** |
| RPRB | Re-probe after a tool change | a new tool is a new **length**, so the Z datum set for the previous one describes a tip that is no longer there. Every cut after the change is displaced by the difference — short and the tenon will not seat, long and the cutter is in the spoilboard — and the program renders, posts and runs perfectly either way | `--plant no-reprobe`, driven on `multi-tool`. The `G38.2` is read out of the slice of the EMITTED program **after the last `M0`**, never counted over the whole file (a program that probes twice at the start and never again passes a count). Paired: skipping the re-probe is **allowed** — some shops set tool-length offsets at the controller — but never **silent**, so the planted run must still carry the acknowledgement naming the tool-length error |
| REACH | Unreachable material is NAMED (armed 2026-09-05) | 🔴 **THE ONLY OBLIGATION IN THIS TABLE.** Every other gate here FORBIDS something and goes red when it sees it. This one REQUIRES the program to say something — and a feature that is simply not cut leaves **no wrong move for a prohibition to find**. Measured 2026-08-31: a 60x60 plate with a 2mm x 55mm notch, cut Outside with a 6mm cutter, emitted **230 cutting moves with `ok=true` and `gouge=0`** while **109.8mm² of its own outline could not be produced** — a 6mm tool cannot enter a 2mm gap, the offset closes the slot, and the part comes out **SOLID** there. Every coordinate is a real coordinate of a real part, so nothing downstream notices and it is found at assembly. ⚠ The note gives the **area**, because a note without a quantity cannot be told from one about corner rounding | 🔴 **The negative control is INVERTED, and that is the whole difficulty.** The planted defect is the **SILENCE**: `--plant reach-blind` removes the sentence and leaves the G-code **byte-identical**, which is the exact state the defect produced before `unreachable_feature_note` existed. ⚠ This needed a new `PlantEffect::NoteDisappears` arm and a `notes` observable — the plant framework could not express an obligation plant, because every observable it had (refusal, program, verdict) assumes the plant CORRUPTS something. The observable is consulted **only** for contracts declaring it: widening the global set made two unrelated plants read as "not inert" and moved their ablation reasoning. Third limb on every pass: a drawing with **nothing** unreachable must stay silent, or the note is a rubber stamp and the first limb is vacuous |
| MULTI | Several drawings on one workpiece (TODO #31 / #54, armed 2026-08-10) | two parts cut from the same material is **one program destroying its own second part**: the first profile removes the second's edge, and what is left is a loose offcut under a 2.2 kW spindle **while the program is still running**. Nothing downstream can notice, because every coordinate is a real coordinate of a real part. So the refusal comes **before the program exists** and emits **zero bytes** — G13's property, applied to a nest. Four silent failures sit here, one limb each. (1) An overlap **warned about over a runnable file** — a warning printed above a program is a program that gets run. (2) A part the operator **moved** that moves only in the picture, which is this lane's most-repeated defect arriving one object along; the limb asserts that part A is byte-for-byte where it was while part B moved by exactly the amount typed, because "the program changed" would pass for a per-drawing offset that is really the job-level one wearing a per-part label. (3) A part the operator **turned** whose toolpath is planned unturned — it cuts the wrong shape and the render is the half that looks right (`P7R`'s lesson, one object along); the limb reads the **emitted X and Y spans** and requires them to swap on a quarter turn about a corner that stays put. (4) A refusal so eager that **nothing ever emits**, which is indistinguishable from a working check until the day somebody needs two parts on a workpiece | `--plant overlap-unchecked` on `nest`, **inverted polarity** like `tool-substitute`: the clean run is REFUSED and the planted one must EMIT a runnable program for the very workpiece just refused. Driven on `gates/fixtures/overlap.dxf` — two rectangles sharing 50 x 80mm — because the check only exists where drawings exist. Plus four in-gate controls on every pass: the **paired positive** (the same two parts 300mm apart must emit, so a check that refused everything cannot hold this row green), the **too-close** leg (4mm of channel for a 6mm cutter must refuse as TOO CLOSE and **not** as an overlap — a different failure with a different fix), the turned-workpiece leg (a 50mm per-drawing drag on a workpiece turned 90° must land as +50 in the machine's Y), and a **flag/plant refusal** leg (`--at`, a fixture plant, and an unknown plant must each exit 2 — a flag accepted and discarded makes every control driven through it vacuous). Two witnessed reds below |
| MOVE | Dragging the part on the workpiece | a part the operator has moved must move **in the emitted program**, by exactly the same amount, measured **on the workpiece** so it turns with the workpiece. Three silent failures sit here and the gate has one limb for each. (1) An offset stored, displayed and dropped before the program — this lane's most-repeated defect, four times over (`EntryMode::Ramp` with a full-depth plunge, P4's dogbone counts, P3's `pocketFloorZ`, a `JobSummary` walked off `path.moves`); the operator reads 50mm on the panel and the machine cuts where the part was. (2) Geometry that moves while the **verification** stays behind — DINV's defect one term along: measured at 4301 gouges on `plate` at a 50,25 drag with the regions left on `Stock::place`, and further out the two stop overlapping at all and the sim reports a clear workpiece it never examined. (3) A drag that **relocates a program past a clamp** instead of being refused by it — the clamps do not travel with the parts, which is why `fit` reports a datum shift and refuses to apply one and `layout` grades a placement rather than choosing it | `--plant drawing-offset-ignored`, **vacuous without its config** (the thing it discards is 0 by default) so it is driven with `{"drawing_offset":[50,25]}`; the planted program must be **byte-identical to the unmoved one**, which is the defect stated as a consequence. Plus three in-gate controls on every pass: the turned-workpiece leg (a 50mm drag along the workpiece's X must land as +50 in the machine's Y), the sim-verdict leg at three drags, and a **paired** clamp leg — `job clamped` with the part dragged 160mm into `bar-right` must exit non-zero with empty stdout while the same fixture undragged still emits. 🔴 **NO RED HAS EVER BEEN RECORDED FOR THIS GATE — corrected 2026-08-10.** This cell used to claim four witnessed reds, *"below"*. There is no MOVE section below it, and `grep -oE 'FAIL +MOVE'` over this file and 2000 commit bodies returns **zero hits**. The implementation is one of the best in the suite and the plant is live, checked on every pass; what was missing was the evidence, and the citation covered for it. The four legs above are in-gate controls asserted every run, which is a real control and is **not** the same class of evidence as a watched red — say which one you have. Now enforced by gate `GDOC` limb B |
| PLANT | The plants still plant | **this one does not guard a physical failure — it guards the evidence for all the others.** A negative control that silently stops planting runs CLEAN and reads as a **passing** control, so every other row in this table quietly becomes decoration. Until 2026-08-09 exactly three gates checked their own plant (DOC, TOOL, REL) | the registry comes out of the binary (`2bee-slice plants`), and the gate drives every plant on its declared target and asserts a **consequence**. Four limbs, one of which is an in-gate blindness probe that runs on every pass — **four probes, one per checker arm**, plus the core's own `PLANT DISARMED` token read on every planted run, which since `ea6cf254f0` is the ONLY thing separating a vacuous plant from a genuine refusal. Ten witnessed reds below |
| PROBE | XYZ touch plate | an X/Y probe touches with the **side** of the cutter, so the datum carries the **tool radius** — a wrong radius displaces every coordinate in the program, and a displaced program renders perfectly and cuts the part in the wrong place. **The same displacement comes free from a plate that does not follow its workpiece** (TODO #40): the corner plate is hooked over the *workpiece*, so a workpiece dragged or turned with the plate modelled on the machine leaves the datum describing a corner that is not there. Also: a probe under a running spindle destroys the plate and the cutter; a probe after the first cut sets a datum for work already done; an assumed corner drives the cutter *into* the plate; a side probe against a workpiece lying at a free angle measures a slanted face | the same plate probed with a 6mm and an 8mm cutter must give datums exactly one radius apart (a hardcoded constant passes one and fails the other); a back-right plate must invert every X/Y sign; **a workpiece moved to (137,42) must move the datum and the probe station with it, proved through the core dump *and* through the real CLI `--config`, and a quarter turn must carry the plate round and reverse the stand-off — while a FIXED plate on the same moved workpiece must NOT follow**; seven refusals (`stock.corner_plate`, tool radius, `top_mm`, `wall_mm`, a plate that *has* no wall — refused with a different message — `xy_depth_mm`, and a workpiece not square to the machine's axes) must each refuse and emit **no** `G38`; **plus the EIGHTH, on the Z-only path every existing machine takes: an undeclared `machine.touch_plate_mm` (#43 P0) — `--plant undeclared-plate` drives it through the real binary and must exit non-zero with EMPTY stdout, paired with the same job declaring a plate and still probing, so "refused" cannot be confused with "stopped probing"**; plus six in-gate controls that feed the checkers a corrupted program, including the exact text the pre-#40 core emitted |

⚠ **P8 is the highest-consequence one on the list.** `build_nest.py` documents
that it *"drops internal holes"*, so the nest output is **placement data, not
machinable geometry**. Piping a nested outline straight into CAM cuts parts with
no rabbets and no holes — and it *looks correct*, because the outlines are right.

**I1 fails if port 4173 is already served.** That is deliberate, not a flake:
Playwright is configured with `reuseExistingServer: false`, so a stale preview
server left over from a screenshot or a previous run would otherwise be tested
INSTEAD of a fresh build — a green from I1 would then say nothing about the code
just changed. Kill the stale server and re-run; do not set `reuseExistingServer`.

## DOOR — the two tool doors are supposed to be one door (armed 2026-08-11)

**This gate was written RED and landed RED, deliberately.** It is the negative
control for a fix that was in flight in `core/**` while it was being built, and
a gate is more useful red on the day the defect exists than green a week later.
It was not marked PENDING and must not be: `PENDING` is for a check that
**cannot run**, and this one runs fine and answers. Red is the honest state.

**What it asks.** For every (fixture × single tool) pair — 6 fixtures × the
whole 51-tool library = **306 pairs** — `{"tool_id": X}` and `{"tool_ids": [X]}`
must return the **same verdict**, and where both emit, the **same program bytes**.
Asserted on the emitted program, never on the plan, per the standing rule; every
pair the gate names is then re-driven through `job`, which is the host that
actually prints the program an operator sends to the machine, and `job` must
corroborate `report` byte-for-byte and on the exit contract.

**What a green here would mean, and what it would still not see.** Green means
the **core's** two doors are equivalent. It says nothing about *which door a
host uses*: `web/src/App.tsx` now sends `tool_ids` unconditionally, which removes
the browser's **reach** to the singular door and changes nothing about the core
asymmetry — this gate would still be red. It also says nothing about whether
either door is **right**: agreement is not correctness, and both doors could
agree on a program that gouges (that is P1–P9, TOOL, DOC, ENT). And it says
nothing about a set of two or more tools, which has no singular counterpart.

**Why there is no allowance list.** Twelve of the 66 divergences are
same-verdict-different-program, and some of those look like the *set* door being
right rather than the singular door being wrong — on `plate` the set door
re-decides Profile→Drill at `job.rs:2081-2098` and the singular door does not.
They are still two doors disagreeing about one cutter, and **a gate that permits
some disagreement cannot tell the benign direction from the dangerous one**,
which is the entire question. ⚠ And "benign" did not survive being looked at:
the `socket` and `clamped` divergences on the 6mm class have **identical line
counts** and differ only in `M3 S18000` / `F3600.0` against `M3 S24000` /
`F4800.0` — the same cutter, the same fixture, two spindle speeds and two feeds
depending on which field named the tool. A comparison keyed on line count reads
those as agreement. This one compares bytes.

**Cost, measured rather than budgeted.** 612 `report` invocations at ~21ms
≈ 13s, plus ~3s of `job` corroboration, on a `--quick` run that took ~22s
without it. **It runs under `--quick` anyway** — `--quick` is what people
actually run, §4 of this document exists because a `--quick` run and a full run
disagreed about a verdict, and a sweep that only runs behind the wasm rebuild is
a sweep that does not run. It is **not** in `PENDING_BUDGET`. The corroboration
half is proportional to the number of disagreements, so it costs ~3s today and
~0 once the core is fixed.

### The five witnessed reds

**1 — the product, clean run** (`node gates/slicer_gate_check.mjs --quick`).
The number is anchored to the core digest because `core/**` was being edited by
another agent while this was written, and a count with no anchor cannot tell a
fix from a different binary:

```
  FAIL    DOOR  THE TWO TOOL DOORS AGREE 66 of 306 (fixture x single tool) pair(s) DISAGREE at
  core de7d9f0d917d — the same one cutter, the same fixture, two answers depending on which
  field named it. 46 in the DANGEROUS direction (`tool_id` emits a program `tool_ids` refuses),
  8 the other way, and 12 where both emit DIFFERENT BYTES. 240 pair(s) agree (0 both emit, 240
  both refuse) ... EVERY agreement on this tree is two refusals. There is no (fixture x single
  tool) pair anywhere in the matrix on which both doors emit and produce the same program.
  Where the cutter cannot do the job both doors say so; wherever one CAN, they differ. 134
  side(s) of the pairs below were re-driven through `job` — the host that prints the program —
  and it corroborates `report` byte-for-byte and on the exit contract.
      EMITS-vs-REFUSES  pocket   End Mill - Down-cut 6mm 2F   tool_id EMITS 963L (sim uncut=3,
        Uncut { x: 120.6, y: 90.6, standing_mm: 6.0 }) · tool_ids REFUSES: pocket-10: NO TOOL IN
        THIS LIBRARY CAN CUT THIS POCKET.
      EMITS-vs-REFUSES  plate    Drill - Brad Point 6mm 2F    tool_id EMITS 498L · tool_ids
        REFUSES: plate: NO TOOL IN THIS LIBRARY CAN CUT THIS PROFILE.
      DIFFERENT-PROGRAM socket   End Mill - Down-cut 6mm 2F   both emit, DIFFERENT BYTES:
        tool_id 586L vs tool_ids 586L
VERDICT: NO-GO — 5 gate(s) did not pass, and 4 could not run (RUN, I1, CTRL, AGPL).
```

**2 — `--self-plant door-same-door`: the one failure this gate cannot survive.**
Both sides driven through the SET door. The product divergence vanishes to
**0 of 306** — and that is precisely the reading a comparator without an
instrument check would have printed as a pass. A door compared with itself
agrees perfectly, always, and is byte-identical to a fixed core from every angle
except the config that was written to disk. So the config is read back and its
**shape** asserted:

```
  SELF-PLANTED FAIL    DOOR  THE TWO TOOL DOORS AGREE THE INSTRUMENT, NOT THE PRODUCT — 1
  fault(s) at core de7d9f0d917d, so this run does not know what it measured (0/306 pair(s)
  diverged, which is NOT a trustworthy number while this list is non-empty):
      DEAD INSTRUMENT: the two sides were driven with {"tool_ids":["Ball Nose 3mm 2F"]} and
      {"tool_ids":["Ball Nose 3mm 2F"]} — that is one door compared with itself, and "the two
      doors agree" is not what this run measured
VERDICT: NO-GO
```

**3 — `--self-plant door-library-blind`: a sweep that narrows silently.** The
tool set is **discovered**, never enumerated, and checked against the core's own
`library_size`, so a matrix that stops covering cases cannot report a clean
sweep of the cases it still runs. `cadt-file-blind` one lane along:

```
  SELF-PLANTED FAIL    DOOR  THE TWO TOOL DOORS AGREE THE INSTRUMENT, NOT THE PRODUCT — 1
  fault(s) at core de7d9f0d917d ... (8/30 pair(s) diverged, which is NOT a trustworthy number
  while this list is non-empty):
      the sweep covers 5 tool(s) and the core reports a library of 51 — a matrix that narrows
      silently reports a clean sweep of the cases it still runs
VERDICT: NO-GO
```

**4 — `--self-plant door-inject`: a fresh disagreement, counted and named.**
66 → **67**, 46 → **47** dangerous, and the extra pair is labelled `PLANTED` and
attributed to the harness rather than to the product:

```
  SELF-PLANTED FAIL    DOOR  THE TWO TOOL DOORS AGREE 67 of 306 (fixture x single tool) pair(s)
  DISAGREE at core de7d9f0d917d ... 47 in the DANGEROUS direction ... SELF-PLANTED: one extra
  pair below is this harness's, not the product's — plate x Ball Nose 3mm 2F (a synthetic
  program where both doors refused).
      PLANTED EMITS-vs-REFUSES  plate  Ball Nose 3mm 2F  tool_id EMITS 4L · tool_ids REFUSES:
        plate-hole1: NO TOOL IN THIS LIBRARY CAN CUT THIS HOLE.
VERDICT: NO-GO
```

🔴 **This control's FIRST draft planted nothing, and only driving it said so.**
It was written as *"append a line to the singular program of a pair that
agrees"* — and on this tree **every agreement is two refusals**, so there was no
program to append to. Clean and planted both printed `66 of 306`. That is gate
`PLANT`'s founding failure occurring inside this gate's own controls; it now
perturbs whatever the first agreeing pair can carry, records which arm fired,
and **DOOR fails if neither did**.

**5 — the classifier control, proved by deleting the limb it protects.** The
byte-comparison branch is **not reachable from any agreeing pair on this tree**,
so it is exercised today only by the 12 real different-program pairs — and the
day the core is fixed those vanish and the branch would go vacuous with nothing
to say so. Six synthetic cases run on every pass. Deleting the `sg !== mg` arm
from the classifier on a **copy** of the gate file makes 12 divergences silently
disappear, which without the control would have read as a 12-pair improvement:

```
  FAIL    DOOR  THE TWO TOOL DOORS AGREE THE INSTRUMENT, NOT THE PRODUCT — 2 fault(s) at core
  de7d9f0d917d, so this run does not know what it measured (54/306 pair(s) diverged, which is
  NOT a trustworthy number while this list is non-empty):
      the comparator called (true, true, "G0 X1\n", "G0 X1\nG0 X2\n") "AGREE" and it is
      "DIFFERENT-PROGRAM" — every count below was produced by this function
      the comparator called (true, true, "G0 X1\n", "G0 X1") "AGREE" and it is
      "DIFFERENT-PROGRAM" — every count below was produced by this function
VERDICT: NO-GO
```

### The relayed split did not reproduce, and that is a finding

The diagnosis that prompted this gate reported **19 of 60 combinations
disagreeing — 13 dangerous, 6 benign** over 6 fixtures × 10 tools. Re-measured
independently over 6 fixtures × the **whole 51-tool library**: **66 of 306**,
of which 46 emit-vs-refuse, 8 refuse-vs-emit and 12 same-verdict-different-bytes.

**The 13/6 split cannot be a subset of that matrix under any choice of 10
tools.** Only four tools contribute a non-dangerous divergence — `Ball Nose 6mm`,
`End Mill - Down-cut 6mm`, `End Mill - Up-cut 6mm`, `End Mill - Compression 6mm`
— and each contributes exactly **five** across the six fixtures (three
different-program, two refuse-vs-emit). Since every tool in a set is run against
all six fixtures, the benign count is necessarily a multiple of five: 0, 5, 10,
15 or 20. **Six is not reachable.** Likewise the dangerous counts come in 4s, 2s
and 1s, and 13 needs an odd contributor, which only those same four tools supply
— at one dangerous *and* five benign each.

Two readings survive, and this gate cannot choose between them: the earlier pass
compared **line counts** rather than bytes (which would hide `socket` and
`clamped`, whose divergent programs have equal line counts), or `core/**` moved
between the two measurements — it was being edited throughout, and `CAD1`'s
`cad-src` digest and the CLI's core digest both changed inside this session.
**Neither reading changes the direction of the finding**; the wider scope makes
it larger, not smaller. This is why the gate prints the core digest with the
count.

## MULTI — several drawings on one workpiece (TODO #31 / #54, armed 2026-08-10)

Founder, 2026-08-10: *"In the drawings I should able to add more than 1 drawings,
I should able to rotate the drawings"*.

🔴 **The refusal came first, and it is not a preference.** `core/src/layout.rs`
had been able to GRADE a nest since 2026-08-08 — `2bee-slice layout` prints
findings and no G-code — but nothing that EMITTED a program had ever asked it.
Two drawings dropped on one spot planned two profiles through each other and
posted at exit 0. `plan_report_import_many` now runs `check_interference` on the
placed parts **before a single operation is generated**, and a condemned workpiece
returns with `gcode` empty.

**Every import goes through that one function, including a single drawing.** The
one-drawing entry points are one-element calls of it, asserted byte-for-byte
(`one_drawing_left_as_drawn_takes_the_same_route_and_emits_a_program`, and
`nest --drawing plate.dxf --id drawing` is byte-identical to `import plate.dxf`).
A separate single-drawing path would be a path on which the check does not run.

### The two witnessed reds

**1. The placement dropped before the program** — `ImportSource::is_as_drawn`
forced to `true`, so every drawing is passed through untouched while the offset
and the rotation are still stored, displayed and echoed:

```
test ...::a_per_drawing_offset_moves_only_that_drawing_in_the_emitted_program ... FAILED
test ...::turning_a_drawing_turns_the_geometry_the_program_is_cut_from ... FAILED
test ...::the_reported_drawing_is_the_placed_geometry_the_program_was_cut_from ... FAILED
test ...::the_same_two_drawings_moved_apart_still_emit_a_program ... FAILED
test ...::two_drawings_closer_than_the_cutter_are_refused_as_too_close... ... FAILED
test result: FAILED. 6 passed; 5 failed
```

⚠ Note which tests did **not** go red: the overlap refusal still fired, because
two drawings at the same spot overlap whether or not either was moved. A gate
built only on the refusal would have been green on a build that moved nothing.

**2. The findings discarded** — `if !findings.is_empty()` neutered, which is the
shape of a report that lists a refusal above a runnable program:

```
test ...::two_drawings_on_the_same_material_are_refused_with_no_program_at_all ... FAILED
test ...::two_drawings_closer_than_the_cutter_are_refused_as_too_close... ... FAILED
test ...::the_overlap_plant_restores_the_defect_and_is_not_reachable_without_it ... FAILED
test result: FAILED. 8 passed; 3 failed
```

And the registered control, through the real binary:

```
$ 2bee-slice nest gates/fixtures/overlap.dxf --config tool.json
exit=1 bytes=0
refused: part `overlap/part1` and part `overlap/part2` OVERLAP — they are cut from the
same material: 50.000mm in X and 80.000mm in Y (4000.000mm² shared …). One of them has
to come off this material — re-nest, do not nudge

$ 2bee-slice nest gates/fixtures/overlap.dxf --config tool.json --plant overlap-unchecked
exit=0 bytes=14854
```

### N copies of ONE file

Founder, same day: *"Drawing: Able to add more than 1 from the same drawing"*. Two
copies are **two parts with two placements**, and the thing that makes that safe is
that a part is keyed by its **instance** (`ImportSource::id`) and never by the drawing
it points at. `plan_report_import_many` refuses a duplicate id outright rather than
disambiguating one: operation names are `<instance>/<part>`, and two copies sharing a
name is a refusal that cannot say which copy it condemned.

🔴 **A copy lands ON TOP of the original and the job is then refused.** That is a
decision, not an oversight — offsetting it automatically would be the software moving
a part on its own, which is the one thing this tool does not do. The refusal therefore
has to be actionable, and the message now opens **`MOVE ONE OF THEM off this
material`** rather than only stating that the pair cannot be cut.

⚠ **A harness defect this found, and it would have held the gate green.** The first
per-part coordinate reader — in the core test, in this gate, and in the browser test —
split an operation comment on WHITESPACE. Real instance ids are drawing names, so
`( op: Hive super end/part1 [End Mill …] )` read as a part called `Hive`, and one
copy's coordinates were attributed to a part that does not exist. It was caught only
because a test used a realistic id; `A` and `B` would have passed forever. All three
readers now take the name up to ` [`, which is where the tool name starts and is the
only reliable end marker in that comment.

### The scope of the pair check, written down before it is needed

`check_interference` compares parts in **workpiece-local millimetres** — the datum is
applied afterwards by `Job::place`. So two parts are compared **because they share a
workpiece**, not because they are both in the list, and that is now keyed on
`PlacedDrawing::sheet_id` (always `ONE_SHEET` today) rather than left implicit.

🔴 **Why now, with one workpiece:** the moment multiple workpieces land (TODO #64), two
copies of one part on two DIFFERENT workpieces would read as a 100% overlap and this gate
would refuse a perfectly good nest with zero bytes — a total false red produced by a
check that was right when it was written. **An invariant that is true because there is
only one of something is not an invariant, it is a coincidence**, and it stops being
true silently.

Watched red: removing the two-line scope check makes
`parts_on_different_sheets_are_not_compared_with_each_other` fail while every other
test stays green — `FAILED. 0 passed; 1 failed` on the filtered run, `391 passed` once
restored.

### Two flags that are not interchangeable

`layout --at <x>,<y>` is the **absolute** workpiece position of a drawing's
lower-left corner. `nest --offset <dx>,<dy>` is a **delta from where the drawing
was drawn**, so that zero means AS DRAWN — an emitter that defaulted every
drawing to the workpiece corner would move geometry the operator never touched, and
the program would still look right. Neither subcommand accepts the other's flag:
`flags_for` refuses it by name rather than reading it as the one it does know,
and `run_nest` asserts the invariant a second time rather than trusting it.

### What MULTI does NOT cover

- 🔴 **Tabs are still per JOB, not per part.** `P1`'s physical failure is per
  part: three parts with one of them tabbed still leaves two loose pieces. TODO
  #31 item 2 is open and this gate does not touch it.
- 🔴 **The PICTURE.** A CLI gate cannot see a viewport. Three browser tests
  assert the multi-select, the per-part turn and the paired refusal in the UI —
  and they run only under `I1`, which cannot pass on this box today (see the
  WebGL note under *What the gate does NOT cover*).
- **Workpiece fit over the union** is `layout_extent`'s and `plan_placement`'s, and
  neither is driven from the planning path. The travel check still runs on the
  planned toolpath, which is the stronger answer for travel and says nothing
  about whether the MATERIAL is big enough.
- **A part nested inside another part's hole is refused as an overlap.** A known
  FALSE RED, carried onto every refusal rather than discovered: refusing a legal
  nest costs a re-draw, permitting an illegal one costs a cutter.
- **The gap margin.** Absent means the parts were checked against the cutter
  diameter alone — the bare geometric minimum, with nothing left for runout,
  workpiece bow or chip clearance. Every report says so on its face; nothing defaults
  it, because a gap computed from a number nobody chose is trusted exactly as if
  somebody had.

## CAD1 — our OpenSCAD subset means what OpenSCAD means (wired 2026-08-10)

**Physical failure guarded:** a `.scad` source the `2bee.cad` tab evaluates into a
**different part** from the one the author wrote and OpenSCAD renders. It is the
quietest defect this lane can ship, because **nothing downstream can notice** —
every contour handed to CAM is a real contour of a real solid, so the wrong part
posts cleanly, simulates cleanly, passes every gate above this one, and gets cut.

The instrument is `tools/scad_oracle/`, which runs the **real OpenSCAD
2026.08.07** binary and our own `web/src/cad/*.ts` over the same source and
compares the evaluated **CSG tree** and the **solid**. The gate drives it and
scores it; it does not edit it. Both legs are needed:
`corpus/partial_rotate_axis_angle` matches on volume and area to **1.6e-16** and
is caught only by the tree and the bounding box.

**The corpus leg is scored NAME-EXACT.** Every case that `DIVERGES` or `ERROR`s
must be one of these, each with a reason and a date in `CAD1_KNOWN`, and each
named here as well — the gate FAILs if the two lists disagree:

| Case | Why it is accepted, for now |
|---|---|
| `corpus/partial_rotate_axis_angle` | `rotate(45,[1,1,0])` is refused by name and the subtree is kept **unrotated**; only the tree and a 10 mm bounding-box error catch it |
| `corpus/fn_clamped` | `$fn = 400` against `mesh.ts`'s `MAX_FN = 256`. Tree agrees (it carries 400), solid is 5.93e-5 light |
| `corpus/refuse_polyhedron` | the corpus file winds its faces **inward**; OpenSCAD exports verbatim (signed volume −266.67), our kernel re-orients outward (+266.67). Area/bbox/centroid identical — only orientation differs, and orientation is what a CAM normal is. Added 2026-08-22 |

*(2026-08-27: `corpus/refuse_rotate_extrude` **left** the table — fixed, not
tolerated. `$fn` is carried end-to-end (scad.ts → mesh.ts → the canon marker),
and closing the revolution loop surfaced two deeper defects the open mesh had
hidden — a missing last→first strip and an inward-wound surface, volume
−1720.1166 against OpenSCAD's +1720.1165. All three fixed; the case reads
SAME on tree and solid.)*

🔴 **`corpus/partial_fa_fs_global` and `corpus/partial_fa_fs_args` were the first
two rows and are GONE — ratcheted DOWN 2026-08-11.** Both now score `SAME` ("tree
and solid both agree"), so limb 3 held the gate red until the exemption was
withdrawn. **This is a tightening, not a raise:** either case diverging again is
now a *fresh* divergence that fails `CAD1` by name.

They were an exemption for a defect **on the wrong side of the comparison**. Both
rows asserted that `mesh.ts` never reads `$fa`/`$fs`; it does —
`fragmentsRequested` derives the fragment count from both (`360/$fa` and
`2πr/$fs`) — and the hard-coded `12`/`2` the rows described lived in the
**harness** (`canon.mjs`, with `ours.mjs` re-imposing it on every run). The
instrument was printing a tessellation our kernel had stopped using and
attributing the difference to the product. ⚠ *A true fact about the wrong
artefact reads exactly like a finding* — the same shape as `corpus/refuse_color`
below, found the same day, one module along.

Three things were checked before the rows came out, because *"it stopped
diverging"* has three causes and only one of them justifies the edit:

1. **Not a capability loss laundered as agreement.** `stale` is computed from
   `DIVERGES|ERROR`, so a case that went `DIVERGES → REFUSED` would read as stale
   too, and removing it would retire the exemption for a construct we had stopped
   implementing. Read at the record, not inferred from the summary: **both are
   `SAME`, neither is `REFUSED`.**
2. **Not the case file bent until it agreed.** Both `.scad` files were touched by
   `efb9cefa8d`; both were re-read and each is still a bare `sphere(r=10)` asking
   for `$fa=5, $fs=0.5` — **5180 triangles against the 840 a 12/2 default gives**,
   in the assignment form and the argument form respectively.
3. **The stated reason was checked against the code**, not against the commit that
   claimed to fix it.

The lane that fixed the harness left these entries deliberately (`gates/` is
another lane's boundary) and said so in the corpus headers; this is that report
being actioned. **A stale exemption is not inert — it is standing permission for
the real defect to return unnamed.**

🔴 **`corpus/refuse_color` was the fifth row and is GONE — it was the HARNESS, and
the row said so while declining to check (removed 2026-08-11).** It was right to
record the suspicion rather than bend the gate; it was wrong to leave it there,
because *"this may be the instrument"* written into a baseline is an accepted
divergence that nobody owns. The question was put to **the binary** instead of to
either implementation, and `openscad 2026.08.07` answers it four ways:
`color("red") cube(3);` and `cube(3);` export **byte-identical ASCII STL**; a
`color()`-wrapped **difference minuend** is byte-identical to the same program
without it; **`alpha = 0` still exports 12 facets**; with several children it
behaves as a group, and empty it emits no geometry at all. `color()` is a
*container* in OpenSCAD's own semantics, so `canon.mjs` mapping it to an OPAQUE
node was **the harness reporting its own vocabulary as a defect in the product**.
`canon.mjs` now maps `color()` — and `render()`, the same defect one module along,
also byte-identical at the binary — to a union. The case is renamed
`corpus/passthrough_color` and joined by five more that pin the behaviour, and the
**ratchet-down limb is what forced this row out** rather than letting it sit as
silent headroom.

⚠ **Four more `refuse_*` cases were stale the same way and only this one had been
noticed** — `refuse_children`, `refuse_function_def`, `refuse_let` and
`refuse_modifier_highlight` all read `SAME` with **zero refusals**. They never
reached the baseline because they stopped diverging rather than started, so the
ratchet had nothing to catch: **a stale case NAME is invisible to a gate that only
scores failures.** They are renamed to what they now test (`module_children`,
`variables_function_def`, `control_let`, `edge_modifier_highlight`). The lesson is
the general one — the finding handed over named one case, and the property behind
it covered five.

⚠ **A sixth entry, `corpus/edge_modifier_root`, was written into the baseline and
removed the same hour** — the `!` root modifier, where OpenSCAD emitted the cube
and we emitted the sphere, *the opposite object*. The **ratchet-down limb went
red on it, unplanted**, on this gate's first real run, because the agent working
in `web/src/cad/` fixed it between the measurement and the run. That is a better
control for that limb than the planted one, because nobody arranged it.

### CAD1 — the three-valued refusal, and the two things that were not reading it (2026-08-11)

🔴 **`1e84797818` split the oracle's `REFUSED` in two and both gates went on
counting the word it had stopped emitting.** The oracle used to award `REFUSED`
as soon as we named a construct and emitted nothing — *before either leg was
compared*, so its own answer was never consulted for a refusal. It now asks the
binary first:

| verdict | what it means | is it safe? |
|---|---|---|
| `REFUSED-BOTH` | we emit nothing **and openscad emits nothing** | ✅ agreement |
| `STRICTER` | we emit nothing **and openscad produces geometry** | 🔴 a capability gap |

**Of the sixteen refusals that had been scored as safe, sixteen were capability
gaps and zero were agreement.** The only `REFUSED-BOTH` in the suite is a case
written during that pass.

**Three consequences reported by that commit and deliberately left for this one,
because `gates/` is another boundary. All three are now closed:**

1. 🔴 **Both gate messages printed `0 REFUSED` over 21 live refusals.** They
   counted `verdict === 'REFUSED'`, a word with no producer left. The counts are
   now **tallied from the rows** — every verdict actually present is printed with
   its own count — so the line cannot describe a vocabulary the run did not use.
   ⚠ **And the durable half is the other one:** a verdict word this gate does not
   model is now a **FAILURE**, not a zero. The vocabulary changed once underneath
   a gate that could not notice; the next change goes red. *A gate whose own
   output misdescribes its run is the defect this file exists to find, and it was
   in this file.*
2. 🔴 **An unlisted `STRICTER` was a NO-GO in the oracle and a PASS in `CAD1`.**
   The oracle carries the ledger verdict in its JSON (`stricterLedger`)
   *precisely because* this file branches on its exit code only for `2` — so the
   NO-GO reached nothing. It is read now, **per leg**: `fresh`/`wrongKind` can
   name a case in either leg, and failing `CAD1` — whose entire contract is the
   corpus — for a file in `hardware/cad/` is the exact defect the per-leg
   `PENDING` split was written to undo. The hardware `stale`/`gone` entries stay
   **warnings** and are printed in `CAD1H`'s message: a rename in another lane's
   tree is not a regression, and failing on one trains the "just edit the list"
   habit the ratchet exists to prevent.
   ⚠ **The category list is itself a list that can go blind**, so the oracle's own
   failure count is compared against the number of categories this gate models; a
   disagreement fails both gates rather than scoring the categories it happens to
   know.
3. **`CAD1`'s pass message claimed *"whether a construct we refuse OUGHT to be
   implemented"* was NOT COVERED.** Half of that is now measured: every refusal
   is put to the binary, and every gap is named and dated. **A stale "not
   covered" understates coverage, which is the mirror of overstating it.** The
   row now says what is still uncovered and says it precisely — the ledger
   measures what a refusal **costs**; whether anyone should **pay** it is a
   decision nobody has taken.

⚠ **The baselines were NOT touched and the tracked numbers did not move.**
`CAD1H` measured **29** against a baseline of **29**, identical before and after,
and `CAD1`'s two named divergences are the same two. Re-verified here rather than
taken from the handover.

**Four witnessed reds, one per new limb** — each drives a different branch and
each says a different sentence, which is the point of there being four:

```
  SELF-PLANTED FAIL  CAD1  … 1 verdict word(s) in this run are ones this gate does not
  model: ZZTOP — every count below is built from a fixed vocabulary, so a word outside
  it is counted as ZERO and reads as an absence
  SELF-PLANTED FAIL  CAD1H … same word, same run, both legs
```

```
  SELF-PLANTED FAIL  CAD1  … 1 STRICTER-LEDGER finding(s) on the corpus leg — a refusal
  is only SAFE when openscad refuses too, and these do not:
  corpus/zztop_not_on_the_ledger …
  SELF-PLANTED FAIL  CAD1H … 1 STRICTER-LEDGER finding(s) on the HARDWARE leg:
  hardware/zztop_not_on_the_ledger.scad …
```

🔴 **Read the pair above as the control it is:** one plant adds **one name per
leg** and each gate fails on **its own** name only. A single shared branch would
have shown both gates quoting both names.

```
  SELF-PLANTED FAIL  CAD1  … the oracle wrote no `stricterLedger` in its JSON — that
  object IS how its NO-GO reaches a gate at all … Its absence is a broken instrument,
  not a clean ledger
```

```
  SELF-PLANTED FAIL  CAD1  … the oracle raised 1 STRICTER-LEDGER failure(s) and this
  gate models 0 category(ies) of them — so it is not reading something the oracle is
  complaining about, and scoring only the categories it knows would report a clean
  ledger over an unread one
```

**The four pre-existing plants were re-driven after the change and still fire on
the limbs they name** — `cad1-oracle-plant` (60 fresh divergences on `CAD1`,
`WORSE: 30` on `CAD1H`), `cad1-baseline-slack` (`RATCHET` on `CAD1`, gate-file-30
vs document-29 on `CAD1H`), `cadt-needle-drift` (`CADT`, unchanged). A new limb
that quietly displaced an old one would be a control that stopped controlling.

### Every limb of both gates, driven 2026-08-10 — six witnessed reds and two PENDING paths

Numbers are `--quick` runs; the whole-run verdict is `NO-GO` throughout for
reasons unrelated to these gates (`core/src` was mid-edit and would not compile
for part of the session), so read the **gate line**, not the tally.

**1 — CAD1 ratchet-down, UNPLANTED.** The first real run, and the best control of
the set because nobody arranged it: the agent in `web/src/cad/` fixed the `!`
root modifier between the baseline being measured and the gate being run.

```
  FAIL    CAD1  SCAD SUBSET vs OPENSCAD RATCHET: 1 baseline entr(ies) no longer
  diverge and must be REMOVED — corpus/edge_modifier_root. A baseline that keeps
  headroom it has stopped needing is the slack that absorbs the next regression,
  which is the whole reason this limb is a failure and not a note.
  corpus 63 cases: 41 SAME, 17 REFUSED, 5 DIVERGES/ERROR
  (openscad OpenSCAD version 2026.08.07, cad-src 4bb0142dfccd)
VERDICT: NO-GO
```

**2 — CAD1 fresh-divergence limb**, `--self-plant cad1-oracle-plant` (the oracle's
own `mesh-scale`, which scales our triangles by 1.01):

```
  SELF-PLANTED FAIL    CAD1  SCAD SUBSET vs OPENSCAD 37 case(s) diverge that are
  NOT in the baseline — our subset means something OpenSCAD does not, and nobody
  wrote down why: corpus/bool_difference, corpus/bool_difference_coplanar,
  corpus/bool_intersection, corpus/bool_nested, … +31
VERDICT: NO-GO                                                        (exit 1)
```

**3 — CAD1 ratchet-down limb**, `--self-plant cad1-baseline-slack` (a known-GOOD
case added to the accepted list, so the only limb it can move is this one):

```
  SELF-PLANTED FAIL    CAD1  SCAD SUBSET vs OPENSCAD RATCHET: 1 baseline
  entr(ies) no longer diverge and must be REMOVED — corpus/prim_cube.
VERDICT: NO-GO                                                        (exit 1)
```

**4 — CAD1H document-disagreement limb**, same plant. Note the ORDER: the doc
check runs before the count comparison, deliberately — if the two copies of the
number disagree, neither of them can be trusted as the baseline.

```
  SELF-PLANTED FAIL    CAD1H SCAD SUBSET vs OUR OWN MODELS the gate file allows
  31 and SLICER-GATES.md says 30 — one of them was moved without the other, and
  a baseline that disagrees with its own documentation is not a baseline
VERDICT: NO-GO                                                        (exit 1)
```

**5 — CAD1H ratchet-down limb.** Planted the way `SPEC`'s and `GDOC`'s limbs are —
by an edit to the artefacts under test, because that edit *is* the defect: the
count raised to 31 in **both** places, which is precisely the quiet bump the
five mechanisms above exist to make loud.

```
  FAIL    CAD1H SCAD SUBSET vs OUR OWN MODELS RATCHET: only 30 files diverge and
  the baseline still allows 31. Lower it — in the gate file AND in
  SLICER-GATES.md — or the slack sits there to absorb the next regression in
  silence. hardware 68 files: 30 DIVERGES/ERROR, 24 REFUSED, 0 REAL (non-empty)
  agreement(s) (openscad OpenSCAD version 2026.08.07, cad-src ad76772ae66e)
```

**6 — CAD1H "worse" limb**, the same edit in the other direction (29 in both):

```
  FAIL    CAD1H SCAD SUBSET vs OUR OWN MODELS WORSE: 30 files emit geometry that
  is not what OpenSCAD renders, baseline 29. New or changed:
  hardware/hive_context_viz.scad, hardware/lib/autoframe_actuator.scad, … +24
```

**7 — the budgeted PENDING, and it does NOT read as a pass.** `OPENSCAD_BIN`
pointed at a path that does not exist:

```
  PENDING CAD1  openscad is not on this box (no version), so all 131 cases are
                PENDING and nothing was compared
  PENDING CAD1H openscad is not on this box (no version), so all 131 cases are
                PENDING and nothing was compared
  COULD NOT RUN HERE  CAD1 — … NARROW: only "binary not found" pends
  COULD NOT RUN HERE  CAD1H — same binary, same reason
```

**8 — and the narrow half of that budget: a PENDING for ANY OTHER reason is a
FAIL.** Driven by temporarily passing `--timeout 1` to the oracle:

```
  FAIL    CAD1  SCAD SUBSET vs OPENSCAD 131 case(s) PENDING for a reason that is
  NOT a missing binary — a check that broke, not a box that lacks a tool:
  openscad timed out after 1 ms
  FAIL    CAD1H  … same
```

### ✅ A control that did NOT work and now DOES — re-measured 2026-08-11

🔴 **This section is kept, not deleted, because a stale RED lies exactly like a
stale green — and this one understated our coverage for a day.** Everything below
the rule was true when written and is now false. Re-measured `2026-08-11`:

```
  SELF-PLANTED FAIL    CAD1  … 46 fresh divergences
  SELF-PLANTED FAIL    CAD1H … WORSE: 30 … baseline 29, real agreements 2 → 1
```

**`cad1-oracle-plant` is no longer inert on CAD1H.** The stated reason it *was*
inert — *"the 14 `SAME` rows are empty on both sides"*, so `mesh-scale` had nothing
to break — stopped holding when `93b83a472c` produced **2 non-empty `SAME` rows**.
The plant breaks one of them: `hardware/cad/lib/jzbz_cage.scad` moves `SAME → DIVERGES`.

⚠ **The same work that bought the ratchet re-armed a control this document buries
as dead**, and nothing announced it. 🔴 **`GDOC` cannot catch this class**: its
limb C matches only `"<GATE> … is PENDING/GREEN/PASSING/FAILING/RED"`, and a
paragraph arguing that a control is structurally inert is prose of another shape.
**A document can hold a false claim about a gate in a sentence no gate can parse.**

---

**Historical, as written, now FALSE:**

`--self-plant cad1-oracle-plant` **fires on CAD1 and is INERT on CAD1H**:

```
  SELF-PLANTED FAIL    CAD1  … 37 case(s) diverge that are NOT in the baseline
  SELF-PLANTED PASS    CAD1H … 30 DIVERGES/ERROR … at the baseline of 30
```

`mesh-scale` moves the **mesh** leg only, and every one of the 30 hardware
failures already fails on the **tree** leg, so scaling our triangles cannot
change any of their verdicts; the 24 refusals emit no triangles to scale, and the
14 `SAME` rows are empty on both sides. **A plant hung on the wrong pairing
proves nothing and normally says so nowhere** — which is gate `PLANT`'s own
headline finding, arriving in the gate that was written the same day. CAD1H's
real controls are reds 4, 5 and 6; `cad1-oracle-plant` is listed for CAD1 only.

## CAD1H — the same question against the 68 models this company cuts

**Why this leg is a TRACKED NUMBER and not pass/fail.** At wiring time it is
`DIVERGES 27 · ERROR 3 · REFUSED 24 · SAME 14 (all 14 empty-on-both-sides)` —
🔴 **zero real agreements on 68 files.** None of it is a regression and all of it
is known. Gating on it would ship a gate that is red on day one and stays red,
and §4 of this file already records what that does: **a permanently-red verdict
stops being read**, and then the day a real red arrives nobody sees it. Same
reasoning that produced the three-valued verdict, applied one gate along.

**What "worse" means, and why it is not `REFUSED` going down.** This lane's rule
is *refuse rather than approximate*. A refusal emits **nothing** and is safe; a
divergence emits a **plausible wrong part**. So the tracked quantity is
`DIVERGES + ERROR`, and a file moving `REFUSED → DIVERGES` counts as getting
worse **even though it looks like new capability**. That is not hypothetical: it
is what happened between the oracle's README being written and this gate being
wired, when `color()` became a pass-through and the hardware leg went from
`REFUSED 50 / DIVERGES 3 / ERROR 1` to `REFUSED 24 / DIVERGES 27 / ERROR 3`.

CAD1H BASELINE: DIVERGES+ERROR = 72
CAD1H BASELINE: PENDING = 126/318

*(2026-09-02: **a second ratchet, because the first one is gameable.** A ratchet
on `DIVERGES+ERROR` alone rewards turning a file into "undecidable": today
79 → 70 looked like a 12% capability gain and was a **one-file** gain — 9 of the
10 that left the count became `PENDING`, not `SAME`. `PENDING` is now pinned too,
so `DIVERGES → PENDING` breaks the second number. We did not get better; we
stopped being able to tell. ⚠ More than a third of this leg is now a class the
gate cannot decide, and the direction that matters is **down**.)*

*(2026-09-02: 79 → 70 — `mirror()`, the negative-determinant winding fix, and a
canon serialiser that had been dropping `multmatrix`. ⚠ **Read the transitions,
not the number:** 9 files went `DIVERGES → PENDING` and only **one** went
`DIVERGES → SAME`. Nine left the tracked count by becoming **undecidable**, not
by agreeing — seven on the ruled overlap class, two because our kernel audits
those solids as OPEN, which it did before this change too and the tree
divergence was masking. **The count improved by 9; our capability improved by
1.** Same shape as the 31 → 16 and 10 → 7 moves this document already records.)*

*(2026-09-02, same day: **80 → 79, and `cad` moved it, not us.** Between the run
that measured 80 and the gate run that scored it, `cad` deleted six pnp scratch
files (`_ab*.scad`, `_root.scad`), one of them an ERROR case. Nothing in
`web/src/cad` changed. ⚠ **This baseline is a strict-equality ratchet over
another lane's tree** — every `cad` commit that adds or removes a diverging file
reddens this gate, and the remedy is to re-measure and move the number, never to
widen the rule. The population is theirs; only the reader is ours.)*

*(2026-09-02: 7 → 80, and **this is not a regression — do not narrow the population
to 'fix' it.** The 7 was the divergence count of `lib/` **with imports unresolved**:
the collector was non-recursive (85 files of 584; zero from any product directory,
zero of the 18 `_wcnc` cut files, all of which are in subdirectories) and the
ours-side parsed with **no library host**, so every file carrying `use`/`include`
refused everything and scored `STRICTER` — recorded as safety, and it was a missing
library. The two defects were self-consistent: the set was 93% `lib/` leaf files,
the exact subset a no-host parse handles. **80 is 296 live files measured honestly
for the first time.** Population is `hardware/cad/` recursive minus `archive/` and
`ref_models/`, 288 excluded with the reason printed at run time. Of the 296, **16
are `_wcnc` cut files and 6 diverge**. The count rose 73 → 80 while `str()` and
string indexing landed, and every transition is **out of** `STRICTER` — removing a
refusal turns UNMEASURED into MEASURED-AND-WRONG, which is this document's own
`REFUSED → DIVERGES` rule arriving one step earlier.)*

*(2026-08-27: ratcheted 10 → 7 — the KERNEL this time: `$fn`/`start` carried on
rotate_extrude and `$fn` on linear_extrude closed the tree gaps on
electret_capsule_9_7mm and fan_axial (both now PENDING on the ruled overlap
class, not SAME), and corpus `refuse_rotate_extrude` reads SAME after the
closing-strip + winding fix. `linear_extrude(twist/scale)` is now refused by
name instead of silently ignored. UNDECIDED rose 42 → 45: three files left the
tracked count and zero became agreements.)*

*(2026-08-22: ratcheted 16 → 10. The instrument learned the ten constructs the
08-19→21 series implemented (8 hardware ERRORs were the serializer throwing),
and cad deleted the 12 untracked `_*.scad` scratch files that had entered the
scan set. Kernel remainder is named in the gate file: `refuse_rotate_extrude`
(dropped `$fn`), `refuse_polyhedron` (winding), hull/minkowski PENDING on the
kernel's own audit with broken meshes.)*

**That line is machine-read.** The count lives in the gate file *and* here, and
the gate FAILs if they disagree — so raising a baseline costs an edit to the
document that is read in review, and the gate is red in between.

**RE-TAKEN AGAINST COMMITTED SOURCE, 2026-08-10 23:28 — `cad-src 3f6f576a2765`.**
Both baselines were first measured over an **uncommitted** `web/src/cad/`, and the
agent who took them said so and printed the digest for exactly this reason: it had
seen **three distinct `cad-src` values inside one hour**. `web/src/cad/` has since
committed (`2bc4cb0f19`, 23:13), and the two files the oracle actually imports —
`web/src/cad/scad.ts` + `web/src/cad/mesh.ts` — now digest to **`3f6f576a2765`**
with a **clean worktree**. Confirmed three ways rather than once: the digest the
gate printed, the same construction run by hand over the worktree, and the same
construction run over a `git archive 2bc4cb0f19` extraction of those two paths —
all three agree, so the bytes measured are the bytes committed.

**The numbers did not move.** `CAD1` 63 corpus cases: 41 SAME / 17 REFUSED /
5 DIVERGES-or-ERROR, and all five are the five named above. `CAD1H` 68 hardware
files: **30 DIVERGES+ERROR**, 24 REFUSED, **0 real (non-empty) agreements** — the
baseline of 30, unchanged. ⚠ **Read that as "the earlier measurement survived
committing", not as an improvement**: there is no `REFUSED → DIVERGES` movement to
report in either direction, and this gate's own contract is that such a move counts
as **worse** even when it looks like new capability. A baseline that is stable
across a commit is a baseline you can now cite by sha; it is not a clean result,
and 0 real agreements on 68 models is still the headline.

### RE-TAKEN AFTER CAD STAGE 0 AND AFTER A HARNESS FIX, 2026-08-11 — `cad-src a3d483d382ea`

🔴 **The baseline of 30 is NOT moved, and the honest number is 35.** CAD1H was red
at `WORSE: 35 … baseline 30` and stayed red. *(Tense corrected 2026-08-14: this is a dated
record of that day's run; the live state is in the UNDECIDED-class section below.)* Stage 0 took the hardware leg's
`REFUSED` count from **24 to 2** — 22 hive models that used to emit nothing now
emit something — and by this gate's own contract — *a refusal emits nothing and is safe;
a divergence emits a plausible wrong part* — that is **getting worse**, not new
capability. Raising the line to 35 would be paying for reach with the one property
this leg exists to protect.

Measured over **committed** source: `web/src/cad/scad.ts` + `mesh.ts` at
`21565e307e`, clean worktree, digest **`a3d483d382ea`**, `openscad 2026.08.07`,
byte-stable across three consecutive runs.

| | corpus (68 cases) | hardware (68 files) |
|---|---|---|
| before the harness fix | 44 SAME (2 empty) · 14 REFUSED · **5 DIVERGES** | 14 SAME (**all** empty) · 2 REFUSED · **51 DIVERGES** · 1 PENDING |
| after | 50 SAME (3 empty) · 14 REFUSED · **4 DIVERGES** | 15 SAME (**1 real**) · 2 REFUSED · **35 DIVERGES** · **16 UNDECIDED** |

**What the harness fix was worth, stated as the thing it actually moved: hardware
files whose TREE agrees went 15 → 42.** That is the *27* the finding predicted, and
it lands exactly. ⚠ **But a tree that agrees is not a part that agrees, and the
split is the whole story:** of those 27, **1** became a real agreement, **15**
became `PENDING` because their solids cannot be decided at all, and **11 still
DIVERGE on the MESH leg** — same program, *different solid*. So the harness was
wrong about the tree and right about the risk, and the corrected number is still
**5 above the baseline**.

⚠ **`16 UNDECIDED` is not a smaller `35`, it is a hole beside it.** Those files
emit geometry whose correctness this leg **does not know**: our top-level solids
overlap and `mesh.ts` deliberately does not union top-level siblings, so the summed
invariants are not the union's. It rides in every CAD1H message for that reason —
`35 DIVERGES` read without it invites the conclusion that 16 files got better, when
what happened is that they stopped being measurable.

**Two harness defects were fixed to get these figures, and only one was handed
over.** Both are in `tools/scad_oracle/`, both are argued from the binary:

1. **`color()` / `render()` mapped to OPAQUE.** 46 of the 51 hardware divergences
   had their *first* tree difference at an `OPAQUE color(...)` node — the harness
   scoring its own vocabulary. Evidence and scope in the CAD1 section above.
2. 🔴 **The oracle could read a TRUNCATED export as ground truth, and did.** The
   only integrity check was `vertices % 9`, whose comment claimed it caught a
   short write. It does not: an ASCII STL facet is exactly three `vertex` lines,
   so a file cut at **any facet boundary** still passes. On this box — `/tmp` is a
   62 GB tmpfs at **89%**, with another lane's `openscad` running — a full
   `--hardware` run returned a **partial** mesh for `sphere(r=8)`
   (`bbox.min.z = +5.30` against our correct `-7.94`) with `openscad` exiting **0**,
   and **gate CAD1 went red naming three innocent cases** (`bool_union`,
   `bool_nested`, `prim_sphere_default_fn`) that are clean and byte-stable in
   isolation. *The instrument produced a red about the product out of a defect in
   itself* — the one failure a differential harness must not have, because its
   output is the evidence. Completeness is now asserted structurally and exactly
   (`endsolid` present · `facet` count == `endfacet` count · vertices == 3x
   facets); a short read is reported as an unusable oracle, never compared.
   Negative-controlled directly: a cube truncated at a facet boundary, mid-facet
   and mid-vertex are all rejected, while a complete file and a legitimately empty
   solid are accepted. ⚠ **A short read is now LOUD; it is not thereby impossible.**

**And a gate defect found while re-taking them: one PENDING anywhere disarmed both
ratchets.** The non-binary-PENDING branch failed CAD1 *and* CAD1H from one shared
test, so (a) CAD1 — whose entire contract is the corpus, which had **zero**
PENDINGs — went red quoting a reason from another lane's tree, and (b) both scoring
chains **short-circuited before the baselines were evaluated at all**, so the stale
`refuse_color` entry and the 30-vs-35 gap were invisible behind a red that never
mentioned either. The check is now per-leg and sits **last in each chain**: after
the regression limbs, so a real divergence is never masked by an undecidable case,
and **not before the ratchet-down limbs**, because `--self-plant
cad1-baseline-slack` exists to drive exactly those and would otherwise have landed
on the new branch — a reordering that leaves a negative control pointing at a
branch it can no longer reach is a control that has silently stopped controlling.

**A known noise floor, recorded rather than tuned away.** Four hardware files
differ only in numbers, and the harness is **left alone** on all four:

- **Three of them are a real product difference, not noise.** OpenSCAD's degree
  trig returns **exact** `0`/`±1` at multiples of 90° — verified at the binary:
  `rotate([90,0,0])` emits `[[1,0,0,0],[0,0,-1,0],[0,1,0,0]]`, while
  `rotate([89.9999,0,0])` emits a real `1.74533e-06`, so it is computing exact
  zeros, not rounding at print time. `web/src/cad/mesh.ts:285` uses
  `Math.cos(v*PI/180)` and produces **`6.12323e-17`**. `brand.scad`,
  `inwall_m8.scad` and `inwall_cover_box.scad` diverge on exactly that. The fix
  belongs in `mesh.ts` (**not this lane's file**); making `canon.mjs` do exact
  quadrant trig would print a matrix our product does not compute — the harness
  agreeing with us by construction, and a true finding erased.
- **The fourth kind is 6-significant-figure boundary noise, and it is ~1 ulp.**
  `fan_40mm` (`7.0822` vs `7.08221`), `fan_axial` (`-0.469847` vs `-0.469846`) and
  `vent_fan` (`5.96591` vs `5.9659`). Measured on the oracle's own full-precision
  ASCII STL for `fan_40mm`: the underlying doubles differ by **0.77 ulp** and
  **0.60 ulp** — relative **1.7e-16** — and the printed strings differ only because
  the value lands on a rounding boundary of the `%g`-at-6 the oracle can speak.
  **No tolerance is added.** A relative tolerance wide enough to absorb 1 ulp would
  also absorb the `6.12323e-17` finding above, which is a real difference; and the
  tree leg is syntactic **on purpose**. The floor is therefore **~2e-16 relative,
  visible only at a print boundary**, and it is written down instead of hidden.

**What stops the baseline being quietly raised** — five mechanisms and one thing
that is *not* claimed:

1. **A name, not a count** (corpus leg). To clear a red you must write
   `corpus/<case>` into the list. A name is legible in review; a digit is not.
2. **Every entry carries `why` and `since`.** A missing one is FATAL, exactly as
   for a `PENDING_BUDGET` entry naming a gate that does not exist.
3. **A stale entry FAILs**, so the list can only be paid down. This is what makes
   it a ratchet rather than a high-water mark.
4. **The document must agree** — the corpus names and the line above.
5. **The whole baseline prints on every run**, so it lands inside the transcript
   this file requires in the commit body of any gate change.

🔴 **NOT claimed: none of this stops a lane with write access from deliberately
raising the baseline.** Nothing in a repo can. What it stops is the *quiet*
raise — the one-digit edit that clears a red without anyone reading a sentence
about it. It is the same honest form as root canon's claim about the pre-commit
hook: not *"no regression can enter"*, but *"no regression enters without being
named, dated and written down twice"*.

### CAD1H — the UNDECIDED class, measured. A fork for whoever owns `web/src/cad/`, NOT taken here (2026-08-12)

**2026-08-14 — the fork is RULED: DEFER.** Founder (ceo ticket
`2026-08-14-ceo-FOUNDER-cadt10-yes-host-yes-cad1h-defer.md`): **no unioning yet —
fix the ~27 known diverges first** (the tracked 31 is inflated by ~10 by the
measurement, see below), and re-evaluate unioning (6× mesh time, F5→F6 semantics)
only against the clean number. Everything under this heading is therefore the
**parked** option, kept because the measurement is real and the re-evaluation
will need it. The live work is the diverges themselves.

**Nothing below changes a gate, a baseline or a harness.** It is the measurement
the fork was missing: *"the class is undecidable"* and *"the class would become
decidable if we unioned"* are very different facts and nobody had established
which. Now measured.

**2026-08-14 — the instrument, not the kernel, was fixed: tracked count 31 → 16,
baseline moves with it, and the unioning question is untouched.** The triage
partitioned 15 of the 31 `DIVERGES` as measurement artefacts *in the oracle*, in
three classes, and all three fixes landed in `tools/scad_oracle/` — nothing in
`web/src/cad/` was touched:

- **10 — touching top-level solids** (`buck_converter`, `ds3231_rtc`,
  `imx219_camera`, `mosfet_module`, `mppt_controller`, `pcf8574_gpio`,
  `skr_pro_v12`, `sma_adapter`, `sma_antenna`, `langstroth_frame`): tree same,
  volume ≤ 5e-8 rel, bbox and centroid fine, **only area ours-high**. The
  harness summed per-solid areas; OpenSCAD's STL is the CGAL union, which
  deletes the coincident contact faces (re-proved against the binary: stacked
  cubes union to area 1000 vs 1200 summed, partial contact removes exactly
  2×contact). Now **PENDING with AREA undecidable** — volume, bbox and centroid
  are still compared and must pass, so a bulk-geometry defect on a touching
  model still diverges.
- **2 — .csg rounding straddle** (`fan_40mm`, `vent_fan`): the oracle's
  `multmatrix` values are pre-rounded to six significant figures and
  `normalise` composes parent·child from them, while our side composes full
  doubles — a 1e-6 straddle (`7.0822` vs `7.08221`) read by an exact-string
  compare as "trees differ". The tree compare is now numeric at rel 1e-5
  (`canon.mjs` `serialiseEq`), tight enough that `corpus/fn_clamped` (400 vs
  256), `corpus/partial_rotate_axis_angle` (structural) and the quadrant
  epsilon (`6.12323e-17` vs exact `0`) all still fail. Both files then land
  PENDING on the overlap class their meshes were already in.
- **3 — `$preview` straddle** (`honey_tank_sensor`, `ov5640_camera`,
  `inwall_cover_box`): the oracle's `-o csg` leg runs `$preview=true` and its
  `-o stl` leg `$preview=false`, so for `$preview`-dependent geometry the
  oracle's own two legs disagree and no comparison is meaningful.
  **PENDING-by-construction**; the kernel's `$preview=true` choice is
  untouched, a deferred product decision.

Hardware leg after: **17 SAME · 2 STRICTER · 16 DIVERGES · 38 PENDING**.
🔴 **UNDECIDED rose 23 → 38, and zero of the 15 became agreements** — they
became decidable-nowhere, so the warning recorded at the 2026-08-11 ratchet ("a
baseline that falls while UNDECIDED rises is buying most of its improvement by
no longer being able to tell") applies to this move in full and is carried in
the baseline's own `why`. The residual 16 are all tree-leg divergences
(refusals taking subtrees, `hull`, `linear_extrude`, …) — the real work queue
the DEFER ruling points at. Everything below this block remains the parked
unioning measurement, now with the clean-number question it posed *answered for
the instrument half*: the "inflated by 10" estimate was exact.

**The gate change that came with it.** CAD1H's UNDECIDED limb failed on *any*
hardware PENDING that was not a missing binary, which made a green unreachable
while the ruled classes stand — a permanently-red gate stops being read. The
limb now carries the three classes **by name** (`CAD1H_UNDECIDED_KNOWN` in the
gate file; each entry is dated and says what it stops detecting — including
that the 7 real divergences hidden inside the overlap class stay hidden until
unioning is taken off defer) and still fails on any PENDING whose reason is
none of them. That surviving half has its own negative control,
`--self-plant cad1-undecided-unlisted`, added with the limb so it never existed
unwatched. `cad1-ledger-unlisted`'s `masked` exemption on CAD1H was discharged
the same day — its tripwire fired on schedule when this gate returned to its
baseline, and the plant's CAD1H half is driven again.

**Where it stands this run** — `openscad 2026.08.07`, `cad-src 56575dc3a635`
(`web/src/cad/scad.ts` + `mesh.ts`, **clean in git**), oracle at working-copy
`oracle.mjs 081684e9f13a` / `ours.mjs 8789d5b49094` — 🔴 **both uncommitted, the
`C3` audit-consumption work landing in them while this was taken.** Read the
digests, not the date.

- 73 hardware files: **17 SAME · 2 STRICTER · 31 DIVERGES · 23 PENDING**, red
  against the tracked line of 29.
- **All 23 PENDINGs are ONE cause** — the overlap class, checked rather than
  assumed: every reason string is *"our N top-level solids overlap, and mesh.ts
  deliberately does not union top-level siblings"*. Zero come from the float32
  floor, zero from an unavailable oracle, zero from the kernel-audit branch added
  the same day.
- 🔴 **And 23 UNDERSTATES IT. Eleven more files have an undecidable MESH leg and
  are scored `DIVERGES` anyway, because their TREE leg diverges and decides the
  case first.** So **34 of 73 models have a solid this gate cannot decide** — the
  gate's own `UNDECIDED` figure is the subset whose tree happens to agree.

**What unioning would resolve, measured file by file** rather than argued. Method:
`web/src/cad/mesh.ts`'s own kernel, driven read-only — the program root's children
wrapped in a single `union` node, meshed, audited, and its invariants compared
against the same OpenSCAD STL the oracle uses. That is the only way to reach the
option from outside `mesh.ts`, and the caveat at the foot of this block is about
exactly that.

| hardware leg | SAME | DIVERGES | PENDING | STRICTER |
|---|---|---|---|---|
| today, summing top-level parts | 17 (**2 real**) | **31** | **23** | 2 |
| with a top-level union | 43 (**28 real**) | **27** | **1** | 2 |

*"Real" = a non-empty agreement. 15 of today's 17 `SAME` are empty on both sides;
every one of the 26 that move is a solid, so the headline this leg has carried
since it was wired — **0, then 2, real agreements on ~70 models** — would become
28.*

- **23 of 23 UNDECIDED become decidable.** 16 land on real agreement, 7 on
  disagreement — `2bee_cables`, `2bee_connectors`, `ics43434_mic`, `scd41_co2`,
  `usb_a_panel_dtype`, `load_cell_50kg_disc`, `planetary_gearmotor_36mm`. Those
  seven are **real divergences currently hidden behind PENDING.**
- ⚠ **And it moves 11 files nobody asked about.** **10 currently-`DIVERGES` files
  become agreement** — `buck_converter`, `ds3231_rtc`, `imx219_camera`,
  `mosfet_module`, `mppt_controller`, `pcf8574_gpio`, `skr_pro_v12`, `sma_adapter`,
  `sma_antenna`, `langstroth_frame`. Their bounding boxes do **not** overlap, so
  the overlap guard never fired; their solids **touch**, and OpenSCAD's F6 union
  removes the coincident internal faces while our sum keeps them. **Measured, not
  inferred — the divergence is entirely in AREA and the volumes agree exactly:**

  | file | openscad vol / area | summed vol / area | unioned vol / area |
  |---|---|---|---|
  | `sma_antenna` | 945.3678 / 1061.7733 | 945.3678 / **1075.2732** | 945.3678 / 1061.7732 |
  | `sma_adapter` | 1550.1387 / 918.6548 | 1550.1388 / **1143.1283** | 1550.1388 / 918.6549 |
  | `imx219_camera` | 2827.6055 / 1898.7993 | 2827.6055 / **2069.5615** | 2827.6055 / 1898.7993 |

  🔴 **So the current count of 31 is inflated by 10 by the measurement itself.**
  The eleventh, `hive_context_viz`, goes the other way: its union audits
  **non-manifold**, so it becomes undecidable — a kernel finding only the union
  surfaces.
- ⇒ tracked `DIVERGES+ERROR` **31 → 27**, which is **below the line of 29**, so
  this option does not merely clear today's red — it lands on the **ratchet-down**
  limb and requires the line to be written down as 27.

🔴 **What it costs, and the first two are not opinions.**

1. **It changes what the mesh leg MEANS,** and the F5/F6 distinction is deliberate
   and documented in `mesh.ts`'s own header. 26 files move to agreement **because
   the harness changed the question**, not because the kernel improved. A reader
   of `43 SAME` would have no way to know that.
2. **A top-level `union` node is REFUSED whole when any operand is 2D**, so a
   model with 2D and 3D geometry side by side stops emitting anything. Measured:
   `corpus/edge_2d_and_3d` moves from mesh-leg agreement to *"openscad has a
   solid, we have none"* — **so this option breaks `CAD1`, which is name-exact and
   green today, and costs a new named baseline entry there.**
   `hardware/cad/lib/brand.scad` picks up the same refusal.
3. **Time: the hardware leg's meshing goes 1,179 ms → 7,507 ms** (6.4×, +6.3 s on
   a ~12.6 s corpus+hardware run). One file dominates —
   `components/nrf9151_feather`, 46 ms → 4,543 ms, 3,856 → 47,950 triangles, from
   BSP-unioning 41 solids. The corpus leg's own time does not move (250 → 237 ms).

**The other option, and what it costs:** say in the gate's contract that the class
is undecidable, with the number in the message so it cannot be read as coverage.
Cost is a message and this document — **and it resolves 0 of the 23**, leaves the
7 real divergences hidden inside them, and leaves the **10 inflated `DIVERGES`
unexplained**, which is the part that was invisible until this measurement. The
gate already prints `23 UNDECIDED` on every run for exactly this reason; what it
does not say is that 11 more are undecidable underneath a tree divergence.

⚠ **Caveat on the measurement, not on the numbers.** The option was implemented
the ONLY way reachable from outside `mesh.ts` — wrapping the root's children in a
`union` node. `web/**` is another lane's file. A `mesh.ts`-side implementation
that unioned the **3D siblings only** would avoid cost 2 entirely; costs 1 and 3
are properties of the option, cost 2 is a property of this route to it. **Whoever
owns `web/src/cad/` should read cost 2 as "a naive implementation does this",
not as "the option does this".**

### What CAD1H does NOT cover, said rather than implied

- **It is a COUNT.** One file fixed and another broken, at equal count, is
  invisible to it. The corpus leg is name-exact because the corpus is this lane's
  own fixed set; `hardware/cad/` is another lane's tree where a **rename** is not
  a regression, and a name list there would train exactly the "just edit the
  list" habit the five mechanisms above exist to prevent.
- **A file added to `hardware/cad/` that REFUSES cleanly moves nothing here.**
- ⚠ **The measurement is taken over a LIVE WORKING TREE.** The oracle imports
  `web/src/cad/*.ts` directly, and on 2026-08-10 that was an uncommitted working
  copy with three agents in it. Both gates therefore print a **`cad-src` digest**
  of the two files they measured, so a red reads *"baseline measured over X, this
  run is Y"* instead of being a mystery. ✅ **The "re-take when `web/src/cad/` next
  commits" obligation was discharged at 23:28** — see the RE-TAKEN block above; the
  baselines now name a digest **and** a sha. ⚠ **The hazard itself has not gone
  away**: the next edit in that directory makes this a live-tree measurement again,
  and the digest, not the date, is what says which state a number describes. Read
  the digest the run printed before treating a red as a regression.
- **The oracle's own limits are inherited** — a 2D+3D model (OpenSCAD drops the
  2D object from an STL export and the tree still matches), and a case whose
  top-level solids overlap, which the mesh leg reports as undecidable rather than
  comparing the wrong quantities.

### The plant registry gate PLANT could not see

🔴 **`PLANT` limb 2 scans this gate file for literal `'--plant', '<name>'` pairs
and cross-checks each against the RUST BINARY's registry.** Writing `mesh-scale`
as a literal pair therefore made `PLANT` correctly report *"the binary does not
register it"* on the first run — it does not; the **oracle** does, which is a
**second plant registry nothing in the gate file knew existed**. The flag is now
built from a constant so it does not match that pattern (**do not "fix" it
back**), and the missing cross-check is done inside CAD1 instead, **on every run
rather than only under the self-plant**: a control that has silently stopped
planting runs clean and reads as a passing control, which is `PLANT`'s own
finding arriving one registry along.

```
$ node gates/slicer_gate_check.mjs --quick     # before the constant was introduced
  FAIL    PLANT THE PLANTS STILL PLANT this file drives `--plant mesh-scale`,
  which the binary does not register — the control is asserting on an exit-2 for
  a typo
```

### Cost, measured rather than budgeted

Corpus alone **3.5 s**; corpus + `--hardware` **7.3 s** wall clock. The oracle's
README suggested a `--quick` PENDING entry *might* be needed and said to measure
before adding one. Measured: it is not needed, and none is added. **A
`PENDING_BUDGET` entry bought for a cost that turned out not to exist is a
permission granted for nothing.**

The two budget entries that *were* added name one condition each: **`openscad`
absent from the box.** Every other PENDING the oracle can produce — a timeout, an
unparseable `.csg`, a comparison the precision cannot settle — is scored as a
**FAIL inside the gate**, because those are checks that broke rather than a box
that lacks a tool. The failure those two entries stop us detecting, stated as
this file requires: on a box with no `openscad`, **the entire CAD-subset
divergence class goes undetected.**

⚠ **2026-08-14 — one narrowing, on the hardware leg only.** The three
*ruled undecidable classes* (overlap, touching-area, `$preview` straddle — see
the CAD1H UNDECIDED-class section) are no longer scored as FAIL inside CAD1H:
each is a comparison measured to have **no referent**, carried by name in
`CAD1H_UNDECIDED_KNOWN` with its date and what it stops detecting. Every PENDING
whose reason is none of the three is still a FAIL, and that half has a negative
control (`--self-plant cad1-undecided-unlisted`). **CAD1 is unchanged** — any
corpus PENDING that is not a missing binary still fails it.

## What the gate does NOT cover

- ✅ **BOTH OF THE TWO REDS THIS BULLET NAMED CLEARED ON 2026-08-10 23:28. Kept
  visible rather than deleted, because a stale 🔴 misleads exactly like a stale ✅
  and is harder to find — nobody re-tests a blocker that names a reason.**
  1. **`TECH`** — the bullet said `dialect-rules <anything that is not fdm>` exits
     **0** and returns the **CNC** ruleset, because `cli/src/main.rs` fell through
     `_ => Cnc`. **`cli/` has since fixed it**, and the fix was verified by running
     the binary rather than by reading the arm: `''`, `bogus` and `laser` each
     **exit 2 with 0 bytes on stdout**, while `cnc` (485 B) and `fdm` (278 B) still
     answer. The refusal is now two distinct arms — an unknown name and a *missing*
     one are refused with different text, which is the difference between "you typed
     something we do not know" and "you named nothing at all".
  2. **`K3`** — `web/src/wasm` had been built from an older core than the CLI. The
     gate was correct and the artefact was stale; the rebuild landed both hosts on
     core `478eb171564e`. ⚠ **This one recurs by design.** It goes red on the next
     `core/src` edit that is not followed by `npm run wasm`, and that red is the
     gate working. Do not read it as a defect in the gate, and do not read `I1`'s
     result as cover — two hosts running the *same old* core agree perfectly.
- 🔴 **`GDOC` is a floor, not a coverage claim** — the same caveat `SPEC` states
  about itself. It verifies that this document does not cite evidence it does not
  contain: that every gate has a row, that a row claiming a witnessed red has a
  transcript block attributed to that gate, and that a sentence asserting a
  gate's state agrees with the run printing the message. It does **not** verify
  that a transcript is genuine, that it belongs to the gate whose section it sits
  in, or that the red was ever actually observed. Attribution is by the nearest
  heading or bold lead-in naming a real gate — the convention this file already
  uses — so **a transcript filed under the wrong gate is invisible to it.**
- ⚠ **`GDOC`'s state limb can only see gates that have already reported when it
  runs.** It sits after `SPEC`, so `K3`, `I1`, `CTRL`, `VERD` and `GDOC` itself
  are outside it, and the PASS line names them rather than letting the gap be
  discovered. Moving the block to the foot of the file would widen it and would
  leave `GDOC`'s own row checked by a gate that has not run.
- ⚠ **`STALE` is a digest of `core/src` ONLY.** Edits to `cli/`, `wasm/`, a
  `Cargo.toml`, a dependency bump or a changed profile do not move the id, so a
  green there means *"the core in this binary is these bytes"*, never *"this
  binary is fresh"*. Same boundary `K3` states one level down.

🔴 **I1 CANNOT PASS ON THIS BOX TODAY, AND THAT IS NOT A REGRESSION IN THIS TREE
(measured 2026-08-10, re-measured 23:28 on a rebuilt tree).** The browser tests
fail across all spec files, and the cause is in the browser rather than in the
app: Chromium cannot create a WebGL context at all, so `three.js` throws at boot
and React unmounts — `document.body` renders 0 characters and no control exists
for any test to find.

```
THREE.WebGLRenderer: A WebGL context could not be created. Reason:  Could not create a
WebGL context, VENDOR = 0xffff, DEVICE = 0xffff, GL_VENDOR = Disabled, GL_RENDERER =
Disabled, Sandboxed = no, ErrorMessage = BindToCurrentSequence failed:
PAGEERROR: Error: Error creating WebGL context.
```

Attributed rather than assumed, and it is **not** the port collision it looks
like from the outside:

- reproduced against the **already-running** preview server, starting no second
  server and binding no port, so nothing was colliding;
- reproduced under **four** GL flag combinations — the config's
  `--use-gl=swiftshader --enable-unsafe-swiftshader`, `--enable-unsafe-swiftshader`
  alone, `--use-angle=swiftshader`, and no GL flags at all — so it is not the
  flag the config chose;
- the served artefacts are fine: `/` is 200, the bundle is 967 kB, and
  `/assets/twobee_cam_wasm_bg-*.wasm` is 200 at 930 202 bytes;
- nothing under `web/` had changed from the last commit when it was measured.

🔴 **AND THE DECISIVE ONE, ADDED 23:28 — the bullets above all still run our app,
so every one of them leaves "three.js, or our use of it" on the table.** The check
that does not: launch the same Chromium, build a bare `<canvas>` and ask it for a
context, with no bundle, no React and no `three` loaded at all.

```
{"args":["--use-gl=swiftshader","--enable-unsafe-swiftshader"],"webgl2":false,"webgl":false}
{"args":[],                                                   "webgl2":false,"webgl":false}
```

`canvas.getContext('webgl')` returns **null** on a blank page. Nothing of ours is
on the stack, so the failure cannot be ours. **Measure the platform without your
product in the frame before you attribute a platform fault** — the four-flag test
above narrowed the *cause* correctly and still could not have ruled us out.

⚠ **A REAL PRODUCT DEFECT IS VISIBLE UNDERNEATH IT, and it is not the same finding.**
A missing WebGL context takes down **the entire application**, not the viewport:
the **two** `new THREE.WebGLRenderer(` sites — one in `web/src/Viewport.tsx`, one in
`web/src/cad/preview.tsx` — are each constructed unguarded inside React's render
path, so the throw
<!-- Cited by file + constructor, NOT by line: both files are live, and the
     Viewport site moved 2473 -> 2478 inside the 15 minutes it took to write this
     paragraph. A line number in another lane's open file is a citation that
     rots before the reader arrives; `grep -n 'new THREE.WebGLRenderer'` does not. -->
unmounts the tree and the page renders **0 characters** — no panels, no tool
picker, no G-code, no error message. An operator on a machine with no working GL
gets a blank page rather than a CAM program they could still have posted and
downloaded. **Owned by `web/src/`, not by `gates/`**; the fix is to catch at the
renderer construction and degrade the viewport, keeping the rest of the app alive.
Reported, deliberately not fixed inside a gate-maintenance pass.

⚠ **What the timeout means for the count.** The gate caps the suite at 900 s
(`gates/slicer_gate_check.mjs:4802`). Each failure burns the 30 s locator timeout,
so the run reaches roughly **45 of 74 declared tests** and is then killed —
`I1` reports *"browser suite errored"* rather than a failed-test count, because
`execSync` threw on the deadline instead of returning a summary line. **45/45 of
the tests that ran failed** (45 `trace.zip` artefacts under `web/test-results/`,
kept only on failure), in three groups: 23 waiting on `tool-picker-trigger`, 21 on
`status`, 1 on a `select`. **All three are the same failure** — nothing rendered.
🔴 **Do not read "74 declared" as 29 tests that might be fine**; they were never
reached, and an unreached test is not a passing one.

⇒ **This is a host problem and it belongs to whoever owns the box, not to this
lane.** Until it is fixed, **every browser test in this repo is DECLARED, not
passing** — including the three added for the multi-drawing work.

🔴 **CORRECTED 2026-08-10 — this paragraph asserted that I1 was PENDING, and that
was FALSE in the direction that mattered.** A full run **FAILS** I1: every path
through the I1 block calls `fail()`, and only `--quick` can pend it. So the code
was doing the safe thing while this document described the unsafe one — and back
when a PENDING was waved through by the verdict, a reader following this sentence
would have concluded that a broken browser layer still allowed a GO. It did not,
and it does not now. **A stale state claim in prose is the one sentence that
rots by itself**, which is why gate `GDOC` limb C now reads sentences of this
shape (`<GATE> is PENDING/GREEN/PASSING/FAILING`) and compares them to what that
gate actually did in the run printing the message.

Do not read a `--quick` result as covering the UI: `--quick` skips I1 by design
and the run says `INCOMPLETE`, never `GO`. Today a full run cannot do better —
it says `NO-GO`.


Stated so nobody reads a GO as more than it is. **This list was itself stale for
one commit** — it still claimed there was no simulation and no browser E2E after
both had been built. A coverage list that understates is as wrong as one that
overstates; it just fails in the direction nobody audits.

- 🔴 **REL does not make a part safe — it makes the ORDER safe, and those are
  different facts.** Three named gaps, in the order they will bite:
  1. **A release that is not an outer profile is invisible to it.** "Releases the
     part" is read off `CutSide::Outside`. A small part nested inside a **larger
     part's hole** is freed the instant that hole is cut — an `Inside` operation,
     in the phase the scheme deliberately runs FIRST. Estlcam automates the same
     rule and produces the same failure. `verify_interior_before_outer` cannot see
     it either: it is keyed on the same classifier. **Nothing in this suite covers
     the nested-part release.**
  2. **A correctly ordered part can still be inadequately held.** That is tabs
     (P1), fixturing (P7, E5) and the workholding catalogue (#34). REL says the
     holes were drilled before the outline was cut; it says nothing about whether
     the tabs hold.
  3. **Onion-skinning — deferring the release itself — is not implemented** and
     is a separate ticket (decision #33, option 5). It composes with REL rather
     than replacing it, and it changes emitted geometry, so it needs its own gate
     and its own coupon.
- 🔴 **TOOL covers the CORE and the CLI, not the browser.** ~~and two CLI flags
  near it are still accepted-and-ignored~~ ✅ **Both CLI flags CLOSED 2026-08-09
  by gate FLAG** — kept visible because the *reason* travels further than the fix:
  1. ~~**`import` does not parse `--plant`** and ignores it silently~~ ✅ it now
     exits **2** — unknown plant refused as `report` refuses one, known plant
     refused **with the reason**. 🔴 **Still true: `import` cannot APPLY a
     plant**, so the TOOL control stays on `report`. The silence is closed; the
     capability is not, and only the core can close it.
  2. ~~**`job <name>` accepts `--config` and never reads it**~~ ✅ `run_job` now
     calls `JobConfig::apply` — the same call `report` goes through. It was not a
     tool-selection bug; it was found while chasing one.
  3. **The browser's own guard is a separate control and is NOT this gate's.**
     `web/src/App.tsx` refuses to plan with an empty tool set client-side; that
     is belt-and-braces over a core that now refuses on its own, and neither
     covers the other. **No browser test exercises the refusal** — `I1` compares
     the fixtures, which name their tools in Rust.
- 🔴 **MOVE proves the DRAG reaches the program; it does not prove the PICTURE
  agrees with it, and those failed separately on the same day.** The founder's
  report — *"I put the Hive super end - solid (STL) into the table but it is out
  of the table"* — was TWO defects: no drag handler on the loaded object, and a
  loaded mesh with **no scene position at all**, drawn at raw model coordinates
  while the workpiece was drawn at its datum. A CLI gate cannot see the second: there
  is no picture on the command line. It is covered by a **browser** assertion
  instead — `data-part-bbox` publishes the drawn object's own world box in machine
  millimetres, and moving the workpiece 40mm must move it 40mm — and that assertion
  runs in the Playwright suite, i.e. **only under I1**, which `--quick` skips.
  ⚠ So a `--quick` GO says nothing about whether the viewport draws the imported
  geometry where the machine will cut it.
- 🔴 **A part dragged past the workpiece edge is NOT SIMULATED, and the gate does not
  refuse it.** The height map is built over the workpiece and `sim::check` walks its
  cells, so geometry outside the workpiece is not judged clean — it is **not judged**,
  and zero findings is what both look like. `plan_job` now emits a note saying so
  by name (`PAST THE EDGE … NOT simulated`) and a browser test asserts the note
  reaches the panel. **That is a disclosure, not coverage.** Cutting past the edge
  of the workpiece is a real thing to do, the travel check still refuses what the
  machine cannot reach, and P7 still refuses what would hit a clamp — but nothing
  here simulates material that is not there.
- **No real controller has run this output.** G2 checks the dialect we believe
  grblHAL accepts, against the published reference. Only a dry run on the
  machine proves the machine agrees. **Gate CTRL now exists to record that
  agreement and reports PENDING until a transcript lands** — the state changes
  when a board answers, not when this file is edited.
  🔴 **The specific thing a published reference cannot tell us: grblHAL's canned
  cycles are a compile-time option.** A build without them answers `error:20` to
  the `G83` that gate G9 asserts on — and G9 would stay green, because it is
  measuring our output against a document, not against the board.
- **Nothing has been cut.** No claim here has been checked against a physical
  part, and the material-removal simulation is a HEIGHT MAP: it cannot see a
  gouge smaller than its cell, and `cell_mm` is reported with every result for
  exactly that reason.
- **Feeds are derived, not validated.** `rpm x flutes x chipload` is arithmetic
  over the tool's published window. Whether that chipload suits *our* ply, on
  *our* spindle, is a coupon question.
- **Import is a subset.** SPLINE, elliptical arcs and SVG `A` are reported by
  name and not parsed. Units are assumed millimetres — an inch drawing imports
  25.4x small and nothing currently catches it (spec F4).
- **No nesting.** Part transforms carry interior geometry and P8 proves it, but
  no nester runs here.
- **The XYZ touch plate has no CLI *flags*, so most of gate PROBE's XYZ limbs
  read a core dump rather than the product's own host.** `--probe` turns a probe
  on and says nothing about the plate. The `--config` route **does** now reach it
  (`machine.probe_plate: "xyz"` plus the `stock.corner_plate` block), and the
  placement limb is driven through the real binary that way on purpose — a dump
  is one build of the core and the product is another. The remaining XYZ limbs
  still come from the dump. ⚠ **I1 (browser vs CLI byte parity) and K3 still
  cannot see the XYZ path**, because they compare the *fixtures* and no fixture
  declares a corner plate. Closing that is a fixture that does, not a config
  change; the gate's own PASS line says so out loud rather than leaving it to be
  assumed away.
- **The touch-plate model is now three owners, and one field is still doing two
  jobs.** `Stock::corner_plate` holds the setup (which corner, how deep),
  `TouchPlate` holds the purchased object (top thickness, wall), and `Machine`
  holds a device fastened to the machine. 🔴 **`Machine::touch_plate_mm` still means
  a different physical quantity on the two device types** — a thickness
  subtracted from the workpiece top on a plate, a standing height of a device bolted to the machine
  on a tool setter — and nothing checks which one a number is. Entering a 90mm
  setter's height zeroes the tool 90mm high. Separating them needs a device type
  *and* a ruling on which surface Z is wanted at; both are founder decisions and
  neither is made.
- ~~**`Machine::default().touch_plate_mm = 1.6` is unsourced and does not refuse.**~~
  ✅ **CLOSED 2026-08-09 — decision #43 P0 (`docs/decision-40-43-touchplate-ownership.md`).**
  The field is `Option<f64>`, defaults to `None` = *nobody has declared it*, and
  `None` is **REFUSED** in `fixed_z_probe()` alongside the seven XYZ refusals —
  before any motion is written, so `PostResult::ok()` is false and no G-code
  exists to be run. `Some(0.0)` stays legal **if typed** (no plate; the tip
  zeroes on the surface it touches) and a negative value is refused. Kept
  visible rather than deleted, because the *reason* is the part that travels:
  ⚠ **the argument is NOT "1.6 is dangerous".** The two failure directions are
  not symmetric — an **under**-declared top puts work-zero above the work and
  cuts **shallower** (a scrapped part), an **over**-declared one drives toward
  the **spoilboard** and takes the safe-Z retract down with it. `1.6`
  under-declared against all 13 surveyed products, so it failed *safe*; the
  most-published catalogue figure (15mm) would over-declare by 10mm for anyone
  holding a 5mm AutoZero, so **sourcing the number would have moved the defect
  into the crash direction.** The rule the survey supports is *a tool may ship a
  plate-thickness default only if it also ships the plate* — we ship no plate.
  Now covered by gate **PROBE** (limb L11 + `refuse-no-plate-thickness.nc`),
  control `--plant undeclared-plate`.
  🔴 **The other half of #43 is still open and is NOT covered:** the field means
  a **thickness** on a plate and a **standing height** on a tool setter, and
  nothing checks which one a number is (next bullet). That needs a founder
  ruling and is decision #43 P2.
- 🔴 **`fixture … --probe` can no longer emit a probing program at all**, and
  that is a consequence of the fix rather than a defect in it: the `fixture`
  host has no flag to declare a plate, so `--probe` now refuses. Gate PROBE's
  CLI limb (L7) was repointed at `job plate`, which declares one. Closing it is
  a `--touch-plate <mm>` flag on the CLI — named here rather than absorbed,
  because a flag that cannot produce its own output is the shape of thing that
  gets read as covered.
- **No probe has been offered to a real board.** Every dialect fact the probe
  rests on is cited at grblHAL's or grbl's own source in `post_grblhal.rs` —
  `G38.2` alarming on no contact (`core/alarms.c`), `G10 L20 P1` taking X and Y,
  `G91` applying to `G38.2` (`gcode.c`) — but a citation is not a controller.
  This is CTRL's ladder, unclimbed.
- **Not built, and listed so the absence is visible:** spiral/zigzag pocket
  strategy (concentric only), a persistent tool store (imported tools live for
  the browser session), and drag-placed clamps. Each is in `FUNCTIONAL-SPEC.md`
  with the reason it matters.
  ⚠ *This bullet also named WCS datum offsets, material presets, engraving/part
  IDs and lead-in/out for one release after all four were built and gated
  (B2B4, MARK, LEAD). **A coverage list that understates is as wrong as one that
  overstates** — it just fails in the direction nobody audits, which is exactly
  what the paragraph above this list says and did not prevent.*

## Audit / fix loop

1. Run the gate.
2. Any FAIL → fix in the source, never in the output.
3. Any gate you add: write its negative control **in the same commit**, and paste
   the red run into the commit body. A gate added without a witnessed red is a
   gate we are guessing about.
4. Any gate you move from PENDING → HARD: the plant comes first, the
   implementation second.
5. **Any number a gate asserts on must be derived from the emitted PROGRAM**, not
   from the plan that produced it. P4 passed for its whole life on a relief count
   taken from the plan while the G-code contained no relief at all.
6. **Never quote a `--quick` result as a gate result, and never quote any
   non-`GO` verdict as a pass.** `--quick` skips the release rebuild and the
   whole browser layer; it can reach `INCOMPLETE`, never `GO`.
7. **When you weaken a gate, weaken it in the ROW as well.** Two of the three
   weakest gates found by the 2026-08-10 audit — `P4` and `TECH` — were weak in
   the code *and* described as strong in this file, and the description is what
   sent every later reader past the code. `P8` was the third and was silent
   rather than wrong, which is only better because it claimed less.
