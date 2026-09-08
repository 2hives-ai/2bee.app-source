#!/usr/bin/env node
/**
 * SLICER GATE — run before shipping any change to 2bee.app.
 *
 * Every check below names the PHYSICAL failure it guards. If you weaken one,
 * say which physical failure you are choosing to stop guarding.
 *
 * Two rules this file exists to enforce on itself:
 *
 *  1. Every HARD gate carries a NEGATIVE CONTROL — a deliberately planted
 *     defect that must make the gate go red. A gate nobody has watched fail is
 *     not a gate. The control asserts on the gate's own pass/fail, and the run
 *     asserts on the VERDICT line, because those are different questions.
 *
 *  2. A check that cannot run reports PENDING, never PASS. A green that means
 *     "unchecked" is worse than a red.
 *
 *  3. 🔴 AND A PENDING MUST NOT READ AS A GO. Rule 2 was honoured everywhere
 *     except the one line that decides what the run SAYS. Measured 2026-08-10,
 *     same tree, minutes apart:
 *
 *       full     46 passed, 1 failed, 1 pending -> VERDICT: NO-GO  (exit 1)
 *       --quick  46 passed, 0 failed, 2 pending -> VERDICT: GO     (exit 0)
 *
 *     `--quick` had not skipped a check. It converted the only FAILING gate
 *     into a PENDING one and flipped the verdict. Because this lane's own rule
 *     is that a negative control asserts THE VERDICT LINE, every control in the
 *     suite was blind to any defect that DISARMS a gate instead of failing it —
 *     delete `web/src/wasm` and K3 pends; move brand's master and BRND pends;
 *     take `rotation_deg` out of `ClampCfg` and P7R pends. All three read GO.
 *     BRND's own comment records watching this happen and fixed ONE branch.
 *
 *     The verdict is now three-valued and PENDING is budgeted (eight entries) —
 *     see PENDING_BUDGET below and the scoring block at the foot of this file.
 *
 * Usage:
 *   node gates/slicer_gate_check.mjs            full gate
 *   node gates/slicer_gate_check.mjs --quick    skip the release rebuild + the browser
 *   node gates/slicer_gate_check.mjs --list     print the gate table and exit
 *   node gates/slicer_gate_check.mjs --self-plant <name>   see SELF_PLANTS below
 *
 *   Those four are the WHOLE vocabulary. Anything else — a typo, a flag from
 *   the CLI, a flag that never existed, a stray word — is REFUSED with exit 2
 *   and an empty stdout, BEFORE this file builds, spawns or writes anything.
 *   See `checkRunnerFlags` below for why that is a safety property and not a
 *   politeness one, and gate FLAG's harness limb for what asserts it.
 *
 * Exit codes — three states, because there are three answers:
 *   0  GO          every gate ran and passed
 *   1  NO-GO       a gate ran and did not pass
 *   3  INCOMPLETE  nothing failed, but a gate could not run HERE. Not a pass.
 */

import { execSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync, statSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// ---------------------------------------------------------------------------
// THE RUNNER'S OWN FLAGS — refused BEFORE anything is built, spawned or written.
//
// 🔴 THE DEFECT THIS CLOSES, found 2026-08-11 by an operator typing `--help`.
// Every flag below was read with `process.argv.includes(...)` and EVERYTHING
// ELSE was ignored, so `--help`, `--quik`, `--only G0`, `--self-plant=doc-roster`
// and a bare positional were all indistinguishable from "no flags given" — each
// started a FULL pass. A full pass rebuilds the release binary and regenerates
// `web/src/wasm`, which is a COMMITTED artefact. So a typo silently rewrote a
// tracked build product, and `c4db1a5d8a` is the record of what that costs:
// three different core digests in play at once, with no diff signature anywhere
// but the digest itself.
//
// 🔴 AND THE INDICTMENT IS SHARPER THAN THE BUG. Gate FLAG's entire subject is
// that a subcommand must refuse a flag it does not read — exit 2, empty stdout,
// on all five paths. THE HARNESS THAT ENFORCES THAT held itself to nothing at
// all. This is not a new rule; it is the rule this file already carries, turned
// around to face the file.
//
// 🔴 ORDERING IS THE PROPERTY, NOT THE EXIT CODE. Exit 2 *after* the wasm
// rebuild would satisfy an exit-code check and still have done the damage — the
// damage is the rebuild. Two things make the ordering assertable from outside:
//   - this block runs before every other statement in this file that can spawn,
//     build or write. It is deliberately above the `--self-plant` parse, above
//     the `--list` branch and above the banner;
//   - the FIRST byte this program ever puts on stdout is that banner, printed
//     three lines above `cargo build --release`. So an EMPTY stdout on a
//     refusal is not cosmetic — it is the witness that execution never reached
//     the banner, let alone the build. Gate FLAG's harness limb asserts that,
//     and separately asserts the artefacts a full pass would have moved are
//     byte-and-mtime identical across the refused run.
//
// ⚠ `--only` DOES NOT EXIST AND NEVER DID. It was passed in the session that
// found this, looked accepted, and ran the WHOLE suite. It is refused BY NAME with
// that sentence rather than implemented: an operator who believes they scoped a
// run reads the result as a subset when it is the whole suite, which is the same
// family of harm as a discarded `--config`. Implementing it was the alternative
// and was declined on purpose — see SLICER-GATES.md, gate FLAG.
const RUNNER_FLAGS = {
  '--quick': { takesValue: false, why: 'skip the release rebuild, the wasm rebuild and the browser suite' },
  '--list': { takesValue: false, why: 'print the gate table + the PENDING budget, then exit 0' },
  '--self-plant': { takesValue: true, why: 'name a negative control for a defect that lives IN THIS HARNESS' },
};
// Named refusals, because "unknown flag" is a true answer that teaches nothing
// about the two flags people have actually typed at this file.
const RUNNER_FLAGS_DEAD = {
  '--only':
    'there is no --only and there never was. This runner does not scope a run to a subset of gates — a run is all of them. If you passed it and read the result as scoped, that result was the WHOLE suite.',
  '--help':
    'there is no --help. The usage block at the top of this file is the usage, and --list prints every gate with the physical failure it guards.',
};
function checkRunnerFlags(argv) {
  const known = Object.keys(RUNNER_FLAGS);
  // Cheap edit distance — this exists only to turn `--quik` into a pointer at
  // `--quick`, which is the whole reason an operator ends up here.
  const near = (a, b) => {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 0; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++)
      for (let j = 1; j <= b.length; j++)
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length];
  };
  const problems = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith('-')) {
      problems.push(
        `positional argument ${JSON.stringify(tok)} — this runner takes flags only, and a stray word was silently swallowed here until 2026-08-11`
      );
      continue;
    }
    if (tok.includes('=')) {
      const head = tok.slice(0, tok.indexOf('='));
      problems.push(
        Object.prototype.hasOwnProperty.call(RUNNER_FLAGS, head)
          ? `${tok} — ${head} takes its value as a SEPARATE argument (${head} <value>). Nothing in this file scans for the = form, so it would have been read as "${head} was not given" and the run would have gone ahead without it`
          : `unknown flag ${JSON.stringify(head)} (in ${JSON.stringify(tok)})`
      );
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(RUNNER_FLAGS, tok)) {
      // hasOwnProperty, not `[tok]` — `--constructor` and `__proto__` resolve on
      // the prototype chain and would paste a function body into the refusal.
      const dead = Object.prototype.hasOwnProperty.call(RUNNER_FLAGS_DEAD, tok) ? RUNNER_FLAGS_DEAD[tok] : null;
      const guesses = known.filter((k) => k !== tok && near(k, tok) <= 2);
      problems.push(
        `unknown flag ${JSON.stringify(tok)}` +
          (dead ? ` — ${dead}` : '') +
          (guesses.length ? ` Did you mean ${guesses.join(' or ')}?` : '')
      );
      continue;
    }
    if (RUNNER_FLAGS[tok].takesValue) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('-')) {
        problems.push(`${tok} needs a value and was given ${v === undefined ? 'nothing' : JSON.stringify(v)}`);
        continue;
      }
      i++; // consumed HERE, so it is never re-read as a stray positional
    }
  }
  if (problems.length === 0) return;
  // stderr only. An empty stdout is load-bearing: gate FLAG's harness limb reads
  // it as proof that the banner — and therefore the build below it — never ran.
  console.error('  FATAL this runner does not accept the arguments it was given, and it refuses BEFORE');
  console.error('        building, spawning or writing anything. A typo must not rebuild web/src/wasm.');
  for (const p of problems) console.error(`    - ${p}`);
  console.error('  accepted:');
  for (const [f, s] of Object.entries(RUNNER_FLAGS)) {
    console.error(`    ${(f + (s.takesValue ? ' <value>' : '')).padEnd(22)} ${s.why}`);
  }
  console.error('  NOTHING RAN. (Gate FLAG holds the CLI to this same contract; this is that rule applied');
  console.error('  to the harness that enforces it.)');
  process.exit(2);
}
checkRunnerFlags(process.argv.slice(2));

const QUICK = process.argv.includes('--quick');
const LIST = process.argv.includes('--list');

// Set by gate SPLNT on the `--quick` children it spawns to audit the
// `--self-plant` registry, and it does two things. It stops a child auditing its
// own audit — SPLNT's DRIVE limb is full-pass-only, so `--quick` already
// prevents the recursion and this is the belt to that brace, the thing a future
// change to drive children differently would hit. And it turns on the one
// machine-readable line at the foot of this file that the parent differences.
//
// ⚠ AN ENV VAR AND NOT A FLAG, ON PURPOSE. `RUNNER_FLAGS` is the WHOLE
// vocabulary this runner accepts and gate FLAG asserts it refuses everything
// else; adding a fifth flag would widen the surface FLAG exists to hold shut.
const SPLNT_CHILD = process.env.SLICER_GATE_SPLNT_CHILD === '1';
const SPLNT_ROWS_TAG = 'SPLNT-ROWS ';

// ---------------------------------------------------------------------------
// `--self-plant` — the negative control for defects that live IN THIS HARNESS.
//
// 🔴 WHY A SECOND PLANT MECHANISM EXISTS, when `--plant` on the CLI is supposed
// to be the only one. `--plant` puts a defect in the PRODUCT, and it is the
// right tool whenever the thing under test is the product. It cannot reach
// three classes of defect that this file is now asserting against:
//
//   1. THE SCORING ITSELF. Nothing a plant does to the core can make the
//      verdict line mis-report a PENDING, because the verdict is computed here.
//   2. A STALENESS CHECK. `STALE` compares the binary's baked-in core digest to
//      one recomputed here; planting it means editing `core/src`, which is a
//      different lane's tree on most days and is forbidden on this one.
//   3. NON-VACUITY OF A COMPARISON. `P8` asserts emitted hole positions against
//      an independently computed transform. Perturbing the EXPECTATION by 1mm
//      is what proves the comparison is live; there is no product defect that
//      does that.
//
// Two properties keep this from becoming a way to make a bad tree look good:
//   - a self-planted run can only REMOVE greens. Every entry below either
//     injects a failure/pending or corrupts an expectation.
//   - a self-planted run is FORBIDDEN from printing `VERDICT: GO`. If a plant
//     leaves the run clean, that IS the finding — the control planted nothing —
//     and the run says so and exits non-zero.
//
// Do not let a self-plant into a real run. It prints a banner on every line of
// the scorecard for exactly that reason.
const SELF_PLANTS = {
  'pend-unbudgeted': 'inject a PENDING for a gate that is NOT in PENDING_BUDGET — must become FAIL, verdict NO-GO',
  'pend-budgeted': 'inject a PENDING for a budgeted gate — must stay PENDING, verdict INCOMPLETE, exit 3',
  'stale-core': 'salt the recomputed core digest — STALE must go red on a tree that is genuinely current',
  'p4-count-all': 'count EVERY canned cycle as a relief, the pre-fix behaviour — P4 must go red on the plate leg',
  'p8-expect-shift': 'shift P8’s independently computed expectation by 1mm — P8 must go red',
  'doc-roster': 'ask GDOC for a gate id that has no row in SLICER-GATES.md — GDOC must go red',
  'verdict-go-on-gaps': 'restore the pre-2026-08-10 verdict rule (pending discarded) — VERD must go red',
  'cad1-oracle-plant': 'run scad_oracle under its own --plant mesh-scale — CAD1 and CAD1H must go red on cases that are not in the baseline',
  // ⚠ THE SECOND HALF OF THIS DESCRIPTION USED TO CLAIM CAD1H'S RATCHET-DOWN LIMB
  // AND NEVER DROVE IT (corrected 2026-08-11, by running it rather than reading
  // it). The plant raises `max` in THIS FILE only, and the branch that compares
  // the gate file against `SLICER-GATES.md` sits AHEAD of both WORSE and
  // RATCHET-DOWN in the CAD1H chain — so CAD1H has always failed here on the
  // DOC-COUPLING limb, which is a different limb and a real one. It cannot reach
  // the ratchet without also editing the document, which a self-plant must not do.
  // A control whose description names a limb it cannot reach is a limb everyone
  // believes is covered, so the description is corrected rather than the plant.
  // FOUR for the CAD1/CAD1H limbs added 2026-08-11, when the oracle's refusal
  // went three-valued and the gates could see neither half of it. One per limb,
  // for the reason RUN's and CADT's sets give: a control that proves one limb
  // says nothing about the other three.
  'cad1-verdict-unknown':
    'corrupt ONE oracle row to a verdict word this gate does not model — CAD1 and CAD1H must BOTH go red naming the ' +
    'word. The defect it models is the one that was live all day: both gates counted `REFUSED`, which the oracle had ' +
    'stopped emitting, and printed `0 REFUSED` over 21 real refusals. A vocabulary this file does not know must fail, ' +
    'never count as zero, because a zero reads as an absence',
  'cad1-ledger-unlisted':
    'add one corpus name and one hardware name to the oracle ledger’s `fresh` list — a refusal that is STRICTER ' +
    'than openscad with no ledger entry. CAD1 must go red on the corpus name and CAD1H on the hardware one, SEPARATELY: ' +
    'the oracle raises this NO-GO for both legs in one list, and failing CAD1 for a file in hardware/cad/ is the ' +
    'cross-leg defect the per-leg PENDING split was written to undo. The plant also adds the matching failure string, ' +
    'so it drives the ledger limb and not the bookkeeping limb beside it',
  'cad1-ledger-absent':
    'delete the oracle’s `stricterLedger` from its JSON — CAD1 and CAD1H must BOTH go red on a BROKEN INSTRUMENT. ' +
    'That object is the only route the oracle’s NO-GO has into a gate (this file reads its exit code for 2 and ' +
    'nothing else), so its absence must not read as a ledger with nothing to say',
  'cad1-ledger-bookkeeping':
    'add a ledger failure in a category this gate does not model — CAD1 and CAD1H must BOTH go red rather than ' +
    'scoring the categories they happen to know. This is the enumeration limb watching itself: the per-category ' +
    'list is exactly the kind of list that goes blind to what is added later, which is the defect it was written for',
  // 🔴 THE TWO LIMBS OF THE PENDING RATE RATCHET HAD NO CONTROL AT ALL, and at
  // equilibrium NEITHER EXECUTES — ceo relaying `research`, 2026-09-05: a
  // ratchet sitting at its ceiling is untested in both directions, because
  // deleting either branch changes no output. This lane re-pinned that ratchet
  // five times in one day with nothing able to see it.
  'disclosure-deleted':
    'strip a self-limiting caveat out of the message a gate ACTUALLY EMITTED, exactly as an edit that ' +
    'reworded or removed it would. DISC must go red. 🔴 This is the class ceo measured fleet-wide: deleting ' +
    'a caveat moves NO number and makes the control read STRONGER, so nothing else in this suite notices — ' +
    'the plant deletes rather than announcing, because a plant that pushes its own failure message proves ' +
    'the FAIL branch renders and says nothing about detection.',
  'cad1h-pending-slack':
    'widen the PENDING allowance by one, so the measured count sits BELOW what the pinned rate permits. CAD1H ' +
    'must go red on the RATCHET-DOWN limb — the half that stops unused slack sitting there to absorb the next ' +
    'regression in silence.',
  'cad1h-pending-tight':
    'narrow the PENDING allowance by one, so the measured count sits ABOVE what the pinned rate permits. CAD1H ' +
    'must go red on the UNDECIDABLE-GREW limb. ⚠ Both of these need a FULL pass: the limbs are `!QUICK`, and ' +
    'SPLNT drives its children with `--quick`, so the harness that audits controls CANNOT drive these two. That ' +
    'is stated here rather than discovered later — a control the control-auditor cannot reach is exactly the ' +
    'shape this registry exists to make visible.',
  'cad1-baseline-slack':
    'give the CAD1 baselines one entry of SLACK each (a case that is NOT diverging, and max+1). CAD1 must go red on ' +
    'the RATCHET-DOWN limb — the half that stops a baseline being quietly raised. CAD1H must go red on the ' +
    'DOC-COUPLING limb (gate file max+1 vs the document\'s un-planted N — 17 vs 16 as of 2026-08-14), which is ' +
    'what it actually reaches; its ratchet-down limb has NO negative control and is driven only by a real ' +
    'measurement moving below the baseline',
  // Added 2026-08-14 WITH the limb it drives, so the limb never existed
  // unwatched: when the instrument fix moved 15 hardware files to PENDING, the
  // UNDECIDED limb was narrowed to fail only on a PENDING whose reason is none
  // of the named, ruled classes. This plant IS the proof that half still
  // fails — a narrowed limb with no control on the remaining half is the old
  // limb removed and called a change.
  'cad1-undecided-unlisted':
    'add ONE hardware row AND ONE corpus row whose verdict is PENDING with a reason that is none of the ruled undecidable classes — ' +
    'CAD1H AND CAD1 must both go red naming theirs, because the narrowed UNDECIDED limbs carry measured classes by name, and a ' +
    'PENDING outside them is a check that broke, never coverage. The corpus row rides the same plant since 2026-08-22, when CAD1\'s limb was narrowed',
  // Three for RUN, because its three limbs fail in three different ways and a
  // control that only proves one of them says nothing about the other two.
  'run-needle-drift': 'rename one RUN branch’s test needle so it matches nothing — RUN must go red rather than silently losing that branch, which is what a renamed test looks like from inside the suite',
  'run-plant-inert': 'make the `overcount` plant answer the same clean and planted — RUN must go red, because a plant that stops planting turns its branch into decoration (gate PLANT’s own founding failure, in the Run modules)',
  'run-persona-instrument': 'run the Run suite WITHOUT the persona recorder — the log is then empty, which is byte-identical to "no fake was driven". RUN must read that as a dead INSTRUMENT and go red, never as a quiet zero',
  // Three for CADT, one per limb, for RUN's reason: a control that proves one
  // limb says nothing about the other two.
  // Armed 2026-08-28 with the routability filter it controls.
  'agpl-hijack-blind':
    'remove the RFC1918/loopback/CGNAT filter from the publish probe AND supply the lie a hijacking resolver would \u2014 ' +
    'AGPL must go red on `published` over a broken \u00a713 offer. That is the FALSE RED the filter exists to stop, so this ' +
    'control proves the filter is load-bearing rather than decorative: with it, an unroutable answer is discarded and the ' +
    'gate keeps its honest PENDING; without it, a box behind a captive portal fails the one gate whose job is to hold a ' +
    'real red visible',
  // Two for MARK, armed 2026-08-28 when it was repointed from the plan-side
  // `render` at the emitted program. One per limb.
  'mark-depth-window':
    'narrow the engraving-depth window to a band no move can occupy (-0.9 > Z > -1.0) — MARK must go red. ' +
    'P8\u2019s precedent: perturbing the EXPECTATION is what proves the comparison is live, and there is no product ' +
    'defect that makes a gate stop reading the Z it claims to read',
  'mark-banner-blind':
    'strip every `( op: \u2026 [tool] )` banner from the text this gate parses \u2014 MARK must go red because the marking ' +
    'moves can no longer be attributed to an operation or to a cutter. A gate that keeps answering after its subject ' +
    'disappears has widened to an easier question, which is how the plan-side version of this gate stayed green for weeks',
  // Two for TSC, armed 2026-08-28 with the gate. One per limb that can carry
  // a control, for the reason RUN's, CADT's and HOST's sets give: a control
  // that proves one limb says nothing about the other.
  'tsc-error-blind':
    'write a REAL type error into a REAL file inside `web/src` — in the program of BOTH configs — and require TSC to go red naming it. ' +
    'It plants the DEFECT, not the message. \ud83d\udd34 It writes to the shared tree: the file is removed in a `finally`, removed again ' +
    'before any write in case a killed run left one, and the gate FAILS if it is still there afterwards',
  'tsc-runner-blind':
    'replace the compiler with a process that exits 0 saying nothing — TSC must report "it did not run" rather than reading no ' +
    'diagnostics as a clean tree. A silent exit 0 and a compiler that never started are the same output to anything that only ' +
    'reads the exit code',
  'cadt-needle-drift': 'rename CADT-7’s needles so they match nothing — CADT must go red rather than silently losing the stale-mesh branch. A renamed test and a deleted one are the same thing from inside the suite, and the branch list is the only place that can tell them apart',
  'cadt-file-blind': 'drop `cad-ask.test.ts` from the DISCOVERED set — CADT must go red because CADT-10/11/12 lose their assertions. This proves the discovery limb is load-bearing: a file that stops being scheduled must not read as a file whose tests all passed',
  'cadt-summary-blind': 'run a process that emits no TAP at all — CADT must report "it did not run" rather than reading zero failing tests as a clean suite. A dead runner and a green suite produce the same count of reds',
  // Three for DOOR. Its red today comes from the PRODUCT, so the interesting
  // question is not "can it go red" but "would it still go red once the core is
  // fixed, and does it know when it has stopped measuring anything".
  'door-same-door':
    'drive the SINGULAR side through `tool_ids` as well, so both sides of every comparison go through the SAME door. The product disagreement then vanishes by construction and a comparator with no instrument check would read GREEN — DOOR must instead go red as a DEAD INSTRUMENT, because "the two doors agree" and "only one door was driven" are not the same finding and only one of them is a pass',
  'door-library-blind':
    'keep 5 tools of the discovered library instead of all of them — DOOR must go red because the matrix silently narrowed. A sweep that stops covering cases must not read as a sweep that passed, which is `cadt-file-blind` one lane along',
  // ⚠ Written first as "append a line to the singular program of a pair that
  // agrees" and it PLANTED NOTHING — on this tree every agreement is two
  // REFUSALS, so there was no program to append to and the run came out 66/306
  // clean and planted alike. That is `run-plant-inert` in this gate's own
  // controls, caught only by driving it. It now perturbs whatever the first
  // agreeing pair can carry, says which arm fired, and DOOR fails if neither did.
  // FLAG's harness limb. The defect is in THIS FILE's argument handling, so
  // `--plant` (which puts a defect in the PRODUCT) cannot reach it — class 4 of
  // the three listed above, and the reason this mechanism exists at all.
  'flag-harness-unguarded':
    'write a copy of THIS FILE with the `checkRunnerFlags(...)` call stripped out, into a temp directory, and point ' +
    'FLAG’s harness limb at that copy instead of at the real runner. The copy is the pre-2026-08-11 runner exactly: ' +
    'it accepts `--no-such-flag`, prints the banner and proceeds — so FLAG must go red on a NON-EMPTY stdout, which ' +
    'is the same evidence the limb uses to assert the refusal happened BEFORE the build. It lands in os.tmpdir() so ' +
    'its ROOT is a directory with no core/ and no web/, and it is driven with --quick: a plant for a defect whose ' +
    'symptom is "it runs the whole suite" must not be able to run the whole suite',
  // Three for HOST, one per limb, for RUN's and CADT's reason: a control that
  // proves one limb says nothing about the other two. All three live here rather
  // than on the CLI because the defect each models is in the ROSTER and in the
  // EXTRACTION — neither is reachable by putting a defect in the product.
  'host-undeclared':
    'drop `machine.probe_enabled` from DECLARED_HOST_DIVERGENCE — HOST must go red on the UNDECLARED limb, which is the limb that would have caught 158658175e’s seam on the day it was introduced instead of two days later',
  'host-stale-entry':
    'declare `machine.safe_z_mm` — a field the two hosts AGREE on — as an intended divergence. HOST must go red as a STALE DECLARATION. This is the half that fails in the other direction: an exemption outliving the thing it exempts reads exactly like a live one, and this lane has found two stale reds today',
  'host-extract-blind':
    'return an EMPTY browser config from the App.tsx extraction. HOST must report a DEAD INSTRUMENT and go red, never "0 divergences found" — an extractor that reads nothing and a pair of hosts that agree produce the same number of findings, and only one of them is a pass',
  // Two for G2, added with the input-set widening of 2026-08-12. One per limb,
  // for the reason RUN's, CADT's and HOST's sets give: a control that proves one
  // limb says nothing about the other. Neither is reachable by `--plant`, which
  // puts a defect in the PRODUCT — the first models a SCAN that narrowed (there
  // is no product defect that removes a program from a gate's input set) and the
  // second models the post's paren sanitiser regressing, which is unconditional
  // in `post_grblhal.rs` and has no plant.
  'g2-input-narrow':
    'cut G2’s input set back to the single `rect-arcs` fixture — the pre-2026-08-12 runner exactly. G2 must go red on ' +
    'the REACH limb, because the `off material:` comment stops being reached and a scan that silently narrows reads ' +
    'exactly like a scan that passed. It is `door-library-blind` one gate along',
  'g2-comment-escape':
    'land a `)` inside the `off material:` comment body with a rapid and an FFF temperature code after it — the post’s ' +
    'paren sanitiser regressed. G2 must go red naming the text that follows the close, because THAT is what makes a ' +
    'banned word in a comment executable rather than inert, and it is the premise limb 1 rests on when it skips ' +
    'comment lines',
  // Three for AGPL, added 2026-08-12 with the two probes. None is reachable by
  // `--plant` (which puts a defect in the PRODUCT): the first two model a state
  // OF THE WORLD that this lane must not create to test — publishing 2bee.app
  // is the very act the gate exists to interrupt — and the third models the
  // box's own network being gone, which is a state you cannot arrange by
  // editing a file.
  'agpl-published':
    'force the publish probe to report PUBLISHED with the footer still on the known-dead link — AGPL must go RED, ' +
    'not pend. This is the ONE branch the gate carried in prose ("IT MUST BECOME A FAIL THE DAY A DEPLOY TARGET ' +
    'EXISTS") and in no code at all, so the flip depended on a human remembering, on the side of the asymmetry ' +
    'where the cheap step (one DNS record) is available before the compliant one (a repo decision)',
  'agpl-offer-ruled':
    'add a SOURCE_OFFER_RULED entry for whatever URL the footer currently carries, so the gate stops asking "has ' +
    'legal ruled" and reaches the DELIVERY probe — which must then measure the real link and fail on what it ' +
    'answers. On this tree that is the known-dead one and the expected red names its HTTP status. ⚠ OFFLINE this ' +
    'plant produces PENDING/UNCHECKED instead, which is the correct answer and is still not a GO; a self-planted ' +
    'run may not print VERDICT: GO either way',
  'agpl-surface-divergent':
    'make the LOGIN SCREEN report a different offer URL from the footer — AGPL must go RED naming both surfaces. ' +
    'The limb this proves was added 2026-08-27 after the gate was found reading `App.tsx`\u2019s <footer> and nothing ' +
    'else, while `AuthGate.tsx` carried a second live link to the same dead repository on the one page an ' +
    'unauthenticated visitor sees. A gate narrowed to the one place a defect was found stays narrow, and the ' +
    'README already recorded that exact failure as retired',
  'agpl-offline':
    'rule the current URL AND force both probes to UNCHECKED — the box has no network. AGPL must report PENDING, ' +
    'never PASS. It is the whole point of adding the probes: a gate that makes a network request is a gate that ' +
    'goes red (or worse, green) when the box is offline, and the offline case must not be able to render as ' +
    'compliance. This is the only control that watches the ruled-target path NOT go green',
  'door-inject':
    'perturb the SINGULAR result of the first pair that genuinely agrees — an extra line if both doors emitted, a synthetic program if both refused — so DOOR must report one MORE disagreement than the clean run and NAME that pair. It is also the only live control on the byte limb once the core is fixed and real different-program pairs stop existing',
  // The one control on gate SPLNT, which audits this registry. It models the
  // failure SPLNT exists for — a registry entry whose branch was refactored
  // away — by adding a name to the audited set that nothing in this file
  // branches on. SPLNT's STATIC limb must go red on the missing call site.
  'splant-orphan':
    'audit a self-plant name that has NO `selfPlanted()` call site anywhere in this file — SPLNT must go red on the ' +
    'ORPHAN limb. That is a registry entry whose branch was refactored away: the flag is still accepted, the run ' +
    'still reports success, and it patches nothing. It is the only in-band control this gate has, and it covers the ' +
    'STATIC limb only — the DRIVE limb cannot have one, because driving it would need a child that itself runs DRIVE',
};
// ---------------------------------------------------------------------------
// 🔴 WHAT EACH SELF-PLANT IS CONTRACTED TO MOVE — the machine-readable half of
// the descriptions above, and what makes gate SPLNT possible at all. Added
// 2026-08-12, when all 31 were driven for the first time and the answer to
// "what audits these?" turned out to be NOTHING: `PLANT` covers the 20
// `--plant` PRODUCT plants, and a self-plant that has stopped planting applies,
// reports success and reddens nothing — `door-same-door`'s founding failure,
// one registry along.
//
// ⚠ A CONTRACT, NOT A RESTATEMENT OF THE PROSE ABOVE. Nothing can check a
// description; these ids are compared against `GATES` and against a measured
// run, so a gate that is renamed or retired takes its own negative control down
// LOUDLY instead of quietly.
//
// ⚠ `moves` IS THE FULL BLAST RADIUS, NOT THE HEADLINE. SPLNT fails a plant
// that moves a gate this list does not name: a control whose side effects
// redden a gate nobody aimed at proves that gate can go red for a reason nobody
// planted, which is the opposite of a negative control. `g2-comment-escape` was
// corrected for exactly that, one limb along.
//
// ⚠ `masked` IS AN EXEMPTION WITH A TRIPWIRE, on PENDING_BUDGET's precedent. It
// says "this plant is SUPPOSED to move that gate and cannot today, because the
// limb it aims at sits behind one that is already red". SPLNT checks BOTH
// halves every run — the gate must still be FAILING in the clean baseline, and
// the plant must still fail to move it — so the exemption cannot outlive its
// reason. A stale exemption reads exactly like a live one.
const SELF_PLANT_TARGETS = {
  'pend-unbudgeted': { moves: ['G1'] },
  'pend-budgeted': { moves: ['BRND'] },
  'stale-core': { moves: ['STALE'] },
  'p4-count-all': { moves: ['P4'] },
  'p8-expect-shift': { moves: ['P8'] },
  'doc-roster': { moves: ['GDOC'] },
  'verdict-go-on-gaps': { moves: ['VERD'] },
  'cad1-oracle-plant': { moves: ['CAD1', 'CAD1H'] },
  'cad1-verdict-unknown': { moves: ['CAD1', 'CAD1H'] },
  // ✅ UNMASKED 2026-08-14, and the tripwire did exactly what it was built to
  // do: CAD1H returned to its baseline (16, after the instrument fix moved 15
  // artefact-divergences to PENDING), so the premise below is gone by design
  // and the CAD1H half is back in `moves`, driven like every other contract.
  // The text it replaces is kept in the git history of this file; it recorded
  // that the hardware ledger limb sat BEHIND `WORSE` (31 vs 29) and could not
  // be reached, measured by driving it 2026-08-12.
  'cad1-ledger-unlisted': { moves: ['CAD1', 'CAD1H'] },
  'cad1-ledger-absent': { moves: ['CAD1', 'CAD1H'] },
  'cad1-ledger-bookkeeping': { moves: ['CAD1', 'CAD1H'] },
  /* 🔴 `CAD1` ONLY SINCE 2026-09-02, AND WHAT THAT GIVES UP IS NAMED.
   *
   * This declared `['CAD1', 'CAD1H']` and SPLNT correctly reported it planting
   * NOTHING on CAD1H after the cadence split: SPLNT drives `--quick` children,
   * `--quick` runs the CUT-FILE SUBSET, and this plant's subject is the
   * BASELINE COUNT — a number over the whole live population, which cannot be
   * scored on 17 files. Its sibling `cad1-ledger-unlisted` still moves both,
   * because a STRICTER refusal missing from the ledger is a finding at any
   * population size; only the count needs the full set.
   *
   * ⚠ GIVEN UP: CAD1H's ratchet-DOWN limb — "the baseline still allows N and
   * only N-1 diverge, lower it" — now has no negative control. It is exercised
   * by the real nightly run and by CAD1's identical limb over the corpus, and
   * it is NOT unguarded in the sense that matters (a stale baseline still fails
   * the run); what is lost is the on-demand proof that it can go red. Restoring
   * it needs a full-population child, which is 6 minutes per plant. */
  'disclosure-deleted': { moves: ['DISC'] },
  'cad1h-pending-slack': { moves: ['CAD1H'] },
  'cad1h-pending-tight': { moves: ['CAD1H'] },
  'cad1-baseline-slack': { moves: ['CAD1'] },
  'cad1-undecided-unlisted': { moves: ['CAD1', 'CAD1H'] },
  'run-needle-drift': { moves: ['RUN'] },
  'run-plant-inert': { moves: ['RUN'] },
  'run-persona-instrument': { moves: ['RUN'] },
  'agpl-hijack-blind': { moves: ['AGPL'] },
  'mark-depth-window': { moves: ['MARK'] },
  'mark-banner-blind': { moves: ['MARK'] },
  'tsc-error-blind': { moves: ['TSC'] },
  'tsc-runner-blind': { moves: ['TSC'] },
  'cadt-needle-drift': { moves: ['CADT'] },
  'cadt-file-blind': { moves: ['CADT'] },
  'cadt-summary-blind': { moves: ['CADT'] },
  'door-same-door': { moves: ['DOOR'] },
  'door-library-blind': { moves: ['DOOR'] },
  'door-inject': { moves: ['DOOR'] },
  'flag-harness-unguarded': { moves: ['FLAG'] },
  'host-undeclared': { moves: ['HOST'] },
  'host-stale-entry': { moves: ['HOST'] },
  'host-extract-blind': { moves: ['HOST'] },
  'g2-input-narrow': { moves: ['G2'] },
  'g2-comment-escape': { moves: ['G2'] },
  'agpl-published': { moves: ['AGPL'] },
  'agpl-offer-ruled': { moves: ['AGPL'] },
  'agpl-surface-divergent': { moves: ['AGPL'] },
  'agpl-offline': { moves: ['AGPL'] },
  'splant-orphan': { moves: ['SPLNT'] },
};

// 🔴 GATES WHOSE ROW IS A FUNCTION OF OTHER GATES' ROWS. `GDOC`'s limb C reads
// `results` and compares every state claim SLICER-GATES.md makes in prose
// against the state that gate reached in THIS run — so ANY plant that moves any
// gate the document talks about also moves GDOC, through no fault of the plant.
// Measured 2026-08-12: all three `run-*` plants redden GDOC on `line 406: the
// document states "RUN` is PENDING" and RUN is FAIL in this run`.
//
// ⚠ Movement of a derivative gate is NOTED, never failed — and that IS a real
// narrowing of the undeclared-blast-radius check, said out loud instead of
// buried in a filter. What it costs: a plant that reached GDOC for its own
// reason, rather than through a state claim, would be waved through here.
const SELF_PLANT_DERIVATIVE = new Set(['GDOC']);

const SELF_PLANT = (() => {
  const i = process.argv.indexOf('--self-plant');
  if (i < 0) return null;
  const name = process.argv[i + 1] ?? '';
  if (!Object.prototype.hasOwnProperty.call(SELF_PLANTS, name)) {
    console.error(`  FATAL unknown --self-plant ${JSON.stringify(name)}. Known:`);
    for (const [n, why] of Object.entries(SELF_PLANTS)) console.error(`    ${n.padEnd(18)} ${why}`);
    process.exit(2);
  }
  return name;
})();
const selfPlanted = (name) => SELF_PLANT === name;

let BIN = join(ROOT, 'target/release/2bee-slice');

const results = [];
const pass = (id, msg) => results.push({ id, state: 'PASS', msg });
const fail = (id, msg) => results.push({ id, state: 'FAIL', msg });
const pend = (id, msg) => results.push({ id, state: 'PENDING', msg });

function fatal(msg) {
  console.error(`  FATAL ${msg}`);
  console.error('\nGATE ABORTED — results would be meaningless.');
  process.exit(2);
}

/**
 * Run the slicer. Never throws — the exit code IS the signal under test.
 *
 * spawnSync, not execFileSync: execFileSync returns stdout ONLY, and discards
 * stderr on success. Warnings are emitted on stderr by a program that exits 0,
 * so that shape of harness cannot see a warning at all — it reported
 * "warned=false" for a warning that was printed. A harness that cannot observe
 * half the output is not observing the program.
 */
function slice(args) {
  const r = spawnSync(BIN, args, { encoding: 'utf8' });
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/**
 * Lines of actual G-code — comments and blanks are not motion.
 *
 * 🔴 EVERY scan below must go through this. The preamble comments legitimately
 * NAME the things the gate bans ("G41/G42 absent from grblHAL core") and
 * legitimately contain letter-number pairs that look like words ("F2" = two
 * flutes). Scanning raw text makes the gate match the text that DISCUSSES what
 * it scans for — G2 and G12 both false-failed exactly this way on first run.
 */
const codeLines = (g) => g.split('\n').filter((l) => l.trim() && !l.trim().startsWith('('));

// ---------------------------------------------------------------------------
// The gate table. `plant` names the negative control for HARD gates.
// ---------------------------------------------------------------------------
const GATES = [
  ['G0', 'BUILD + UNIT TESTS', 'HARD', 'a core that does not compile cannot be reasoned about'],
  ['G1', 'DETERMINISM', 'HARD', 'golden-file tests are worthless if the same input drifts'],
  ['G2', 'DIALECT', 'HARD', 'an FFF word in a CNC program is a command the controller may obey'],
  ['G3', 'TRAVEL LIMITS', 'HARD', 'a move past the travel drives the gantry into its own frame'],
  ['G4', 'SPOILBOARD', 'HARD', 'cutting past the workpiece puts the cutter in the spoilboard'],
  ['G5', 'COMMENT INJECTION', 'HARD', 'a paren in a name ends the comment; the rest executes'],
  ['G6', 'SPINDLE', 'HARD', 'feeding a stationary cutter into ply snaps it'],
  ['G7', 'ARC EMISSION', 'HARD', 'polylined curves flood the planner and stutter the finish'],
  ['G8', 'ARC PRECONDITION', 'HARD', 'an arc with no known start has undefined I/J — a wild move'],
  ['G9', 'PECK CYCLE', 'HARD', 'a drill with no peck packs the flutes and burns the hole'],
  ['G10', 'BLOCK RATE', 'HARD', 'segments shorter than the planner can consume stall the feed'],
  ['G11', 'Z-ZERO SETTING BITES', 'HARD', 'a setting consumed by nothing reads as configured'],
  ['G12', 'FEEDS FROM CHIPLOAD', 'HARD', 'a feed not derived from the tool burns the edge'],
  ['G13', 'FAIL CLOSED', 'HARD', 'a rejected program that still prints G-code gets run anyway'],
  ['G14', 'BINARY STABILITY', 'HARD', 'a build mid-gate compares two different programs'],
  ['STALE', 'BINARY CURRENCY', 'HARD', 'a suite that answers about a binary older than the source gives 47 true answers to a question nobody asked — and G14 cannot see it, because it hashes the same stale file twice'],
  ['P1', 'TABS', 'HARD', 'untabbed parts break loose into a 2.2 kW spindle'],
  ['P2', 'POCKET CLEARING', 'HARD', 'an outlined pocket leaves an island standing'],
  ['P3', 'POCKET FLOOR DEPTH', 'HARD', 'a pocket short of its floor looks right and will not seat a tenon'],
  ['P4', 'DOGBONE RELIEF', 'HARD', 'a square peg will not seat in a round-cornered socket'],
  ['P5', 'HOLE SIZING', 'HARD', 'a hole drilled with the wrong tool is its own diameter'],
  ['P6', 'COLLET vs SHANK', 'HARD', 'an oversize shank will not enter; undersize is thrown'],
  ['P7', 'FIXTURE KEEPOUT', 'HARD', 'a toolpath through a clamp destroys both'],
  ['P7R', 'TURNED-CLAMP KEEPOUT', 'HARD', 'a clamp the VIEWPORT turns and the CHECK does not is a clamp that looks right and is checked wrong, in two directions: a cut into the real clamp passes because the axis-aligned box misses where the clamp is, or a sound program is refused because that box covers where the clamp is not. The first one is a 2.2 kW spindle into steel'],
  ['P8', 'NEST TRANSFORM', 'HARD', 'nest polygons drop internal holes and still look right'],
  ['P9', 'MATERIAL REMOVAL SIM', 'HARD', 'gouges are invisible until the part is scrap'],
  ['MOVE', 'DRAGGING THE PART ON THE WORKPIECE', 'HARD', 'a part the operator has moved must move IN THE EMITTED PROGRAM, by exactly the same amount, measured on the workpiece so it turns with the workpiece — and it must move the SIMULATION\u2019s regions and the FIXTURE keepout with it. The three ways this goes wrong are all silent: an offset stored and displayed while every coordinate stays where it was (this lane\u2019s most-repeated defect, four times over); geometry that moves while the verification stays behind, which is DINV one term along and reports a clear workpiece because nothing overlaps any more; and a drag that RELOCATES a program past a clamp instead of being refused by it, which is the one thing this tool must never learn to do'],
  ['REACH', 'UNREACHABLE MATERIAL IS NAMED', 'HARD', 'THE ONLY OBLIGATION IN THIS TABLE. Every other gate here forbids something and goes red when it sees it; this one requires the program to SAY something, and a feature that is simply not cut leaves no wrong move for a prohibition to find. Measured 2026-08-31: a 60x60 plate with a 2mm x 55mm notch, cut Outside with a 6mm cutter, emitted 230 cutting moves with ok=true and gouge=0 while 109.8mm2 of its own outline could not be produced — the tool cannot enter a 2mm gap, the offset closes the slot, and the part comes out SOLID there. Every coordinate is a real coordinate of a real part, so nothing downstream can notice and it is found at assembly. The negative control is INVERTED for the same reason: the planted defect is the SILENCE, so `--plant reach-blind` removes the sentence and leaves the program byte-identical'],
  ['MULTI', 'SEVERAL DRAWINGS ON ONE WORKPIECE', 'HARD', 'two parts cut from the same material is one program destroying its own second part: the first profile removes the second’s edge, and what is left is a loose offcut under a 2.2 kW spindle WHILE THE PROGRAM IS STILL RUNNING. Nothing downstream can notice, because every coordinate is a real coordinate of a real part. So the refusal comes before the program exists and emits ZERO bytes — and the three ways this goes wrong are all silent: an overlap warned about over a runnable file (a warning above a program is a program that gets run); a part the operator moved or turned that moves ONLY IN THE PICTURE, which is this lane’s most-repeated defect arriving one object along; and a refusal so eager that nothing ever emits, which is indistinguishable from a working check until the day somebody needs two parts on a workpiece'],
  ['DINV', 'SIM DATUM INVARIANCE', 'HARD', 'a verdict that changes when the workpiece is moved is an answer about a part nobody is cutting — an operator told a clean program is dirty, or worse, that a dirty one is clean'],
  ['RPRB', 'RE-PROBE AFTER A TOOL CHANGE', 'HARD', 'a new tool is a new LENGTH, so the Z datum set for the old one describes nothing. Every cut after the change is displaced by the tool-length difference — shallow and the joint does not fit, deep and the cutter is in the spoilboard — and the program renders, posts and runs perfectly either way. Armed 2026-08-09: `--plant no-reprobe` was registered from the day it was written and driven by NO GATE, covered only by unit tests, which is the evidence class that scored 343/343 through a live plant in main()'],
  ['PLANT', 'THE PLANTS STILL PLANT', 'HARD', 'a negative control that silently stops planting runs CLEAN and reads as a PASSING control, which turns every other row in this table into decoration. Measured 2026-08-09: `wrong-drill` announced `PLANTED:` while adding no hole, no operation and no motion — byte-identical output on all six jobs; three plants were consumed by no gate at all; and ten of the eighteen are INERT on most targets, so a control hung on the wrong pairing proves nothing and says so nowhere'],
  // Armed later than the block above, once the settings they guard existed.
  ['B2B4', 'DATUM + MATERIAL', 'HARD', 'a setting consumed by nothing reads as configured'],
  ['DOC', 'DEPTH + CHIP CEILING', 'HARD', 'a pass deeper than this machine class supports deflects the cutter into an out-of-tolerance wall, burns the glue line, and leaves the tool buried when the part lets go — and the first failure is SILENT, a joint that does not fit and gets blamed on the CAD'],
  ['TECH', 'TECHNOLOGY SEAM', 'HARD', 'an unimplemented process must be refused, never posted as CNC. ⚠ DOWNGRADED 2026-08-10 AND SAY SO: no product path takes a technology, so that failure CANNOT OCCUR and this gate cannot go red for the reason it exists. What it does check is real but smaller — the declaration, a refusal of an unknown technology, and that each ban list BITES the other technology’s program'],
  ['C6', 'TOOL LIBRARY I/O', 'HARD', 'a tool fed at somebody else\u0027s numbers burns the edge'],
  ['MARK', 'PART MARKING', 'HARD', '36 identical blanks cannot be sorted without an ID'],
  ['LEAD', 'LEAD IN/OUT', 'HARD', 'entering along the wall leaves a witness mark on the finished edge'],
  ['ENT', 'ENTRY INTO THE CUT', 'HARD', 'a cutter dropped straight to depth loads the ends of the flutes, which do not cut axially — it snaps the tool or lifts the work off the spoilboard'],
  ['SPIN', 'SPINDLE BAND + SPIN-UP', 'HARD', 'cutting before the spindle is at speed, or at an rpm it cannot deliver, is a chipload the cutter is not rated for'],
  ['REL', 'RELEASE ORDERING', 'HARD', 'a part whose outline is cut by one tool group and whose holes are cut by a LATER one is held by its tabs alone while that later tool works on it — it breaks loose into a 2.2 kW spindle. P1\u2019s physical failure, arriving through the ordering rules instead of through a missing tab'],
  ['PROBE', 'XYZ TOUCH PLATE', 'HARD', 'an X/Y probe touches with the SIDE of the cutter, so the datum carries the tool radius — get it wrong and every coordinate is displaced in a direction the preview cannot show'],
  ['TOOL', 'TOOL SELECTION', 'HARD', 'a program whose feeds, depth per pass, pass count and clearances were all derived from a cutter that is not in the spindle — it renders, posts, downloads and cuts, and the only thing wrong with it is the tool nobody chose'],
  ['DOOR', 'THE TWO TOOL DOORS AGREE', 'HARD', '`tool_id: X` and `tool_ids: [X]` are TWO DIFFERENT CODE PATHS INTO THE PLANNER for the same one cutter, and they do not agree. `tool_ids` goes through `assign_tools_from_set` -> `recommend()` per feature, whose rejections become `tool_set_refusals` and reach the check at `job.rs:1140`. `tool_id` sets the tool on every operation and RETURNS — `apply_tool_set` gets `None`, the refusal list stays empty, and the per-feature recommender is never called. So the one-tool run was never PASSING that check, it was SKIPPING it: `pocket` + a 6mm down-cut through the singular door emits 962 lines, `ok: true`, zero refusals, while the simulator on that same run reports 6.0mm of material still standing at (120.6, 90.6) — and the set door refuses the job outright. Same cutter, same fixture, two answers, and the safe one is not the one that emits'],
  ['FLAG', 'FLAG ACCEPTED + DISCARDED', 'HARD', 'a flag that is accepted and ignored reads to the operator, the script AND THE GATE as a setting that took effect — `import --plant` exited 0 doing nothing, which would make any negative control driven that way vacuous, and `job --config` discarded every machine, workpiece, clamp and tool setting in the file on the host that prints the program an operator sends to the machine'],
  ['F1', 'DXF/SVG INTAKE', 'HARD', 'a dropped entity cuts a part that is missing a feature'],
  ['AGPL', 'SOURCE OFFER (\u00a713)', 'HARD', 'this lane is AGPL-3.0-or-later: the moment it is SERVED, every user must be offered its Corresponding Source. The link in the footer IS the offer, and a 404 is not an offer'],
  ['SPEC', 'SPEC CITATIONS', 'HARD', 'a spec row naming a gate that does not exist reads as gated and is not'],
  ['CAD1', 'SCAD SUBSET vs OPENSCAD', 'HARD', 'a .scad source our CAD tab evaluates into a DIFFERENT PART from the one the author wrote and OpenSCAD renders. Nothing downstream can notice: every contour is a real contour of a real solid, so it posts, simulates, gates green and cuts a plausible-looking wrong part. `edge_modifier_root` emits the OPPOSITE OBJECT today'],
  ['CAD1H', 'SCAD SUBSET vs OUR OWN MODELS', 'HARD', 'the same failure on the 296 LIVE .scad files under hardware/cad/ — recursive, minus 288 in archive/ and ref_models/ which are excluded WITH THEIR REASON PRINTED at run time (superseded / vendor reference: not cut, not shipped). Of those, 16 are _wcnc CNC cut files and 6 diverge. ⚠ THIS LINE READ "the 73 .scad files this company actually cuts" UNTIL 2026-09-02 AND SCANNED NONE OF THEM: the collector was non-recursive and every cut file is in a subdirectory, so the set was 6 top-level files plus 79 in lib/, parsed with no library host. The number was true of what it measured and false of what it was called — corrected here because the TABLE line is what a reader sees first, and ratcheting a baseline onto a gate that misdescribes its own population re-creates the defect at a larger number. A REFUSAL is safe (nothing is emitted); a DIVERGENCE is a wrong part with no warning — so the tracked number is DIVERGES+ERROR, and REFUSED->DIVERGES counts as getting WORSE even though it looks like new capability'],
  ['BRND', 'VENDORED BRAND MARK', 'HARD', 'a vendored copy of another lane\u2019s asset silently stops matching its master \u2014 the app renders a logo brand has since changed, and the copy\u2019s own header is the only thing claiming it is current'],
  ['RUN', 'THE RUN TAB’S SENDER', 'HARD', 'a sender that stalls mid-cut leaves a TURNING CUTTER STATIONARY in the material — it burns the edge and on a small cutter it snaps — and a sender that misreads the machine’s state starts a job on a machine whose position is unknown, or rapids DOWNWARD through the stock because the stored G54 Z belonged to the last job. ⚠ AND EVERY GREEN HERE IS ABOUT OUR OWN READING: the fake was written from grblHAL’s C by this lane, so it can prove the sender self-consistent and can never discover the reading is wrong. 🔴 Until 2026-08-11 the 147 assertions about this tab were run by NO GATE — `npm run test:node` sat in web/package.json and nothing invoked it'],
  ['CADT', 'THE CAD TAB’S OWN SUITE', 'HARD', 'the 2bee.cad tab and the app’s own state — the SCAD parser, its import host, the degree trigonometry, the mesh/record round trip, the store’s schema and collections, the preview’s stale banner, the model-proposal path and the no-WebGL degradation — assert 509 things that NO GATE RAN. `npm run test:node` runs `tests/*.test.ts`; gate RUN drives two of those files and nothing drove the other 27. A suite nobody schedules is a file that agrees with itself whenever somebody remembers to look at it. 14 branches are NAMED because a rename there silently unguards a wrong-part failure; the rest are held by "the suite is green", and the file set is DISCOVERED rather than enumerated so a new test file cannot land outside the gate'],
  ['TSC', 'THE TREE STILL COMPILES', 'HARD', 'committed code that does not compile cannot be BUILT, and the browser is one of this tool’s two hosts — a host that cannot be built cannot be compared with the CLI, which is the whole of K3 and I1. Measured 2026-08-28: `a1efde7d92` landed three type errors in `web/e2e/run18.spec.ts`, `npm run build` was red on committed code, and the full 59-gate suite passed over it because NO GATE RAN A COMPILER. The two checks that look like they cover this do not, and both are right not to: `typecheck-coverage.test.ts` asserts WHICH FILES tsc reads and says in its own header that it does not assert the tree is clean, and I1’s Playwright `webServer` runs `vite build` rather than `npm run build` by a deliberate ruling — esbuild strips types without checking them, so a bundle builds green over code that does not compile'],
  ['HOST', 'THE TWO HOSTS’ OPENING DEFAULTS', 'HARD', 'the browser and the CLI hand the SAME core a DIFFERENT MACHINE when nobody has declared one, and no gate could see it: K3 compares the core (both hosts agree on it), I1 compares one program planned from ONE config, and PROBE/RPRB are green because they only ever drive the CLI. Measured 2026-08-11: `job plate` exits 0 with four G38.2 moves at the CLI default and exits 1 with ZERO bytes at the browser’s. The operator-facing failure is not that a default is wrong — it is that a program which runs on one host and is refused on the other looks like a REGRESSION to everyone who meets it, so the real cause is looked for in the core, where it is not'],
  ['I1', 'BROWSER PARITY + UI', 'HARD', 'the browser and the CLI must emit identical G-code'],
  ['K3', 'CORE FINGERPRINT', 'HARD', 'a stale wasm agrees with itself — parity cannot see an un-rebuilt core'],
  // The first rung that needs hardware. It CANNOT pass from this box alone and
  // is not written so that it can: with no transcript in the tree it reports
  // PENDING, which is the true state of "no controller has ever seen our
  // output". See tools/controller_probe.py.
  ['CTRL', 'CONTROLLER ACCEPTANCE', 'HARD', 'a build without canned cycles answers error:20 to the G83 this post emits'],
  ['VERD', 'THE VERDICT ITSELF', 'HARD', 'the line every negative control asserts on could not tell "N gates answered" from "47 answered and one was switched off" — it counted PENDING, printed it in a NOTE, and discarded it before deciding. So the one class of defect that DISARMS a gate was waved through by the mechanism built to catch it, on every gate at once'],
  ['DISC', 'THE DISCLOSURES ARE STILL PRINTED', 'HARD', 'every other gate here guards the PRODUCT or a control; this one guards the SENTENCES THAT LIMIT WHAT A GREEN MEANS. Measured fleet-wide by `pnp` and ruled by ceo 2026-09-05 (FLEET_RULES 0ez): a self-limiting caveat inside a PASS branch can be deleted, reworded into meaninglessness or silently stop firing and NO CONTROL MOVES — their sweep classified runs on a FAIL prefix, so text inside a pass is invisible to it by construction and the output was BYTE-IDENTICAL after a deletion. \u26a0 Unlike a broken check, removing a caveat makes a control read STRONGER: nothing reddens and the verdict looks better, which is why it is the last thing anyone re-checks. This lane holds one of the three largest populations of them, and the class is large because we MADE it — converting silent failures into printed disclosures was right, and it manufactured the one artefact nothing guarded'],
  ['SPLNT', 'THE SELF-PLANTS STILL PLANT', 'HARD', 'PLANT audits the `--plant` PRODUCT plants and NOTHING audited the ' + Object.keys(SELF_PLANTS).length + ' `--self-plant` HARNESS controls (counted here by parsing the registry, because this cell has carried 31, 33 and 34 and each was stale when it was read). A self-plant is a negative control on a GATE — apply it and a named gate must go red — so one whose branch was refactored away, whose needle was absorbed or whose target moved APPLIES, REPORTS SUCCESS AND REDDENS NOTHING, which reads as "the gate is fine" when the truth is "the control is dead". 🔴 The one guard that existed was blind here: the run-level check refuses `VERDICT: GO` under a self-plant, comparing against an ABSOLUTE rather than the clean baseline, so on a tree with anything already red (CAD1H and CADT, for days) a plant that planted nothing printed the same NO-GO as the clean run — measured 2026-08-12, 31/31 self-planted runs NO-GO and so is the clean one (31 was the registry size THAT DAY — it is a dated measurement, not a live count)'],
  ['GDOC', 'THE GATE DOCUMENT’S OWN CLAIMS', 'HARD', 'SLICER-GATES.md says which gates are armed and where their reds are, and NOTHING READ IT — SPEC parses FUNCTIONAL-SPEC.md only. That is how MOVE’s row promised "Four witnessed reds below" with no MOVE section and no transcript anywhere in the tree, and how three live gates ended up with no row at all. A row citing evidence that does not resolve is SPEC’s defect arriving in the document SPEC does not scan'],
];

// ---------------------------------------------------------------------------
// PENDING BUDGET — which gates are ALLOWED to say "could not run", and when.
//
// 🔴 THE DEFECT THIS EXISTS FOR (audit 2026-08-10, docs/audit/). PENDING was
// counted, printed in a NOTE, and then DISCARDED before the verdict. So the one
// class of defect that DISARMS a gate — rather than failing it — was waved
// through by the line every negative control asserts on.
//
// The fix is not "PENDING always blocks". That would make every full run on a
// box with no controller a permanent NO-GO, and a verdict that is always red
// teaches people to stop reading it, which costs more than it saves. The honest
// distinction is between:
//
//   "CANNOT RUN HERE"  — a gap in the ENVIRONMENT, declared in advance, with a
//                        named reason and a named condition. It never becomes a
//                        GO, but it is not a failure either: INCOMPLETE.
//   "DID NOT RUN"      — a gate that was expected to answer and did not. That
//                        is a defect however politely it reports itself, and it
//                        is converted to a FAIL below.
//
// ⚠ ADDING AN ENTRY HERE IS A DECISION, NOT A CLEANUP. It moves a gate from
// "must answer" to "may decline", and the only thing standing between that and
// a suite of gates that all decline is that this list is short, dated, and read
// in review. If you add one, say in the commit which failure you have chosen to
// stop being able to detect.
//
//   when: 'always' — the gap is a property of the box or of the world.
//   when: 'quick'  — honest under `--quick` and a FAIL in a full run.
const PENDING_BUDGET = {
  DISC: {
    when: 'always',
    why:
      'DISC reads each caveat out of the message its gate EMITTED, so a gate that could not run ' +
      'here (AGPL needs the network) never printed its pass-branch text and its caveat is neither ' +
      'present nor missing. 🔴 WHICH FAILURE THIS STOPS BEING ABLE TO DETECT, as this list requires: ' +
      'a caveat deleted from a gate that is ALREADY red or already unrunnable here goes unnoticed — ' +
      'the deletion and the gate\'s own silence are indistinguishable from this side. That is a real ' +
      'hole and it is the SAME hole one level up (a red gate hides its own disclosure), which is why ' +
      'this reports which caveats were unchecked BY NAME rather than reporting a count.',
  },
  CTRL: {
    when: 'always',
    why: 'needs a real controller on the USB cable; evidence is a committed transcript in gates/controller/, not a run on this box',
  },
  // 🔴 ADDED 2026-08-11 with gate RUN. WHICH FAILURE THIS STOPS BEING ABLE TO
  // DETECT, said plainly as this list's own rule requires: whether grblHAL
  // understands a single byte we emit is undetectable here and will stay
  // undetectable until someone plugs in a board. ⚠ THIS USED TO NAME A SECOND
  // HALF — "whether a hidden tab keeps streaming" — and that half became
  // detectable 2026-08-28: `web/e2e/run18.spec.ts` measures it in a real
  // browser through a test-only worker entry, so RUN-18 is now a FAIL inside
  // the suite when it regresses, not a pending. NOTHING ELSE is bought: every
  // branch drivable against the fake is a FAIL inside the gate, and both
  // conditions below are TRIPWIRED — the gate goes RED if the controller half
  // becomes runnable while this entry still claims it is not, or if the RUN-18
  // test disappears while the entry declares the branch measured.
  //
  // ⚠ The design (`docs/design-76-run-tab.md` §18) writes this budget with the
  // controller condition ALONE — which, since 2026-08-28, is also the correct
  // count here.
  RUN: {
    when: 'always',
    why:
      'TWO conditions. (1) the browser-vs-machine half needs a real controller on the USB cable; evidence is a committed transcript in gates/controller/, not a run on this box — and no transcript has ever existed. ' +
      '(2) RUN-18 — and name the subject exactly, because the spec bypasses the Run tab and a verdict string must not outrun its check: THE STREAMER WORKER MODULE sustains throughput while its page is hidden. That is what was measured — NOT "RUN survives a hidden page"; nothing in the spec touches RunTab connect() wiring. ✅ MEASURED 2026-08-28 by web/e2e/run18.spec.ts, with ZERO product change: the spec drives the UNMODIFIED streamer.worker module through a TEST-ONLY worker entry (web/e2e/run18/) that prepends a fake navigator.serial over fake.ts, exactly the counter-proposal TODO #142 records. Hidden leg was REAL — verified visibilityState === hidden, page timers throttled to 3 ticks/2s — and throughput did not collapse (hidden/visible ratio 0.771, zero stall events). ⚠ That green is against fake.ts, this lane\u2019s own model of grblHAL: it proves the I/O-driven pump design survives a hidden tab in a real browser, and it cannot prove a machine agrees. ⚠ HISTORY, KEPT: this condition was stated wrong twice before — first pointing at App.tsx, then (correctly about the worker, wrongly about the fix) requiring a fake INSIDE THE SERVED worker; a test-only entry need not touch the product because the test builds its OWN worker global. A browser is no longer the blocker; Playwright has been driving this suite since 2026-08-27.',
  },
  I1: {
    when: 'quick',
    why: '--quick deliberately skips the wasm rebuild and the Playwright suite. In a FULL run an I1 that cannot answer is a failure, not a gap',
  },
  // \ud83d\udd34 REWRITTEN 2026-08-12. The old text ended "...and MUST become a FAIL the
  // day a deploy target exists" \u2014 an OBLIGATION IN A BUDGET ENTRY, which is a
  // budget entry describing work nobody had done. It is now enforced by a probe
  // (see the AGPL block), so this entry no longer promises a flip; it names the
  // two gaps that genuinely remain, on RUN's precedent that a budget naming one
  // of two gaps is a pending that reads as narrower than it is.
  // 2026-08-14: founder ruled the domain WILL be served ("@software/2bee.app/
  // will served here"), so this budget now measures a DEADLINE, not a maybe —
  // the two conditions below are unchanged and still true.
  AGPL: {
    when: 'always',
    why:
      "RULED 2026-08-14: the domain WILL be served (founder), so this pending is a deadline, not a contingency. TWO conditions. (1) \u2705 SETTLED 2026-09-04 \u2014 the offer's TARGET was a legal decision this lane may not make, and `legal` has now RULED it: a public mirror of `software/2bee.app/` only, tagged per release, recorded in SOURCE_OFFER_RULED. \u26a0 The ruling was MADE 2026-08-11 and did not reach this lane until 2026-09-04, so this gate read COULD NOT RUN for three weeks on a transmission failure rather than an open question \u2014 indistinguishable from here, and harmless only because the empty register was declared void instead of passing. What remains is not a decision: the mirror does not exist yet, so the ruled URL 404s, and publishing it is founder-gated. " +
      '(2) both probes this gate now runs \u2014 is `2bee.app` published, and does the offer URL answer \u2014 need the network, and on a box with no network the honest answer is UNCHECKED, which is NOT "the premise holds". Every branch that does NOT need the network (no link at all, two links, an unruled link, a ruled link the box can prove dead, a published domain) is a FAIL inside the gate, not a pending',
  },
  BRND: {
    when: 'always',
    why: "brand's master tree may legitimately not be present, and this lane cannot tell 'brand deleted it' from 'the path moved'. The other BRND branches FAIL",
  },
  // 🔴 ADDED 2026-08-10. WHICH FAILURE THIS STOPS BEING ABLE TO DETECT, said
  // plainly as this list's own rule requires: on a box with no `openscad`, the
  // ENTIRE CAD-subset divergence class goes undetected — every case is PENDING
  // and nothing is compared to anything. That is the whole of what this entry
  // buys. Every OTHER pending reason the oracle can produce (a timeout, an
  // unparseable .csg, a case whose measured float32 floor reaches REL_TOL, an
  // overlap the mesh leg cannot decide) is scored as a FAIL inside the gate,
  // because those are checks that BROKE, not a box that lacks a tool.
  CAD1: {
    when: 'always',
    why: 'openscad is not a build dependency of this lane and a box without the binary can compare nothing. NARROW: only "binary not found" pends — a timeout or an undecidable comparison is a FAIL inside the gate',
  },
  CAD1H: {
    when: 'always',
    why:
      'TWO reasons now, and only the first is an absence. (1) same binary, same reason as CAD1 — the hardware leg ' +
      'reads hardware/cad/ through the same oracle and cannot answer without openscad. (2) under `--quick` it runs ' +
      'the CUT-FILE SUBSET by design (ceo cadence ruling 2026-09-02): the full live population is 296 files and ' +
      '~25 min, which belongs to the nightly cadence, while the 17 files that are actually CUT run in ~16s and are ' +
      'the ones with a physical consequence. A subset is reported as a subset and never as a pass — see the ' +
      'verdict text, which names the diverging files. ⚠ THIS SECOND REASON WAS NOT ADDED WHEN THE SPLIT WAS: the ' +
      'entry said only "cannot answer without openscad" while the binary was present and the gate had CHOSEN to ' +
      'narrow, so the listing gave a reason that was no longer the reason.',
  },
  // 🔴 ADDED 2026-08-12 with gate SPLNT. WHICH FAILURE THIS STOPS BEING ABLE TO
  // DETECT, said plainly as this list's own rule requires: under `--quick`,
  // whether each `--self-plant` still CHANGES anything is not measured. The
  // STATIC half — contract present, contracted gate exists, literal call site
  // present — still runs under `--quick` and a defect there is a FAIL inside
  // the gate, not a gap. So what `--quick` gives up is exactly one thing: a
  // call site that still exists and no longer does anything.
  //
  // ⚠ THE COST IS MEASURED, NOT ASSERTED, because that is the whole reason this
  // entry exists. The DRIVE half spawns one `--quick` child per self-plant plus
  // THREE clean baselines, not two — an opening PAIR (`b1`, `b2`, taken
  // back-to-back so they cannot disagree about a moving tree) and a CLOSING one
  // (`b3`). ⚠ The child count and the baseline count were BOTH hardcoded here
  // and both had drifted: this said "34 children … 2 clean baselines" while the
  // code took three, and the registry had moved twice. They are computed now.
  // 22.8 min was measured 2026-08-12 at 33 children, against a 2.4-minute full
  // pass — a DATED measurement, kept as one.
  //
  // It is NOT sampled: a gate covering a subset would have to say so, and a
  // control suite audited by sampling is one whose dead members are found by
  // luck.
  SPLNT: {
    when: 'quick',
    why:
      'the DRIVE half spawns ' + (Object.keys(SELF_PLANTS).length + 3) + ' `--quick` children — one per self-plant (' + Object.keys(SELF_PLANTS).length + ') plus THREE clean baselines ' +
      '(an opening pair and a closing one) — and took 22.8 min when it was measured at 33 children on 2026-08-12, against a ' +
      '2.4-min full pass, so it is full-pass-only. The STATIC half still runs under --quick ' +
      'and fails inside the gate; what is given up here is whether each plant still MOVES anything',
  },
};

// ---------------------------------------------------------------------------
// THE §13 SOURCE OFFER — THE TARGETS `legal` HAS ACTUALLY RULED ON.
//
// 🔴 EMPTY IS THE CORRECT CONTENT TODAY, and the emptiness is the whole point.
// Until 2026-08-12 gate AGPL passed on `url !== KNOWN_DEAD` — it awarded a green
// for the link having CHANGED, and its own message said so out loud: "not the
// known-dead link, so a human changed it deliberately". Point the footer at a
// DIFFERENT 404 and the gate went green. That is precisely the outcome the
// gate's own preamble calls worse than what it was catching: "a link that 404s
// is bad; a link that LOOKS compliant and delivers nothing is worse."
//
// So the gate now keys on a DECISION, not on a diff. A target enters this table
// when `legal` has ruled on the Corresponding Source mechanism, and the entry
// must say which ruling and when — the same shape as PENDING_BUDGET and the
// CAD1 baselines, for the same reason: a value nobody wrote a sentence about is
// a number wearing a comment.
//
// ⚠ AND MEMBERSHIP HERE IS NOT SUFFICIENT, ONLY NECESSARY. A ruled target must
// ALSO answer (see the AGPL block's delivery probe). A ruling naming a URL that
// is dead, or that goes dead later, delivers exactly nothing to the user §13 is
// written for, and this lane has already shipped one URL that was true when it
// was written.
//
//   why    — what the mechanism IS, in a sentence a reviewer can disagree with.
//   since  — the date it was ruled.
//   ruling — where the decision is recorded. A path, not a recollection.
const SOURCE_OFFER_RULED = {
  // 🔴 RULED 2026-09-04 BY `legal`, AND THE ROW EXISTED FOR THREE WEEKS BEFORE IT
  // REACHED HERE. The decision was made 2026-08-11 and drafted 2026-08-12; both
  // landed in `legal`'s own inbox and were closed without the row being sent.
  // ⚠ So this gate read COULD NOT RUN on a TRANSMISSION failure, not on an open
  // question — and from inside this lane those are indistinguishable. The empty
  // register was declared void and never reported as a pass, which is the only
  // reason the three weeks cost nothing but time.
  //
  // ⚠ ADDING THIS ROW TURNS `AGPL` FROM PENDING TO RED, ON PURPOSE. The ruled
  // URL is a 404 today (measured by `legal` 2026-09-04, anonymous, github.com ->
  // 200 as control) because the mirror does not exist yet. `legal`, verbatim:
  // *"That red is the ruling working… the red holds the truth that the offer does
  // not yet exist, and it clears the day the mirror answers anonymously. Do not
  // treat it as a regression to suppress."*
  //
  // ⚠ THE RULED TARGET IS THE ROOT **AND EVERY URL WITHIN IT** — per-tag
  // `/tree/<build-tag>` deep links are the SAME mechanism, not new offers. This
  // register is matched by exact string, so the ROOT is keyed here and a tag
  // belongs in link text or beside it, per `legal`'s instruction for that case.
  'https://github.com/2hives-ai/2bee.app-source': {
    why: 'public mirror of software/2bee.app/ only, tagged per release — §13 Corresponding Source by a standard means, without opening the monorepo',
    since: '2026-09-04',
    ruling: 'legal/compliance/2026-09-04-agpl-13-source-offer-mechanism-ruling.md',
  },
};

// Kept as a literal, and kept OUTSIDE the gate block so the validator below can
// see it: CHANGING THE LINK is what must clear this gate, never editing the
// gate. Measured 404 anonymously on 2026-08-10 and again on 2026-08-11, with
// `github.com` -> 200 as the control both times.
const AGPL_KNOWN_DEAD = 'https://github.com/2bee-farm/2bee.slicer';

// ---------------------------------------------------------------------------
// CAD1 / CAD1H BASELINES — the known divergences, named and dated.
//
// 🔴 WHY A BASELINE AT ALL, AND WHY IT IS NOT A NUMBER YOU CAN NUDGE.
//
// `tools/scad_oracle` measures our `web/src/cad/*.ts` against the real
// OpenSCAD 2026.08.07 binary. Today it finds real, named defects on BOTH legs.
// Wiring that as plain pass/fail would ship a gate that is red on the day it
// lands and stays red until three other agents finish work in `web/src/cad/` —
// and SLICER-GATES.md §4 already records what a permanently-red verdict does:
// it stops being read, and then the day a REAL red arrives nobody sees it.
// That reasoning is the reason the verdict is three-valued; it applies here.
//
// So the gate tracks a baseline and fails on GETTING WORSE. The obvious hole in
// that shape is that a stored baseline anyone can raise is not a ratchet, it is
// a suggestion. Five things are done about it, and one is not claimed:
//
//   1. IT IS A NAME, NOT A COUNT (corpus leg). To clear a red you must write
//      `corpus/edge_modifier_root` into this list. A name is legible in review;
//      a digit is not. The hardware leg is a count because `hardware/cad/` is
//      ANOTHER LANE'S TREE where a file may legitimately be renamed or removed
//      — see the blindness that costs, named in the gate's own message.
//   2. EVERY ENTRY CARRIES `why` AND `since`. A missing one is a FATAL, exactly
//      like a PENDING_BUDGET entry naming a gate that does not exist. You
//      cannot add an entry without saying what you have chosen to stop
//      detecting and when you chose it.
//   3. A STALE ENTRY FAILS. If a case in this list stops diverging, the gate
//      goes red until the entry is REMOVED. That is what makes it a ratchet
//      rather than a high-water mark: the list cannot keep silent headroom that
//      would absorb the next regression.
//   4. THE DOCUMENT MUST AGREE. Every corpus entry must appear by name in
//      SLICER-GATES.md, and the hardware count must appear there verbatim as
//      `CAD1H BASELINE: DIVERGES+ERROR = N`. Raising a baseline therefore takes
//      two files, one of which is the document that is read in review, and the
//      gate is red in between. Same coupling GDOC uses on itself.
//   5. THE WHOLE BASELINE IS PRINTED ON EVERY RUN, so it lands inside the
//      transcript this lane's rules require in the commit body of any gate
//      change.
//
// 🔴 WHAT IS **NOT** CLAIMED: none of this stops a lane with write access from
// deliberately raising the baseline. Nothing in a repo can. What it stops is a
// QUIET raise — the one-digit edit that clears a red without anyone reading a
// sentence about it. Same shape as the honest claim about the pre-commit hook
// in root canon: not "no regression can enter", but "no regression enters
// without being named, dated and written down twice".
//
// ⚠ MEASURED OVER AN UNCOMMITTED TREE, AND THE RUN SAYS SO. The oracle imports
// `web/src/cad/*.ts` directly, and on 2026-08-10 that file is a live agent's
// working copy: `scad.ts` had 622 uncommitted insertions adding `color()` as a
// pass-through, which moved the hardware leg from `REFUSED 50 / DIVERGES 3 /
// ERROR 1` (the figures in tools/scad_oracle/README.md, hours old) to
// `REFUSED 25 / DIVERGES 24 / ERROR 5`. So both gates print a digest of the two
// input files they measured. A red that says "baseline measured over cad-src
// X, this run is Y" is a legible red; the same red without it is a mystery.
//
// 🔴 `corpus/edge_modifier_root` WAS THE SIXTH ENTRY AND IS NOT HERE — it was
// removed the same hour it was written, because the RATCHET-DOWN limb went red
// on it unplanted, on this gate's first real run. The `!` root modifier ("only
// that subtree renders", where OpenSCAD emitted the cube and we emitted the
// sphere — the opposite object) was fixed in `web/src/cad/scad.ts` by the live
// agent working there, between the baseline being measured and the gate being
// run. That is a better negative control for limb 3 than the planted one below,
// because nobody arranged it.
const CAD1_KNOWN = {
  // 🔴 `corpus/partial_fa_fs_global` AND `corpus/partial_fa_fs_args` WERE THE
  // FIRST TWO ROWS AND ARE GONE — RATCHETED DOWN 2026-08-11. Both are now
  // `SAME` ("tree and solid both agree"), so limb 3 was red until they were
  // removed, and the removal is a TIGHTENING: the exemption they held is
  // withdrawn, and either case diverging again is now a FRESH divergence that
  // fails this gate by name.
  //
  // ⚠ WHAT WAS CHECKED BEFORE REMOVING THEM, because "it stopped diverging" has
  // three causes and only one of them justifies this edit:
  //   1. NOT a capability loss laundered as agreement. `stale` is computed from
  //      `isBad` (DIVERGES|ERROR), so a case that went DIVERGES -> REFUSED would
  //      also read as stale, and removing it would retire the exemption for a
  //      construct we had stopped implementing. Read at the record instead of
  //      inferred from the summary: both are `SAME`, neither is `REFUSED`.
  //   2. NOT the case file bent until it agreed. Both were touched by
  //      `efb9cefa8d`, so the sources were re-read: each is still bare
  //      `sphere(r=10)` asking for `$fa=5, $fs=0.5` — 5180 triangles against the
  //      840 that a 12/2 default gives, in the assignment form and the argument
  //      form respectively. The discrimination is intact.
  //   3. The stated REASON was checked against the code rather than against the
  //      commit that claimed to fix it. Both rows asserted `mesh.ts` never reads
  //      `$fa`/`$fs`. It does — `fragmentsRequested` derives the count from both
  //      (`360/$fa` and `2πr/$fs`) — and the hard-coded 12/2 the rows described
  //      lived in the HARNESS (`canon.mjs`, with `ours.mjs` re-imposing it), so
  //      the instrument was printing a tessellation our kernel had stopped using
  //      and attributing the difference to the product.
  //
  // ⇒ These were an exemption for a defect on the wrong side of the comparison.
  // The lane that fixed the harness left the entries deliberately — its corpus
  // headers say so, "reported to the lane, not edited here, because `gates/` is
  // another boundary" — and this is that report being actioned. **A stale
  // exemption is not inert: it is standing permission for the real defect to
  // return unnamed**, which is the whole reason limb 3 fails rather than notes.
  'corpus/partial_rotate_axis_angle': {
    since: '2026-08-10',
    why: '`rotate(45,[1,1,0])` is refused by name and the subtree is kept UNROTATED. Volume and area match to 1.6e-16; only the tree and the bounding box (10mm out) catch it',
  },
  'corpus/fn_clamped': {
    since: '2026-08-10',
    why: '`$fn = 400` against mesh.ts MAX_FN = 256. Tree agrees (it carries 400), solid is 5.93e-5 light — the smallest real defect in the corpus and the reason REL_TOL is not at 1e-4',
  },
  // 🔴 2026-08-22 — TWO ENTRIES ADDED, and both are TRUE kernel diverges
  // surfaced by fixing the INSTRUMENT, not new breakage: the 08-19→21 feature
  // series implemented ten previously-refused constructs without teaching the
  // oracle's serializer, so canon.mjs dropped the new GroupNode flags and
  // crashed on the three new primitives, and these ten cases reported
  // DIVERGES/ERROR about the harness. With the serializer taught (canon.mjs
  // `sceneToCanon` group-flag arms + polygon/polyhedron/text primitives,
  // measured against openscad 2026.08.07), eight of the ten closed honestly —
  // six SAME, hull/minkowski PENDING on the kernel's own audit (broken meshes,
  // not greens) — and these two remained red for real reasons:
  //
  // ⚠ `corpus/refuse_rotate_extrude` LEFT this list 2026-08-27 — FIXED, not
  // tolerated: scad.ts carries `$fn` on `GroupNode.rotateExtrude` (same
  // semantics as `Facets.fn`), mesh.ts revolves at that count, and closing the
  // loop surfaced TWO deeper kernel defects the open mesh had been hiding —
  // the revolution of an implicitly-closed outline was missing its last→first
  // strip (audit: open), and once closed the whole surface measured INWARD
  // (volume −1720.1166 vs +1720.1165; both body strips and both caps were
  // wound to the axis). All three fixed together; the case reads SAME, tree
  // and solid. A return to this list would be a FRESH divergence.
  'corpus/refuse_polyhedron': {
    since: '2026-08-22',
    why: 'the corpus file winds its faces INWARD; OpenSCAD exports verbatim (signed volume -266.67), our kernel re-orients outward (+266.67). Area, bbox, centroid identical — only orientation differs, and only the signed volume catches it. Which side is wrong is a real question (outward is the sane winding; verbatim is the OpenSCAD contract this gate measures against), and until the kernel chooses, the divergence is named rather than laundered into SAME',
  },
  // 🔴 `corpus/refuse_color` WAS THE FIFTH ENTRY AND IS GONE — it was the HARNESS,
  // and the entry said so while declining to check. Removed 2026-08-11 after the
  // question was put to the binary instead of to either implementation:
  // `openscad 2026.08.07` exports BYTE-IDENTICAL ASCII STL for `color("red")
  // cube(3);` and `cube(3);`, for a `color()`-wrapped difference MINUEND, and at
  // `alpha = 0`; with several children it behaves as a group; empty, it emits no
  // geometry. So `color()` is a container in OpenSCAD's own semantics, and
  // `canon.mjs` mapping it to an OPAQUE node was the harness reporting its own
  // vocabulary. `canon.mjs` now maps it (and `render()`, the same defect one
  // module along) to a union. The case is renamed `corpus/passthrough_color` and
  // is one of SIX that pin the behaviour, and the RATCHET-DOWN limb below is what
  // forces this entry out rather than leaving it as silent headroom.
  //
  // ⚠ FOUR MORE `refuse_*` CASES WERE STALE FOR THE SAME REASON and only this one
  // had been noticed: `refuse_children`, `refuse_function_def`, `refuse_let` and
  // `refuse_modifier_highlight` all read SAME with zero refusals. They never
  // reached this list because they stopped diverging rather than started, so the
  // ratchet had nothing to catch — a stale CASE NAME is invisible to a gate that
  // only scores failures. They are renamed to what they now test.
};

// The hardware leg. A COUNT, not a name list — and the blindness that buys is
// stated in the gate message rather than left to be discovered: one file fixed
// and another broken, at equal count, is invisible here. The corpus leg is
// name-exact because the corpus is this lane's own fixed set; `hardware/cad/`
// is not, and a name list over another lane's tree would go red on a RENAME,
// which is not a regression and would train exactly the "just edit the list"
// habit points 1-5 above exist to prevent.
/**
 * The STRICTER refusals on the hardware leg that are ACCOUNTED FOR — by name,
 * with the construct that causes each and the date it was pinned.
 *
 * 🔴 THIS IS THE OPPOSITE OF A BLANKET ENTRY, AND THE DIFFERENCE IS THE POINT.
 * ceo ruling 2026-09-02: *"pin the 14 as a NAMED, COUNTED set, and make CAD1H
 * distinguish 'the known 14' from 'a new STRICTER-ledger finding'. Otherwise
 * the 14 mask the 15th."* A red that persists becomes furniture exactly like a
 * report does — and a gate that is red for a known reason cannot tell you about
 * an unknown one.
 *
 * Two rules, both enforced below and both directions:
 *   · a hardware `fresh` name NOT in this list is a LOUD failure — a capability
 *     the binary has and we do not, with nobody's name on it.
 *   · a name in this list that is NO LONGER STRICTER must be REMOVED. The count
 *     may only go DOWN. Headroom a ledger has stopped needing is the slack that
 *     absorbs the next gap.
 *
 * ⚠ WHY THEY EXIST AT ALL: these appeared when `CAD1H`'s scan became recursive
 * on 2026-09-02 and its ours-side gained a library host. They are not new
 * defects — they are the same capability gaps, on files that were never looked
 * at. `STRICTER` means WE REFUSE AND OPENSCAD EMITS: nothing wrong is drawn, so
 * none of these can produce a wrong part; what they cost is a part we cannot
 * make at all.
 *
 * ⚠ AND THEN BY 1 AGAIN, FOR A REASON THAT IS NOT OURS. `pnp_drum_housing_3d`
 * left the set hours later: `cad`'s COAXIAL ruling changed the file and it now
 * ERRORS on `variable D_MOTOR_CLOCK is not defined` — a variable that IS
 * defined, in an `include`d params file, where OpenSCAD renders NoError.
 * ⚠ OPEN, AND NOT THE TRAILING SEMICOLON: `include <p.scad>;` resolves
 * correctly in isolation (measured). So this file left STRICTER for a
 * DIFFERENT defect of ours rather than for a fix — the ratchet moved down
 * and our capability did not.
 *
 * ⚠ IT SHRANK BY 1, NOT 2, WHEN `mirror()` LANDED (2026-09-02). Both
 * `2bee_pnp` rows were annotated 'expected to clear'; only `pnp_drum_drive`
 * did. `pnp_drum_housing_3d` had a kernel `difference()` refusal standing
 * BEHIND the mirror() one, and removing the first exposed the second. The
 * ratchet did exactly what it was written for: it forced this list to be
 * edited, and the edit is where the wrong prediction was found.
 */
const CAD1H_STRICTER_KNOWN = [
  { file: 'hardware/2bee_entrance/2bee_entrance_top_panel_3d.scad', cause: 'difference() [kernel]', since: '2026-09-02' },
  { file: 'hardware/2bee_feeder/feeder_half_3d.scad', cause: 'union() [kernel]', since: '2026-09-02' },
  { file: 'hardware/2bee_feeder/feeder_molded.scad', cause: 'union() [kernel]', since: '2026-09-02' },
  { file: 'hardware/2bee_hive/2bee_hive_panels_18mm.scad', cause: 'use <> of the brood/super panel cut files, which refuse first', since: '2026-09-02' },
  { file: 'hardware/2bee_hive/side_hive.scad', cause: 'linear_extrude(twist/scale) + for(c=...) in list comprehension', since: '2026-09-02' },
  { file: 'hardware/2bee_honey_tank/collection_lid.scad', cause: 'union() [kernel] + text() [kernel]', since: '2026-09-02' },
  { file: 'hardware/2bee_honey_tank/strainer_basket.scad', cause: 'difference() [kernel]', since: '2026-09-02' },
  { file: 'hardware/2bee_schools_kit/schools_kit_box_3d.scad', cause: 'difference() [kernel]', since: '2026-09-02' },
  { file: 'hardware/2bee_schools_kit/schools_kit_cover_3d.scad', cause: 'union() + difference() [kernel]', since: '2026-09-02' },
  { file: 'hardware/2bee_schools_kit/schools_kit_enclosure_3d.scad', cause: 'union() [kernel]', since: '2026-09-02' },
  { file: 'hardware/2bee_schools_kit/schools_kit_floor_3d.scad', cause: 'difference() + union() [kernel]', since: '2026-09-02' },
  { file: 'hardware/2bee_schools_kit/schools_kit_solar_3d.scad', cause: 'union() [kernel]', since: '2026-09-02' },
];

/**
 * 🔴 POPULATION FLOORS FOR THE TWO REGISTRIES THAT AUDIT EVERY OTHER CONTROL.
 *
 * `PLANT` and `SPLNT` are both shaped `if (problems.length) fail() else pass()`.
 * With an EMPTY registry `problems` is empty, so `SPLNT` prints *"All 0
 * self-plant(s) have a contract"* and PASSES — the two gates whose entire job is
 * auditing the other controls reporting success over nothing.
 *
 * ⚠ THIS LANE HAD ALREADY WRITTEN THE NEIGHBOURING SENTENCE AND MISSED THIS ONE.
 * `SPLNT`'s own description says *"a control whose branch was refactored away
 * APPLIES, REPORTS SUCCESS AND REDDENS NOTHING"*. That is about ONE dead
 * control. Nobody asked what happens when the LIST is empty, which is the same
 * failure at full scale. Found 2026-09-04 by applying ceo's generalisation of
 * `backend`'s find — *a guard over an empty population is indistinguishable from
 * a working one* — to this file's own registers.
 *
 * 🔴 A FLOOR, NOT A NON-ZERO TEST. `length > 0` passes at ONE plant, which is
 * not the property wanted: the risk is controls quietly disappearing, not the
 * registry being emptied in a single stroke. A pinned count that must not shrink
 * makes retiring a control cost an edit that is read in review — the same shape
 * as the two CAD1H baselines, and for the same reason.
 *
 * ⚠ RAISING THESE IS FREE AND LOWERING THEM IS A DECISION. If you retire a
 * control, lower the number here IN THE SAME COMMIT that removes it, and say in
 * the message which control went and why it is no longer needed.
 */
const REGISTRY_FLOOR = { PLANT: 21, SPLNT: 42 };

const CAD1H_BASELINE = {
  max: 72,
  since: '2026-09-04',
  input: 'cad-tree@e856a01710af (extracted, not the working tree)',
  // 🔴 THE BARE HASH, BECAUSE THE PROSE ABOVE IS AN ANNOTATION AND NOTHING READ
  // IT. Found 2026-09-04 by parking the caches for ceo's fresh-checkout run: the
  // gate extracts CURRENT HEAD's `hardware/cad` tree, this pair was measured
  // against `e856a01710af`, and `cad` had already committed — so the ratchet was
  // comparing numbers taken from two different inputs with nothing saying so.
  // ⚠ Same shape as `readerSha`, one level over: I built the control for the
  // READER and left the INPUT as a sentence.
  // Re-pinned 2026-09-04 to the tree the numbers were LAST reproduced on. ⚠ And
  // the reproduction is the point: 61 and 129/303 were derived on
  // cad-tree@e856a01710af and came back IDENTICAL on cad-tree@bcad6ec592bc after
  // `cad` had committed — same 7 audit-not-closed files too. ⇒ Evidence the pair
  // measures OUR READER rather than their models, which is what a baseline on
  // this leg is supposed to be.
  inputTree: '88cc2346fb97',
  why:
    '72 DIVERGES+ERROR of 318 hardware files at cad-tree@88cc2346fb97. \ud83d\udd34 RAISED, and raising is a ' +
    'DECISION \u2014 so here is the attribution rather than the number: 59 + 11 (of 14 files `cad` ADDED) + 2 ' +
    '(pre-existing, REGRESSED) - 0 (improved) = 72, measured file-by-file against the previous run rather than ' +
    'inferred from the totals. \u26a0 THE 2 ARE A REAL WORSENING AND ARE NOT HIDDEN IN THE 11: ' +
    'probe_upright_contact and probe_spindle_clear went STRICTER -> DIVERGES when the offset() fix landed, i.e. ' +
    'they stopped REFUSING and started EMITTING something OpenSCAD disagrees with. A refusal emits nothing; a ' +
    'divergence emits a part a machine would cut. \u21d2 THE OFFSET FIX WAS NOT FREE: it cleared both _wcnc cut ' +
    'files out of the undecidable class and cost these two their refusal. PRIOR value: ' +
    '59 DIVERGES+ERROR of 303 hardware files \u2014 UP from 55, and the direction is the honest one. The ' +
    '`offset()` self-intersecting-outline fix made FOUR files MEASURABLE that were undecidable: both ' +
    '2bee_hive_{brood,super}_panel_wcnc (CUT FILES), lib/serial_qr.scad and luckfox_pico_zero.scad all moved ' +
    'PENDING -> DIVERGES. \ud83d\udd34 THEY DID NOT BECOME AGREEMENTS. They became VISIBLE disagreements, and on ' +
    'the two cut files that is a real divergence that was previously hidden behind "we cannot tell". ' +
    '\ud83d\udfe2 audit-not-closed 6 -> 3, and NO CUT FILE REMAINS IN IT. PRIOR value: ' +
    '55 DIVERGES+ERROR of 303 hardware files \u2014 ratcheted DOWN from 58 by fixing rotate_extrude the same way ' +
    'linear_extrude was fixed. \u26a0 ALL THREE MOVES WERE DIVERGES -> REFUSAL, NOT DIVERGES -> AGREEMENT: two ' +
    'probe_upright files went STRICTER (ledgered) and probe_wheel_seat went REFUSED-BOTH, where openscad also ' +
    'produces nothing. \u21d2 A count that fell because we stopped EMITTING is not the same as one that fell ' +
    'because we started AGREEING, and only the second is capability. PRIOR value: ' +
    '58 DIVERGES+ERROR of 303 hardware files \u2014 ratcheted DOWN from 61 by the linear_extrude local-frame fix ' +
    '(rotated extrusions were extruded along WORLD Z). \ud83d\udfe2 THE HEADLINE IS NOT THE NUMBER: ' +
    '2bee_hive_box_panel_wcnc.scad went PENDING -> SAME \u2014 a CUT FILE that we could not decide at all now ' +
    'AGREES with OpenSCAD. Also key.scad DIVERGES -> SAME. \u26a0 And two moved the other way and are not hidden: ' +
    'feeder.scad PENDING -> DIVERGES (it became MEASURABLE and then disagreed, which is the honest direction) and ' +
    'lib/serial_qr.scad DIVERGES -> PENDING (we stopped being able to tell \u2014 a real loss, tracked). ' +
    'PRIOR value: 61 DIVERGES+ERROR of 303 hardware files. \ud83d\udd34 IT WENT UP BY ONE AND THAT IS A COVERAGE GAIN, NOT A ' +
    'REGRESSION \u2014 read the transition, not the number. pnp_drum_3d.scad was PENDING because the harness ' +
    'could not ingest its CSG at all, so it was compared on NOTHING: no mesh leg AND no tree leg. The ' +
    '`normalise` spread-push fix made it decidable, and the first thing the comparison said was that OUR ' +
    'evaluator errors on it (lib/involute_gears.scad line 466). \u21d2 A FILE ENTERED THE TRACKED COUNT BY ' +
    'BECOMING MEASURABLE. This ledger has recorded the mirror of this three times \u2014 files LEAVING the count ' +
    'by becoming undecidable, which looks like progress and is not \u2014 and this is the same trade in the ' +
    'honest direction. PRIOR value: ' +
    '60 DIVERGES+ERROR of 303 hardware files AT HEAD@dbb53024e5c5 \u2014 the first baseline on this leg measured ' +
    'against a COMMIT rather than the shared working tree. \u26a0 THE NUMBER MOVED 59 -> 60 WITHOUT ANY CHANGE TO ' +
    'OUR READER, and that is the whole reason the input is pinned: 8 commits landed in hardware/cad in the hour ' +
    'between the two measurements, one of them adding the 2bee_autoframe_automation family, which the full pass ' +
    'named. \u21d2 A BASELINE PINNED AGAINST A LIVE SHARED TREE IS NOT A BASELINE. ceo 2026-09-06: annotate each ' +
    'baseline with the input it was measured against, or a re-pin is byte-for-byte indistinguishable from a ' +
    'regression. PRIOR value, and read the transition rather than the number: ' +
    '59 DIVERGES+ERROR of 304 live hardware files — ratcheted DOWN from 69 by the RATCHET-DOWN LIMB ITSELF, which ' +
    'failed the first full pass since 2026-09-02: *"only 59 files diverge and the baseline still allows 69. Lower ' +
    'it — or the slack sits there to absorb the next regression in silence."* \u26a0 I HAD RECOMMENDED TO ceo THAT ' +
    'THIS LEG STAY AT 69 on the grounds that 59 left "real slack", and ceo agreed. THE RECOMMENDATION WAS WRONG and ' +
    'the gate is right: unused slack on a ratchet is not headroom, it is the exact margin a future regression ' +
    'disappears into. Lowering is a TIGHTENING and needs no ruling; only raising does. ' +
    '\u26a0 MEASURED TWICE, INDEPENDENTLY, BOTH 59: the oracle driven directly (--hardware, 304 hardware cases) ' +
    'and this gate driving it, on the same tree — which is also the cross-check that the JSON this gate reads is ' +
    'the run it thinks it read. ' +
    'PRIOR why, kept because the transitions matter more than the number: ' +
    '69 DIVERGES+ERROR of 293 LIVE hardware files (296 minus three `_`-prefixed scratch files, excluded by ceo ruling 2026-09-02 and printed with their reason). Was 70 of 296. ' +
    '70 DIVERGES+ERROR of 296 LIVE hardware files — ratcheted DOWN from 79 on 2026-09-02 by mirror(), the negative-determinant winding fix, and a canon serialiser that had been DROPPING multmatrix. \u26a0 READ THE TRANSITIONS BEFORE READING THE NUMBER: 9 files went DIVERGES -> PENDING and only ONE went DIVERGES -> SAME. Nine left the tracked count by becoming UNDECIDABLE, not by agreeing — seven on the ruled top-level-overlap class, and two (2bee_hive_brood_panel_wcnc, 2bee_hive_super_panel_wcnc, both CUT FILES) because our kernel audits their solids as OPEN, which it did BEFORE this change too and the tree divergence was masking. This is the same shape this ledger recorded at 31 -> 16 and 10 -> 7: files leaving the count without becoming agreements. \u21d2 THE COUNT IMPROVED BY 9 AND OUR CAPABILITY IMPROVED BY 1. \u26a0 I PREDICTED THIS WOULD GO UP AND IT WENT DOWN — logged in advance with ceo, wrong for a reason worth keeping: I expected mirror() to convert unmeasured refusals into measured divergences (as str() did), and instead the canon fix retired nine tree-leg divergences that were the INSTRUMENT, not the kernel. ' +
    '79 DIVERGES+ERROR of 296 LIVE hardware files — the first honestly measured population. \u26a0 IT WAS 80 FOR ABOUT AN HOUR AND CAD MOVED IT, NOT US: between the measuring run and the gate run, `cad` deleted six pnp scratch files (_ab*.scad, _root.scad — commits eb5fd56604..0f643fa769), one of which was an ERROR case, and the count fell by one with nothing in web/src/cad changing. \u21d2 THIS BASELINE IS A STRICT-EQUALITY RATCHET OVER ANOTHER LANE\'S TREE: every cad commit that adds or removes a diverging file reddens this gate, and the fix is to re-measure and move the number, NOT to widen the rule. The population is theirs; only the reader is ours. 🔴 7 AND 80 ARE NOT COMPARABLE AND THIS IS NOT A 10x REGRESSION. The 7 was the divergence count of `lib/` with imports UNRESOLVED: the hardware leg collected files non-recursively (6 top-level + 79 lib/ = 85 of a 584-file tree, ZERO from any product directory and ZERO of the 18 _wcnc cut files, all of which live in subdirectories) and parsed every one with `parseScad(src)` and no host, so any file carrying `use`/`include` refused everything, emitted nothing, and scored STRICTER — the harness\'s word for \'we safely refuse where OpenSCAD emits\'. Recorded as safety; it was a missing library. The two defects were self-consistent, the set being 93% lib/ leaf files, which is the exact subset a no-host parse handles. 80 is 296 live files honestly measured for the FIRST time. ⚠ ANYONE READING THIS AS A REGRESSION WILL \'FIX\' IT BY NARROWING THE POPULATION, WHICH IS HOW IT REACHED 6 FILES BEFORE. The repair was two changes that had to land together (`b7c981f7cd`): the hardware collector is now RECURSIVE, and `runOurs` parses through `makeLibraryHost` over the case root with the case PATH, because `parseScad` resolves every spec against the importing file\'s directory. Proof on the file that exposed it — 2bee_hive_fan_box_panel_wcnc: before, 12 use<> refusals / 0 primitives / STRICTER; after, 0 refusals / 98 triangles / DIVERGES, with the cause NAMED (openscad offset(r=3,$fn=32) vs ours $fn=0 — a dropped $fn on offset(), the same class this ledger already closed for rotate_extrude and linear_extrude, sitting one construct away and scored as safety). ⚠ THE COUNT THEN ROSE 73 -> 80 UNDER str() AND STRING INDEXING (`4afac25606`) AND THAT IS THE GATE BECOMING HONEST, NOT THE CODE GETTING WORSE: every transition is OUT of STRICTER (3 -> ERROR, 3 -> DIVERGES, 1 REFUSED-BOTH -> SAME). Removing a refusal converts UNMEASURED into MEASURED-AND-WRONG — this ledger\'s own REFUSED->DIVERGES rule, arriving one step earlier. Remaining causes, ranked: mirror() 23, text() [kernel] 23, difference() [kernel] 13, modifier % 10. Runtime 5m54s full / 16s --cut-only. ' +
    '7 DIVERGES+ERROR of 72 real hive models — ratcheted DOWN from 10 on 2026-08-27, and the move is the KERNEL this time: scad.ts now carries `$fn` (and `start`) on rotate_extrude and `$fn` on linear_extrude, which closed the tree gaps holding electret_capsule_9_7mm and fan_axial red (both now PENDING on the ruled overlap class, not SAME — unioning is still the deferred founder decision), and the corpus rotate_extrude case read SAME outright once the revolution also gained its closing strip and outward winding (two defects the open mesh had hidden: a missing last→first strip; an inward-wound surface at volume −1720.1166 vs +1720.1165). linear_extrude(twist/scale) is now REFUSED rather than silently ignored — a source that asks for a sweep gets nothing, by name, instead of a straight part that posts clean. 🔴 UNDECIDED rose 42 -> 45 in the same step: three files left the tracked count and ZERO became agreements — decidable-nowhere, not fixed. ' +
    '10 DIVERGES+ERROR of 72 real hive models — ratcheted DOWN from 16, and the move is again the INSTRUMENT plus the TREE, not the kernel. Two causes, both dated 2026-08-22: (1) the oracle serializer learned the ten constructs the 08-19→21 feature series implemented (canon.mjs sceneToCanon group-flag arms + polygon/polyhedron/text primitives), so 8 hardware files that reported ERROR ("unknown primitive" — the harness throwing, not the kernel) now measure for real: 3 became PENDING (top-level overlap, undecidable by design), 2 became DIVERGES with TRUE causes (battery_lifepo4 area rel 4.5e-3; electret/fan_axial the dropped-$fn tree gap), 1 stayed DIVERGES, and the net tracked count fell; (2) cad deleted the 12 untracked `_*.scad` scratch slices that had entered the scan set on 08-17 (ticket 2026-08-22-2bee_app-underscore-scratch-scad-files-redden-cad1h), restoring the 72-file set. The kernel-side remainder is real and named: the corpus leg of the same fix left corpus/refuse_rotate_extrude red on a dropped `$fn` and corpus/refuse_polyhedron red on winding, and hull/minkowski sit PENDING on the kernel\'s own audit with BROKEN meshes (minkowski: 2 triangles against OpenSCAD\'s 188). ' +
    '16 DIVERGES+ERROR of 73 real hive models — down from a MEASURED 31, against a baseline of 29 — and the move is the INSTRUMENT being fixed, not the kernel: a 2026-08-14 triage (fresh oracle JSON, every row re-read) partitioned 15 of the 31 as measurement artefacts in the oracle, in three classes, and all three fixes are on the harness side (tools/scad_oracle) with NOTHING touched in web/src/cad. TEN (buck_converter, ds3231_rtc, imx219_camera, mosfet_module, mppt_controller, pcf8574_gpio, skr_pro_v12, sma_adapter, sma_antenna, langstroth_frame) were touching top-level solids: tree same, volume to <=5e-8 rel, bbox and centroid fine, ONLY area ours-high, because the harness summed per-solid areas while OpenSCAD\'s STL is the CGAL union that deletes coincident contact faces — they are now PENDING with AREA undecidable and volume/bbox/centroid still compared. TWO (fan_40mm, vent_fan) were the oracle\'s .csg matrices being pre-rounded to six significant figures and composed by `normalise` while our side composes full doubles — a 1e-6 rounding straddle read by an exact-string compare as "trees differ"; the tree compare is now numeric at rel 1e-5 (canon.mjs `serialiseEq`, tight enough that corpus/fn_clamped and the quadrant epsilon still fail), and both files land PENDING on the overlap class their meshes were already in. THREE (honey_tank_sensor, ov5640_camera, inwall_cover_box) reference `$preview`: the oracle\'s csg leg runs $preview=true and its stl leg $preview=false, so the oracle\'s OWN two legs disagree there and no comparison is meaningful — PENDING-by-construction, with the kernel\'s $preview=true choice untouched (a deferred product decision). 🔴 UNDECIDED rose 23 -> 38 in the same step, and the warning the previous `why` (baseline 29, 2026-08-11, the rotationMatrixDegrees ratchet) recorded APPLIES TO THIS MOVE TOO: 15 files left the tracked count and ZERO became agreements — they became decidable-nowhere, so more than half the hardware leg is now a class this gate cannot decide. It is still the right move: the 15 were never kernel defects, and a red that names innocent files trains the reader to discount the guilty ones. The residual 16 are all tree-leg divergences (refusals taking subtrees, hull/linear_extrude and the rest) — real work, not artefacts. ⚠ The UNDECIDED limb that failed this gate on ANY hardware PENDING now carries the three ruled classes by name — see CAD1H_UNDECIDED_KNOWN below — and still fails on any PENDING whose reason is none of them.',
};

// THE NAMED UNDECIDABLE CLASSES — the CAD1H counterpart of the STRICTER
// ledger, added 2026-08-14 when the instrument fix above moved 15 files from
// DIVERGES to PENDING and the gate's own UNDECIDED limb stood between the
// measured baseline and a green.
//
// 🔴 WHY THE LIMB CHANGED AT ALL. Until today ANY hardware PENDING that was
// not a missing binary failed CAD1H — "a check that cannot run is not a
// pass". That was written when PENDING meant "a check that BROKE". The three
// classes below are not broken checks: each is a comparison that has NO
// REFERENT, measured as such, with the cause named and the decision to leave
// it undecidable taken out loud (the founder's 2026-08-14 DEFER ruling on
// unioning covers the first two; the third is the oracle straddling its own
// F5/F6 legs). Failing the gate on them forever is the permanently-red
// verdict §4 warns about — it stops being read. So the limb now fails on any
// PENDING whose reason is NONE of these, which is the half that was always
// the point, and carries these by name so the green cannot read as coverage.
//
// ⚠ THE MATCH IS A SUBSTRING OF THE ORACLE'S REASON STRING, and that fails
// SAFE: reword the reason in tools/scad_oracle and the class becomes
// unlisted, which is a RED here, never a silent green. A class that stops
// occurring prints a warning and fails nothing — hardware/cad/ is another
// lane's tree, same one-directional scoring as the STRICTER ledger's
// hardware entries.
/**
 * 🔴 THE SECOND RATCHET, AND IT EXISTS BECAUSE THE FIRST ONE IS GAMEABLE.
 *
 * ceo ruling 2026-09-02: *"a ratchet on `DIVERGES+ERROR` alone rewards
 * converting a file into 'undecidable'."* Today's move is the proof and it went
 * in our favour by accident: 79 -> 70 looks like a 12% capability gain and was a
 * ONE-file capability gain — 9 of the 10 files that left the tracked count did
 * so by becoming PENDING, not by agreeing.
 *
 * So `PENDING` is ratcheted too. A file moving `DIVERGES -> PENDING` now breaks
 * THIS number, which is correct: we did not get better, we stopped being able to
 * tell. The ledger already said that in words, and ceo's answer is the reason
 * this constant exists — **words do not ratchet.**
 *
 * ⚠ RAISING IT IS A DECISION, exactly like the other baseline: it takes an edit
 * here AND in `SLICER-GATES.md`, and the `why` must say which files became
 * undecidable and on what class.
 */
/**
 * 🔴 A COUNT AND ITS POPULATION, NOT A BARE COUNT — ceo ruling 2026-09-05:
 * *"a bare bound is a number reported without its instrument."* A bare `max`
 * cannot tell a RATE increase from population growth, so adding files silently
 * buys headroom and a real regression hides inside the growth.
 *
 * 🔴 AND THE OLD PAIR DID NOT REPRODUCE, WHICH IS THE PART TO READ. `113 of 293`
 * was pinned at commit `f8c71ddaa1` (2026-09-02 11:52). Re-measured 2026-09-04
 * against that EXACT commit in a `git worktree`, with today's reader:
 * **122 of 291.** Same models, same exclusions (diffed, identical) — nine files
 * more, two files fewer.
 *
 * ⇒ ***The difference is OUR OWN READER, not `cad`'s models.*** Between the pin
 * and now this lane shipped `mirror()`, the negative-determinant winding fix, a
 * canon serialiser that had been dropping `multmatrix`, `str()`, `each`, string
 * indexing, `text()` `$fn` and a CSG read cap. Every one legitimately moves
 * verdicts, and the constant was never re-derived after any of them — so it kept
 * its authority while measuring an instrument that had changed underneath it.
 *
 * ⚠ SO THE DENOMINATOR IS NECESSARY AND NOT SUFFICIENT. `count / population`
 * stops population growth moving the bound; it does NOT stop a reader change
 * moving it, and this pair is only comparable against a run of the SAME reader.
 * `readerNote` records which one, so a future mismatch is visible rather than
 * inferred. RECOMMENDED TO ceo, not decided here: re-derive on any commit that
 * changes `scad.ts`/`mesh.ts`/`canon.mjs`, the way a calibration is re-taken
 * after the instrument is serviced.
 *
 * ATTRIBUTION of 122 -> 131, measured file by file rather than by subtraction:
 * only TWO files present in both runs changed verdict at all —
 * `pnp_drive_drum_assembly` ERROR -> PENDING (its CSG crossed the new 64 MB cap)
 * and `pnp_drum_housing_3d` STRICTER -> DIVERGES. The other +8 are 8 of the 14
 * files `cad` added since the pin. Nothing unexplained remains on this leg.
 */
const CAD1H_PENDING_BASELINE = {
  count: 126,
  population: 318,
  input: 'cad-tree@e856a01710af (extracted, not the working tree)',
  // 🔴 THE BARE HASH, BECAUSE THE PROSE ABOVE IS AN ANNOTATION AND NOTHING READ
  // IT. Found 2026-09-04 by parking the caches for ceo's fresh-checkout run: the
  // gate extracts CURRENT HEAD's `hardware/cad` tree, this pair was measured
  // against `e856a01710af`, and `cad` had already committed — so the ratchet was
  // comparing numbers taken from two different inputs with nothing saying so.
  // ⚠ Same shape as `readerSha`, one level over: I built the control for the
  // READER and left the INPUT as a sentence.
  // Re-pinned 2026-09-04 to the tree the numbers were LAST reproduced on. ⚠ And
  // the reproduction is the point: 61 and 129/303 were derived on
  // cad-tree@e856a01710af and came back IDENTICAL on cad-tree@bcad6ec592bc after
  // `cad` had committed — same 7 audit-not-closed files too. ⇒ Evidence the pair
  // measures OUR READER rather than their models, which is what a baseline on
  // this leg is supposed to be.
  inputTree: '88cc2346fb97',
  readerNote: 'scad.ts+mesh.ts+canon.mjs as of 2026-09-04 (CSG cap, budget tick, canon multmatrix, mirror/winding)',
  // 🔴 THE INSTRUMENT THIS PAIR WAS MEASURED WITH, as the same sha256-over-
  // CAD_SRC_FILES digest every CAD1/CAD1H message already prints.
  //
  // ceo canon 2026-09-06: *"a ratchet compares two measurements taken with
  // DIFFERENT INSTRUMENTS unless you re-measure the baseline with the current
  // one. The denominator rule catches a POPULATION that moved. It does not catch
  // an INSTRUMENT that moved — and the second is invisible in the same way,
  // while looking like a regression in the subject."*
  //
  // ⚠ IT DOES NOT SUPPRESS THE RATCHET, deliberately. A reader change is not a
  // licence to stop enforcing — a real regression could hide behind "the
  // instrument moved". It changes what a FAILURE IS ALLOWED TO CLAIM: with a
  // different digest the gate may no longer say the subject got worse, only that
  // the two numbers are not comparable and the baseline needs re-deriving.
  // That is the distinction that cost ceo two wrong decompositions and me one
  // file-hunt for eight files that did not exist.
  // Moved 2026-09-04 when `canon.mjs` gained the spread-push fix. The digest
  // changing is the mechanism working: a reader change invalidates the pair.
  // Moved again 2026-09-04 with the linear_extrude local-frame fix in mesh.ts.
  // Moved 2026-09-04 when `library.ts` entered the digest — the value changing is
  // the ONLY visible sign that the previous pin had been blind to a reader file.
  readerSha: 'da2a3d44a5c7',
  since: '2026-09-02',
  why:
    '113 PENDING of 293 live hardware files — the `_`-prefixed scratch exclusion landed and took the two _mtest files (and one more) out of the count, which is the CLASS fix rather than the instance. ' +
    '115 PENDING of 298 live hardware files, pinned the day the second ratchet was added. \u26a0 IT WAS 113 OF 296 WHEN MEASURED 40 MINUTES EARLIER: `cad` added two `_`-prefixed scratch files (export/school-cnc-hive/tierA-1to5/_mtest.scad, _mtest2.scad), both PENDING, and D+E did not move. \ud83d\udd34 THIS IS THE SECOND OCCURRENCE OF A KNOWN PROBLEM: handover 2026-08-22-2bee_app-underscore-scratch-scad-files-redden-cad1h raised it when 12 such files entered the scan set, and it was closed by `cad` DELETING them — which fixes the instance and not the class. Three live `_*.scad` files exist today. \u21d2 RECOMMENDED TO ceo, NOT DONE HERE because population is their ruling: exclude `_`-prefixed scratch files the way `archive/` is excluded, stated and counted. Until then this number tracks another lane\'s scratch directory. ' +
    '113 PENDING of 296 live hardware files, pinned the day the second ratchet was added. It rose 104 -> 113 in ' +
    'the mirror()/winding/canon step: NINE files went DIVERGES -> PENDING while only ONE went DIVERGES -> SAME. ' +
    'Seven are the ruled top-level-overlap class; two are 2bee_hive_brood_panel_wcnc and ' +
    '2bee_hive_super_panel_wcnc — CUT FILES — whose solids our kernel audits as OPEN, which it did BEFORE that ' +
    'change too (re-measured against the pre-fix mesher: identical `open`), so the tree divergence had been ' +
    'masking an older mesh defect. ⚠ MORE THAN A THIRD OF THIS LEG IS NOW A CLASS THE GATE CANNOT DECIDE, and ' +
    'the direction that matters is DOWN: every file that leaves PENDING for SAME is a real gain, and every one ' +
    'that arrives is a thing we stopped being able to check.',
};

/**
 * The bound this population is allowed, from the pinned RATE.
 *
 * ⚠ `Math.floor` deliberately: it rounds in the direction that makes the gate
 * STRICTER as the population grows, so growth can never buy a whole extra file
 * of headroom by rounding.
 */
const cad1hPendingAllowed = (population) => {
  // 🔴 INTEGER CROSS-MULTIPLICATION, NOT `(count / pop) * pop`. Dividing first
  // loses exactness: at EQUILIBRIUM — the same population it was pinned at —
  // `Math.floor((125 / 304) * 304)` is **124**, not 125, because 125/304 is not
  // representable and the product lands a hair below. ⇒ The ratchet-down limb
  // would fire on a tree that had not moved at all: a FALSE RED at the one state
  // the ratchet spends most of its life in.
  //
  // ⚠ Found 2026-09-05 by arithmetic while re-pinning, NOT by a run — and it
  // would have been read as "the count fell, lower the baseline", which is a
  // fix that makes the next real regression invisible.
  const base = Math.floor((CAD1H_PENDING_BASELINE.count * population) / CAD1H_PENDING_BASELINE.population);
  // The two negative controls for this ratchet. See SELF_PLANTS.
  if (selfPlanted('cad1h-pending-slack')) return base + 1;
  if (selfPlanted('cad1h-pending-tight')) return base - 1;
  return base;
};

/**
 * CNC CUT FILES THAT ARE UNDECIDABLE, BY NAME.
 *
 * 🔴 ceo ruling 2026-09-02: *"name those two in the pinned set with the
 * mesh-open cause, so they are a tracked defect rather than two rows inside a
 * PENDING total."* Named here rather than counted there, because a cut file is
 * the population where being unable to tell has a physical tail.
 *
 * ⚠ THE RULING SAID TWO AND THE MEASUREMENT SAYS FIVE. Three were already
 * PENDING before today and were not visible in the number ceo was given: the
 * two `$preview` straddles, and `2bee_hive_box_panel_wcnc`, open for the same
 * reason as the two new ones. Listing only the two that MOVED would have made
 * this list a diff instead of a state.
 */
const CAD1H_UNDECIDABLE_CUT_FILES = [
  { file: 'hardware/2bee_hive/2bee_hive_brood_panel_wcnc.scad', cause: 'our kernel audits the solid as OPEN', since: '2026-09-02' },
  { file: 'hardware/2bee_hive/2bee_hive_super_panel_wcnc.scad', cause: 'our kernel audits the solid as OPEN', since: '2026-09-02' },
  { file: 'hardware/2bee_hive/2bee_hive_box_panel_wcnc.scad', cause: 'our kernel audits the solid as OPEN', since: '2026-09-02' },
  { file: 'hardware/2bee_feeder/feeder_box_panel_wcnc.scad', cause: "$preview straddle — the oracle's own two legs disagree", since: '2026-09-02' },
  { file: 'hardware/2bee_hive/sc133_wood_base_18mm_wcnc.scad', cause: "$preview straddle — the oracle's own two legs disagree", since: '2026-09-02' },
];

const CAD1H_UNDECIDED_KNOWN = [
  {
    label: 'overlap',
    match: 'top-level solids overlap',
    since: '2026-08-14',
    why:
      'our top-level solids overlap and mesh.ts deliberately does not union siblings (it matches F5, not F6), so the ' +
      'summed invariants are not the union\'s — 23 files, measured 2026-08-12. Unioning ruled DEFERRED by the founder ' +
      '2026-08-14 (ceo ticket 2026-08-14-ceo-FOUNDER-cadt10-yes-host-yes-cad1h-defer.md). WHICH FAILURE THIS STOPS ' +
      'BEING ABLE TO DETECT, said as PENDING_BUDGET requires: a real divergence hiding inside one of these files ' +
      'stays hidden — measured the same day: 7 of the 23 (2bee_cables, 2bee_connectors, ics43434_mic, scd41_co2, ' +
      'usb_a_panel_dtype, load_cell_50kg_disc, planetary_gearmotor_36mm) DIVERGE when unioned. That was invisible ' +
      'behind the old red too; the difference is that the count now rides in a green message',
  },
  {
    label: 'touching-area',
    match: 'area is not comparable without unioning',
    since: '2026-08-14',
    why:
      'touching top-level solids: the CGAL union deletes coincident contact faces, our summed area counts them ' +
      '(proved against the binary: stacked cubes union to area 1000 vs 1200 summed) — 10 of the 31 tracked ' +
      'divergences were exactly this, tree same and volume to <=5e-8 rel. Same deferred ruling as `overlap`. GIVEN ' +
      'UP: a real AREA-ONLY defect on a touching model would now pend instead of diverging — accepted because ' +
      'volume, bbox and centroid are still compared, and a bulk-geometry defect moves those',
  },
  {
    label: 'export-over-cap',
    // 'MB read cap' is the literal shared by BOTH cap messages — the CSG one
    // added 2026-09-04 and the older STL one. Deliberately covers both: they are
    // the same fact about the harness (an export larger than it will read), and
    // splitting them would put one of the two behind an unlisted reason.
    match: 'MB read cap',
    since: '2026-09-04',
    why:
      'the model\'s CSG export is larger than the harness will read. `csgToCanon` costs ~23.7x the file in heap ' +
      '(measured: 64.8 MB -> 1536 MB peak), so a 485 MB export needs ~11.5 GB against a 4 GB heap — it OOM-KILLED ' +
      'the whole run and took 302 unrelated cases with it, nightly, from 2026-09-02 until the cap landed. ' +
      'CONFIRMED INTENDED by `cad` 2026-09-05: the size is 40 sprocket teeth plus a conjugate ring gear at $fn ' +
      '128-160 times seven lanes, linear in lane count, no nested instantiation (they measured 7x one drum = ' +
      '537978 facets against 711752 for the assembly, so drums are 76%). NOT a defect in their model and not one ' +
      'in ours. WHICH FAILURE THIS STOPS BEING ABLE TO DETECT: any disagreement between our reader and OpenSCAD ' +
      'on these files is now invisible — they are the largest assemblies in the tree, so this is not a small hole. ' +
      '⚠ `cad` offered `-D SHOW_DRUM=false`, which brings the export to 0.7 MB; REFUSED because our reader has no ' +
      '`-D` equivalent, so passing it to the binary alone would compare two different models and report a ' +
      'DIVERGES this harness manufactured. Closing this class means implementing overrides in scad.ts, not ' +
      'raising the cap: at 23.7x, admitting the 67 MB file alone costs ~70 MB of heap and turns a capacity bound ' +
      'into a negotiation',
  },
  {
    label: 'audit-not-closed',
    match: 'our kernel audits this solid as',
    since: '2026-09-04',
    why:
      'our own mesh audit reports the solid is NOT CLOSED — open edges, non-manifold, or duplicate seams — and ' +
      'volume and surface area are UNDEFINED on a surface that is not closed, so the invariant comparison has no ' +
      'referent to compute. 7 files at cad-tree@e856a01710af: 4 open (2bee_feeder/feeder, and the three ' +
      '2bee_hive *_wcnc panels), 2 non-manifold (marker_circle_3d, marker_triangle_3d), 1 seams ' +
      '(queen_excluder_3d). ' +
      '\ud83d\udd34 THE AMBIGUITY THIS ENTRY NAMED IS NOW RESOLVED, AND IT RESOLVED AGAINST US. When registered ' +
      '(2026-09-04) it said we could not tell whether the openness was the model\u2019s or a DEFECT IN OUR OWN ' +
      'MESHER. MEASURED THE SAME DAY, by exporting each file with the real binary and counting edge parity on the ' +
      'triangle soup \u2014 a closed manifold uses every undirected edge exactly twice: ' +
      '2bee_hive_box_panel_wcnc 290 tris / 0 open / 0 non-manifold; 2bee_hive_brood_panel_wcnc 2428 / 0 / 0; ' +
      '2bee_hive_super_panel_wcnc 4786 / 0 / 0; 2bee_feeder/feeder 162998 / 0 / 0; marker_circle_3d 460 / 0 / 0; ' +
      'queen_excluder_3d 1076 / 0 / 0. \u21d2 OPENSCAD PRODUCES A CLOSED SOLID FOR EVERY ONE. ' +
      '\ud83d\udd34 SO THIS IS OUR KERNEL\u2019S DEFECT, NOT A PROPERTY OF THE MODELS, and THREE OF THEM ARE CUT ' +
      'FILES. The class stays because the consequence is real \u2014 volume and area cannot be computed on the ' +
      'open mesh WE produced, so the comparison still has no referent \u2014 but it is kept as a TRACKED DEFECT ' +
      'with a known owner, NOT as an undecidable comparison nobody is responsible for. \u26a0 A registered class ' +
      'that names what it cannot distinguish is a gap; one that has since been distinguished and still reads as ' +
      '\u201cno referent\u201d is a cover. ' +
      'WHICH FAILURE THIS STOPS BEING ABLE TO DETECT: any mesh-leg divergence in these 7 is invisible. The TREE ' +
      'leg still compares them, so a structural disagreement is still caught. ' +
      '\u26a0 THREE OF THEM ARE CUT FILES and are ALSO pinned individually in CAD1H_UNDECIDABLE_CUT_FILES with ' +
      'the same cause \u2014 the set with a physical tail is tracked BY NAME as well as by class, deliberately.',
  },
  {
    label: 'preview-straddle',
    match: 'two legs straddle',
    since: '2026-08-14',
    why:
      'the source references $preview, and the oracle\'s own legs straddle it — `-o csg` runs $preview=true, ' +
      '`-o stl` runs $preview=false — so the tree leg and the mesh leg would be measured against DIFFERENT solids ' +
      '(honey_tank_sensor, ov5640_camera, inwall_cover_box). Our kernel is deliberately self-consistent at ' +
      '$preview=true; following OpenSCAD to F6 is a deferred PRODUCT decision this instrument may not pre-empt. ' +
      'GIVEN UP: nothing that was decidable — the comparison never had a referent',
  },
];

// The corpus-leg counterpart, added 2026-08-22 — name-exact, because the
// corpus is this lane's own fixed set. These two are NOT "the instrument
// cannot tell": the kernel's OWN audit has already called both meshes broken,
// which is stronger than a divergence — the product refuses to draw them.
// PENDING here means only that a volume comparison has no referent on an
// open/non-manifold surface; it must never read as green, and the entries
// exist so the red they deserve is carried by name while the meshes are
// unfixed, instead of holding the whole gate red until the kernel work lands.
const CAD1_UNDECIDED_KNOWN = [
  {
    name: 'corpus/refuse_hull',
    match: 'audits this solid as non-manifold',
    since: '2026-08-22',
    why:
      'hull() was implemented 2026-08-19 (6762357f92) but its mesh audits NON-MANIFOLD by the kernel\'s own audit ' +
      '(1711 tris vs the reference\'s 100 on this case) — a broken-mesh defect, not a comparison gap. Carried as ' +
      'named-and-dated UNDECIDED because the invariant comparison has no referent on a non-manifold surface; the ' +
      'physical failure it guards is a plausible-looking wrong part, and the kernel defect is the fix, not this entry',
  },
  {
    name: 'corpus/refuse_minkowski',
    match: 'audits this solid as open',
    since: '2026-08-22',
    why:
      'minkowski() was implemented 2026-08-19 (fe9fbea312) and emits TWO triangles against OpenSCAD\'s 188 on this ' +
      'case — the audit calls the surface open. A nearly-empty mesh is a likely-broken implementation; carried ' +
      'named-and-dated for the same reason as refuse_hull, and the same fix lives in the kernel, not here',
  },
];
{
  const ids = new Set(GATES.map((g) => g[0]));
  const unknown = Object.keys(PENDING_BUDGET).filter((k) => !ids.has(k));
  if (unknown.length) {
    // A budget entry for a gate that does not exist is a permission granted to
    // nothing — and it would sit here looking like coverage of something.
    console.error(`  FATAL PENDING_BUDGET names gates that do not exist: ${unknown.join(', ')}`);
    process.exit(2);
  }
}

// An accepted divergence with no reason and no date is a number wearing a
// comment. FATAL rather than FAIL: a malformed baseline means the gate below is
// scoring against something nobody wrote a sentence about, and a run in that
// state should not produce a verdict at all.
{
  const bad = [];
  for (const [name, e] of Object.entries(CAD1_KNOWN)) {
    if (!e || typeof e.why !== 'string' || e.why.trim().length < 20) bad.push(`${name}: no usable \`why\``);
    if (!e || !/^\d{4}-\d{2}-\d{2}$/.test(e.since ?? '')) bad.push(`${name}: no \`since\` date`);
  }
  if (!Number.isInteger(CAD1H_BASELINE.max) || CAD1H_BASELINE.max < 0) bad.push('CAD1H_BASELINE.max is not a count');
  if (typeof CAD1H_BASELINE.why !== 'string' || CAD1H_BASELINE.why.trim().length < 20) bad.push('CAD1H_BASELINE: no usable `why`');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(CAD1H_BASELINE.since ?? '')) bad.push('CAD1H_BASELINE: no `since` date');
  for (const k of CAD1H_UNDECIDED_KNOWN) {
    if (!k || typeof k.match !== 'string' || k.match.length < 10) bad.push('CAD1H_UNDECIDED_KNOWN: an entry has no usable `match`');
    if (!k || typeof k.why !== 'string' || k.why.trim().length < 20) bad.push(`CAD1H_UNDECIDED_KNOWN ${k?.label}: no usable \`why\``);
    if (!k || !/^\d{4}-\d{2}-\d{2}$/.test(k.since ?? '')) bad.push(`CAD1H_UNDECIDED_KNOWN ${k?.label}: no \`since\` date`);
  }
  for (const k of CAD1_UNDECIDED_KNOWN) {
    if (!k || typeof k.name !== 'string' || !k.name.startsWith('corpus/')) bad.push('CAD1_UNDECIDED_KNOWN: an entry has no usable corpus `name`');
    if (!k || typeof k.match !== 'string' || k.match.length < 10) bad.push(`CAD1_UNDECIDED_KNOWN ${k?.name}: no usable \`match\``);
    if (!k || typeof k.why !== 'string' || k.why.trim().length < 20) bad.push(`CAD1_UNDECIDED_KNOWN ${k?.name}: no usable \`why\``);
    if (!k || !/^\d{4}-\d{2}-\d{2}$/.test(k.since ?? '')) bad.push(`CAD1_UNDECIDED_KNOWN ${k?.name}: no \`since\` date`);
  }
  if (bad.length) {
    console.error(`  FATAL malformed CAD1 baseline — an accepted divergence must name itself and its date: ${bad.join(' | ')}`);
    process.exit(2);
  }
}

// A ruled source-offer target with no ruling and no date is this lane deciding
// `legal`'s open question by typing a URL into a table. FATAL for the CAD1
// baseline's reason: a run in that state should not produce a verdict at all.
//
// 🔴 AND THE LAZIEST BYPASS IS CLOSED HERE RATHER THAN AT THE PROBE. Adding the
// known-dead URL to this table is the one edit that would turn the gate green
// without touching the product — and it is refused at PARSE time, on a box with
// no network, because the probe that would otherwise catch it is exactly the
// check that can come back UNCHECKED.
{
  const bad = [];
  for (const [url, e] of Object.entries(SOURCE_OFFER_RULED)) {
    if (!/^https:\/\/\S+$/.test(url)) bad.push(`${url}: not an https URL`);
    if (url === AGPL_KNOWN_DEAD) {
      bad.push(
        `${url}: this is AGPL_KNOWN_DEAD — measured 404. If that repository has since been created and made ` +
          `public, retire the literal with a fresh measurement in its comment; do not rule the dead link good`
      );
    }
    if (!e || typeof e.why !== 'string' || e.why.trim().length < 20) bad.push(`${url}: no usable \`why\``);
    if (!e || !/^\d{4}-\d{2}-\d{2}$/.test(e.since ?? '')) bad.push(`${url}: no \`since\` date`);
    if (!e || typeof e.ruling !== 'string' || e.ruling.trim().length < 8) bad.push(`${url}: no \`ruling\` — name where the decision is recorded`);
  }
  if (bad.length) {
    console.error(`  FATAL malformed SOURCE_OFFER_RULED — a §13 target must name its ruling and its date: ${bad.join(' | ')}`);
    process.exit(2);
  }
}

// 🔴 A duplicate gate ID silently mislabels the scorecard: two different checks
// print under one name, and a reader sees the same gate "pass twice" while one
// of them is actually a different check entirely. It happened the first time two
// gates were added in one commit.
{
  const ids = GATES.map((g) => g[0]);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dupes.length) {
    console.error(`  FATAL duplicate gate ids: ${[...new Set(dupes)].join(', ')}`);
    process.exit(2);
  }
}

if (LIST) {
  for (const [id, name, kind, why] of GATES) {
    console.log(`${id.padEnd(5)} ${kind.padEnd(8)} ${name.padEnd(22)} ${why}`);
  }
  console.log(`\n${GATES.length} gates. PENDING is budgeted, not discarded — a gate allowed to say`);
  console.log('"could not run here" must be named in PENDING_BUDGET, and the run then reads');
  console.log('INCOMPLETE (exit 3), never GO. Anything else that pends is scored as a FAIL.');
  for (const [id, b] of Object.entries(PENDING_BUDGET)) {
    console.log(`  budgeted PENDING  ${id.padEnd(5)} (--${b.when}) ${b.why}`);
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
console.log('==============================================================');
console.log(' 2bee.app GATE');
console.log('==============================================================');

// --- G0: build + unit tests ------------------------------------------------
if (!QUICK) {
  try {
    execSync('cargo build --release', { cwd: ROOT, stdio: 'pipe' });
  } catch (e) {
    fatal(`release build failed:\n${e.stderr?.toString() ?? e.message}`);
  }
}
if (!existsSync(BIN)) fatal(`binary missing at ${BIN} — run without --quick`);

const BIN_HASH_0 = createHash('sha256').update(readFileSync(BIN)).digest('hex').slice(0, 12);
console.log(` binary ${BIN_HASH_0}\n`);

// --- STALE: the binary every other gate drives was built from THIS source ---
//
// 🔴 THE HOLE THIS CLOSES, and it is the one `--quick` opens. `cargo test`
// runs unconditionally and compiles the CURRENT source. Every other gate drives
// `target/release/2bee-slice`, which under `--quick` was built from whatever was
// in the tree when someone last ran it. So G0 can be green about today's source
// while every other gate is green about last week's binary, and NOTHING SAYS SO:
//
//   - G14 hashes the same file at the start and the end of the run. That
//     detects a rebuild DURING the run, not staleness BEFORE it.
//   - K3 compares the CLI's BUILD_ID to the WASM's. Two equally stale artefacts
//     agree perfectly — which is the exact failure K3 was written for, one level
//     up. Nothing compared either of them to the SOURCE.
//
// So this recomputes `core/build.rs`'s fingerprint here, independently, and
// requires the binary to agree. `core/build.rs` documents the digest as a change
// detector rather than a cryptographic hash, and that is all this needs: the
// failure being guarded is a forgotten rebuild, not a forgery.
//
// ⚠ WHAT IT DOES NOT COVER, stated rather than implied: the id is a digest of
// `core/src` ONLY. Edits to `cli/`, `wasm/`, `Cargo.toml`, a dependency bump or
// a changed profile do NOT move it, so a green here is "the CORE this binary
// carries is these bytes", never "this binary is fresh". Same boundary K3 states
// for itself, one level down.
{
  const M64 = (1n << 64n) - 1n;
  const FNV_PRIME = 0x100000001b3n;
  const fnv = (h, bytes) => {
    for (const b of bytes) {
      h ^= BigInt(b);
      h = (h * FNV_PRIME) & M64;
    }
    return h;
  };
  // `build.rs` sorts `Vec<PathBuf>`, and Rust's Path ordering is COMPONENT-wise,
  // not a byte compare of the whole string. The two disagree exactly where a
  // file and a directory share a prefix (`src/a.rs` vs `src/a/b.rs`, because
  // '.' < '/'), so a naive string sort would produce a digest that is stable,
  // plausible, and not the one the binary carries — a permanent false red.
  const cmpPath = (a, b) => {
    const A = a.split('/');
    const B = b.split('/');
    for (let i = 0; i < Math.max(A.length, B.length); i++) {
      const x = A[i];
      const y = B[i];
      if (x === undefined) return -1;
      if (y === undefined) return 1;
      if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
  };
  const rels = [];
  const walk = (rel) => {
    for (const e of readdirSync(join(ROOT, 'core', rel), { withFileTypes: true })) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(r);
      else if (e.name.endsWith('.rs')) rels.push(r);
    }
  };

  const cli = slice(['buildid']);
  const binId = cli.stdout.trim();
  let srcId = null;
  let why = '';
  try {
    walk('src');
    if (rels.length === 0) {
      // build.rs itself panics rather than hash nothing, for the same reason: a
      // constant fingerprint agrees with everything.
      why = 'found no .rs under core/src — a digest of nothing agrees with every binary ever built';
    } else {
      rels.sort(cmpPath);
      let h = 0xcbf29ce484222325n;
      for (const r of rels) {
        h = fnv(h, Buffer.from(r, 'utf8'));
        h = fnv(h, [0]);
        h = fnv(h, readFileSync(join(ROOT, 'core', r)));
        h = fnv(h, [0]);
      }
      // splitmix64-style finalising mix, exactly as build.rs does it — FNV
      // leaves the low bits weakly mixed and this id is truncated to 12 hex.
      let x = h;
      x ^= x >> 30n;
      x = (x * 0xbf58476d1ce4e5b9n) & M64;
      x ^= x >> 27n;
      x = (x * 0x94d049bb133111ebn) & M64;
      x ^= x >> 31n;
      srcId = x.toString(16).padStart(16, '0').slice(0, 12);
      // The self-plant salts the SOURCE side only, so a genuinely current tree
      // must go red. Salting both sides would agree with itself, which is the
      // defect this gate exists to catch, planted into its own control.
      //
      // ⚠ XOR, not "set the first digit to f". The first draft did the latter
      // and was VACUOUS one time in sixteen — on any tree whose digest already
      // started with `f`, the plant would have produced an identical id, the
      // gate would have stayed green, and the control would have read as
      // passing. A negative control with a 1-in-16 silent failure is the exact
      // shape gate PLANT exists to find in other people's work.
      if (selfPlanted('stale-core')) srcId = (parseInt(srcId[0], 16) ^ 1).toString(16) + srcId.slice(1);
    }
  } catch (e) {
    why = `could not recompute the core digest: ${String(e.message ?? e).slice(0, 200)}`;
  }

  if (cli.code !== 0 || !/^[0-9a-f]{12}$/.test(binId)) {
    fail('STALE', `the CLI did not answer \`buildid\` (exit ${cli.code}, stdout ${JSON.stringify(binId.slice(0, 40))}) — this binary predates the fingerprint; run without --quick`);
  } else if (srcId === null) {
    fail('STALE', why);
  } else if (srcId === binId) {
    pass('STALE', `the binary carries core ${binId}, recomputed independently over ${rels.length} file(s) under core/src`);
  } else {
    fail(
      'STALE',
      `STALE BINARY: target/release/2bee-slice was built from core ${binId}, core/src hashes to ${srcId} ` +
        `over ${rels.length} file(s). Every gate below this line is an answer about the OLD program. ` +
        `Rebuild: cargo build --release (or drop --quick). ` +
        `⚠ If another session is editing core/src right now, this can also be a source tree that moved ` +
        `UNDER the run — re-measure on a settled tree before reporting it as a regression`
    );
  }
}

try {
  const out = execSync('cargo test --workspace 2>&1', { cwd: ROOT, encoding: 'utf8' });
  const failed = /(\d+) failed/.exec(out);
  const suites = (out.match(/test result: ok/g) || []).length;
  /* 🔴 THE SUITE COUNT WAS PRINTED AND NEVER ASSERTED (found 2026-09-07).
   * `cargo test --workspace` exits 0 having run NOTHING if a member drops out of
   * Cargo.toml, a [[test]] target is removed, or everything is #[ignore]d — and
   * this printed `unit tests green (0 suites)` and passed. G0 is the gate the
   * rest of this file stands on: STALE, G14, DOOR, REL and the whole --plant
   * product layer all reason about a binary G0 is supposed to have proven.
   * ⚠ Every gate written AFTER this one carries the floor it lacked —
   * TSC's FILE_FLOOR, CADT's `discovered.length === 0`, SPEC's `rustFns.size
   * === 0`. G0 is the oldest and never got one. */
  /* ⚠ THE FLOOR IS ON TESTS, NOT SUITES, and the first version of this fix was
   * on suites — measured immediately afterwards: `cargo test --workspace` prints
   * FOUR `test result: ok` lines here and TWO of them report `0 passed`. A
   * suite-count floor of 3 would therefore pass on four EMPTY suites, which is
   * the exact state it was written to catch. Counting the tests that actually
   * ran cannot be satisfied by an empty binary. */
  const ranTests = [...out.matchAll(/test result: ok\. (\d+) passed/g)].reduce(
    (n, m) => n + Number(m[1]),
    0,
  );
  const G0_TEST_FLOOR = 700;
  if (ranTests < G0_TEST_FLOOR) {
    fail(
      'G0',
      `cargo test --workspace ran ${ranTests} test(s) across ${suites} suite(s), below the floor ` +
        `of ${G0_TEST_FLOOR}. A workspace that runs no tests exits 0 and would otherwise read as ` +
        '"unit tests green". ⚠ Two of this workspace\'s suites legitimately report 0 passed, so a ' +
        'SUITE count cannot carry this floor. Raise it with the suite, or find the member that ' +
        'stopped being tested.',
    );
  } else if (failed && Number(failed[1]) > 0) {
    /* ⚠ Kept, and it is NOT the live detector: `execSync` throws on any non-zero
     * exit and `cargo test` exits 101 when a test fails, so a failing run is
     * already in the catch below. Reaching here needs cargo to exit 0 while
     * printing a non-zero failure count. Retained as a belt on a brace rather
     * than removed, but do not read its presence as the thing that catches a
     * failing test — the catch is. */
    fail('G0', `unit tests: ${failed[0]}`);
  } else {
    pass('G0', `unit tests green (${ranTests} tests across ${suites} suites, floor ${G0_TEST_FLOOR})`);
  }
} catch (e) {
  fail('G0', `cargo test failed: ${String(e.stdout ?? e.message).split('\n').slice(-5).join(' ')}`);
}

// --- G1: determinism -------------------------------------------------------
{
  const runs = [0, 1, 2].map(() => slice(['fixture', 'rect-arcs']).stdout);
  const h = runs.map((r) => createHash('sha256').update(r).digest('hex'));
  if (h[0] === h[1] && h[1] === h[2] && runs[0].length > 0) {
    pass('G1', `3 runs byte-identical (${h[0].slice(0, 12)})`);
  } else {
    fail('G1', `output drifted across runs: ${h.map((x) => x.slice(0, 8)).join(' ')}`);
  }
}

// --- G2: dialect -----------------------------------------------------------
//
// 🔴 WHY THIS GATE SCANS A SET AND NOT ONE FIXTURE (widened 2026-08-12).
// `6860da1777` added an `off material:` line to the EMITTED PROGRAM — the first
// new comment generator in this core for weeks — and closed with the residual
// in its own commit body: *"GATE G2 CANNOT SEE THIS COMMENT — G2 reads the
// fixtures' programs and no fixture cuts off the material, so a banned word
// introduced here would ship past the dialect gate unread."* It checked the one
// ban free prose can plausibly trip (the extruder `E` word) inside a Rust unit
// test instead, by hand, and said so.
//
// ⚠ THE STATED REASON IS HALF THE REASON, AND THE OBVIOUS FIX WOULD NOT HAVE
// WORKED. Measured before writing this: `codeLines` DROPS EVERY COMMENT, on
// purpose and load-bearingly — the preamble legitimately reads
// `( post: grblHAL dialect. Cutter comp is NOT used _G41/G42 absent from
// grblHAL core_; )`, so a comment-scanning G2 goes red on its own header on
// every program in the tree. A fixture that cuts off the material would
// therefore NOT have shown this gate the comment either — and it costs two
// things besides. It is an edit to `cli/src/main.rs`'s `FIXTURES` table and to
// `core/src/fixtures.rs`, which are NOT this lane's files today; and the four
// entries there are what `2bee-slice fixtures` offers an operator as worked
// examples, so a deliberately-wrong program would sit permanently in the demo
// set. ⚠ It would NOT enter DOOR's matrix — DOOR sweeps the six `jobs`, not
// these four — which is worth stating because that was the first reason written
// here and it was wrong; the reasons above are the ones that hold. So the input
// set widens instead, through `--config`, which reaches the same emitted program
// without adding a corpus member.
//
// THREE LIMBS, and the second is the one that makes the first sound:
//
//   1 BANNED / REQUIRED / M30, over the CODE LINES of every program in the set.
//     Unchanged in meaning; five programs instead of one.
//   2 COMMENT CONTAINMENT. A banned word inside a comment is not a command the
//     controller may obey — PROVIDED the comment cannot end early. grblHAL does
//     not nest comments (`gcode.c gc_normalize_block` carries the TODO) and ends
//     one at the FIRST `)`, parsing the rest as code; `post_grblhal.rs::sanitize`
//     is what stops that, by rewriting `(`/`)` to `_` in every interpolated
//     string. So this limb asserts the property the code-lines-only scan RESTS
//     ON, over every comment of every program: one `(`, one `)`, nothing between
//     them that could close it, nothing executable after it. G5 asserts the same
//     shape under `--plant paren` on one program; this is it unplanted, over the
//     set, because the sanitiser is the premise of limb 1 and a premise nobody
//     checks is an assumption.
//   3 REACH. The set must contain a program that actually carries the
//     `off material:` comment. A widening that silently stops reaching the thing
//     it was widened for reads exactly like a widening that passed.
//
// ⚠ NOT ASSERTED, DELIBERATELY: comment LENGTH and non-ASCII bytes. The
// off-material comment is 200 chars and carries a U+2014 em-dash; every fixture
// line is <=86 chars and pure ASCII, so this set is the first thing here to see
// either. Both are `pcb`'s facts about the controller (grblHAL's line-buffer
// size, and what its parser does with a byte >0x7F inside a comment) and this
// lane has verified neither — an invented threshold is worse than a named gap.
// Both numbers are REPORTED on every pass so the gap has a size.
{
  // 🔴 The rules come FROM THE CORE, per technology. A copy of the list here
  // would drift from the one the code enforces, and the copy nobody looks at is
  // always the one that drifts. It is also what keeps the ban survivable when a
  // second process arrives: the fix then is to ask for that technology's rules,
  // never to delete these.
  let rules = null;
  try {
    rules = JSON.parse(slice(['dialect-rules', 'cnc']).stdout);
  } catch {
    /* reported below */
  }
  // ⚠ THIS `fail` DOES NOT RETURN, and on an empty ban list G2 pushes BOTH a
  // FAIL and (limb 1 being vacuous with no patterns) a PASS. Pre-existing, left
  // deliberately, named rather than silently inherited by the rewrite around it:
  // it fails CLOSED — the scorecard prints the FAIL, the counts include it and
  // the verdict is NO-GO — so changing the control flow here would buy nothing
  // and cost a verification cycle. If anyone tidies it, the shape to keep is the
  // failure, not the return.
  if (!rules || !rules.banned?.length) {
    fail('G2', 'the core reported no dialect rules — the ban list is empty, not clean');
  }
  /* 🔴 THE SAME FLOOR ON `required`, ADDED 2026-09-08. The check above covers
   * `banned` ONLY. `required` was read with no floor anywhere in this file, and
   * the limb that consumes it — `required.filter(w => !RegExp(w).test(g))` — is
   * VACUOUSLY TRUE over an empty list: `missing` is always `[]`, no problem is
   * pushed, and G2 passes printing `preamble  present and M30 last in each` with
   * `required.join(' ')` rendering an empty string. That double space is the
   * only symptom and nothing reads it.
   *
   * ⚠ Measured before pinning, so the floor is derived rather than typed: the
   * core declares SIX required words today (G17 G21 G90 G54 G94 G40) and six
   * banned. The assertion is non-emptiness, not the number, because the list is
   * the core's to grow — pinning 6 would fail on a legitimate seventh.
   *
   * ⚠ It inherits the non-return above BY DESIGN: same reasoning, it fails
   * CLOSED — the scorecard prints the FAIL, the counts include it, the verdict
   * is NO-GO. The shape to keep is the failure, not the return. */
  if (!rules || !rules.required?.length) {
    fail(
      'G2',
      'the core reported no REQUIRED preamble words — an empty list is not a clean preamble. ' +
        'Every `missing` check below is vacuously satisfied by it, and G2 would print ' +
        '"preamble present" about a program it never checked a single word of.',
    );
  }
  const banned = (rules?.banned ?? []).map((b) => [new RegExp(b.pattern), b.why]);
  const required = rules?.required ?? [];

  // The off-material program. `plate` on a workpiece small enough that the part
  // hangs over three of its edges — NOT a fixture, so nothing else in this file
  // enumerates it, and not a plant, because the core is behaving correctly: it
  // is telling the operator the cutter has left the material.
  const offCfg = join(ROOT, 'target', 'gatecfg-g2-offmaterial.json');
  writeFileSync(
    offCfg,
    JSON.stringify({ stock: { size_x_mm: 190, size_y_mm: 250, origin_x_mm: 55, origin_y_mm: 55 } })
  );
  const PROGRAMS = [
    ['fixture rect-arcs', ['fixture', 'rect-arcs'], 'real G2/G3 arc emission — the program this gate read alone until 2026-08-12'],
    ['fixture rect-profile', ['fixture', 'rect-profile'], 'the plain outside profile'],
    ['fixture rect-inside', ['fixture', 'rect-inside'], 'the inside cut, whose comments name a different op'],
    ['fixture drill-peck', ['fixture', 'drill-peck'], 'canned cycles — the shortest program here'],
    [
      'job plate --config (workpiece smaller than the part)',
      ['job', 'plate', '--config', offCfg],
      'the ONLY program in this set that emits the `off material:` comment, and the reason the set exists',
    ],
    // `--self-plant g2-input-narrow` removes everything but the first entry.
  ].slice(0, selfPlanted('g2-input-narrow') ? 1 : undefined);

  const problems = [];
  let commentCount = 0;
  let widestComment = 0;
  let nonAscii = 0;
  let offMaterialSeen = 0;
  let codeLineCount = 0;

  for (const [label, args, why] of PROGRAMS) {
    const r = slice(args);
    if (r.code !== 0 || !r.stdout.trim()) {
      problems.push(
        `\`${label}\` emitted no program (exit ${r.code}, ${r.stdout.length}B) — it is in this set because ${why}, ` +
          `and a member that stops emitting silently narrows the scan`
      );
      continue;
    }
    const lines = r.stdout.split('\n');
    const g = codeLines(r.stdout).join('\n');
    codeLineCount += codeLines(r.stdout).length;

    // LIMB 1.
    const hits = banned.filter(([re]) => re.test(g)).map(([, n]) => n);
    if (hits.length) problems.push(`\`${label}\` code lines carry banned: ${hits.join(', ')}`);
    const missing = required.filter((w) => !new RegExp(`\\b${w}\\b`).test(g));
    if (missing.length) problems.push(`\`${label}\` is missing preamble word(s): ${missing.join(', ')}`);
    if (!/M30\s*$/.test(g.trimEnd() + '\n')) problems.push(`\`${label}\` does not end M30`);

    // LIMB 2 + LIMB 3, on the comment lines limb 1 deliberately never reads.
    for (let i = 0; i < lines.length; i++) {
      let t = lines[i].trim();
      if (!t.startsWith('(')) continue;
      // ⚠ THE REACH COUNT IS TAKEN FROM THE UNPLANTED TEXT, and the first cut of
      // this was written the other way round. `g2-comment-escape` overwrites the
      // needle `off material:` while planting, so limb 3 ALSO went red and the
      // control's transcript named two failures when it had caused one. A plant
      // whose blast radius reaches a sibling limb proves that limb can go red
      // for a reason nobody planted, which is the opposite of a negative control.
      const isOff = t.includes('off material:');
      // `--self-plant g2-comment-escape`: the sanitiser regressed. A `)` lands
      // inside the comment body and a rapid follows it — the exact shape
      // `post_grblhal.rs::sanitize` exists to prevent, and the shape that makes
      // a banned word in a comment executable rather than inert.
      if (selfPlanted('g2-comment-escape') && isOff) {
        t = t.replace('off material:', 'off material) G0 Z0 M104 S200 (');
      }
      commentCount++;
      widestComment = Math.max(widestComment, t.length);
      const outside = [...t].filter((c) => c.codePointAt(0) > 0x7f).length;
      nonAscii += outside;
      if (isOff) offMaterialSeen++;
      const close = t.indexOf(')');
      if (close < 0) {
        problems.push(`\`${label}\` line ${i + 1}: a comment that never closes — grblHAL parses to end of line`);
        continue;
      }
      if (/[()]/.test(t.slice(1, close))) {
        problems.push(
          `\`${label}\` line ${i + 1}: a parenthesis SURVIVED inside a comment body — the post's sanitiser did not ` +
            `rewrite it, and grblHAL ends the comment at the first \`)\`: ${t.slice(0, 90)}`
        );
      }
      const after = t.slice(close + 1).trim();
      if (after) {
        problems.push(
          `\`${label}\` line ${i + 1}: ${JSON.stringify(after.slice(0, 60))} follows the comment's close and is CODE to ` +
            `grblHAL — this is the whole reason limb 1 may skip comment lines, and it just stopped being true`
        );
      }
    }
  }

  // LIMB 3.
  if (offMaterialSeen === 0) {
    problems.push(
      'NO program in this set carries the `off material:` comment. That line is the newest thing the core writes into ' +
        'an emitted program and the reason this set is wider than one fixture; if the `plate` job stops hanging over ' +
        'its workpiece, this gate has silently gone back to reading four clean fixtures. Re-point the config — do not ' +
        'delete the limb'
    );
  }

  if (problems.length === 0) {
    pass(
      'G2',
      `no FFF words on ${codeLineCount} code line(s) across ${PROGRAMS.length} program(s); preamble ` +
        `${required.join(' ')} present and M30 last in each. COMMENT CONTAINMENT holds on all ${commentCount} comment ` +
        `line(s) — one open, one close, no parenthesis surviving inside a body, nothing executable after the close — ` +
        `which is the property that makes it sound for the banned-word scan to skip comments at all (it must: the ` +
        `preamble legitimately NAMES G41/G42). REACH: ${offMaterialSeen} program(s) carry the \`off material:\` line, ` +
        `so the newest comment generator in the core is inside the scan. ⚠ NOT ASSERTED: comment LENGTH (widest here ` +
        `${widestComment} chars) and NON-ASCII bytes (${nonAscii} in this set, all in comments) — grblHAL's line ` +
        `buffer and its handling of a byte >0x7F are pcb's facts and this lane has verified neither, so they are ` +
        `measured and reported rather than gated on an invented threshold`
    );
  } else {
    fail('G2', problems.join(' | '));
  }
}

// --- G3: travel limits (negative control: --plant offbed) ------------------
{
  const clean = slice(['fixture', 'rect-profile']);
  const planted = slice(['fixture', 'rect-profile', '--plant', 'offbed']);
  if (clean.code === 0 && planted.code !== 0 && /outside X travel/.test(planted.stderr)) {
    pass('G3', 'out-of-travel path rejected; the in-bounds control still passes');
  } else if (clean.code !== 0) {
    fail('G3', `STUCK RED — the clean fixture is rejected: ${clean.stderr.trim()}`);
  } else {
    fail('G3', 'an out-of-travel path was accepted');
  }
}

// --- G4: spoilboard (negative control: --plant deep) -----------------------
{
  const clean = slice(['fixture', 'rect-profile']);
  const planted = slice(['fixture', 'rect-profile', '--plant', 'deep']);
  if (clean.code === 0 && planted.code !== 0 && /spoilboard/.test(planted.stderr)) {
    pass('G4', 'over-depth cut rejected; a through-cut at workpiece thickness still passes');
  } else if (clean.code !== 0) {
    fail('G4', `STUCK RED — a legitimate through-cut is rejected: ${clean.stderr.trim()}`);
  } else {
    fail('G4', 'a cut 7mm into the spoilboard was accepted');
  }
}

// --- G5: comment injection (negative control: --plant paren) ---------------
{
  const r = slice(['fixture', 'rect-profile', '--plant', 'paren']);
  const comments = r.stdout.split('\n').filter((l) => l.trim().startsWith('('));
  // The mitigation must hold: no paren survives INSIDE a comment body, and
  // nothing after the comment's first ')' is executable.
  const nested = comments.filter((l) => /\(.*[()]/.test(l.slice(1)));
  // 🔴 This limb MODELS grblHAL's normaliser rather than reading our own line
  // structure. Our line filter drops anything starting with '(' — so a scan of
  // "code lines" can never see code injected INSIDE a comment line, which is
  // the entire hazard. It measured 0 with the sanitiser deliberately disabled:
  // a limb that cannot fire on the defect it names. grblHAL ends the comment at
  // the FIRST ')' and parses the remainder as code, so that is what is checked.
  const strayMotion = comments.filter((l) => {
    const close = l.indexOf(')');
    if (close < 0) return false;
    return /\b[GM]\d+\b/.test(l.slice(close + 1));
  });
  if (r.code === 0 && nested.length === 0 && strayMotion.length === 0) {
    pass('G5', 'a name containing "(v2) G0 Z0" is neutralised, not executed');
  } else {
    fail('G5', `injection survived: nested=${nested.length} strayMotion=${strayMotion.length}`);
  }
}

// --- G6: spindle (negative control: --plant spindle-off) -------------------
{
  const planted = slice(['fixture', 'rect-profile', '--plant', 'spindle-off']);
  const clean = slice(['fixture', 'rect-profile']);
  if (planted.code !== 0 && /spindle is off/.test(planted.stderr) && clean.code === 0) {
    pass('G6', 'cutting with a stopped spindle rejected');
  } else {
    fail('G6', 'a program that cuts with the spindle off was accepted');
  }
}

// --- G7: arc emission, BOTH directions -------------------------------------
{
  const withArcs = slice(['fixture', 'rect-arcs']);
  const without = slice(['fixture', 'rect-arcs', '--no-arcs']);
  const arcLines = codeLines(withArcs.stdout).filter((l) => /^G[23]\b/.test(l.trim()));
  const ijOk = arcLines.every((l) => /\bI-?[\d.]+\s+J-?[\d.]+/.test(l));
  const degraded = codeLines(without.stdout).some((l) => /^G[23]\b/.test(l.trim()));
  const warned = /arc degraded/.test(without.stderr);
  if (arcLines.length >= 4 && ijOk && !degraded && warned) {
    pass('G7', `${arcLines.length} arcs with I/J; --no-arcs degrades to G1 and says so`);
  } else {
    fail(
      'G7',
      `arcs=${arcLines.length} ij=${ijOk} degradedStillEmitsArc=${degraded} warned=${warned}`
    );
  }
}

// --- G8: arc precondition (negative control: --plant arc-first) ------------
{
  const planted = slice(['fixture', 'rect-arcs', '--plant', 'arc-first']);
  if (planted.code !== 0 && /before any positioning/.test(planted.stderr)) {
    pass('G8', 'an arc with no known start is rejected');
  } else {
    fail('G8', 'an arc was emitted with an unknown start point');
  }
}

// --- G9: peck cycle --------------------------------------------------------
{
  const g = slice(['fixture', 'drill-peck']).stdout;
  const pecks = codeLines(g).filter((l) => /\bG83\b/.test(l));
  const haveQR = pecks.every((l) => /\bQ[\d.]+/.test(l) && /\bR[\d.]+/.test(l));
  const cancelled = (g.match(/^G80$/gm) || []).length >= pecks.length;
  const retract = pecks.every((l) => /\bG98\b/.test(l));
  if (pecks.length === 4 && haveQR && cancelled && retract) {
    pass('G9', '4 G83 cycles, each with Q and R, G98 retract, each cancelled by G80');
  } else {
    fail('G9', `pecks=${pecks.length} QR=${haveQR} G80=${cancelled} G98=${retract}`);
  }
}

// --- G10: block rate -------------------------------------------------------
{
  const g = slice(['fixture', 'rect-arcs']).stdout;
  // Reconstruct XY motion and measure segment lengths.
  let x = null,
    y = null,
    feed = 0;
  const segs = [];
  for (const l of codeLines(g)) {
    const mf = /\bF([\d.]+)/.exec(l);
    if (mf) feed = Number(mf[1]);
    if (!/^G[0123]\b/.test(l.trim())) continue;
    const nx = /\bX(-?[\d.]+)/.exec(l),
      ny = /\bY(-?[\d.]+)/.exec(l);
    const px = nx ? Number(nx[1]) : x,
      py = ny ? Number(ny[1]) : y;
    if (x !== null && y !== null && px !== null && py !== null && /^G[123]\b/.test(l.trim())) {
      const d = Math.hypot(px - x, py - y);
      if (d > 0) segs.push(d);
    }
    x = px;
    y = py;
  }
  segs.sort((a, b) => a - b);
  const median = segs.length ? segs[Math.floor(segs.length / 2)] : 0;
  // grblHAL on an SKR Pro sustains roughly 480 blocks/sec. The fork measured a
  // real program demanding ~1920.
  const SUSTAINABLE_BPS = 480;
  const bps = median > 0 ? feed / 60 / median : Infinity;
  if (segs.length > 0 && bps <= SUSTAINABLE_BPS) {
    pass('G10', `median segment ${median.toFixed(3)}mm at F${feed} = ${bps.toFixed(1)} blocks/s`);
  } else {
    fail('G10', `${bps.toFixed(1)} blocks/s demanded, ${SUSTAINABLE_BPS} sustainable`);
  }
}

// --- G11: the Z-zero setting must CHANGE the program -----------------------
{
  const top = slice(['fixture', 'rect-profile']).stdout;
  const spoil = slice(['fixture', 'rect-profile', '--spoilboard-zero']).stdout;
  const zOf = (g) =>
    codeLines(g)
      .map((l) => /\bZ(-?[\d.]+)/.exec(l))
      .filter(Boolean)
      .map((m) => Number(m[1]));
  const a = zOf(top),
    b = zOf(spoil);
  const shifted =
    a.length > 0 && a.length === b.length && a.every((v, i) => Math.abs(b[i] - v - 18.0) < 1e-6);
  if (top !== spoil && shifted) {
    pass('G11', 'spoilboard zeroing shifts every Z word by exactly one workpiece thickness');
  } else {
    fail('G11', `setting had no effect or the wrong effect (identical=${top === spoil})`);
  }
}

// --- G12: feeds derived from chipload --------------------------------------
{
  const g = codeLines(slice(['fixture', 'rect-profile']).stdout).join('\n');
  // 6mm 2-flute at 0.10mm/tooth, 18000 rpm => 18000 * 2 * 0.10 = 3600 mm/min.
  const want = 3600.0;
  const feeds = [...g.matchAll(/\bF([\d.]+)/g)].map((m) => Number(m[1]));
  const cutting = feeds.filter((f) => f !== 300.0); // 300 is the plunge rate
  const ok = cutting.length > 0 && cutting.every((f) => Math.abs(f - want) < 1e-6);
  if (ok) pass('G12', `cutting feed ${want} = rpm x flutes x chipload, exactly`);
  else fail('G12', `expected ${want}, got ${[...new Set(cutting)].join(',')}`);
}

// --- G13: fail closed ------------------------------------------------------
{
  const planted = slice(['fixture', 'rect-profile', '--plant', 'offbed']);
  if (planted.code !== 0 && planted.stdout.trim() === '') {
    pass('G13', 'a rejected program emits no G-code at all');
  } else {
    fail('G13', `rejected program still printed ${planted.stdout.length} bytes of G-code`);
  }
}

// --- G14: binary stability -------------------------------------------------
{
  const h1 = createHash('sha256').update(readFileSync(BIN)).digest('hex').slice(0, 12);
  if (h1 === BIN_HASH_0) pass('G14', 'same binary throughout');
  else fail('G14', `BINARY CHANGED MID-GATE (${BIN_HASH_0} -> ${h1}) — results VOID`);
}

// ===========================================================================
//  JOB-LEVEL GATES — the engine end to end, not just the post.
//  Every one below is paired with `--plant`, and each plant was watched failing
//  before the gate was trusted.
// ===========================================================================

/** Run a job fixture. Job output is diagnostics on stderr, G-code on stdout. */
function job(args) {
  const r = slice(['job', ...args]);
  const num = (re) => {
    const m = re.exec(r.stderr);
    return m ? Number(m[1]) : null;
  };
  return {
    ...r,
    gouge: num(/gouge=(\d+)/),
    uncut: num(/uncut=(\d+)/),
    spoilboard: num(/spoilboard=(\d+)/),
    tabs: num(/tabs: lifts=(\d+)/),
    dogbones: num(/dogbones: (\d+)/),
    designDepth: num(/removal: design_depth=([\d.]+)mm/),
  };
}

/**
 * Deepest Z reached inside the pocket operations of an emitted program.
 *
 * 🔴 Read from the PROGRAM, and only from the blocks between `( op: pocket-… )`
 * and the next op comment. The job's own `deepest=` summary is -18mm — the
 * through-profile — so a gate that used it would pass no matter what the pocket
 * floor did. Rule 5 of the audit loop, applied: the number a gate asserts on
 * comes from the emitted program, not from the plan that produced it.
 */
function pocketFloorZ(gcode) {
  let inPocket = false;
  let deepest = null;
  let z = null;
  for (const raw of gcode.split('\n')) {
    const line = raw.trim();
    // EVERY section header closes the previous section, not just `op:`. The
    // drill cycles are headed `( drill: … )` and sit between the last pocket
    // lap and the outer profile — scanning only for `op:` left the pocket
    // region open across them and read the through-hole Z-18.000 as the pocket
    // floor. The gate went red for that reason before it ever saw a real one.
    const sec = /^\( (op|drill): (\S+)/.exec(line);
    if (sec) {
      inPocket = sec[1] === 'op' && sec[2].startsWith('pocket-');
      continue;
    }
    if (line.startsWith('(') || !line) continue;
    const m = /(?:^|\s)Z(-?[\d.]+)/.exec(line);
    /* 🔴 ONLY A LINE THAT COMMANDS Z DEEPENS THE POCKET. This used to record
     * the CARRIED Z on every line, including Z-less ones — so the pocket
     * section's opening `G0 X… Y…` (no Z word) was read at whatever Z the
     * previous section happened to end on. That carry was invisible while a
     * spurious same-tool `TOOL CHANGE` block sat between the drills and the
     * pocket, because its retract `G0 Z5.000` reset the carry to +5; when the
     * core stopped emitting that block (2026-08-27, `job.rs` — a group
     * boundary with the same cutter is not a tool change) the carry read the
     * last drill's Z-18.000 as the pocket floor and P3 went red on a program
     * whose pocket section was byte-identical. */
    if (m) {
      z = Number(m[1]);
      if (inPocket && (deepest === null || z < deepest)) deepest = z;
    }
  }
  return deepest;
}

// --- P1: tabs --------------------------------------------------------------
{
  const clean = job(['plate']);
  const planted = job(['plate', '--plant', 'no-tabs']);
  if (clean.tabs > 0 && planted.tabs === 0) {
    pass('P1', `${clean.tabs} tab lifts present; disabling tabs removes all of them`);
  } else {
    fail('P1', `clean=${clean.tabs} planted=${planted.tabs} — the tab signal does not separate`);
  }
}

// --- P2: pocket clearing ---------------------------------------------------
{
  const clean = job(['pocket']);
  const planted = job(['pocket', '--plant', 'outline-only']);
  // A cleared pocket may leave a few cells at the sampling boundary; an
  // outlined one leaves the whole island. The two must be orders apart.
  if (clean.uncut !== null && clean.uncut < 20 && planted.uncut > clean.uncut * 50) {
    pass('P2', `cleared leaves ${clean.uncut} cells, outlined leaves ${planted.uncut}`);
  } else {
    fail('P2', `cleared=${clean.uncut} outlined=${planted.uncut} — clearing is not distinguishable`);
  }
}

// --- P3: pocket floor depth ------------------------------------------------
// A pocket short of its design floor is not a visible defect: the pocket is
// there, the walls are right, and the tenon simply will not seat. The design
// floor comes from the fixture (`removal: design_depth=`), the cut floor from
// the emitted program — a gate that took both from the same place would agree
// with itself.
{
  const clean = job(['pocket']);
  const planted = job(['pocket', '--plant', 'shallow-floor']);
  const cleanZ = pocketFloorZ(clean.stdout);
  const plantedZ = pocketFloorZ(planted.stdout);
  const want = clean.designDepth === null ? null : -clean.designDepth;
  const onFloor = want !== null && cleanZ !== null && Math.abs(cleanZ - want) < 1e-6;
  const plantShort = plantedZ !== null && want !== null && plantedZ > want + 1e-6;
  if (onFloor && plantShort) {
    pass('P3', `pocket floor Z${cleanZ.toFixed(3)} equals the design floor; planted stops at Z${plantedZ.toFixed(3)}`);
  } else {
    fail('P3', `design=${want} cut=${cleanZ} planted=${plantedZ} — the floor is not held to the design depth`);
  }
}

// --- MOVE: the part can be dragged on the workpiece, and the PROGRAM moves ------
//
// Founder, 2026-08-09: *"why I can't move the loaded object in the board?"* —
// he could not, and the two failures either side of that are both silent.
//
// 🔴 EVERY LEG BELOW READS THE EMITTED PROGRAM OR A REFUSAL. None of them reads
// `drawing_offset` back out of the report. This lane has shipped a setting that
// read as applied and changed no emitted word four separate times (`EntryMode`
// with a full-depth plunge in the program, P4's dogbone counts, P3's
// `pocketFloorZ` helper, a `JobSummary` walked off `path.moves`), and a control
// that reads the intent is green about the intent.
//
// ⚠ The plant is VACUOUS without its config — the thing it discards is 0 by
// default — so the offset is set in the same config the plant runs with. A
// negative control driven at the default would run clean forever and read as
// armed, which is exactly what `PLANT`'s registry exists to stop.
{
  const cfgFile = (name, body) => {
    const p = join(ROOT, 'target', `move-${name}.json`);
    writeFileSync(p, JSON.stringify(body));
    return p;
  };
  const BIG = { travel_x_mm: 2000, travel_y_mm: 2000 };
  // Every (X, Y) the post actually WROTE. G-code is modal — a block carries a
  // word only when it changes — so the pair is tracked across lines. Collecting
  // only blocks that carry both words would silently skip most of the program
  // and compare two short samples of it.
  const coords = (g) => {
    const out = [];
    let x = null;
    let y = null;
    for (const line of codeLines(g)) {
      let moved = false;
      for (const w of line.split(/\s+/)) {
        const m = /^([XY])(-?\d+(?:\.\d+)?)$/.exec(w);
        if (!m) continue;
        if (m[1] === 'X') x = Number(m[2]);
        else y = Number(m[2]);
        moved = true;
      }
      if (moved && x !== null && y !== null) out.push([x, y]);
    }
    return out;
  };
  // ⚠ `name` is a FILENAME, not an argument. An earlier draft of this gate
  // passed it through to the CLI as well, which gate FLAG then correctly
  // refused as a flag the subcommand does not read — exit 2, empty stdout, and
  // the turned leg failed reporting a core defect that was not there. A harness
  // fault reads exactly like a finding.
  const runOf = (name, body) => slice(['job', 'plate', '--config', cfgFile(name, body)]);

  const home = runOf('clean', { machine: BIG });
  const moved = runOf('moved', { machine: BIG, drawing_offset: [50, 25] });
  const hc = coords(home.stdout);
  const mc = coords(moved.stdout);
  const sameShape = hc.length > 0 && hc.length === mc.length;
  const everyMoveMoved =
    sameShape &&
    hc.every(([x, y], i) => Math.abs(mc[i][0] - x - 50) < 1e-6 && Math.abs(mc[i][1] - y - 25) < 1e-6);

  // The drag is measured ON THE WORKPIECE, so turning it carries the part
  // round with it. A quarter turn anticlockwise sends the workpiece's +X into the
  // machine's +Y — asserted at the controller's coordinates, because an offset
  // applied AFTER the rotation would slide the part across the material it is
  // cut from and look identical in the panel.
  const turned = coords(runOf('turn0', { machine: BIG, stock: { rotation_deg: 90 } }).stdout);
  const turnedMoved = coords(
    runOf('turn50', { machine: BIG, stock: { rotation_deg: 90 }, drawing_offset: [50, 0] }).stdout
  );
  const onTheSheet =
    turned.length > 0 &&
    turned.length === turnedMoved.length &&
    turned.every(
      ([x, y], i) =>
        Math.abs(turnedMoved[i][0] - x) < 1e-6 && Math.abs(turnedMoved[i][1] - y - 50) < 1e-6
    );

  // THE PLANT. It leaves the offset stored and reported and drops it on the way
  // to the program, so the planted run must be BYTE-IDENTICAL to the unmoved
  // one — which is the defect, stated as a consequence rather than as a claim.
  const plantCfg = { machine: BIG, drawing_offset: [50, 25] };
  const planted = slice([
    'job',
    'plate',
    '--config',
    cfgFile('plant', plantCfg),
    '--plant',
    'drawing-offset-ignored',
  ]);
  const plantWentInert = planted.stdout !== home.stdout;
  const plantRestoredTheDefect = planted.stdout === home.stdout && planted.stdout.length > 0;

  // The verification has to move WITH the part. This is DINV one term along:
  // `plan_job` places the toolpath through `Job::place`, and if
  // `simulate_and_check` had stayed on `Stock::place` the keep/remove regions
  // would have been left behind. MEASURED against that state (2026-08-09):
  // 0/0/0 clean and 4301 gouges at a 50,25 drag on this fixture.
  const simAt = (offset) => {
    const r = slice([
      'report',
      'plate',
      '--config',
      cfgFile(`sim-${offset.join('_')}`, { machine: BIG, drawing_offset: offset }),
    ]);
    try {
      const s = JSON.parse(r.stdout).sim;
      return `${s.gouge}/${s.uncut}/${s.spoilboard}`;
    } catch {
      return `unreadable(${r.code})`;
    }
  };
  const simHome = simAt([0, 0]);
  const simDrift = [
    [50, 25],
    [-30, 40],
    [200, 300],
  ]
    .map((o) => [o.join(','), simAt(o)])
    .filter(([, c]) => c !== simHome);

  // 🔴 AND THE DRAG MUST NOT BECOME A WAY ROUND P7. `fit` reports a datum shift
  // and refuses to apply one, and `layout` grades a placement rather than
  // choosing it, because THE CLAMPS DO NOT TRAVEL WITH THE PARTS. An operator
  // dragging a part into a declared clamp gets the same refusal any other
  // program into that clamp gets — no snap, no nudge, no G-code.
  const intoClamp = slice([
    'job',
    'clamped',
    '--config',
    cfgFile('into-clamp', { drawing_offset: [160, 0] }),
  ]);
  const clampRefused =
    intoClamp.code !== 0 &&
    intoClamp.stdout.trim() === '' &&
    /CutsClamp/.test(intoClamp.stderr);
  const clampClean = slice(['job', 'clamped', '--config', cfgFile('clamp-clean', {})]);
  const clampCleanEmits = clampClean.code === 0 && codeLines(clampClean.stdout).length > 0;

  if (
    everyMoveMoved &&
    onTheSheet &&
    plantRestoredTheDefect &&
    simDrift.length === 0 &&
    simHome === '0/0/0' &&
    clampRefused &&
    clampCleanEmits
  ) {
    pass(
      'MOVE',
      `all ${hc.length} emitted positions moved by exactly +50,+25; on a workpiece turned 90 deg a ` +
        `50mm drag along the WORKPIECE's X lands as +50 in the machine's Y; the plant leaves the ` +
        `program byte-identical to the unmoved one; the sim verdict stays ${simHome} at every ` +
        `drag tried; and a drag into a declared clamp is REFUSED with no program ` +
        `(${/CutsClamp \{ clamp: "[^"]+"/.exec(intoClamp.stderr)?.[0] ?? 'no finding'})`
    );
  } else if (plantWentInert) {
    fail(
      'MOVE',
      'the plant no longer plants: `--plant drawing-offset-ignored` produced a program that ' +
        'DIFFERS from the unmoved one, so this gate has no negative control and every leg ' +
        'above it is unproven'
    );
  } else if (!everyMoveMoved) {
    const bad = sameShape
      ? hc.findIndex(([x, y], i) => Math.abs(mc[i][0] - x - 50) > 1e-6 || Math.abs(mc[i][1] - y - 25) > 1e-6)
      : -1;
    fail(
      'MOVE',
      sameShape
        ? `the drag did not reach the program: move ${bad} went ${hc[bad]} -> ${mc[bad]}, not +50,+25`
        : `the offset changed the SHAPE of the program: ${hc.length} positions clean, ${mc.length} moved`
    );
  } else if (!onTheSheet) {
    fail(
      'MOVE',
      'the drag is not measured on the WORKPIECE: on a workpiece turned 90 degrees a 50mm drag along the ' +
        "workpiece's X did not land as +50 in the machine's Y, so turning the workpiece slides the part " +
        'across the material it is cut from'
    );
  } else if (simDrift.length) {
    fail(
      'MOVE',
      `the simulation verdict moved with the part: ${simHome} at rest, ` +
        simDrift.map(([at, c]) => `${at} gives ${c}`).join(', ') +
        ' — the path was placed and the regions were not, which is DINV’s defect one term along'
    );
  } else if (!clampRefused || !clampCleanEmits) {
    fail(
      'MOVE',
      `dragging a part into a declared clamp did not refuse: exit=${intoClamp.code} ` +
        `stdout=${intoClamp.stdout.length}B cleanEmits=${clampCleanEmits} — the drag has become a ` +
        'way of moving a program past P7, which is the one thing this must never do'
    );
  } else {
    fail('MOVE', `unclassified: simHome=${simHome} plantIdentical=${plantRestoredTheDefect}`);
  }
}

// --- MULTI: several drawings on one workpiece, placed, turned, and refused ------
//
// Founder, 2026-08-10: *"In the drawings I should able to add more than 1
// drawings, I should able to rotate the drawings"*.
//
// 🔴 EVERY LEG READS THE EMITTED PROGRAM OR A REFUSAL. Not the config, not the
// report's echo of a placement, not a finding count. This lane has shipped a
// setting that read as applied and changed no emitted word four separate times,
// and a control that reads the intent is green about the intent. The per-part
// coordinates below are attributed by the operation comments the post already
// writes (`( op: <drawing>/<part> …)`), so the geometry each leg asserts on is
// the geometry the controller is handed.
//
// 🔴 AND THE REFUSAL IS PAIRED. A refusal test with no positive beside it is
// indistinguishable from a gate that refuses everything — which would pass this
// row forever while making the feature unusable. So the same two parts are cut
// apart and MUST emit.
{
  const cfgFile = (name, body) => {
    const p = join(ROOT, 'target', `multi-${name}.json`);
    writeFileSync(p, JSON.stringify(body));
    return p;
  };
  const TOOL = 'End Mill - Down-cut 6mm 2F';
  const BIG = {
    tool_id: TOOL,
    machine: { travel_x_mm: 2000, travel_y_mm: 2000 },
    stock: { size_x_mm: 1200, size_y_mm: 900 },
  };
  const PLATE = 'gates/fixtures/plate.dxf';
  const OVERLAP = 'gates/fixtures/overlap.dxf';

  /**
   * Every (X, Y) the post WROTE, grouped by the part it was written for.
   *
   * G-code is modal — a block carries a word only when it changes — so the pair
   * is tracked across lines exactly as gate MOVE does. The part is taken from
   * the operation comment, which is the only place the emitted program names a
   * part at all: there is no tool table and no part table in this dialect.
   *
   * ⚠ Attribution by comment is what makes a per-part assertion possible, and it
   * is also its limit: `PostOptions::emit_comments` can switch the comments off,
   * and this helper would then see one unnamed run. That is stated rather than
   * discovered — the gate asserts below that it found the parts it expected, so
   * a program with no comments fails here loudly instead of comparing two empty
   * lists and calling them equal.
   */
  const byPart = (g) => {
    const out = new Map();
    let part = null;
    let x = null;
    let y = null;
    for (const line of g.split('\n')) {
      const t = line.trim();
      const c = /^\(\s*(?:op|drill|mark):\s*(\S+)\s/.exec(t);
      if (c) {
        // `<drawing>/<part>` and `<drawing>/<part>-holeN` are the same part.
        part = c[1].replace(/-hole\d+$/, '');
        if (!out.has(part)) out.set(part, []);
        continue;
      }
      if (!t || t.startsWith('(')) continue;
      let moved = false;
      for (const w of t.split(/\s+/)) {
        const m = /^([XY])(-?\d+(?:\.\d+)?)$/.exec(w);
        if (!m) continue;
        if (m[1] === 'X') x = Number(m[2]);
        else y = Number(m[2]);
        moved = true;
      }
      if (moved && part && x !== null && y !== null) out.get(part).push([x, y]);
    }
    return out;
  };
  const span = (pts) => ({
    n: pts.length,
    x: [Math.min(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[0]))],
    y: [Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[1]))],
  });
  const nest = (...args) => slice(['nest', ...args]);

  // --- leg 1: TWO drawings, and only the one that was moved moves ------------
  //
  // The two drawings are the SAME FILE, so any difference between the two parts
  // in one program is the placement and nothing else. `A` is never given an
  // offset; `B` is moved 300mm along the workpiece's X.
  const cfgBig = cfgFile('big', BIG);
  const twoHome = nest(
    '--drawing', PLATE, '--id', 'A',
    '--drawing', PLATE, '--id', 'B', '--offset', '300,0',
    '--config', cfgBig
  );
  const homeParts = byPart(twoHome.stdout);
  const twoMoved = nest(
    '--drawing', PLATE, '--id', 'A',
    '--drawing', PLATE, '--id', 'B', '--offset', '300,40',
    '--config', cfgBig
  );
  const movedParts = byPart(twoMoved.stdout);

  const bothPlanned = twoHome.code === 0 && twoMoved.code === 0;
  const namedBoth =
    homeParts.has('A/part1') && homeParts.has('B/part1') &&
    movedParts.has('A/part1') && movedParts.has('B/part1');
  // 🔴 The whole point of the leg: A must be byte-for-byte where it was, and B
  // must be exactly 40mm further along Y. An implementation that moved the whole
  // workpiece — the job-level offset misapplied per drawing — passes the second half
  // and fails the first, which is why both are asserted and not just the motion.
  const sameA =
    namedBoth &&
    homeParts.get('A/part1').length === movedParts.get('A/part1').length &&
    homeParts.get('A/part1').every(
      ([x, y], i) =>
        movedParts.get('A/part1')[i][0] === x && movedParts.get('A/part1')[i][1] === y
    );
  const movedB =
    namedBoth &&
    homeParts.get('B/part1').length === movedParts.get('B/part1').length &&
    homeParts.get('B/part1').every(
      ([x, y], i) =>
        Math.abs(movedParts.get('B/part1')[i][0] - x) < 1e-6 &&
        Math.abs(movedParts.get('B/part1')[i][1] - y - 40) < 1e-6
    );
  // And the two parts are not the same coordinates: a placement that silently
  // dropped B's offset would satisfy "A did not move" perfectly.
  const bIsElsewhere =
    namedBoth && span(homeParts.get('B/part1')).x[0] - span(homeParts.get('A/part1')).x[0] > 299;

  // --- leg 2: ROTATION reaches the emitted program --------------------------
  //
  // `plate.dxf` is 200 x 120. Turned a quarter turn about its own lower-left
  // corner it is 120 x 200, and the corner stays put — so the emitted X span and
  // Y span SWAP while the move count is unchanged. A rotation applied to the
  // picture and not to the geometry leaves both spans exactly as they were.
  const flat = nest('--drawing', PLATE, '--id', 'A', '--config', cfgBig);
  const turned = nest('--drawing', PLATE, '--id', 'A', '--rot', '90', '--config', cfgBig);
  const fs = flat.code === 0 && byPart(flat.stdout).has('A/part1')
    ? span(byPart(flat.stdout).get('A/part1'))
    : null;
  const ts = turned.code === 0 && byPart(turned.stdout).has('A/part1')
    ? span(byPart(turned.stdout).get('A/part1'))
    : null;
  const near = (a, b) => Math.abs(a - b) < 1e-6;
  const rotatedTheGeometry =
    fs !== null &&
    ts !== null &&
    fs.n === ts.n &&
    // the spans swapped …
    near(ts.x[1] - ts.x[0], fs.y[1] - fs.y[0]) &&
    near(ts.y[1] - ts.y[0], fs.x[1] - fs.x[0]) &&
    // … and they are genuinely different, so a square part could not pass this
    // by being unchanged.
    !near(fs.x[1] - fs.x[0], fs.y[1] - fs.y[0]) &&
    // the corner it turned about stayed where it was
    near(ts.x[0], fs.x[0]) &&
    near(ts.y[0], fs.y[0]);
  // A free angle is runnable arithmetic and a fixturing problem, so it must NOTE
  // rather than refuse — and the note must reach the operator.
  const skew = nest('--drawing', PLATE, '--id', 'A', '--rot', '37', '--config', cfgBig);
  const skewWarnsAndRuns = skew.code === 0 && /not a quarter turn/.test(skew.stderr);

  // --- leg 3: the per-drawing offset is measured ON THE WORKPIECE ---------------
  //
  // The same property gate MOVE holds for the job-level offset, asserted again
  // because this is a DIFFERENT mechanism reaching the same coordinates. Turn
  // the workpiece a quarter turn anticlockwise and its +X is the machine's
  // +Y, so a 50mm drag along the workpiece must land as +50 in the machine's Y. An
  // offset applied after the rotation would slide the part across the material
  // it is cut from and look identical in every panel.
  const TURN = { ...BIG, stock: { ...BIG.stock, rotation_deg: 90 } };
  const sheetHome = nest('--drawing', PLATE, '--id', 'A', '--config', cfgFile('turn0', TURN));
  const sheetDrag = nest(
    '--drawing', PLATE, '--id', 'A', '--offset', '50,0', '--config', cfgFile('turn50', TURN)
  );
  const hp = sheetHome.code === 0 ? byPart(sheetHome.stdout).get('A/part1') ?? [] : [];
  const dp = sheetDrag.code === 0 ? byPart(sheetDrag.stdout).get('A/part1') ?? [] : [];
  const onTheSheetPerDrawing =
    hp.length > 0 &&
    hp.length === dp.length &&
    hp.every(([x, y], i) => Math.abs(dp[i][0] - x) < 1e-6 && Math.abs(dp[i][1] - y - 50) < 1e-6);

  // --- leg 4: 🔴 THE OVERLAP REFUSAL, AND ITS PAIRED POSITIVE ---------------
  //
  // `overlap.dxf` holds two rectangles sharing 50 x 80mm of material. It must be
  // refused with NOTHING on stdout: a warning printed above a runnable file is a
  // file that gets run, which is G13's property and the reason `nest` writes its
  // refusals to stderr.
  const cfgTool = cfgFile('tool', { tool_id: TOOL });
  const shared = nest(OVERLAP, '--config', cfgTool);
  const refusedShared = shared.code !== 0 && shared.stdout.trim() === '';
  const namesBothParts =
    /part `overlap\/part\d` and part `overlap\/part\d` OVERLAP/.test(shared.stderr) &&
    /mm² shared/.test(shared.stderr);
  // It must not offer to move anything. This lane REPORTS a shift and never
  // applies one, because the clamps do not travel with the parts.
  const doesNotNudge = /re-nest, do not nudge/.test(shared.stderr);

  // THE PAIRED POSITIVE. Two parts that share no material and have room for the
  // cutter between them MUST emit — otherwise a gate that refused every workpiece
  // would be indistinguishable from one that works.
  const apart = nest(
    '--drawing', PLATE, '--id', 'A',
    '--drawing', PLATE, '--id', 'B', '--offset', '300,0',
    '--config', cfgBig
  );
  const apartEmits = apart.code === 0 && codeLines(apart.stdout).length > 0;

  // TOO CLOSE is a DIFFERENT failure with a different fix, and the message must
  // not blur them: these two share no material, and a 6mm cutter does not fit
  // the 4mm channel between them. `plate.dxf` spans X 50..250, so an offset of
  // 204 leaves exactly 4mm of clear material.
  const tight = nest(
    '--drawing', PLATE, '--id', 'A',
    '--drawing', PLATE, '--id', 'B', '--offset', '204,0',
    '--config', cfgBig
  );
  const tooCloseRefused =
    tight.code !== 0 &&
    tight.stdout.trim() === '' &&
    /TOO CLOSE to cut between/.test(tight.stderr) &&
    !/OVERLAP/.test(tight.stderr);

  // THE PLANT. It takes the check out and nothing else, so the planted run must
  // EMIT a runnable program for the very workpiece that was just refused — the state
  // this path was built to leave behind, stated as a consequence rather than as
  // a claim.
  const planted = slice(['nest', OVERLAP, '--config', cfgTool, '--plant', 'overlap-unchecked']);
  const plantRestoredTheDefect = planted.code === 0 && codeLines(planted.stdout).length > 0;
  // And a FIXTURE plant must be refused here rather than accepted and discarded:
  // `nest` builds no fixture, so honouring one would report a defect that was
  // never planted — a control that can never go red.
  const wrongPlant = slice(['nest', OVERLAP, '--config', cfgTool, '--plant', 'no-tabs']);
  const wrongPlantRefused = wrongPlant.code === 2;
  const unknownPlant = slice(['nest', OVERLAP, '--config', cfgTool, '--plant', 'no-such-plant']);
  const unknownPlantRefused = unknownPlant.code === 2;
  // `--at` is `layout`'s flag and means an absolute corner position. Accepted
  // here it would move a part by the whole distance between the drawing's own
  // origin and the workpiece's — silently, and the program would look right.
  const wrongFlag = slice(['nest', '--drawing', PLATE, '--at', '0,0', '--config', cfgTool]);
  const wrongFlagRefused = wrongFlag.code === 2 && wrongFlag.stdout.trim() === '';

  if (
    bothPlanned && namedBoth && sameA && movedB && bIsElsewhere &&
    rotatedTheGeometry && skewWarnsAndRuns && onTheSheetPerDrawing &&
    refusedShared && namesBothParts && doesNotNudge && apartEmits && tooCloseRefused &&
    plantRestoredTheDefect && wrongPlantRefused && unknownPlantRefused && wrongFlagRefused
  ) {
    pass(
      'MULTI',
      `two drawings in one program: every one of A's ${homeParts.get('A/part1').length} emitted ` +
        `positions is unchanged when B is moved, and every one of B's moves by exactly +0,+40; a ` +
        `quarter turn swaps the emitted spans ${fs.x[1] - fs.x[0]}x${fs.y[1] - fs.y[0]} -> ` +
        `${ts.x[1] - ts.x[0]}x${ts.y[1] - ts.y[0]} about a corner that stays put, and 37 degrees ` +
        `warns and still runs; a 50mm drag on a workpiece turned 90 degrees lands as +50 in the ` +
        `machine's Y; two parts sharing material are REFUSED with 0 bytes naming both, two parts ` +
        `4mm apart are refused as TOO CLOSE and not as an overlap, the same two 300mm apart emit ` +
        `${codeLines(apart.stdout).length} lines, and \`--plant overlap-unchecked\` restores the ` +
        `defect by emitting ${codeLines(planted.stdout).length} lines for the refused workpiece`
    );
  } else if (!plantRestoredTheDefect) {
    fail(
      'MULTI',
      'the plant no longer plants: `nest overlap.dxf --plant overlap-unchecked` did not emit a ' +
        `program (exit=${planted.code}, ${planted.stdout.length}B), so this gate has no negative ` +
        'control and every leg above it is unproven'
    );
  } else if (!refusedShared || !namesBothParts) {
    fail(
      'MULTI',
      `two parts cut from the same material were NOT refused: exit=${shared.code}, ` +
        `${shared.stdout.length}B on stdout. ` +
        (shared.stdout.length
          ? 'A refusal printed above a runnable program is a program that gets run'
          : `The refusal did not name both parts and the shared area: ${shared.stderr.slice(-200)}`)
    );
  } else if (!apartEmits) {
    fail(
      'MULTI',
      `the paired POSITIVE failed: two parts 300mm apart on a 1200mm workpiece were refused ` +
        `(exit=${apart.code}) — a check that refuses everything is indistinguishable from a ` +
        `working one until somebody needs two parts, and it would hold this row green forever. ` +
        `${apart.stderr.slice(-200)}`
    );
  } else if (!tooCloseRefused) {
    fail(
      'MULTI',
      `two parts 4mm apart with a 6mm cutter were not refused as TOO CLOSE (exit=${tight.code}, ` +
        `${tight.stdout.length}B) — the cutter does not fit the channel and takes the edge off ` +
        `BOTH parts. This is the failure a grid snap invites, and it is not an overlap: it has a ` +
        `different fix and must not share a message. ${tight.stderr.slice(-200)}`
    );
  } else if (!namedBoth || !bothPlanned) {
    fail(
      'MULTI',
      `a two-drawing program did not name both drawings' parts in its operation comments ` +
        `(exit ${twoHome.code}/${twoMoved.code}, found ${[...homeParts.keys()].join(',') || 'none'}) ` +
        '— without that this gate cannot attribute a coordinate to a part, so nothing below it ' +
        'is being measured'
    );
  } else if (!sameA) {
    fail(
      'MULTI',
      'moving ONE drawing moved the other: A\'s emitted coordinates changed when only B was ' +
        'given an offset. A per-drawing placement that reaches every part is the job-level ' +
        'offset wearing a per-part label, and the workpiece would be nested from a picture nobody cut'
    );
  } else if (!movedB || !bIsElsewhere) {
    fail(
      'MULTI',
      'the drawing that WAS moved did not move in the program: B\'s emitted coordinates are ' +
        `unchanged by a 40mm offset. That is this lane's most-repeated defect — a placement ` +
        'stored, displayed and dropped on the way to the machine — arriving one object along'
    );
  } else if (!rotatedTheGeometry) {
    fail(
      'MULTI',
      `a quarter turn did not reach the emitted program: spans ` +
        `${fs ? `${fs.x[1] - fs.x[0]}x${fs.y[1] - fs.y[0]}` : 'unreadable'} -> ` +
        `${ts ? `${ts.x[1] - ts.x[0]}x${ts.y[1] - ts.y[0]}` : 'unreadable'} ` +
        '(move counts ' + `${fs?.n}/${ts?.n}` + '). A part DRAWN turned whose toolpath is ' +
        'planned unturned cuts the wrong shape, and the picture is the half that looks right'
    );
  } else if (!skewWarnsAndRuns) {
    fail(
      'MULTI',
      `a 37-degree placement did not both run and warn (exit=${skew.code}): a free angle is ` +
        'runnable arithmetic and a fixturing problem — refusing it costs a legal job, and ' +
        'accepting it silently costs the operator the one fact they need to register the work'
    );
  } else if (!onTheSheetPerDrawing) {
    fail(
      'MULTI',
      'the per-drawing offset is not measured on the WORKPIECE: on a workpiece turned 90 degrees a 50mm ' +
        "drag did not land as +50 in the machine's Y, so turning the workpiece slides the part across " +
        'the material it is cut from'
    );
  } else {
    fail(
      'MULTI',
      `unclassified: wrongPlantRefused=${wrongPlantRefused} unknownPlantRefused=${unknownPlantRefused} ` +
        `wrongFlagRefused=${wrongFlagRefused} (exit ${wrongPlant.code}/${unknownPlant.code}/${wrongFlag.code}) ` +
        '— a flag or a plant this subcommand does not apply was ACCEPTED, which makes every ' +
        'control driven through it vacuous'
    );
  }
}

// --- DINV: the simulation verdict does not depend on where the workpiece sits ---
//
// Moving a workpiece on the machine cannot change what the program cuts RELATIVE TO THAT
// WORKPIECE — the geometry moves rigidly with the datum — so every simulation count
// must be identical at every datum.
//
// 🔴 This gate exists because the opposite shipped green. Measured on `plate`
// before the fix: 0 gouges at datum 0, 1027 at datum 150, and 0 AGAIN at datum
// 300. The planner places the geometry through `Stock::place()`; the
// verification regions were never placed and the height map was nailed to the
// machine origin, so the check compared a placed path against unplaced regions.
//
// ⚠ The second zero is the dangerous one. At 300 the path and the regions had
// stopped overlapping at all, so the check compared NOTHING and returned a pass
// it never earned. A false red announces itself; a vacuous green is
// indistinguishable from a clean part. Every gate passed throughout, because
// every fixture defaults to datum 0 — which is precisely the state where both
// halves of the defect are inert.
{
  const countsAt = (dx, dy) => {
    const cfgPath = join(ROOT, 'target', `dinv-${dx}-${dy}.json`);
    writeFileSync(
      cfgPath,
      JSON.stringify({
        machine: { travel_x_mm: 2000, travel_y_mm: 2000 },
        stock: { origin_x_mm: dx, origin_y_mm: dy },
      })
    );
    // ⚠ `--json` was passed here and `report` never read it — it always emits
    // JSON. Harmless in itself, and it is dropped rather than allowlisted
    // because gate FLAG now refuses any flag a subcommand does not read, and a
    // gate that needs an exemption from a rule is the first argument for
    // weakening the rule.
    const r = slice(['report', 'plate', '--config', cfgPath]);
    try {
      const sim = JSON.parse(r.stdout).sim;
      return `${sim.gouge}/${sim.uncut}/${sim.spoilboard}`;
    } catch {
      return `unreadable(${r.code})`;
    }
  };
  const base = countsAt(0, 0);
  const moved = [
    [150, 0],
    [300, 0],
    [0, 220],
    [450, 380],
  ].map(([x, y]) => [`${x},${y}`, countsAt(x, y)]);
  const drift = moved.filter(([, c]) => c !== base);

  // The control the comparison needs: a check that went SILENT would satisfy
  // "identical everywhere" perfectly. So a planted gouge must still be caught.
  const planted = slice(['job', 'plate', '--plant', 'gouge']);
  const plantedGouges = Number(/gouge=(\d+)/.exec(planted.stderr)?.[1] ?? 0);

  // 🔴 THE SECOND CONTROL, and until 2026-08-09 it was missing while the plant
  // built for it sat unused. `JobPlant::BedAnchoredSim`'s own doc comment says
  // "It exists to arm gate DINV" — and DINV drove `--plant gouge` and never
  // touched it. The plant was armed by unit tests only, which is the evidence
  // class that passed 343/343 through a live plant in `main()`.
  //
  // What it restores is the pre-fix harness itself: the height map nailed to
  // the machine origin while the toolpath is PLACED by the datum. It changes no motion —
  // the program is byte-identical — so the gouge control above cannot see it,
  // and neither can any other gate in this suite.
  //
  // ⚠ It is VACUOUS at datum 0, which is what every fixture defaults to and
  // therefore the one state anybody would naturally test it in. At the origin
  // the machine-origin anchor and the placed geometry coincide and the planted run reports
  // the same `0/0/0` a clean one does. So it is driven at a MOVED datum, and
  // the identical-program half is asserted rather than assumed — if the plant
  // ever starts changing the motion it has stopped being a control for the
  // CHECK and has become one for the cut.
  const dinvCfg = join(ROOT, 'target', 'dinv-plant.json');
  writeFileSync(
    dinvCfg,
    JSON.stringify({
      machine: { travel_x_mm: 2000, travel_y_mm: 2000 },
      stock: { origin_x_mm: 150 },
    })
  );
  const anchorClean = slice(['job', 'plate', '--config', dinvCfg]);
  const anchorPlant = slice(['job', 'plate', '--config', dinvCfg, '--plant', 'bed-anchored-sim']);
  const simOf = (r) => /sim: [^\n]*/.exec(r.stderr)?.[0] ?? 'unreadable';
  const anchorSameProgram = anchorClean.stdout === anchorPlant.stdout;
  const anchorVerdictMoved = simOf(anchorClean) !== simOf(anchorPlant);

  if (
    drift.length === 0 &&
    base === '0/0/0' &&
    plantedGouges > 100 &&
    anchorSameProgram &&
    anchorVerdictMoved
  ) {
    pass(
      'DINV',
      `verdict ${base} at every datum tried; a planted gouge still reports ${plantedGouges}; ` +
        `and bed-anchoring the map at a moved datum flips the verdict on a BYTE-IDENTICAL ` +
        `program (${simOf(anchorClean)} -> ${simOf(anchorPlant)})`
    );
  } else if (!anchorSameProgram || !anchorVerdictMoved) {
    fail(
      'DINV',
      `the bed-anchored control proves nothing: sameProgram=${anchorSameProgram} ` +
        `verdictMoved=${anchorVerdictMoved} (${simOf(anchorClean)} vs ${simOf(anchorPlant)}) — ` +
        'a plant that changes neither the program nor the verdict is not planting'
    );
  } else if (drift.length) {
    fail(
      'DINV',
      `the verdict moved with the workpiece: datum 0 gives ${base}, ` +
        drift.map(([at, c]) => `${at} gives ${c}`).join(', ')
    );
  } else {
    fail('DINV', `the counts agree but the check may be silent: planted gouge reported ${plantedGouges}`);
  }
}

// --- P4: dogbone relief ----------------------------------------------------
//
// 🔴 REWRITTEN 2026-08-10 — the previous version read the PLAN and the document
// said the opposite in print. Both halves, measured:
//
//   if (socket.dogbones === 4 && plate.dogbones === 0 && bores >= 8)
//
//   - `socket.dogbones` is scraped from `eprintln!("dogbones: {}", built.dogbones
//     .len())` — `BuiltJob::dogbones`, i.e. THE PLAN. The 4-and-0 assertion, the
//     whole substance of this gate, never touched the program. `SLICER-GATES.md`
//     claimed it "counts relief bores in the EMITTED G-code, and the reported
//     figure is derived from the moves rather than from the plan". It did not.
//   - `bores` counted EVERY `G98 G8[123]` line. The socket emits 8 canned cycles
//     — 4 drill holes AND 4 reliefs — so `>= 8` could not tell one from the
//     other, and the drills supplied half the threshold. A socket that gained
//     four holes and lost every relief satisfied it.
//
// It now counts by SECTION, which is how the program itself distinguishes them:
// `( 4 corner reliefs )` heads the relief block and `( drill: <name> [...] )`
// heads each hole. Same idea REL uses on `( op: … )`. Three consequences:
//
//   1. The count is relief-SELECTIVE and comes off the emitted text.
//   2. `plate` is the discriminating control ON EVERY PASS: it emits 4 canned
//      cycles and must yield ZERO reliefs. The old counter scores 4 there —
//      `--self-plant p4-count-all` restores it and this gate goes red.
//   3. The plan is still read, but only to assert it AGREES with the program.
//      "The plan says 4" and "the program cuts 4" are different facts and the
//      gap between them is this gate's entire history.
{
  const socket = job(['socket']);
  const plate = job(['plate']);

  // Canned cycles, attributed to the `( … )` section header above them, and the
  // XY the cycle actually commands. A cycle with no section above it is counted
  // under '' and can never be a relief — an unattributed bore is not evidence.
  const cycles = (gcode) => {
    const out = [];
    let section = '';
    for (const line of gcode.split('\n')) {
      const t = line.trim();
      const c = /^\(\s*(.*?)\s*\)$/.exec(t);
      if (c) {
        section = c[1];
        continue;
      }
      const m = /^G98 G8[123]\s+X(-?\d+(?:\.\d+)?)\s+Y(-?\d+(?:\.\d+)?)/.exec(t);
      if (m) out.push({ section, x: Number(m[1]), y: Number(m[2]) });
    }
    return out;
  };
  const gcodeOf = (name) => {
    try {
      return JSON.parse(slice(['report', name]).stdout).gcode ?? '';
    } catch {
      return '';
    }
  };
  // THE COUNTER UNDER TEST. The self-plant is the pre-fix behaviour restored,
  // and it is restored HERE rather than described in a comment, so the claim
  // "the old counter could not tell a relief from a drill hole" is something
  // this gate can be made to demonstrate rather than something it asserts.
  const isRelief = selfPlanted('p4-count-all')
    ? () => true
    : (c) => /\brelief/i.test(c.section);

  const socketCycles = cycles(gcodeOf('socket'));
  const plateCycles = cycles(gcodeOf('plate'));
  const socketReliefs = socketCycles.filter(isRelief);
  const plateReliefs = plateCycles.filter(isRelief);

  // Four reliefs at the four INSIDE CORNERS of a square socket: two distinct X
  // and two distinct Y, four distinct points. A count of four says four cycles
  // exist; this says they are at corners of a rectangle, which is what a corner
  // relief IS. Four bores stacked on one corner would satisfy a count.
  const xs = new Set(socketReliefs.map((c) => c.x.toFixed(3)));
  const ys = new Set(socketReliefs.map((c) => c.y.toFixed(3)));
  const pts = new Set(socketReliefs.map((c) => `${c.x.toFixed(3)},${c.y.toFixed(3)}`));
  const atCorners = pts.size === 4 && xs.size === 2 && ys.size === 2;

  const socketOk = socketReliefs.length === 4 && atCorners;
  const plateOk = plateReliefs.length === 0 && plateCycles.length > 0;
  const planAgrees = socket.dogbones === socketReliefs.length && plate.dogbones === plateReliefs.length;

  if (socketOk && plateOk && planAgrees) {
    pass(
      'P4',
      `4 relief bores in the socket's EMITTED program, at the 4 corners of a rectangle ` +
        `(${[...xs].join('/')} x ${[...ys].join('/')}), and the plan agrees (dogbones=${socket.dogbones}); ` +
        `the plate emits ${plateCycles.length} canned cycles and ZERO reliefs — which is the leg a ` +
        `counter that cannot tell a relief from a drill hole fails`
    );
  } else if (!plateOk) {
    fail(
      'P4',
      `the plate reports ${plateReliefs.length} relief(s) out of ${plateCycles.length} canned cycle(s) — ` +
        `a part with no inside corner has no relief, so this count is either always-on or is counting ` +
        `drill holes, which is the defect this gate was rewritten for`
    );
  } else if (!socketOk) {
    fail(
      'P4',
      `the socket's emitted program carries ${socketReliefs.length} relief bore(s) at ` +
        `${pts.size} distinct point(s) (${xs.size} X, ${ys.size} Y) out of ${socketCycles.length} ` +
        `canned cycle(s) — expected 4, at the 4 corners of a rectangle. ` +
        `A square peg will not seat in a round-cornered socket`
    );
  } else {
    fail(
      'P4',
      `the plan and the program disagree: dogbones planned socket=${socket.dogbones} plate=${plate.dogbones}, ` +
        `relief bores EMITTED socket=${socketReliefs.length} plate=${plateReliefs.length}. ` +
        `The program is the fact; a plan that reports a relief nobody cuts is this gate's own history`
    );
  }
}

// --- P5: hole sizing -------------------------------------------------------
//
// 🔴 This gate cited `--plant wrong-drill` in SLICER-GATES.md for its whole
// life and NEVER PASSED THE FLAG — it drove the `drill-check` helper, which
// asks the tool library a question and never plans a job. The plant it was
// credited with, meanwhile, added no hole and no operation: the emitted program
// was byte-identical to the clean one on all six fixtures while its note read
// `PLANTED: a 5.2mm hole with no matching drill`. **A named control that is not
// driven, pointing at a plant that does not plant** — neither half was visible
// from the other, and each made the other look covered.
//
// Both are fixed here. The helper limb is kept (it is the cheapest statement of
// the rule) and a SECOND limb drives the real product path: the plant now puts
// a genuine 5.2mm hole into the plate job, and the job must be REFUSED with no
// program — G13's property, not a warning printed above a runnable file.
{
  const exact = slice(['drill-check', '6.0']);
  const none = slice(['drill-check', '5.2']);
  const helper = exact.code === 0 && none.code !== 0 && /interpolated/.test(none.stderr);

  const clean = slice(['job', 'plate']);
  const planted = slice(['job', 'plate', '--plant', 'wrong-drill']);
  const productPath =
    clean.code === 0 &&
    clean.stdout.length > 0 &&
    planted.code !== 0 &&
    planted.stdout.trim().length === 0;
  // ...and the refusal must name the feature, or an operator cannot find it.
  const named = /wrong-drill-hole/.test(planted.stderr);

  if (helper && productPath && named) {
    pass(
      'P5',
      '6.0mm resolves to a 6mm drill and 5.2mm is refused rather than rounded; the same hole ' +
        'planted into a real job is refused by name with NO program emitted'
    );
  } else {
    fail(
      'P5',
      `helper=${helper}(exact=${exact.code} none=${none.code}) ` +
        `productPath=${productPath}(planted exit=${planted.code} stdout=${planted.stdout.length}B) ` +
        `namesFeature=${named} — a hole with no matching drill was given one`
    );
  }
}

// --- RPRB: Z is re-referenced after every tool change ----------------------
//
// A new tool is a new LENGTH. The Z datum set for the previous one describes a
// tip that is no longer there, so every cut after the change is displaced by
// the difference: short and the tenon will not seat, long and the cutter is in
// the spoilboard. Nothing about the program looks wrong — it renders, posts and
// runs.
//
// 🔴 `--plant no-reprobe` existed from the day it was written and NO GATE
// DROVE IT. `FUNCTIONAL-SPEC.md` D4 cites two unit tests, and a unit test is
// exactly the evidence that scored 343/343 on 2026-08-09 with a plant live in
// `main()` — the tests called the callee while the caller had stopped calling
// it. So this reads the EMITTED PROGRAM, and it reads the slice AFTER the tool
// change rather than counting probes over the whole file: a program that probes
// twice at the start and never again would pass a count.
//
// The second limb is the one that makes it a pair. Skipping the re-probe is
// ALLOWED — some shops set tool length offsets at the controller — but it may
// never be SILENT, so the planted run must still carry the acknowledgement
// naming the tool-length error. "Refused" and "done quietly" are different
// facts and only the first is safe to leave unstated.
{
  const afterLastChange = (g) => {
    const lines = g.split('\n');
    const last = lines.map((l) => l.trim()).lastIndexOf('M0');
    return last < 0 ? null : lines.slice(last).join('\n');
  };

  const clean = slice(['job', 'multi-tool']);
  const planted = slice(['job', 'multi-tool', '--plant', 'no-reprobe']);
  const cleanTail = afterLastChange(clean.stdout);
  const plantedTail = afterLastChange(planted.stdout);

  const changed = cleanTail !== null && plantedTail !== null;
  const cleanReprobes = changed && /G38\.2/.test(cleanTail);
  const plantedSkips = changed && !/G38\.2/.test(plantedTail);
  // Never silent: the skip must be stated, naming what it costs.
  const acknowledged = /tool length|re-reference/i.test(planted.stderr);

  if (changed && cleanReprobes && plantedSkips && acknowledged) {
    pass(
      'RPRB',
      'Z is re-referenced after the tool change in the emitted program; removing it removes the ' +
        'G38.2 from the post-change slice and is ACKNOWLEDGED, never silent'
    );
  } else if (!changed) {
    fail('RPRB', 'the multi-tool job emitted no M0 — this gate has no tool change to reason about');
  } else {
    fail(
      'RPRB',
      `cleanReprobesAfterChange=${cleanReprobes} plantedSkips=${plantedSkips} ` +
        `skipAcknowledged=${acknowledged} — a new tool ran on the old tool's Z datum`
    );
  }
}

// --- P6: collet vs shank ---------------------------------------------------
{
  const clean = job(['multi-tool']);
  const planted = job(['multi-tool', '--plant', 'oversize-shank']);
  if (clean.code === 0 && planted.code !== 0 && /will not enter the spindle/.test(planted.stderr)) {
    pass('P6', 'a 12mm shank on a 6mm collet is refused; a fittable tool still runs');
  } else if (clean.code !== 0) {
    fail('P6', `STUCK RED — an ordinary multi-tool job is refused: ${clean.stderr.trim().slice(0, 120)}`);
  } else {
    fail('P6', 'an unfittable shank was accepted');
  }
}

// --- P7: fixture keepout ---------------------------------------------------
{
  const clean = job(['clamped']);
  const planted = job(['clamped', '--plant', 'cut-clamp']);
  if (clean.code === 0 && planted.code !== 0 && /CutsClamp/.test(planted.stderr)) {
    pass('P7', 'a cut into a clamp is refused; clamps clear of the work still run');
  } else if (clean.code !== 0) {
    fail('P7', `STUCK RED — a correctly clamped job is refused: ${clean.stderr.trim().slice(0, 120)}`);
  } else {
    fail('P7', 'a toolpath through a clamp was accepted');
  }
}

// --- P7R: the keepout follows a TURNED clamp -------------------------------
//
// 🔴 THE DEFECT THIS EXISTS FOR. `Clamp` gained `rotation_deg` (TODO #57). If a
// rotation the VIEWPORT honours reaches a keepout that still tests the
// axis-aligned rectangle, the operator gets a clamp drawn where it is and
// checked where it is not — and it fails in BOTH directions. A cut into the
// real clamp passes because the box misses the steel; a sound program is
// refused because the box covers area that is empty. Only the first one breaks a
// cutter, but the second is what gets a keepout muted.
//
// ALL FOUR LIMBS RUN as of 2026-08-09 — `ClampCfg` carries `rotation_deg` and
// `JobConfig::apply` passes it to `Clamp::rotated`, so a host can finally ask
// for the thing the core could always do:
//
//   A `clear-square` at (300,60) 250x20 — off the part, MUST RUN.
//   C `hit-square`   at (50,40)  250x20 — across the profile pass at y=57,
//     MUST REFUSE with `CutsClamp` and EMPTY stdout (G13's property).
//
// A and C are the geometry the rotated limbs turn INTO each other: a 180-degree
// turn about the anchor maps each onto the other's footprint. So they are not
// scaffolding — if either stops behaving, the rotated limbs would be measuring
// nothing and this gate goes RED rather than green on a pair that means nothing.
//
//   B `clear-square` turned 180 — now lies across the same pass, MUST REFUSE.
//   D `hit-square`   turned 180 — now lies off the workpiece, MUST RUN.
//
// ⚠ THE PENDING BRANCH IS KEPT, and it is not dead code. `ClampCfg` is
// `#[serde(deny_unknown_fields)]`, so if the field is ever removed the config is
// REFUSED AT THE DOOR with `unknown field \`rotation_deg\`` and this gate returns
// to PENDING and says so, instead of quietly scoring A and C and calling the row
// covered. That branch is the reachability probe, measured rather than assumed.
//
// 🔴 And the probe is a check in its own right, not a skip. If the field is
// accepted by `ClampCfg` and NOT wired through to `Clamp::rotated`, the config
// stops being refused, B RUNS — and B running is a program that cuts into a
// clamp — so this gate goes RED, which is exactly the state that must not read
// as PENDING. That is gate FLAG's failure (a flag accepted and discarded)
// arriving on the one path where it ends in steel; it was PLANTED and watched
// red on 2026-08-09, see SLICER-GATES.md.
//
// NEGATIVE CONTROLS, three, on three different layers:
//   · CORE   — `Clamp::contains` reverted to the axis-aligned test (limb B stops
//     refusing) or widened to the rotated clamp's BOUNDING BOX (limb D stops
//     running). Both watched red in `core/src/fixture.rs::rotated_clamp_tests`,
//     where the second also caught the FIRST mirror control being vacuous.
//   · HOST   — `rotation_deg` accepted by `ClampCfg` and not passed to
//     `Clamp::rotated`: B runs (9390B, exit 0) and D refuses. Watched red.
//   · ECHO   — `report_of` dropping `rotation_deg`. Watched red 2026-08-09, and
//     it is the reason limb E exists: with only B and D, that plant left P7R,
//     P7 and FLAG ALL GREEN while the browser drew a square clamp over a turned
//     keepout. The emitted program is untouched by it, so no program-side check
//     could ever have seen it.
//
// ⚠ STILL NOT COVERED: that the browser actually USES the echoed angle when it
// draws. Limb E proves the number leaves the core; it cannot prove three.js
// turns the box. That leg is I1's, and this row does not imply it.
{
  const cfgPath = (name, obj) => {
    const p = join(ROOT, 'target', `p7r-${name}.json`);
    writeFileSync(p, JSON.stringify({ clamps: [obj] }));
    return p;
  };
  const CLEAR = { name: 'clear-square', x: 300, y: 60, w: 250, h: 20, height_mm: 40 };
  const HIT = { name: 'hit-square', x: 50, y: 40, w: 250, h: 20, height_mm: 40 };

  const a = job(['clamped', '--config', cfgPath('a', CLEAR)]);
  const c = job(['clamped', '--config', cfgPath('c', HIT)]);
  const aRuns = a.code === 0 && a.stdout.length > 0;
  const cRefuses = c.code !== 0 && /CutsClamp/.test(c.stderr) && c.stdout.trim() === '';

  // The same clamp as A, asked for turned. Today this is the reachability
  // probe; the day the field exists it IS limb B.
  const b = job(['clamped', '--config', cfgPath('b', { ...CLEAR, rotation_deg: 180 })]);
  const refusedAtTheDoor =
    b.code !== 0 && /unknown field `rotation_deg`/.test(b.stderr) && b.stdout.trim() === '';

  // 🔴 THE ARMED ANSWER FOR LIMB B *IS* A REFUSAL, so "b exited non-zero" cannot
  // be the test for "the probe is not measuring what it thinks". It was, until
  // 2026-08-09: this branch read `else if (b.code !== 0)` and sat AHEAD of the
  // armed branch, so the moment `ClampCfg` carried `rotation_deg` the gate went
  // STUCK RED on its own success — a turned clamp correctly refused with
  // `CutsClamp` reported as an unexplained refusal, and the armed branch below
  // was unreachable by construction. The self-arming claim in the header was
  // therefore untestable while it was PENDING, which is exactly the class of
  // green (here, of pending) nobody watches. Narrowed to refusals that are NOT
  // the keepout speaking — a parse error, a different finding — so a genuinely
  // mismeasuring probe still goes red. The armed assertions are untouched.
  const refusedForAnotherReason = b.code !== 0 && !refusedAtTheDoor && !/CutsClamp/.test(b.stderr);

  if (!aRuns || !cRefuses) {
    fail(
      'P7R',
      `the pair the rotated limbs turn into each other does not behave: ` +
        `clearRuns=${aRuns}(exit=${a.code} stdout=${a.stdout.length}B) ` +
        `hitRefuses=${cRefuses}(exit=${c.code} stdout=${c.stdout.length}B) — ` +
        `until these two hold, a rotated limb would be measuring nothing`
    );
  } else if (refusedAtTheDoor) {
    pend(
      'P7R',
      `the CORE turns a clamp and the keepout follows it (core/src/fixture.rs::rotated_clamp_tests, ` +
        `both directions planted red) — but no product host can ask for it: ` +
        `\`ClampCfg\` has no \`rotation_deg\` and denies unknown fields, so this config is refused ` +
        `at the door (exit=${b.code}, stdout empty). NOT covered end to end. Arms itself the day ` +
        `\`ClampCfg\` carries \`rotation_deg\` and \`JobConfig::apply\` passes it to \`Clamp::rotated\``
    );
  } else if (refusedForAnotherReason) {
    fail(
      'P7R',
      `the reachability probe is not measuring what it thinks: the rotated config was refused for ` +
        `some OTHER reason — ${b.stderr.trim().slice(0, 200)}`
    );
  } else {
    // Armed: the field is reachable, so B and D are real limbs now.
    const d = job(['clamped', '--config', cfgPath('d', { ...HIT, rotation_deg: 180 })]);
    const bRefuses =
      b.code !== 0 && /CutsClamp/.test(b.stderr) && /clear-square/.test(b.stderr) && b.stdout.trim() === '';
    const dRuns = d.code === 0 && d.stdout.length > 0;

    // LIMB E — the OTHER host, and the one this gate could not see until
    // 2026-08-09. The viewport does not draw clamps from the config it posted;
    // it draws them from the report `report_of` hands back. So a rotation that
    // reaches `Clamp::rotated` but not that echo gives the browser a SQUARE
    // clamp drawn over a keepout that turned — the same look-right /
    // checked-wrong failure as limb B, arriving through the picture instead of
    // through the program. Measured, not reasoned about: an echo-drop plant was
    // watched leaving B, D, P7 and FLAG all green.
    //
    // 37 degrees, deliberately — not 180. A dropped field reads 0, and a field
    // wired to the wrong constant reads 180; only an angle that is neither
    // catches both. Off the part, so the job runs and the echo is the only
    // thing under test.
    const e = slice(['report', 'clamped', '--config', cfgPath('e', { ...CLEAR, rotation_deg: 37 })]);
    let echoed = null;
    try {
      echoed = JSON.parse(e.stdout).clamps?.[0]?.rotation_deg ?? null;
    } catch {
      echoed = null;
    }
    const eEchoes = e.code === 0 && echoed === 37;

    if (bRefuses && dRuns && eEchoes) {
      pass(
        'P7R',
        'a clamp turned 180 degrees about its anchor is checked WHERE IT IS: the off-part clamp ' +
          'turned across the profile pass is refused with empty stdout, and the clamp turned off ' +
          'the workpiece stops being a keepout — and the report the VIEWPORT draws from echoes the ' +
          'angle back (37 deg in, 37 deg out), so the picture and the keepout cannot come from ' +
          'two different numbers'
      );
    } else if (bRefuses && dRuns) {
      fail(
        'P7R',
        `the keepout turns but the PICTURE does not: the report echoed rotation_deg=${echoed} for a ` +
          `clamp declared at 37 (exit=${e.code}). The browser draws clamps from this report, so it ` +
          `would render a clamp square to the machine's axes over a keepout that is not — an operator looking ` +
          `at a clear machine while the checker is refusing, or worse, at a clamp that is not where the ` +
          `steel is`
      );
    } else {
      fail(
        'P7R',
        `turnedClampBites=${bRefuses}(exit=${b.code} stdout=${b.stdout.length}B) ` +
          `turnedClampReleases=${dRuns}(exit=${d.code} stdout=${d.stdout.length}B) — ` +
          `the picture and the keepout are not computed from the same number. ` +
          `A false GREEN here is a cutter into a clamp; a false RED is a keepout that gets muted`
      );
    }
  }
}

// --- P8: nest transform ----------------------------------------------------
//
// 🔴 REWRITTEN 2026-08-10. What this gate used to be, in full:
//
//   const moved    = slice(['nest-check', '30', '500', '400']);
//   const identity = slice(['nest-check', '0', '0', '0']);
//   if (moved.code === 0 && identity.code === 0 && /4 holes/.test(moved.stdout))
//
// Two exit codes and one substring — against `core/src/fixtures.rs::nest_check`,
// whose doc comment opens `/// Gate P8:` and which NOTHING ELSE CALLS. The check
// it advertised happened inside a core function written for, and reachable only
// by, this gate: P8 re-implemented the transform on `plate()` and then checked
// its own arithmetic. **No plant, no failing input, no product path.** The
// `identity` limb was decoration (at rot=dx=dy=0 the expected position equals
// the original by construction) and `/4 holes/` also matches `14 holes`.
// `SLICER-GATES.md` calls this the highest-consequence gate on the list.
//
// It is now asserted on the EMITTED PROGRAM of the `nest` path — the one an
// operator actually uses — with the expected transform computed HERE, from the
// clean run, independently of the code under test. The hazard P8 names is
// `build_nest.py` dropping internal holes, so the interior features are followed
// by name: four drill cycles, at positions this gate works out for itself.
//
//   T   a pure translation must move EVERY emitted position by exactly that
//       amount — 363 of them on this fixture, not just the holes. A transform
//       that moved the outline and left the holes behind is the defect, and a
//       holes-only check cannot see its mirror image.
//   R   a pure rotation must carry the four holes as a RIGID SET: each centred
//       hole vector equals the clean one rotated by exactly the angle asked
//       for. This needs no knowledge of the rotation anchor, which is the point
//       — an assertion that had to be told the anchor could be satisfied by a
//       core that rotates about the wrong one.
//   RT  rotation and offset composed: the offset lands in MACHINE coordinates
//       AFTER the rotation. Measured, then asserted — the alternative (an
//       offset turned with the part) is a different program and this says which
//       one we ship.
//   N   exactly four canned cycles. Not `>= 4`, not a substring.
//
// The old `nest-check` limbs are kept as corroboration and demoted to that, with
// the count anchored so `14 holes` cannot satisfy it.
//
// NON-VACUITY: `--self-plant p8-expect-shift` moves this gate's own expectation
// by 1mm. A comparison that cannot fail proves nothing, and the expectation is
// the half that is easy to write so that it always agrees.
{
  const TOOL = 'End Mill - Down-cut 6mm 2F';
  const cfg = join(ROOT, 'target', 'p8-nest.json');
  writeFileSync(cfg, JSON.stringify({ tool_id: TOOL }));
  const DXF = join(ROOT, 'gates/fixtures/plate.dxf');
  const nest = (rot, dx, dy) =>
    slice(['nest', '--drawing', DXF, '--rot', String(rot), '--offset', `${dx},${dy}`, '--config', cfg]);

  // Every (X, Y) the post WROTE, tracked across lines because G-code is modal.
  // Same reader MOVE uses, for the same reason: collecting only blocks carrying
  // both words silently skips most of the program.
  const coords = (g) => {
    const out = [];
    let x = null;
    let y = null;
    for (const line of codeLines(g)) {
      let moved = false;
      for (const w of line.split(/\s+/)) {
        const m = /^([XY])(-?\d+(?:\.\d+)?)$/.exec(w);
        if (!m) continue;
        if (m[1] === 'X') x = Number(m[2]);
        else y = Number(m[2]);
        moved = true;
      }
      if (moved && x !== null && y !== null) out.push([x, y]);
    }
    return out;
  };
  const holesOf = (g) =>
    codeLines(g)
      .map((l) => /^G98 G8[123]\s+X(-?\d+(?:\.\d+)?)\s+Y(-?\d+(?:\.\d+)?)/.exec(l.trim()))
      .filter(Boolean)
      .map((m) => [Number(m[1]), Number(m[2])]);

  // Coordinates are emitted at 3dp, so half an ulp is 5e-4 per word and a
  // centroid of four of them can carry that far. 2e-3 is a tolerance on
  // ROUNDING, not on geometry — 1mm of drift fails it by three orders.
  const TOL = 2e-3;
  const D = [137, 42];
  const ROT = 30;
  // THE EXPECTATION UNDER TEST. Salted by the self-plant, and only here — the
  // measured side is never touched, so a planted run compares a true reading
  // against a wrong expectation, which is the direction that proves the
  // comparison is live.
  const bias = selfPlanted('p8-expect-shift') ? 1 : 0;

  const clean = nest(0, 0, 0);
  const moved = nest(0, D[0], D[1]);
  const turned = nest(ROT, 0, 0);
  const both = nest(ROT, D[0], D[1]);
  const runs = [clean, moved, turned, both];
  const allEmit = runs.every((r) => r.code === 0 && codeLines(r.stdout).length > 0);

  const cH = holesOf(clean.stdout);
  const mH = holesOf(moved.stdout);
  const tH = holesOf(turned.stdout);
  const bH = holesOf(both.stdout);
  const counts = [cH, mH, tH, bH].map((h) => h.length);
  const fourHoles = counts.every((n) => n === 4);

  // T — the whole program, position by position.
  const cAll = coords(clean.stdout);
  const mAll = coords(moved.stdout);
  // ⚠ ONE predicate, used by the assertion AND by the diagnostic. The first
  // draft recomputed the comparison without `bias` when composing the failure
  // message, so the planted run failed correctly and then reported
  // "first disagreement at index -1" — a true red with a message that says
  // nothing disagreed. Found by running the plant, which is what plants are for.
  const dragOk = ([x, y], i) =>
    mAll[i] && Math.abs(mAll[i][0] - x - D[0] - bias) < TOL && Math.abs(mAll[i][1] - y - D[1]) < TOL;
  const translated = cAll.length > 0 && cAll.length === mAll.length && cAll.every(dragOk);

  // R — rigid rotation by exactly ROT, anchor-free.
  const mean = (pts) => [
    pts.reduce((s, p) => s + p[0], 0) / pts.length,
    pts.reduce((s, p) => s + p[1], 0) / pts.length,
  ];
  let rotated = false;
  let rotWhy = '';
  if (fourHoles) {
    const th = ((ROT + bias) * Math.PI) / 180;
    const [cx, cy] = mean(cH);
    const [tx, ty] = mean(tH);
    const want = cH.map(([x, y]) => [
      (x - cx) * Math.cos(th) - (y - cy) * Math.sin(th),
      (x - cx) * Math.sin(th) + (y - cy) * Math.cos(th),
    ]);
    const got = tH.map(([x, y]) => [x - tx, y - ty]);
    // Matched as a SET: the router is free to reorder the four drills, and it
    // does. A bijection is required, so two holes landing on one point cannot
    // both match it — which is how "a hole was dropped and another duplicated"
    // is caught by a check that would otherwise only count to four.
    const used = new Set();
    rotated = want.every((w) => {
      const j = got.findIndex((g, k) => !used.has(k) && Math.abs(g[0] - w[0]) < TOL && Math.abs(g[1] - w[1]) < TOL);
      if (j < 0) return false;
      used.add(j);
      return true;
    });
    if (!rotated) rotWhy = `clean ${JSON.stringify(cH)} -> turned ${JSON.stringify(tH)}`;
  }

  // RT — the offset lands in machine coordinates, after the rotation.
  let composed = false;
  if (fourHoles) {
    const used = new Set();
    composed = tH.every(([x, y]) => {
      const j = bH.findIndex(
        (b, k) => !used.has(k) && Math.abs(b[0] - x - D[0] - bias) < TOL && Math.abs(b[1] - y - D[1]) < TOL
      );
      if (j < 0) return false;
      used.add(j);
      return true;
    });
  }

  // Corroboration only — a core helper written for this gate, kept because it
  // is cheap and dropped from the substance of the claim. `\b4 holes\b`, not
  // `4 holes`, because the latter is satisfied by `14 holes`.
  const nc = slice(['nest-check', '30', '500', '400']);
  const ncIdentity = slice(['nest-check', '0', '0', '0']);
  const helperAgrees = nc.code === 0 && ncIdentity.code === 0 && /\b4 holes\b/.test(nc.stdout);

  if (allEmit && fourHoles && translated && rotated && composed && helperAgrees) {
    pass(
      'P8',
      `nest EMITS and the interior geometry survives it: all ${cAll.length} emitted positions move by ` +
        `exactly +${D[0]},+${D[1]} on a pure drag; the 4 interior holes are the same rigid set turned ` +
        `exactly ${ROT} deg (matched as a set, bijection required); and the offset composes AFTER the ` +
        `rotation in machine coordinates. Helper \`nest-check\` agrees`
    );
  } else if (!allEmit) {
    fail(
      'P8',
      `the nest path did not emit a program to check: exits ${runs.map((r) => r.code).join('/')}, ` +
        `bytes ${runs.map((r) => r.stdout.length).join('/')} — ${(runs.find((r) => r.code !== 0)?.stderr ?? '').trim().slice(0, 200)}`
    );
  } else if (!fourHoles) {
    fail(
      'P8',
      `interior features were LOST by the transform: 4 holes in the drawing, ${counts.join('/')} canned ` +
        `cycles emitted across clean/moved/turned/both. This is the hazard by name — the outlines are ` +
        `right and the part has no holes`
    );
  } else if (!translated) {
    fail(
      'P8',
      `a pure drag did not move the whole program by exactly +${D[0] + bias},+${D[1]}: ` +
        `${cAll.length} clean positions vs ${mAll.length} moved` +
        (() => {
          const i = cAll.findIndex((p, k) => !dragOk(p, k));
          return i < 0 ? '' : `, first disagreement at index ${i}: ${JSON.stringify(cAll[i])} -> ${JSON.stringify(mAll[i] ?? null)}`;
        })()
    );
  } else if (!rotated) {
    fail('P8', `the 4 holes are not the clean set turned ${ROT} deg about one centre: ${rotWhy}`);
  } else if (!composed) {
    fail(
      'P8',
      `rotation and offset do not compose as measured: turned ${JSON.stringify(tH)} + (${D}) != ` +
        `${JSON.stringify(bH)} — the offset is being applied in some other frame than the machine's`
    );
  } else {
    fail('P8', `the core helper disagrees with the emitted program: nest-check exit ${nc.code}/${ncIdentity.code}, stdout ${JSON.stringify(nc.stdout.trim().slice(0, 80))}`);
  }
}

// --- P9: material removal simulation ---------------------------------------
{
  const clean = job(['plate']);
  const planted = job(['plate', '--plant', 'gouge']);
  if (clean.gouge === 0 && planted.gouge > 100) {
    pass('P9', `a clean plate simulates with 0 gouged cells; a planted cut shows ${planted.gouge}`);
  } else {
    fail('P9', `clean=${clean.gouge} planted=${planted.gouge} — the simulation does not separate them`);
  }
}

// --- B2/B4: datum and material both reach the emitted program ---------------
{
  const write = (obj) => {
    const f = join(ROOT, 'target', `gatecfg-${Object.keys(obj).join('-')}.json`);
    writeFileSync(f, JSON.stringify(obj));
    return f;
  };
  const rep = (cfgPath) => {
    const r = slice(cfgPath ? ['report', 'plate', '--config', cfgPath] : ['report', 'plate']);
    try {
      return JSON.parse(r.stdout);
    } catch {
      return null;
    }
  };

  const base = rep(null);
  // B2: the datum must move every coordinate, and it must reach the LIMIT
  // CHECK — a datum that shifts the drawing but not the check is decoration.
  const moved = rep(write({ stock: { origin_x_mm: 100, origin_y_mm: 25 } }));
  const offTable = rep(write({ stock: { origin_x_mm: 500 } }));
  const datumMoves =
    base && moved && Math.abs(moved.deepest_z_mm - base.deepest_z_mm) < 1e-9 &&
    base.gcode !== moved.gcode;
  const datumBounds = offTable && offTable.ok === false;

  // B4: material must change the program, and refuse what it cannot take.
  const alu = rep(write({ material: 'Aluminium', op: { depth_per_pass_mm: 6, rpm: 24000 } }));
  const aluClamped =
    alu &&
    alu.notes.some((n) => n.includes('depth per pass reduced')) &&
    alu.notes.some((n) => n.includes('spindle reduced')) &&
    alu.estimated_seconds > (base?.estimated_seconds ?? 0) * 3;
  // ...and an unknown material must NOT silently become plywood.
  const bogus = rep(write({ material: 'Unobtainium' }));
  const bogusReported = bogus && bogus.notes.some((n) => n.includes("unknown material"));

  if (datumMoves && datumBounds && aluClamped && bogusReported) {
    pass('B2B4', 'the datum shifts the program and the limit check; material bounds feed/depth/rpm');
  } else {
    fail(
      'B2B4',
      `datumMoves=${!!datumMoves} datumChecked=${!!datumBounds} ` +
        `materialClamped=${!!aluClamped} unknownReported=${!!bogusReported}`
    );
  }
}

// --- DOC: depth-of-cut and chipload ceilings (decision #38 §A) --------------
//
// PHYSICAL FAILURE, in the order it actually happens on this machine — and the
// order matters, because the loud one is not the first one:
//
//   1. The wall is TAPERED. Tool-tip deflection on the ⌀6 at 25mm stickout is
//      ~1.05 µm/N, i.e. 8–40 µm at the old numbers, before any gantry
//      deflection, against FR3's 100 µm budget for finger/dogbone fit. The part
//      comes off the machine looking perfect, the joint does not seat, and it
//      gets blamed on the CAD. This failure is DIAGNOSTICALLY SILENT and it
//      recurs on every job.
//   2. The glue line burns and the flute packs — worst with a down-cut in a
//      full-depth slot, which is the library's first ⌀6 entry.
//   3. The part breaks free with the cutter buried a full diameter deep. Cost
//      is a sheet of 18mm structural ply; the expensive consumable in this
//      failure is the MATERIAL, not the tool.
//
// ⚠ What this gate is NOT arguing: the spindle will not stall and the cutter
// will not snap in steady state on a 2.2 kW C-Beam gantry — 2.2 kW against
// ~170 W of cut, ~50 N against a ~180 N cutter limit (`cad`,
// cnc_e2e_requirements.md §3.2). Overstating that would be a false red, and a
// false red lies exactly like a false green.
//
// 🔴 MEASURED ON THE EMITTED PROGRAM, never on `Material::max_doc_ratio()`.
// The depth comes out of the Z of each pass floor in the G-code and the chip
// multiplier out of the emitted F and S words. A gate that read the constant
// would be green about the constant — which is the shape that already caught
// this lane out four times (P3, P4, ENT, the JobSummary).
//
// 🔴 CEILINGS, not equalities. Any later REDUCTION stays green; any increase
// goes red. Raising these needs a physical coupon (#38 §B1) and no output of
// this program has ever cut anything.
{
  // Tool with a known diameter so a depth becomes a RATIO. `entry: Plunge` and
  // `lead_mm: 0` are not a preference — a ramped lead-in writes intermediate Z
  // values into the section and the pass floors stop being separable from them.
  const TOOL = 'End Mill - Up-cut 6mm 2F';
  const D = 6.0;

  // #38 §A. Plywood is the chip reference by definition, so its factor is 1.00
  // and is not an independent claim.
  const CEIL = {
    Plywood: { doc: 0.5, chip: 1.0 },
    MDF: { doc: 0.5, chip: 1.0 },
    Softwood: { doc: 0.5, chip: 1.1 },
    Hardwood: { doc: 0.5, chip: 0.8 },
    Acrylic: { doc: 0.5, chip: 0.75 },
    Aluminium: { doc: 0.15, chip: 0.35 },
  };

  // ⚠ THE DEFECT, kept as data so the checker can be watched refusing it on
  // every run. These are the pre-#38 values as they were EMITTED. Nothing may
  // read this table as permission — it exists to be rejected.
  const PRE_38 = {
    Plywood: { doc: 1.0, chip: 1.0 },
    MDF: { doc: 1.0, chip: 1.1 },
    Softwood: { doc: 1.0, chip: 1.2 },
    Hardwood: { doc: 0.75, chip: 0.8 },
    Acrylic: { doc: 0.5, chip: 1.15 },
    Aluminium: { doc: 0.15, chip: 0.35 },
  };

  /** Emitted pass floors, spindle speed and cutting feed of the outer profile. */
  const measure = (material) => {
    const f = join(ROOT, 'target', `gatecfg-doc-${material}.json`);
    writeFileSync(
      f,
      JSON.stringify({
        material,
        tool_id: TOOL,
        // Ask for far more than any material can take: the number that reaches
        // the program is then the CEILING itself, not the caller's request.
        op: { depth_per_pass_mm: 99, entry: 'Plunge', lead_mm: 0 },
      })
    );
    let j = null;
    try {
      j = JSON.parse(slice(['report', 'plate', '--config', f]).stdout);
    } catch {
      return null;
    }
    if (!j?.gcode) return null;

    let rpm = null;
    let inProfile = false;
    const floors = [];
    let feed = 0;
    for (const raw of j.gcode.split('\n')) {
      const l = raw.trim();
      if (l.startsWith('(')) {
        // A section scanner must close on EVERY header, not the one kind it was
        // written for — the P3 lesson, which read a drill's Z as a pocket floor.
        inProfile = /^\(\s*op:\s*plate\s*\[/.test(l);
        continue;
      }
      const s = /^M3 S([\d.]+)/.exec(l);
      if (s) rpm = Number(s[1]);
      if (!inProfile) continue;
      const z = /^G1 Z(-?[\d.]+) F[\d.]+$/.exec(l);
      if (z) floors.push(Number(z[1]));
      const fw = /F([\d.]+)/.exec(l);
      // The cutting feed is the fast one; the other F in the section is the
      // plunge.
      if (fw) feed = Math.max(feed, Number(fw[1]));
    }
    if (!rpm || floors.length === 0 || feed === 0) return null;

    // The deepest single bite the program actually takes, from the surface down.
    const sorted = [...new Set(floors)].sort((a, b) => b - a);
    let prev = 0;
    let doc = 0;
    for (const z of sorted) {
      doc = Math.max(doc, prev - z);
      prev = z;
    }
    // feed = rpm x flutes x chipload x factor, and flutes and chipload are the
    // same tool in every run — so feed/rpm normalised against plywood IS the
    // material factor, with no library constant copied into this gate.
    return { doc: doc / D, perRev: feed / rpm };
  };

  /**
   * THE CHECK. Shared by the product limb and by the in-gate control, because a
   * control that exercises a different checker than the product does proves
   * nothing about the one that ships.
   */
  const over = (table) =>
    Object.entries(CEIL)
      .filter(([m, c]) => table[m] && (table[m].doc > c.doc + 1e-6 || table[m].chip > c.chip + 1e-6))
      .map(([m]) => m);

  const measured = {};
  let unreadable = null;
  for (const m of Object.keys(CEIL)) {
    const r = measure(m);
    if (!r) {
      unreadable = m;
      break;
    }
    measured[m] = r;
  }

  // Normalise the per-rev chip against plywood to recover the material factor.
  if (!unreadable) {
    const ref = measured.Plywood.perRev;
    for (const m of Object.keys(measured)) measured[m].chip = measured[m].perRev / ref;
  }

  // --- limb 3: the compression cutter the depth cap turns into an up-cut ----
  // #38 §A3. The cap is what CREATES this failure, so the warning is measured
  // in the same gate rather than in a follow-up one.
  const rec = (extra) => {
    const r = slice(['recommend', join(ROOT, 'gates/fixtures/plate.svg'), '--json', ...extra]);
    try {
      return JSON.parse(r.stdout).choices[0];
    } catch {
      return null;
    }
  };
  const torn = (c) => !!c && c.notes.some((n) => n.includes('TEARS OUT THE TOP VENEER'));
  // A 6mm collet with no spares leaves only 6mm tools holdable, so the outer
  // profile falls to the compression cutter. 18mm at 0.50xD is 6 passes.
  const multiPass = rec(['--collet', '6']);
  // Control A: the SAME cutter in one pass must be silent, or the warning is a
  // constant that also fires on the one job this cutter is for.
  const onePass = rec(['--collet', '6', '--thickness', '2.5']);
  // Control B: same depth, same pass count, different flute type.
  const notCompression = rec([]);
  const warnOk =
    torn(multiPass) &&
    multiPass.limits.passes > 1 &&
    !torn(onePass) &&
    onePass?.limits?.passes === 1 &&
    !torn(notCompression) &&
    (notCompression?.limits?.passes ?? 0) > 1;

  // --- the in-gate negative control ----------------------------------------
  // 🔴 Run on EVERY pass, not once at arming time. It feeds the same `over()`
  // the product limb uses with the pre-#38 numbers and requires it to name
  // Plywood, MDF, Softwood, Hardwood and Acrylic. A checker that cannot see the
  // defect it was written for is not a checker, and nothing else in this file
  // would notice it having gone blind.
  const controlSaw = over(PRE_38).sort().join(',');
  const controlOk = controlSaw === 'Acrylic,Hardwood,MDF,Plywood,Softwood';

  const breached = unreadable ? [] : over(measured);
  if (unreadable) {
    fail('DOC', `could not read the emitted program for ${unreadable} — a check that cannot run is not a check that passed`);
  } else if (!controlOk) {
    fail('DOC', `the in-gate control is blind: the pre-#38 table should breach 5 materials, it named [${controlSaw}]`);
  } else if (breached.length) {
    fail(
      'DOC',
      `${breached.length} material(s) cut deeper or thicker than #38 §A defends: ` +
        breached
          .map(
            (m) =>
              `${m} doc=${measured[m].doc.toFixed(3)}xD (max ${CEIL[m].doc}) chip=x${measured[m].chip.toFixed(3)} (max x${CEIL[m].chip})`
          )
          .join(' | ')
    );
  } else if (!warnOk) {
    fail(
      'DOC',
      `compression warning wrong: multiPass=${torn(multiPass)}@${multiPass?.limits?.passes} ` +
        `onePass=${torn(onePass)}@${onePass?.limits?.passes} upcut=${torn(notCompression)}@${notCompression?.limits?.passes}`
    );
  } else {
    pass(
      'DOC',
      `emitted depth <= ceiling on all 6 materials (ply/mdf/soft/hard ${measured.Plywood.doc.toFixed(2)}xD, alu ${measured.Aluminium.doc.toFixed(2)}xD); ` +
        `chip x${measured.Acrylic.chip.toFixed(2)} acrylic / x${measured.Softwood.chip.toFixed(2)} softwood; ` +
        `a compression cutter in ${multiPass.limits.passes} passes names the torn veneer and is silent at 1 pass; ` +
        `control rejected the pre-#38 table on 5 materials`
    );
  }
}

// --- TECH: the second-technology seam ---------------------------------------
//
// 🔴 HONESTLY DOWNGRADED 2026-08-10, AND THE DOWNGRADE IS THE POINT. The row
// this gate is listed under says its control is *"`Technology::Fdm` must
// refuse"* and the failure it guards is *"an unimplemented process posted as
// CNC"*. Measured: **that failure cannot occur, so this gate cannot go red for
// the reason it exists.** `Technology::Fdm` is reachable from exactly one place
// in the whole CLI — the `dialect-rules` REPORTING subcommand
// (`cli/src/main.rs:899`). No `job`, `report`, `import`, `nest` or `fixture`
// path takes a technology, so no job can be posted as the wrong one, and the
// declared control was a restatement of one of the gate's own limbs.
//
// Everything this gate asserted was a METADATA DUMP — `implemented`, `has_post`
// and two substrings out of the `why` fields. That is the exact shape
// `AGENTS.md` bans: assert on the emitted program, not on the setting that was
// supposed to produce it.
//
// What this lane can honestly hold today, without a `--tech` flag it is not
// this file's job to add:
//
//   1. THE DECLARATION (kept, unchanged, and now labelled as what it is).
//   2. AN UNKNOWN TECHNOLOGY IS REFUSED, NOT APPROXIMATED. This is the limb
//      that gives the gate a reachable red, and it is red today.
//   3. THE BAN LISTS BITE A REAL PROGRAM. The old limbs checked that each list
//      MENTIONED the other process. This runs FDM's list over the CNC fixture's
//      emitted G-code and requires it to HIT — because a ban list that matches
//      nothing is indistinguishable from an empty one, and G2 would then pass
//      on anything the day a job could ask for FDM.
//
// ⚠ WHAT REMAINS UNCOVERED, and it is the whole original claim: nothing here
// posts a job as a technology, so *"an FDM job silently posted as grblHAL"* is
// still unwitnessed. It arms the day a product path takes a technology. Until
// then this row is a DECLARATION check and `SLICER-GATES.md` says so.
{
  let cnc = null;
  let fdm = null;
  try {
    cnc = JSON.parse(slice(['dialect-rules', 'cnc']).stdout);
    fdm = JSON.parse(slice(['dialect-rules', 'fdm']).stdout);
  } catch {
    /* null */
  }
  const cncOk = cnc?.implemented === true && cnc?.has_post === true;
  const fdmDeclared = fdm?.implemented === false && fdm?.has_post === false;
  const cncBansE = (cnc?.banned ?? []).some((b) => b.why.includes('extruder'));
  const fdmBansSpindle = (fdm?.banned ?? []).some((b) => b.why.includes('spindle'));

  // LIMB 2 — refuse rather than approximate. An unknown technology must not be
  // answered; a name nobody implemented is a question this program cannot have
  // an answer to.
  const bogus = slice(['dialect-rules', 'no-such-technology']);
  let bogusTech = null;
  try {
    bogusTech = JSON.parse(bogus.stdout).technology ?? null;
  } catch {
    /* refused, or unparseable — both are covered by the exit code below */
  }
  const unknownRefused = bogus.code !== 0 && bogus.stdout.trim() === '';

  // LIMB 3 — the FDM ban list, run over a real CNC program. `codeLines` because
  // the preamble comment legitimately NAMES what is banned (G2 and G12 both
  // false-failed on exactly that).
  const cncProgram = codeLines(slice(['fixture', 'rect-arcs']).stdout).join('\n');
  const fdmHits = (fdm?.banned ?? [])
    .filter((b) => new RegExp(b.pattern).test(cncProgram))
    .map((b) => b.why);
  const listBites = cncProgram.length > 0 && fdmHits.length > 0;

  if (cncOk && fdmDeclared && cncBansE && fdmBansSpindle && unknownRefused && listBites) {
    pass(
      'TECH',
      `CNC implemented with a post; FDM declared, not implemented, no post; an unknown technology is ` +
        `REFUSED (exit ${bogus.code}, no stdout); and FDM's ban list BITES a real CNC program ` +
        `(${fdmHits.join(', ')}) so it is not an empty list agreeing with everything. ` +
        `⚠ NOT COVERED: no product path takes a technology, so a job posted as the wrong one is ` +
        `still unwitnessed — this row is a DECLARATION check`
    );
  } else if (!unknownRefused) {
    fail(
      'TECH',
      `an unknown technology was ANSWERED, not refused: \`dialect-rules no-such-technology\` exited ` +
        `${bogus.code} and returned the ${bogusTech ?? 'unparseable'} ruleset with ` +
        `${bogus.stdout.trim().length} bytes on stdout. ` +
        `\`cli/src/main.rs:899\` matches \`Some("fdm") | Some("FDM")\` and falls through \`_ =>\` to ` +
        `Cnc, so every typo, every future technology name AND A MISSING ARGUMENT are all answered as ` +
        `CNC. That is "an unimplemented process answered as CNC" — this gate's own headline failure, ` +
        `on the one path that can reach it. Refuse rather than approximate: exit non-zero, no stdout. ` +
        `⚠ Owned by cli/, not by gates/`
    );
  } else if (!listBites) {
    fail(
      'TECH',
      `FDM's ban list matched NOTHING in a real CNC program (${cncProgram.length} bytes of code lines) — ` +
        `a list that never fires is indistinguishable from an empty one, and G2 asks the core for ` +
        `exactly this kind of list`
    );
  } else {
    fail(
      'TECH',
      `cncImplemented=${cncOk} fdmDeclaredNotBuilt=${fdmDeclared} ` +
        `cncBansExtruder=${cncBansE} fdmBansSpindle=${fdmBansSpindle}`
    );
  }
}

// --- C6: user tool library --------------------------------------------------
{
  const w = (name, obj) => {
    const f = join(ROOT, 'target', `gatecfg-${name}.json`);
    writeFileSync(f, JSON.stringify(obj));
    return f;
  };
  const rep = (p) => {
    try {
      return JSON.parse(slice(['report', 'plate', '--config', p]).stdout);
    } catch {
      return null;
    }
  };
  const tool = (over) => ({
    id: 'Shop 6mm 1F',
    category: 'End Mill',
    diameter_mm: 6,
    flutes: 1,
    shank_mm: 6,
    cutting_length_mm: 22,
    chipload_mm: 0.18,
    chipload_min_mm: 0.08,
    chipload_max_mm: 0.3,
    rpm_min: 10000,
    rpm_max: 24000,
    ...over,
  });

  const base = rep(w('c6base', {}));
  const added = rep(w('c6add', { extra_tools: [tool({})], tool_id: 'Shop 6mm 1F' }));
  // 1 flute at 0.18 is a different feed from 2 flutes at 0.10, so the user
  // tool must CHANGE the program, not merely appear in a list.
  const usedIt = added && added.gcode && base && added.gcode !== base.gcode;

  // An invalid tool must be refused BY NAME rather than quietly used.
  const bad = rep(
    w('c6bad', {
      extra_tools: [tool({ id: 'Bad', chipload_min_mm: 0.3, chipload_max_mm: 0.05 })],
      tool_id: 'Bad',
    })
  );
  const refused = bad && bad.notes.some((n) => n.includes('is invalid') && n.includes('NOT added'));

  if (usedIt && refused) {
    pass('C6', "a user tool changes the emitted feed; an invalid one is refused by name");
  } else {
    fail('C6', `userToolUsed=${!!usedIt} invalidRefused=${!!refused}`);
  }
}

// --- MARK: part marking ----------------------------------------------------
//
// 🔴 REPOINTED AT THE EMITTED PROGRAM, 2026-08-28. This gate used to read
// `report.render` — the plan-side move list `core/src/fixtures.rs` builds by
// walking `r.path.moves`, one step BEFORE the post. That is one doctrinal
// violation sitting inside the harness that enforces the doctrine: this lane's
// standing rule is **assert on the emitted program, never on the setting that
// was supposed to produce it**, and it has been bitten by that exact shape five
// times (ENT's vertical plunge under `EntryMode::Ramp`, `EntryMode::Helix`
// aliased to `Ramp`, P4's dogbone counts, P3's `pocketFloorZ` helper, and a
// `JobSummary` walked off `path.moves`). A post that dropped, rounded or
// reordered the marking moves would have left this green.
//
// It now reads `gcode` and nothing else:
//
//   DEPTH  the marking moves are cutting moves at ENGRAVING depth in the
//          emitted text — modal Z tracked line by line, because a G1 that
//          carries no Z word is still cutting at the last Z that was stated.
//   TOOL   attribution comes from the `( op: <name> [<tool>] )` banner the core
//          writes and `parse_banner` reads back — the only place the emitted
//          program says which cutter a move belongs to (this post emits no `T`
//          word and no `M6`; the change is a banner, a collet note and M5/M3).
//          The marking ops must name a DIFFERENT cutter from the profile ops:
//          an 8mm-tall mark cut with the profiling cutter is illegible, and a
//          mark at full depth is a cut-out.
{
  const r = slice(['report', 'plate']);
  let j = null;
  try {
    j = JSON.parse(r.stdout);
  } catch {
    /* null */
  }
  const gcode = j?.gcode ?? '';
  // The self-plant strips the banners the attribution limb depends on. Losing
  // them must REDDEN this gate, not quietly widen it to "shallow moves
  // anywhere" — a gate that keeps answering after its subject disappears is
  // answering an easier question.
  const text = selfPlanted('mark-banner-blind') ? gcode.replace(/^\(\s*op:.*$/gm, '') : gcode;

  // Perturbed expectation, on P8's precedent: a window no move can occupy. If
  // the count survives it, this gate is not reading the numbers it claims to.
  const [zHi, zLo] = selfPlanted('mark-depth-window') ? [-0.9, -1.0] : [-0.001, -1.0];

  const banner = /^\(\s*op:\s*(.+?)\s*\[(.+?)\]\s*\)\s*$/;
  const strip = (l) => l.replace(/\([^)]*\)/g, ' ');

  let z = 0;
  let op = null;
  let tool = null;
  let markMoves = 0;
  const toolsByOp = new Map();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const b = banner.exec(line);
    if (b) {
      op = b[1];
      tool = b[2];
      toolsByOp.set(op, tool);
      continue;
    }
    const code = strip(line).trim();
    if (!code) continue;
    const zm = /(?:^|\s)Z(-?\d+(?:\.\d+)?)/.exec(code);
    if (zm) z = Number(zm[1]);
    const moves = /(?:^|\s)G0?1(?:\s|$)/.test(code) && /(?:^|\s)[XY]-?[\d.]/.test(code);
    if (moves && op && /mark/i.test(op) && z < zHi && z > zLo) markMoves += 1;
  }

  const markTools = new Set([...toolsByOp].filter(([o]) => /mark/i.test(o)).map(([, t]) => t));
  const otherTools = new Set([...toolsByOp].filter(([o]) => !/mark/i.test(o)).map(([, t]) => t));
  const ownTool = markTools.size > 0 && [...markTools].every((t) => !otherTools.has(t));

  const problems = [];
  if (!j?.ok) problems.push(`the plate job did not plan (ok=${j?.ok})`);
  if (!gcode) problems.push('the report carried no `gcode` — there is no emitted program to read, and the plan-side `render` is NOT a substitute');
  if (toolsByOp.size === 0) problems.push('no `( op: <name> [<tool>] )` banner in the emitted program — the marking moves cannot be attributed to an operation OR to a cutter, so a shallow move anywhere would answer for them');
  if (markTools.size === 0) problems.push('no operation whose name says it marks — nothing in this program claims to be a mark');
  if (markMoves <= 20) problems.push(`${markMoves} cutting move(s) attributed to a marking op at engraving depth (${zLo} < Z < ${zHi}) in the EMITTED text — a mark at full depth is a cut-out`);
  if (!ownTool) problems.push(`the marking op(s) do not name their own cutter: mark=[${[...markTools].join(', ')}] other=[${[...otherTools].join(', ')}] — an 8mm-tall mark cut with the profiling cutter is illegible`);

  if (problems.length === 0) {
    pass(
      'MARK',
      `${markMoves} marking move(s) at engraving depth READ OUT OF THE EMITTED G-CODE (modal Z tracked; ${zLo} < Z < ${zHi}), ` +
        `attributed by the ( op: … [tool] ) banner to ${markTools.size} marking op-tool(s) [${[...markTools].join(', ')}] ` +
        `distinct from the ${otherTools.size} other cutter(s) [${[...otherTools].join(', ')}] over ${toolsByOp.size} banner(s). ` +
        'NOT COVERED: whether the mark is LEGIBLE or says the right thing — this checks that it is shallow, present and cut with its own cutter'
    );
  } else {
    fail('MARK', `${problems.length} problem(s): ${problems.join(' | ')}`);
  }
}

// --- LEAD: lead in / out ---------------------------------------------------
{
  const cfgNo = join(ROOT, 'target', 'gatecfg-lead0.json');
  const cfgYes = join(ROOT, 'target', 'gatecfg-lead4.json');
  writeFileSync(cfgNo, JSON.stringify({ op: { lead_mm: 0, entry: 'Plunge' } }));
  writeFileSync(cfgYes, JSON.stringify({ op: { lead_mm: 4, entry: 'Plunge' } }));
  const arcsIn = (p) => {
    try {
      const g = JSON.parse(slice(['report', 'plate', '--config', p]).stdout).gcode ?? '';
      return (g.match(/^G[23] /gm) || []).length;
    } catch {
      return -1;
    }
  };
  const a = arcsIn(cfgNo);
  const b = arcsIn(cfgYes);
  // ⚠ NOT "no arcs without a lead" — the outside offset of a sharp corner IS an
  // arc of the tool radius, so a square part already emits arcs at its corners.
  // What the lead must do is ADD arcs.
  if (a > 0 && b >= a + 2) {
    pass('LEAD', `lead adds ${b - a} arcs to a program that already had ${a} corner arcs`);
  } else {
    fail('LEAD', `arcs without lead=${a}, with lead=${b} — the lead added nothing`);
  }
}

// --- ENT: how the tool gets into the cut (control: entry=Plunge) -----------
//
// Spec row G-9, "no vertical plunge in a through-cut". The failure is physical
// and immediate: the end of a router flute is not a drill point, so a tool that
// descends to full depth with no XY motion puts the entire axial load on the
// flute corners. In 18mm ply that snaps a 6mm cutter or lifts the workpiece off the
// spoilboard and throws it.
//
// 🔴 THIS GATE ASKS THE QUESTION OF THE EMITTED PROGRAM, NOT OF THE PLAN.
// `params.entry == Ramp` is what the plan says; what the controller executes is
// the sequence of moves, and the two disagreed until this gate was written — a
// ramped pass with a lead-in still emitted a full-depth vertical descent at the
// lead point. A check on the enum would have been green for it.
//
// ⚠ It also exists because the tests NEAREST this behaviour deselect it: both
// toolpath entry tests and the LEAD gate set `entry: 'Plunge'` deliberately,
// because they are testing leads. The default path had no assertion at all.
{
  const cfgPath = (name, obj) => {
    const p = join(ROOT, 'target', name);
    writeFileSync(p, JSON.stringify(obj));
    return p;
  };
  const reportOf = (args) => {
    const r = slice(args);
    try {
      return JSON.parse(r.stdout);
    } catch {
      return null;
    }
  };

  /**
   * Facts about entry, read from the G-code.
   *
   * Sections headed `( drill: … )` are EXCLUDED and that is deliberate: a drill
   * IS designed to cut on its end, and a canned cycle is a vertical descent by
   * definition. Including them would make the gate red on correct work, and a
   * gate that cries wolf gets muted.
   *
   * A section counts as a THROUGH-CUT when its own deepest Z passes half the
   * workpiece thickness — that keeps the 0.4mm marking passes out of it (they are
   * not through-cuts and a shallow marking descent is not the failure this
   * guards) without letting a milling op opt itself out.
   */
  const entryFacts = (gcode, thicknessMm) => {
    const secs = [];
    let cur = null;
    let x = NaN;
    let y = NaN;
    let z = NaN;
    for (const raw of gcode.split('\n')) {
      const line = raw.trim();
      const hdr = /^\( (op|drill): (\S+)/.exec(line);
      if (hdr) {
        cur = { kind: hdr[1], name: hdr[2], moves: [], deepest: 0 };
        secs.push(cur);
        continue;
      }
      if (!line || line.startsWith('(')) continue;
      const g = /^(G0|G1|G2|G3)\b/.exec(line);
      if (!g) continue;
      const from = [x, y, z];
      // Modal words: an axis absent from a block keeps its previous value, so
      // the previous position must be carried, not re-read. Reading a block in
      // isolation would report every Z-word line as a Z-only move.
      const word = (ax) => {
        const m = new RegExp(`(?:^|\\s)${ax}(-?[\\d.]+)`).exec(line);
        return m ? Number(m[1]) : null;
      };
      const nx = word('X');
      const ny = word('Y');
      const nz = word('Z');
      if (nx !== null) x = nx;
      if (ny !== null) y = ny;
      if (nz !== null) z = nz;
      if (!cur) continue;
      cur.moves.push({ g: g[1], from, to: [x, y, z] });
      if (Number.isFinite(z)) cur.deepest = Math.min(cur.deepest, z);
    }

    const through = secs.filter((s) => s.kind === 'op' && s.deepest <= -0.5 * thicknessMm);
    const plunges = [];
    let rampMoves = 0;
    for (const s of through) {
      for (const m of s.moves) {
        const [fx, fy, fz] = m.from;
        const [tx, ty, tz] = m.to;
        if (![fx, fy, fz, tx, ty, tz].every(Number.isFinite)) continue;
        const dxy = Math.hypot(tx - fx, ty - fy);
        const dz = tz - fz;
        // Descending, no XY component, ending BELOW the workpiece top. Stopping at
        // Z0 is not a plunge — that is the tool arriving at the surface, and
        // the ramp does the rest. Rapids count too: a G0 that descends into
        // the material is the same failure at ten times the speed.
        if (dz < -1e-6 && dxy < 1e-6 && tz < -1e-6) {
          plunges.push(`${s.name} ${m.g} Z${tz.toFixed(3)}`);
        }
        if (dz < -1e-6 && dxy > 1e-6) rampMoves += 1;
      }
    }
    return { sections: through.length, plunges, rampMoves };
  };

  const clean = reportOf(['report', 'plate']);
  const thick = clean?.stock?.[2] ?? 18;
  const leadCfg = cfgPath('gatecfg-ent-lead.json', { op: { lead_mm: 4 } });
  const plungeCfg = cfgPath('gatecfg-ent-plunge.json', { op: { entry: 'Plunge' } });
  const helixCfg = cfgPath('gatecfg-ent-helix.json', { op: { entry: 'Helix' } });
  const lead = reportOf(['report', 'plate', '--config', leadCfg]);
  const planted = reportOf(['report', 'plate', '--config', plungeCfg]);
  const helix = reportOf(['report', 'plate', '--config', helixCfg]);

  const fClean = clean ? entryFacts(clean.gcode, thick) : null;
  const fLead = lead ? entryFacts(lead.gcode, thick) : null;
  const fPlanted = planted ? entryFacts(planted.gcode, thick) : null;

  // The Helix limb of the row. `EntryMode::Helix` had no distinct behaviour —
  // it was matched together with Ramp, so a job asking for a helical bore got a
  // linear ramp and nothing said so. It now REFUSES, on the precedent of
  // `Technology::Fdm`: an unimplemented thing reports that it is unimplemented
  // rather than quietly behaving like its neighbour.
  const helixRefused =
    helix?.ok === false &&
    (helix.refusals ?? []).some((r) => /helical entry is NOT IMPLEMENTED/.test(r)) &&
    (helix.gcode ?? '') === '';

  const ok =
    fClean &&
    fLead &&
    fPlanted &&
    fClean.sections >= 1 &&
    fClean.plunges.length === 0 &&
    fClean.rampMoves > 5 &&
    /* 🔴 THE LEAD LEG NEEDS THE SAME FLOOR AS THE CLEAN ONE, and did not have
     * it until 2026-09-07. `fLead.plunges.length === 0` is VACUOUSLY TRUE over a
     * program with no through-cut section in it: `entryFacts` builds `through`
     * by filtering sections that reach half thickness, so a lead run that stops
     * emitting one yields `sections: 0`, `plunges: []`, and this limb passes
     * while ENT prints "a lead-in adds none" about a program containing no cuts.
     *
     * ⚠ REACHABLE, not theoretical: `report` answers a REFUSAL as
     * `{ ok: false, gcode: '' }` — valid JSON — so `reportOf` returns non-null,
     * `fLead` is a truthy object literal, and `lead.ok` is never consulted. A
     * config-key rename or a lead implementation that no longer reaches depth
     * takes this path silently.
     *
     * The floor two lines above proves the author knew it was needed; it was
     * applied to one leg of three. `fPlanted.plunges.length > 0` is a POSITIVE
     * assertion and cannot go vacuous, so the lead leg was the single exposed
     * limb. Found by a read-only sweep of gates/, 2026-09-07. */
    fLead.sections >= 1 &&
    fLead.plunges.length === 0 &&
    fPlanted.plunges.length > 0 &&
    helixRefused;

  if (ok) {
    pass(
      'ENT',
      `default entry descends only with XY motion (${fClean.rampMoves} ramping moves, ` +
        `0 vertical plunges in ${fClean.sections} through-cut op(s)); a lead-in adds none; ` +
        `entry=Plunge produces ${fPlanted.plunges.length} (${fPlanted.plunges[0]}); ` +
        `entry=Helix is refused as unimplemented rather than silently ramped`
    );
  } else {
    fail(
      'ENT',
      `default plunges=${JSON.stringify(fClean?.plunges ?? null)} ramping=${fClean?.rampMoves} ` +
        `throughOps=${fClean?.sections} lead-in plunges=${JSON.stringify(fLead?.plunges ?? null)} ` +
        `control(entry=Plunge) plunges=${fPlanted?.plunges.length} helixRefused=${helixRefused}`
    );
  }
}

// --- REL: release ordering across tool groups (TODO #33) -------------------
//
// PHYSICAL FAILURE: a part is freed from the workpiece the moment its outer profile
// is cut through. Every operation after that is being made on a part held by
// its tabs alone. That is gate P1's failure — a part breaking loose into a
// 2.2 kW spindle — and it arrives here through the ORDERING rules rather than
// through a missing tab, which is why P1 cannot see it: the tabs are all
// present and correct on a part that is nonetheless loose.
//
// Until 2026-08-09 `toolpath::group_by_tool` ran the tool groups in
// FIRST-APPEARANCE order, so whether the 6mm outline ran before or after the
// 4mm drill was decided by how the caller happened to build the operation
// vector. `optimise_route` now topologically sorts the groups on
// "interior work before the tool that releases the part" — see
// docs/decision-33-tool-grouping-vs-part-restraint.md, option 4.
//
// 🔴 MEASURED ON THE EMITTED PROGRAM. The section order comes out of the
// G-code, never out of the plan — this lane has been bitten four times by a
// check that read the setting that was supposed to produce the output (P3, P4,
// ENT, the JobSummary). The only thing taken from the plan is WHICH operation
// belongs to WHICH part, which the emitted text does not carry; the core states
// it on a `route-parts:` line so this gate does not have to re-derive part
// attribution from a naming convention the core deliberately does not use.
{
  /** `route-parts: <release><-<i>|<i>; <release><-<i>` → [{release, interior}] */
  const partMap = (stderr) => {
    const m = /^note: route: route-parts: (.+)$/m.exec(stderr);
    if (!m) return null;
    const out = [];
    for (const chunk of m[1].split('; ')) {
      const i = chunk.indexOf('<-');
      if (i < 0) continue;
      out.push({ release: chunk.slice(0, i), interior: chunk.slice(i + 2).split('|') });
    }
    return out.length ? out : null;
  };

  /** Section headers of the EMITTED program, in program order. */
  const sections = (gcode) =>
    [...gcode.matchAll(/^\(\s*(?:op|drill):\s*(.+?)\s*\[(.+?)\]\s*\)\s*$/gm)].map((m) => ({
      name: m[1],
      tool: m[2],
    }));

  /**
   * THE CHECK: every part worked on AFTER the operation that released it.
   *
   * Shared by the product limb and by the negative control on purpose. A
   * control that exercises a different checker than the product does proves
   * nothing about the one that ships.
   */
  const lateWork = (parts, order) => {
    const at = (n) => order.findIndex((s) => s.name === n);
    const bad = [];
    for (const p of parts) {
      const r = at(p.release);
      if (r < 0) continue;
      const late = p.interior.filter((n) => at(n) > r);
      if (late.length) bad.push(`${p.release} released before ${late.join(',')}`);
    }
    return bad;
  };

  /** Contiguous tool runs — one per tool if the grouping held. */
  const runs = (order) => {
    const r = [];
    for (const s of order) if (r[r.length - 1] !== s.tool) r.push(s.tool);
    return r;
  };

  // A drawing that ACTUALLY EXERCISES the reorder. Two parts: a big plain
  // rectangle that takes the 6mm end mill, and a smaller one whose 4mm holes
  // need a drill. The plain part sorts first, so its END MILL is the
  // first-appearing tool — which is exactly the accident that used to decide
  // the group order and cut the second part loose before its holes were
  // drilled. Written here rather than committed as a fixture so this gate
  // carries its own evidence.
  const dxf = (() => {
    const poly = (pts) =>
      `0\nLWPOLYLINE\n70\n1\n` + pts.map(([x, y]) => `10\n${x}\n20\n${y}\n`).join('');
    const rect = (x, y, w, h) =>
      poly([[x, y], [x + w, y], [x + w, y + h], [x, y + h]]);
    const circ = (cx, cy, r) => `0\nCIRCLE\n10\n${cx}\n20\n${cy}\n40\n${r}\n`;
    let s = '0\nSECTION\n2\nENTITIES\n';
    s += rect(30, 30, 260, 160);
    s += rect(350, 30, 150, 100);
    for (const [cx, cy] of [[390, 60], [460, 60], [390, 100], [460, 100]]) s += circ(cx, cy, 2.0);
    return s + '0\nENDSEC\n0\nEOF\n';
  })();
  const dxfPath = join(ROOT, 'target', 'gate-rel-twopart.dxf');
  // THE SAME GEOMETRY UNDER A FILENAME THAT USED TO DEFEAT THE CLASSIFIER
  // (TODO #146, added 2026-08-29) — and 🔴 IT DOES NOT DISCRIMINATE. Read the
  // next paragraph before quoting this case as coverage.
  //
  // The intent was to give REL the case it could never see. `group_by_tool` used
  // to decide interior-vs-releasing by asking whether the operation NAME
  // contained `-hole`/`-inner`, and every part this gate drove — `plate`,
  // `blank`, `drilled`, `drawing/partN` — answered "no" for the releasing cut,
  // so right and wrong agreed on every case here. `nest` puts the caller's id
  // into the part name and the id DEFAULTS TO THE FILE STEM (`label_for`):
  //   nest --drawing …/gate-rel-sensor-hole-jig.dxf
  //     -> route-parts: gate-rel-sensor-hole-jig/part2<-…/part2-hole1|…
  // The releasing operation therefore CONTAINS `-hole`, and the old code read
  // the cut that frees the part as interior work.
  //
  // 🔴 MEASURED, AND THE MEASUREMENT SAYS THIS CASE IS NOT THE CONTROL. With the
  // old name-substring classifier planted back into `group_by_tool` and the
  // release binary rebuilt, this gate STILL PASSED — all five cases, including
  // this one, 6 sections and 1 tool change. `optimise_route` topologically sorts
  // the tool groups before any of this matters, and on this drawing it produces
  // a safe order either way: the split changes where the group BOUNDARIES fall,
  // not the order the cuts come out in. The same planted run turned `G0` red on
  // `toolpath::tests::the_release_split_is_decided_by_role_and_not_by_what_the_
  // drawing_is_called`, which is the control that actually discriminates.
  //
  // So: #146 is gated — by G0, which runs the unit suite — and NOT by REL. The
  // case is kept because it exercises the `nest` door end to end for free, and
  // it is labelled below as what it is rather than what it was meant to be. A
  // case that passes either way, described as a control, is worse than no case.
  //
  // ⚠ Reachability measured rather than assumed, because it decides how big #146
  // was: `import` and the BROWSER both send synthetic ids (`drawing`, `0:1`), so
  // neither could reach it. `nest` and `layout` carry the filename.
  const dxfHostilePath = join(ROOT, 'target', 'gate-rel-sensor-hole-jig.dxf');
  const relCfg = join(ROOT, 'target', 'gatecfg-rel.json');
  writeFileSync(dxfPath, dxf);
  writeFileSync(dxfHostilePath, dxf);
  writeFileSync(
    relCfg,
    JSON.stringify({ tool_ids: ['End Mill - Down-cut 6mm 2F', 'Drill - Brad Point 4mm 2F'] })
  );

  /** The core's "tool groups reordered: A, B -> C, D" note, as two lists. */
  const reorderNote = (stderr) => {
    const m = /^note: route: tool groups reordered so interior work precedes the tool that releases the part: (.+?) -> (.+?)\. /m.exec(stderr);
    return m ? { before: m[1].split(', '), after: m[2].split(', ') } : null;
  };

  const cases = [
    { what: 'job multi-tool', r: slice(['job', 'multi-tool']) },
    { what: 'job two-part', r: slice(['job', 'two-part']) },
    { what: 'import two-part drawing', r: slice(['import', dxfPath, '--config', relCfg]) },
    // Same geometry, same config, a filename that used to defeat the split.
    { what: 'nest, benign filename', r: slice(['nest', '--drawing', dxfPath, '--config', relCfg]) },
    {
      // NOT a control — see the block above. Measured 2026-08-29: this case
      // passes with the old classifier planted. The discriminating control for
      // #146 is a unit test, and gate G0 is what runs it.
      what: 'nest, filename containing `-hole` (exercised, NOT discriminating — G0 holds #146)',
      r: slice(['nest', '--drawing', dxfHostilePath, '--config', relCfg]),
    },
  ];

  const problems = [];
  const good = [];
  let controlSaw = null;
  let controlPlant = null;

  for (const c of cases) {
    const parts = partMap(c.r.stderr);
    const order = sections(c.r.stdout);
    if (!parts) {
      problems.push(`${c.what}: no route-parts line — the part map this gate reads is missing, so nothing was checked (a check that cannot run is not a check that passed)`);
      continue;
    }
    if (order.length === 0) {
      // 🔴 Distinguish the two ways this happens, because they are opposite
      // findings and an unexplained "no sections" reads as a harness fault.
      //
      // If the core REFUSED the job for release ordering, the refusal half is
      // working exactly as designed — it makes `is_runnable()` false and no
      // G-code is emitted — but on THIS drawing, which has a perfectly good
      // grouped order, being refused means the ordering half is not doing its
      // job. That is the shape the gate goes red in when the group sort is
      // removed, and saying so is the difference between a diagnosis and a
      // shrug.
      const refused = [...c.r.stderr.matchAll(/^refused: ([^:]+?):? ?—? ?(it is cut before .+)$/gm)];
      if (refused.length) {
        problems.push(
          `${c.what}: REFUSED for release ordering (${refused
            .map((m) => `${m[1]}: ${m[2].slice(0, 90)}`)
            .join(' | ')}) and emitted no G-code. The refusal is correct; being refused is not — ` +
            `this drawing HAS a safe grouped order (drill then end mill, one tool change), so the ` +
            `group ordering in optimise_route did not run or did not work`
        );
      } else {
        problems.push(`${c.what}: the emitted program has no ( op: … ) / ( drill: … ) sections to read an order from`);
      }
      continue;
    }
    const bad = lateWork(parts, order);
    if (bad.length) {
      problems.push(`${c.what}: ${bad.join(' | ')}`);
      continue;
    }
    good.push(`${c.what}: ${order.length} sections, ${runs(order).length} tool run(s) = ${runs(order).length - 1} change(s), no part worked on after its release`);
  }

  // ---- NEGATIVE CONTROL, and it is the reason this gate means anything ----
  //
  // The core says out loud when it swapped the groups and what the order was
  // BEFORE. Rebuild that pre-fix order — a stable sort of the SAME emitted
  // sections by the SAME tools, in first-appearance order — and put it through
  // the SAME checker. It must come back RED. If it does not, either the fix
  // changed nothing on this drawing or the checker cannot see the hazard it
  // exists for, and in both cases the green above is vacuous.
  {
    const c = cases.find((x) => x.what.startsWith('import'));
    const note = reorderNote(c.r.stderr);
    const parts = partMap(c.r.stderr);
    const order = sections(c.r.stdout);
    if (!note) {
      problems.push('the two-part drawing did not exercise the group reorder at all (no "tool groups reordered" note) — this gate would be green on a job that never had the problem');
    } else if (parts && order.length) {
      const before = note.before;
      const planted = before.flatMap((t) => order.filter((s) => s.tool === t));
      if (planted.length !== order.length) {
        problems.push(`the negative control could not be rebuilt: the pre-fix group list [${before.join(', ')}] does not cover the ${order.length} emitted sections`);
      } else {
        controlSaw = lateWork(parts, planted);
        if (controlSaw.length === 0) {
          problems.push(`NEGATIVE CONTROL DEFEATED: the pre-fix group order (${before.join(' then ')}) is safe too, so this gate proves nothing about the fix`);
        }
        // The tool-change count must be identical in both orders. That is the
        // whole claim of decision #33 option 4 — the safety was free.
        if (runs(planted).length !== runs(order).length) {
          problems.push(`the reorder changed the tool-change count (${runs(planted).length - 1} -> ${runs(order).length - 1}); grouping was broken, not reordered`);
        }
      }
    }
  }

  // ---- STANDING NEGATIVE CONTROL: `--plant release-order` ------------------
  //
  // The control above is rebuilt IN JAVASCRIPT from the core's own note. It is
  // real — it goes red if the pre-fix order turns out to be safe — but it is
  // asserting on this file's arithmetic, not on a program the core emitted. A
  // standing `--plant` was OWED from the day REL landed, and it could not be
  // paid because the knob did not exist: `optimise_route` called `order_groups`
  // unconditionally, and none of the five reference fixtures produced a reorder
  // to neuter, so a plant hung on one would have run clean and READ AS A PASSING
  // CONTROL — the exact failure `--plant` exists to prevent.
  //
  // Both halves are now built: `optimise::GroupOrder::FirstAppearance` (reached
  // ONLY by `JobPlant::ReleaseOrder`) and the `two-part` fixture, which is the
  // one job whose first-appearance order is genuinely unsafe.
  //
  // 🔴 FOUR THINGS ARE ASSERTED, AND THE FIRST IS THE POINT. "The exit code
  // moved" proves nothing — an exit code moves for a typo in a flag name. So the
  // control asserts that the planted run REACHED THE HAZARDOUS PATH:
  //   1. the core states `planted-difference: YES` — it applied the plant AND
  //      the resulting group order differs from the sorted one on this job;
  //   2. the order it kept is byte-for-byte the `before` list of the CLEAN run's
  //      own reorder note, and the order it declined is that note's `after` —
  //      two independent runs agreeing on which order is the pre-fix one;
  //   3. the refusal names the released part and EVERY interior feature the
  //      clean run's `route-parts` line attributes to it — the physical hazard,
  //      enumerated, not a message that merely mentions ordering;
  //   4. stdout is EMPTY. Gate G13's property: the refusal must mean *no program
  //      exists*, not *a warning was printed above one*.
  {
    const PLANT_JOB = 'two-part';
    const clean = cases.find((x) => x.what === `job ${PLANT_JOB}`);
    const planted = slice(['job', PLANT_JOB, '--plant', 'release-order']);
    // The control compares the planted run against the SAME job run clean, so
    // a missing clean case is a broken harness, not a passing control.
    const cleanNote = clean ? reorderNote(clean.r.stderr) : null;
    const parts = clean ? partMap(clean.r.stderr) : null;
    const bits = [];
    if (!clean) {
      problems.push(
        `CONTROL: there is no unplanted \`job ${PLANT_JOB}\` case to compare the plant against — ` +
          `the control cannot run, and a check that cannot run is not a check that passed`
      );
    }

    // 1 — did the plant plant anything?
    const diff = /planted-difference: (YES|NO)/.exec(planted.stderr);
    if (!diff) {
      problems.push(
        'CONTROL: `--plant release-order` produced no planted-difference line — the core did not ' +
          'take the plant, so nothing below means anything'
      );
    } else if (diff[1] !== 'YES') {
      problems.push(
        `NEGATIVE CONTROL VACUOUS: \`--plant release-order\` on \`${PLANT_JOB}\` reports ` +
          '`planted-difference: NO` — it neutered a sort that was never going to fire on this ' +
          'job, so it would run clean and read as a passing control. The job it is driven on ' +
          'stopped exercising the reorder; fix that, do not move the plant'
      );
    } else {
      bits.push('planted-difference=YES');
    }

    // 2 — is the order it kept the SAME pre-fix order the clean run named?
    const kept = /first-appearance order is kept: (.+?)\. The release-sorted order would have been: (.+?)\. planted-difference:/.exec(planted.stderr);
    if (!kept) {
      problems.push('CONTROL: the plant did not state which group order it kept and which it declined');
    } else if (!cleanNote) {
      problems.push('CONTROL: the unplanted `job two-part` emitted no reorder note, so the plant has nothing to be checked against');
    } else if (kept[1] !== cleanNote.before.join(', ') || kept[2] !== cleanNote.after.join(', ')) {
      problems.push(
        `CONTROL: the planted order does not match the clean run's own note — planted kept ` +
          `[${kept[1]}] / declined [${kept[2]}], clean reported [${cleanNote.before.join(', ')}] -> ` +
          `[${cleanNote.after.join(', ')}]. The plant is restoring some other order, not the pre-fix one`
      );
    } else {
      bits.push(`restored [${kept[1]}] over [${kept[2]}]`);
    }

    // 3 — does the refusal name the part and everything stranded behind it?
    const refused = [...planted.stderr.matchAll(/^refused: ([^:—]+?) — (it is cut before .+)$/gm)];
    if (!refused.length) {
      problems.push(
        'CONTROL: the planted job was NOT refused for release ordering — the group order was ' +
          'restored to the pre-fix one and nothing objected, which means the refusal half is not ' +
          'covering the case the ordering half was built to remove'
      );
    } else if (parts) {
      const missed = [];
      for (const m of refused) {
        const p = parts.find((x) => x.release === m[1].trim());
        if (!p) {
          missed.push(`${m[1].trim()} is not a released part in the clean run's route-parts`);
          continue;
        }
        const absent = p.interior.filter((n) => !m[2].includes(n));
        if (absent.length) missed.push(`${p.release}: refusal does not name ${absent.join(',')}`);
      }
      if (missed.length) {
        problems.push(`CONTROL: the refusal does not enumerate the stranded work — ${missed.join(' | ')}`);
      } else {
        bits.push(`refused ${refused.map((m) => m[1].trim()).join(',')} naming every stranded feature`);
      }
    }

    // 4 — no program, not a warning above one.
    if (planted.stdout.trim().length) {
      problems.push(
        `CONTROL: the planted job emitted ${planted.stdout.length}B of G-code. A part released ` +
          `before its own holes must produce NO program — a warning printed above a runnable file ` +
          `is a file that gets run`
      );
    } else if (planted.code === 0) {
      problems.push('CONTROL: the planted job exited 0 with no program — a refusal must be non-zero');
    } else {
      bits.push(`exit=${planted.code} stdout=0B`);
    }

    if (bits.length) controlPlant = bits.join(', ');
  }

  if (problems.length === 0) {
    pass(
      'REL',
      `${good.join('; ')}. NEGATIVE CONTROL (in-gate): the pre-fix first-appearance group order on ` +
        `the same program is caught (${controlSaw?.join(' | ')}) at the SAME tool-change count. ` +
        `NEGATIVE CONTROL (--plant release-order on two-part): ${controlPlant}`
    );
  } else {
    fail('REL', problems.join(' | '));
  }
}

// --- SPIN: spindle band + spin-up dwell (control: --plant rpm) -------------
//
// Spec row A2. Two separate physical failures, one gate:
//   * an rpm outside the spindle's band — a VFD spindle below its minimum
//     stalls and loses torque; above its maximum it is not a speed the machine
//     can produce, so the actual chipload is nothing like the planned one;
//   * the first cut arriving before the spindle is at speed — a 2.2 kW spindle
//     takes seconds to spin up, and a cutter fed into ply at a fraction of its
//     rpm sees several times its rated chipload.
//
// 🔴 `--plant rpm` (`Plant::RpmOutOfRange`) was BUILT AND NEVER FIRED by any
// gate or test — a negative control armed by nobody, which reads as protection
// and is not. This gate is the caller it was waiting for.
{
  const clean = slice(['fixture', 'rect-profile']);
  const planted = slice(['fixture', 'rect-profile', '--plant', 'rpm']);

  // Every M3 in the program — the multi-tool job restarts the spindle after
  // each tool change, and a dwell that is only correct on the FIRST start is a
  // dwell missing from every subsequent one.
  const dwellFollowsEveryStart = (gcode) => {
    const lines = codeLines(gcode).map((l) => l.trim());
    const starts = [];
    lines.forEach((l, i) => {
      if (/^M3 S[\d.]+$/.test(l)) starts.push(i);
    });
    if (!starts.length) return { starts: 0, ok: false, why: 'no M3 at all' };
    for (const i of starts) {
      const next = lines[i + 1] ?? '';
      const m = /^G4 P([\d.]+)$/.exec(next);
      if (!m || Number(m[1]) <= 0) {
        return { starts: starts.length, ok: false, why: `M3 at ${i} is followed by "${next}"` };
      }
      // …and the dwell must come BEFORE the cut, not merely exist somewhere.
      const cut = lines.findIndex((l, k) => k > i + 1 && /^G[123]\b/.test(l));
      if (cut === -1 || cut <= i + 1) {
        return { starts: starts.length, ok: false, why: `no cutting move after the dwell at ${i}` };
      }
    }
    return { starts: starts.length, ok: true, why: '' };
  };

  const fix = dwellFollowsEveryStart(clean.stdout);
  const multi = slice(['job', 'multi-tool']);
  const multiDwell = dwellFollowsEveryStart(multi.stdout);

  // The band. The warning names the limit that was exceeded, and the clean run
  // must be silent — otherwise the gate is reading a warning that is always on.
  const plantedWarned = /exceeds the spindle's maximum/.test(planted.stderr);
  const cleanQuiet = !/spindle's (maximum|minimum)/.test(clean.stderr);
  // The out-of-band speed is really in the program the warning is about.
  const plantedS = /^M3 S(\d+)$/m.exec(planted.stdout ?? '');
  const bandIsAboutTheProgram = !!plantedS && Number(plantedS[1]) > 24000;

  if (
    clean.code === 0 &&
    fix.ok &&
    multiDwell.ok &&
    multiDwell.starts >= 2 &&
    plantedWarned &&
    cleanQuiet &&
    bandIsAboutTheProgram
  ) {
    pass(
      'SPIN',
      `G4 dwell follows all ${fix.starts} spindle start(s) on the fixture and all ` +
        `${multiDwell.starts} on the multi-tool job, before the first cut; ` +
        `an S${plantedS[1]} program warns that the spindle maximum is exceeded and a clean one does not`
    );
  } else {
    fail(
      'SPIN',
      `fixtureDwell=${fix.ok}(${fix.why}) multiToolDwell=${multiDwell.ok}(${multiDwell.why}, ` +
        `starts=${multiDwell.starts}) plantedWarned=${plantedWarned} cleanQuiet=${cleanQuiet} ` +
        `plantedS=${plantedS?.[1]}`
    );
  }
}

// --- PROBE: the XYZ touch plate --------------------------------------------
//
// TODO #37. Five physical failures, one gate — every one of them invisible in
// the 3D preview, which is why they need a check on the EMITTED PROGRAM:
//
//   * 🔴 THE RADIUS. An X or Y probe touches with the SIDE of the cutter, so
//     the work offset carries the TOOL RADIUS; a Z probe touches with the tip
//     and carries none. A wrong radius displaces EVERY coordinate in the
//     program by that amount. The toolpath renders perfectly and the part is
//     cut in the wrong place — there is no visual symptom at all.
//   * THE CORNER. Which corner the plate is hooked over decides which way the
//     tool drives to meet it. Assume front-left, run on a back-right plate, and
//     the cutter is driven INTO the plate at the seek rate.
//   * THE SPINDLE. A probe with the spindle turning sweeps the plate on the way
//     in: contact fires early, at a radius that is not the radius, and the
//     plate, the cutter or both are destroyed.
//   * THE ORDER. The probe sets the origin every later coordinate is measured
//     from. After the first cut it sets a datum for work already done.
//   * 🔴 THE PLACEMENT (TODO #40). The corner plate is hooked over the
//     WORKPIECE, so it moves when the workpiece moves. Modelled on the machine —
//     as it was until 2026-08-08 — a dragged or turned workpiece left its plate
//     behind, and the datum the whole program is measured from then described a
//     corner that was not there. Every coordinate displaced, nothing on screen.
//     Same failure class as the radius, and this limb is the one that would have
//     caught it: MOVE the workpiece and watch the emitted probe move with it.
//   * THE OTHER HALF OF THAT SPLIT. A FIXED plate is bolted to the machine and
//     must NOT follow the workpiece. A gate that only checked "the plate moves"
//     would go green on a post that moved both.
//   * THE REFUSALS. An undeclared corner, top, wall, descent or tool radius, and
//     a workpiece not square to the machine's axes, are refused — never guessed. A guessed
//     number here produces a runnable file that is wrong by an amount nobody can
//     see.
//
// ⚠ SCOPE, STATED SO NOBODY READS THIS GREEN AS MORE THAN IT IS. Most XYZ
// programs below come from `post_grblhal` through the core's own test dump
// rather than through `2bee-slice`, because the CLI has no FLAGS for the plate.
// The `--config` route DOES reach it (`machine.probe_plate` + the
// `stock.corner_plate` block), and limb L8 drives the placement claim through
// the real binary for exactly that reason — a dump the gate reads is one build,
// the product is another. It still does NOT prove the browser emits the same
// thing: I1/K3 compare CLI and wasm on the fixtures, which do not declare a
// corner plate.
{
  const dumpDir = join(ROOT, 'target/probe-gate');
  const gen = spawnSync(
    'cargo',
    ['test', '-p', 'twobee-cam', '--lib', 'probe_gate_dump', '--', '--exact', '--quiet'],
    { cwd: ROOT, encoding: 'utf8' }
  );

  const read = (name) => {
    const p = join(dumpDir, name);
    if (!existsSync(p)) return null;
    const raw = readFileSync(p, 'utf8');
    const cut = raw.indexOf('\n----\n');
    if (cut < 0) return null;
    const head = raw.slice(0, cut).split('\n');
    return {
      ok: head[0] === 'OK true',
      errors: head[1].replace(/^ERRORS ?/, ''),
      gcode: raw.slice(cut + 6),
    };
  };

  // ---- the checkers. Pure functions of program text, so the negative
  // controls below can feed them a corrupted program and watch them go red.
  // A gate whose limbs have never been seen to fail is not a gate.
  const datum = (g, axis) => {
    const m = new RegExp(`^G10 L20 P1 ${axis}(-?[\\d.]+)$`, 'm').exec(
      codeLines(g).join('\n')
    );
    return m ? Number(m[1]) : null;
  };
  /** M5 before the first probe, and no M3 left running across any probe. */
  const spindleOffAcrossProbes = (g) => {
    const lines = codeLines(g).map((l) => l.trim());
    let on = false;
    let sawM5BeforeProbe = false;
    let seenProbe = false;
    for (const l of lines) {
      if (/^M3\b/.test(l)) on = true;
      else if (/^M5\b/.test(l)) {
        on = false;
        if (!seenProbe) sawM5BeforeProbe = true;
      } else if (/^G38\./.test(l)) {
        if (on) return { ok: false, why: 'a probe runs with M3 still in force' };
        seenProbe = true;
      }
    }
    if (!seenProbe) return { ok: false, why: 'no probe in the program at all' };
    if (!sawM5BeforeProbe) return { ok: false, why: 'no M5 before the first probe' };
    return { ok: true, why: '' };
  };
  /** The first probe must precede the first cutting move. */
  const probeBeforeFirstCut = (g) => {
    const lines = codeLines(g).map((l) => l.trim());
    const probe = lines.findIndex((l) => /^G38\./.test(l));
    const cut = lines.findIndex((l) => /^(G1|G2|G3|G8[123])\b/.test(l));
    if (probe === -1) return { ok: false, why: 'no probe' };
    if (cut === -1) return { ok: false, why: 'no cutting move to be before' };
    return { ok: probe < cut, why: `probe@${probe} cut@${cut}` };
  };
  /** G38.2 only. .3/.5 return silently on no contact and the G10 then persists garbage. */
  const onlyG382 = (g) => codeLines(g).every((l) => !/^G38\./.test(l.trim()) || /^G38\.2\b/.test(l.trim()));
  /** Every `G0 X.. Y..` station, in order — where the tool is SENT to find the plate. */
  const stations = (g) =>
    codeLines(g)
      .map((l) => /^G0 X(-?[\d.]+) Y(-?[\d.]+)$/.exec(l.trim()))
      .filter(Boolean)
      .map((m) => [Number(m[1]), Number(m[2])]);

  const fl = read('xyz-front-left.nc');
  const br = read('xyz-back-right.nc');
  const t8 = read('xyz-tool8.nc');
  const zo = read('z-only.nc');
  const moved = read('xyz-moved.nc');
  const turned = read('xyz-turned.nc');
  const zoMoved = read('z-only-moved.nc');
  const refusals = [
    'refuse-no-corner.nc',
    'refuse-no-radius.nc',
    'refuse-no-top.nc',
    'refuse-no-wall.nc',
    'refuse-no-depth.nc',
    'refuse-wall-absent.nc',
    'refuse-not-square.nc',
    // 🔴 TODO #43 / decision #43 P0 — the MACHINE's plate, on the Z-only path,
    // left undeclared. The odd one out in this list: every other entry is an
    // XYZ setting, and this one is the setting the SHIPPED DEFAULT carries.
    'refuse-no-plate-thickness.nc',
  ].map((n) => [n, read(n)]);

  if (
    gen.status !== 0 || !fl || !br || !t8 || !zo || !moved || !turned || !zoMoved ||
    refusals.some(([, r]) => !r)
  ) {
    // A check that cannot run reports PENDING, never PASS.
    pend(
      'PROBE',
      `the core did not produce the probe dump (cargo exit ${gen.status}) — ` +
        `nothing about the touch plate has been checked`
    );
  } else {
    // L1 — the radius term, and the control that it is a TERM and not a constant.
    // wall 10 + radius 3 = 13; the same plate with an 8mm cutter must move by
    // exactly 1.0. A hardcoded 13 passes the first line and fails this one.
    const flX = datum(fl.gcode, 'X');
    const flY = datum(fl.gcode, 'Y');
    const t8X = datum(t8.gcode, 'X');
    const t8Y = datum(t8.gcode, 'Y');
    const radiusCarried =
      flX === -13 && flY === -13 && t8X === -14 && t8Y === -14 &&
      Math.abs(Math.abs(t8X) - Math.abs(flX) - 1.0) < 1e-9;
    // ...and Z must NOT carry it — the tip touches on the axis.
    const zHasNoRadius = datum(fl.gcode, 'Z') === 1.6 && datum(t8.gcode, 'Z') === 1.6;

    // L2 — the corner is read, not assumed: every X/Y sign inverts. The dump's
    // workpiece is 600x900 at the machine datum, so the back-right corner is at
    // (600, 900) and the wall+radius term is added OUTBOARD of it.
    const cornerRead = datum(br.gcode, 'X') === 613 && datum(br.gcode, 'Y') === 913;

    // L3/L4 — spindle and order, on the emitted program.
    const spin = spindleOffAcrossProbes(fl.gcode);
    const order = probeBeforeFirstCut(fl.gcode);

    // L5 — the refusals. Each must be rejected, name its setting, and emit NO
    // probing move at all: a refused probe that still emits G38.2 is a program
    // someone runs. Each token is chosen to be unique to its own message — the
    // wall's text also mentions `top_mm`, so the top limb asserts the qualified
    // `corner_plate.top_mm` and cannot be satisfied by the wrong refusal.
    const refusalNames = {
      'refuse-no-corner.nc': 'stock.corner_plate',
      'refuse-no-radius.nc': 'TOOL RADIUS',
      'refuse-no-top.nc': 'corner_plate.top_mm',
      'refuse-no-wall.nc': 'corner_plate.wall_mm',
      'refuse-no-depth.nc': 'corner_plate.xy_depth_mm',
      // 🔴 A plate that HAS no wall must not be refused as one nobody measured.
      // The token is the distinguishing half of the message, so a post that
      // collapsed the two states back into one `f64` fails here.
      'refuse-wall-absent.nc': 'NO WALL',
      'refuse-not-square.nc': "square to the machine's axes",
      'refuse-no-plate-thickness.nc': 'machine.touch_plate_mm',
    };
    const badRefusals = refusals
      .filter(([n, r]) => r.ok || !r.errors.includes(refusalNames[n]) || /^G38\./m.test(r.gcode))
      .map(([n]) => n);
    // ...and the two wall states must not share a message: the unmeasured one
    // must NOT claim the plate has no wall, or the distinction lives only in the
    // type and never reaches the person reading the refusal.
    const wallStatesDistinct = !(
      refusals.find(([n]) => n === 'refuse-no-wall.nc')?.[1]?.errors ?? ''
    ).includes('NO WALL');

    // L6 — the compatibility limb: a Z-only plate still works and claims no
    // X/Y datum it did not measure.
    const zOnlyClean =
      zo.ok && datum(zo.gcode, 'Z') === 1.6 && datum(zo.gcode, 'X') === null &&
      datum(zo.gcode, 'Y') === null;

    // L7 — the same properties through the REAL CLI, on the Z path it can reach.
    //
    // 🔴 THIS LIMB MOVED OFF `fixture rect-profile --probe` ON 2026-08-09, and
    // the reason is a real gap, not a convenience. Since decision #43 P0 a probe
    // needs a DECLARED plate thickness, and the `fixture` host has no flag to
    // declare one — `--probe` turns probing on and says nothing about the plate,
    // so it now (correctly) REFUSES and emits no probe to inspect. `job plate`
    // reaches the same Z-only path through the same binary AND declares a plate,
    // so the limb keeps its meaning instead of quietly measuring a refusal.
    // ⚠ NAMED RATHER THAN ABSORBED: `fixture … --probe` is a flag that can no
    // longer produce a probing program at all. Closing that is a `--touch-plate`
    // flag on the CLI, not a change here; L11 below is what proves the refusal
    // it produces today is the intended one.
    const cli = slice(['job', 'plate']);
    const cliSpin = spindleOffAcrossProbes(cli.stdout);
    const cliOrder = probeBeforeFirstCut(cli.stdout);
    const cliOk = cli.code === 0 && cliSpin.ok && cliOrder.ok && onlyG382(cli.stdout);

    // ---- TODO #40 -------------------------------------------------------
    // L8 — THE PLATE FOLLOWS THE WORKPIECE. The same machine and the same
    // plate, on a workpiece moved to (137, 42): the datum and the station must move
    // with it, exactly. Held still — which is what storing the plate on the
    // machine did — the X datum stays at -13 while every cut in the program has
    // already moved 137mm, and the part is cut 137mm from where it was drawn.
    const movedStations = stations(moved.gcode);
    const platefollows =
      moved.ok &&
      datum(moved.gcode, 'X') === 137 - 13 &&
      datum(moved.gcode, 'Y') === 42 - 13 &&
      movedStations.length > 0 &&
      movedStations[0][0] === 137 && movedStations[0][1] === 42 &&
      // Z is a property of the PLATE, not of where the workpiece is.
      datum(moved.gcode, 'Z') === 1.6 &&
      // ...and the control: the same plate at the machine datum is still at -13, so
      // the numbers above are read from the placement, not from a constant.
      datum(fl.gcode, 'X') === -13;

    // L8b — the same claim through the REAL BINARY, not through the dump. A
    // `--config` carrying `stock.corner_plate` + a moved origin must produce the
    // same displaced datum: the dump is one build of the core, the product is
    // another, and a claim proved only in a test is proved in the wrong place.
    const cfgPath = join(ROOT, 'target', 'gatecfg-probe-xyz.json');
    writeFileSync(
      cfgPath,
      JSON.stringify({
        machine: { probe_enabled: true, probe_plate: 'xyz' },
        stock: {
          origin_x_mm: 137,
          origin_y_mm: 42,
          corner_plate: {
            corner: 'front-left',
            top_mm: 1.6,
            wall_mm: 10,
            xy_depth_mm: 3,
          },
        },
        tool_id: 'End Mill - Down-cut 6mm 2F',
      })
    );
    let cliXyz = null;
    try {
      cliXyz = JSON.parse(slice(['report', 'plate', '--config', cfgPath]).stdout);
    } catch {
      cliXyz = null;
    }
    const cliXyzG = cliXyz?.gcode ?? '';

    // 🔴 THE EXPECTED DATUM HERE IS DERIVED, NOT TYPED. RE-POINTED 2026-08-11,
    // and the old number was WRONG rather than merely stale.
    //
    // It read `137 - 13` and `42 - 13`: the workpiece origin, less the 10mm
    // wall, less 3mm — the radius of the `tool_id` written into the config
    // above. That is not the cutter in the collet when the probe runs. `plate`
    // puts its 16 part-ID MARKING ops FIRST, and an engraving KEEPS THE TOOL IT
    // WAS GIVEN by design (`core/src/job.rs`; the program says so in its own
    // notes, once per mark), so the emitted program opens
    // `( tool: End Mill - Down-cut 3.175mm 2F )` and the X/Y probe touches with
    // the SIDE of a Ø3.175 cutter. 137 - 10 - 1.5875 = 125.4125.
    //
    // ⚠ HOW A WRONG CONSTANT SURVIVED IN A GATE WHOSE WHOLE SUBJECT IS THIS
    // NUMBER: the `tool_ids` door on the control tree had been emitting the
    // 3.175 header all along. PROBE only ever drove `tool_id`, so nothing in
    // the suite ever put the two side by side — the contradiction existed in
    // the tree and no check spanned it. Collapsing the two doors (4bcbf6d73f)
    // is what made the singular door emit what the set door already did, and
    // that is what turned this limb red. The limb was measuring the OLD door's
    // behaviour, not the plate's.
    //
    // DERIVATION — stated so the next tool change makes this go red for the
    // right reason instead of being edited again:
    //
    //   datum_axis = stock origin_axis
    //              - corner_plate.wall_mm
    //              - (D / 2) of the tool THE EMITTED PROGRAM FITS FIRST
    //
    // and D is read from that tool's row in `core/src/tools.rs` — the library
    // definition, which is a DIFFERENT source from the post that wrote the
    // datum. The program names WHICH tool; it does not get to say how wide it
    // is. (Its own `D3.17mm` header is 2dp and would not resolve 1.5875 anyway.)
    // If the fitted cutter changes, the expectation moves with it and this stays
    // green; if the post stops carrying the radius, or carries the wrong one,
    // the two sources disagree and this goes red.

    /** D of a library tool, from its `mk(...)` row — NOT from the program. */
    const libToolDiameter = (name) => {
      const src = readFileSync(join(ROOT, 'core/src/tools.rs'), 'utf8');
      const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const m = new RegExp(`mk\\(\\s*"${esc}"\\s*,\\s*ToolCategory::\\w+\\s*,\\s*([\\d.]+)`).exec(src);
      return m ? Number(m[1]) : null;
    };
    /** The tool the program declares it is running when it starts — the one at the probe. */
    const firstFittedTool = (g) => {
      const m = /^\( tool: (.+?) D[\d.]+mm F\d+ \)$/m.exec(g);
      return m ? m[1].trim() : null;
    };
    // Pure function of program text + the library figure, so the negative
    // control below can hand it the exact program the OLD constant described.
    const placementCarriesRadius = (g, originX, originY, wallMm, dMm) => {
      if (!g) return { ok: false, why: 'no program' };
      if (!(dMm > 0)) return { ok: false, why: 'no library diameter for the fitted tool' };
      const r = dMm / 2;
      const gx = datum(g, 'X');
      const gy = datum(g, 'Y');
      if (gx === null || gy === null) return { ok: false, why: 'no X/Y work-offset in the program' };
      // "Agrees to the precision the post emits" — the post writes 3dp, so a
      // half-count of the last digit is the whole tolerance. The smallest real
      // error this limb exists to catch (a Ø6 radius read for a Ø3.175 one) is
      // 1.4125mm, ~2800x this window: nothing about it is loose.
      const tol = 6e-4;
      const wantX = originX - wallMm - r;
      const wantY = originY - wallMm - r;
      if (Math.abs(gx - wantX) > tol || Math.abs(gy - wantY) > tol) {
        return {
          ok: false,
          why: `X${gx}/Y${gy} but D${dMm} at wall ${wallMm} from (${originX},${originY}) derives X${wantX}/Y${wantY}`,
        };
      }
      // ...and the radius must actually be a TERM. A post that dropped it
      // entirely would land on origin-wall, which no tolerance above excludes.
      if (Math.abs(gx - (originX - wallMm)) <= tol) {
        return { ok: false, why: 'the datum is origin-wall exactly — no radius term at all' };
      }
      return { ok: true, why: `X${gx} Y${gy} from D${dMm} (r${r})` };
    };
    const cliProbeTool = firstFittedTool(cliXyzG);
    const cliProbeD = cliProbeTool ? libToolDiameter(cliProbeTool) : null;
    const cliPlace = placementCarriesRadius(cliXyzG, 137, 42, 10, cliProbeD ?? NaN);
    const cliPlacement =
      cliPlace.ok && /^G38\.2 X/m.test(codeLines(cliXyzG).join('\n'));

    // L9 — A TURNED WORKPIECE TAKES ITS PLATE ROUND WITH IT. 600x900 at 90deg
    // measures 900x600 in machine coordinates, and the workpiece's front-LEFT corner ends up at
    // the machine's MAXIMUM X — so the stand-off must reverse. `ProbeCorner`'s own
    // signs cannot know this: they name a side of the WORKPIECE, not of the machine.
    const turnedStations = stations(turned.gcode);
    const plateTurns =
      turned.ok &&
      datum(turned.gcode, 'X') === 900 + 13 &&
      datum(turned.gcode, 'Y') === -13 &&
      turnedStations.length > 0 &&
      turnedStations[0][0] === 900 && turnedStations[0][1] === 0;

    // L10 — THE OTHER HALF OF THE SPLIT. A FIXED plate is bolted to the machine
    // and must NOT follow the workpiece. Without this, a post that moved everything
    // with the workpiece would pass L8 and L9 and be wrong in the other direction.
    const zoMovedStations = stations(zoMoved.gcode);
    const fixedPlateStays =
      zoMoved.ok &&
      zoMovedStations.length > 0 &&
      zoMovedStations[0][0] === 25 && zoMovedStations[0][1] === 30 &&
      !zoMovedStations.some(([x, y]) => x === 137 && y === 42) &&
      datum(zoMoved.gcode, 'X') === null && datum(zoMoved.gcode, 'Y') === null;

    // L11 — 🔴 THE MACHINE'S OWN PLATE THICKNESS, THROUGH THE REAL BINARY AND
    // ITS OWN `--plant`. Decision #43 P0.
    //
    // PHYSICAL FAILURE, and it is the one on the Z-only path every existing
    // machine definition takes: `G10 L20 P1 Z<top>` is emitted at the moment of
    // contact, so the declared top decides where work-zero lands and therefore
    // how deep EVERY cut in the program runs. Until 2026-08-09 the field was a
    // bare `f64` defaulting to an unsourced `1.6`, and a shop that had never
    // been asked for the number got a full probing sequence datumed on it — no
    // symptom in the preview, and the program cuts shallow (or, with a
    // plausible catalogue figure, toward the spoilboard: the two directions are
    // NOT symmetric, see `types.rs`).
    //
    // The limb is a PAIR on purpose. `job plate` declares a plate and must
    // still probe — otherwise "it refused" would be indistinguishable from a
    // post that had stopped probing altogether — and the same job under
    // `--plant undeclared-plate` must be REFUSED, name the field, and emit
    // nothing at all on stdout.
    const declared = slice(['job', 'plate']);
    const undeclared = slice(['job', 'plate', '--plant', 'undeclared-plate']);
    const declaredProbes =
      declared.code === 0 && /^G38\.2\b/m.test(codeLines(declared.stdout).join('\n'));
    const undeclaredRefused =
      undeclared.code !== 0 &&
      undeclared.stdout.trim() === '' &&
      /machine\.touch_plate_mm/.test(undeclared.stderr) &&
      /calipers/.test(undeclared.stderr) &&
      !/G38\./.test(undeclared.stdout);
    const plateThicknessDeclaredOrRefused = declaredProbes && undeclaredRefused;

    // ---- NEGATIVE CONTROLS, permanent. Each checker is handed a program that
    // carries exactly the defect it exists to catch. If a checker cannot be made
    // to fail, it is not checking anything.
    const ctlSpindle = !spindleOffAcrossProbes(
      fl.gcode.replace(/^M5$/m, 'M3 S18000')
    ).ok;
    const ctlOrder = !probeBeforeFirstCut(`M5\nG1 X10.000 F600.0\n${fl.gcode}`).ok;
    const ctlDialect = !onlyG382(fl.gcode.replace('G38.2', 'G38.3'));
    const ctlRadius = datum(fl.gcode.replace('G10 L20 P1 X-13.000', 'G10 L20 P1 X-10.000'), 'X') === -10;
    // 🔴 The control for the placement limb, and the reason it is not decoration:
    // hand it the program a plate-left-behind post WOULD have emitted — the
    // moved workpiece with the datum still written at the machine origin — and watch the
    // checker reject it. This is the exact text the pre-#40 core produced.
    const ctlPlacement = !(
      datum(moved.gcode.replace('G10 L20 P1 X124.000', 'G10 L20 P1 X-13.000'), 'X') === 137 - 13
    );
    // ...and the control for L10: a fixed plate that DID follow the workpiece must
    // be caught, or "it stayed put" is vouching for an arrangement.
    const ctlFixed = (() => {
      const s = stations(zoMoved.gcode.replace('G0 X25.000 Y30.000', 'G0 X137.000 Y42.000'));
      return s.length > 0 && !(s[0][0] === 25 && s[0][1] === 30);
    })();
    // 🔴 THE CONTROL FOR THE RE-POINTED L8b DERIVATION (2026-08-11). Two arms,
    // because the limb can fail in two directions and only one of them was ever
    // exercised:
    //
    //  (a) the datum written for the CONFIGURED tool instead of the FITTED one —
    //      literally the constant this limb carried until today (X124.000 /
    //      Y29.000, a Ø6 radius). Hand the checker that program and it must
    //      reject it. This arm is what makes today's correction a re-pointing
    //      rather than a relaxation: the number the gate used to demand is now
    //      a number it must refuse.
    //  (b) the radius dropped entirely (datum = origin - wall). A tolerance-only
    //      check would pass a post that had stopped carrying the term at all if
    //      the tool ever went to zero width.
    const ctlDerivedA = (() => {
      if (!cliXyzG || !(cliProbeD > 0)) return false;
      const wrong = cliXyzG
        .replace(/^G10 L20 P1 X-?[\d.]+$/m, 'G10 L20 P1 X124.000')
        .replace(/^G10 L20 P1 Y-?[\d.]+$/m, 'G10 L20 P1 Y29.000');
      return !placementCarriesRadius(wrong, 137, 42, 10, cliProbeD).ok;
    })();
    const ctlDerivedB = (() => {
      if (!cliXyzG || !(cliProbeD > 0)) return false;
      const noRadius = cliXyzG
        .replace(/^G10 L20 P1 X-?[\d.]+$/m, 'G10 L20 P1 X127.000')
        .replace(/^G10 L20 P1 Y-?[\d.]+$/m, 'G10 L20 P1 Y32.000');
      return !placementCarriesRadius(noRadius, 137, 42, 10, cliProbeD).ok;
    })();
    const controls =
      ctlSpindle && ctlOrder && ctlDialect && ctlRadius && ctlPlacement && ctlFixed &&
      ctlDerivedA && ctlDerivedB;

    if (
      radiusCarried && zHasNoRadius && cornerRead && spin.ok && order.ok &&
      badRefusals.length === 0 && wallStatesDistinct && zOnlyClean && cliOk &&
      onlyG382(fl.gcode) && platefollows && cliPlacement && plateTurns && fixedPlateStays &&
      plateThicknessDeclaredOrRefused && controls
    ) {
      pass(
        'PROBE',
        `X/Y datums carry the tool radius (6mm -> ${flX}, 8mm -> ${t8X}, exactly one radius ` +
          `apart) and Z does not (${datum(fl.gcode, 'Z')} = plate top only); the corner inverts ` +
          `every X/Y sign (back-right -> ${datum(br.gcode, 'X')}); the CORNER PLATE FOLLOWS THE ` +
          `WORKPIECE — a workpiece moved to (137,42) puts the datum at ` +
          `${datum(moved.gcode, 'X')}/${datum(moved.gcode, 'Y')} and the station at ` +
          `(${movedStations[0]}), and a quarter turn ` +
          `carries it to X${datum(turned.gcode, 'X')} with the stand-off reversed; a FIXED plate ` +
          `does NOT follow (station stays at ${zoMovedStations[0]}); M5 precedes every probe and ` +
          `no probe runs under M3; the probe precedes the first cut (${order.why}); G38.2 only; ` +
          `8/8 undeclared or unrunnable settings refused with no G38 emitted, and a plate that HAS `+
          `no wall is refused differently from one nobody measured; an UNDECLARED ` +
          `machine.touch_plate_mm is refused through the real binary (\`job plate ` +
          `--plant undeclared-plate\` exits ${undeclared.code} with empty stdout) while the same ` +
          `job with a declared plate still probes; the Z-only plate is ` +
          `unchanged and claims no X/Y datum; the real CLI \`job plate\` program agrees on spindle ` +
          `and order. THROUGH THE REAL BINARY (\`report plate --config\`), the placement datum is ` +
          `DERIVED, not typed: the program fits \`${cliProbeTool}\` first — an engraving keeps its ` +
          `own tool, and \`plate\` marks before it cuts — so origin 137/42 less wall 10 less ` +
          `D${cliProbeD}/2 read from that tool's row in core/src/tools.rs gives ${cliPlace.why}; ` +
          `the configured tool_id (Ø6, the constant this limb carried until 2026-08-11) is REFUSED ` +
          `by the same checker, as is a datum with no radius term at all. ` +
          `NOT COVERED: browser parity for the XYZ path — I1/K3 compare the fixtures, and ` +
          `no fixture declares a corner plate`
      );
    } else {
      fail(
        'PROBE',
        `radiusCarried=${radiusCarried}(6mm X=${flX} Y=${flY}, 8mm X=${t8X} Y=${t8Y}) ` +
          `zHasNoRadius=${zHasNoRadius} cornerRead=${cornerRead}(BR X=${datum(br.gcode, 'X')} ` +
          `Y=${datum(br.gcode, 'Y')}) platefollows=${platefollows}(X=${datum(moved.gcode, 'X')} ` +
          `Y=${datum(moved.gcode, 'Y')} station=${JSON.stringify(movedStations[0])}) ` +
          `cliPlacement=${cliPlacement}(fitted=${cliProbeTool} D=${cliProbeD} ${cliPlace.why}) ` +
          `plateTurns=${plateTurns}(X=${datum(turned.gcode, 'X')} Y=${datum(turned.gcode, 'Y')} ` +
          `station=${JSON.stringify(turnedStations[0])}) ` +
          `fixedPlateStays=${fixedPlateStays}(station=${JSON.stringify(zoMovedStations[0])}) ` +
          `spindle=${spin.ok}(${spin.why}) order=${order.ok}(${order.why}) ` +
          `unrefused=[${badRefusals.join(',')}] wallStatesDistinct=${wallStatesDistinct} `+
          `zOnlyClean=${zOnlyClean} ` +
          `plateThickness=${plateThicknessDeclaredOrRefused}(declaredProbes=${declaredProbes} ` +
          `undeclaredRefused=${undeclaredRefused} exit=${undeclared.code} ` +
          `stdout=${undeclared.stdout.trim().length}B) ` +
          `cli=${cliOk}(code=${cli.code} spin=${cliSpin.why} order=${cliOrder.why}) ` +
          `g382only=${onlyG382(fl.gcode)} controls=${controls}` +
          (controls
            ? ''
            : ` [spindle=${ctlSpindle} order=${ctlOrder} dialect=${ctlDialect} radius=${ctlRadius} ` +
              `placement=${ctlPlacement} fixed=${ctlFixed} derived-wrong-tool=${ctlDerivedA} ` +
              `derived-no-radius=${ctlDerivedB}]`)
      );
    }
  }
}

// --- TOOL: the cutter is chosen or the job is refused -----------------------
//
// 🔴 The defect, measured at HEAD on 2026-08-09 before the fix. `fixtures.rs`
// resolved the tool with
//
//     .unwrap_or_else(|| end_mill(6.0))
//
// and TWO different failures fell into it:
//
//   1. NOTHING CHOSEN — `import plate.dxf` planned a complete 9,390-byte
//      program on a Ø6mm end mill and exited 0.
//   2. A MISTYPED id — `find()` returned None and the same line swallowed it.
//      `report plate --config '{"tool_id":"endmill-6"}'` emitted 11,976 bytes.
//
// The second is the worse of the two: case 1 at least corresponds to "the user
// chose nothing", while case 2 is a program that silently CONTRADICTS an
// explicit instruction. Both post, download and cut.
//
// ⚠ This gate asserts on the EMITTED PROGRAM — the byte length of stdout and
// the report's own `gcode` — never on the config that was supposed to produce
// it. The sixth time this lane has had to write that sentence (P3, P4, ENT,
// JobSummary, REL). A refusal that prints a message above a program that still
// posts is gate G13's failure mode, not a refusal.
{
  const cfgFile = (name, obj) => {
    const f = join(ROOT, 'target', `gatecfg-${name}.json`);
    writeFileSync(f, JSON.stringify(obj));
    return f;
  };
  const TYPO = cfgFile('tool-typo', { tool_id: 'endmill-6' });
  const GOOD = cfgFile('tool-good', { tool_id: 'End Mill - Down-cut 6mm 2F' });
  // Both fields at once. `assign_tools_from_set` ASSIGNS `tool_set_refusals`
  // rather than extending it, so a refusal recorded before it is deleted by a
  // config that also carries `tool_ids` — a safety check that evaporates on one
  // input shape while the code still reads as if it is there.
  const BOTH = cfgFile('tool-both', {
    tool_id: 'endmill-6',
    tool_ids: ['End Mill - Down-cut 6mm 2F', 'Drill - Brad Point 4mm 2F'],
  });
  const DXF = join(ROOT, 'gates/fixtures/plate.dxf');

  const imp = (args) => {
    const r = slice(['import', DXF, ...args, '--json']);
    let j = null;
    try {
      j = JSON.parse(r.stdout);
    } catch {
      /* left null — reported below */
    }
    return { ...r, j };
  };
  const rep = (args) => {
    const r = slice(['report', 'plate', ...args]);
    let j = null;
    try {
      j = JSON.parse(r.stdout);
    } catch {
      /* left null */
    }
    return { ...r, j };
  };
  // A refusal means NO PROGRAM EXISTS. Not a short one, not a preamble — none.
  const refusedEmpty = (j) => !!j && j.ok === false && (j.gcode ?? '').length === 0;
  const why = (j) => (j?.refusals ?? []).join(' | ');

  // --- L1/L2: the two import failures, told apart -------------------------
  const absent = imp([]);
  const unknown = imp(['--config', TYPO]);
  const l1 = refusedEmpty(absent.j);
  const l2 = refusedEmpty(unknown.j);
  // 🔴 DISTINGUISHABLE. "You chose nothing" and "what you chose does not exist"
  // have different fixes — the picker vs the spelling — so neither message may
  // carry the other's key phrase. Equal-but-different text is not enough: a
  // host keying on one must not match the other.
  const A_KEY = 'no cutting tool was selected';
  const U_KEY = 'is not a tool in the library';
  const distinct =
    why(absent.j).includes(A_KEY) &&
    !why(absent.j).includes(U_KEY) &&
    why(unknown.j).includes(U_KEY) &&
    !why(unknown.j).includes(A_KEY);
  // The typed id is quoted back, or the operator retypes it verbatim.
  const namesId = why(unknown.j).includes('endmill-6');
  // ...and is given somewhere to go.
  const offersNear = why(unknown.j).includes('End Mill -');

  // --- L3: the same defect on the FIXTURE path (JobConfig::apply) ----------
  const sibling = rep(['--config', TYPO]);
  const l3 = refusedEmpty(sibling.j);
  // ...and it survives a config that also carries a valid set.
  const both = rep(['--config', BOTH]);
  const l4 = refusedEmpty(both.j);

  // --- L5: the CLI's own exit contract, through the real binary -----------
  // Not the JSON: a script reads the exit code and pipes stdout to a file.
  const cliAbsent = slice(['import', DXF]);
  const cliUnknown = slice(['import', DXF, '--config', TYPO]);
  const cliExit =
    cliAbsent.code === 1 &&
    cliAbsent.stdout.trim().length === 0 &&
    cliUnknown.code === 1 &&
    cliUnknown.stdout.trim().length === 0;

  // --- the NEGATIVE CONTROL, run on every pass ----------------------------
  // 🔴 A PAIR, and the second half is the point. `--plant tool-substitute`
  // restores the pre-fix swallow verbatim, so the planted run must produce a
  // RUNNABLE PROGRAM. Its polarity is the inverse of every other plant here:
  // the others put a defect INTO a good job and the gate asserts a refusal;
  // this one takes the refusal OUT and the gate asserts a program.
  //
  // Without this half, a plant that quietly stopped planting would be
  // indistinguishable from a codebase that is clean — the control would read
  // green forever while proving nothing, which is the exact failure DOC's
  // in-gate control and REL's rebuilt order exist to prevent.
  const planted = rep(['--config', TYPO, '--plant', 'tool-substitute']);
  const controlLive = !!planted.j && planted.j.ok === true && (planted.j.gcode ?? '').length > 0;
  // ...and the plant must be a REAL flag on this path, not one that is parsed
  // and ignored. ⚠ The reason recorded here is now HALF STALE and is corrected
  // rather than deleted: `import --plant <x>` DID exit 0 and silently ignore
  // every plant, and as of 2026-08-09 it exits 2 instead (gate FLAG). What has
  // not changed is why the control lives on `report`: `import` still cannot
  // APPLY a plant — the core's import path takes no plant argument — so it
  // refuses rather than honours, and only `report` can drive this control.
  const plantHonoured = slice(['report', 'plate', '--plant', 'no-such-plant']).code === 2;

  // --- the regressions: choosing a tool must still WORK -------------------
  const okImport = imp(['--config', GOOD]);
  const okFixture = rep([]);
  const stillPlans =
    !!okImport.j &&
    okImport.j.ok === true &&
    okImport.j.gcode.length > 0 &&
    !!okFixture.j &&
    okFixture.j.ok === true &&
    okFixture.j.gcode.length > 0;

  if (
    l1 && l2 && l3 && l4 && distinct && namesId && offersNear && cliExit &&
    controlLive && plantHonoured && stillPlans
  ) {
    pass(
      'TOOL',
      `no tool and an unresolvable tool_id are BOTH refused with zero G-code, on the import ` +
        `path and on the fixture path (and the refusal survives a valid tool_ids beside it); ` +
        `the two refusals are distinguishable ("${A_KEY}" vs "${U_KEY}"), the typed id is quoted ` +
        `back and the nearest library ids offered; the real CLI exits 1 with empty stdout on ` +
        `both. NEGATIVE CONTROL: --plant tool-substitute restores the substitution and emits ` +
        `${planted.j?.gcode?.length ?? 0}B, and an unknown plant on this path still exits 2. ` +
        `A chosen tool still plans (import ${okImport.j?.gcode?.length ?? 0}B, fixture ` +
        `${okFixture.j?.gcode?.length ?? 0}B)`
    );
  } else {
    fail(
      'TOOL',
      `noToolRefused=${l1}(${absent.j?.gcode?.length ?? '?'}B) ` +
        `unknownIdRefused=${l2}(${unknown.j?.gcode?.length ?? '?'}B) ` +
        `fixturePathRefused=${l3}(${sibling.j?.gcode?.length ?? '?'}B) ` +
        `survivesToolIds=${l4}(${both.j?.gcode?.length ?? '?'}B) ` +
        `distinguishable=${distinct} namesId=${namesId} offersNear=${offersNear} ` +
        `cliExitContract=${cliExit} stillPlans=${stillPlans} ` +
        `CONTROL[plantEmits=${controlLive}(${planted.j?.gcode?.length ?? '?'}B) ` +
        `unknownPlantErrors=${plantHonoured}] ` +
        `absent="${why(absent.j).slice(0, 90)}" unknown="${why(unknown.j).slice(0, 90)}"`
    );
  }
}

// --- DOOR: `tool_id: X` and `tool_ids: [X]` must be the same door ----------
//
// 🔴 THE DEFECT, MEASURED. The core has TWO WAYS to be told which cutter is in
// the spindle, and for ONE cutter they are supposed to mean the same thing.
// They do not — they are different code paths and only one of them is checked:
//
//   `tool_ids` -> `job.rs::assign_tools_from_set` -> `recommend.rs::recommend()`
//                 per feature. Every rejection becomes a `tool_set_refusals`
//                 entry and reaches the check at `job.rs:1140`, which refuses.
//   `tool_id`  -> `job.rs` sets the tool on every operation and RETURNS.
//                 `apply_tool_set` receives `None` and returns immediately, so
//                 `tool_set_refusals` stays EMPTY and the check at `job.rs:1140`
//                 has nothing to refuse. The recommender is never called.
//
// ⇒ "one tool works, so one tool can make it" was FALSE. The one-tool run was
// not passing the per-feature check; it was SKIPPING it. The headline case, and
// it reproduces on this box on every run of this gate:
//
//   report pocket --config '{"tool_id":  "End Mill - Down-cut 6mm 2F"}'
//     -> ok: true, 962 lines of G-code, refusals: [], warnings: []
//        ...and the simulator ON THAT SAME RUN reports uncut: 3, first at
//        (120.6, 90.6), 6.0mm of material still standing.
//   report pocket --config '{"tool_ids":["End Mill - Down-cut 6mm 2F"]}'
//     -> ok: false, ZERO bytes, refused: "6mm does not fit inside this loop;
//        offsetting the loop in by the tool radius leaves nothing to cut"
//
// The physical failure is P2's and P9's arriving through a door neither of them
// watches: a pocket that leaves an island standing, in a program declared OK
// with nothing said. `Drill - Brad Point 6mm 2F` is worse — it clears the
// singular door on `plate`, `pocket`, `socket` and `clamped` and emits PROFILE
// CONTOURS CUT WITH A DRILL BIT, which the set door refuses in as many words:
// "its cutting geometry is on the point, not the flank".
//
// 🔴 WHY THIS GATE HAS NO ALLOWANCE LIST, AND WILL NOT BE GIVEN ONE. Some of
// the divergences look like the set door being RIGHT rather than the singular
// door being wrong — on `plate` the set door re-decides Profile->Drill at
// `job.rs:2081-2098` and the singular door does not. It is still two doors
// disagreeing about the same cutter, and a gate that permits "some
// disagreement" cannot tell the benign direction from the dangerous one, which
// is the entire question. A blanket tolerance here would be a control that
// reports the defect it exists for as within budget. So: exact agreement, zero
// entries, and the classes are reported separately so a reader can tell them
// apart without the gate having to pretend it can.
//
// ⚠ AND "BENIGN" DID NOT SURVIVE BEING LOOKED AT. Three of the same-verdict
// divergences (`socket` and `clamped` on the 6mm class) have IDENTICAL LINE
// COUNTS and differ only in `M3 S18000` / `F3600.0` against `M3 S24000` /
// `F4800.0` — the same cutter in the same job, run at two different spindle
// speeds and two different feeds depending on which door was used. A comparison
// keyed on line count reads those as agreement. This one compares BYTES.
//
// 🔴 WHAT A GREEN HERE WOULD MEAN, said now rather than when someone needs it:
//   it means the CORE's two doors produce the same verdict and the same program
//   bytes for every (fixture, single tool) pair. Nothing else.
// 🔴 WHAT IT WOULD STILL NOT SEE:
//   1. WHICH DOOR ANY HOST USES. `web/src/App.tsx` now sends `tool_ids` always,
//      which removes the browser's REACH to the singular door and changes
//      nothing about the asymmetry — this gate would still be red. Conversely a
//      green here says the singular door is now equivalent, not that anyone
//      stopped calling it. Those are different facts and only this gate's is
//      measured here.
//   2. WHETHER EITHER DOOR IS RIGHT. Agreement is not correctness: both doors
//      could agree on a program that gouges. P1-P9, TOOL, DOC and ENT are what
//      say anything about that.
//   3. MORE THAN ONE TOOL. A set of two or more has no singular counterpart, so
//      there is nothing to compare and this gate is silent about it.
//
// COST, measured rather than budgeted: 6 fixtures x the whole 51-tool library
// = 306 pairs = 612 `report` invocations at ~21ms, ~13s, on a `--quick` run
// that takes ~22s without it. It runs in `--quick` ANYWAY, and that is a
// deliberate choice: `--quick` is what people actually run, SLICER-GATES.md §4
// exists because a `--quick` run and a full run disagreed about a verdict, and
// the alternative — a sweep that only runs behind the wasm rebuild — is a gate
// that does not run. The re-drive through `job` below is proportional to the
// number of DISAGREEMENTS, so it costs ~3s today and ~0 once the core is fixed.
{
  const DIR = join(ROOT, 'target', 'gate-door');
  mkdirSync(DIR, { recursive: true });
  const cfgPath = (side, i) => join(DIR, `${side}${i}.json`);
  // Instrument faults are kept apart from divergences on purpose. A divergence
  // is a finding ABOUT THE PRODUCT; an instrument fault means this run does not
  // know what it measured, and the two must not be summed into one number.
  const broken = [];

  // --- the tool library, DISCOVERED rather than enumerated ----------------
  // An enumerated list goes blind to whatever is added after it was written,
  // and a sweep that quietly covers fewer cases reports a clean sweep of the
  // cases it still runs. The union of chosen + alternatives + rejected across
  // every feature of one drawing IS the library, and `library_size` is the
  // core's own count of it — so the discovery is CHECKED, not assumed.
  const recRaw = slice(['recommend', join(ROOT, 'gates/fixtures/plate.dxf'), '--json', '--all-rejections']);
  let rec = null;
  try {
    rec = JSON.parse(recRaw.stdout);
  } catch {
    /* reported below — an unreadable library is not an empty one */
  }
  let TOOLS = [];
  if (!rec || !Array.isArray(rec.choices)) {
    broken.push(`the tool library could not be read from \`recommend --json\` (exit ${recRaw.code}) — this sweep has no set to sweep`);
  } else {
    const seen = new Set();
    for (const c of rec.choices) {
      if (c.tool) seen.add(c.tool);
      for (const a of c.alternatives ?? []) seen.add(a);
      for (const r of c.rejected ?? []) if (r.tool) seen.add(r.tool);
    }
    TOOLS = [...seen].sort();
    if (selfPlanted('door-library-blind')) TOOLS = TOOLS.slice(0, 5);
    if (TOOLS.length !== rec.library_size) {
      broken.push(
        `the sweep covers ${TOOLS.length} tool(s) and the core reports a library of ${rec.library_size} — ` +
          `a matrix that narrows silently reports a clean sweep of the cases it still runs`
      );
    }
  }

  // --- the fixtures, likewise discovered ----------------------------------
  const JOBS = slice(['jobs']).stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split(/\s+/)[0]);
  if (JOBS.length === 0) broken.push('`jobs` listed no fixture — there is nothing to sweep');

  // --- INSTRUMENT: the two sides really are two DIFFERENT doors ------------
  // 🔴 The one failure this whole gate cannot survive: comparing a door with
  // itself. It agrees perfectly, always, and reads exactly like a fixed core.
  // So the config that was actually written to disk is read back and its SHAPE
  // asserted — `--self-plant door-same-door` is this limb's negative control.
  TOOLS.forEach((t, i) => {
    writeFileSync(cfgPath('s', i), JSON.stringify(selfPlanted('door-same-door') ? { tool_ids: [t] } : { tool_id: t }));
    writeFileSync(cfgPath('m', i), JSON.stringify({ tool_ids: [t] }));
  });
  if (TOOLS.length) {
    const s0 = JSON.parse(readFileSync(cfgPath('s', 0), 'utf8'));
    const m0 = JSON.parse(readFileSync(cfgPath('m', 0), 'utf8'));
    if (!('tool_id' in s0) || 'tool_ids' in s0 || !('tool_ids' in m0) || 'tool_id' in m0) {
      broken.push(
        `DEAD INSTRUMENT: the two sides were driven with ${JSON.stringify(s0)} and ${JSON.stringify(m0)} — ` +
          `that is one door compared with itself, and "the two doors agree" is not what this run measured`
      );
    }
  }

  const rep = (jobName, f) => {
    const r = slice(['report', jobName, '--config', f]);
    let j = null;
    try {
      j = JSON.parse(r.stdout);
    } catch {
      /* reported at the call site */
    }
    return { ...r, j };
  };

  // --- the classification, as a function, so it can be CONTROLLED ---------
  // 🔴 Extracted for one reason: the DIFFERENT-PROGRAM branch is not reachable
  // from any agreeing pair on this tree (there are none that emit), so the byte
  // comparison is exercised today only by the 12 real divergences — and the day
  // the core is fixed those vanish and the branch would go vacuous with nothing
  // to say so. `--self-plant door-inject` is the live control; this table is
  // the one that cannot become vacuous, because it supplies its own inputs.
  const classify = (sok, mok, sg, mg) =>
    sok !== mok ? (sok ? 'EMITS-vs-REFUSES' : 'REFUSES-vs-EMITS') : sok && sg !== mg ? 'DIFFERENT-PROGRAM' : 'AGREE';
  for (const [sok, mok, sg, mg, want] of [
    [true, true, 'G0 X1\n', 'G0 X1\n', 'AGREE'],
    [true, true, 'G0 X1\n', 'G0 X1\nG0 X2\n', 'DIFFERENT-PROGRAM'],
    [true, true, 'G0 X1\n', 'G0 X1', 'DIFFERENT-PROGRAM'],
    [true, false, 'G0 X1\n', '', 'EMITS-vs-REFUSES'],
    [false, true, '', 'G0 X1\n', 'REFUSES-vs-EMITS'],
    [false, false, '', '', 'AGREE'],
  ]) {
    const got = classify(sok, mok, sg, mg);
    if (got !== want) {
      broken.push(
        `the comparator called (${sok}, ${mok}, ${JSON.stringify(sg)}, ${JSON.stringify(mg)}) "${got}" ` +
          `and it is "${want}" — every count below was produced by this function`
      );
    }
  }

  // --- the matrix ---------------------------------------------------------
  const rows = [];
  let agreeBothEmit = 0;
  let agreeBothRefuse = 0;
  let singularEmitted = 0;
  let setEmitted = 0;
  let keptAgreeing = false;
  let injected = null;
  for (const jb of JOBS) {
    for (let i = 0; i < TOOLS.length; i++) {
      const t = TOOLS[i];
      const s = rep(jb, cfgPath('s', i));
      const m = rep(jb, cfgPath('m', i));
      if (!s.j || !m.j) {
        broken.push(
          `${jb} x ${t}: \`report\` returned no JSON (singular exit ${s.code}, set exit ${m.code}) — ` +
            `an unreadable answer is not an agreement`
        );
        continue;
      }
      let sok = s.j.ok === true;
      const mok = m.j.ok === true;
      let sg = s.j.gcode ?? '';
      const mg = m.j.gcode ?? '';
      // `--self-plant door-inject`: perturb the SINGULAR result of the first
      // pair that genuinely agrees — an extra line where both doors emitted, a
      // synthetic program where both refused. Whichever arm fires, the clean run
      // and the planted run must differ by exactly one named pair.
      let wasPlanted = false;
      if (selfPlanted('door-inject') && !injected && sok === mok && (!sok || sg === mg)) {
        injected = `${jb} x ${t} (${sok ? 'an extra line on a program both doors emitted' : 'a synthetic program where both doors refused'})`;
        if (sok) sg += '\nG0 X0.000 (planted)';
        else {
          sok = true;
          sg = '(planted)\nG0 X0.000\nM30\n';
        }
        wasPlanted = true;
      }
      const cls = classify(sok, mok, sg, mg);
      if (sok) singularEmitted++;
      if (mok) setEmitted++;
      if (cls === 'AGREE') {
        if (sok) agreeBothEmit++;
        else agreeBothRefuse++;
      }
      // The program text is kept only where it is needed — for the pairs that
      // are re-driven through `job` below. 306 whole programs is 4MB of nothing.
      // ⚠ ONE agreeing pair is kept whatever its verdict, and deliberately not
      // "the first agreeing pair where both doors EMIT": on this tree there is
      // no such pair — see the `agreeBothEmit` note below — so a keep-rule that
      // asked for one would have silently kept nothing and left the `job`
      // corroboration with only diverging pairs to work from, which is exactly
      // the leg that must survive the core being fixed.
      let keep = cls !== 'AGREE';
      if (cls === 'AGREE' && !keptAgreeing) {
        keep = true;
        keptAgreeing = true;
      }
      rows.push({
        job: jb,
        tool: t,
        i,
        sok,
        mok,
        cls,
        planted: wasPlanted,
        sLines: sg ? sg.split('\n').length : 0,
        mLines: mg ? mg.split('\n').length : 0,
        uncut: s.j.sim?.uncut ?? null,
        first: s.j.sim?.first ?? null,
        sWhy: (s.j.refusals ?? []).join(' | '),
        mWhy: (m.j.refusals ?? []).join(' | '),
        sg: keep ? sg : null,
        mg: keep ? mg : null,
      });
    }
  }
  const diverging = rows.filter((r) => r.cls !== 'AGREE');
  const agreeing = rows.filter((r) => r.cls === 'AGREE');

  // --- INSTRUMENT: the comparator can report BOTH answers -----------------
  // A comparator that always says "different" would be red on a fixed core and
  // nobody would know. A comparator that always says "same" is the failure the
  // shape check above guards. Both directions are asserted, from real pairs.
  if (rows.length && agreeing.length === 0) {
    broken.push(
      `the comparator reported a difference on ALL ${rows.length} pair(s) and agreement on none — ` +
        `a comparison that cannot come out equal proves nothing when it comes out unequal`
    );
  }
  // ⚠ The liveness question is PER DOOR, not per pair, and getting that wrong
  // produced this gate's first red — an instrument fault reading "no pair had
  // BOTH doors emit a program", which is TRUE HERE and is a fact about the
  // defect, not about the harness: on this tree every pair either has both
  // doors refuse (they agree) or has them emit different things (they do not),
  // so `agreeBothEmit` is legitimately 0 and must not be an error. What would
  // really be an instrument fault is a door that emitted NOTHING ANYWHERE.
  if (rows.length && singularEmitted === 0) {
    broken.push('the `tool_id` door emitted no program on ANY pair — a door that refuses everything agrees with nothing');
  }
  if (rows.length && setEmitted === 0) {
    broken.push('the `tool_ids` door emitted no program on ANY pair — a door that refuses everything agrees with nothing');
  }
  if (rows.length && agreeBothRefuse === 0 && agreeBothEmit === 0) {
    broken.push('no pair agreed in either direction — see above; a comparison that never comes out equal proves nothing when it comes out unequal');
  }
  // 🔴 A PLANT THAT PLANTS NOTHING RUNS CLEAN AND READS AS A PASSING CONTROL —
  // gate PLANT's founding failure, and this one's first draft did exactly that.
  if (selfPlanted('door-inject') && !injected) {
    broken.push('`--self-plant door-inject` found no agreeing pair to perturb and planted NOTHING — an inert control is worse than no control');
  }

  // --- every pair this gate NAMES is re-driven through the EMITTING host ---
  // 🔴 `report` answers in JSON; `job` is what prints the program an operator
  // sends to the machine. This lane's standing rule is to assert on the emitted
  // program, so the claim "the singular door EMITS what the set door REFUSES"
  // is confirmed at the host that emits — byte-for-byte, plus the exit contract
  // (`job` exits 1 with empty stdout on a refusal, 0 with the program on a
  // pass; `report` exits 0 either way and is therefore no evidence at all).
  // One AGREEING pair is re-driven too, so this limb is not vacuous on a fixed
  // core, and so a `report`-vs-`job` split cannot hide inside the agreements.
  // ⚠ A planted row is EXCLUDED here — its `sg` is a string this harness wrote,
  // so re-driving it through `job` would compare the product against a fiction
  // and produce an instrument fault that says nothing about the product.
  const corroborate = diverging.filter((r) => !r.planted).concat(agreeing.filter((r) => r.sg !== null).slice(0, 1));
  let corroborated = 0;
  for (const d of corroborate) {
    for (const [side, want, txt] of [
      ['s', d.sok, d.sg],
      ['m', d.mok, d.mg],
    ]) {
      if (txt === null) continue;
      const r = slice(['job', d.job, '--config', cfgPath(side, d.i)]);
      const doorName = side === 's' ? 'tool_id' : 'tool_ids';
      if (want) {
        if (r.code !== 0 || r.stdout !== txt) {
          broken.push(
            `${d.job} x ${d.tool} (${doorName}): \`report\` says a ${txt.length}B program and \`job\` ` +
              `exits ${r.code} with ${r.stdout.length}B${r.stdout === txt ? '' : ' of DIFFERENT bytes'} — ` +
              `this gate is measuring through a door the operator does not use`
          );
        } else corroborated++;
      } else if (r.code !== 1 || r.stdout.trim().length !== 0) {
        broken.push(
          `${d.job} x ${d.tool} (${doorName}): \`report\` says REFUSED and \`job\` exits ${r.code} with ` +
            `${r.stdout.length}B on stdout — a refusal that still prints G-code is gate G13's failure`
        );
      } else corroborated++;
    }
  }

  const byClass = {};
  for (const r of diverging) byClass[r.cls] = (byClass[r.cls] ?? 0) + 1;
  // 🔴 ANCHOR THE COUNT TO THE CORE IT WAS TAKEN FROM. `core/**` is under
  // another agent while this gate is being written, and a count with no anchor
  // is a fact about a tree nobody can name afterwards — someone re-measuring
  // and getting a different number would have no way to tell a fix from a
  // different binary. `buildid` is the digest STALE and K3 already key on.
  const coreId = slice(['buildid']).stdout.trim() || 'UNKNOWN';
  const line = (r) =>
    `${r.planted ? 'PLANTED ' : ''}${r.cls.padEnd(17)} ${r.job.padEnd(11)} ${r.tool.padEnd(31)} ` +
    (r.cls === 'EMITS-vs-REFUSES'
      ? `tool_id EMITS ${r.sLines}L (sim uncut=${r.uncut}${r.first ? `, ${r.first}` : ''}) · tool_ids REFUSES: ${r.mWhy.replace(/\s+/g, ' ').slice(0, 150)}`
      : r.cls === 'REFUSES-vs-EMITS'
        ? `tool_id REFUSES: ${r.sWhy.replace(/\s+/g, ' ').slice(0, 120)} · tool_ids EMITS ${r.mLines}L`
        : `both emit, DIFFERENT BYTES: tool_id ${r.sLines}L vs tool_ids ${r.mLines}L`);

  if (broken.length === 0 && diverging.length === 0 && rows.length > 0) {
    pass(
      'DOOR',
      `${rows.length} (fixture x single tool) pair(s) — ${JOBS.length} fixture(s) x the whole ` +
        `${TOOLS.length}-tool library — and \`tool_id: X\` and \`tool_ids: [X]\` return the SAME ` +
        `verdict and byte-identical G-code on every one (${agreeBothEmit} both emit, ` +
        `${agreeBothRefuse} both refuse), core ${coreId}. ${corroborated} side(s) re-driven through \`job\`, which ` +
        `is what prints the program, and it agrees byte-for-byte and on the exit contract. ` +
        `WHAT THIS DOES NOT SAY: (1) which door any host uses — App.tsx sending \`tool_ids\` ` +
        `removes the browser's REACH to the singular door and would not have made this green; ` +
        `(2) that either door is RIGHT — agreement is not correctness, and both could agree on a ` +
        `program that gouges (that is P1-P9, TOOL, DOC, ENT); (3) anything about a set of two or ` +
        `more tools, which has no singular counterpart to compare`
    );
  } else if (broken.length) {
    fail(
      'DOOR',
      `THE INSTRUMENT, NOT THE PRODUCT — ${broken.length} fault(s) at core ${coreId}, so this run does not know what ` +
        `it measured (${diverging.length}/${rows.length} pair(s) diverged, which is NOT a trustworthy ` +
        `number while this list is non-empty):\n      ${broken.slice(0, 6).join('\n      ')}` +
        `${broken.length > 6 ? `\n      …+${broken.length - 6} more` : ''}`
    );
  } else {
    fail(
      'DOOR',
      `${diverging.length} of ${rows.length} (fixture x single tool) pair(s) DISAGREE at core ${coreId} ` +
        `— the same one cutter, the same fixture, two answers depending on which field named it. ` +
        `${byClass['EMITS-vs-REFUSES'] ?? 0} in the DANGEROUS direction (\`tool_id\` emits a program ` +
        `\`tool_ids\` refuses), ${byClass['REFUSES-vs-EMITS'] ?? 0} the other way, and ` +
        `${byClass['DIFFERENT-PROGRAM'] ?? 0} where both emit DIFFERENT BYTES. ` +
        `${agreeing.length} pair(s) agree (${agreeBothEmit} both emit, ${agreeBothRefuse} both refuse), ` +
        `so this comparator can and does report agreement — but read that split before taking comfort ` +
        `from it: ${agreeBothEmit === 0 ? 'EVERY agreement on this tree is two refusals. There is no ' +
        '(fixture x single tool) pair anywhere in the matrix on which both doors emit and produce the ' +
        'same program. Where the cutter cannot do the job both doors say so; wherever one CAN, they ' +
        'differ.' : `${agreeBothEmit} of them are two identical programs`} ` +
        `${corroborated} side(s) of the pairs below ` +
        `were re-driven through \`job\` — the host that prints the program — and it corroborates ` +
        `\`report\` byte-for-byte and on the exit contract. NO ALLOWANCE LIST, deliberately: a gate ` +
        `that permits some disagreement cannot tell the benign direction from the dangerous one. ` +
        `Fix is in \`core/**\` (\`apply_tool_set\` must route a single \`tool_id\` through ` +
        `\`assign_tools_from_set\`), not here.` +
        `${injected ? ` SELF-PLANTED: one extra pair below is this harness's, not the product's — ${injected}.` : ''}` +
        `\n      ${diverging.map(line).join('\n      ')}`
    );
  }
}

// --- FLAG: a flag accepted and discarded -----------------------------------
//
// 🔴 The failure this guards is not a bad cut — it is a control that cannot go
// red. `import <dxf> --plant <anything>` exited 0 having done nothing, so a
// negative control driven that way would have run CLEAN and read as a passing
// control; TOOL's own comment records that it had to be routed through `report`
// for exactly this reason, and REL's owed `--plant release-order` was blocked
// by it. `job <name> --config <file>` was the same defect on the host that
// prints the program an operator sends to the machine: no `JobConfig` was built
// at all, and every machine, workpiece, clamp and tool setting in the file was
// discarded in silence — including when the path did not exist.
//
// 🔴 EVERY limb here is a PAIR, and that is the whole design. "exit code is 2"
// alone passes when the binary is broken in some other way, or when a checker
// has been written to refuse everything — so each refusal is asserted BESIDE a
// valid invocation on the SAME path that must still succeed. A one-sided limb
// here would be the vacuous control this gate exists to prevent.
{
  const DXF = join(ROOT, 'gates/fixtures/plate.dxf');
  const cfg = (name, obj) => {
    const f = join(ROOT, 'target', `gatecfg-${name}.json`);
    writeFileSync(f, JSON.stringify(obj));
    return f;
  };
  // A tool must be named or the import path refuses for a different reason
  // (gate TOOL) and every limb below would go red for the wrong cause.
  const TOOLCFG = cfg('flag-tool', { tool_id: 'End Mill - Down-cut 6mm 2F' });
  // A machine that cannot hold the workpiece. If `--config` is READ this job is
  // refused; if it is discarded the program posts exactly as it did without it.
  const TINY = cfg('flag-tiny', { machine: { travel_x_mm: 10, travel_y_mm: 10 } });

  const ok = (r) => r.code === 0 && r.stdout.length > 0;
  const refusedTwo = (r) => r.code === 2 && r.stdout.length === 0;

  // --- limb 1: every path that ACCEPTS --plant refuses an unknown one ------
  // One unknown-plant contract across the whole binary, so a control written
  // against any of these paths means the same thing. Each is paired with the
  // same command minus the flag, which must still work.
  const plantPaths = [
    ['report', ['report', 'plate'], ['report', 'plate', '--plant', 'no-such-plant']],
    ['job', ['job', 'plate'], ['job', 'plate', '--plant', 'no-such-plant']],
    ['fixture', ['fixture', 'rect-profile'], ['fixture', 'rect-profile', '--plant', 'no-such-plant']],
    ['route', ['route', 'plate'], ['route', 'plate', '--plant', 'no-such-plant']],
    [
      'import',
      ['import', DXF, '--config', TOOLCFG],
      ['import', DXF, '--config', TOOLCFG, '--plant', 'no-such-plant'],
    ],
  ];
  const plantBad = [];
  for (const [name, good, bad] of plantPaths) {
    const g = slice(good);
    const b = slice(bad);
    if (!refusedTwo(b)) plantBad.push(`${name}: unknown plant exit=${b.code} stdout=${b.stdout.length}B`);
    // The pair. Without it, a binary that refused EVERYTHING would score green.
    if (!ok(g)) plantBad.push(`${name}: the same command WITHOUT --plant failed (exit=${g.code}) — this limb proves nothing`);
  }

  // --- limb 2: a KNOWN plant on `import` is refused, not swallowed ---------
  // `import` cannot apply a plant at all (the core's import path takes no plant
  // argument), so the honest answer is a refusal that says so. Silently
  // accepting it is what made a control vacuous.
  const knownPlant = slice(['import', DXF, '--config', TOOLCFG, '--plant', 'gouge']);
  const knownRefused = refusedTwo(knownPlant) && /known job plant/.test(knownPlant.stderr);
  // ...and `--plant none` is the value it CAN honour, so it must still plan.
  const plantNone = slice(['import', DXF, '--config', TOOLCFG, '--plant', 'none']);

  // --- limb 3: `job --config` BITES ---------------------------------------
  // Asserted on the EMITTED PROGRAM, not on the setting: the discarded-config
  // job posted 11,978 bytes and exited 0, so "a message was printed" is not the
  // property — "no program exists" is.
  const jobPlain = slice(['job', 'plate']);
  const jobTiny = slice(['job', 'plate', '--config', TINY]);
  const configBites = jobTiny.code === 1 && jobTiny.stdout.length === 0 && ok(jobPlain);
  // A `--config` that cannot be opened or parsed is exit 2, never a shrug.
  const jobMissing = slice(['job', 'plate', '--config', join(ROOT, 'target', 'no-such-config.json')]);
  const jobBadJson = slice(['job', 'plate', '--config', DXF]);
  const configStrict = refusedTwo(jobMissing) && refusedTwo(jobBadJson);

  // --- limb 3b: the config REACHES THE CUTTING MOVES, not just the verdict --
  //
  // 🔴 Limb 3 above only proves a config can make the job REFUSE. A `run_job`
  // that parsed `--config`, checked the travel, refused an unreadable file and
  // then posted a program built from DEFAULTS would score limb 3 green while
  // discarding every machine, workpiece, tool and op setting in the file — which is
  // the original defect wearing the fix's clothes. What is asserted here is the
  // EMITTED G-CODE: a config that changes a cutting parameter must change the
  // motion, and a config that removes a controller capability must remove those
  // words from the program.
  //
  // Both limbs are PAIRED against the same job with no config, so a binary that
  // emitted a fixed program, an empty program, or an arc-free one regardless
  // cannot score them green.
  const cutMoves = (s) => (s.match(/^G0?1 /gm) || []).length;
  const arcMoves = (s) => (s.match(/^G0?[23] /gm) || []).length;
  // Depth per pass FINER than the fixture's own — the same part cut in more
  // passes. Measured on the program: 300 cutting moves becomes 804.
  const FINE = cfg('flag-fine-dpp', { op: { depth_per_pass_mm: 1.0 } });
  const jobFine = slice(['job', 'plate', '--config', FINE]);
  const depthReachesTheProgram =
    ok(jobFine) && ok(jobPlain) && cutMoves(jobFine.stdout) > cutMoves(jobPlain.stdout);
  // A controller that cannot interpolate arcs. Measured on the program: 108
  // G2/G3 words become 0, and the moves come back as lines rather than as
  // nothing — an empty program would satisfy "no arcs" and cut no part.
  const NOARCS = cfg('flag-no-arcs', { machine: { supports_arcs: false } });
  const jobNoArcs = slice(['job', 'plate', '--config', NOARCS]);
  const arcsReachTheProgram =
    ok(jobNoArcs) &&
    arcMoves(jobPlain.stdout) > 0 &&
    arcMoves(jobNoArcs.stdout) === 0 &&
    cutMoves(jobNoArcs.stdout) >= cutMoves(jobPlain.stdout);
  // ...and the flag SPELLING of the same idea is refused rather than ignored:
  // `job` does not read `--no-arcs` (`fixture` does), and the report that
  // opened this gate measured it silently discarded while the program still
  // carried 108 arcs.
  const jobNoArcsFlag = slice(['job', 'plate', '--no-arcs']);
  const noArcsFlagRefused = refusedTwo(jobNoArcsFlag) && /--no-arcs/.test(jobNoArcsFlag.stderr);

  // --- limb 4: an unread flag is refused, on every subcommand --------------
  // Paired the same way: the valid form of each call must still succeed, so a
  // checker that refused every invocation cannot score this green.
  const unread = [
    ['job', ['job', 'plate'], ['job', 'plate', '--no-such-flag']],
    ['report', ['report', 'plate'], ['report', 'plate', '--json']],
    ['fixture', ['fixture', 'rect-profile'], ['fixture', 'rect-profile', '--sim-cell', '0.2']],
    ['fit', ['fit', DXF], ['fit', DXF, '--plant', 'gouge']],
    ['route', ['route', 'plate'], ['route', 'plate', '--tool', 'End Mill - Down-cut 6mm 2F']],
  ];
  const unreadBad = [];
  for (const [name, good, bad] of unread) {
    const g = slice(good);
    const b = slice(bad);
    if (!refusedTwo(b)) unreadBad.push(`${name}: unread flag exit=${b.code} stdout=${b.stdout.length}B`);
    if (!ok(g)) unreadBad.push(`${name}: the valid form failed (exit=${g.code}) — this limb proves nothing`);
  }
  // ...and the flags each subcommand DOES read still arrive. This is the limb
  // that fails if someone "fixes" the checker by refusing everything.
  //
  // 🔴 `fixture --no-arcs` was driven on `rect-profile` until 2026-08-09, and
  // THAT FIXTURE EMITS NO ARCS EITHER WAY (0 with the flag, 0 without). The
  // limb asserted exit 0 and nothing else, so `--no-arcs` could have stopped
  // being read on the fixture path — the exact defect this gate is named for —
  // with FLAG still green. It is driven on `rect-arcs` now and asserted on the
  // EMITTED PROGRAM: 24 arcs become 0, and the moves come back as lines
  // (36 -> 60) rather than the part quietly not being cut.
  const fixArcs = slice(['fixture', 'rect-arcs']);
  const fixNoArcs = slice(['fixture', 'rect-arcs', '--no-arcs', '--spoilboard-zero']);
  const stillReads =
    // The plant that gate G4 drives still BITES — exit 1, the spoilboard
    // refusal — rather than being caught by the new flag checker.
    slice(['fixture', 'rect-profile', '--plant', 'deep']).code === 1 &&
    ok(fixArcs) &&
    ok(fixNoArcs) &&
    arcMoves(fixArcs.stdout) > 0 &&
    arcMoves(fixNoArcs.stdout) === 0 &&
    cutMoves(fixNoArcs.stdout) > cutMoves(fixArcs.stdout) &&
    ok(slice(['job', 'plate', '--sim-cell', '0.5', '--no-probe'])) &&
    ok(slice(['import', DXF, '--config', TOOLCFG, '--json'])) &&
    ok(slice(['report', 'plate', '--config', TOOLCFG]));

  // --- limb 5: THE HARNESS holds itself to the contract it enforces --------
  //
  // 🔴 Found 2026-08-11, by accident, by an operator typing
  // `node gates/slicer_gate_check.mjs --help`. It was not refused. It ran a FULL
  // pass, rebuilt the release binary and regenerated `web/src/wasm` — a
  // COMMITTED artefact — and was killed part-way through. Every limb above holds
  // the CLI to "exit 2, empty stdout, on every path"; this file, which is where
  // that rule is enforced from, was held to nothing. A harness that keeps a
  // lower standard than the thing it gates is the one place nobody audits.
  //
  // ⚠ WHY IT IS A LIMB OF **FLAG** AND NOT A GATE OF ITS OWN. The contract is
  // the same sentence, the failure is the same sentence, and the guarded harm is
  // the same sentence one level up — an operator, a script or a GATE believing a
  // flag took effect. Gate FLAG's own row already names all three believers. A
  // separate gate id would let the harness's contract drift away from the
  // product's, which is precisely the pair of things that must never disagree
  // here. (Gate-on-harness itself is well precedented in this file: VERD scores
  // the verdict rule, PLANT scores plant registration, GDOC scores the document.)
  //
  // 🔴 ORDERING IS ASSERTED, NOT JUST THE EXIT CODE. Exit 2 after the wasm
  // rebuild is not a fix — the damage IS the rebuild. Two independent witnesses:
  //   - STDOUT MUST BE EMPTY. The first bytes this program prints are the
  //     banner, three lines above `cargo build --release`. Empty stdout means
  //     execution never reached the banner, so it cannot have reached the build.
  //   - THE ARTEFACTS A FULL PASS MOVES must be identical across the refused
  //     call: the release binary and both `web/src/wasm` files, by mtime + size.
  //
  // PAIRED like every other limb in this gate: `--list`, `--quick --list` and
  // `--self-plant <known> --list` must all still be ACCEPTED. A checker "fixed"
  // by refusing everything would take this whole lane down while scoring green,
  // and `--quick` is what every session in this tree actually runs.
  //
  // TWO SAFETY MEASURES ON THE PROBE, because the failure under test is "it runs
  // the suite":
  //   - `--quick` rides along with the bogus flag, so a REGRESSED guard cannot
  //     reach the wasm rebuild while this limb is busy proving that it would;
  //   - the child gets `SLICER_GATE_NO_SELF_SPAWN=1` and this limb skips itself
  //     when that variable is set, capping recursion at one level. Without it a
  //     broken guard would have every generation spawn the next, forever.
  const HARNESS = fileURLToPath(import.meta.url);
  const WATCHED = [
    join(ROOT, 'target/release/2bee-slice'),
    join(ROOT, 'web/src/wasm/twobee_cam_wasm_bg.wasm'),
    join(ROOT, 'web/src/wasm/twobee_cam_wasm.js'),
  ];
  const stampOf = () =>
    WATCHED.map((p) => {
      if (!existsSync(p)) return `${p}=absent`;
      const s = statSync(p);
      return `${p}=${s.mtimeMs}/${s.size}`;
    }).join(' ');
  const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, ms));
  // ⚠ `spawnSync` returns `status`, not `code` — normalised here to the same
  // shape `slice()` returns, because `refusedTwo` reads `.code` and an
  // `undefined` exit code compares unequal to 2 in BOTH directions. Written
  // without this the first time: every arm reported `exit=undefined`, the
  // refusal arms read as accepted and the acceptance arms read as refused, so
  // the limb failed loudly in both directions at once rather than passing
  // quietly. A harness bug that produces a FALSE RED is the cheap kind.
  const runner = (script, args) => {
    const r = spawnSync(process.execPath, [script, ...args], {
      encoding: 'utf8',
      cwd: ROOT,
      timeout: 15_000,
      env: { ...process.env, SLICER_GATE_NO_SELF_SPAWN: '1' },
    });
    return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  // `--self-plant flag-harness-unguarded`: the pre-fix runner, reconstructed by
  // deletion rather than described. Returns null if the strip matched nothing,
  // which is itself reported — a plant that plants nothing is worse than none.
  //
  // ⚠ THE DIRECTORY IS REMOVED AFTER THE LAST ARM THAT DRIVES IT (see
  // `plantedDir` below) AND AGAIN IN A `finally` (2026-08-12). Harmless per run
  // and unbounded over many: this plant is driven every time anybody re-arms
  // FLAG, and `os.tmpdir()` is not swept on every box. Left behind it is also a
  // COPY OF THIS RUNNER WITH ITS ARGUMENT GUARD REMOVED sitting in a
  // world-readable directory — small, but it is a deliberately-defective build
  // product and nothing was going to delete it. The eager removal alone did not
  // survive a throw between the copy and it, which is the residual the agent
  // that wrote this plant named in its own work rather than leaving silent.
  let plantedDir = null;
  let plantCleanup = '';
  const unguardedCopy = () => {
    const src = readFileSync(HARNESS, 'utf8');
    const cut = src.replace(
      /^checkRunnerFlags\(process\.argv\.slice\(2\)\);$/m,
      '/* guard removed by --self-plant flag-harness-unguarded */'
    );
    if (cut === src) return null;
    plantedDir = mkdtempSync(join(tmpdir(), 'slicer-flag-plant-'));
    const f = join(plantedDir, 'unguarded_gate.mjs');
    writeFileSync(f, cut);
    return f;
  };

  const harnessProblems = [];
  let harnessNote = '';
  if (process.env.SLICER_GATE_NO_SELF_SPAWN === '1') {
    harnessNote =
      'the harness limb did NOT run: this process is itself a child probe (SLICER_GATE_NO_SELF_SPAWN=1) and skips it to cap recursion';
  } else {
    try {
      const wantPlant = selfPlanted('flag-harness-unguarded');
      const plantedProbe = wantPlant ? unguardedCopy() : null;
      if (wantPlant && !plantedProbe) {
        harnessProblems.push(
          '`--self-plant flag-harness-unguarded` did not match the `checkRunnerFlags(process.argv.slice(2));` call in this file — the control PLANTED NOTHING, which is the vacuous control this gate is named for'
        );
      }
      const target = plantedProbe ?? HARNESS;

      // The mutation-watched probe. No `--list`, so a regressed guard would go on
      // to do real work — bounded by `--quick`, the env guard and the timeout.
      const before = stampOf();
      const t0 = Date.now();
      const bogus = runner(target, ['--quick', '--no-such-flag']);
      const dt = Date.now() - t0;
      const after = stampOf();

      // ⚠ OTHER LANES ARE LIVE IN `web/`. Before calling a moved artefact a
      // mutation BY THIS REFUSAL, take an idle control window of the same length:
      // an artefact that also moves while this gate runs NOTHING is another lane's
      // and is not evidence about the refusal. When that happens the assertion is
      // reported as NOT TAKEN rather than passed — a check that could not run must
      // say so, never bank a green.
      let mutation = 'none';
      if (before !== after) {
        const c0 = stampOf();
        nap(Math.max(dt, 50));
        mutation = c0 === stampOf() ? 'refusal' : 'contended';
      }

      if (!refusedTwo(bogus)) {
        harnessProblems.push(
          `THE HARNESS ITSELF accepted an unknown flag: \`slicer_gate_check.mjs --quick --no-such-flag\` exit=${bogus.code} stdout=${bogus.stdout.length}B` +
            (bogus.stdout.length
              ? ' — a non-empty stdout means it printed the banner, and the banner sits three lines above `cargo build --release`'
              : '') +
            ' — this gate requires exit 2 with empty stdout of every path in the CLI'
        );
      }
      if (mutation === 'refusal') {
        harnessProblems.push(
          `a REFUSED run moved a build artefact — before[${before}] after[${after}]. Exit 2 after the rebuild is not a refusal: the damage IS the rebuild, and web/src/wasm is committed`
        );
      }

      // The refusal arms an operator actually reaches. All carry `--list`, so even
      // a totally absent guard prints a table and mutates nothing — the arm is
      // cheap AND cannot become the thing it is testing for.
      for (const [label, args] of [
        ['--help, the invocation that found this', ['--help', '--list']],
        ['--quik, a one-letter typo of the flag this session runs', ['--quik', '--list']],
        ['--only, which does not exist and looked like it scoped the run', ['--only', 'G0', '--list']],
        ['--self-plant=<name>, the = form nothing here scans for', ['--self-plant=doc-roster', '--list']],
        ['a bare positional', ['nonsense', '--list']],
        ['--self-plant with no value', ['--self-plant']],
      ]) {
        const r = runner(target, args);
        if (!refusedTwo(r)) harnessProblems.push(`the harness accepted ${label}: exit=${r.code} stdout=${r.stdout.length}B`);
      }

      // The last arm that drives `target` has run, so the planted copy goes now
      // rather than at process exit: an unhandled throw below would skip an
      // `process.on('exit')` hook, and this gate's whole subject is a step that
      // silently does not happen.
      if (plantedDir) {
        rmSync(plantedDir, { recursive: true, force: true });
        plantCleanup = `; the planted unguarded copy and its directory were REMOVED (${plantedDir})`;
        plantedDir = null;
      }

      // THE PAIR. Driven at the REAL runner in every case — these are not what the
      // plant removes, and a plant that reddened them would be proving the wrong
      // thing. `--self-plant <known> --list` is also the arity arm: if the value
      // were not consumed it would be refused as a stray positional.
      for (const [label, args] of [
        ['--list', ['--list']],
        ['--quick --list (what this session runs)', ['--quick', '--list']],
        ['--self-plant doc-roster --list', ['--self-plant', 'doc-roster', '--list']],
      ]) {
        const r = runner(HARNESS, args);
        if (r.code !== 0 || !/\d+ gates\./.test(r.stdout)) {
          harnessProblems.push(
            `the harness REFUSED an argument list it MUST accept: ${label} exit=${r.code} stdout=${r.stdout.length}B — a checker that refuses everything takes this lane down while scoring green`
          );
        }
      }
      // ...and an unknown --self-plant NAME still exits 2 with no output. That
      // refusal predates this limb and is the one the flag checker must not have
      // shadowed by accepting the name as a value and stopping there.
      const badName = runner(HARNESS, ['--self-plant', 'no-such-plant', '--list']);
      if (!refusedTwo(badName)) {
        harnessProblems.push(`an unknown --self-plant NAME was not refused: exit=${badName.code} stdout=${badName.stdout.length}B`);
      }
      harnessNote =
        (mutation === 'contended'
          ? 'NOT TAKEN this run: a watched artefact moved during an IDLE control window too, so another lane is writing web/src/wasm and no conclusion about the refusal is available'
          : `${WATCHED.length} watched artefact(s) byte-and-mtime identical across the refused run`) + plantCleanup;
    } finally {
      // 🔴 BELT ON THE BRACES, AND THE BRACES ARE THE POINT. The eager removal
      // above runs after the last arm that DRIVES the copy, and it is the one
      // that produces `plantCleanup` for the pass message — so it stays where it
      // is. What it could not do is survive a throw: anything above it (a
      // `spawnSync` that raises, a `statSync` on a path another lane deleted
      // mid-run) left a COPY OF THIS RUNNER WITH ITS ARGUMENT GUARD REMOVED in
      // a world-readable tmpdir, and `os.tmpdir()` is not swept on every box.
      // The residual was named by the agent that wrote the plant rather than
      // left silent; this is the close. `plantedDir` is nulled by the eager
      // path, so on every run that completes this branch does nothing.
      if (plantedDir) {
        rmSync(plantedDir, { recursive: true, force: true });
        plantedDir = null;
      }
    }
  }

  const problems = [
    ...plantBad,
    ...unreadBad,
    ...harnessProblems,
    knownRefused ? null : `import --plant gouge exit=${knownPlant.code} stdout=${knownPlant.stdout.length}B — a known plant must be refused with the reason, not swallowed`,
    ok(plantNone) ? null : `import --plant none exit=${plantNone.code} — the one value it CAN honour must still plan`,
    configBites ? null : `job --config discarded: plain=${jobPlain.stdout.length}B tiny=${jobTiny.stdout.length}B(exit=${jobTiny.code}) — a config that cannot hold the workpiece must leave NO program`,
    configStrict ? null : `job --config missing=${jobMissing.code} badjson=${jobBadJson.code} — an unreadable config is exit 2, not a shrug`,
    depthReachesTheProgram
      ? null
      : `job --config op.depth_per_pass_mm never reached the cutting moves: plain=${cutMoves(jobPlain.stdout)} G1 vs fine=${cutMoves(jobFine.stdout)} G1 (exit=${jobFine.code}) — a config read and then posted from defaults is the discarded config with a parser in front of it`,
    arcsReachTheProgram
      ? null
      : `job --config machine.supports_arcs=false never reached the program: plain=${arcMoves(jobPlain.stdout)} arcs/${cutMoves(jobPlain.stdout)} G1 vs no-arcs=${arcMoves(jobNoArcs.stdout)} arcs/${cutMoves(jobNoArcs.stdout)} G1 (exit=${jobNoArcs.code}) — the arcs must become LINES, not vanish with the part`,
    noArcsFlagRefused
      ? null
      : `job --no-arcs exit=${jobNoArcsFlag.code} stdout=${jobNoArcsFlag.stdout.length}B — job does not read --no-arcs, so it must be refused BY NAME rather than accepted while the program keeps its arcs`,
    stillReads
      ? null
      : `a flag each subcommand DOES read stopped arriving — the checker is refusing more than it should, or fixture --no-arcs stopped reaching the program (rect-arcs: ${arcMoves(fixArcs.stdout)} arcs/${cutMoves(fixArcs.stdout)} G1 plain vs ${arcMoves(fixNoArcs.stdout)} arcs/${cutMoves(fixNoArcs.stdout)} G1 with the flag)`,
  ].filter(Boolean);

  if (problems.length === 0) {
    pass(
      'FLAG',
      `an unknown plant exits 2 with empty stdout on all ${plantPaths.length} paths that accept ` +
        `--plant (report, job, fixture, route, import) and the same call without it still runs; ` +
        `a KNOWN plant on import is refused with the reason rather than swallowed, --plant none ` +
        `still plans; job --config is APPLIED (plain ${jobPlain.stdout.length}B, ` +
        `travel 10x10mm leaves ${jobTiny.stdout.length}B and exit ${jobTiny.code}) and an ` +
        `unreadable one exits 2; it reaches the EMITTED PROGRAM — a finer ` +
        `op.depth_per_pass_mm takes the cutting moves ${cutMoves(jobPlain.stdout)}->` +
        `${cutMoves(jobFine.stdout)} G1, and machine.supports_arcs=false takes ` +
        `${arcMoves(jobPlain.stdout)} arcs to ${arcMoves(jobNoArcs.stdout)} with the moves ` +
        `returning as ${cutMoves(jobNoArcs.stdout)} lines rather than disappearing, while ` +
        `job --no-arcs (a flag job does not read) is refused by name; ` +
        `a flag a subcommand does not read is refused on all ` +
        `${unread.length} sampled paths while every flag it does read still arrives — ` +
        `fixture --no-arcs on rect-arcs asserted on the program too ` +
        `(${arcMoves(fixArcs.stdout)} arcs -> ${arcMoves(fixNoArcs.stdout)}, ` +
        `${cutMoves(fixArcs.stdout)} -> ${cutMoves(fixNoArcs.stdout)} lines); ` +
        `and THE HARNESS ITSELF keeps this contract — --help, --quik, --only, ` +
        `--self-plant=<name> and a bare positional each exit 2 with EMPTY stdout, which is the ` +
        `witness that the refusal happened above the banner and therefore above cargo build, ` +
        `while --list, --quick --list and --self-plant <known> --list are all still accepted ` +
        `(${harnessNote})`
    );
  } else {
    fail('FLAG', problems.join(' | '));
  }
}

// --- F1: geometry intake ---------------------------------------------------
{
  // 🔴 F1 NAMES ITS CUTTER, and did not until 2026-08-09. It imported with no
  // `--config` at all, so every program it compared was planned with the Ø6mm
  // end mill the core silently substituted for a missing `tool_id`. F1 was not
  // testing that substitution — it was unknowingly RELYING on it, which is
  // exactly why the gate suite could never have caught it. Naming the tool is
  // the fix; exempting the import path from the refusal would have re-opened
  // the hole in the one place that looks at it. The id resolves to the same
  // cutter the old fallback returned, so nothing F1 asserts has moved.
  const F1CFG = join(ROOT, 'target', 'gatecfg-f1.json');
  writeFileSync(F1CFG, JSON.stringify({ tool_id: 'End Mill - Down-cut 6mm 2F' }));
  const imp = (f) => {
    const r = slice(['import', join(ROOT, 'gates/fixtures', f), '--config', F1CFG, '--json']);
    let j = null;
    try {
      j = JSON.parse(r.stdout);
    } catch {
      /* left null — reported below */
    }
    return { ...r, j };
  };

  const dxf = imp('plate.dxf');
  const svg = imp('plate.svg');
  const planted = imp('spline.dxf');

  // 🔴 THE SVG CASE THIS GATE NEVER HAD (2026-08-29). `gates/fixtures/plate.svg`
  // uses `<rect>`, `<circle>` and `<svg>` and carries NO `transform` — so on the
  // only SVG F1 has ever read, a reader that applies transforms and one that
  // silently ignores them give the same answer. `transform=` is parsed nowhere
  // in `import.rs`, and an SVG carrying `<g transform="translate(…)">` — what
  // every drawing tool emits for a moved group — imported every child at its
  // UNTRANSFORMED coordinates: real contours, in the wrong place, that post and
  // simulate and gate green.
  //
  // Written here rather than committed as a fixture, on the same reasoning REL's
  // hostile-filename drawing gives: the gate carries its own evidence, and a new
  // file under `gates/fixtures/` is a new thing to keep in step.
  const XFORM_SVG = join(ROOT, 'target', 'gate-f1-transform.svg');
  writeFileSync(
    XFORM_SVG,
    '<svg width="200" height="100">' +
      '<g transform="translate(50,20)">' +
      '<rect x="10" y="10" width="40" height="30"/>' +
      '</g></svg>'
  );
  const xform = (() => {
    const r = slice(['import', XFORM_SVG, '--config', F1CFG, '--json']);
    try {
      return JSON.parse(r.stdout);
    } catch {
      return null;
    }
  })();
  const xformRefused = (xform?.notes ?? []).some(
    (n) => n.includes('transform') && n.includes('NOT imported')
  );
  const xformEmitted = (xform?.gcode ?? '').length;

  // 🔴 THE SAME SVG UNDER TWO WORKPIECE HEIGHTS (2026-08-29). `parse_svg` flipped
  // Y about `stock.size_y_mm` — a number that has nothing to do with the drawing
  // — so CHANGING THE WORKPIECE MOVED THE PART. Measured on plate.svg
  // (`height="900"`) before the fix: stock 900 gave Y in [47.0, 173.0] and stock
  // 950 gave Y in [97.0, 223.0], `ok: true`, no note, 50mm out.
  //
  // ⚠ And this gate could not see it for the reason it could not see the
  // transform: plate.svg declares 900 and the reference workpiece IS 900, so the
  // wrong number and the right one were the same number.
  const svgAt = (sizeY) => {
    const cfg = join(ROOT, 'target', `gatecfg-f1-y${sizeY}.json`);
    writeFileSync(
      cfg,
      JSON.stringify({
        tool_id: 'End Mill - Down-cut 6mm 2F',
        machine: { travel_x_mm: 1200, travel_y_mm: 1200 },
        stock: { size_x_mm: 600, size_y_mm: sizeY, thickness_mm: 18 },
      })
    );
    const r = slice(['import', join(ROOT, 'gates/fixtures', 'plate.svg'), '--config', cfg, '--json']);
    try {
      return JSON.parse(r.stdout)?.gcode ?? '';
    } catch {
      return '';
    }
  };
  const svgY900 = svgAt(900);
  const svgY950 = svgAt(950);
  // Byte equality is the assertion: the drawing decides where the part is, so a
  // taller sheet must change NOTHING about the program.
  const svgSheetInvariant = svgY900.length > 0 && svgY900 === svgY950;

  const holes = (j) => {
    const m = /with (\d+) interior feature/.exec((j?.notes ?? []).join(' '));
    return m ? Number(m[1]) : -1;
  };

  const dxfHoles = holes(dxf.j);
  const svgHoles = holes(svg.j);
  const plantedHoles = holes(planted.j);
  const namesSpline = (planted.j?.notes ?? []).some((n) => n.includes('SPLINE'));
  const cleanIsSilent = !(dxf.j?.notes ?? []).some((n) => n.includes('NOT imported'));
  // 🔴 A drawing with no declared units must SAY that millimetres were assumed.
  // Silence there is how an inch drawing imports 25.4x small with a perfect
  // outline and only a ruler disagreeing.
  const unitsStated = (dxf.j?.notes ?? []).some((n) => n.includes('ASSUMED') || n.includes('INSUNITS'));
  // The same plate drawn two ways must import to the same program. This is the
  // cheapest check that the SVG Y-flip is right: without it the part is
  // mirrored, which is invisible on a symmetric outline and wrong on any other.
  const agree = dxf.j?.gcode && svg.j?.gcode && dxf.j.gcode === svg.j.gcode;

  if (
    dxfHoles === 4 && svgHoles === 4 && agree && namesSpline && plantedHoles === 0 &&
    cleanIsSilent && unitsStated && xformRefused && xformEmitted === 0 && svgSheetInvariant
  ) {
    pass(
      'F1',
      'DXF and SVG import to identical G-code with 4 holes; a SPLINE is named, not dropped; ' +
        'an SVG carrying a `transform` is REFUSED by name and emits 0 bytes rather than importing ' +
        'its geometry at the untransformed coordinates; and the SAME SVG on a 900mm and a 950mm ' +
        'workpiece emits BYTE-IDENTICAL G-code — the drawing decides where the part is, not the sheet'
    );
  } else {
    fail(
      'F1',
      `dxfHoles=${dxfHoles} svgHoles=${svgHoles} identical=${!!agree} ` +
        `splineNamed=${namesSpline} plantedHoles=${plantedHoles} cleanSilent=${cleanIsSilent} ` +
        `unitsStated=${unitsStated} svgTransformRefused=${xformRefused} ` +
        `svgTransformBytesEmitted=${xformEmitted} (a transform this reader cannot apply must ` +
        `refuse the drawing, not import its geometry at the untransformed coordinates) ` +
        `svgSheetInvariant=${svgSheetInvariant} (${svgY900.length}B at stock 900 vs ` +
        `${svgY950.length}B at stock 950 — if these differ, the Y flip is reading the WORKPIECE ` +
        `height instead of the DRAWING's, so changing the sheet moves the part)`
    );
  }
}

// --- SPEC: every citation in FUNCTIONAL-SPEC.md resolves to something real --
//
// 🔴 THE DEFECT THIS EXISTS FOR, measured 2026-08-08. The Gate column of
// `FUNCTIONAL-SPEC.md` cited **33 gate ids that exist nowhere in this repo**
// (`G-OFF`, `G-DEP`, `G-ENT`, `E2E-U1`…). 35 rows read ✅ "done and gated" while
// a reader following the named gate found nothing — in EVERY case, including the
// 13 rows that were genuinely well covered. A dangling label is worse than a
// blank: it is a green nobody can back, and it survived four audits because the
// ids LOOKED like gate ids.
//
// So the spec is now parsed, not trusted. Each Gate cell carries backticked
// tokens separated by ` · `, and each must resolve to one of:
//
//   `G3`, `P7`, `TECH`, …   a gate id in the GATES table above
//   `core:some_fn`          a `fn some_fn(` under core/src/**.rs  (run by G0)
//   `e2e:"a test title"`    a `test('a test title'` in web/e2e/*.ts (run by I1)
//   `none`                  NOTHING covers this row
//
// ⚠ `none` is accepted DELIBERATELY and is not a loophole. A row with no check
// that says so is honest; the thing being prevented is a row that claims one it
// does not have. What stops `none` becoming the easy way out is that this gate
// COUNTS them and prints the count in its own PASS message — a number allowed to
// grow silently is just the next version of this defect. If that number goes up,
// the run says so where everyone reads it.
//
// NEGATIVE CONTROL: add a row citing a gate that does not exist — `G-NONSENSE`
// is the one this was watched failing on — and SPEC must go red and the VERDICT
// line must read NO-GO. There is no `--plant` for this one because the plant is
// an edit to the document under test, which is exactly the defect.
{
  const specPath = join(ROOT, 'FUNCTIONAL-SPEC.md');

  /**
   * Every `fn name(` under core/src, and WHETHER IT IS A `#[test]`.
   *
   * 🔴 The distinction is the whole point, added 2026-08-09. Until now this
   * index was a bare set of names, so `core:plan_job` — a production function
   * that asserts nothing — resolved exactly as well as a test. That is the
   * 33-dangling-id defect one level in: the citation points at something real,
   * a reader greps it, finds code, and reads the ✅ as backed. **A function is
   * not an assertion.** Only a `#[test]` can go red.
   *
   * `rustTests` holds the ones annotated `#[test]` (the attribute may sit a
   * couple of lines up, above `#[should_panic]` or a doc line); `rustFns` still
   * holds every name so the two failures can be reported differently — "no such
   * fn" and "that fn is not a test" send a reader to different fixes.
   */
  const rustFns = new Set();
  const rustTests = new Set();
  const walkRs = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walkRs(p);
      else if (e.name.endsWith('.rs')) {
        const lines = readFileSync(p, 'utf8').split('\n');
        for (let i = 0; i < lines.length; i++) {
          const m = /\bfn\s+([A-Za-z_]\w*)\s*(?:<[^>]*>)?\s*\(/.exec(lines[i]);
          if (!m) continue;
          rustFns.add(m[1]);
          for (let k = 1; k <= 3 && i - k >= 0; k++) {
            if (/#\[\s*test\s*\]/.test(lines[i - k])) {
              rustTests.add(m[1]);
              break;
            }
          }
        }
      }
    }
  };

  /** Every Playwright test title — these are what an `e2e:` citation names. */
  const e2eTitles = new Set();
  const readE2e = (dir) => {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.ts')) continue;
      for (const m of readFileSync(join(dir, f), 'utf8').matchAll(/\btest\(\s*'((?:[^'\\]|\\.)*)'/g)) {
        e2eTitles.add(m[1].replace(/\\'/g, "'"));
      }
    }
  };

  /**
   * Rows of every markdown table in the spec THAT HAS A `Gate` COLUMN.
   *
   * Tables without one (the K testing table, the citation-grammar key) are
   * skipped by column name rather than by position — a gate that assumed
   * "column 4" would start reading Status cells the moment a column was added.
   */
  const specRows = (md) => {
    const lines = md.split('\n');
    const isRow = (s) => s.trim().startsWith('|');
    const isSep = (s) => /^\|[\s:|-]*-[\s:|-]*\|$/.test(s.trim());
    const cellsOf = (s) => s.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    const rows = [];
    let gateCol = null; // null = not inside a table; -1 = table has no Gate column
    let header = [];
    for (let i = 0; i < lines.length; i++) {
      if (!isRow(lines[i])) {
        gateCol = null;
        continue;
      }
      if (isSep(lines[i])) continue;
      if (gateCol === null) {
        // A header row is one immediately followed by the |---|---| separator.
        header = isSep(lines[i + 1] ?? '') ? cellsOf(lines[i]) : [];
        gateCol = header.length ? header.indexOf('Gate') : -1;
        continue;
      }
      if (gateCol < 0) continue;
      const cells = cellsOf(lines[i]);
      // The Status cell too — `none` and ✅ in the same row is a row claiming to
      // be done and admitting nothing checks it, which is a false green written
      // out longhand. Found by name so a column reorder cannot silently repoint
      // it, and empty when the table has no Status column.
      const statusCol = header.indexOf('Status');
      rows.push({
        line: i + 1,
        id: cells[0] || '?',
        cell: cells[gateCol] ?? '',
        status: statusCol >= 0 ? cells[statusCol] ?? '' : '',
      });
    }
    return rows;
  };

  const problems = [];
  let rows = [];
  let citations = 0;
  let uncovered = 0;

  if (!existsSync(specPath)) {
    problems.push('FUNCTIONAL-SPEC.md is missing — the document this gate reads does not exist');
  } else {
    walkRs(join(ROOT, 'core/src'));
    readE2e(join(ROOT, 'web/e2e'));
    // A harness with an empty index would pass every `core:`/`e2e:` citation for
    // the wrong reason. Absence of needles is a broken gate, not a clean run.
    if (rustFns.size === 0) problems.push('found no `fn` in core/src — the index is empty, not clean');
    if (e2eTitles.size === 0) problems.push('found no test titles in web/e2e — the index is empty, not clean');

    const gateIds = new Set(GATES.map((g) => g[0]));
    rows = specRows(readFileSync(specPath, 'utf8'));
    if (rows.length === 0) problems.push('no spec row with a Gate column was parsed — the parser matched nothing');

    for (const r of rows) {
      const toks = [...r.cell.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim());
      if (toks.length === 0) {
        problems.push(`${r.id} (line ${r.line}): Gate cell cites nothing — use \`none\` and say so in Status`);
        continue;
      }
      for (const t of toks) {
        citations++;
        if (t === 'none') {
          uncovered++;
          // `none` is honest; `none` next to a ✅ is not. The row would be
          // saying "done and covered" and "nothing covers this" in one line,
          // and a reader scanning the Status column sees only the tick.
          if (/✅/.test(r.status)) {
            problems.push(
              `${r.id} (line ${r.line}): Status is ✅ while the Gate cell cites \`none\` — a row cannot be covered by nothing`
            );
          }
        } else if (/^core:/.test(t)) {
          const fn = t.slice(5);
          if (!rustFns.has(fn)) problems.push(`${r.id} (line ${r.line}): no \`fn ${fn}\` in core/src`);
          else if (!rustTests.has(fn))
            problems.push(
              `${r.id} (line ${r.line}): \`fn ${fn}\` exists but is NOT a #[test] — a production function cannot go red`
            );
        } else if (/^e2e:/.test(t)) {
          const m = /^e2e:"(.*)"$/.exec(t);
          if (!m) problems.push(`${r.id} (line ${r.line}): malformed e2e citation ${JSON.stringify(t)} — expected e2e:"exact test title"`);
          else if (!e2eTitles.has(m[1])) problems.push(`${r.id} (line ${r.line}): no Playwright test titled ${JSON.stringify(m[1])}`);
        } else if (!gateIds.has(t)) {
          problems.push(`${r.id} (line ${r.line}): \`${t}\` is not a gate id, not core:<fn>, not e2e:"<title>", not none`);
        }
      }
    }
  }

  if (problems.length === 0) {
    pass(
      'SPEC',
      `${rows.length} rows, ${citations} citations all resolve; ` +
        `${uncovered} row(s) cite \`none\` — UNCOVERED and saying so`
    );
  } else {
    fail('SPEC', `${problems.length} dangling citation(s): ${problems.slice(0, 6).join(' | ')}${problems.length > 6 ? ` | …+${problems.length - 6} more` : ''}`);
  }
}

// --- CAD1 / CAD1H: our OpenSCAD subset means what OpenSCAD means ------------
//
// PHYSICAL FAILURE GUARDED: a `.scad` source that the `2bee.cad` tab evaluates
// into a DIFFERENT PART from the one the author wrote and OpenSCAD renders. It
// is the quietest defect this lane can ship, because nothing downstream can
// notice: every contour handed to CAM is a real contour of a real solid, so the
// wrong part posts cleanly, simulates cleanly, passes every gate above this one
// and gets cut. `corpus/edge_modifier_root` is that failure today, in its
// strongest form — OpenSCAD renders the cube, we render the sphere.
//
// The measurement is `tools/scad_oracle/` (READ AND RUN, NEVER EDITED from
// here): the real `openscad` binary and our own `web/src/cad/*.ts` over the same
// source, compared as an evaluated CSG tree and as a solid. Both legs, because
// they catch different things — `partial_rotate_axis_angle` matches on volume
// and area to 1.6e-16 and is caught only by the tree and the bounding box.
//
// TWO GATES, because they are two different contracts:
//   CAD1   this lane's own fixed corpus, scored NAME-EXACT against CAD1_KNOWN.
//   CAD1H  `hardware/cad/` — the real hive models in ANOTHER LANE'S TREE, scored
//          as a tracked COUNT that fails on getting worse.
//
// ⚠ NEITHER SIZE IS STATED HERE ANY MORE, and that is the correction. These two
// lines read "the 63-case corpus" and "73 real hive models" until 2026-08-27,
// when the run measured 87 and 72. CAD1H's set is not ours — `cad` adds and
// deletes files in it — so a count written down here is a number that goes stale
// without anyone touching this file, and the ratchet log below already records
// the corpus moving 73 -> 72 while these lines did not. Take both from the run;
// the log's own dated entries are history and keep the number they were true at.
//
// 🔴 WHY CAD1H IS A NUMBER AND NOT PASS/FAIL — the README's argument, checked
// rather than taken: at wiring time it is 24 DIVERGES + 5 ERROR with ZERO real
// agreements, none of them regressions and all of them known. Gating on that
// ships a gate that is red on day one and stays red, and a permanently-red gate
// stops being read — the same reasoning that produced the three-valued verdict.
//
// 🔴 AND WHY "WORSE" IS `DIVERGES + ERROR` AND NOT `REFUSED` GOING DOWN. This
// lane's rule is REFUSE RATHER THAN APPROXIMATE. A refusal emits nothing and is
// SAFE; a divergence emits a plausible wrong part. So a file moving REFUSED ->
// DIVERGES counts as getting worse even though it looks like new capability,
// and that is not a hypothetical: it is exactly what happened between the
// oracle README being written and this gate being wired.
//
// MEASURED COST, rather than budgeted on a guess: corpus alone 3.5s, corpus +
// hardware 7.3s wall clock. The oracle README suggested a `--quick` PENDING
// entry might be needed and said to measure first. Measured: it is not, and one
// is not added. A PENDING_BUDGET entry bought for a cost that turned out not to
// exist is a permission granted for nothing.
//
// 🔴 THAT 7.3s WAS THE COST OF SCANNING 85 FILES, 79 OF THEM `lib/`. Corrected
// 2026-09-02: the hardware leg was non-recursive AND parsed with no library
// host, so it measured leaf files it could handle and skipped every part this
// company cuts. Recursive, with imports resolved, the real population is 296
// live files and the measured cost is **24m58s**.
//
// ⇒ CADENCE SPLIT, ceo ruling 2026-09-02 — *"move the cadence, not the code."*
// 25 minutes is only fatal in a per-commit loop; the nightly audit has hours.
//   · FULL run  -> the whole live population. This is what nightly executes.
//   · `--quick` -> `--cut-only`: the 16 `_wcnc` + 1 `_acnc` files that are
//     actually CUT, in ~16s. Chosen by CONSEQUENCE, not by size — it is the
//     subset where being wrong ends at a spindle.
//
// ⚠ AND THE QUICK RUN SAYS SO IN ITS OWN VERDICT. A subset that quietly became
// the whole check is the exact defect this gate spent the morning repairing, so
// the cut-file run is reported as a SUBSET and never as a clean full pass.
//
// ⏸ A content-hash cache was considered and DEFERRED by the same ruling: it is
// the right answer eventually and a day of harness work for a problem the
// cadence change removes today. Revisit when the nightly slot is the
// bottleneck, not before.

// ===========================================================================
//  REACH — unreachable material is NAMED
// ===========================================================================
//
// 🔴 AN OBLIGATION, NOT A PROHIBITION, AND THAT CHANGES THE CONTROL.
//
// A prohibition gate plants a wrong value and watches the gate see it. Here the
// program is RIGHT in everything it contains; what is wrong is what it does not
// contain, and what must not be missing is the SENTENCE. So the plant removes
// the note and leaves the G-code byte-identical — the state the defect produced
// before `unreachable_feature_note` existed.
//
// ⚠ THREE LIMBS, AND THE THIRD IS THE ONE PEOPLE SKIP. A check that always says
// "unreachable" is as useless as one that never does, so a drawing with nothing
// unreachable must stay SILENT. Without that limb this gate would pass with the
// note hardcoded.
{
  const NOTCH = 'gates/fixtures/notch-unreachable.dxf';
  // Local, not borrowed: `cfgFile`/`TOOL` are block-scoped in MULTI and this
  // gate must not depend on another block's internals to run.
  const cfgReach = join(ROOT, 'target', 'reach-tool.json');
  writeFileSync(cfgReach, JSON.stringify({ tool_id: 'End Mill - Down-cut 6mm 2F' }));
  // Driven exactly as `PLANT` drives it — `nest <path> --config` and nothing
  // else — because a gate that needs flags its own plant-auditor does not pass
  // is a gate whose control runs a different command than the gate does.
  const on = (...extra) => slice(['nest', NOTCH, '--config', cfgReach, ...extra]);

  const clean = on();
  const NEEDLE = 'CANNOT BE PRODUCED';
  // 1. THE OBLIGATION. The program must emit AND name what it cannot make.
  const emitted = clean.code === 0 && clean.stdout.trim() !== '';
  const named = clean.stderr.includes(NEEDLE);
  // It must name the AREA, not merely gesture: a note with no quantity cannot be
  // told from a note about rounding.
  const quantified = /\d+\.\dmm² of this outline CANNOT BE PRODUCED/.test(clean.stderr);

  // 2. THE PLANT — inverted. Silence, with the same bytes.
  const blind = on('--plant', 'reach-blind');
  const plantRan = blind.code === 0 && blind.stdout.trim() !== '';
  const wentSilent = plantRan && !blind.stderr.includes(NEEDLE);
  const sameProgram = plantRan && blind.stdout === clean.stdout;

  // 3. SPECIFICITY. A drawing with nothing unreachable must say NOTHING — else
  //    the note is a rubber stamp and limb 1 is vacuous.
  const plate = slice(['nest', 'gates/fixtures/plate.dxf', '--config', cfgReach]);
  const quietWhenReachable = plate.code === 0 && !plate.stderr.includes(NEEDLE);

  const bits = [
    [emitted, 'the notch fixture emitted no program, so there is nothing to be silent ABOUT'],
    [named, `the program does NOT name its unreachable material — this is the defect, not a gap`],
    [quantified, 'the note does not give the AREA, so it cannot be told from a note about corner rounding'],
    [plantRan, '`--plant reach-blind` did not emit; the inverted control needs a program to be silent in'],
    [wentSilent, 'the planted run STILL names the material — the control cannot go red, so limb 1 proves nothing'],
    [sameProgram, 'the plant MOVED the program; it is declared to remove a sentence and nothing else'],
    [quietWhenReachable, 'a drawing with nothing unreachable ALSO gets the note — the check is a rubber stamp'],
  ];
  const bad = bits.filter(([ok]) => !ok).map(([, why]) => why);
  if (bad.length) {
    fail('REACH', bad.join(' | '));
  } else {
    pass(
      'REACH',
      'the 2mm notch a 6mm cutter cannot enter is NAMED with its area (109.8mm²) on a program that ' +
        'is otherwise clean — ok=true, gouge=0, 230 cutting moves — and `--plant reach-blind` removes ' +
        'the sentence while leaving the G-code BYTE-IDENTICAL, which is what an obligation\'s negative ' +
        'control has to look like. A reachable drawing stays silent, so the note is not a rubber stamp. ' +
        '⚠ NOT COVERED: this asserts the program SAYS what it cannot make, never that the operator read ' +
        'it — and it is one fixture, so a second unreachable shape this rule misses is invisible here'
    );
  }
}
{
  const ORACLE = join(ROOT, 'tools/scad_oracle/oracle.mjs');
  const OUT = join(ROOT, 'target', 'scad-oracle-gate.json'); // target/ is gitignored
  // 🔴 `canon.mjs` IS PART OF THE INSTRUMENT AND WAS NOT IN THIS DIGEST. The
  // fingerprint existed to make a red legible — "baseline measured over cad-src
  // X, this run is Y" — and it could not see the file that reduces BOTH sides to
  // the compared form. Measured 2026-09-02: a canon serialiser that had been
  // dropping `multmatrix` retired NINE tree-leg divergences when fixed. Nine
  // verdicts moved with the digest unchanged, so the one line whose job is
  // saying "a different instrument measured this" said nothing.
  // 🔴 THIS LIST IS DECLARED, AND UNTIL 2026-09-04 NOTHING ASKED THE WORLD ABOUT
  // IT. ceo's generalisation of the doc-vs-code round: *if your gate reads a
  // declared list of places, ask whether anything asks the WORLD about that
  // list.* Measured immediately: `web/src/cad/` holds SEVEN `.ts` files and this
  // named TWO of them, while the oracle's reader actually imports THREE —
  // `library.ts` was missing.
  //
  // ⚠ AND IT IS NOT AN INERT OMISSION. `library.ts` resolves `use`/`include`, so
  // a change to it changes WHICH SOURCE the oracle reads — and `readerSha`, the
  // digest whose entire job is to say "a different instrument measured this",
  // could not see it. The baseline pair would have stayed "comparable" across a
  // change to how files are found.
  //
  // The list is still declared rather than globbed, deliberately: globbing
  // `web/src/cad/*.ts` would sweep in the editor-side modules (`record`,
  // `replace`, `rulers`, `session`) that no oracle path imports, and a digest
  // that moves when the RULERS change is a digest nobody trusts. So it is
  // declared AND checked against the imports below.
  const CAD_SRC_FILES = [
    // These three are MECHANICAL: they are exactly what the reducers import from
    // `web/src/cad/`, and the check below re-derives them on every run.
    'web/src/cad/scad.ts',
    'web/src/cad/library.ts',
    'web/src/cad/mesh.ts',
    // 🔴 THIS ONE IS NOT, AND THE RULE STRUCTURALLY CANNOT REACH IT. `canon.mjs`
    // is THE REDUCER — no import inside `web/src/cad/` can ever name the module
    // doing the importing, so no widening of the rule will produce it.
    //
    // ⚠ MARKED HERE, AT THE POINT IT IS ADDED, RATHER THAN ONLY WHERE IT IS
    // EXEMPTED (`DIGEST_NON_IMPORT`, below). ceo 2026-09-04: an unmarked
    // exception is indistinguishable from a forgotten one — the next reader
    // deletes it as a stray, or the next auditor counts it as a hand-assembled
    // set when it is a real gap in the rule rather than laziness.
    'tools/scad_oracle/canon.mjs',
  ];
  // The B−A direction for this list: every local `.ts` the oracle's own modules
  // import must be in the digest. A reader file added and imported but not
  // listed is exactly the blind spot that was here.
  const readerImports = new Set();
  for (const f of ['tools/scad_oracle/ours.mjs', 'tools/scad_oracle/canon.mjs']) {
    try {
      for (const m of readFileSync(join(ROOT, f), 'utf8').matchAll(/from '\.\.\/\.\.\/(web\/src\/cad\/[a-z]+\.ts)'/g)) {
        readerImports.add(m[1]);
      }
    } catch {
      /* reported by the load guard below, not here */
    }
  }
  const undigested = [...readerImports].filter((f) => !CAD_SRC_FILES.includes(f));
  // 🔴 AND THE OTHER DIRECTION, because I built only B−A and ceo's round note
  // named the shape I was left with: *a mechanical rule UNION a remembered fact
  // is not a mechanical set.* The rule is "everything `ours.mjs`/`canon.mjs`
  // import from `web/src/cad/`". The remembered member is `canon.mjs` ITSELF —
  // the oracle's reducer, which no `web/src/cad` import can name.
  //
  // ⚠ SO THE UNION MEMBER IS DECLARED HERE INSTEAD OF BEING IMPLICIT. A stale
  // entry — a reader file renamed, or one that stops being part of the reader —
  // would otherwise sit in the digest making it move on changes that cannot
  // affect a verdict, and a digest that moves for irrelevant reasons is one
  // nobody trusts, which is how a correct alarm gets ignored.
  const DIGEST_NON_IMPORT = ['tools/scad_oracle/canon.mjs'];
  const stale = CAD_SRC_FILES.filter((f) => !readerImports.has(f) && !DIGEST_NON_IMPORT.includes(f));
  const DOC = join(ROOT, 'SLICER-GATES.md');

  // The two gates share one oracle run, so a failure to RUN it must reach both.
  const bothFail = (m) => {
    fail('CAD1', m);
    fail('CAD1H', m);
  };
  const bothPend = (m) => {
    pend('CAD1', m);
    pend('CAD1H', m);
  };

  if (stale.length) {
    bothFail(
      `CAD_SRC_FILES names ${stale.length} file(s) the oracle does NOT import: ${stale.join(', ')}. ` +
        'The digest would move on a change that cannot affect a verdict, and a digest that moves for irrelevant ' +
        'reasons stops being read. Remove it, or add it to DIGEST_NON_IMPORT with the reason it belongs.'
    );
  }
  if (undigested.length) {
    bothFail(
      `the reader digest is BLIND to ${undigested.length} file(s) the oracle imports: ${undigested.join(', ')}. ` +
        '`readerSha` exists to say when a DIFFERENT instrument measured a baseline, so a reader file outside ' +
        'CAD_SRC_FILES can change what the oracle reads while the digest — and therefore the baseline pair — ' +
        'still reads as comparable. Add it to CAD_SRC_FILES and re-derive the baselines.'
    );
  }
  let cadSrc = null;
  try {
    const h = createHash('sha256');
    for (const p of CAD_SRC_FILES) h.update(readFileSync(join(ROOT, p)));
    cadSrc = h.digest('hex').slice(0, 12);
  } catch (e) {
    cadSrc = null;
  }

  if (!existsSync(ORACLE)) {
    // Not a gap: the harness this gate is made of has gone. A check whose
    // instrument is missing is a defect, and it is not the same thing as a box
    // that happens to lack `openscad`.
    bothFail(`the oracle is GONE — ${ORACLE} does not exist, so nothing was compared to anything`);
  } else if (cadSrc === null) {
    bothFail(`could not read ${CAD_SRC_FILES.join(' + ')} — the side under test is unreadable, which is not a gap`);
  } else {
    // The two Node flags are not decoration: `ours.mjs` imports the browser's
    // own `.ts` unmodified, and Node's strip-only TypeScript mode rejects
    // constructor parameter properties. Passed here so the gate cannot be the
    // reason the harness declines to start.
    // 🔴 CAD1H MEASURES A COMMIT, NOT THE SHARED WORKING TREE.
    //
    // `hardware/cad/` belongs to `cad` and is written continuously — 13
    // uncommitted paths while this was written. Two runs minutes apart therefore
    // measured different inputs, and `SPLNT` reported `CAD1H` as a NOISY ROW:
    // two clean runs of "one tree" disagreed, which made the 8 self-plants aimed
    // at it UNMEASURABLE. A row that cannot repeat cannot certify anything.
    //
    // ⚠ AND NOISE IS THE SMALLER HALF. A verdict measured against a tree that no
    // longer exists cannot be re-derived by anyone, us included — `cad`'s
    // standing suggestion (2026-09-02), in this lane's OPEN block since 09-03.
    //
    // `git archive HEAD hardware/cad | tar -x` — 596 .scad files in 751 ms,
    // measured. Extracted under `target/`, which is BOTH gitignored AND excluded
    // from the SPLNT fingerprint, so writing it cannot itself look like drift.
    //
    // ⚠ CACHED BY SHA BECAUSE A FULL PASS SPAWNS 42 CHILDREN. Re-extracting per
    // child would be ~12 GB of writes per run. The first process to see a new
    // HEAD extracts into a temp dir and MOVES it into place, so a child can
    // never read a half-written tree.
    const CAD_HEAD = join(ROOT, 'target/cad-head');
    // 🔴 GIT RUNS FROM THE REPO ROOT, NOT THE LANE. `ROOT` is `software/2bee.app`
    // and `hardware/cad` is repo-relative, so `git archive HEAD hardware/cad`
    // with `cwd: ROOT` dies with *"pathspec did not match any files"*.
    //
    // ⚠ AND THIS WAS HIDDEN BY MY OWN HAND. I extracted the tree manually from
    // the repo root to take the baseline measurement and wrote the stamp file
    // myself, so the gate found a valid cache and SKIPPED extraction on every
    // run I called verification. What I actually verified was the ANNOTATION;
    // the extraction underneath it had never executed. A cache pre-populated by
    // the person testing the thing the cache bypasses is a green with nothing
    // behind it.
    const REPO_ROOT = join(ROOT, '../..');
    let cadHeadSha = null;
    let cadHeadWhy = null;
    try {
      // 🔴 KEYED ON THE `hardware/cad` TREE HASH, NOT ON HEAD — the identity that
      // matters is the INPUT, and HEAD is not it. Measured 2026-09-04: the tree
      // was `e856a01710af` at both `dbb53024e5c5` and four commits later, so a
      // HEAD-keyed cache re-extracts 297 MB every time ANY lane commits anything
      // — this fleet commits many times an hour — while a tree-keyed one
      // re-extracts exactly when `cad` changes something.
      //
      // ⚠ AND IT FIXES THE ANNOTATION, WHICH IS THE HALF THAT MATTERS. A baseline
      // labelled with a COMMIT reads as stale the moment HEAD moves, so the next
      // reader cannot tell "the input changed" from "the repo moved on". Two
      // commits with identical `cad` content must compare EQUAL, and only the
      // tree hash says so.
      cadHeadSha = execSync('git rev-parse HEAD:hardware/cad', { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
      const stamp = join(CAD_HEAD, '.sha');
      const have = existsSync(stamp) ? readFileSync(stamp, 'utf8').trim() : null;
      if (have !== cadHeadSha) {
        const tmp = CAD_HEAD + '.tmp.' + process.pid;
        rmSync(tmp, { recursive: true, force: true });
        mkdirSync(tmp, { recursive: true });
        // `git archive HEAD hardware/cad` (not the bare tree) so the extracted
        // layout keeps its `hardware/cad/` prefix; the TREE HASH above is what
        // decides whether this runs at all.
        execSync('git archive HEAD hardware/cad | tar -x -C ' + JSON.stringify(tmp), { cwd: REPO_ROOT });
        writeFileSync(join(tmp, '.sha'), cadHeadSha);
        rmSync(CAD_HEAD, { recursive: true, force: true });
        execSync('mv ' + JSON.stringify(tmp) + ' ' + JSON.stringify(CAD_HEAD));
      }
    } catch (e) {
      cadHeadSha = null;
      cadHeadWhy = String(e.message).split('\n')[0].slice(0, 120);
    }

    const args = [
      '--experimental-transform-types',
      '--disable-warning=ExperimentalWarning',
      ORACLE,
      '--hardware',
      ...(cadHeadSha ? ['--hardware-root', join(CAD_HEAD, 'hardware/cad'), '--hardware-ref', cadHeadSha] : []),
      ...(QUICK ? ['--cut-only'] : []),
      '--json',
      OUT,
    ];
    // 🔴 THE NEGATIVE CONTROL FOR THIS GATE LIVES IN A SECOND PLANT REGISTRY,
    // AND GATE `PLANT` CANNOT SEE IT. `PLANT` limb 2 scans this file for literal
    // `'--plant', '<name>'` pairs and cross-checks each against the RUST
    // BINARY's registry — so writing `mesh-scale` as a literal pair here made
    // PLANT correctly report *"the binary does not register it"* on the first
    // run. It does not: the ORACLE registers it, which is a different registry
    // that nothing in this file knew about. The flag is therefore built from a
    // constant so it does not match PLANT's pattern (do not "fix" it back), and
    // the missing cross-check is done HERE instead, on EVERY run rather than
    // only under the self-plant: a control that has silently stopped planting
    // runs clean and reads as a passing control, which is PLANT's own finding
    // arriving one registry along.
    const ORACLE_PLANT_FLAG = '--plant';
    const ORACLE_PLANT = 'mesh-scale';
    const plantList = spawnSync(
      process.execPath,
      ['--experimental-transform-types', '--disable-warning=ExperimentalWarning', ORACLE, '--list-plants'],
      { cwd: ROOT, encoding: 'utf8' }
    );
    const plantRegistered = (plantList.stdout ?? '').includes(ORACLE_PLANT);
    if (selfPlanted('cad1-oracle-plant')) args.push(ORACLE_PLANT_FLAG, ORACLE_PLANT);

    // 🔴 NEGATIVE CONTROL FOR THE HARNESS'S OWN LOAD GUARD — every run, not
    // only under a self-plant. `oracle.mjs` catches a missing
    // `--experimental-transform-types` and exits 2 saying nothing was measured.
    //
    // ⚠ THAT GUARD IS DISARMED BY ANY STATIC LOCAL IMPORT AT THE TOP OF
    // `oracle.mjs`, and it silently was. Measured 2026-09-04: `canon.mjs` was
    // `import ... from` and it pulls `web/src/cad/mesh.ts`, so a flagless run
    // died inside the MODULE LOADER — before the module body, therefore before
    // the try/catch — with a raw V8 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` stack
    // and exit **1**. In this harness 1 means RAN AND FOUND PROBLEMS and 2 means
    // COULD NOT RUN, so the one condition the guard exists to announce was
    // reported as its opposite.
    //
    // ⚠ ASSERTS THE STATUS, not just the message: exit 1 carrying a perfect
    // explanation is still the failure, because the status is what a caller
    // branches on and the prose is not.
    const noFlag = spawnSync(process.execPath, [ORACLE, '--hardware', '--cut-only'], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    const noFlagOut = `${noFlag.stdout ?? ''}${noFlag.stderr ?? ''}`;
    if (noFlag.status !== 2) {
      bothFail(
        "the oracle's LOAD GUARD IS DISARMED: run without --experimental-transform-types it exited " +
          `${noFlag.status}, not 2. Exit 2 is COULD NOT RUN; anything else this harness reads as a ` +
          'finding. Either a local dependency was made a STATIC import at the top of ' +
          'tools/scad_oracle/oracle.mjs (which hoists above the try/catch that explains the flag), ' +
          "or this Node now parses the browser's .ts without the flag — in which case the guard is " +
          'moot and this control needs retiring deliberately, not deleting quietly.'
      );
    } else if (!/NOTHING was measured/.test(noFlagOut)) {
      bothFail(
        'the oracle exits 2 without the TypeScript flag but no longer SAYS nothing was measured — ' +
          'the status is right and the operator-facing explanation is gone. Both are load-bearing: ' +
          'the status is for the caller, the sentence is for the human reading a red run.'
      );
    }

    const run = spawnSync(process.execPath, args, {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    });
    const transcript = `${run.stdout ?? ''}${run.stderr ?? ''}`;
    const tail = transcript.trim().split('\n').slice(-3).join(' / ').slice(0, 400);

    let doc = '';
    try {
      doc = readFileSync(DOC, 'utf8');
    } catch {
      doc = '';
    }

    let j = null;
    if (run.error) {
      bothFail(`the oracle could not be spawned: ${run.error.message}`);
    } else if (run.status === 2) {
      // Exit 2 is "the harness could not start", and with the flags supplied
      // above that is a broken instrument, not an absent binary — an absent
      // binary is exit 3 with every case PENDING.
      bothFail(`the oracle refused to start (exit 2), so NOTHING was measured: ${tail}`);
    } else {
      try {
        j = JSON.parse(readFileSync(OUT, 'utf8'));
      } catch (e) {
        /* 🔴 SAY WHICH BOUNDS ARE NOT BEING HELD, not merely that a step failed.
         * ceo ruling 2026-09-05: an UNMEASURABLE ratchet and a SATISFIED ratchet
         * must not render identically. A reader who sees only "the oracle
         * exited" can carry on believing the last good number still bounds
         * something; it does not, because nothing was compared to anything.
         * ⚠ 134 is SIGABRT — on this leg that has meant a V8 heap OOM over the
         * full population, a CAPACITY limit rather than a finding, so it is
         * named instead of left as a bare status for the reader to decode. */
        const why =
          run.status === 134
            ? `exited ${run.status} (SIGABRT — on this leg that has been a V8 heap OOM over the full population: a capacity limit, not a finding)`
            : `exited ${run.status}`;
        bothFail(
          `the oracle ${why} and wrote no readable JSON at ${OUT}: ${e.message}. ` +
            '⇒ BOTH CAD1H RATCHETS ARE UNMEASURED ON THIS RUN — DIVERGES+ERROR and PENDING were ' +
            'not evaluated, so the numbers in SLICER-GATES.md bound NOTHING here. Do not read the ' +
            'last good value as a bound that is holding; it is a bound that was not checked.'
        );
      }
    }

    if (j) {
      // With `--plant`, the oracle runs the suite twice and `planted` is the run
      // under test. Reading `baseline` there would score the CLEAN run and the
      // negative control would pass while planting nothing — the exact vacuity
      // gate PLANT exists to find.
      const cases = (j.plant ? j.planted : j.baseline) ?? [];
      // Negative control for the vocabulary limb below. It corrupts ONE row's
      // verdict word, which is the whole defect in miniature: a word this file
      // does not model must not be counted as zero.
      if (selfPlanted('cad1-verdict-unknown') && cases.length) cases[0] = { ...cases[0], verdict: 'ZZTOP' };
      // Negative control for the named-undecidable-class limb in the CAD1H
      // chain: a hardware PENDING whose reason is NONE of the ruled classes
      // must still fail. The limb carries measured, ruled classes by name;
      // without this plant, "unlisted still fails" is a branch nobody has
      // watched go red.
      if (selfPlanted('cad1-undecided-unlisted')) {
        cases.push({
          name: 'hardware/zztop_undecidable.scad',
          group: 'hardware',
          verdict: 'PENDING',
          reason: 'PLANTED: undecidable for a reason nobody has named, dated or ruled on',
        });
        // 2026-08-22: CAD1's corpus limb was narrowed the same way CAD1H's was,
        // so the plant covers BOTH legs — a narrowed corpus half with no
        // control is the old limb removed and called a change.
        cases.push({
          name: 'corpus/zztop_undecidable',
          group: 'corpus',
          verdict: 'PENDING',
          reason: 'PLANTED: undecidable for a reason nobody has named, dated or ruled on',
        });
      }
      const grp = (g) => cases.filter((c) => c.group === g);
      const isBad = (c) => c.verdict === 'DIVERGES' || c.verdict === 'ERROR';
      // ⚠ THE INPUT IS PART OF THE INSTRUMENT AND IS NAMED HERE. ceo 2026-09-06:
      // a baseline that moved because its INPUT was re-pinned is byte-for-byte
      // indistinguishable from a regression unless the input is recorded beside
      // it. `cad-src` already names the reader; this names what it read.
      const src =
        `openscad ${j.openscad ?? 'ABSENT'}, cad-src ${cadSrc}, input ` +
        (cadHeadSha
          ? `cad-tree@${cadHeadSha.slice(0, 12)} (extracted — reproducible)`
          : `🔴 WORKING TREE (extraction failed${cadHeadWhy ? `: ${cadHeadWhy}` : ''}) — NOT reproducible`);

      // 🔴 THE COUNTS IN BOTH MESSAGES ARE TALLIED FROM THE ROWS, NEVER
      // ENUMERATED — because the enumerated form was WRONG for a day and said
      // so in green. Both gates counted `c.verdict === 'REFUSED'`, a word the
      // oracle STOPPED EMITTING at `1e84797818`, which split a refusal into
      // `REFUSED-BOTH` (openscad emits nothing either — safe agreement) and
      // `STRICTER` (openscad emits geometry and we refuse — a capability gap).
      // So both gates printed `0 REFUSED` over 21 live refusals, in the same
      // sentence that reported everything else correctly. A gate whose own
      // output misdescribes its run is the defect this file exists to find,
      // arriving in the file itself.
      //
      // ⇒ Two properties, and the SECOND is the one that lasts:
      //   1. every verdict actually present is printed, with its own count, so
      //      the line cannot describe a vocabulary the run did not use;
      //   2. a verdict this gate does not MODEL is a FAILURE, not a silent
      //      zero. The vocabulary changed once underneath a gate that could not
      //      notice; the next change goes red instead of quietly reading 0.
      const KNOWN_VERDICTS = ['SAME', 'STRICTER', 'REFUSED-BOTH', 'DIVERGES', 'ERROR', 'PENDING'];
      const unmodelled = [...new Set(cases.map((c) => c.verdict))].filter((v) => !KNOWN_VERDICTS.includes(v));
      const legSummary = (label, noun, rows) => {
        const t = new Map();
        for (const c of rows) t.set(c.verdict, (t.get(c.verdict) ?? 0) + 1);
        const parts = [...t.keys()]
          .sort((a, b) => KNOWN_VERDICTS.indexOf(a) - KNOWN_VERDICTS.indexOf(b))
          .map((v) => `${t.get(v)} ${v}`);
        return `${label} ${rows.length} ${noun}: ${parts.join(', ')}`;
      };

      // 🔴 THE ORACLE'S OWN NO-GO REACHED NOTHING UNTIL THIS BLOCK READ IT.
      // `oracle.mjs` scores every `STRICTER` refusal against a named, dated
      // `STRICTER_LEDGER` — an unlisted one is a capability the binary has and
      // we do not, with nobody's name and no date on it — and it says in its
      // own source that the verdict reaches nothing, because THIS FILE branches
      // on the oracle's exit code only for `2`. A control with no consumer is a
      // control that accrues authority it never earned.
      //
      // ⚠ READ PER LEG, NOT AS ONE VERDICT. `fresh`/`wrongKind` can name a case
      // in EITHER leg, and failing CAD1 — whose entire contract is the corpus —
      // for a file in `hardware/cad/` is the exact defect the per-leg PENDING
      // split above was written to undo. `staleCorpus`/`goneCorpus` are
      // corpus-only by construction in the oracle; the hardware equivalents are
      // WARNINGS there, deliberately, because a rename in another lane's tree
      // is not a regression — so they ride in CAD1H's message and fail nothing.
      if (selfPlanted('cad1-ledger-absent')) j.stricterLedger = undefined;
      const ledger = j.stricterLedger ?? null;
      if (selfPlanted('cad1-ledger-unlisted') && ledger) {
        const had = (ledger.fresh ?? []).length > 0;
        ledger.fresh = [...(ledger.fresh ?? []), 'corpus/zztop_not_on_the_ledger', 'hardware/zztop_not_on_the_ledger.scad'];
        // The bookkeeping limb below compares the oracle's OWN failure count
        // against the categories this gate models. A plant that moved one
        // without the other would fire THAT limb instead of the one it names,
        // and a plant that fires for the wrong reason certifies the wrong
        // property.
        if (!had) {
          ledger.failures = [
            ...(ledger.failures ?? []),
            'PLANTED: 2 refusal(s) are STRICTER THAN OPENSCAD and are NOT on the ledger',
          ];
        }
      }
      const LEDGER_CATEGORIES = [
        ['fresh', (n) => `${n} REFUSES where openscad produces geometry and is NOT on the ledger — a capability the binary has and we do not, with nobody's name and no date on it`],
        ['wrongKind', (n) => `${n}'s ledger entry claims the wrong thing about what openscad does with it`],
        ['staleCorpus', (n) => `${n} is no longer STRICTER and its ledger entry must be REMOVED — a ledger that keeps headroom it has stopped needing is the slack that absorbs the next gap`],
        ['goneCorpus', (n) => `${n} names a case that DID NOT RUN — the entry reads as coverage of something that is not there`],
      ];
      const ledgerFindings = (hwLeg) =>
        LEDGER_CATEGORIES.flatMap(([k, say]) =>
          (ledger?.[k] ?? []).filter((n) => n.startsWith('hardware/') === hwLeg).map(say)
        );

      /* The hardware leg's `fresh` names, partitioned against
       * {@link CAD1H_STRICTER_KNOWN}. Everything OUTSIDE `fresh` — a ledger
       * entry that claims the wrong thing, a stale one, one naming a case that
       * did not run — stays a hard failure untouched: those are ledger
       * INTEGRITY problems, and pinning a count of them would be pinning a
       * broken instrument. */
      const hwFresh = (ledger?.fresh ?? []).filter((n) => n.startsWith('hardware/'));
      const knownFiles = new Set(CAD1H_STRICTER_KNOWN.map((k) => k.file));
      const unknownStricter = hwFresh.filter((n) => !knownFiles.has(n));
      /* 🔴 THE RATCHET-DOWN LIMB IS FULL-RUN ONLY, FOR THE SAME REASON THE
       * BASELINE COUNT IS: absence over a SUBSET proves nothing. Under
       * `--quick` the population is the 17 cut files, none of the pinned 14 is
       * among them, and a naive `!hwFresh.includes(...)` reported all 14 as
       * "no longer refuse — remove them". That would have deleted the pinned
       * set on the strength of not having looked. Measured, not reasoned: the
       * first `--quick` run after wiring this said exactly that.
       *
       * `unknownStricter` needs no such guard — a name that APPEARS is real
       * wherever it appears, and it is the direction that must stay loud. */
      const clearedStricter = QUICK ? [] : CAD1H_STRICTER_KNOWN.filter((k) => !hwFresh.includes(k.file));
      const otherLedger = LEDGER_CATEGORIES.filter(([k]) => k !== 'fresh').flatMap(([k, say]) =>
        (ledger?.[k] ?? []).filter((n) => n.startsWith('hardware/')).map(say)
      );
      /** Says which of the three things went wrong, separately — they have
       *  different remedies and merging them into one count is what let 14
       *  known gaps hide a 15th unknown one. */
      /* The second ratchet's inputs, and the cut-file split that rides in every
       * CAD1H message. `_wcnc` under `test/fixtures/` is OURS, not a part this
       * company cuts — counting it would inflate the population the sentence is
       * about, which is the same label-vs-measurement error this gate has now
       * caught three times. */
      const stricterMessage = () => {
        const parts = [];
        if (unknownStricter.length) {
          parts.push(
            `${unknownStricter.length} STRICTER refusal(s) NOT on the pinned set — a capability openscad ` +
              `has and we do not, with nobody's name and no date on it: ${unknownStricter.join(', ')}. ` +
              'Add each to CAD1H_STRICTER_KNOWN with its cause, or fix it'
          );
        }
        if (clearedStricter.length) {
          parts.push(
            `${clearedStricter.length} pinned STRICTER entr(ies) NO LONGER REFUSE and must be REMOVED from ` +
              `CAD1H_STRICTER_KNOWN — the count may only go DOWN: ${clearedStricter.map((k) => k.file).join(', ')}`
          );
        }
        if (otherLedger.length) parts.push(`ledger integrity: ${otherLedger.join(' | ')}`);
        return parts.join(' — ');
      };
      // ⚠ AND THE ENUMERATION ABOVE IS ITSELF A LIST THAT CAN GO BLIND. The
      // oracle raises exactly one failure string per non-empty category, so the
      // two counts must agree; if they do not, this gate is not reading
      // something the oracle is complaining about, and it says that rather than
      // reporting the categories it happens to know.
      if (selfPlanted('cad1-ledger-bookkeeping') && ledger) {
        ledger.failures = [...(ledger.failures ?? []), 'PLANTED: a ledger failure in a category this gate does not model'];
      }
      const ledgerRaised = (ledger?.failures ?? []).length;
      const ledgerModelled = LEDGER_CATEGORIES.filter(([k]) => (ledger?.[k] ?? []).length).length;

      // PENDING, split by WHY. Only "the binary is not on this box" is a gap;
      // a timeout, an unparseable .csg or a comparison the precision cannot
      // settle is a check that could not answer and is scored as one.
      //
      // 🔴 AND SPLIT BY WHICH LEG IT LANDED ON (2026-08-11). This used to fail
      // BOTH gates from one shared branch, so a file in `hardware/cad/` that the
      // mesh leg cannot decide reported as a failure of CAD1 — whose entire
      // contract is the 68-case CORPUS, which had zero PENDINGs. Measured: the
      // colour pass-through moved 15 hardware files from DIVERGES to PENDING
      // (our top-level solids now overlap, and `mesh.ts` deliberately does not
      // union top-level siblings), and CAD1 went red naming a reason from
      // another lane's tree. Worse, the shared branch SHORT-CIRCUITED both
      // scoring chains: with one PENDING anywhere, neither the name-exact corpus
      // ratchet nor the CAD1H tracked count was ever evaluated, so both
      // baselines could have gone stale behind a red that never mentioned them.
      // A gate that stops scoring the moment anything is undecided is a gate
      // whose ratchet is disarmed by the very condition it exists to survive.
      //
      // ⚠ THE BRANCH IS PLACED LAST IN EACH CHAIN, IMMEDIATELY BEFORE `pass`,
      // AND THE ORDER IS LOAD-BEARING IN TWO DIRECTIONS. It must come AFTER the
      // regression limbs so a genuine new divergence is never masked by an
      // undecidable case — and it must not come BEFORE the ratchet-down limbs,
      // because `--self-plant cad1-baseline-slack` exists to drive exactly those
      // and would have landed here instead. A reordering that leaves a negative
      // control pointing at a branch it can no longer reach is a control that
      // has silently stopped controlling, which is this file's own founding
      // failure. Nothing here lets a gate PASS with an undecided case.
      //
      // ⚠ 2026-08-14 — THE LAST SENTENCE IS NOW TRUE OF THE CORPUS LEG ONLY.
      // CAD1H passes with up to the named, dated and ruled classes of
      // undecided case (CAD1H_UNDECIDED_KNOWN) — each a comparison measured to
      // have NO referent, not a check that broke — and still fails on any
      // PENDING whose reason is none of them.
      // ⚠ 2026-08-22 — CAD1's limb is narrowed the same way, name-exact AND
      // reason-matched against CAD1_UNDECIDED_KNOWN (2 entries, both broken
      // meshes the kernel's own audit rejects — carried as named kernel
      // defects, never as greens). `cad1-undecided-unlisted` now plants an
      // unlisted PENDING into BOTH legs, so neither narrowed half is unwatched.
      const pending = cases.filter((c) => c.verdict === 'PENDING');
      const absent = pending.filter((c) => /binary not found|NOT AVAILABLE/i.test(c.reason ?? ''));
      const other = pending.filter((c) => !/binary not found|NOT AVAILABLE/i.test(c.reason ?? ''));
      const undecided = (g) => other.filter((c) => c.group === g);
      const undecidedWhy = (rows) =>
        `${rows.length} case(s) UNDECIDED — PENDING for a reason that is NOT a missing binary, so this leg does ` +
        `not know whether they are right, and a PENDING IS NOT A PASS: ` +
        `${[...new Set(rows.map((c) => c.reason))].slice(0, 2).join(' | ')}`;

      if (!plantRegistered) {
        bothFail(
          `the oracle no longer registers \`${ORACLE_PLANT}\`, the plant this gate's negative control is driven by ` +
            '— the control would exit 2 on a typo and that reads exactly like a control that fired'
        );
      } else if (cases.length === 0) {
        bothFail(`the oracle produced ZERO cases — a suite that measured nothing is not a suite that agreed (${src})`);
      } else if (unmodelled.length) {
        bothFail(
          `${unmodelled.length} verdict word(s) in this run are ones this gate does not model: ${unmodelled.join(', ')} — ` +
            'every count below is built from a fixed vocabulary, so a word outside it is counted as ZERO and reads as ' +
            "an absence. That is not hypothetical: `REFUSED` was counted as zero for a day after the oracle split it " +
            `into STRICTER and REFUSED-BOTH (${src})`
        );
      } else if (!ledger) {
        bothFail(
          'the oracle wrote no `stricterLedger` in its JSON — that object IS how its NO-GO on an unlisted capability ' +
            `gap reaches a gate at all, because this file ignores the oracle's exit code except 2. Its absence is a ` +
            `broken instrument, not a clean ledger (${src})`
        );
      } else if (ledgerRaised !== ledgerModelled) {
        bothFail(
          `the oracle raised ${ledgerRaised} STRICTER-LEDGER failure(s) and this gate models ${ledgerModelled} category(ies) ` +
            'of them — so it is not reading something the oracle is complaining about, and scoring only the categories ' +
            `it knows would report a clean ledger over an unread one: ${(ledger.failures ?? []).join(' | ') || '(none listed)'}`
        );
      } else if (absent.length === cases.length) {
        bothPend(`openscad is not on this box (${j.openscad ?? 'no version'}), so all ${cases.length} cases are PENDING and nothing was compared`);
      } else if (absent.length > 0) {
        bothFail(
          `${absent.length} of ${cases.length} cases report the binary missing while ${cases.length - absent.length} ran — ` +
            'a partial oracle is not a partial answer, it is an unknown one'
        );
      } else {
        // ---- CAD1: the corpus, scored name-exact -------------------------
        const corpus = grp('corpus');
        const badNames = new Set(corpus.filter(isBad).map((c) => c.name));
        const known = new Set(Object.keys(CAD1_KNOWN));
        // The slack plant adds a case that is KNOWN-GOOD, so the only limb it
        // can move is the ratchet-down one. It cannot hide a real divergence.
        if (selfPlanted('cad1-baseline-slack')) known.add('corpus/prim_cube');

        const fresh = [...badNames].filter((n) => !known.has(n)).sort();
        const stale = [...known].filter((n) => !badNames.has(n)).sort();
        // Limb 4: the document must carry every accepted divergence by name.
        const undocumented = [...known].filter((n) => !doc.includes(n)).sort();

        // The corpus UNDECIDED limb, narrowed 2026-08-22: listed = name-exact
        // AND reason-match against CAD1_UNDECIDED_KNOWN (both, so a case
        // PENDING for a NEW reason fails even when its name is listed).
        const corpusUndecided = undecided('corpus');
        const corpusUndecidedUnlisted = corpusUndecided.filter(
          (c) => !CAD1_UNDECIDED_KNOWN.some((k) => c.name === k.name && (c.reason ?? '').includes(k.match))
        );
        // A listed entry that no longer pends is slack of the same kind limb
        // RATCHET guards above: the exemption outlived the thing it exempts.
        const undecidedStale = CAD1_UNDECIDED_KNOWN.filter(
          (k) => !corpusUndecided.some((c) => c.name === k.name && (c.reason ?? '').includes(k.match))
        );

        const summary = `${legSummary('corpus', 'cases', corpus)} (${badNames.size} tracked DIVERGES+ERROR, by name)`;

        if (fresh.length) {
          fail(
            'CAD1',
            `${fresh.length} case(s) diverge that are NOT in the baseline — our subset means something OpenSCAD does not, ` +
              `and nobody wrote down why: ${fresh.join(', ')}. ${summary} (${src})`
          );
        } else if (stale.length) {
          fail(
            'CAD1',
            `RATCHET: ${stale.length} baseline entr(ies) no longer diverge and must be REMOVED — ${stale.join(', ')}. ` +
              'A baseline that keeps headroom it has stopped needing is the slack that absorbs the next regression, ' +
              `which is the whole reason this limb is a failure and not a note. ${summary} (${src})`
          );
        } else if (undocumented.length) {
          fail(
            'CAD1',
            `${undocumented.length} accepted divergence(s) appear in the gate file and NOT in SLICER-GATES.md — ` +
              `${undocumented.join(', ')}. Raising a baseline must cost an edit to the document that is read in review, ` +
              'or it is a one-digit change that clears a red in silence'
          );
        } else if (ledgerFindings(false).length) {
          const f = ledgerFindings(false);
          fail(
            'CAD1',
            `${f.length} STRICTER-LEDGER finding(s) on the corpus leg — a refusal is only SAFE when openscad refuses ` +
              `too, and these do not: ${f.join(' | ')}. ${summary} (${src})`
          );
        } else if (corpusUndecidedUnlisted.length) {
          // The limb is narrowed the way CAD1H's was on 2026-08-14, and the
          // same rule applies: a PENDING outside the named, dated list is a
          // check that broke, never coverage. `--self-plant
          // cad1-undecided-unlisted` pushes an unlisted row into BOTH legs, so
          // this half is watched too.
          fail('CAD1', `${undecidedWhy(corpusUndecidedUnlisted)}. ${summary} (${src})`);
        } else if (undecidedStale.length) {
          fail(
            'CAD1',
            `RATCHET: ${undecidedStale.length} undecided-class entr(ies) no longer pend and must be REMOVED from ` +
              `CAD1_UNDECIDED_KNOWN — ${undecidedStale.map((k) => k.name).join(', ')}. An exemption that outlives ` +
              'the case it exempts is standing permission for a worse verdict to arrive unnamed'
          );
        } else {
          const strict = corpus.filter((c) => c.verdict === 'STRICTER');
          const both = corpus.filter((c) => c.verdict === 'REFUSED-BOTH').length;
          pass(
            'CAD1',
            `${summary}; every divergence is one of the ${known.size} named, dated and documented: ` +
              `${[...known].sort().join(', ')}. EVERY REFUSAL WAS PUT TO THE BINARY: ${strict.length} are STRICTER ` +
              `than openscad — it produces geometry where we produce none — and each is named and dated on the ` +
              `oracle's STRICTER ledger, which this gate reads (${ledger.entries} entr(ies) over both legs, ` +
              `${ledger.scored} scored this run); REFUSED-BOTH covers ${both}, the only refusal(s) openscad declines too. ` +
              `${src}. NOT CLEAN BY ABSENCE: ${corpusUndecided.length} case(s) are carried as named, dated UNDECIDED ` +
              `(CAD1_UNDECIDED_KNOWN: ${CAD1_UNDECIDED_KNOWN.map((k) => k.name).join(', ')}) — the kernel's own audit ` +
              'calls both meshes broken, so these are deferred kernel defects wearing a name, not agreements. ' +
              'NOT COVERED: a 2D+3D model (openscad drops the 2D object from an STL export and the tree still ' +
              'matches), and whether a ledgered gap OUGHT TO BE CLOSED — the ledger measures what a refusal COSTS, ' +
              'which is a different question from whether anyone should pay it, and nobody has taken that decision'
          );
        }

        // ---- CAD1H: the real models, scored as a tracked count -----------
        const hw = grp('hardware');
        /* 🔴 WHAT TREE STATE PRODUCED THESE FINDINGS. This gate scans the SHARED
         * WORKING TREE, so a divergence is only replayable if `hardware/cad` was
         * clean — see `treeState` in oracle.mjs. On 2026-09-02 this leg reported a
         * file erroring on an undefined variable and I logged it as OUR defect;
         * `cad` showed no COMMITTED state ever had that reference — we had read
         * the middle of a seven-file rename. The SHA now rides in every message so
         * an anomaly is attributable, which is the difference between "chase this
         * in our reader" and "re-run it when the tree settles". */
        const treeNote = j.tree
          ? j.tree.dirtyFiles === null
            ? ' ⚠ TREE STATE UNKNOWN (git unavailable) — findings cannot be attributed to a commit.'
            : j.tree.dirtyFiles > 0
              ? ` ⚠ SCANNED A DIRTY TREE at ${j.tree.sha} (${j.tree.dirtyFiles} uncommitted path(s) under ` +
                'hardware/cad) — a finding here may exist in NO commit and be unreproducible; re-run when the tree ' +
                'settles before chasing one.'
              : ` (tree ${j.tree.sha}, hardware/cad clean — replayable).`
          : '';
        const isCadCut = (n) => /_wcnc\.scad$/.test(n) && !n.includes('/test/fixtures/');
        const cutFiles = hw.filter((c) => isCadCut(c.name));
        const cutBy = (v) => cutFiles.filter((c) => c.verdict === v).length;
        const cutSentence =
          `of ${cutFiles.length} CNC cut files: ${cutBy('SAME')} agree, ${cutBy('DIVERGES') + cutBy('ERROR')} ` +
          `diverge, ${cutBy('PENDING')} UNDECIDABLE`;
        const hwPending = hw.filter((c) => c.verdict === 'PENDING');
        // 🔴 WAS THIS RUN MEASURED WITH THE INSTRUMENT THE BASELINE WAS PINNED
        // AGAINST? `cadSrc` is the digest of CAD_SRC_FILES for THIS run; the
        // baseline carries the digest it was taken with. When they differ the
        // two numbers are not comparable, and a gate that says "UNDECIDABLE
        // GREW" is making a claim about `cad`'s models that it cannot support.
        const readerMoved = cadSrc !== null && cadSrc !== CAD1H_PENDING_BASELINE.readerSha;
        // The INPUT half of the same question. `cadHeadSha` is the tree this run
        // actually extracted; the baseline carries the tree it was measured on.
        const inputNow = cadHeadSha ? cadHeadSha.slice(0, 12) : null;
        const inputMoved = inputNow !== null && inputNow !== CAD1H_PENDING_BASELINE.inputTree;
        const inputClause = inputMoved
          ? ` 🔴 AND THE INPUT HAS MOVED: this pair was measured on cad-tree@${CAD1H_PENDING_BASELINE.inputTree} ` +
            `and this run read cad-tree@${inputNow}. ⇒ THE TWO NUMBERS COME FROM DIFFERENT MODEL SETS, so a ` +
            'difference is not evidence about our reader — `cad` commits many times a day and every commit that ' +
            'touches hardware/cad moves this. Re-derive against the current tree before reading any movement as ' +
            'a regression.'
          : ` The input matches the tree this pair was measured on (cad-tree@${CAD1H_PENDING_BASELINE.inputTree}).`;
        const readerClause = readerMoved
          ? ' 🔴 AND THE READER HAS MOVED SINCE THIS BASELINE WAS PINNED: it was measured over cad-src ' +
            `${CAD1H_PENDING_BASELINE.readerSha} and this run is ${cadSrc}. ⇒ THESE TWO NUMBERS WERE TAKEN WITH ` +
            'DIFFERENT INSTRUMENTS, so this is NOT evidence that the models got worse — the same count can move ' +
            'because our own reader changed, which is measured: the pinned 113/293 re-measures as 122/291 against ' +
            'ITS OWN commit under a later reader. Re-derive the baseline before reading this as a regression: ' +
            'node --experimental-transform-types tools/scad_oracle/oracle.mjs --hardware --hardware-root ' +
            '<worktree>/hardware/cad'
          : ` The reader digest matches the one this baseline was pinned against (${CAD1H_PENDING_BASELINE.readerSha}), ` +
            'so the two numbers are comparable.';
        const pinnedCut = new Set(CAD1H_UNDECIDABLE_CUT_FILES.map((k) => k.file));
        const unpinnedCut = cutFiles.filter((c) => c.verdict === 'PENDING' && !pinnedCut.has(c.name)).map((c) => c.name);
        const clearedCut = QUICK ? [] : CAD1H_UNDECIDABLE_CUT_FILES.filter((k) => !hwPending.some((c) => c.name === k.file));
        const hwBad = hw.filter(isBad);
        const hwSameReal = hw.filter((c) => c.verdict === 'SAME' && !c.empty).length;
        let max = CAD1H_BASELINE.max;
        if (selfPlanted('cad1-baseline-slack')) max += 1;

        const m = /^CAD1H BASELINE: DIVERGES\+ERROR = (\d+)$/m.exec(doc);
        // 🔴 THE PENDING BASELINE HAD NO DOC CHECK AT ALL — only DIVERGES+ERROR
        // did. So the second ratchet could be raised in the gate file with the
        // document left saying anything, and nothing would notice: the exact
        // "lives in TWO places on purpose" argument, applied to only one of the
        // two numbers it was written for. Added 2026-09-04 with the rate change,
        // and it parses the RATE so the pair cannot drift apart either.
        const mp = /^CAD1H BASELINE: PENDING = (\d+)\/(\d+)$/m.exec(doc);
        // The UNDECIDED count rides in every CAD1H message, including the WORSE
        // one, because the tracked number alone understates the exposure: a file
        // that stops diverging by becoming undecidable has not been fixed, and
        // reading `35 DIVERGES` without `16 UNDECIDED` beside it invites exactly
        // that reading.
        // ⚠ The hardware ledger's stale/gone entries are WARNINGS in the oracle
        // and warnings here: `hardware/cad/` is another lane's tree, where a
        // rename is not a regression and failing on one trains the "just edit
        // the list" habit the ratchet exists to prevent. They are PRINTED
        // rather than hidden, because the hole a warning leaves is only useful
        // if somebody can see it.
        const hwLedgerWarn = [
          ...(ledger.staleHardware ?? []).map((n) => `${n} is no longer STRICTER`),
          ...(ledger.goneHardware ?? []).map((n) => `${n} is no longer in hardware/cad/`),
        ];
        // 🔴 THE INSTRUMENT MISMATCH RIDES IN THE SUMMARY, WHICH PRINTS ON A PASS
        // TOO. It was written only into the two ratchet FAILURE messages, and
        // the first full run showed why that is not enough: the D+E limb failed
        // earlier in the same else-if chain, so the clause never printed at all
        // — and on a HEALTHY tree it would never print either, because nothing
        // would have failed. ⇒ A fact about whether two numbers are comparable
        // is not a fact about whether one of them is out of bounds, and hiding
        // it inside a failure means it is announced only when something else is
        // already wrong.
        const hwSummary =
          `${legSummary('hardware', 'files', hw)} — ${hwBad.length} tracked DIVERGES+ERROR, ` +
          `${undecided('hardware').length} UNDECIDED (PENDING), ${hwSameReal} REAL (non-empty) agreement(s)` +
          (hwLedgerWarn.length
            ? `. ⚠ LEDGER: ${hwLedgerWarn.join('; ')} — NOT a failure (another lane may legitimately have changed ` +
              'the file) and NOT nothing: check it stopped being a gap rather than stopped being read'
            : '') +
          readerClause +
          inputClause +
          // 🔴 THE PENDING RATCHET'S STATE RIDES IN EVERY CAD1H MESSAGE, because
          // its two limbs are the LAST branches of a 14-branch else-if chain and
          // anything failing earlier hides them completely.
          //
          // ⚠ MEASURED ON MYSELF, 2026-09-05: a planted run meant to prove the
          // PENDING controls failed on the D+E limb instead (72 against a
          // baseline of 59, after `cad` added 14 files), so the limbs under test
          // NEVER EXECUTED and the experiment was void — the third distinct
          // reason one of those runs came back inconclusive.
          //
          // ceo's canon: *an else-if chain reports the FIRST fault and hides the
          // COUNT of the remaining ones — report every limb, or say evaluation
          // stopped.* This reports it.
          (!QUICK && hwPending.length !== cad1hPendingAllowed(hw.length)
            ? ` ⚠ PENDING RATCHET ALSO OUT: ${hwPending.length} of ${hw.length} against an allowance of ` +
              `${cad1hPendingAllowed(hw.length)} (pinned ${CAD1H_PENDING_BASELINE.count}/` +
              `${CAD1H_PENDING_BASELINE.population}) — stated here because an earlier limb may be the only one ` +
              'this message is about.'
            : '');
        // The undecided set, split by whether its reason is one of the named,
        // ruled classes. See CAD1H_UNDECIDED_KNOWN for why the limb below
        // fails on the unlisted half only.
        const hwUndecided = undecided('hardware');
        const unlistedUndecided = hwUndecided.filter(
          (c) => !CAD1H_UNDECIDED_KNOWN.some((k) => (c.reason ?? '').includes(k.match))
        );

        if (hw.length === 0) {
          fail('CAD1H', `the hardware leg measured ZERO files — the tracked number is over an empty set (${src})`);
        } else if ((unknownStricter.length || clearedStricter.length || otherLedger.length) && QUICK) {
          /* 🔴 THE LEDGER LIMB RUNS UNDER `--quick`, AND ONLY THE COUNT DOES NOT.
           *
           * A STRICTER refusal that is not on the dated ledger is a finding at
           * ANY population size — it says the binary has a capability we do not,
           * with nobody's name on it — whereas the BASELINE is a count over the
           * whole live population and cannot be scored on a subset.
           *
           * ⚠ THIS ORDER IS A REPAIR, NOT A PREFERENCE. Putting the `--quick`
           * PENDING first disarmed two self-plants: `SPLNT` drives `--quick`
           * children, so `cad1-ledger-unlisted` and `cad1-baseline-slack` both
           * reported *"PLANTED NOTHING on CAD1H — byte-identical to the clean
           * baseline, where it was PENDING"*. A control that applies, reports
           * success and reddens nothing is indistinguishable from a gate that is
           * fine. `SPLNT` caught it on the first full run after the cadence
           * split; the split is right and this is the half of it I got wrong.
           *
           * `cad1-baseline-slack` still cannot fire under `--quick` — its
           * subject IS the count — and that is stated in its own registry entry
           * rather than left for the next reader to rediscover. */
          fail(
            'CAD1H',
            stricterMessage() + treeNote + ' (The baseline COUNT is not scored here; the full population runs nightly.)'
          );
        } else if (QUICK) {
          /* 🔴 A SUBSET IS NOT A PASS, AND IT IS NOT SCORED AGAINST THE FULL
           * BASELINE. `--quick` runs `--cut-only` (ceo cadence ruling
           * 2026-09-02): the files that are actually CUT, in ~16s, because that
           * is the subset where being wrong ends at a spindle. The ratchet
           * below demands EXACT equality with a baseline measured over the
           * whole live population, so scoring a subset against it would fail on
           * arithmetic rather than on a defect — and passing it would be worse,
           * because a subset that reads as a clean full run is the exact defect
           * this gate spent 2026-09-02 repairing.
           *
           * So it reports what it measured, by name, and PENDS.
           *
           * ⚠ AND IT NO LONGER CLAIMS THE FULL POPULATION IS BEING RUN. This
           * comment and the message below both said it "runs at the nightly
           * cadence" — an assertion about a run this process cannot observe,
           * and one that was FALSE from 2026-09-04, when the full leg began
           * aborting on a heap limit. A subset that promises the rest is
           * covered elsewhere is the same defect as a subset that reads as a
           * full pass, one sentence along. */
          pend(
            'CAD1H',
            `--quick ran the CUT-FILE SUBSET only: ${hwBad.length} of ${hw.length} file(s) that are ` +
              `actually cut diverge from OpenSCAD` +
              (hwBad.length
                ? ` — ${hwBad.map((c) => c.name.replace('hardware/', '')).slice(0, 6).join(', ')}`
                : '') +
              `.${treeNote} This is NOT the full population and is NOT a pass: the whole live set ` +
              `(${CAD1H_PENDING_BASELINE.population} files at the pinned input) is scored ONLY by a full run, and ` +
              'this run cannot see whether one has succeeded. ' +
              // 🔴 THIS SENTENCE CARRIED THREE DEFECTS AT ONCE AND I WROTE ALL
              // THREE THE SAME DAY (2026-09-04):
              //  · it said "As of 2026-09-05" — a date INHERITED from the ticket
              //    I was answering rather than read off the clock;
              //  · it said the full leg "was ABORTING on a heap limit", which was
              //    true for two days and STOPPED BEING TRUE when the CSG read cap
              //    landed — a full pass has since completed (58 passed, 0 failed);
              //  · and it hardcoded "293 files" for a population that is 303.
              // ⚠ A stale instruction to distrust a number is not harmless: it
              // tells a reader the baselines are UNMEASURED when they have in
              // fact been measured, which spends the same credibility as a false
              // green — in the opposite direction.
              'The full leg ABORTED on a heap limit until 2026-09-04, when an uncapped CSG read was capped; a full ' +
              'pass has completed since. Treat both baselines as UNMEASURED only until a full run is observed to ' +
              'complete — this line used to say the set "runs at the nightly cadence", which asserted a nightly it ' +
              `cannot observe and that was in fact broken. (${src})`
          );
        } else if (!m) {
          fail(
            'CAD1H',
            'SLICER-GATES.md carries no line `CAD1H BASELINE: DIVERGES+ERROR = N`. The count lives in TWO places on ' +
              'purpose: raising it has to cost an edit to the document that is read in review'
          );
        } else if (!mp) {
          fail(
            'CAD1H',
            'SLICER-GATES.md carries no line `CAD1H BASELINE: PENDING = N/POPULATION`. Same reason as the line ' +
              'above, and this one was missing entirely until 2026-09-04 — the PENDING ratchet could be raised in ' +
              'the gate file alone. ⚠ The POPULATION is part of the pinned value now (ceo ruling 2026-09-05): a ' +
              'bare count cannot tell a rate increase from population growth'
          );
        } else if (
          Number(mp[1]) !== CAD1H_PENDING_BASELINE.count ||
          Number(mp[2]) !== CAD1H_PENDING_BASELINE.population
        ) {
          fail(
            'CAD1H',
            `the gate file pins PENDING at ${CAD1H_PENDING_BASELINE.count}/${CAD1H_PENDING_BASELINE.population} ` +
              `and SLICER-GATES.md says ${mp[1]}/${mp[2]} — one was moved without the other, and a baseline that ` +
              'disagrees with its own documentation is not a baseline'
          );
        } else if (Number(m[1]) !== max) {
          fail(
            'CAD1H',
            `the gate file allows ${max} and SLICER-GATES.md says ${m[1]} — one of them was moved without the other, ` +
              'and a baseline that disagrees with its own documentation is not a baseline'
          );
        } else if (hwBad.length > max) {
          fail(
            'CAD1H',
            `WORSE: ${hwBad.length} files emit geometry that is not what OpenSCAD renders, baseline ${max}. ` +
              `New or changed: ${hwBad.map((c) => c.name).slice(0, 6).join(', ')}${hwBad.length > 6 ? ` …+${hwBad.length - 6}` : ''}. ` +
              `${hwSummary} (${src})`
          );
        } else if (hwBad.length < max) {
          fail(
            'CAD1H',
            `RATCHET: only ${hwBad.length} files diverge and the baseline still allows ${max}. Lower it — in the gate ` +
              'file AND in SLICER-GATES.md — or the slack sits there to absorb the next regression in silence. ' +
              `${hwSummary} (${src})`
          );
        } else if (!QUICK && hwPending.length > cad1hPendingAllowed(hw.length)) {
          /* 🔴 THE SECOND RATCHET. A file that stops being decidable is not a
           * file that got better — see CAD1H_PENDING_BASELINE. */
          fail(
            'CAD1H',
            `UNDECIDABLE GREW: ${hwPending.length} of ${hw.length} PENDING, against a pinned RATE of ` +
              `${CAD1H_PENDING_BASELINE.count}/${CAD1H_PENDING_BASELINE.population} which allows ` +
              `${cad1hPendingAllowed(hw.length)} at this population. A file moving out of DIVERGES into PENDING ` +
              'is not progress — we stopped being able to tell. ⚠ THE RATE IS THE BOUND, so this cannot be ' +
              `cleared by the population growing. ${cutSentence}. (${src})`
          );
        } else if (!QUICK && hwPending.length < cad1hPendingAllowed(hw.length)) {
          fail(
            'CAD1H',
            `RATCHET: only ${hwPending.length} of ${hw.length} PENDING and the pinned rate ${CAD1H_PENDING_BASELINE.count}/${CAD1H_PENDING_BASELINE.population} still allows ${cad1hPendingAllowed(hw.length)}. ` +
              'Lower it — here AND in SLICER-GATES.md — or the slack absorbs the next file that goes undecidable. ' +
              `${cutSentence}. (${src})`
          );
        } else if (unpinnedCut.length || clearedCut.length) {
          fail(
            'CAD1H',
            (unpinnedCut.length
              ? `${unpinnedCut.length} CNC CUT FILE(S) ARE UNDECIDABLE AND NOT NAMED: ${unpinnedCut.join(', ')}. ` +
                'Add each to CAD1H_UNDECIDABLE_CUT_FILES with its cause — a cut file we cannot check is a tracked ' +
                'defect, not a row inside a PENDING total. '
              : '') +
              (clearedCut.length
                ? `${clearedCut.length} named undecidable cut file(s) are decidable again and must be REMOVED: ` +
                  `${clearedCut.map((k) => k.file).join(', ')}. `
                : '') +
              `${cutSentence}. (${src})`
          );
        } else if (unknownStricter.length || clearedStricter.length || otherLedger.length) {
          fail('CAD1H', stricterMessage());
        } else if (false) {
          const f = ledgerFindings(true);
          fail(
            'CAD1H',
            `${f.length} STRICTER-LEDGER finding(s) on the hardware leg — a refusal is only SAFE when openscad ` +
              `refuses too, and these do not: ${f.join(' | ')}. ${hwSummary} (${src})`
          );
        } else if (unlistedUndecided.length) {
          // 🔴 THE LIMB THAT CHANGED 2026-08-14, AND WHAT IT STILL FAILS ON.
          // It used to fail on ANY hardware PENDING that was not a missing
          // binary. The three classes in CAD1H_UNDECIDED_KNOWN are not broken
          // checks — each is a comparison with NO REFERENT, measured as such
          // and ruled on — so the limb now fails on exactly the half that was
          // always the point: a PENDING whose reason is NONE of the named
          // classes. `--self-plant cad1-undecided-unlisted` drives this branch.
          fail(
            'CAD1H',
            `${undecidedWhy(unlistedUndecided)} — and its reason is NONE of the ` +
              `${CAD1H_UNDECIDED_KNOWN.length} named, dated and ruled undecidable classes this gate carries ` +
              `(${CAD1H_UNDECIDED_KNOWN.map((k) => k.label).join(', ')}), so it is a check that BROKE, not a class ` +
              `somebody measured. ${hwSummary} (${src})`
          );
        } else {
          // Every hardware PENDING is in a named class — say so, with the
          // per-class counts, so the green cannot read as coverage of them.
          const classCounts = CAD1H_UNDECIDED_KNOWN.map(
            (k) => `${hwUndecided.filter((c) => (c.reason ?? '').includes(k.match)).length} ${k.label}`
          ).join(', ');
          const staleClasses = CAD1H_UNDECIDED_KNOWN.filter(
            (k) => !hwUndecided.some((c) => (c.reason ?? '').includes(k.match))
          );
          pass(
            'CAD1H',
            `${hwSummary}, at the baseline of ${max} (${CAD1H_BASELINE.since}). ${src}. ` +
              // 🔴 THIS LINE USED TO HARDCODE "0 real agreements is the headline" while the SAME
              // STRING interpolated `hwSummary`, which has read "2 REAL (non-empty) agreement(s)"
              // since 93b83a472c. The green would have contradicted itself in one sentence.
              // ⚠ Nobody saw it because CAD1H HAS NOT PASSED SINCE IT BECAME FALSE — a message on
              // an unreachable branch rots with no symptom, and only a reader looking at the source
              // can catch it. The count now comes from the same measurement as the rest of the line.
              /* 🔴 THE CUT-FILE SPLIT RIDES IN THE PASSING MESSAGE, ceo ruling
               * 2026-09-02: *"of the live cut files, N are undecidable and M
               * diverge — that sentence belongs in the gate's output."* It is
               * the population with a physical tail, and a total that hides it
               * is the same shape as a green that hides a PENDING. */
              `${cutSentence}.${treeNote} ` +
              `🔴 NOT A CLEAN RESULT — it is a tracked one, and ${hwSameReal} real agreement(s) is the headline. ` +
              `The ${hwUndecided.length} UNDECIDED are every one inside a named, dated and ruled class ` +
              `(${classCounts}) — PENDING is not agreement, and the count rides in this message so the green ` +
              'cannot read as coverage of them. ' +
              (staleClasses.length
                ? `⚠ ${staleClasses.length} named undecidable class(es) did NOT occur this run: ` +
                  `${staleClasses.map((k) => k.label).join(', ')} — NOT a failure (another lane may legitimately ` +
                  'have changed the files) and NOT nothing: an entry that no longer matches is headroom. '
                : '') +
              'NOT COVERED, said rather than implied: this leg is a COUNT, so one file fixed and another broken at ' +
              'equal count is invisible to it; a real divergence hiding INSIDE one of the ruled undecidable classes ' +
              '(measured: 7 of the 23 overlap files diverge when unioned) stays hidden until unioning is taken off ' +
              'defer; and a file added to hardware/cad/ that refuses where OPENSCAD ALSO emits nothing moves nothing ' +
              "here. ⚠ One that refuses where openscad DOES emit is no longer invisible: it is a fresh unlisted " +
              "STRICTER and fails on this gate's ledger limb"
          );
        }
      }
    }
  }
}

// --- RUN: the Run tab's sender, against a fake grblHAL ---------------------
//
// 🔴 THE PHYSICAL FAILURES, both of which end with a cutter in the work:
//   - a sender that stalls mid-cut leaves a TURNING CUTTER STATIONARY in the
//     material. It burns the edge and on a small cutter it snaps. That is why
//     the transport choice (character counting against a MEASURED buffer) is a
//     safety property and not a performance one.
//   - a sender that misreads the machine's state starts a job on a machine
//     whose position is unknown, or rapids DOWNWARD through the stock because
//     the stored G54 Z belonged to the last job.
//
// 🔴 AND THE SENTENCE THAT MUST TRAVEL WITH EVERY GREEN THIS GATE PRINTS:
// **a green against the fake is a green about THIS LANE'S READING of grblHAL.**
// `web/src/run/fake.ts` was written from grblHAL's C by this lane. It can show
// the sender is self-consistent with that reading; it can never discover the
// reading is wrong. `docs/design-76-run-tab.md` §18 requires the fake's own
// configuration line in this gate's output for exactly that reason — *a green
// whose subject is unnamed is a green nobody can audit* — and the persona list
// below is INSTRUMENTED (see gates/run_fake_probe.mjs), not scanned out of the
// test source, because "written" and "answered" are different claims.
//
// WHY THIS GATE EXISTS AT ALL, given the tests already run: it did not, and the
// tests were not run by anything either. `npm run test:node` is in
// `web/package.json` and NO GATE INVOKED IT — 147 assertions about the one tab
// that talks to a motion controller, watched by nobody. A suite nothing runs is
// a suite that can go red in a commit and stay red.
//
// THREE LIMBS, and each answers a question the other two cannot:
//   A BRANCHES  every branch of the design's table maps to named tests, each of
//               which must EXIST (matched exactly once) and PASS. A missing
//               needle is a FAIL, not a silent loss of coverage — this is the
//               only limb that can see a test being renamed out of its branch.
//   B PLANTS    the sixteen protocol plants are driven THROUGH THE REAL MODULES
//               here, clean and planted, and the two answers must differ. Gate
//               PLANT's row records why a title is not enough: `wrong-drill`
//               announced `PLANTED:` while changing nothing.
//   C SUBJECT   which fake answered, instrumented at `FakeController.onData` /
//               `.write`, with the configuration line the design demands.
//
// 🔴 WHAT PENDS, AND WHY IT IS NOT A PASS. One condition remains, named in
// PENDING_BUDGET.RUN:
//   - `RUN-18` — the streamer WORKER MODULE sustains throughput while its page
//     is hidden (the Run tab is NOT the subject; the spec bypasses it) — ✅
//     MEASURED 2026-08-28.
//     The paragraph that used to stand here named the wrong file twice:
//     first `App.tsx` (a page-level prop CANNOT WORK — `streamer.worker.ts::attach`
//     acquires the port ITSELF from `self.navigator.serial` BY INDEX, and the
//     page never transfers a port object), then "a fake transport INSIDE THE
//     WORKER, in the served product" — a false dichotomy, because a test can
//     build its OWN worker global: `web/e2e/run18/streamer-fake.worker.ts`
//     imports `./install-fake-serial` (the stub) and then the REAL, UNMODIFIED
//     `../../src/run/streamer.worker`. The shipped file is byte-identical; only
//     vite dev ever serves the entry. Measured: hidden/visible ratio 0.771,
//     zero stalls, hidden leg verified (`visibilityState === 'hidden'`, page
//     timers throttled to 3 ticks/2s). Against fake.ts — this lane's model of
//     grblHAL — NOT a machine.
//   - the controller half. NOTHING THIS LANE EMITS HAS BEEN OFFERED TO A BOARD.
//     `gates/controller/` holds a README and no transcript, and has never held
//     one — so this gate does not read a transcript at all, and there is no arm
//     in it that could quietly pass on an absent file.
// Both halves are TRIPWIRED rather than hard-coded: if the e2e test naming
// RUN-18 DISAPPEARS, or a transcript lands in `gates/controller/`, this gate
// goes RED and says the declaration is stale. A declaration that cannot notice
// its own condition changing is how a stale red outlives the thing it warned
// about — in either direction.
{
  const branchProblems = [];
  const notes = [];

  // The design's §18 table, as the gate reads it. `where` is the honest half:
  // `fake` = drivable in node here; `browser-fake` = drivable only in a real
  // browser against the fake — e2e/run18.spec.ts, which skips with a named
  // reason when no X display can be had.
  const RUN_BRANCHES = [
    { id: 'RUN-1', plant: 'overcount', what: 'character counting never exceeds the responder buffer over 5,000 lines', where: 'fake',
      tests: ['RUN-1 — character counting never overruns the fake', 'the allowance is exact: pending + len + 1 must fit', '5,000 lines against a 64-byte buffer never overrun the fake'] },
    { id: 'RUN-2', plant: 'count-status-as-ok', what: 'exactly one reply per line; reports/messages/ALARM are not replies', where: 'fake',
      tests: ['RUN-2 — status reports and messages are not replies', 'only ok and error: are line replies', 'a status report arriving mid-stream decrements nothing'] },
    { id: 'RUN-3', plant: 'keep-going-past-error', what: 'the first error: aborts; nothing further is sent (F7)', where: 'fake',
      tests: ['RUN-3 — the first error: aborts the stream and nothing else is sent', 'the first error: aborts the stream and nothing further is sent'] },
    { id: 'RUN-4', plant: 'utf8-realtime', what: 'realtime bytes go out as ONE byte, not UTF-8', where: 'fake',
      tests: ['RUN-4 — a realtime command goes out as ONE byte', 'every realtime command goes out as exactly one byte', 'the override set runs to 0x9E and 0x98 does not exist'] },
    { id: 'RUN-5', plant: 'assume-zero-wco', what: 'no WCO yet ⇒ the work DRO is a dash and a reason, never 0.000', where: 'fake',
      tests: ['RUN-5 — with no WCO yet, the work DRO is a dash and a reason', 'with no WCO the work DRO is unavailable WITH A REASON'] },
    { id: 'RUN-6', plant: 'double-subtract-wco', what: 'a WPos report already carries the offset — it is not subtracted twice', where: 'fake',
      tests: ['RUN-6 — when the controller reports WPos', 'a WPos report already has the offset applied'] },
    { id: 'RUN-7', plant: 'cancel-while-streaming', what: '0x85 is never emitted outside Jog (R7)', where: 'fake',
      tests: ['R7 — 0x85 outside Jog is refused', '0x85 is refused outside Jog, and 0x9E outside Hold', '0x85 flushes the RX buffer even outside Jog'] },
    { id: 'RUN-8', plant: 'stream-unhomed', what: 'streaming refused with no homing evidence (R1) and while UNTRUSTED (R2)', where: 'fake',
      tests: ['R1 — no homing evidence refuses', 'R2 — untrusted position refuses', 'a fresh connection refuses to start, and says which facts are missing'] },
    { id: 'RUN-9', plant: 'descend-first', what: 'refused when the first Z descends, AND when the comparison cannot be made (F3/R3)', where: 'fake',
      tests: ['R3 — a first move that descends is refused', 'R3 — an unmakeable comparison is a refusal', 'first Z is read off the EMITTED TEXT'] },
    { id: 'RUN-10', plant: 'unlock-optimism', what: '$X on error:46 does not clear the UI alarm state (F6)', where: 'fake',
      tests: ['R9 — $X is refused where grblHAL would refuse it', 'the alarm-on-boot persona: $X answers error:46'] },
    { id: 'RUN-11', plant: 'trust-after-hardlimit', what: 'after $X on alarm 1/3 Start stays refused; after alarm 2 it does not', where: 'fake',
      tests: ['alarm 2 retains position; alarms 1 and 3 lose it', 'an alarm whose position consequence grblHAL does not state', 'a soft reset costs position only if the machine was moving'] },
    { id: 'RUN-12', plant: 'auto-resume', what: 'mid-stream disconnect ⇒ no auto-resume, DRO marked stale (R11)', where: 'fake',
      tests: ['R11 — auto-resume is refused always', 'a silent link is "state unknown", not "the machine stopped"', 'a controller that stops answering stalls the stream rather than completing it'] },
    { id: 'RUN-13', plant: 'ignore-async-alarm', what: 'an ALARM: arriving between replies aborts the stream', where: 'fake',
      tests: ['RUN-13 — an async ALARM between replies aborts', 'an ALARM arriving between line replies aborts the stream'] },
    { id: 'RUN-14', plant: 'swallow-unknown-code', what: 'codes render from the extracted grblHAL tables; an unknown one renders as unknown', where: 'fake',
      tests: ['all 21 grblHAL alarms are carried', 'an unknown alarm or error code is rendered as unknown, never swallowed', 'the error table is partial, and says so'] },
    { id: 'RUN-15', plant: 'accept-anything', what: 'Marlin and grbl-1.1 are refused/degraded per §11; unknown closes the port', where: 'fake',
      tests: ['FW:grblHAL in a full report is the strongest identification', 'a grbl 1.1 banner is degraded to read-only', 'Marlin and silence are both "unknown"', 'the Marlin and grbl-1.1 personas are classified correctly through the real identify()'] },
    { id: 'RUN-16', plant: 'assume-read-is-line', what: 'a line split across two reads parses as one line', where: 'fake',
      tests: ['RUN-16 — a line split across two reads still parses as one line', 'a split falling between CR and LF still yields one line', 'the fake can split every line across reads'] },
    // The only branch whose negative control lives INSIDE its test rather than
    // in a plant registry: `markerProblems()` is run against the real render and
    // against a planted one in the same test. Named here so the difference is
    // visible rather than discovered.
    { id: 'RUN-17', plant: 'same-marker (in-test, not a registry plant)', what: 'prediction and measurement differ WITHOUT colour — fill and shape', where: 'fake',
      tests: ['RUN-17 — the predicted and measured markers differ in fill AND in shape', 'the legend claims passage, not removal'] },
    { id: 'RUN-18', plant: 'timer-pump', what: 'the streamer WORKER MODULE (not the Run tab) sustains throughput while its page is hidden — ✅ measured 2026-08-28 (e2e/run18.spec.ts, test-only worker entry, zero product change): ratio 0.771, zero stalls; against fake.ts, NOT a machine', where: 'browser-fake',
      tests: ['the RUN-18 instrument exists (the hidden-tab measurement is e2e/run18.spec.ts)'] },
  ];

  // The plant column of the design's table, minus the two that are not registry
  // plants. Held here so a plant DISAPPEARING from the module is visible: a
  // check that reads its expectation out of the thing it checks cannot fail.
  const DESIGN_PLANTS = RUN_BRANCHES.map((b) => b.plant).filter((p) => !p.includes('(') && p !== 'timer-pump');

  const webDir = join(ROOT, 'web');
  const logPath = join(ROOT, 'target', 'run-gate-fakes.log');
  let tap = '';
  let registries = null;

  if (!existsSync(join(webDir, 'node_modules'))) {
    // NOT a PENDING. `web/node_modules` is a build step of this lane, not a
    // property of the world — I1 fails for the same absence in a full run and
    // this gate must not be softer about the same missing thing.
    fail('RUN', 'web/node_modules is absent — the Run suite cannot run. `npm ci` in web/ is a build step of this lane, not an environment gap, so this is a failure and not a PENDING');
  } else {
    // ── limb C, part 1: arm the instrument ────────────────────────────────
    try {
      writeFileSync(logPath, '');
    } catch (e) {
      fail('RUN', `could not create the persona log at ${logPath}: ${String(e.message ?? e)}`);
    }

    const suite = spawnSync(
      process.execPath,
      [
        '--import', './tests/register.mjs',
        '--import', selfPlanted('run-persona-instrument') ? './tests/register.mjs' : '../gates/run_fake_probe.mjs',
        '--test', '--test-reporter=tap',
        'tests/run.test.ts', 'tests/run-protocol.test.ts',
      ],
      { cwd: webDir, encoding: 'utf8', timeout: 600_000, env: { ...process.env, RUN_FAKE_LOG: logPath } }
    );
    tap = (suite.stdout ?? '') + (suite.stderr ?? '');

    const probe = spawnSync(
      process.execPath,
      ['--import', './web/tests/register.mjs', 'gates/run_fake_probe.mjs'],
      { cwd: ROOT, encoding: 'utf8', timeout: 300_000 }
    );
    try {
      registries = JSON.parse(probe.stdout.trim().split('\n').at(-1) ?? '');
    } catch {
      branchProblems.push(`the plant probe did not answer (exit ${probe.status}): ${String(probe.stderr ?? '').slice(-200)}`);
    }

    // ── limb A: the suite ran, and every branch resolves to passing tests ──
    const ok = new Map();
    for (const line of tap.split('\n')) {
      const m = /^(not ok|ok) \d+ - (.*)$/.exec(line.trim());
      if (m) ok.set(m[2].trim(), m[1] === 'ok');
    }
    const totals = /^# pass (\d+)$/m.exec(tap);
    const fails = /^# fail (\d+)$/m.exec(tap);

    if (!totals || !fails) {
      // No summary at all means the runner did not run. Loudly not a pass —
      // this is the shape I1's own "no result line" arm exists for.
      branchProblems.push(`the Run suite produced no TAP summary — it did not run (exit ${suite.status}): ${tap.slice(-300)}`);
    } else if (Number(fails[1]) > 0) {
      const red = [...ok].filter(([, v]) => !v).map(([t]) => t);
      branchProblems.push(`${fails[1]} failing test(s) in the Run suite: ${red.slice(0, 4).join(' | ')}`);
    }

    for (const b of RUN_BRANCHES) {
      for (const needle0 of b.tests) {
        const needle = selfPlanted('run-needle-drift') && b.id === 'RUN-9' ? `${needle0} ZZTOP` : needle0;
        const hits = [...ok.keys()].filter((t) => t.includes(needle));
        if (hits.length === 0) {
          branchProblems.push(
            `${b.id}: no test matches ${JSON.stringify(needle)} — the branch has lost its assertion. A renamed test is indistinguishable from a deleted one from inside the suite, and this is the only place that can tell`
          );
        } else if (hits.length > 1) {
          branchProblems.push(`${b.id}: ${JSON.stringify(needle)} matches ${hits.length} tests, so this branch does not name what it asserts on`);
        } else if (!ok.get(hits[0])) {
          branchProblems.push(`${b.id}: FAILING — ${hits[0]}`);
        }
      }
    }

    // ── limb B: the plants still bite, driven through the real modules ─────
    let bitten = 0;
    if (registries) {
      const inModule = registries.protocolPlants ?? [];
      const missing = DESIGN_PLANTS.filter((p) => !inModule.includes(p));
      const extra = inModule.filter((p) => !DESIGN_PLANTS.includes(p));
      if (missing.length) branchProblems.push(`design plant(s) with no entry in PROTOCOL_PLANTS: ${missing.join(', ')} — the control named by the design does not exist in the code`);
      if (extra.length) branchProblems.push(`PROTOCOL_PLANTS carries ${extra.join(', ')}, which no RUN branch consumes — a control nobody runs (gate PLANT's limb 1, one module along)`);

      for (const [name, p] of Object.entries(registries.probes ?? {})) {
        const clean = JSON.stringify(p.clean);
        let planted = JSON.stringify(p.planted);
        if (selfPlanted('run-plant-inert') && name === 'overcount') planted = clean;
        if (clean === planted) {
          branchProblems.push(
            `plant \`${name}\` is INERT: clean and planted both answer ${clean.slice(0, 90)}. Its gate branch is decoration until it bites again — this is the failure gate PLANT was written for, arriving in the Run modules`
          );
        } else bitten++;
      }
      const unprobed = DESIGN_PLANTS.filter((p) => !(p in (registries.probes ?? {})));
      if (unprobed.length) branchProblems.push(`plant(s) with a branch and NO liveness probe here: ${unprobed.join(', ')}`);

      // Every `PLANT <name>` test the suite carries must also be passing —
      // limb A only reaches the ones a branch names.
      for (const p of DESIGN_PLANTS) {
        const t = [...ok.keys()].filter((k) => k.includes(`PLANT ${p}`));
        if (t.length === 0) branchProblems.push(`plant \`${p}\` has no \`PLANT ${p}\` test in the suite`);
        else if (t.some((k) => !ok.get(k))) branchProblems.push(`plant \`${p}\`: its PLANT test is failing`);
      }
    }

    // ── limb C, part 2: name the subject ──────────────────────────────────
    let personas = [];
    let configs = [];
    try {
      const seen = readFileSync(logPath, 'utf8').split('\n').filter((l) => l.trim());
      // 🔴 SORTED, AND THAT IS LOAD-BEARING, NOT COSMETIC (2026-08-14). The log
      // is written in test-COMPLETION order and the suite runs concurrently, so
      // unsorted `configs`/`personas` — and the TRANSPORT line's "first healthy
      // config", there being healthy fakes with BOTH autoExecute values — made
      // RUN's row byte-DIFFERENT between identical runs. SPLNT's DRIVE limb is
      // a difference test over exactly these rows: a row that moves by itself
      // reads as "the plant bit", and a full pass flagged `cad1-verdict-unknown`
      // for moving RUN — a plant that cannot reach it. The SET the suite drives
      // is deterministic; only its order was not.
      configs = [...new Set(seen.map((l) => JSON.parse(l).describe))].sort();
      personas = [...new Set(configs.map((d) => /persona=([\w.-]+)/.exec(d)?.[1]).filter(Boolean))].sort();
    } catch (e) {
      branchProblems.push(`the persona instrument produced nothing readable (${String(e.message ?? e)})`);
    }
    if (personas.length === 0) {
      // 🔴 An empty log and "no fake was driven" are the same file. Only one is
      // safe to report, so this is a failure of the INSTRUMENT and says so.
      branchProblems.push(
        'the persona instrument recorded NOTHING. That is indistinguishable from a suite that drove no fake at all, and the safe reading is that the instrument is dead — check that gates/run_fake_probe.mjs is still --import-ed and still wrapping FakeController.prototype'
      );
    } else if (registries) {
      const never = (registries.personas ?? []).filter((p) => !personas.includes(p));
      if (never.length) {
        branchProblems.push(`persona(s) in the registry that NO test drives: ${never.join(', ')} — a fake configuration nobody exercises is a control that does nothing, and the design names the Marlin and grbl-1.1 ones specifically`);
      }
    }

    notes.push(`TRANSPORT: ${configs.find((c) => c.includes('persona=healthy')) ?? configs[0] ?? '(none)'}`);
    notes.push(`${personas.length} persona(s) DRIVEN (instrumented, not scanned): ${personas.join(', ')}`);
    notes.push(`${bitten}/${DESIGN_PLANTS.length} plants driven clean-and-planted here and observed to still bite`);
    notes.push(`suite: ${totals ? totals[1] : '?'} passed, ${fails ? fails[1] : '?'} failed across web/tests/run.test.ts + run-protocol.test.ts`);

    // ⚠ MEASURED OVER A WORKING COPY, AND THE RUN SAYS SO — the same note CAD1
    // carries for the same reason. `web/src/run/*` and `RunTab.tsx` are live
    // agents' trees on most days; a green that does not name the bytes it was
    // taken over cannot be compared with tomorrow's.
    {
      const h = createHash('sha256');
      for (const f of ['run/protocol.ts', 'run/fake.ts', 'run/transport.ts', 'run/streamer.worker.ts', 'RunTab.tsx']) {
        const p = join(ROOT, 'web/src', f);
        h.update(f).update(existsSync(p) ? readFileSync(p) : Buffer.from('ABSENT'));
      }
      notes.push(`run-src ${h.digest('hex').slice(0, 12)} (the bytes this run measured, working copy — not a commit)`);
    }
  }

  // ── the pendings, and their tripwires — in BOTH directions ─────────────
  const e2eNamesRun18 = (() => {
    const dir = join(ROOT, 'web/e2e');
    if (!existsSync(dir)) return false;
    return readdirSync(dir)
      .filter((f) => f.endsWith('.ts'))
      .some((f) => /test\([^)]*RUN-18/.test(readFileSync(join(dir, f), 'utf8')));
  })();
  const controllerTranscripts = existsSync(join(ROOT, 'gates/controller'))
    ? readdirSync(join(ROOT, 'gates/controller')).filter((f) => f.endsWith('.json'))
    : [];

  /* RUN-18 is MEASURED since 2026-08-28 (web/e2e/run18.spec.ts, test-only
   * worker entry). The tripwire now fires the OTHER way: if the test vanishes
   * or is renamed, this gate's declaration that the branch is measured is
   * stale. (The spec SKIPS with a named reason where no X display exists —
   * the tripwire guards the test's existence, the spec guards the
   * measurement's conditions.) */
  if (!e2eNamesRun18) {
    branchProblems.push('no e2e test names RUN-18 any more, yet this gate declares the branch MEASURED by web/e2e/run18.spec.ts. The declaration is STALE — restore the test or rewrite the branch and the PENDING_BUDGET entry rather than letting a measurement outlive its instrument');
  }
  if (controllerTranscripts.length) {
    branchProblems.push(`gates/controller/ now holds ${controllerTranscripts.length} transcript(s) and this gate still declares the controller half unrunnable. Rewrite the branch: what a transcript proves is CTRL's claim and this gate has never read one`);
  }

  const go = RUN_BRANCHES.filter((b) => b.where === 'fake');
  const browserGo = RUN_BRANCHES.filter((b) => b.where === 'browser-fake');
  if (branchProblems.length) {
    fail('RUN', `${branchProblems.length} problem(s): ${branchProblems.slice(0, 4).join(' | ')}${branchProblems.length > 4 ? ` | …+${branchProblems.length - 4} more` : ''}`);
  } else {
    pend(
      'RUN',
      `${go.length}/${RUN_BRANCHES.length} branches GO against the fake in node (${go.map((b) => b.id).join(' ')}). ` +
        `${browserGo.map((b) => b.id).join(', ')} GO against the fake in a REAL BROWSER (web/e2e/run18.spec.ts — hidden leg verified hidden, timers throttled, ratio 0.771 at the 2026-08-28 measurement, zero stalls; the spec re-measures on every run where an X display can be had). ` +
        `${notes.join('. ')}. ` +
        '🔴 INCOMPLETE for ONE remaining reason, and it is a condition not an opinion: NOTHING THIS LANE EMITS HAS EVER BEEN OFFERED TO A CONTROLLER — gates/controller/ holds a README and no transcript, and this gate reads none. ' +
        '🔴 WHAT A GREEN HERE WOULD NOT SAY: the fake is this lane’s model of grblHAL, written from grblHAL’s source by this lane — and RUN-18’s green is green against that same fake, one star further out (a real browser, a real hidden tab, the real worker module). It proves the I/O-driven pump design survives a hidden tab; it CANNOT discover that our reading of grblHAL is wrong. CTRL and the physical rungs are what prove anything else'
    );
  }
}

// --- CADT: everything under `test:node` that RUN does not drive -------------
//
// 🔴 THE HOLE THIS CLOSES, AND IT IS THE SAME HOLE RUN CLOSED ONE FILE ALONG.
// `web/package.json` carries `test:node`, which runs `tests/*.test.ts`. On
// 2026-08-11 gate RUN started driving TWO of those files — `run.test.ts` and
// `run-protocol.test.ts`, 147 assertions. THE OTHER 27 FILES WERE STILL DRIVEN
// BY NOTHING: the SCAD parser and its import host, the degree trigonometry, the
// mesh/record round trip, the store's schema and collection handling, the menu,
// the preview's stale banner, the model-proposal path, and the no-WebGL
// degradation — 509 assertions measured on the run that wired this gate. A
// suite nobody schedules is not coverage; it is a file that agrees with itself
// whenever somebody remembers to look at it.
//
// ⚠ WHY THIS IS A SEPARATE GATE AND NOT MORE BRANCHES ON RUN. RUN's verdict is
// PENDING by budget — it can never report PASS on this box, because two of its
// branches need a controller and a browser. Folding 509 assertions behind a
// permanent PENDING would make every one of them unable to say GREEN, which is
// the same as not gating them. CADT is fully runnable here and is therefore
// NOT in PENDING_BUDGET: it passes or it fails.
//
// ─────────────────────────────────────────────────────────────────────────────
// HOW BIG THE NAMED-BRANCH LIST IS ALLOWED TO GET, AND WHY IT STOPS HERE
// ─────────────────────────────────────────────────────────────────────────────
//
// RUN names a branch per grblHAL protocol property because each one is its own
// safety property over a CLOSED vocabulary — eighteen of them and the list is
// finished. This suite is three times the size and most of it is not
// safety-bearing: a menu that opens, a picker that sorts, a resizable split.
// Naming all 509 would produce a gate nobody maintains, and a branch list
// nobody maintains rots into a list of renamed tests that all report the same
// green.
//
// So the split is by FAILURE CLASS, not by coverage:
//
//   NAMED BRANCH   the assertion is the only thing standing between a source
//                  file and a WRONG PART THAT LOOKS RIGHT — a rotation in the
//                  wrong angular unit, a construct skipped instead of named, an
//                  import resolved out of the wrong folder, a stale mesh cut as
//                  if it were current, a model's text applied instead of
//                  proposed. Rename one of these tests and the property is
//                  silently unguarded, which is exactly the hole a suite-level
//                  "0 failed" cannot see.
//   THE SUITE      everything else. It must still be RUN and must still be
//                  GREEN — `# fail 0` is a hard condition of this gate — but it
//                  is not named, because the cost of a rename there is a test
//                  that stops existing, not a part that gets cut wrong.
//
// And the file set is DISCOVERED, never enumerated. A gate scoped by a
// hardcoded list goes blind to whatever is added after it was written, which is
// the failure mode this lane has already met twice. `readdirSync` finds the
// files; the only hardcoded names are RUN's two, and this gate goes red if
// EITHER of them stops existing — a stale exclusion silently drops a file back
// out of coverage.
//
// ⚠ WHAT THIS GATE DOES NOT DO. It runs the same modules the browser runs, but
// it runs them in NODE, under `tests/register.mjs`, against fakes. It cannot
// discover that the DOM disagrees with the module (that is I1's job, and I1 is
// red on this box for want of WebGL), and it cannot discover that our reading of
// OpenSCAD is wrong (that is CAD1/CAD1H, against the real binary). A green here
// says the modules are self-consistent with this lane's own model of them.
{
  const cadtProblems = [];
  const cadtNotes = [];
  // Branch-level explanations for a branch that HAS gone red. Kept out of
  // `cadtProblems` so the `slice(0, 4)` below cannot truncate away the sentence
  // that says what the red means and which fix is the wrong one.
  const cadtWhy = [];
  const webDir = join(ROOT, 'web');
  const testsDir = join(webDir, 'tests');

  // The two files gate RUN drives. Hardcoded ON PURPOSE and asserted to exist:
  // an exclusion list that silently stops matching is how a file falls out of
  // BOTH gates while both of them still look complete.
  const RUN_OWNED = ['run.test.ts', 'run-protocol.test.ts'];

  // ── the named branches ─────────────────────────────────────────────────────
  // `tests` are substrings of test titles. Each must match EXACTLY ONE test in
  // the suite and that test must pass. Exactly one, not at least one: a needle
  // that matches two tests does not name what it asserts on, and a needle that
  // matches none is indistinguishable from a deleted assertion when read from
  // inside the suite. That is the whole reason this list exists.
  const CADT_BRANCHES = [
    { id: 'CADT-1', what: 'ANGLES ARE DEGREES — a radian slipped into a rotate() turns the part by 57x and every contour it emits is a real contour',
      tests: [
        'sin and cos in degrees are exact where OpenSCAD is exact',
        'four 90 degree turns return a real part, byte for byte',
        'a rotation too large to reduce is REFUSED, and says why',
      ] },
    { id: 'CADT-2', what: 'AN UNIMPLEMENTED CONSTRUCT IS NAMED AND EMITS NOTHING — a silently skipped construct is a part missing a feature nobody was told about',
      tests: [
        'everything Stage 0 did not implement is STILL named, and still emits nothing',
        'THE SENTINEL IS NOT WEAKENED',
      ] },
    { id: 'CADT-3', what: 'AN UNRESOLVABLE IMPORT IS REFUSED BY NAME — treating a missing library as empty deletes whatever that library contributed to the solid',
      tests: [
        'an import this host cannot resolve is REFUSED BY NAME, never treated as empty',
        'with NO host nothing resolves, and the refusal NAMES THE FILE',
        'a cycle is refused rather than recursed, and the refusal names the chain',
        'a circular include is refused BY NAME and does not hang',
      ] },
    { id: 'CADT-4', what: 'WHICH FOLDER IS MOUNTED DECIDES WHICH PART IS DRAWN — a spec that resolves against the wrong directory produces a different, entirely valid-looking part',
      tests: [
        'which folder is mounted decides which part is drawn, and both are silent about it',
        'a path that climbs out of the picked folder is null, not clamped to the root',
        'a spec resolves against the DIRECTORY OF THE FILE THAT WROTE IT',
      ] },
    { id: 'CADT-5', what: 'use AND include ARE NOT THE SAME IMPORT — swapping them changes the emitted geometry and nothing downstream can tell',
      tests: [
        'gives DIFFERENT geometry',
        '`use` imports modules and functions and NOT variables, and runs no top-level geometry',
      ] },
    { id: 'CADT-6', what: 'A MESH THAT DID NOT VERIFY NEVER REACHES THE STORE — an unaudited solid saved as a drawing is a drawing that gets cut',
      tests: [
        'a model whose mesh audit did not pass is REFUSED, for every planted defect',
        'a refused model never reaches the store',
        'the STORE refuses to write a record that does not verify — the gate is not only in the UI',
      ] },
    { id: 'CADT-7', what: 'A STALE MESH SAYS DO-NOT-CUT — cutting yesterday’s mesh from today’s source is a wrong part with a correct-looking source next to it',
      tests: [
        'an edited source with an unrefreshed mesh reports STALE, and names which half moved',
        'a stale record leads its description with a do-not-cut line',
        'told the mesh is of a previous source, the preview says so on the picture',
      ] },
    { id: 'CADT-8', what: 'A RECORD WHOSE HALVES MOVED DOES NOT OPEN SILENTLY — opening it silently is the same wrong part arriving through the library instead of the editor',
      tests: [
        'a record whose SOURCE moved must not open silently',
        'a record whose MESH moved must not open silently either',
        'a record written by another schema must not open silently',
        'verification reports WHICH half moved, and the two messages differ',
      ] },
    { id: 'CADT-9', what: 'NOTHING TO SECTION IS REFUSED, NOT DRAWN EMPTY — a 2D source or an unparsed one must not present as a clean model with no features',
      tests: [
        'a source with no solid is refused — a 2D shape has nothing to section',
        'nothing understood is reported as nothing drawn, not as a clean empty model',
        'a refused construct stops the picture being trusted, even with sound geometry',
      ] },
    { id: 'CADT-10', what: 'A MODEL\u2019S TEXT APPLIES ONLY THROUGH `mayApply`, AND THE REVIEW SURVIVES THE APPLY — the click that used to make the operator read the cautions is gone (founder 2026-08-11, "Enter sends, reply applies"), so the cautions themselves must still be on screen after the text lands, a BLOCKED reply must neither apply nor vanish, and only `blocked` may stop an apply',
      // 🔴 RE-STATED 2026-08-14 ON A FOUNDER RULING (ceo ticket
      // 2026-08-14-ceo-FOUNDER-cadt10-yes-host-yes-cad1h-defer.md): the old
      // "no application whatever the caller does" world was removed ON PURPOSE
      // (`dcf4adeea6`), and the founder ruled the needles be updated to the
      // `mayApply` contract — guard the operator-reads-cautions risk, not the
      // vanished auto-apply one. The previous red's `why` (do-NOT-re-point)
      // was correct until the decision existed; it is recorded in
      // SLICER-GATES.md's CADT section.
      why:
        'needles re-pointed 2026-08-14 per founder ruling: the risk guarded is now that an applied reply still SHOWS its review ' +
        '(cautions, "the evaluated geometry is IDENTICAL"), that a BLOCKED reply reaches neither the editor nor the void, and that ' +
        'nothing but `blocked` gates the apply',
      tests: [
        'a clean reply applies itself, with no action in between',
        'applying does not throw away the review — it is the only thing left that can warn',
        'a BLOCKED reply does not reach the editor, and does not vanish either',
        'cautions do not stop an apply — only `blocked` does',
        '“the evaluated geometry is IDENTICAL” survives the apply, and is not a grey note',
      ] },
    { id: 'CADT-11', what: 'A PROPOSAL THAT DESCRIBES A DIFFERENT PART SAYS SO — an accepted edit that quietly moved the geometry is a wrong part authored by a model',
      tests: [
        'a clean proposal that describes a DIFFERENT PART is measured and said out loud',
        'a refused construct in the proposal is reported by name and by line',
        'a text change that moves NO geometry says exactly that',
      ] },
    { id: 'CADT-12', what: 'NO ENDPOINT, HOST OR KEY LITERAL SHIPS — a credential in an AGPL tree is published the moment the source offer is honoured',
      tests: [
        'no endpoint, host or key literal reaches the source tree',
        'the shipped defaults are NOTHING — no endpoint, no model, no key, key not remembered',
        'no model-list state ever contains the API key',
      ] },
    { id: 'CADT-13', what: 'A MISSING PICTURE IS REPORTED, NOT DRAWN EMPTY — a viewport that fails to build a renderer and shows an empty scene reads as "there is nothing there"',
      tests: [
        'both viewports BAIL when the renderer cannot be built',
        'the degraded state is REPORTED, and the probes stay absent rather than zeroed',
        'the absence states that nothing was drawn in the picture’s place',
      ] },
    { id: 'CADT-14', what: 'A COLLECTION THIS BUILD CANNOT READ IS NAMED, NEVER DROPPED — a setup restored minus a collection nobody mentioned is a machine set up from a form somebody half-filled',
      tests: [
        'an import names the collections it had to leave behind instead of reporting success',
        'a file exported today carries the collection list and the warning for an older build',
        'a record from an unknown schema version is refused rather than read field-by-field',
      ] },
  ];

  if (!existsSync(join(webDir, 'node_modules'))) {
    // Same reasoning as RUN's arm: `npm ci` in web/ is a build step of this
    // lane, not a property of the world. A gate that pends on its own missing
    // build step reports "could not run" for something it could have run.
    fail('CADT', 'web/node_modules is absent — the CAD suite cannot run. `npm ci` in web/ is a build step of this lane, not an environment gap, so this is a failure and not a PENDING');
  } else if (!existsSync(testsDir)) {
    fail('CADT', 'web/tests/ does not exist — the suite this gate drives is gone, which is not the same as a suite that passes');
  } else {
    const all = readdirSync(testsDir).filter((f) => f.endsWith('.test.ts')).sort();
    for (const r of RUN_OWNED) {
      if (!all.includes(r)) {
        cadtProblems.push(
          `\`${r}\` is excluded here because gate RUN drives it, and it DOES NOT EXIST — the exclusion is stale, so a file is out of this gate's set for a reason that stopped being true. Re-read RUN's spawn list before editing RUN_OWNED`
        );
      }
    }
    let discovered = all.filter((f) => !RUN_OWNED.includes(f));
    if (selfPlanted('cadt-file-blind')) discovered = discovered.filter((f) => f !== 'cad-ask.test.ts');
    if (discovered.length === 0) {
      cadtProblems.push('no test file outside RUN’s two was discovered in web/tests/ — an empty set passes every branch check vacuously, so it is a failure here');
    }

    const suite = spawnSync(
      process.execPath,
      selfPlanted('cadt-summary-blind')
        ? ['--eval', 'process.exit(1)']
        : ['--import', './tests/register.mjs', '--test', '--test-reporter=tap', ...discovered.map((f) => `tests/${f}`)],
      { cwd: webDir, encoding: 'utf8', timeout: 900_000 }
    );
    const tap = (suite.stdout ?? '') + (suite.stderr ?? '');

    const ok = new Map();
    for (const line of tap.split('\n')) {
      const m = /^(not ok|ok) \d+ - (.*)$/.exec(line.trim());
      if (m) ok.set(m[2].trim(), m[1] === 'ok');
    }
    const totals = /^# pass (\d+)$/m.exec(tap);
    const fails = /^# fail (\d+)$/m.exec(tap);

    // ── limb A: the suite RAN, and every assertion in it is green ───────────
    //
    // 🔴 The "no summary" arm is not a formality. A runner that dies before it
    // starts produces zero `not ok` lines, and zero failures read as a clean
    // suite by every check that only counts reds. Absence rendered as a
    // reassuring state — the reason `--self-plant cadt-summary-blind` exists.
    if (!totals || !fails) {
      cadtProblems.push(
        `the CAD suite produced no TAP summary — it did not run (exit ${suite.status}). Zero failing tests and a dead runner are the same output to anything that only counts reds: ${tap.slice(-300) || '(no output at all)'}`
      );
    } else if (Number(fails[1]) > 0) {
      const red = [...ok].filter(([, v]) => !v).map(([t]) => t);
      cadtProblems.push(`${fails[1]} failing test(s) in the CAD suite: ${red.slice(0, 4).map((t) => JSON.stringify(t)).join(' | ')}${red.length > 4 ? ` | …+${red.length - 4} more` : ''}`);
    }

    // ── limb B: every named branch resolves to exactly one passing test ─────
    for (const b of CADT_BRANCHES) {
      const before = cadtProblems.length;
      for (const needle0 of b.tests) {
        const needle = selfPlanted('cadt-needle-drift') && b.id === 'CADT-7' ? `${needle0} ZZTOP` : needle0;
        const hits = [...ok.keys()].filter((t) => t.includes(needle));
        if (hits.length === 0) {
          cadtProblems.push(
            `${b.id}: no test matches ${JSON.stringify(needle)} — the branch has lost its assertion. A renamed test is indistinguishable from a deleted one from inside the suite, and this is the only place that can tell`
          );
        } else if (hits.length > 1) {
          cadtProblems.push(`${b.id}: ${JSON.stringify(needle)} matches ${hits.length} tests, so this branch does not name what it asserts on`);
        } else if (!ok.get(hits[0])) {
          cadtProblems.push(`${b.id}: FAILING — ${JSON.stringify(hits[0])}`);
        }
      }
      if (b.why && cadtProblems.length > before) cadtWhy.push(`${b.id}: ${b.why}`);
    }

    // ── name the subject ───────────────────────────────────────────────────
    //
    // ⚠ MEASURED OVER A WORKING COPY AND THE RUN SAYS SO — the note CAD1 and
    // RUN both carry, for the same reason: `web/src/cad/*` is a live tree on
    // most days and a green that does not name the bytes it was taken over
    // cannot be compared with tomorrow's.
    {
      const h = createHash('sha256');
      const cadDir = join(ROOT, 'web/src/cad');
      const srcFiles = (existsSync(cadDir) ? readdirSync(cadDir).sort() : []).map((f) => `cad/${f}`);
      for (const f of [...srcFiles, 'store.ts', 'Tabs.tsx']) {
        const p = join(ROOT, 'web/src', f);
        h.update(f).update(existsSync(p) && statSync(p).isFile() ? readFileSync(p) : Buffer.from('ABSENT'));
      }
      cadtNotes.push(`cad-src ${h.digest('hex').slice(0, 12)} (the bytes this run measured, working copy — not a commit)`);
    }
    cadtNotes.push(
      `${discovered.length} test file(s) DISCOVERED (not enumerated) under web/tests/, RUN's ${RUN_OWNED.length} excluded: ${discovered.join(' ')}`
    );
    cadtNotes.push(`suite: ${totals ? totals[1] : '?'} passed, ${fails ? fails[1] : '?'} failed`);
    cadtNotes.push(
      `${CADT_BRANCHES.length} NAMED branches over ${CADT_BRANCHES.reduce((n, b) => n + b.tests.length, 0)} needles; ` +
        'the remaining assertions are covered by "the suite is green" and are deliberately NOT named — see the header for the split'
    );
  }

  if (cadtProblems.length) {
    fail(
      'CADT',
      `${cadtProblems.length} problem(s): ${cadtProblems.slice(0, 4).join(' | ')}${cadtProblems.length > 4 ? ` | …+${cadtProblems.length - 4} more` : ''}` +
        (cadtWhy.length ? ` ⚠ ${cadtWhy.join(' ⚠ ')}` : '')
    );
  } else {
    pass(
      'CADT',
      `${CADT_BRANCHES.length}/${CADT_BRANCHES.length} named branches green (${CADT_BRANCHES.map((b) => b.id).join(' ')}). ${cadtNotes.join('. ')}. ` +
        'NOT COVERED: the DOM (I1), and whether our reading of OpenSCAD is right (CAD1/CAD1H). This runs the same modules the browser runs, in node, against this lane’s own fakes'
    );
  }
}

// --- TSC: the committed tree still COMPILES ---------------------------------
//
// 🔴 THE HOLE THIS CLOSES, measured 2026-08-28 on committed code. `a1efde7d92`
// landed three type errors in `web/e2e/run18.spec.ts`. `npm run typecheck`
// failed, `npm run build` therefore failed, and **the full 59-gate suite was
// green over it** — 56 passed, 0 failed, 3 budgeted pendings. No gate in this
// file ran a compiler.
//
// It is worth saying exactly why the two checks that LOOK like they cover this
// do not, because both are correct and both were read as covering it:
//
//   · `web/tests/typecheck-coverage.test.ts` asks the compiler WHICH FILES are
//     in its program and compares that to the files on disk. Its own header
//     says, in the 🔴 NOT ASSERTED block, that it does not assert the project
//     typechecks — deliberately, so a real error produces one red and not two.
//     That "one red" was nobody's.
//   · gate I1 boots the browser suite through Playwright, whose `webServer`
//     runs `vite build`, NOT `npm run build`. That is a DELIBERATE and correct
//     decision (see the comment at `web/playwright.config.ts:159`): chaining
//     the typecheck there made one lane's in-flight type error a precondition
//     for another lane's suite, ~40 minutes lost across four attempts, and two
//     agents independently wrote the same bypass. esbuild strips types without
//     checking them, so a bundle builds green over code that does not compile.
//
// ⚠ SO THIS GATE IS NOT "PUT THE TYPECHECK BACK IN THE E2E PATH". It is a
// SEPARATE gate, on the gate runner's own schedule, which is the one place a
// red costs the lane that owns the file rather than the lane that ran the
// suite. The physical failure is one step removed and real: a tree that does
// not compile cannot be built, so the browser host of a two-host tool cannot
// ship — and K3/I1's whole job is that the browser and the CLI emit the same
// bytes. A host that cannot be built cannot be compared.
//
// Three limbs:
//
//   A DOOR    the configs this gate compiles are EXACTLY the configs
//             `web/package.json`'s `typecheck` script names. A gate that runs
//             a different compiler invocation than the command people type is
//             green about a door nobody uses — this lane's most-repeated
//             defect (`DOOR`, `HOST`, `FLAG`) arriving at the build.
//   B CLEAN   every one of those configs reports zero diagnostics.
//   C RAN     every one of those runs produced POSITIVE EVIDENCE that a
//             compiler read a non-trivial program — `--extendedDiagnostics`
//             prints `Files: N` on success as well as on failure. A silent
//             exit 0 and a compiler that never started are the same output to
//             anything that only reads the exit code, which is the shape of
//             every other "absence rendered as a reassuring state" in this
//             file.
//
// NEGATIVE CONTROLS, one per limb that can carry one:
//   `--self-plant tsc-error-blind`  writes a REAL type error into a REAL file
//        inside `web/src` — in the program of BOTH configs — and requires TSC
//        to go red naming it. It plants the defect, not the message.
//        🔴 It writes to the shared tree. The file is removed in a `finally`,
//        is removed again before any write in case a killed run left one, and
//        the block FAILS THE GATE if it is still there afterwards. It lives
//        for the ~10s of this block and no other gate reads `web/src/*.ts`
//        between here and the removal (I1's `vite build` is 900 lines below).
//   `--self-plant tsc-runner-blind`  replaces the compiler with a process that
//        exits 0 saying nothing — TSC must report "it did not run" rather than
//        reading no diagnostics as a clean tree. This is limb C's control and
//        the reason limb C exists.
{
  const webDir = join(ROOT, 'web');
  const problems = [];
  const notes = [];

  // Non-vacuity floor. `tsconfig.browser.json` covers `src` only and still
  // pulls the lib + @types files, so both configs are in the hundreds; 50 is
  // a floor that a truncated or mis-rooted program cannot clear, not an
  // assertion about the size of the tree.
  const FILE_FLOOR = 50;

  const plantPath = join(webDir, 'src', '__tsc_selfplant__.ts');
  const PLANT_SRC =
    '// Written by gate TSC under `--self-plant tsc-error-blind`, removed in its finally.\n' +
    'export const tscSelfPlant: number = "this is not a number";\n';

  // ── limb A: the door ─────────────────────────────────────────────────────
  //
  // Parsed from the script, never hardcoded beside it: a list that agrees with
  // package.json because somebody kept them in step is a list that stops
  // agreeing the day nobody does.
  let configs = [];
  const pkgPath = join(webDir, 'package.json');
  if (!existsSync(pkgPath)) {
    problems.push('web/package.json is missing — the script this gate mirrors does not exist');
  } else {
    const script = JSON.parse(readFileSync(pkgPath, 'utf8')).scripts?.typecheck;
    if (typeof script !== 'string') {
      problems.push(
        'web/package.json has no `typecheck` script — this gate exists to run the command people type, and there is no longer one to run'
      );
    } else {
      configs = [...script.matchAll(/-p\s+(\S+)/g)].map((m) => m[1]);
      if (configs.length === 0) {
        problems.push(`the \`typecheck\` script names no \`-p <config>\`: ${JSON.stringify(script)}`);
      }
      if (!/--noEmit/.test(script)) {
        problems.push(
          `the \`typecheck\` script no longer passes --noEmit: ${JSON.stringify(script)} — this gate would then be measuring a build, and its greens would not be about the command it claims to mirror`
        );
      }
      notes.push(`door: ${configs.length} config(s) read from package.json \`typecheck\` — ${configs.join(' ')}`);
    }
  }

  if (!existsSync(join(webDir, 'node_modules', 'typescript', 'bin', 'tsc'))) {
    // CADT's and RUN's reasoning, unchanged: `npm ci` in web/ is a build step
    // of this lane, not a property of the world, so this is a FAIL and not a
    // PENDING. A gate that pends on its own missing build step reports "could
    // not run" for something it could have run.
    problems.push(
      'web/node_modules/typescript is absent — the compiler this gate drives is not installed. `npm ci` in web/ is a build step of this lane, not an environment gap, so this is a failure and not a PENDING'
    );
    configs = [];
  }

  const planted = selfPlanted('tsc-error-blind');
  try {
    if (planted) {
      rmSync(plantPath, { force: true });
      writeFileSync(plantPath, PLANT_SRC);
    }

    for (const cfg of configs) {
      if (!existsSync(join(webDir, cfg))) {
        problems.push(`\`${cfg}\` is named by the \`typecheck\` script and does not exist — the script cannot be the command it claims to be`);
        continue;
      }

      const run = selfPlanted('tsc-runner-blind')
        ? spawnSync(process.execPath, ['--eval', 'process.exit(0)'], { cwd: webDir, encoding: 'utf8', timeout: 600_000 })
        : spawnSync(
            process.execPath,
            [join(webDir, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', cfg, '--noEmit', '--pretty', 'false', '--extendedDiagnostics'],
            { cwd: webDir, encoding: 'utf8', timeout: 600_000 }
          );
      const out = (run.stdout ?? '') + (run.stderr ?? '');

      // ── limb C: it RAN, over a non-trivial program ───────────────────────
      const files = /^Files:\s+(\d+)\s*$/m.exec(out);
      if (!files) {
        problems.push(
          `\`${cfg}\`: the compiler produced no \`Files:\` line — it did not run (exit ${run.status}). A silent exit and a clean tree are the same thing to anything that only reads the exit code: ${out.slice(-300) || '(no output at all)'}`
        );
        continue;
      }
      if (Number(files[1]) < FILE_FLOOR) {
        problems.push(
          `\`${cfg}\`: the compiler read ${files[1]} file(s), below the floor of ${FILE_FLOOR} — a program this small is a mis-rooted or truncated config, and its green is about almost nothing`
        );
      }

      // ── limb B: it is CLEAN ──────────────────────────────────────────────
      const diags = out
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => /^\S+\(\d+,\d+\):\s+error TS\d+:/.test(l) || /^error TS\d+:/.test(l));
      if (diags.length) {
        problems.push(
          `\`${cfg}\`: ${diags.length} type error(s) — ${diags.slice(0, 3).join(' | ')}${diags.length > 3 ? ` | …+${diags.length - 3} more` : ''}`
        );
      } else if (run.status !== 0) {
        // Exit non-zero with nothing this parser recognises: a compiler that
        // refused rather than disagreed. Named, never treated as clean.
        problems.push(
          `\`${cfg}\`: tsc exited ${run.status} and emitted no diagnostic this gate can parse — a refusal is not a pass: ${out.slice(-300)}`
        );
      } else {
        notes.push(`${cfg}: clean over ${files[1]} files`);
      }
    }
  } finally {
    if (planted) {
      rmSync(plantPath, { force: true });
      if (existsSync(plantPath)) {
        problems.push(
          `🔴 the planted file ${plantPath} could NOT be removed — it is in a shared tree and will break every other lane's typecheck until it is deleted by hand`
        );
      }
    }
  }

  if (problems.length) {
    fail('TSC', `${problems.length} problem(s): ${problems.slice(0, 4).join(' | ')}${problems.length > 4 ? ` | …+${problems.length - 4} more` : ''}`);
  } else {
    pass(
      'TSC',
      notes.join('. ') +
        '. NOT COVERED: whether the code is CORRECT (every other gate), and the .mjs/.js files \u2014 `checkJs` is off, so they are read and not checked'
    );
  }
}

// --- HOST: the two hosts' OPENING DEFAULTS ----------------------------------
//
// 🔴 THE HOLE THIS CLOSES, measured three ways in `158658175e`. The browser
// opens with the probe OFF (`App.tsx`: `probeEnabled ?? false`) and the CLI
// opens with it ON (`core/src/fixtures.rs::machine()`: `probe_enabled: true`),
// so `job plate` exits 0 with four `G38.2` moves through one host and exits 1
// with ZERO bytes through the other — same core, same job, same day.
//
// AND NO GATE COULD SEE IT:
//   · `K3` compares the CORE — it hashes the wasm's baked-in digest against the
//     CLI's. Both hosts agree on the core and DISAGREE ON THE MACHINE THEY HAND
//     IT, which is a difference K3 is structurally unable to express.
//   · `I1` compares one program the two hosts emit — for a job it drives with
//     the SAME config on both sides, which is exactly the substitution that
//     makes a host-default difference invisible.
//   · `PROBE` and `RPRB` are green because they drive the CLI, whose default has
//     the probe on. A gate that only ever exercises one host cannot report that
//     the other host opens somewhere else.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS GATE ASSERTS, AND — MORE IMPORTANTLY — WHAT IT REFUSES TO ASSERT
// ─────────────────────────────────────────────────────────────────────────────
//
// 🔴 IT DOES NOT ASSERT THAT THE DEFAULTS ARE EQUAL, and that is the whole
// design. They may legitimately differ: the CLI's `job <fixture>` is a reference
// setup this crate wrote, with a machine and a plate declared; the browser opens
// before anybody has described a machine at all. Demanding equality would demand
// a change nobody has ruled on — whether the app default is wrong or the
// fourteen e2e expectations are — and that decision belongs to whoever owns the
// app and the suite. A gate that forces an unruled decision gets reverted, and a
// reverted gate guards nothing.
//
// It asserts instead that **the divergence is DECLARED**: every field on which
// the two hosts' opening states hand the core something different is in
// `DECLARED_HOST_DIVERGENCE` below with a reason, and every field in that list
// still diverges. Undeclared divergence is red; a listed field that has stopped
// diverging is red too, because a stale exemption reads exactly like a live one
// and this lane has found two of those today.
//
// ⚠ NOT "THE LITERALS DIFFER" — the comparison is on the EMITTED PROGRAM.
// Each field is sent to the CLI ALONE, at the browser's opening value, and the
// run is compared against the CLI's own opening run: exit code, stdout AND
// stderr. Reading two source files and diffing the numbers would tell you the
// literals differ and nothing about whether that reaches a cutter — this lane's
// standing rule is to assert on the emitted program, and a divergence that
// changes only a WARNING is still a divergence the operator sees, so stderr is
// in the comparison and not thrown away.
//
// ⚠ AND AN AGREEMENT IS ONLY WORTH SOMETHING IF THE FIXTURE COULD HAVE TOLD.
// "Same program" has two causes — the two hosts agree, or the field does nothing
// here — and only one of them is a pass. So every agreeing field is additionally
// driven at OTHER values until one of them moves the run. A field no value can
// move is reported as INERT and FAILS: it is a setting that reads as configured
// and is consumed by nothing, which is gate `G11`'s whole class arriving through
// a host instead of through the core.
//
// ⚠ SCOPE, said rather than implied. The CLI side here is the six `job`
// fixtures. Those are the only jobs with a CLI-side opening state to compare
// against — `import` has no default drawing — and the fixture machine is shared
// by both paths (`fixtures::machine()`), which limb D checks rather than
// assumes. What is NOT covered: the flags (`--collet`, `--machine-x`, …), which
// are a caller's declaration and not a default; `nest`; and anything about
// WHICH default is right, which is not this gate's question.
{
  const hostProblems = [];
  const hostNotes = [];

  // ── the declared divergences ───────────────────────────────────────────────
  //
  // ⚠ ADDING AN ENTRY HERE IS A DECISION, NOT A CLEANUP, in exactly the sense
  // `PENDING_BUDGET` means it. It says "the two hosts open differently on this
  // field ON PURPOSE" — so say who decided, and what the operator sees when the
  // two answers differ. `fixtures` is the set measured when the entry was
  // written; the gate reports a change to it and fails only if the field stops
  // diverging altogether.
  //
  // 🔴 FOUNDER RULED 2026-08-14 (ceo ticket
  // 2026-08-14-ceo-FOUNDER-cadt10-yes-host-yes-cad1h-defer.md): KEEP ALL FIVE
  // divergences as-is — declared + safe-direction is the correct end state; do
  // NOT equalise. So this table is the settled end state, not a list awaiting a
  // decision, and an entry leaving it is now a change AWAY from a ruling.
  const DECLARED_HOST_DIVERGENCE = {
    'machine.probe_enabled': {
      fixtures: ['plate', 'pocket', 'socket', 'multi-tool', 'clamped', 'two-part'],
      why:
        'THE ONE FROM 158658175e. The browser opens `false` (App.tsx, 2026-08-09, deliberate and reasoned: an ' +
        'undeclared plate must not silently zero the datum, so the thing that REQUIRES a thickness must not be ' +
        'defaulted on either); the CLI fixtures open `true` with a declared 1.6mm plate, because a reference job ' +
        'needs something to probe against. On `plate` — which is multi-tool, so a tool change inserts a Z ' +
        're-reference — the browser default makes the core REFUSE with zero bytes. 🔴 UNRESOLVED, AND NOT THIS ' +
        'GATE\u2019S TO RESOLVE: whether the app default or the fourteen e2e `runnable` expectations are the wrong ' +
        'half is a decision for whoever owns the app and the suite. This entry says it is KNOWN, not that it is fine',
    },
    tool_ids: {
      fixtures: ['plate', 'pocket', 'socket', 'multi-tool', 'clamped', 'two-part'],
      why:
        'the browser opens with ONE cutter pre-selected (`End Mill - Down-cut 6mm 2F`); a fixture assigns a tool ' +
        'PER OPERATION in Rust — `plate` engraves its part number with a 3.175mm cutter and profiles with the 6mm ' +
        'one. So the browser\u2019s opening set is not a subset of what the fixtures use, and it reaches the emitted ' +
        'program: on `plate` the spindle word changes S18000 -> S24000 and the drill feed F3600 -> F4800, and on ' +
        '`pocket` the single 6mm cutter is REFUSED outright (0 bytes) because it does not fit the pocket. ' +
        '⚠ This is not gate DOOR\u2019s question — DOOR asks whether `tool_id` and `tool_ids` agree with each other; ' +
        'this asks whether the two HOSTS start from the same cutters, and they do not',
    },
    clamps: {
      fixtures: ['clamped'],
      why:
        'the browser opens with NO workholding declared (`[]`) and the `clamped` fixture declares a pressure bar. ' +
        'It reaches the report rather than the G-code: sending `[]` takes the hold-down check from an answer ' +
        '("workpiece edge under a clamp footprint, y-min 80/600mm …") to `hold-down PENDING (this is NOT a pass): ' +
        'NO WORK HOLDING IS DECLARED`. 🔴 The safe direction, and deliberately so — nothing declared is not the ' +
        'same fact as checked-and-held — but it is still the two hosts opening in different states, and the ' +
        'browser operator sees a PENDING where the CLI operator sees a checked clamp',
    },
    'op.entry': {
      fixtures: ['plate'],
      why:
        '🔴 THE VALUE AGREES AND THE FIELD STILL DIVERGES. `OperationParams::default().entry` is ' +
        '`EntryMode::Ramp` and the browser opens on `Ramp`; what diverges is the BREADTH. The browser sends ONE ' +
        '`op` block for the WHOLE job, so `Ramp` reaches operations a fixture built with their own params — ' +
        '`plate`\u2019s engraved part-number marks, which plunge — and the program goes 11708B -> 12588B as those ' +
        'marks acquire ramping moves. ⚠ Read this before "fixing" it: comparing the two literals would have ' +
        'called this EQUAL, which is why this gate compares programs and not numbers. Only `plate` marks, so only ' +
        '`plate` can show it',
    },
    'op.depth_per_pass_mm': {
      fixtures: ['plate', 'pocket'],
      why:
        '`op.entry`\u2019s divergence one field along, and it is the more legible of the two. The browser\u2019s 4mm is ' +
        'broadcast to the engraving ops, which the fixture built at 0.4mm; the core clamps each one back down and ' +
        'says so — eleven `depth per pass reduced from 4.00 to 1.59mm` notes on `plate` that the CLI operator ' +
        'never sees. 🔴 THE G-CODE IS BYTE-IDENTICAL; only the report moves. A stdout-only comparison read ' +
        'this as agreement on this gate\u2019s own first pass, which is why stderr is in the comparison',
    },
  };

  // ── liveness witnesses ─────────────────────────────────────────────────────
  //
  // Values used ONLY to prove a fixture could have told the browser's value from
  // some other value. The automatic ladder (flip a bool, halve/double/bump a
  // number) cannot construct an alternative for an enum or an empty list, and a
  // field whose alternatives are all rejected would otherwise read INERT — a
  // harness fault wearing a finding's face.
  //
  // 🔴 A witness may never be used to decide AGREES vs DIVERGES. That verdict
  // comes from the browser's own value and nothing else; these only answer
  // "could this fixture have noticed at all".
  const LIVENESS_WITNESS = {
    material: ['Aluminium'], // ⚠ NOT MDF — Plywood and MDF give byte-identical programs for a 6mm cutter
    'op.entry': ['Plunge'],
    'op.direction': ['Conventional'],
    'op.dogbone': ['None'],
    clamps: [[{ name: 'witness', x: 0, y: 0, w: 80, h: 40, height_mm: 30, rotation_deg: 0 }]],
    tool_ids: [['End Mill - Up-cut 3.175mm 2F']],
    drawing_offset: [[10, 10]],
  };

  // ── the conditional keys `App.tsx` may or may not send ─────────────────────
  //
  // The config object carries five `...(cond ? A : B)` spreads. Which branch the
  // OPENING state takes cannot be decided by reading the object — it depends on
  // state this gate does not evaluate — so each is declared here with the branch
  // it opens on, and the CONDITION IS HASHED. Change the condition and this goes
  // red, which is the point: a condition change can flip a key from absent to
  // present, and an absent key is the browser agreeing with the CLI by saying
  // nothing at all.
  //
  // ⚠ THIS IS A TEXT GUARD AND IT PROVES "UNCHANGED", NEVER "TRUE". It cannot
  // observe React state. It is here because the alternative is to assume the
  // opening branch silently, and an assumption that is never restated is the one
  // nobody re-checks.
  const CONDITIONAL_KEYS = {
    '6cbfa5a9': { keys: ['machine.touch_plate_mm'], branch: 'then', why: 'touchPlateMm opens `\'\'` — blank is NOT DECLARED and the key is OMITTED, which is the `Option::None` the core refuses on. Sending `0` would be a measured "no plate", which is a different fact and the one that runs' },
    '0d936558': { keys: ['machine.spoilboard'], branch: 'else', why: 'no board is declared at opening, so the key is absent and the core reports the position limb UNCHECKED. A default board would be an over-declaration, which is the direction that reaches the machine frame' },
    'd2ad79c7': { keys: ['drawing_offset'], branch: 'else', why: 'no drawings at opening, so the JOB-level offset IS sent — the one spread whose opening branch ADDS a key rather than dropping one, and the reason this list records a branch instead of assuming absence' },
    '0747e988': { keys: ['extra_tools'], branch: 'else', why: 'the user has added no tools of their own at opening' },
    '2d853158': { keys: ['workpiece_edge_tolerance_mm'], branch: 'else', why: 'the workpiece-edge switch opens off, and the tolerance is a stored preference the core only reads when the switch is on' },
  };

  // ── A. read the browser's opening JobConfig out of App.tsx ─────────────────
  const APP_PATH = join(ROOT, 'web/src/App.tsx');
  const STORE_PATH = join(ROOT, 'web/src/store/cncStore.ts');
  const unresolved = [];
  let browserCfg = null;
  let spreads = [];
  let appDigest = 'ABSENT';
  let storeDigest = 'ABSENT';

  // A JS scanner that keeps strings and drops comments. The config object is
  // ~150 lines of which most is commentary containing braces, quotes and JSON
  // examples, so a brace match over the raw text lands anywhere at all.
  const stripJs = (src) => {
    let out = '';
    let mode = 'code';
    let quote = '';
    for (let i = 0; i < src.length; ) {
      const c = src[i];
      const d = src[i + 1];
      if (mode === 'code') {
        if (c === '/' && d === '/') { mode = 'line'; i += 2; continue; }
        if (c === '/' && d === '*') { mode = 'block'; i += 2; continue; }
        if (c === '"' || c === "'" || c === '`') { quote = c; mode = 'str'; out += c; i++; continue; }
        out += c; i++; continue;
      }
      if (mode === 'line') { if (c === '\n') { mode = 'code'; out += c; } i++; continue; }
      if (mode === 'block') { if (c === '*' && d === '/') { mode = 'code'; i += 2; } else { if (c === '\n') out += c; i++; } continue; }
      if (c === '\\') { out += c + (d ?? ''); i += 2; continue; }
      out += c;
      if (c === quote) mode = 'code';
      i++;
    }
    return out;
  };

  /** The balanced `{…}` (or `[…]`, `(…)`) starting at `from`, string-aware. */
  const balanced = (s, from) => {
    const open = s[from];
    const close = { '{': '}', '[': ']', '(': ')' }[open];
    let depth = 0;
    let q = '';
    for (let i = from; i < s.length; i++) {
      const c = s[i];
      if (q) { if (c === '\\') i++; else if (c === q) q = ''; continue; }
      if (c === '"' || c === "'" || c === '`') { q = c; continue; }
      if (c === '{' || c === '[' || c === '(') depth++;
      else if (c === '}' || c === ']' || c === ')') { depth--; if (depth === 0) return s.slice(from, i + 1); }
    }
    return null;
  };

  /** Split an object/array body on TOP-LEVEL commas, string- and nesting-aware. */
  const topSplit = (body) => {
    const parts = [];
    let depth = 0;
    let q = '';
    let start = 0;
    for (let i = 0; i < body.length; i++) {
      const c = body[i];
      if (q) { if (c === '\\') i++; else if (c === q) q = ''; continue; }
      if (c === '"' || c === "'" || c === '`') { q = c; continue; }
      if (c === '{' || c === '[' || c === '(') depth++;
      else if (c === '}' || c === ']' || c === ')') depth--;
      else if (c === ',' && depth === 0) { parts.push(body.slice(start, i)); start = i + 1; }
    }
    parts.push(body.slice(start));
    return parts.map((p) => p.trim()).filter((p) => p.length);
  };

  if (!existsSync(APP_PATH)) {
    hostProblems.push('web/src/App.tsx does not exist — the browser host this gate compares against is gone, which is not the same as two hosts that agree');
  } else {
    const raw = readFileSync(APP_PATH, 'utf8');
    appDigest = createHash('sha256').update(raw).digest('hex').slice(0, 12);
    const src = stripJs(raw);

    // opening values of every `useState`/`const` the config object can name.
    const openingOf = new Map();
    for (const m of src.matchAll(/\bconst\s+\[\s*([A-Za-z_$][\w$]*)\s*,[^\]]*\]\s*=\s*useState\s*(?:<[^>]*>)?\s*\(/g)) {
      const par = balanced(src, src.indexOf('(', m.index + m[0].length - 1));
      if (par) openingOf.set(m[1], par.slice(1, -1).trim());
    }
    for (const m of src.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]*)?=\s*([^;]*);/g)) {
      if (!openingOf.has(m[1])) openingOf.set(m[1], m[2].trim());
    }

    // 2026-08-20 the Zustand migration (e8f19e24d6 et al) moved the opening
    // values out of App.tsx's `useState(...)` calls into
    // `web/src/store/cncStore.ts`'s `create<CncStore>((set) => ({ … }))`
    // object, and App.tsx now destructures `useCncStore()`. An extractor that
    // reads only App.tsx sees every config key as ABSENT — and an absent
    // `probe_enabled` is exactly the difference between a refused `job plate`
    // and an emitted one (measured: 38 problems, including the anchor limb
    // reporting exit 0 where exit 1 was the recorded truth). The store uses
    // the same `R.x ?? <default>` idiom, so the same passes work; they run
    // here only for keys App.tsx did NOT provide (App.tsx stays authoritative
    // for what it still declares).
    if (!existsSync(STORE_PATH)) {
      hostProblems.push('web/src/store/cncStore.ts does not exist — since the 2026-08-20 Zustand migration the browser\'s opening defaults live there, and an extraction that cannot see the store reads every config key as absent, which emits jobs the browser refuses');
    } else {
      const storeRaw = readFileSync(STORE_PATH, 'utf8');
      storeDigest = createHash('sha256').update(storeRaw).digest('hex').slice(0, 12);
      const storeSrc = stripJs(storeRaw);
      // Module-level `const X = …;` (DEFAULT_TRAVEL_MM and friends).
      for (const m of storeSrc.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]*)?=\s*([^;]*);/g)) {
        if (!openingOf.has(m[1])) openingOf.set(m[1], m[2].trim());
      }
      // Top-level `key: expr` properties of the `create<CncStore>((set) => ({
      // … }))` object. Action properties (`name: (v) => set(…)`) are skipped:
      // they are functions, not opening values.
      const cm = /create\s*(?:<[^>]*>)?\s*\(\s*\([^)]*\)\s*=>\s*\(\s*\{/.exec(storeSrc);
      if (!cm) {
        hostProblems.push('cncStore.ts no longer opens with `create<…>((set) => ({` — the store extraction cannot find the opening-values object, and every config key reads as absent');
      } else {
        const obj = balanced(storeSrc, storeSrc.indexOf('{', cm.index + cm[0].length - 1));
        if (!obj) {
          hostProblems.push('cncStore.ts store object does not balance — the store extraction cannot read the opening values');
        } else {
          for (const prop of topSplit(obj.slice(1, -1))) {
            const pm = /^([A-Za-z_$][\w$]*)\s*:\s*([\s\S]*)$/.exec(prop);
            if (!pm) continue;
            if (pm[2].includes('=>')) continue;
            if (!openingOf.has(pm[1])) openingOf.set(pm[1], pm[2].trim());
          }
        }
      }
    }

    const NOTHING = Symbol('unresolved');
    /** Resolve a source expression to the value the page OPENS with. */
    const evalOpening = (expr, depth = 0) => {
      let e = expr.trim();
      if (depth > 6) return NOTHING;
      // `X ?? Y ?? Z` — the page opens on the LAST arm when nothing is restored.
      const arms = topSplitNullish(e);
      if (arms.length > 1) return evalOpening(arms[arms.length - 1], depth + 1);
      // A trailing TypeScript assertion. `[^,]*$` was wrong and this is where it
      // showed: the one assertion in the object is `as [number, number]`, whose
      // TYPE contains a comma, so the strip did not fire and the value read as
      // unresolvable. Skipped entirely when the expression IS a string, so a
      // literal containing " as " is not truncated.
      if (!/^['"`]/.test(e)) e = e.replace(/\s+as\s+[\s\S]*$/, '').trim();
      while (e.startsWith('(') && balanced(e, 0) === e) e = e.slice(1, -1).trim();
      if (/^-?\d+(\.\d+)?$/.test(e)) return Number(e);
      if (e === 'true') return true;
      if (e === 'false') return false;
      if (e === 'null') return null;
      if (/^'([^'\\]*)'$/.test(e) || /^"([^"\\]*)"$/.test(e)) return e.slice(1, -1);
      if (e.startsWith('[')) {
        const b = balanced(e, 0);
        if (b !== e) return NOTHING;
        const items = topSplit(b.slice(1, -1)).map((x) => evalOpening(x, depth + 1));
        return items.some((x) => x === NOTHING) ? NOTHING : items;
      }
      if (e.startsWith('{')) {
        const b = balanced(e, 0);
        if (b !== e) return NOTHING;
        return parseObject(b, depth + 1);
      }
      // `CONST[0]`
      const idx = /^([A-Za-z_$][\w$]*)\[(\d+)\]$/.exec(e);
      if (idx && openingOf.has(idx[1])) {
        const arr = evalOpening(openingOf.get(idx[1]), depth + 1);
        return Array.isArray(arr) && arr.length > Number(idx[2]) ? arr[Number(idx[2])] : NOTHING;
      }
      if (/^[A-Za-z_$][\w$]*$/.test(e) && openingOf.has(e)) return evalOpening(openingOf.get(e), depth + 1);
      return NOTHING;
    };

    /** Split on top-level `??`, which is how every default in this file is written. */
    function topSplitNullish(s) {
      const parts = [];
      let depth = 0;
      let q = '';
      let start = 0;
      for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (q) { if (c === '\\') i++; else if (c === q) q = ''; continue; }
        if (c === '"' || c === "'" || c === '`') { q = c; continue; }
        if (c === '{' || c === '[' || c === '(') depth++;
        else if (c === '}' || c === ']' || c === ')') depth--;
        else if (c === '?' && s[i + 1] === '?' && depth === 0) { parts.push(s.slice(start, i)); start = i + 2; i++; }
      }
      parts.push(s.slice(start));
      return parts.map((p) => p.trim());
    }

    /** `...( cond ? A : B )` → [condText, A, B], or null. */
    const splitTernary = (spread) => {
      const inner = balanced(spread, spread.indexOf('('));
      if (!inner) return null;
      const body = inner.slice(1, -1);
      let depth = 0;
      let q = '';
      let qm = -1;
      for (let i = 0; i < body.length; i++) {
        const c = body[i];
        if (q) { if (c === '\\') i++; else if (c === q) q = ''; continue; }
        if (c === '"' || c === "'" || c === '`') { q = c; continue; }
        if (c === '{' || c === '[' || c === '(') depth++;
        else if (c === '}' || c === ']' || c === ')') depth--;
        else if (depth === 0 && c === '?' && body[i + 1] !== '?' && body[i + 1] !== '.') { qm = i; break; }
      }
      if (qm < 0) return null;
      depth = 0; q = '';
      for (let i = qm + 1; i < body.length; i++) {
        const c = body[i];
        if (q) { if (c === '\\') i++; else if (c === q) q = ''; continue; }
        if (c === '"' || c === "'" || c === '`') { q = c; continue; }
        if (c === '{' || c === '[' || c === '(') depth++;
        else if (c === '}' || c === ']' || c === ')') depth--;
        else if (depth === 0 && c === ':') {
          return [body.slice(0, qm).trim(), body.slice(qm + 1, i).trim(), body.slice(i + 1).trim()];
        }
      }
      return null;
    };

    /** Parse one `{…}` object literal into the values the page opens with. */
    function parseObject(text, depth = 0, prefix = '') {
      const out = {};
      for (const entry of topSplit(text.slice(1, -1))) {
        if (entry.startsWith('...')) {
          const t = splitTernary(entry);
          const norm = entry.replace(/\s+/g, ' ');
          const hash = createHash('sha256').update(norm).digest('hex').slice(0, 8);
          spreads.push({ hash, norm, prefix });
          const decl = CONDITIONAL_KEYS[hash];
          if (!t) {
            unresolved.push(`a conditional spread in the config object is not a \`...(cond ? A : B)\` and could not be read: ${norm.slice(0, 90)}`);
            continue;
          }
          if (!decl) continue; // reported by the roster limb below, not silently taken
          const chosen = decl.branch === 'then' ? t[1] : t[2];
          Object.assign(out, parseObject(balanced(chosen, 0) ?? '{}', depth + 1, prefix));
          continue;
        }
        const kv = /^([A-Za-z_$][\w$]*|'[^']*'|"[^"]*")\s*:\s*([\s\S]*)$/.exec(entry);
        const key = kv ? kv[1].replace(/^['"]|['"]$/g, '') : entry;
        const valText = kv ? kv[2] : entry; // shorthand `material,`
        if (!kv && !/^[A-Za-z_$][\w$]*$/.test(entry)) {
          unresolved.push(`config entry could not be read as a key or a shorthand: ${entry.slice(0, 80)}`);
          continue;
        }
        const trimmed = valText.trim();
        if (trimmed.startsWith('{')) {
          out[key] = parseObject(balanced(trimmed, 0), depth + 1, `${prefix}${key}.`);
          continue;
        }
        const v = evalOpening(valText, depth + 1);
        if (v === NOTHING) {
          unresolved.push(`\`${prefix}${key}\` opens from \`${trimmed.slice(0, 60)}\`, which this gate could not resolve to a value`);
          continue;
        }
        out[key] = v;
      }
      return out;
    }

    const anchor = src.indexOf('const config: JobConfig = useMemo(');
    if (anchor < 0) {
      hostProblems.push(
        'the `const config: JobConfig = useMemo(` object could not be found in App.tsx — this gate reads the browser\u2019s opening state from that object and has just read nothing. An extraction that finds nothing must not report "no divergences"'
      );
    } else {
      const objStart = src.indexOf('{', src.indexOf('=> (', anchor));
      const obj = objStart > 0 ? balanced(src, objStart) : null;
      if (!obj) hostProblems.push('the config object literal in App.tsx did not brace-match — nothing was extracted');
      else browserCfg = selfPlanted('host-extract-blind') ? {} : parseObject(obj);
    }
  }

  // ── B. the extraction is NON-VACUOUS, and it is the REAL opening state ─────
  //
  // 🔴 THE ANCHOR, and the reason this gate is not just a source-diff. The
  // extracted config is handed to the CLI and must reproduce what the browser
  // was MEASURED doing in 158658175e: `plate` refused, zero bytes, that
  // sentence. A parse that drifted — a key silently dropped, a spread branch
  // taken the wrong way — stops reproducing it, and says so here rather than
  // going on to report a comfortable "0 undeclared divergences".
  const TMP = mkdtempSync(join(tmpdir(), 'slicer-host-'));
  let cfgSeq = 0;
  const runCache = new Map();
  const runWith = (argv, cfg) => {
    const key = `${argv.join(' ')}\u0000${cfg === null ? '' : JSON.stringify(cfg)}`;
    if (runCache.has(key)) return runCache.get(key);
    const args = [...argv];
    if (cfg !== null) {
      const p = join(TMP, `c${cfgSeq++}.json`);
      writeFileSync(p, JSON.stringify(cfg));
      args.push('--config', p);
    }
    const r = spawnSync(BIN, args, { encoding: 'utf8' });
    const out = r.stdout ?? '';
    // The temp path travels in some messages; normalised so a cache key does not
    // become the thing that makes two identical runs compare unequal.
    const err = (r.stderr ?? '').split(TMP).join('<TMP>');
    const v = { code: r.status ?? -1, out, err, seen: `${r.status ?? -1}\u0000${out}\u0000${err}` };
    runCache.set(key, v);
    return v;
  };

  const FIXTURES = ['plate', 'pocket', 'socket', 'multi-tool', 'clamped', 'two-part'];
  const REFUSAL = 'a Z re-reference was requested but the machine has no probe';

  if (browserCfg && Object.keys(browserCfg).length) {
    const whole = runWith(['job', 'plate'], browserCfg);
    if (whole.code !== 1 || whole.out.length !== 0 || !whole.err.includes(REFUSAL)) {
      hostProblems.push(
        `the config extracted from App.tsx does NOT reproduce the browser\u2019s measured behaviour: \`job plate\` with it gave exit=${whole.code} stdout=${whole.out.length}B and ${whole.err.includes(REFUSAL) ? 'did' : 'did NOT'} carry the refusal. 158658175e measured exit 1, ZERO bytes and "${REFUSAL}" in the running browser, at the CLI and in the wasm. Either the extraction has drifted from what the page opens with, or the browser default moved and this anchor is the first thing that noticed`
      );
    } else {
      hostNotes.push(`ANCHOR: the extracted opening config reproduces the browser\u2019s measured refusal through the CLI (exit 1, 0 bytes, "${REFUSAL.slice(0, 34)}…")`);
    }
  } else if (!hostProblems.length) {
    hostProblems.push('the browser\u2019s opening config extracted EMPTY — a dead instrument, not two hosts that agree. Every comparison below would pass vacuously');
  }

  // ── C. the per-field sweep ─────────────────────────────────────────────────
  const leaves = (o, p = []) => {
    const acc = [];
    for (const [k, v] of Object.entries(o ?? {})) {
      if (v && typeof v === 'object' && !Array.isArray(v)) acc.push(...leaves(v, [...p, k]));
      else acc.push([[...p, k], v]);
    }
    return acc;
  };
  const nestAt = (path, v) => {
    const root = {};
    let cur = root;
    for (let i = 0; i < path.length - 1; i++) { cur[path[i]] = {}; cur = cur[path[i]]; }
    cur[path[path.length - 1]] = v;
    return root;
  };
  const ladderFor = (key, v) => {
    const w = LIVENESS_WITNESS[key] ?? [];
    if (typeof v === 'boolean') return [...w, !v];
    if (typeof v === 'number') return [...w, v / 2, v * 2, v + 1, 0];
    return w;
  };

  const measured = new Map(); // key -> { verdict, fixtures[], live[] }
  if (browserCfg) {
    const base = new Map(FIXTURES.map((f) => [f, runWith(['job', f], null)]));
    for (const [path, value] of leaves(browserCfg)) {
      const key = path.join('.');
      const divergesOn = [];
      const liveOn = [];
      const rejected = [];
      for (const f of FIXTURES) {
        const solo = runWith(['job', f], nestAt(path, value));
        if (solo.code === 2) { rejected.push(f); continue; }
        if (solo.seen !== base.get(f).seen) { divergesOn.push(f); continue; }
        for (const alt of ladderFor(key, value)) {
          const probe = runWith(['job', f], nestAt(path, alt));
          if (probe.code !== 2 && probe.seen !== solo.seen) { liveOn.push(f); break; }
        }
      }
      if (rejected.length === FIXTURES.length) {
        hostProblems.push(`\`${key}\` is a key App.tsx SENDS and the core REJECTS on every fixture (exit 2) — the browser\u2019s opening config does not deserialise, which is a defect in the wire and not a default`);
      }
      const verdict = divergesOn.length ? 'DIVERGES' : liveOn.length ? 'AGREES' : 'INERT';
      measured.set(key, { verdict, fixtures: divergesOn, live: liveOn, value });
    }
  }

  // ── D. is every divergence declared, and is every declaration still live? ──
  for (const [key, m] of measured) {
    const decl = DECLARED_HOST_DIVERGENCE[key];
    const dropped = selfPlanted('host-undeclared') && key === 'machine.probe_enabled';
    if (m.verdict === 'DIVERGES' && (!decl || dropped)) {
      hostProblems.push(
        `UNDECLARED HOST DIVERGENCE on \`${key}\`: the browser opens with ${JSON.stringify(m.value)} and handing the core that ALONE changes the CLI\u2019s own opening run on ${m.fixtures.join(', ')}. Either it is intended — put it in DECLARED_HOST_DIVERGENCE with a reason and what the operator sees — or one of the two hosts is wrong`
      );
    }
    if (m.verdict === 'INERT') {
      hostProblems.push(
        `\`${key}\` is INERT: the browser sends ${JSON.stringify(m.value)} and NO value of that field changes any of the ${FIXTURES.length} fixtures. That is not agreement — nothing here could have told the two hosts apart, so this comparison says nothing, and a setting consumed by nothing reads as configured (G11\u2019s class, arriving through a host)`
      );
    }
  }
  const stale = { ...DECLARED_HOST_DIVERGENCE };
  if (selfPlanted('host-stale-entry')) stale['machine.safe_z_mm'] = { fixtures: ['plate'], why: 'SELF-PLANT: a declaration for a field that agrees' };
  for (const [key, d] of Object.entries(stale)) {
    const m = measured.get(key);
    if (!m) {
      hostProblems.push(`DECLARED_HOST_DIVERGENCE names \`${key}\` and the browser does not send that key at all — the declaration outlived the field it exempts, and an exemption nobody re-reads is indistinguishable from a live one`);
      continue;
    }
    if (m.verdict !== 'DIVERGES') {
      hostProblems.push(
        `STALE DECLARATION on \`${key}\`: it is listed as an intended host divergence and it does NOT diverge any more (${m.verdict}). A stale exemption reads exactly like a live one — delete the entry, or find out which host moved`
      );
      continue;
    }
    const drift = m.fixtures.join(',') !== [...d.fixtures].join(',');
    if (drift) hostNotes.push(`\`${key}\` now diverges on [${m.fixtures.join(' ')}], declared [${d.fixtures.join(' ')}] — the reach changed, the divergence did not`);
  }

  // ── the conditional spreads: declared, and unchanged ───────────────────────
  for (const s of spreads) {
    if (!CONDITIONAL_KEYS[s.hash]) {
      hostProblems.push(
        `an UNDECLARED conditional key in App.tsx\u2019s config object (\`${s.hash}\`): ${s.norm.slice(0, 110)}… — this gate cannot tell which branch the page opens on, and a key that is absent at opening is the browser AGREEING with the CLI by saying nothing. Declare it in CONDITIONAL_KEYS with the opening branch`
      );
    }
  }
  for (const [hash, d] of Object.entries(CONDITIONAL_KEYS)) {
    if (!spreads.some((s) => s.hash === hash)) {
      hostProblems.push(
        `CONDITIONAL_KEYS carries \`${hash}\` (${d.keys.join(', ')}) and no spread in App.tsx hashes to it — the condition was edited or removed. Re-decide which branch the page opens on rather than re-hashing it: the point of the hash is that this decision gets taken again`
      );
    }
  }

  // ── E. the divergence is not an artefact of the fixtures ──────────────────
  //
  // 🔴 The fixture jobs are geometry this crate wrote, so a sceptic can ask
  // whether any of this reaches a person with a drawing. `import` builds its job
  // through `fixtures::machine()` too, so it does — asserted here rather than
  // asserted of the source, because "they share a constructor" is a claim about
  // code and "the DXF path probes" is a claim about a program.
  {
    const dxf = 'gates/fixtures/plate.dxf';
    const tool = { tool_ids: browserCfg?.tool_ids ?? ['End Mill - Down-cut 6mm 2F'] };
    const cliSide = runWith(['import', dxf], tool);
    const appSide = runWith(['import', dxf], { ...tool, machine: { probe_enabled: false } });
    const cliProbes = /^G38\.2 /m.test(cliSide.out);
    if (!cliProbes) {
      hostProblems.push(`the DXF path does NOT probe at the CLI\u2019s own default (exit=${cliSide.code}, ${cliSide.out.length}B) — this limb exists to show the divergence is not a fixture artefact and it can no longer show it`);
    } else if (cliSide.seen === appSide.seen) {
      hostProblems.push('on the DXF path the browser\u2019s probe default changes NOTHING while the fixtures say it changes everything — two answers to one question, and this gate cannot say which is right');
    } else {
      hostNotes.push(`REACH: the same divergence is on the DXF path an operator uses — \`import plate.dxf\` probes at the CLI default (G38.2 present) and differs at the browser default (${cliSide.out.length}B -> ${appSide.out.length}B)`);
    }
  }

  // The config files this gate wrote go with it. ~200 of them per pass, and the
  // FLAG plant one directory along shipped exactly this leak — a temp directory
  // is harmless per run and unbounded over many, which is a defect whose only
  // symptom is an absence of anyone noticing.
  rmSync(TMP, { recursive: true, force: true });

  const counts = [...measured.values()].reduce((a, m) => ((a[m.verdict] = (a[m.verdict] ?? 0) + 1), a), {});
  hostNotes.push(
    `${measured.size} leaf field(s) swept over ${FIXTURES.length} fixture(s): ${counts.DIVERGES ?? 0} DIVERGES, ${counts.AGREES ?? 0} AGREES (each shown LIVE on at least one fixture), ${counts.INERT ?? 0} INERT`
  );
  hostNotes.push(`App.tsx ${appDigest} + cncStore.ts ${storeDigest} (the bytes this run read, working copies — not commits)`);
  for (const u of unresolved) hostProblems.push(`EXTRACTION: ${u}`);

  if (hostProblems.length) {
    fail('HOST', `${hostProblems.length} problem(s): ${hostProblems.slice(0, 3).join(' | ')}${hostProblems.length > 3 ? ` | …+${hostProblems.length - 3} more` : ''}`);
  } else {
    pass(
      'HOST',
      `${Object.keys(DECLARED_HOST_DIVERGENCE).length} declared host divergence(s), all still diverging: ` +
        Object.entries(DECLARED_HOST_DIVERGENCE).map(([k, d]) => `${k} [${(measured.get(k)?.fixtures ?? []).join(' ')}]`).join('; ') +
        `. ${hostNotes.join('. ')}. ` +
        'NOT ASSERTED, DELIBERATELY: that the two defaults SHOULD be equal — and that is now a RULING, not an open question: founder, 2026-08-14, keep all 5 divergences, declared + safe-direction is the correct end state. This gate only refuses to let the difference stay invisible. NOT COVERED: the CLI flags (a caller\u2019s declaration, not a default), `nest`, and the browser\u2019s React state itself — the opening values are read out of App.tsx as text'
    );
  }
}

// --- GDOC: SLICER-GATES.md's own claims resolve -----------------------------
//
// 🔴 THE HOLE THIS CLOSES. `SPEC` parses `FUNCTIONAL-SPEC.md` and nothing else.
// `SLICER-GATES.md` — the document that says WHICH GATES ARE ARMED and WHERE
// THEIR REDS ARE, and the one every reader of this lane is told to read second
// — was checked by nothing at all. Measured 2026-08-10:
//
//   - `MOVE`'s row ends **"Four witnessed reds below."** There is no MOVE
//     section below it and no `FAIL` transcript for MOVE anywhere in the
//     repository — not in this document, not in 2000 commit bodies. That is
//     precisely the defect SPEC exists to prevent (a row citing evidence that
//     does not resolve) arriving in the document SPEC does not scan.
//   - Three live gates — `DINV`, `BRND`, `CTRL` — had NO ROW AT ALL. 45 of 48.
//     A gate absent from the table reads as a gate that does not exist.
//   - Line ~1171 stated *"I1 is PENDING"*. It was not: only `--quick` can pend
//     I1, and a full run FAILS it. The document described the UNSAFE behaviour
//     while the code did the safe one — and in the direction that matters,
//     because a PENDING used to be waved through by the verdict.
//
// Three limbs, and each is a claim the document makes ABOUT ITSELF:
//
//   A ROSTER      every gate in GATES has a row; every gate-shaped row id is a
//                 real gate. Catches both a gate added without a row and a row
//                 outliving its gate.
//   B EVIDENCE    a row claiming "witnessed red(s) below" must have at least one
//                 fenced transcript block attributed to that gate somewhere in
//                 the file. Attribution is by the nearest preceding heading or
//                 bold lead-in that NAMES A REAL GATE, which is the convention
//                 this document already uses.
//   C STATE       a sentence asserting a gate "is PENDING/GREEN/PASSING/FAILING"
//                 must agree with what that gate did in THIS run. A state claim
//                 in prose is the one kind of sentence that rots by itself.
//
// ⚠ WHAT THIS DOES NOT DO. It does not verify that a transcript is genuine, that
// it belongs to the gate whose section it sits in, or that the red was ever
// actually observed — only that the document is not citing evidence it does not
// contain. A floor, exactly as SPEC's own note says of itself. And limb B is
// deliberately NOT positional: several rows say "below" while their transcript
// sits in `### Notes on specific gates` further up. The claim being checked is
// "there is a recorded red here", not the page order.
//
// NEGATIVE CONTROLS: limb A has `--self-plant doc-roster`. Limbs B and C are
// planted the way SPEC's is — by an edit to the document under test, because
// that edit IS the defect.
{
  const docPath = join(ROOT, 'SLICER-GATES.md');
  const problems = [];
  let rowIds = new Set();
  let claims = [];
  let fencesByGate = new Map();

  if (!existsSync(docPath)) {
    problems.push('SLICER-GATES.md is missing — the document this gate reads does not exist');
  } else {
    const lines = readFileSync(docPath, 'utf8').split('\n');
    const gateIds = new Set(GATES.map((g) => g[0]));
    // Gate-SHAPED: all caps, digits allowed, 1-5 chars. `Plant` and `Gate` are
    // column headings and are not this shape, which is what keeps the roster
    // limb off the header rows without having to model the tables.
    const SHAPE = /^[A-Z][A-Z0-9]{0,4}$/;
    const anchorOf = (l) => {
      const m = /^(?:#{2,3}\s+|\*\*)([A-Z][A-Z0-9]{0,4})\s+[—-]/.exec(l);
      return m && gateIds.has(m[1]) ? m[1] : null;
    };

    let gate = null;
    let inFence = false;
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (/^\s*```/.test(l)) {
        if (!inFence && gate) fencesByGate.set(gate, (fencesByGate.get(gate) ?? 0) + 1);
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;
      const a = anchorOf(l);
      if (a) gate = a;
      if (!l.trim().startsWith('|')) continue;
      const cells = l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
      const id = cells[0];
      if (!SHAPE.test(id)) continue;
      rowIds.add(id);
      if (!gateIds.has(id)) {
        problems.push(`line ${i + 1}: table row \`${id}\` is not a gate — this row outlived its gate, and a row is how a reader learns a gate exists`);
        continue;
      }
      // The claim form this document actually uses: "Witnessed red below",
      // "Two witnessed reds below", "Six witnessed reds below".
      if (/witnessed reds? below/i.test(l)) claims.push({ id, line: i + 1 });
    }
    /* 🔴 LIMB B IS VACUOUS OVER AN EMPTY `claims`, floored 2026-09-08. The set
     * is built from ONE prose phrasing in SLICER-GATES.md. Reword every row away
     * from "witnessed red below" and limb B walks nothing, contributes no
     * problem, and GDOC passes reporting `0 witnessed-red claim(s) each have a
     * transcript attributed to them` — a sentence that is true of a document
     * making no claims and of a document whose claims this reader stopped
     * recognising, and it cannot tell them apart.
     *
     * ⚠ Measured before pinning: SLICER-GATES.md carries 14 such rows today. The
     * floor asserts the phrasing is still FOUND, not how many — the count is the
     * document's to change, the phrasing is this reader's to keep up with.
     *
     * 🟢 Limb A (every gate must have a row) is non-vacuous and would still
     * bite, so this is a hole in one limb rather than a blind gate — which is
     * why it is a floor and not an alarm. */
    if (claims.length === 0) {
      problems.push(
        'no row in SLICER-GATES.md matches the witnessed-red phrasing this limb reads, so the ' +
          'evidence check below walked an EMPTY set and proved nothing. Either every such claim ' +
          'was removed from the document — say so in the commit — or the wording moved and this ' +
          'reader no longer recognises it.',
      );
    }

    // A ROSTER.
    const wanted = GATES.map((g) => g[0]).concat(selfPlanted('doc-roster') ? ['ZZTOP'] : []);
    for (const id of wanted) {
      if (!rowIds.has(id)) {
        problems.push(`gate \`${id}\` has NO ROW in SLICER-GATES.md — it runs on every pass and the document that lists the armed gates does not mention it`);
      }
    }

    // B EVIDENCE.
    for (const c of claims) {
      if (!fencesByGate.get(c.id)) {
        problems.push(
          `line ${c.line}: \`${c.id}\`'s row cites a witnessed red and there is NO transcript block attributed to ${c.id} anywhere in this file — a row citing evidence that does not resolve is exactly what SPEC exists to stop, in the document SPEC does not read`
        );
      }
    }

    // C STATE. `[^.\n]{0,30}` keeps the match inside one sentence on one line —
    // a scanner that crossed a full stop would pair a gate id with the state of
    // whatever was discussed next.
    const stateOf = (id) => results.find((r) => r.id === id)?.state ?? null;
    const WORD = { PENDING: 'PENDING', GREEN: 'PASS', PASSING: 'PASS', FAILING: 'FAIL', RED: 'FAIL' };
    const body = lines.join('\n');
    for (const id of GATES.map((g) => g[0])) {
      const re = new RegExp(`\\b${id}\\b[^.\\n]{0,30}?\\bis\\s+(PENDING|GREEN|PASSING|FAILING|RED)\\b`, 'g');
      for (const m of body.matchAll(re)) {
        const want = WORD[m[1].toUpperCase()];
        const got = stateOf(id);
        if (got === null) continue; // gate has not reported yet in this run — see below
        if (got !== want) {
          const line = body.slice(0, m.index).split('\n').length;
          problems.push(
            `line ${line}: the document states "${m[0].trim()}" and ${id} is ${got} in this run — a state claim in prose is the sentence that rots by itself, and a stale red misleads exactly like a stale green`
          );
        }
      }
    }
  }

  // ⚠ Limb C can only see gates that have ALREADY REPORTED when this block runs
  // — K3, I1 and CTRL are below it. Said here rather than left to be discovered:
  // moving this block to the foot of the file would widen it, and the reason it
  // is not there is that GDOC's own row would then be checked by a gate that has
  // not run. The gates it cannot see are named, not silently skipped.
  const unseen = GATES.map((g) => g[0]).filter((id) => !results.some((r) => r.id === id));

  if (problems.length === 0) {
    pass(
      'GDOC',
      `SLICER-GATES.md: all ${GATES.length} gates have a row, ${rowIds.size} row id(s) resolve, ` +
        `${claims.length} witnessed-red claim(s) each have a transcript attributed to them, and no ` +
        `state claim contradicts this run. NOT COVERED: whether a transcript is genuine, and the ` +
        `state of ${unseen.length} gate(s) that report after this one (${unseen.join(', ')})`
    );
  } else {
    fail('GDOC', `${problems.length} unresolved claim(s) in SLICER-GATES.md: ${problems.slice(0, 4).join(' | ')}${problems.length > 4 ? ` | …+${problems.length - 4} more` : ''}`);
  }
}

// --- K3: the wasm was built from THIS core ---------------------------------
//
// 🔴 THE DEFECT THIS EXISTS FOR, measured 2026-08-08. Gate I1 proves the browser
// and the CLI emit identical bytes for one program. It does NOT prove the wasm
// was built from the current core: a `web/src/wasm` artefact was missing a plant
// added to the core an hour earlier and **I1 passed**, because that change only
// affects planted runs, so both hosts agreed on identical STALE output. "The two
// hosts agree" and "the wasm is current" are different claims, and I1 only ever
// checked the first.
//
// K3 compares `twobee_cam::BUILD_ID` — a digest of every `core/src/*.rs` file,
// baked in by `core/build.rs` — as reported by each host.
//
// WHICH ROUTE THIS TAKES, and therefore what it does not cover:
//   This is the NODE route, not the Playwright route. It imports the built
//   wasm-bindgen glue in this process (`initSync` with the .wasm bytes) and
//   calls `build_id()`. Chosen over reading the value through the browser suite
//   for one reason that decides it: I1 REBUILDS the wasm before it runs, so a
//   value taken from inside I1 would be read from an artefact this gate had just
//   made current — the check would be structurally incapable of seeing the
//   defect it was written for. This block therefore runs BEFORE that rebuild and
//   reads the artefact AS IT LIES ON DISK: the one `npm run dev`, a preview
//   server, or a deploy would serve right now.
//
//   ⚠ CONSEQUENTLY K3 DOES NOT COVER:
//    - that the PAGE loads this artefact. It proves the file in `web/src/wasm/`
//      is current; a second stale copy imported from somewhere else would be
//      invisible here. Node executing the module is not a browser executing it.
//    - anything outside `core/src`. Edits to `wasm/src/lib.rs`, a different
//      wasm-bindgen version, or a changed build profile do NOT move the id, so
//      an id match is not "the artefact is fresh", it is "the CORE that went
//      into it was these bytes".
//    - behaviour. Equal ids say the same source compiled; that the two hosts
//      then EMIT the same G-code is I1's claim and stays I1's claim. K3 is a
//      currency check, I1 is a parity check, and neither substitutes.
{
  const glue = join(ROOT, 'web/src/wasm/twobee_cam_wasm.js');
  const bg = join(ROOT, 'web/src/wasm/twobee_cam_wasm_bg.wasm');
  const cli = slice(['buildid']);
  const cliId = cli.stdout.trim();

  if (cli.code !== 0 || !/^[0-9a-f]{12}$/.test(cliId)) {
    // The BINARY is the stale one in this arm. Not a PENDING: a harness that
    // cannot ask the question it was built to ask is failing, not waiting.
    fail('K3', `the CLI did not answer \`buildid\` (exit ${cli.code}, stdout ${JSON.stringify(cliId.slice(0, 40))}) — this binary predates gate K3; run without --quick`);
  } else if (!existsSync(glue) || !existsSync(bg)) {
    // Nothing built yet is genuinely unchecked, and unchecked is PENDING.
    pend('K3', `no wasm artefact at web/src/wasm — nothing to compare against the CLI (${cliId})`);
  } else {
    let wasmId = null;
    let why = '';
    try {
      const mod = await import(pathToFileURL(glue).href);
      if (typeof mod.build_id !== 'function') {
        why = 'the built wasm exports no build_id() — it predates this gate, which is itself the stale artefact K3 exists to catch';
      } else {
        mod.initSync({ module: readFileSync(bg) });
        wasmId = String(mod.build_id()).trim();
      }
    } catch (e) {
      why = `could not load the wasm glue: ${String(e.message ?? e).slice(0, 200)}`;
    }

    if (wasmId === null) {
      fail('K3', why);
    } else if (wasmId === cliId) {
      pass('K3', `wasm and CLI built from the same core (${cliId})`);
    } else {
      fail(
        'K3',
        `STALE WASM: web/src/wasm was built from core ${wasmId}, the CLI from ${cliId}. ` +
          'I1 would still pass — two hosts running the same old core agree perfectly. ' +
          'Rebuild: cargo build -p twobee-cam-wasm --target wasm32-unknown-unknown --release && ' +
          'wasm-bindgen --target web --out-dir web/src/wasm --no-typescript ' +
          'target/wasm32-unknown-unknown/release/twobee_cam_wasm.wasm'
      );
    }
  }
}

// --- I1: the browser -------------------------------------------------------
//
// Runs the real Playwright suite against a real build. It is the slowest gate
// by far, and it is the only one that can see the thing the operator sees.
//
// 🔴 The suite's parity test carries its OWN negative control: it re-runs the
// CLI with one setting changed and requires the comparison to reject it. An
// equality assertion that cannot fail proves nothing, and two hosts both
// emitting an empty string would satisfy a naive check.
if (!QUICK) {
  try {
    // The wasm the browser loads must be rebuilt from the same source the rest
    // of this gate just tested — otherwise I1 compares today's CLI against
    // whatever wasm happened to be lying in public/.
    execSync('cargo build -p twobee-cam-wasm --target wasm32-unknown-unknown --release', {
      cwd: ROOT,
      stdio: 'pipe',
    });
    execSync(
      'wasm-bindgen --target web --out-dir web/src/wasm --no-typescript ' +
        'target/wasm32-unknown-unknown/release/twobee_cam_wasm.wasm',
      { cwd: ROOT, stdio: 'pipe' }
    );
    const out = execSync('npx playwright test --reporter=line 2>&1', {
      cwd: join(ROOT, 'web'),
      encoding: 'utf8',
      timeout: 900_000,
    });
    const m = /(\d+) passed/.exec(out);
    const failed = /(\d+) failed/.exec(out);
    if (failed && Number(failed[1]) > 0) {
      fail('I1', `browser suite: ${failed[0]}`);
    } else if (m) {
      pass('I1', `browser suite green (${m[1]} tests), G-code byte-identical to the CLI`);
    } else {
      // No result line at all is NOT a pass. It means the runner did not run.
      fail('I1', 'the browser suite produced no result line — it did not run');
    }
  } catch (e) {
    const txt = String(e.stdout ?? '') + String(e.stderr ?? e.message);
    const failed = /(\d+) failed/.exec(txt);
    fail('I1', failed ? `browser suite: ${failed[0]}` : `browser suite errored: ${txt.slice(-300)}`);
  }
} else {
  pend('I1', 'BROWSER PARITY + UI — skipped by --quick, which is not a pass');
}

// --- CTRL: a real controller has seen this program -------------------------
//
// Every dialect claim this gate suite makes is measured against grblHAL's
// PUBLISHED REFERENCE. A board can disagree with its own documentation: canned
// cycles are a compile-time option, so a build without them answers `error:20`
// to the `G83` gate G9 is proud of. G9 would still be green. That is the shape
// of green this gate exists to remove.
//
// It cannot pass from this box. Evidence comes from `tools/controller_probe.py`
// run on the machine that has the USB cable, committed as a transcript. With no
// transcript: PENDING — the true state of "no controller has ever seen our
// output", and NOT a pass.
{
  const dir = join(ROOT, 'gates/controller');
  let transcripts = [];
  if (existsSync(dir)) {
    transcripts = readdirSync(dir).filter((f) => f.endsWith('.json'));
  }
  if (transcripts.length === 0) {
    pend('CTRL', 'no controller transcript in the tree — nothing this lane emits has been offered to a real board');
  } else {
    const problems = [];
    const good = [];
    for (const f of transcripts) {
      let t;
      try {
        t = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      } catch (e) {
        problems.push(`${f}: unreadable (${e.message})`);
        continue;
      }
      // 🔴 A transcript is evidence about ONE program. If this build no longer
      // emits those bytes, the transcript is about something else — and stale
      // evidence reads exactly like proof. Re-emit and compare hashes.
      const cmd = String(t.program_command ?? '').trim();
      if (!cmd) {
        problems.push(`${f}: no program_command — cannot re-emit, so cannot be checked for staleness`);
        continue;
      }
      if (!/^[\w. -]+$/.test(cmd)) {
        problems.push(`${f}: program_command has characters this gate will not execute`);
        continue;
      }
      const emitted = slice(cmd.split(/\s+/));
      const hash = createHash('sha256').update(emitted.stdout).digest('hex');
      if (hash !== t.program_sha256) {
        problems.push(`${f}: transcript is for a program this build no longer emits (${String(t.program_sha256).slice(0, 12)} vs ${hash.slice(0, 12)})`);
        continue;
      }
      if (t.rejected > 0) {
        problems.push(`${f}: ${t.rejected} line(s) rejected by ${t.firmware} — e.g. ${t.rejections?.[0]?.verdict} <- ${t.rejections?.[0]?.sent}`);
        continue;
      }
      good.push(`${cmd} accepted by ${t.firmware} (rig=${t.rig}, ${t.lines_sent} lines)`);
    }
    if (problems.length) {
      fail('CTRL', problems.join(' | '));
    } else {
      // 🔴 Deliberately worded as acceptance, not validation. Nothing moved.
      pass('CTRL', `${good.length} transcript(s): ${good.join('; ')} — ACCEPTED, not cut`);
    }
  }
}

// ===========================================================================
//  PLANT — the gate on the gates: every negative control must still plant
// ===========================================================================
//
// 🔴 THE FAILURE THIS EXISTS FOR IS NOT A DEFECT IN THE PRODUCT. It is a defect
// in the evidence: a plant that silently stops planting makes its gate run
// CLEAN, and a control running clean is indistinguishable from a codebase that
// is correct. Every other row in this table rests on the assumption that its
// plant still injects the defect it names, and until 2026-08-09 exactly three
// gates checked that assumption (DOC, TOOL, REL).
//
// Six ways it went wrong in one session, all real, all found by accident:
//
//   1. `--plant release-order` was nearly hung on a fixture producing ZERO
//      reorder notes — it would have run clean and read as a passing control.
//   2. `import --plant <name>` swallowed the flag entirely, exit 0, no error.
//      Any control on that path was dead on arrival.
//   3. A browser probe-clear control passed because it was checked on a fresh
//      navigation, where there was nothing to go stale from.
//   4. A parity control went vacuous when decision #38 lowered `max_doc_ratio`
//      to 0.50: the "drifted" value clamped to the same 3.0 as the original, so
//      the drift stopped drifting. Caused by OUR OWN change, three commits away.
//   5. `cargo test` passed 343/343 with a plant live, because the tests call
//      `check_flags` directly and cannot see that `main()` stopped calling it.
//   6. `job <name> --config` was accepted and discarded.
//
// ⚠ **This gate asserts CONSEQUENCES, never announcements**, and the reason is
// measured rather than stylistic. `wrong-drill` pushed a note reading
// `PLANTED: a 5.2mm hole with no matching drill` while adding no hole, no
// operation and no motion — byte-identical output on all six jobs, exit 0. An
// intent signal is exactly as trustworthy as the intent. So the contract in
// `core/src/fixtures.rs` declares, per plant, the ONE target it is non-vacuous
// on and the consequence that must be observable from outside the binary, and
// this gate drives the real binary and asserts it.
//
// ⚠ **`cargo test` is not evidence for anything below** — see failure 5. The
// Rust tests beside the contract prove the three lists agree on which plants
// EXIST; only this gate, through the real binary, proves they still bite.
{
  const problems = [];
  const reg = slice(['plants']);

  if (reg.code !== 0 || !reg.stdout.trim()) {
    fail('PLANT', `\`2bee-slice plants\` did not answer (exit=${reg.code}) — the registry this gate reads comes out of the binary, so there is nothing to check against`);
  } else {
    const plants = reg.stdout
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => {
        const [name, ...rest] = l.split('\t');
        const kv = Object.fromEntries(
          rest.filter((f) => f.includes('=')).map((f) => {
            const i = f.indexOf('=');
            return [f.slice(0, i), f.slice(i + 1)];
          })
        );
        return { name, ...kv };
      });

    // 🔴 THE FLOOR — see REGISTRY_FLOOR. Every check below this is satisfied
    // vacuously by an empty registry, so `PLANT` would print "0 plants: each
    // has a contract…" and PASS. A registry that shrinks takes its own alarm
    // with it.
    if (plants.length < REGISTRY_FLOOR.PLANT) {
      problems.push(
        `REGISTRY SHRANK: the binary reports ${plants.length} plant(s) against a floor of ${REGISTRY_FLOOR.PLANT}. ` +
          'If a plant was retired on purpose, lower REGISTRY_FLOOR.PLANT in the same commit and say which one.'
      );
    }

    // --- limb 1: every registered plant has a contract and a consuming gate --
    // An orphan plant is a control nobody runs. It is invisible from every
    // direction except this one: it is registered, it is reachable from the
    // CLI, it appears in `--help`, and no gate names it. Three were orphans on
    // 2026-08-09 — `no-reprobe`, `wrong-drill` and `bed-anchored-sim` — and the
    // third's own doc comment claimed it armed a gate that never drove it.
    for (const p of plants) {
      if (p.host === '?' || p.target === '?') {
        problems.push(`${p.name}: registered with NO CONTRACT — gate PLANT cannot drive it, so nothing would notice it going inert`);
      } else if (p.gate === 'NONE') {
        problems.push(`${p.name}: registered and NO GATE CONSUMES IT — a control nobody runs`);
      }
    }

    // --- limb 2: the gate file and the registry agree, BOTH directions -------
    // A gate naming a plant that does not exist drives a typo and reads the
    // resulting exit-2 as a signal; a plant no gate names is limb 1's orphan.
    //
    // Only LITERAL invocations count. This gate builds its own `--plant` args
    // from the registry, so its own calls do not match the pattern and cannot
    // satisfy limb 2 on another gate's behalf — which is the point: the
    // question is whether a REAL gate drives it, not whether this one does.
    const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    const driven = new Set(
      [...src.matchAll(/'--plant',\s*\n?\s*'([a-z0-9-]+)'/g)].map((m) => m[1])
    );
    const registered = new Set(plants.map((p) => p.name));
    for (const p of plants) {
      if (p.gate !== 'NONE' && !driven.has(p.name)) {
        problems.push(`${p.name}: the contract says gate ${p.gate} drives it, but no literal \`--plant '${p.name}'\` invocation exists in this file`);
      }
    }
    for (const d of driven) {
      // `no-such-plant` is driven deliberately, by FLAG and TOOL, to prove the
      // binary REFUSES an unknown plant. A flag that is honoured is a
      // precondition of every control below meaning anything.
      if (d !== 'no-such-plant' && d !== 'none' && !registered.has(d)) {
        problems.push(`this file drives \`--plant ${d}\`, which the binary does not register — the control is asserting on an exit-2 for a typo`);
      }
    }

    // --- limb 3: NON-VACUITY — the declared consequence must be observed -----
    //
    // The heart of it. Each plant is driven on its declared target, clean and
    // planted, and the declared effect asserted. This is REL's
    // `planted-difference: YES|NO` idea generalised and moved OUTSIDE the core:
    // the core cannot pass by claiming success, because nothing it says is
    // read — only the exit code, the emitted program and the verdict.
    const cfgFile = (name, body) => {
      const f = join(ROOT, 'target', `plant-${name}.json`);
      writeFileSync(f, body);
      return f;
    };
    const simOf = (r) => /sim: [^\n]*/.exec(r.stderr)?.[0] ?? 'unreadable';

    // 🔴 THE TOKEN A DISARMED PLANT PRINTS, TAKEN OUT OF THE CORE'S SOURCE.
    //
    // Before `ea6cf254f0` a plant that was not in force ran to completion: it
    // applied, exited 0, and emitted a program byte-identical to the unplanted
    // one, under its own `PLANTED:` note. That shape — "exits 0 and changes
    // nothing" — is what the checker below was written against, and it is what
    // limb 4 named as its known-inert signature.
    //
    // 🔴 THAT SHAPE NO LONGER EXISTS. A disarmed plant now REFUSES: exit 1,
    // `gcode` cleared, empty stdout, and `PLANT DISARMED` on stderr. Which means
    // a vacuous plant and a GENUINE refusal are now byte-for-byte identical from
    // outside — same exit code, same empty stdout — and the only thing that
    // separates them is that token. Measured 2026-08-12 at core `5a1e27f9d0bc`,
    // over the full plant x target matrix (20 plants, 105 pairings): **18
    // pairings were vacuous refusals the `refuses` arm below called fine** — an
    // EVIDENCE COUNT, not a constant; re-derive it before quoting it. Because every
    // test it applies is satisfied by a refusal it did not cause. That is a live
    // blind spot in limb 3 on all 9 `refuses`-effect plants, not only in limb 4.
    //
    // ⚠ The key is READ OUT OF `core/src/fixtures.rs`, never typed here. A copy
    // of it in this file would be a second place for the constant to live, and
    // the day core renamed it this gate would go silently blind — the exact
    // failure limb 4 exists to catch, arriving through the needle instead of
    // through the checker. Unreadable ⇒ a problem, not a default: a check that
    // cannot run has not passed.
    const disarmedKey = (() => {
      const rs = join(ROOT, 'core/src/fixtures.rs');
      if (!existsSync(rs)) return null;
      return /pub const PLANT_DISARMED_KEY:\s*&str\s*=\s*"([^"]+)"/.exec(readFileSync(rs, 'utf8'))?.[1] ?? null;
    })();
    if (!disarmedKey) {
      problems.push(
        'IN-GATE CONTROL: `PLANT_DISARMED_KEY` could not be read out of `core/src/fixtures.rs`, so the token that ' +
          'separates a vacuous plant from a genuine refusal is unknown on this pass — every `refuses`-effect plant below ' +
          'is checked by a test a refusal it did not cause would also satisfy'
      );
    }

    /**
     * Drive one plant on one target and report what is WRONG, or null.
     *
     * Returns `{ arm, message }` rather than a bare string. The arm is the
     * NAME OF THE BRANCH that objected, and limb 4 asserts on it — keying a
     * probe to a sentence in the message would make every rewording of that
     * sentence a false red, and a false red is how a control gets muted.
     *
     * Split out from the loop so limb 4 can call it with a deliberately
     * neutered pairing and require it to object. A checker that has gone blind
     * is otherwise indistinguishable from a suite that is clean — DOC's lesson,
     * applied to the thing DOC's lesson is about.
     */
    const vacuityProblem = (p, target) => {
      const base = [p.host, target];
      if (p.config && p.config !== '-') base.push('--config', cfgFile(p.name, p.config));
      const clean = slice(base);
      const planted = slice([...base, '--plant', p.name]);
      const where = `${p.name} (${p.host} ${target})`;
      const empty = (r) => r.stdout.trim().length === 0;

      // The core's own verdict on whether this plant bit. `clean` carries no
      // `--plant`, so it can never carry the token; only the planted run is read.
      const disarmed = disarmedKey !== null && planted.stderr.includes(disarmedKey);
      const say = (arm, msg) => ({
        arm,
        message:
          `${where}: ${msg}` +
          // 🔴 Appended, never substituted. The arm's sentence is the SYMPTOM
          // ("declared `program-differs` and a run was refused") and reads as a
          // wrong contract; the token is the DIAGNOSIS ("the plant is not in
          // force"), and they send a reader to different fixes. Printing only
          // the first is how a disarmed control gets closed as a bad row.
          (disarmed
            ? ` — AND the run said so itself: the core printed \`${disarmedKey}\`, which is the diagnosis (this plant is not in force on this run) rather than the symptom above`
            : ''),
      });

      const armProblem = () => {
        switch (p.effect) {
          case 'refuses':
            if (clean.code !== 0 || !clean.stdout.length) {
              return say('refuses', `the UNPLANTED run is already refused (exit=${clean.code}) — the plant cannot be shown to cause anything`);
            }
            if (planted.code === 0) {
              return say('refuses', `declared \`refuses\` and the planted run EXITED 0 emitting ${planted.stdout.length}B — the plant is INERT here and any control on it runs clean`);
            }
            // G13's property: a refusal must mean no program EXISTS, not that a
            // warning was printed above a runnable one.
            if (!empty(planted)) {
              return say('refuses', `refused but emitted ${planted.stdout.length}B — a warning printed above a runnable file is a file that gets run`);
            }
            // 🔴 AND HERE THE ARM RUNS OUT OF QUESTIONS. Every test above is
            // satisfied by a refusal the plant did not cause, so a vacuous
            // plant leaves this arm with nothing to object to. The token
            // fallthrough below is what closes it — see `disarmedKey`.
            return null;

          case 'emits':
            if (clean.code === 0 || !empty(clean)) {
              return say('emits', `declared \`emits\` (inverted polarity) but the UNPLANTED run already emits ${clean.stdout.length}B at exit ${clean.code} — there is no refusal for the plant to remove`);
            }
            if (planted.code !== 0 || !planted.stdout.length) {
              return say('emits', `declared \`emits\` and the planted run was refused (exit=${planted.code}) — the plant did not restore the swallow`);
            }
            return null;

          case 'program-differs':
            if (clean.code !== 0 || planted.code !== 0) {
              return say('program-differs', `declared \`program-differs\` but a run was refused (clean=${clean.code} planted=${planted.code}) — compare two programs or declare a different effect`);
            }
            if (clean.stdout === planted.stdout) {
              return say('program-differs', `declared \`program-differs\` and the programs are BYTE-IDENTICAL (${clean.stdout.length}B) — the plant is INERT here and any control on it runs clean`);
            }
            return null;

          case 'verdict-differs':
            if (clean.code !== 0 || planted.code !== 0) {
              return say('verdict-differs', `declared \`verdict-differs\` but a run was refused (clean=${clean.code} planted=${planted.code})`);
            }
            // The identical-program half is ASSERTED, not assumed. This effect
            // means "the defect is in the CHECK" — a plant that starts moving the
            // cutter has silently become a different kind of control.
            if (clean.stdout !== planted.stdout) {
              return say('verdict-differs', `declared \`verdict-differs\`, which means the motion is unchanged BY DESIGN, and the programs differ — it is no longer a control for the check`);
            }
            if (simOf(clean) === simOf(planted)) {
              return say('verdict-differs', `declared \`verdict-differs\` and the verdict did not move (${simOf(clean)}) — the plant is INERT here`);
            }
            return null;

          case 'note-disappears': {
            /* 🔴 THE INVERTED ARM. Every case above observes a defect the gate
             * can SEE; an obligation plant makes nothing go wrong and a SENTENCE
             * stops being said, so all three halves are asserted here: the note
             * present clean, absent planted, and the program unmoved. A plant
             * that started moving the cutter would have quietly become a
             * different kind of control. */
            if (clean.code !== 0 || planted.code !== 0) {
              return say('note-disappears', `declared \`note-disappears\` but a run was refused (clean=${clean.code} planted=${planted.code}) — an obligation control needs a PROGRAM to be silent in`);
            }
            if (clean.stdout !== planted.stdout) {
              return say('note-disappears', 'declared `note-disappears`, which means the cut is unchanged BY DESIGN and the SILENCE is the defect — but the program moved');
            }
            const needle = 'CANNOT BE PRODUCED';
            if (!clean.stderr.includes(needle)) {
              return say('note-disappears', `the CLEAN run does not carry \`${needle}\` — there was nothing to take away, so the obligation is unmet rather than guarded`);
            }
            if (planted.stderr.includes(needle)) {
              return say('note-disappears', `the planted run STILL says \`${needle}\` — the control cannot go red`);
            }
            return null;
          }

          default:
            return say('unknown-effect', `unknown declared effect \`${p.effect}\``);
        }
      };

      const bad = armProblem();
      if (bad) return bad;

      // 🔴 THE FALLTHROUGH THAT CLOSES THE `refuses` ARM. The arm above is
      // satisfied by ANY refusal with empty stdout, and since `ea6cf254f0` a
      // plant that is not in force produces exactly that. So the last question
      // asked is the one the core already answered for us: did it say the plant
      // was disarmed? This is not a second opinion about the same evidence — it
      // is a channel the arms never read.
      if (disarmed) {
        return say(
          'disarmed',
          `the core REFUSED this run with \`${disarmedKey}\` — the plant was applied and left no trace of itself, so this refusal is NOT the ` +
            `consequence the plant names. From outside it is byte-for-byte a genuine refusal (exit=${planted.code}, ${planted.stdout.length}B on stdout), ` +
            `which is why every test the \`${p.effect}\` arm applies passed`
        );
      }
      return null;
    };

    for (const p of plants) {
      if (p.host === '?' || p.target === '?') continue; // limb 1 has it
      const bad = vacuityProblem(p, p.target);
      if (bad) problems.push(bad.message);
    }

    // --- limb 4: the IN-GATE CONTROL, run on every pass ----------------------
    //
    // 🔴 Limbs 1-3 are a checker, and a checker is a thing that can go blind.
    // If `vacuityProblem` ever returns null unconditionally — a refactor, a
    // swallowed exception, a switch arm that stops matching — limb 3 reports no
    // problems and this gate goes GREEN while proving nothing. That is the
    // exact shape of the defect it was built to catch, arriving in the checker
    // instead of in the plants.
    //
    // So it is fed pairings that are KNOWN INERT and must object.
    //
    // 🔴 RE-POINTED 2026-08-12, and the reason is worth more than the fix.
    // The original probe drove `cut-clamp` on `plate` and keyed on the signature
    // *"it applies, exits 0 and changes nothing"*. `ea6cf254f0` — a core change
    // in another lane, three commits away — made a disarmed plant REFUSE
    // instead, so that signature ceased to exist and the probe's premise became
    // false. It went red and was deliberately LEFT red rather than re-pointed at
    // whatever pairing happened to be green mid-change. This is the re-point,
    // taken against a settled core, from a measured matrix rather than a search
    // for something that passes.
    //
    // 🔴 THE PROPERTY EACH ROW MUST HAVE IS STRUCTURAL INERTNESS, not observed
    // inertness. `cut-clamp` works by replacing `j.fixturing`, and the ONLY site
    // that reads `JobPlant::CutClamp` is inside the `"clamped"` arm of the job
    // builder — on `plate` the plant has no code path at all. `spindle-off` and
    // `gouge` are the same shape reached from the other side: the pairing fails
    // the plant's declared consequence because the target has not got the thing
    // the plant attacks. "It is green today" would be picking a needle; "this
    // plant cannot reach this job" is a reason that survives the next commit.
    //
    // ⚠ ONE ROW PER ARM OF `vacuityProblem`, because the comment above already
    // claims "a switch arm that stops matching" as a covered failure and ONE row
    // never covered it — the old probe exercised the `refuses` arm and nothing
    // else. An arm whose body goes permissive is invisible to a probe that never
    // enters it.
    //
    // 🔴 RESIDUAL, NAMED RATHER THAN PAPERED OVER: the `emits` arm has no
    // token-free inert pairing on this tree. `tool-substitute` bites on all six
    // jobs, and `overlap-unchecked` off its declared drawing is caught by the
    // token before the arm is reached. So `emits` is covered through `disarmed`
    // and NOT through its own branch. If that arm goes permissive, this probe
    // will not see it.
    //
    // ⚠ This is NOT a source edit that proved the gate could go red on the day
    // it was written. It runs on every pass, which is the difference between a
    // control and an anecdote.
    const BLIND_PROBES = [
      {
        plant: 'cut-clamp',
        target: 'plate',
        arm: 'disarmed',
        why: 'a `refuses`-effect plant that is not in force. Since `ea6cf254f0` the core refuses it — exit 1, empty ' +
          'stdout — which is byte-for-byte what a GENUINE refusal looks like from outside, so only the `PLANT DISARMED` ' +
          'token separates them. A checker that reads the exit code and not the token cannot tell these apart at all',
      },
      {
        plant: 'spindle-off',
        target: 'drill-peck',
        arm: 'refuses',
        why: 'declared `refuses`, and on a peck-drill fixture the planted run EXITS 0 with a program — a drill cycle ' +
          'starts the spindle through a path this plant does not reach. The `refuses` arm must object to a planted run ' +
          'that emitted',
      },
      {
        plant: 'gouge',
        target: 'clamped',
        arm: 'program-differs',
        why: 'declared `program-differs`, and on the clamped fixture the planted cut runs into a clamp, so the run is ' +
          'REFUSED and there is no second program to compare. The `program-differs` arm must object to being asked to ' +
          'diff a program that does not exist',
      },
      {
        plant: 'bed-anchored-sim',
        target: 'clamped',
        arm: 'verdict-differs',
        why: 'declared `verdict-differs`, and under its own config the clamped fixture is refused BEFORE the plant ' +
          'matters — both runs exit 1 with no program and no verdict to move. The `verdict-differs` arm must object ' +
          'rather than read two absent verdicts as equal-and-fine',
      },
    ];
    for (const probe of BLIND_PROBES) {
      const p = plants.find((x) => x.name === probe.plant);
      if (!p) {
        problems.push(
          `IN-GATE CONTROL: \`${probe.plant}\` is not in the registry, so the blindness probe for the \`${probe.arm}\` ` +
            `arm could not run — that arm is unverified on this pass`
        );
        continue;
      }
      const objection = vacuityProblem(p, probe.target);
      if (!objection) {
        problems.push(
          `IN-GATE CONTROL BLIND: \`${probe.plant}\` driven on \`${probe.target}\` is ${probe.why} — and the checker ` +
            `called it fine. Limb 3 is not detecting vacuous plants through its \`${probe.arm}\` path, so every green ` +
            `above it means nothing`
        );
      } else if (objection.arm !== probe.arm) {
        // Not "blind" — the checker DID object, through a different door. That
        // is a moved premise, not a dead control, and the two have different
        // fixes: re-derive the pairing, or find out what changed in the core.
        problems.push(
          `IN-GATE CONTROL PREMISE MOVED: \`${probe.plant}\` on \`${probe.target}\` was chosen to exercise the ` +
            `\`${probe.arm}\` path and the checker objected through \`${objection.arm}\` instead — the \`${probe.arm}\` ` +
            `path is no longer proven on this pass. Re-derive the pairing from a fresh plant x target matrix rather ` +
            `than relaxing this row. What was observed: ${objection.message}`
        );
      }
    }

    if (problems.length) {
      fail('PLANT', problems.join(' | '));
    } else {
      pass(
        'PLANT',
        `${plants.length} plants (floor ${REGISTRY_FLOOR.PLANT}): each has a contract, a consuming gate, a literal invocation in ` +
          `this file, and was driven on its declared target and observed to actually plant ` +
          `(programs differ / refuses with empty stdout / emits / verdict moves), with the core's own ` +
          `\`${disarmedKey}\` token read on every planted run — the one channel that separates a vacuous ` +
          `plant from a genuine refusal. ${BLIND_PROBES.length} blindness probe(s) still catch a known-inert ` +
          `pairing, one per checker arm (${BLIND_PROBES.map((b) => b.arm).join(', ')}; \`emits\` covered only ` +
          `through the token — see the note above)`
      );
    }
  }
}

// --- PENDING gates ---------------------------------------------------------// --- BRND: the vendored brand marks still match brand's masters ----------
//
// 🔴 THE GAP THIS EXISTS FOR. `web/src/assets/2bee-farm-mark-*.svg` are COPIES
// of `brand/brand-kit/logos/*`, taken 2026-08-08. Each copy's header says so in
// capitals — "THIS IS A COPY. IT WILL NOT FOLLOW BRAND'S CHANGES" — and records
// the source sha256 it was taken from. That is an honest, well-written comment
// and it is not a control: nothing compared the recorded hash to the master
// again, so the day brand edits the mark, this app goes on rendering the old one
// and the ONLY artefact claiming it is current is the copy's own header.
//
// ⚠ This is the night's recurring shape, third instance: a `debug_assert` that
// catches our NaN and is compiled out of the build we ship; an ignore rule added
// without `git rm --cached`; and here, a comment that names the risk precisely
// and ends the search for it. A stated caveat reads as a handled one.
//
// PENDING, not PASS, when a master is missing — brand owns that tree and this
// lane cannot tell "brand deleted it" from "the path moved". A check that cannot
// run has not passed.
{
  const marks = ['2bee-farm-mark-reversed-white', '2bee-farm-mark-mono-black'];
  const drifted = [];
  const missingProvenance = [];
  const unreadable = [];
  let checked = 0;
  for (const m of marks) {
    const master = join(ROOT, '..', '..', 'brand', 'brand-kit', 'logos', `${m}.svg`);
    const copy = join(ROOT, 'web', 'src', 'assets', `${m}.svg`);
    if (!existsSync(master) || !existsSync(copy)) {
      unreadable.push(`${m} (master ${existsSync(master) ? 'ok' : 'MISSING'}, copy ${existsSync(copy) ? 'ok' : 'MISSING'})`);
      continue;
    }
    const text = readFileSync(copy, 'utf8');
    const rec = /Source sha256:\s*([0-9a-f]{64})/.exec(text)?.[1];
    if (!rec) {
      // 🔴 FAIL, not PENDING — and the distinction is the whole point.
      //
      // PENDING is for a check this lane CANNOT run: brand's master is missing
      // and we cannot tell "brand deleted it" from "the path moved". A copy that
      // does not record where it came from is a different thing entirely — it is
      // OUR file, in OUR tree, and its provenance is ours to keep.
      //
      // ⚠ Found by planting it: stripping the hash line turned this gate PENDING
      // and the run still said VERDICT: GO. So the one edit that permanently
      // disarms this check was the one edit it waved through. An unverifiable
      // copy is worse than a drifted one — a drift can be detected later, a copy
      // with no recorded source never can.
      missingProvenance.push(m);
      continue;
    }
    const now = createHash('sha256').update(readFileSync(master)).digest('hex');
    checked += 1;
    if (rec !== now) drifted.push(`${m}: copy taken from ${rec.slice(0, 12)}, master is now ${now.slice(0, 12)}`);
  }
  if (missingProvenance.length) {
    fail(
      'BRND',
      `${missingProvenance.join(', ')}: the vendored copy records no Source sha256, so nothing can ever ` +
        `tell whether it still matches brand's master — an unverifiable copy is worse than a drifted one`
    );
  } else if (unreadable.length) {
    results.push({
      id: 'BRND',
      state: 'PENDING',
      msg: `cannot compare ${unreadable.join('; ')} — brand owns that tree and a check that cannot run has not passed`,
    });
  } else if (drifted.length) {
    fail('BRND', `${drifted.length} vendored mark(s) no longer match brand's master: ${drifted.join(' | ')}`);
  } else {
    pass('BRND', `${checked} vendored mark(s) match the brand master they record (sha256), so a brand edit will go red here instead of silently rendering the old logo`);
  }
}


// ---------------------------------------------------------------------------
// DISC: THE DISCLOSURES ARE STILL IN THE OUTPUT
//
// 🔴 THE HAZARD (`pnp`, measured; ceo FLEET_RULES 0ez, 2026-09-05): a self-
// limiting caveat inside a gate's PASS branch can be DELETED, reworded into
// meaninglessness, or silently stop firing, and NO CONTROL MOVES. `pnp` removed
// one and their sweep's output was BYTE-IDENTICAL, because a sweep classifying
// runs on `startswith("  FAIL")` cannot see text inside a pass by construction.
//
// ⇒ Unlike a broken check, removing a caveat makes the control look STRONGER:
// nothing goes red and the verdict reads better. That is why it is the last
// thing anyone re-checks — and this lane holds one of the three largest
// populations of them.
//
// ⚠ THE CLASS IS LARGE BECAUSE WE MADE IT. Converting silent failures into
// printed disclosures was right all session, and it manufactured exactly the
// artefact nothing guards.
//
// So rather than a test that would notice a deletion, this makes a deletion
// MOVE THE VERDICT: each pinned caveat must appear in the message its gate
// actually emitted, checked on the emitted text, never on the constant that was
// supposed to produce it. `DISCLOSURES` is a list so adding one is a line.
//
// ⚠ REACHABILITY IS ASSERTED SEPARATELY AND LOUDLY. A caveat pinned to text a
// gate prints only when it PASSES is legitimately absent when that gate fails —
// and a check that silently accepted that would be green on a suite where every
// gate had failed. An unreachable disclosure reports UNREACHABLE and counts as
// a gap, never as a pass. (`pnp` hit this exactly: a naive fixture tripped their
// ratchet and returned FAIL before any PASS text existed.)
/* ⚠ THE GATE ID IS PART OF THE PIN, AND I GOT FOUR OF THEM WRONG. I derived
 * them by taking the nearest preceding `pass(`/`fail(` call in the source, which
 * is a proxy, not a measurement: these messages are multi-line template
 * literals and another gate's emit call can sit between a caveat and its own.
 * The first clean run accused TECH, MARK, PROBE and GDOC of dropping caveats
 * they were printing perfectly — a check that names the wrong owner does not
 * fail safe, it manufactures a defect in correct work. The ids below are read
 * off the EMITTED REPORT, which is the same artefact this check asserts on. */
const DISCLOSURES = [
  ['TECH',  'no product path takes a technology'],
  ['MARK',  'whether the mark is LEGIBLE'],
  ['PROBE', 'browser parity for the XYZ path'],
  ['REACH', 'never that the operator read'],
  ['CAD1',  'NOT CLEAN BY ABSENCE'],
  ['RUN',   'CANNOT discover that our reading of grblHAL is wrong'],
  ['CADT',  'whether our reading of OpenSCAD is right'],
  ['TSC',   'whether the code is CORRECT'],
  ['HOST',  'NOT ASSERTED, DELIBERATELY'],
  ['GDOC',  'whether a transcript is genuine'],
  ['AGPL',  'that what it serves is the Corresponding Source'],
];
/* 🔴 PINNED, because the list itself is deletable. Removing an entry would
 * otherwise silence its caveat and leave this gate green — the same failure one
 * level up, which is where controls of controls usually die. */
const DISCLOSURES_PINNED = 11;
{
  const missing = [];
  const unreachable = [];
  if (DISCLOSURES.length !== DISCLOSURES_PINNED) {
    missing.push(
      `the list itself changed: ${DISCLOSURES.length} entr(ies), pinned at ${DISCLOSURES_PINNED}. ` +
        'Adding one is fine — update the pin in the same commit. Removing one needs a sentence ' +
        'saying which caveat you decided a reader no longer needs.',
    );
  }
  if (selfPlanted('disclosure-deleted')) {
    for (const r of results) r.msg = r.msg.split('NOT CLEAN BY ABSENCE').join('');
  }
  for (const [gate, text] of DISCLOSURES) {
    const rows = results.filter((r) => r.id === gate);
    if (rows.length === 0) { unreachable.push(`${gate} did not run — "${text}" untested`); continue; }
    if (!rows.some((r) => r.msg.includes(text))) {
      const states = rows.map((r) => r.state).join('/');
      /* A gate that FAILED prints a different message, so its pass-branch
       * caveat is absent for a reason that is not a deletion. Reported as a
       * gap, because "we could not check" and "we checked" are different facts
       * and only the second is a pass. */
      if (rows.every((r) => r.state !== 'PASS')) unreachable.push(`${gate} was ${states} — "${text}" untested`);
      else missing.push(`${gate} passed WITHOUT its caveat: "${text}"`);
    }
  }
  /* 🔴 THE PLANT DELETES, it does not announce. Pushing a synthetic problem here
   * would exercise the FAIL branch and prove nothing about DETECTION — the
   * difference between "a plant that fires" and "a plant that fires correctly".
   * This strips a real caveat out of a real emitted message and the check above
   * has to notice on its own. Placed AFTER the loop would be useless, so the
   * mutation runs before it: see the re-scan below. */
  if (missing.length > 0) {
    fail(
      'DISC',
      `${missing.length} disclosure problem(s): ${missing.join(' | ')}. ` +
        'A caveat that stops printing removes the only thing standing between this gate’s number ' +
        'and a reader who over-reads it, and nothing else in this suite would have moved.',
    );
  } else if (unreachable.length > 0) {
    pend(
      'DISC',
      `${DISCLOSURES.length - unreachable.length} of ` +
        `${DISCLOSURES.length} caveat(s) confirmed in the text their gate emitted; ` +
        `${unreachable.length} COULD NOT BE CHECKED because the gate did not pass here: ` +
        `${unreachable.join(' | ')}. UNCHECKED IS NOT ABSENT and it is not present either — ` +
        'these are pinned to pass-branch text, so a red gate hides its own caveat from this check.',
    );
  } else {
    pass(
      'DISC',
      `all ${DISCLOSURES.length} pinned caveat(s) appear in the ` +
        'message their gate EMITTED (asserted on the emitted text, never on the constant that was ' +
        'supposed to produce it). NOT COVERED: whether a caveat is still TRUE, or still the right ' +
        'caveat — this proves it was printed, which is a different fact from it being earned.',
    );
  }
}

// ---------------------------------------------------------------------------
// The verdict, as a pure function, so the thing every negative control asserts
// on is itself under assertion. `--self-plant verdict-go-on-gaps` restores the
// rule exactly as it stood until 2026-08-10 — `pending` counted, printed, and
// discarded — and gate VERD must go red on it.
const EXIT_OF = { GO: 0, INCOMPLETE: 3, 'NO-GO': 1 };
const verdictOf = (failed, gaps) =>
  selfPlanted('verdict-go-on-gaps')
    ? failed === 0
      ? 'GO'
      : 'NO-GO'
    : failed > 0
      ? 'NO-GO'
      : gaps > 0
        ? 'INCOMPLETE'
        : 'GO';
const verdictLine = (v, failed, gaps) =>
  v === 'GO'
    ? 'VERDICT: GO'
    : v === 'INCOMPLETE'
      ? `VERDICT: INCOMPLETE — ${gaps.length} gate(s) could not run here (${gaps.map((g) => g.id).join(', ')}). ` +
        `Nothing failed and nothing is certified: this is NOT a pass, and it is NOT the string a ` +
        `negative control may accept.`
      : `VERDICT: NO-GO — ${failed} gate(s) did not pass${gaps.length ? `, and ${gaps.length} could not run (${gaps.map((g) => g.id).join(', ')})` : ''}.`;

// --- VERD: the verdict cannot call an unanswered gate a pass ----------------
//
// 🔴 Every other gate in this file guards the PRODUCT. This one guards the
// SENTENCE, because that sentence is what rule 2 makes every negative control
// assert on — so a defect here is not one gate going quiet, it is all of them.
//
// The truth table is asserted on every pass, and it includes the INCOMPLETE
// branch. That matters more than it looks: on this box the suite cannot reach a
// zero-failure state (the browser has no WebGL and `web/src/wasm` is stale), so
// `VERDICT: INCOMPLETE` cannot be produced by a real run here and would
// otherwise be a branch nobody has ever seen behave.
//
// The prefix limb is not decoration either. The tempting third verdict was
// `GO-WITH-GAPS`, and `grep 'VERDICT: GO'` matches it — a control greping for a
// pass would have gone on passing through the exact state this work exists to
// stop being a pass.
{
  const table = [
    [0, 0, 'GO'],
    [0, 1, 'INCOMPLETE'],
    [0, 7, 'INCOMPLETE'],
    [1, 0, 'NO-GO'],
    [1, 1, 'NO-GO'],
    [5, 3, 'NO-GO'],
  ];
  const wrong = table.filter(([f, g, want]) => verdictOf(f, g) !== want);

  // 🔴 DOES `EXIT_OF` COVER THE RANGE OF `verdictOf`? The table above is six
  // hardcoded rows and the checks below validate `EXIT_OF` AGAINST ITSELF —
  // distinct values, one zero, no prefixes. Nothing asked whether every word
  // `verdictOf` can RETURN is a key of the map, and that is the question the
  // exit code depends on.
  //
  // ⚠ MEASURED 2026-09-04, not suspected: `process.exit(undefined)` exits **0**,
  // and `EXIT_OF['GO-WITH-GAPS']` is `undefined`. So a verdict word missing from
  // the map is a PASS to everything that reads the exit status, which is the
  // whole deploy contract. `GO-WITH-GAPS` is not hypothetical — this file's own
  // comment above records it as "the tempting third verdict".
  //
  // The grid is wider than the table on purpose: it asks the FUNCTION what it
  // can produce rather than asserting answers somebody already thought of.
  const produced = new Set();
  for (let f = 0; f <= 3; f++) for (let g = 0; g <= 3; g++) produced.add(verdictOf(f, g));
  const unmapped = [...produced].filter((v) => !Number.isInteger(EXIT_OF[v]));

  // No verdict may be a PREFIX of another, or a control greping for one accepts
  // the other. And only GO may exit 0.
  const names = Object.keys(EXIT_OF);
  const prefixes = [];
  for (const a of names) for (const b of names) if (a !== b && b.startsWith(a)) prefixes.push(`${a} is a prefix of ${b}`);
  const zeroExits = names.filter((n) => EXIT_OF[n] === 0);
  const exitsDistinct = new Set(Object.values(EXIT_OF)).size === names.length;

  // And the composed LINE, not just the word: a non-GO run must not contain the
  // string a control greps for. Asserted on the text that actually gets printed.
  const fakeGaps = [{ id: 'CTRL' }, { id: 'I1' }];
  const leaks = ['INCOMPLETE', 'NO-GO']
    .map((v) => verdictLine(v, 2, fakeGaps))
    .filter((l) => /VERDICT: GO\b/.test(l) || /VERDICT: GO$/.test(l));

  if (
    wrong.length === 0 &&
    prefixes.length === 0 &&
    zeroExits.length === 1 &&
    zeroExits[0] === 'GO' &&
    exitsDistinct &&
    leaks.length === 0 &&
    unmapped.length === 0
  ) {
    pass(
      'VERD',
      `${table.length}/${table.length} of the verdict truth table hold, including 0 failed + gaps -> ` +
        `INCOMPLETE (exit 3) which no real run on this box can currently produce; no verdict string is a ` +
        `prefix of another; only GO exits 0; neither non-GO line contains "VERDICT: GO"; and every one of the ` +
        `${produced.size} verdict(s) verdictOf can return over a 4x4 grid maps to an INTEGER exit code ` +
        `(an unmapped word exits 0 — measured: process.exit(undefined) is rc=0)`
    );
  } else if (unmapped.length) {
    fail(
      'VERD',
      `verdictOf can return ${unmapped.length} verdict(s) with NO integer in EXIT_OF: ${unmapped.join(', ')}. ` +
        'process.exit(undefined) is rc=0, so each of these would report a PASS to CI while the run was not one. ' +
        'Add the word to EXIT_OF with a distinct non-zero code, or stop verdictOf producing it.'
    );
  } else if (wrong.length) {
    fail(
      'VERD',
      `the verdict does not distinguish a gate that ANSWERED from one that was SWITCHED OFF: ` +
        wrong.map(([f, g, want]) => `${f} failed + ${g} could-not-run gives ${verdictOf(f, g)}, expected ${want}`).join('; ') +
        `. Every negative control in this suite asserts this line, so this is not one gate going quiet — ` +
        `it is all of them`
    );
  } else if (prefixes.length || leaks.length) {
    fail('VERD', `a verdict string can be mistaken for a pass by a grep: ${[...prefixes, ...leaks].join(' | ')}`);
  } else {
    fail('VERD', `exit codes are wrong: ${JSON.stringify(EXIT_OF)} — exactly one verdict may exit 0 and it must be GO`);
  }
}

// The two scoring self-plants. They disarm a gate the way a real defect would —
// by turning an ANSWER into a PENDING — which is the one move the old verdict
// line could not see. Applied after every gate has reported, because that is
// where the defect they model lands: the gate ran, and stopped being able to say
// anything.
if (SELF_PLANT === 'pend-unbudgeted' || SELF_PLANT === 'pend-budgeted') {
  const target = SELF_PLANT === 'pend-budgeted' ? 'BRND' : 'G1';
  const r = results.find((x) => x.id === target);
  const msg = `SELF-PLANT ${SELF_PLANT}: forced PENDING to model a gate that stopped being able to answer`;
  if (r) {
    r.state = 'PENDING';
    r.msg = msg;
  } else {
    pend(target, msg);
  }
}

// 🔴 A GATE THAT NEVER REPORTED IS NOT A GATE THAT PASSED. Every row in GATES
// is HARD, so an id with no result means its block threw, was deleted, or was
// edited out — none of which may be silent. This used to backfill `PENDING` for
// `kind === 'PENDING'` rows and was dead code, because there are none.

// --- AGPL: the §13 source offer -------------------------------------------
//
// 🔴 MEASURED 2026-08-10 and still unresolved: the footer links
// `https://github.com/2bee-farm/2bee.slicer` -> HTTP 404 (control: github.com ->
// 200, so the box is online and the 404 is real). Wrong org, wrong repo, and the
// lane renamed to `2bee.app` without the link moving. And the only real
// repository is PRIVATE, so even a corrected link delivers nothing today.
//
// ⚠ CORRECTED 2026-08-12 — this paragraph used to end "The same URL is in
// `Cargo.toml`." IT NO LONGER IS, and it stopped being true a day after it was
// written. The `repository` key was deleted on 2026-08-11; the string survives
// in that file only inside the comment explaining its own removal, where it
// asserts nothing. A reader following the old sentence would have found the
// text, believed the gate, and "fixed" a comment. THE LIVE COPY IS ONE:
// `web/src/App.tsx`, the footer anchor this block reads. Corrected rather than
// deleted, because the sentence was true when written and that is exactly how a
// gate comment goes wrong — it stands still while the tree moves, and a comment
// is the least-audited thing in a repo.
//
// ⚠ WHY THIS IS A GATE AND NOT A FIX. Choosing what the link points at IS the
// Corresponding Source mechanism — public mirror, source tarball, or opening the
// monorepo — and that is `legal`'s open decision. A link that 404s is bad; a link
// that LOOKS compliant and delivers nothing is worse. So this lane does not
// guess; it refuses to let the broken offer ship UNNOTICED.
//
// ⚠ AND WHY IT PENDS RATHER THAN FAILS. §13 attaches when the work is SERVED.
// Every listener here is loopback-only and nothing resolves for `2bee.app`, so
// nothing is served — and a permanent red would cry wolf, which is the same
// reasoning that shaped the verdict above: a verdict that is always red stops
// being read. That reasoning is unchanged. What changed is that THE PREMISE IS
// NOW MEASURED instead of asserted.
//
// ⚠ 2026-08-14 — THE INTENT HALF OF THE PREMISE IS NOW A RULING, NOT A GUESS.
// Founder, verbatim: "@software/2bee.app/ will served here" — the domain is
// served-intent, not defensive, so the offer is LIVE-DUTY and this pending is
// a deadline, not a contingency. What the ruling is NOT: publish-now (no DNS
// record without a further word) and not `legal`'s mechanism ruling, which
// still blocks the offer itself. So no branch below changes: published with a
// dead or unruled offer FAILS; not-yet-served with the known-dead link still
// PENDS, because §13 has not attached and a red that cannot clear until two
// other lanes act is a red that stops being read.
//
// 🔴 THE DANGEROUS PROPERTY IS THE ORDER. Publishing is ONE DNS RECORD; fixing
// the offer is a repo decision. The cheap step and the compliant step are not the
// same step, and the cheap one is available first. ceo has made the working offer
// a PRECONDITION on publishing — "before the A record exists, not in the same
// change" — and that asymmetry is what this gate exists to interrupt.
//
// ---------------------------------------------------------------------------
// 🔴 WHAT THIS GATE ASSERTED UNTIL 2026-08-12, AND WHY IT WAS NOT ENOUGH.
// Three defects, and all three are the gate believing its own prose.
//
//   D1 THE GREEN MEANT "CHANGED", NOT "WORKS". The pass branch was
//      `url !== KNOWN_DEAD`, and its message said the quiet part: "not the
//      known-dead link, so a human changed it deliberately". Nothing fetched
//      anything. Point the footer at a DIFFERENT 404 and this gate went green —
//      the verdict string outran the check, and it outran it in the exact
//      direction the preamble above calls worse. FIXED: green now requires a
//      target `legal` has RULED on (SOURCE_OFFER_RULED) *and* a live answer from
//      that target. Neither alone.
//
//   D2 THE FLIP WAS CARRIED BY A COMMENT. "IT MUST BECOME A FAIL THE DAY A
//      DEPLOY TARGET EXISTS" was a sentence in the PENDING message and in the
//      budget entry, and in no code anywhere — so on the day the record appears,
//      the gate keeps pending and the flip depends on a human remembering, on
//      the side of the asymmetry where the cheap step is available first. FIXED:
//      the serving premise is probed, and a published domain is a FAIL.
//
//   D3 THE EXTRACTOR PRESUPPOSED THE ANSWER. The regex was
//      `href="(https://github\.com/...)"` — github, or nothing. But the whole
//      reason this gate does not fix the link is that the mechanism is undecided
//      and MAY NOT BE GITHUB (a tarball beside a release, a mirror, the monorepo
//      opened). Under the old regex a correct non-github offer read as "the
//      served UI carries NO source-offer link at all", which is the message for
//      a DELETED link. A gate whose extractor can only see one candidate answer
//      reports every other answer as an absence. FIXED: it reads the anchors in
//      the footer, whatever host they name, and refuses to guess when there is
//      more than one.
//
// ⚠ AND WHY THE NETWORK IS NOT SIMPLY BOLTED ON. A gate that makes a network
// request is a gate that goes red when the box is offline, and a false red
// trains the habit that defeats it — this file's own §4 reasoning. So both
// probes are CONTROLLED and THREE-VALUED, and the third value is not a pass:
//
//   - each probe first asks a control (`2bee.farm` on the DNS plane,
//     `github.com` on the HTTPS plane). If the control does not answer, the box
//     is offline or filtered and the probe returns UNCHECKED. UNCHECKED is not
//     "not-held": it reports PENDING and says which question went unanswered.
//   - ⚠ "the control answered" is NOT "the answer is meaningful" — ceo's DNS
//     watch passed its control while the resolver returned garbage for an
//     undelegated name. So the control here must return an ANSWER RECORD, not
//     merely a response, and it is queried THROUGH THE SAME RESOLVER as the
//     target so a resolver that is up for one and blind for the other cannot
//     vote. Every branch that does not need the network stays a FAIL.
//   - 🔴 NO EQUALITY TEST ACROSS RESOLVERS. `2bee.farm` answered with THREE
//     DIFFERENT ADDRESS SETS from 1.1.1.1 / 8.8.8.8 / 9.9.9.9 on 2026-08-12,
//     all correct, because CloudFront is anycast. A publish check that compared
//     resolvers would go blind to exactly the shape a publish is most likely to
//     take — a CNAME onto a CDN. This one counts ANSWERS and never compares
//     them, and takes the UNION: one resolver seeing a record is published.
//   - 🔴 THE OFFER PROBE IS ANONYMOUS, ON PURPOSE AND PERMANENTLY. The obligation
//     is to the USER of the served page, who has no credentials of ours. An
//     authenticated 200 on a private repository is the textbook green through a
//     door no real caller uses — and it is the live case here: the only
//     repository holding this source returns 404 anonymously and 200 to `gh`.
//
// ⚠ NOT COVERED, said here rather than left to be discovered: an answering URL
// is not proof that what it serves IS the Corresponding Source. This gate can
// see that the offer resolves, answers, and was ruled on; it cannot read the
// bytes and know they are the source of the running build. That is a human
// review at the ruling, not a check.
//
// MEASURED 2026-08-12 while writing this, and the reason the shape above is what
// it is: `2bee.app` does not return "no A record". All three public resolvers
// return SERVFAIL, because the domain IS DELEGATED — the `.app` registry hands
// out `christina.ns.cloudflare.com` / `rex.ns.cloudflare.com`, THE SAME PAIR
// that serves live `2bee.farm` — and those nameservers answer REFUSED, i.e. the
// zone is not (yet) in the account. `dig +short` prints nothing for that, prints
// nothing for NXDOMAIN, and prints nothing when the box is offline. Three
// different worlds, one empty string. The probe below distinguishes them by
// STATUS, not by emptiness.
//
// NEGATIVE CONTROLS: `--self-plant agpl-published`, `--self-plant
// agpl-offer-ruled`, `--self-plant agpl-offline`. The green branch cannot have
// one: a self-plant may only REMOVE greens (see SELF_PLANTS), so the pass path
// is witnessed on a COPY of this file — SLICER-GATES.md, gate AGPL.
{
  // The plants. `agpl-offer-ruled` and `agpl-offline` rule whatever the footer
  // currently carries, which is how they reach the branches beyond the ruling
  // check without this file naming a URL that nobody ruled.
  const PLANT_RULES_CURRENT = selfPlanted('agpl-offer-ruled') || selfPlanted('agpl-offline');
  const PLANT_PUBLISH = selfPlanted('agpl-published') ? 'published' : selfPlanted('agpl-offline') ? 'unchecked' : null;
  const PLANT_OFFER = selfPlanted('agpl-offline') ? 'unchecked' : null;

  const DNS_TIMEOUT = ['+time=2', '+tries=1'];

  // 🔴 AN ANSWER FROM A LYING RESOLVER IS NOT A PUBLICATION. Added 2026-08-28,
  // closing the false-red class documented on 2026-08-11 and left open since.
  //
  // A captive portal, a filtering ISP resolver or a corporate DNS box answers an
  // unregistered name with an address of its own — `10.0.0.1`, `192.168.1.1`,
  // an NXDOMAIN-hijack landing page. This probe counted ANY A/AAAA record as
  // evidence that `2bee.app` is published, and `published` + a broken §13 offer
  // is a FAIL. So a box behind a hijacking resolver would have failed AGPL for
  // a domain nobody served — a false red on the one gate whose whole job is to
  // hold a real red visible. **A false red silently edits the thing it
  // protects**: the cheapest way to make it stop is to weaken the gate.
  //
  // The filter is on ROUTABILITY, not on a blocklist of known portals: an
  // address in a private, loopback, link-local, CGNAT, documentation or
  // multicast range cannot be a host serving this work to the public internet,
  // whatever produced it. An unparseable rdata is also NOT counted — an answer
  // this probe cannot read is not an answer it may rely on.
  //
  // ⚠ IT IS APPLIED TO THE CONTROL TOO. A resolver that hijacks `2bee.farm`
  // proves nothing about `2bee.app`, so it must lose its vote rather than cast
  // one from a lie.
  const isRoutableV4 = (a) => {
    const p = a.split('.').map(Number);
    if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
    const [w, x] = p;
    if (w === 0 || w === 10 || w === 127 || w >= 224) return false;           // this-network, RFC1918, loopback, multicast/reserved
    if (w === 100 && x >= 64 && x <= 127) return false;                        // CGNAT (RFC6598)
    if (w === 169 && x === 254) return false;                                  // link-local
    if (w === 172 && x >= 16 && x <= 31) return false;                         // RFC1918
    if (w === 192 && x === 168) return false;                                  // RFC1918
    if (w === 192 && x === 0) return false;                                    // IETF protocol assignments / TEST-NET-1
    if (w === 198 && (x === 18 || x === 19)) return false;                     // benchmarking
    if (w === 198 && x === 51) return false;                                   // TEST-NET-2
    if (w === 203 && x === 0) return false;                                    // TEST-NET-3
    return true;
  };
  const isRoutableV6 = (a) => {
    const t = a.toLowerCase();
    if (t === '::' || t === '::1') return false;
    if (t.startsWith('fe8') || t.startsWith('fe9') || t.startsWith('fea') || t.startsWith('feb')) return false; // link-local
    if (t.startsWith('fc') || t.startsWith('fd')) return false;                // unique-local
    if (t.startsWith('ff')) return false;                                      // multicast
    if (t.startsWith('::ffff:')) return isRoutableV4(t.slice(7));               // v4-mapped
    if (t.startsWith('2001:db8')) return false;                                // documentation
    return true;
  };

  const dig = (resolver, name, type) => {
    const r = spawnSync('dig', [`@${resolver}`, name, type, ...DNS_TIMEOUT, '+noall', '+comments', '+answer'], {
      encoding: 'utf8',
      timeout: 10000,
    });
    // dig exits 0 on SERVFAIL and 9 on "no servers could be reached", so the
    // exit code alone cannot tell a refusing zone from a dead network. Read the
    // header status, and treat its ABSENCE as "no response", never as a
    // negative answer.
    const out = typeof r.stdout === 'string' ? r.stdout : '';
    const status = /->>HEADER<<-.*status:\s*([A-Z]+)/.exec(out)?.[1] ?? null;
    const owner = new RegExp(`^${name.replace(/\./g, '\\.')}\\.?\\s+\\d+\\s+IN\\s+(A|AAAA|CNAME)\\s+(\\S+)`, 'i');
    let answers = 0;
    let unroutable = [];
    for (const l of out.split('\n')) {
      const m = owner.exec(l);
      if (!m) continue;
      const [, rrtype, rdata] = m;
      const kind = rrtype.toUpperCase();
      // A CNAME carries no address; it is a real delegation and is counted.
      const ok = kind === 'CNAME' ? true : kind === 'A' ? isRoutableV4(rdata) : isRoutableV6(rdata);
      if (ok) answers += 1;
      else unroutable.push(rdata);
    }
    // The plant removes the filter AND supplies the lie, so the branch it
    // reaches is the one a hijacking resolver would have reached.
    if (selfPlanted('agpl-hijack-blind') && name === '2bee.app') {
      answers += 1;
      unroutable = [];
    }
    return { status, answers, unroutable, ran: !r.error };
  };
  const curlCode = (url) => {
    // A one-byte ranged GET rather than HEAD: some hosts answer 405 to HEAD, and
    // a probe that has to interpret 405 is a probe with a third meaning. No
    // credentials, no .netrc, no cookie jar — see the anonymity note above.
    const r = spawnSync(
      'curl',
      ['-sSL', '-o', '/dev/null', '-w', '%{http_code}', '-m', '8', '--connect-timeout', '5', '--retry', '0', '--range', '0-0', url],
      { encoding: 'utf8', timeout: 15000 }
    );
    const code = Number.parseInt((r.stdout ?? '').trim(), 10);
    return Number.isFinite(code) && code > 0 ? code : null;
  };

  // --- probe 1: is 2bee.app PUBLISHED? --------------------------------------
  const RESOLVERS = ['1.1.1.1', '8.8.8.8', '9.9.9.9'];
  const probePublished = () => {
    if (PLANT_PUBLISH) return { state: PLANT_PUBLISH, detail: `SELF-PLANT ${SELF_PLANT}: publish probe forced to ${PLANT_PUBLISH}` };
    const notes = [];
    const votes = [];
    for (const r of RESOLVERS) {
      const control = dig(r, '2bee.farm', 'A');
      if (control.status !== 'NOERROR' || control.answers === 0) {
        // `dig` missing from PATH and `dig` reaching nothing are both "no
        // status", and they are not the same finding — a reader who cannot tell
        // them apart will go looking for a network fault that is a missing tool.
        notes.push(
          `${r}: control 2bee.farm ${control.ran ? (control.status ?? 'no response') : 'DIG NOT ON PATH'} / ${control.answers} routable answer(s)` +
            (control.unroutable.length ? ` [${control.unroutable.length} UNROUTABLE answer(s) discarded: ${control.unroutable.join(' ')} — this resolver is answering with addresses that cannot serve anything]` : '') +
            ' — NO VOTE'
        );
        continue;
      }
      const t = dig(r, '2bee.app', 'A');
      votes.push(t);
      notes.push(
        `${r}: control ok (${control.answers} answers), 2bee.app ${t.status ?? 'no response'} / ${t.answers} routable answer(s)` +
          (t.unroutable.length ? ` [${t.unroutable.length} UNROUTABLE answer(s) DISCARDED: ${t.unroutable.join(' ')} — a private/loopback/CGNAT address is a lying resolver, not a publication]` : '')
      );
    }
    const detail = notes.join('; ');
    if (votes.length === 0) return { state: 'unchecked', detail: `no resolver answered the CONTROL name, so nothing here measures 2bee.app — ${detail}` };
    if (votes.some((v) => v.answers > 0)) return { state: 'published', detail };
    if (votes.every((v) => v.status === 'NXDOMAIN' || v.status === 'NOERROR')) return { state: 'not-served', detail: `definite negative on every voting resolver — ${detail}` };
    // SERVFAIL and friends: the recursors cannot say. That is today's state and
    // it is NOT a negative answer, so it is escalated to the plane the
    // obligation actually lives on rather than being read as "no record".
    const code = curlCode('https://2bee.app/');
    if (code !== null) return { state: 'published', detail: `DNS was indefinite but https://2bee.app/ ANSWERED ${code} — ${detail}` };
    const control = curlCode('https://github.com/');
    if (control !== null) return { state: 'not-served', detail: `DNS indefinite on every voting resolver and https://2bee.app/ unreachable while the HTTPS control answered ${control} — ${detail}` };
    return { state: 'unchecked', detail: `DNS indefinite and the HTTPS control did not answer either, so "unreachable" here means nothing — ${detail}` };
  };

  // --- probe 2: does the OFFER answer? --------------------------------------
  const probeOffer = (url) => {
    if (PLANT_OFFER) return { state: PLANT_OFFER, detail: `SELF-PLANT ${SELF_PLANT}: offer probe forced to ${PLANT_OFFER}` };
    const code = curlCode(url);
    if (code !== null && code < 400) return { state: 'answers', detail: `anonymous ranged GET -> HTTP ${code}` };
    const control = curlCode('https://github.com/');
    if (code !== null) return { state: 'dead', detail: `anonymous ranged GET -> HTTP ${code} (control github.com -> ${control ?? 'no answer'})` };
    if (control !== null) return { state: 'dead', detail: `no HTTP response at all, while the control github.com answered ${control} — the offer's host does not answer this box` };
    return { state: 'unchecked', detail: 'no HTTP response and the control did not answer either — this box has no HTTPS egress, so nothing was measured' };
  };

  // --- the offer link, read WITHOUT presupposing its host --------------------
  //
  // 🔴 EVERY SURFACE THAT RENDERS THE OFFER, NOT JUST THE FOOTER. This block
  // read `App.tsx`'s `<footer>` and nothing else until 2026-08-27, while
  // `web/src/AuthGate.tsx` carried a SECOND live `<a href>` to the same dead
  // repository — on the LOGIN SCREEN, which is the only page an unauthenticated
  // visitor of a Cognito-configured deployment ever sees, i.e. exactly the
  // person §13 is about.
  //
  // ⚠ THE README ALREADY RECORDS THIS EXACT DEFECT AS RETIRED: *"It reads the
  // served UI only, so the second copy of the dead URL — the one in
  // `Cargo.toml`, now removed — was never in its field of view. Fixing the
  // footer alone would have turned it green with a stale copy still in the
  // tree."* The `Cargo.toml` copy was removed; a new one grew in a React
  // component four days later and the gate's scope did not follow. **A gate
  // narrowed to the one place a defect was found stays narrow.**
  //
  // So: the surfaces are DECLARED, they must AGREE, and a sweep looks for the
  // offer URL anywhere else under `web/src` — keyed on the URL the surfaces
  // themselves report plus the known-dead one, so it follows a correction
  // instead of having to be re-aimed at it. `App.tsx`'s grblHAL wiki links are
  // untouched by that needle, which is why the sweep is not "any github link".
  const OFFER_SURFACES = [
    {
      file: 'web/src/App.tsx',
      what: 'the app footer',
      // The footer element, so a link elsewhere in an 11k-line file is not read
      // as the offer.
      region: (t) => {
        const a = t.indexOf('<footer');
        const b = t.indexOf('</footer>', a + 1);
        return a >= 0 && b > a ? t.slice(a, b) : null;
      },
    },
    {
      file: 'web/src/AuthGate.tsx',
      what: 'the login screen',
      // The licence line. Named by class rather than by position: this file is
      // short, and anchoring on a line number is how a gate stops reading the
      // thing it was aimed at.
      region: (t) => {
        const a = t.indexOf('auth-gate-licence');
        return a >= 0 ? t.slice(a, t.indexOf('</p>', a) + 4) : null;
      },
    },
  ];

  const surfaceProblems = [];
  const seenUrls = new Map();
  for (const surf of OFFER_SURFACES) {
    const path = join(ROOT, surf.file);
    if (!existsSync(path)) {
      surfaceProblems.push(`DEAD INSTRUMENT: ${surf.file} does not exist, so ${surf.what} was not read`);
      continue;
    }
    const text = readFileSync(path, 'utf8');
    const region = surf.region(text);
    if (region === null) {
      surfaceProblems.push(
        `DEAD INSTRUMENT: no offer region found in ${surf.file}, so ${surf.what} was NOT READ — ` +
          'an offer this gate cannot find is not an offer it has checked'
      );
      continue;
    }
    let found = [...region.matchAll(/href="(https?:\/\/[^"]+)"/g)].map((x) => x[1]);
    /* The negative control for the limb that made this a list of surfaces
       rather than one file. It corrupts the SECOND surface only, so a run in
       which the two agree by accident cannot swallow it. */
    if (selfPlanted('agpl-surface-divergent') && surf.file === 'web/src/AuthGate.tsx') {
      found = found.map(() => 'https://example.invalid/planted-second-offer');
    }
    if (found.length !== 1) {
      surfaceProblems.push(
        `${surf.what} (${surf.file}) carries ${found.length} link(s) where the offer must be exactly one` +
          (found.length ? `: ${found.join(', ')}` : '')
      );
      continue;
    }
    seenUrls.set(surf.what, found[0]);
  }

  const distinct = [...new Set(seenUrls.values())];
  if (distinct.length > 1) {
    surfaceProblems.push(
      `THE SURFACES DISAGREE — ${[...seenUrls].map(([w, u]) => `${w} -> ${u}`).join(' | ')}. One work, one ` +
        'Corresponding Source: two offers means at least one user is handed a link to something that is not it'
    );
  }
  const url = distinct.length === 1 ? distinct[0] : null;

  // The sweep: a third copy anywhere else under web/src. Keyed on the URL the
  // surfaces report AND on the known-dead one, so a half-done correction — the
  // footer fixed, a component missed — cannot read as clean.
  {
    const needles = new Set([AGPL_KNOWN_DEAD, ...distinct]);
    const declared = new Set(OFFER_SURFACES.map((s) => s.file));
    const stack = ['web/src'];
    while (stack.length) {
      const rel = stack.pop();
      for (const e of readdirSync(join(ROOT, rel), { withFileTypes: true })) {
        const kid = `${rel}/${e.name}`;
        if (e.isDirectory()) {
          stack.push(kid);
          continue;
        }
        if (!/\.(tsx?|html)$/.test(e.name)) continue;
        let t = readFileSync(join(ROOT, kid), 'utf8');
        // 🔴 A DECLARED FILE IS EXEMPT FOR ITS REGION, NOT FOR ITS WHOLE LENGTH.
        // This read `|| declared.has(kid)` until 2026-08-27, which skipped all
        // 11k lines of `App.tsx` because its `<footer>` is a declared surface —
        // so a second offer anchor anywhere else in that file was invisible to
        // BOTH limbs and AGPL would go green on it. That is this widening's own
        // stated defect ("a gate narrowed to the one place a defect was found
        // stays narrow") reproduced one level in, in the same commit that wrote
        // the sentence. The region is blanked out and the REST of the file is
        // swept like any other.
        const dec = OFFER_SURFACES.find((x) => x.file === kid);
        if (dec) {
          const region = dec.region(t);
          if (!region) {
            /* 🔴 A DECLARED FILE WHOSE REGION VANISHED MUST NOT BE SWEPT AS AN
               UNDECLARED ONE. It already fails above as a DEAD INSTRUMENT; if it
               also fell through to here the sweep would tell the fixer to
               *"Declare it in OFFER_SURFACES"* — a list it is already on — which
               is a true finding pointing at the wrong repair. Rename `<footer>`
               to a component and that is the sentence the gate would print. */
            continue;
          }
          /* Cut the region OUT BY POSITION, not by value. `split(region).join('')`
             removes EVERY occurrence, so a byte-identical duplicate of the footer
             elsewhere in the file would delete itself along with the original and
             hide the copy this sweep exists to find. */
          const at = t.indexOf(region);
          t = t.slice(0, at) + t.slice(at + region.length);
        }
        for (const nd of needles) {
          if (t.includes(`href="${nd}"`)) {
            surfaceProblems.push(
              `${kid} renders the §13 offer (${nd}) and is NOT a declared surface, so this gate has never ` +
                'read it. Declare it in OFFER_SURFACES or remove the link — an unwatched copy is how the ' +
                'last one survived a correction'
            );
          }
        }
      }
    }
  }

  const pub = probePublished();
  const premise =
    pub.state === 'published'
      ? `🔴 2bee.app IS PUBLISHED — §13 HAS ATTACHED [${pub.detail}]`
      : pub.state === 'not-served'
        ? // ⚠ SAY WHICH LIMB WAS MEASURED. This sentence used to read "nothing
          // is served (every listener loopback; 2bee.app does not resolve)" and
          // the loopback half was an ASSERTION — no listener is enumerated
          // anywhere in this file. Carrying an unmeasured limb inside a measured
          // one is the defect this whole block was rewritten for, one clause
          // along, and the fix is to name the limb rather than to widen the probe.
          `2bee.app does not resolve, so it is not served under that name [${pub.detail}]. NOT MEASURED HERE: ` +
          `whether some other listener serves this work (the dev servers bind loopback; nothing enumerates them)`
        : `⚠ THE SERVING PREMISE IS UNCHECKED, WHICH IS NOT "IT HOLDS" [${pub.detail}]`;
  const served = pub.state === 'published';
  const ruled = url !== null && Object.prototype.hasOwnProperty.call(SOURCE_OFFER_RULED, url) ? SOURCE_OFFER_RULED[url] : PLANT_RULES_CURRENT && url ? { why: `SELF-PLANT ${SELF_PLANT}`, since: '—', ruling: `SELF-PLANT ${SELF_PLANT}` } : null;

  if (surfaceProblems.length) {
    // 🔴 EVERY ONE OF THESE IS A FAIL, INCLUDING THE "DEAD INSTRUMENT" ONES.
    // A gate that could not find the offer and a gate that found a good one
    // must not print the same word — and the surfaces disagreeing is the
    // defect this block was widened for, so it may not degrade to a pending
    // that lands in the same budgeted INCOMPLETE as the status quo.
    fail(
      'AGPL',
      `${surfaceProblems.length} problem(s) with the OFFER SURFACES themselves: ${surfaceProblems.join(' | ')}. ` +
        `${premise}`
    );
  } else if (url === null) {
    fail('AGPL', `the served UI carries NO source-offer link at all — §13 requires the source to be offered to every user. ${premise}`);
  } else if (!ruled && url !== AGPL_KNOWN_DEAD) {
    // 🔴 A FAIL WHETHER OR NOT ANYTHING IS SERVED, and the asymmetry with the
    // branch below is deliberate. The known-dead link is the DECLARED status
    // quo: a recorded, tracked, budgeted problem, and pending holds it visible.
    // A link that is neither the declared one nor a ruled one is somebody
    // CHANGING a licence-obligation-bearing artefact without the decision that
    // governs it — a new defect, introduced by whoever is committing right now,
    // fully decidable on this box with no network at all. This gate RAN and
    // answered; the file's own doctrine reserves PENDING for a check that
    // could not run, and a pending here would land in the same budgeted
    // INCOMPLETE as the status quo and read as "no change".
    fail(
      'AGPL',
      `the offer points at ${url}, and NO RULING NAMES IT. Changing the link is not fixing the offer: the ` +
        `target IS the Corresponding Source mechanism and that decision is legal's — this is the branch that ` +
        `used to award a PASS for the link merely having CHANGED, which a different 404 satisfies. Add it to ` +
        `SOURCE_OFFER_RULED with the ruling that authorised it, or put the declared link back. ${premise}`
    );
  } else if (!ruled) {
    // 🔴 THIS SENTENCE WENT STALE THE HOUR `legal` RULED, AND IT IS THE EXPENSIVE
    // KIND. It asserted *"legal has not ruled on the mechanism, so
    // SOURCE_OFFER_RULED is empty"* — true from 2026-08-10 until 2026-09-04 and
    // FALSE afterwards, while still reading as a careful, current explanation.
    // The register is no longer empty; the footer simply points somewhere else.
    // A stale red is as expensive as a stale green and harder to find, because
    // nobody re-reads a row that already admits it is uncovered.
    const ruledCount = Object.keys(SOURCE_OFFER_RULED).length;
    const unruled =
      `the offer points at ${url}, measured 404 anonymously, and the only real repository is PRIVATE — it ` +
      `delivers nothing to a user either way. ` +
      (ruledCount === 0
        ? 'legal has not ruled on the mechanism, so SOURCE_OFFER_RULED is empty and NO link can make this gate green today.'
        : `⚠ legal HAS ruled (${ruledCount} target(s) in SOURCE_OFFER_RULED: ${Object.keys(SOURCE_OFFER_RULED).join(', ')}) — ` +
          'so the blocker is no longer the DECISION, it is that the footer does not carry the ruled target and the ' +
          'ruled target does not answer yet. Pointing the footer at it does NOT discharge §13 on its own: the ' +
          'mirror has to exist and answer anonymously first, and publishing it is founder-gated.');
    if (served) {
      fail('AGPL', `🔴 §13 HAS ATTACHED AND THE OFFER IS THE KNOWN-DEAD ONE. ${unruled} ${premise}`);
    } else {
      results.push({
        id: 'AGPL',
        state: 'PENDING',
        msg: `${unruled} ${premise} — so §13 has not attached, and this gate holds the broken offer visible rather than guessing a fix.`,
      });
    }
  } else {
    const off = probeOffer(url);
    const ruling = `ruled ${ruled.since} (${ruled.ruling})`;
    if (off.state === 'answers') {
      pass('AGPL', `the source offer points at ${url}, ${ruling}, and it ANSWERS: ${off.detail}. ${premise}. NOT COVERED: that what it serves is the Corresponding Source of this build`);
    } else if (off.state === 'dead') {
      fail('AGPL', `🔴 THE OFFER IS RULED AND DEAD — ${url}, ${ruling}, ${off.detail}. A link that looks compliant and delivers nothing is the failure this gate exists for. ${premise}`);
    } else {
      results.push({
        id: 'AGPL',
        state: 'PENDING',
        msg: `⚠ UNCHECKED, NOT PASSED: ${url} is ${ruling}, and this box could not measure whether it answers — ${off.detail}. An offline box does not get to certify a source offer. ${premise}`,
      });
    }
  }
}

// --- SPLNT: the harness's own controls must still control ------------------
//
// 🔴 THE GAP THIS CLOSES IS `PLANT`'s FOUNDING FAILURE, ONE REGISTRY ALONG.
// `PLANT` audits the 20 `--plant` PRODUCT plants and NOTHING audited the
// `--self-plant` HARNESS controls. A self-plant is a negative control on a
// GATE: apply it and a named gate must go red. If the code it patches has
// moved, its needle has been absorbed, or its branch was refactored away, then
// it applies, reports success, AND NOTHING REDDENS — which reads as "the gate
// is fine" when the truth is "the control is dead".
//
// 🔴 AND THE ONE GUARD THAT EXISTED WAS BLIND ON THIS TREE, WHICH IS WHY THIS
// IS A GATE AND NOT A HABIT. The foot of this file refuses to print
// `VERDICT: GO` under a self-plant, reasoning that a plant which leaves the run
// clean planted nothing. That guard compares against an ABSOLUTE — the string
// `GO` — and NOT against the clean baseline, so it can only fire on a tree
// where every gate is already green. CAD1H and CADT have been red here for
// days. Measured 2026-08-12: the clean `--quick` run prints NO-GO, and so do
// ALL 31 self-planted runs. `door-same-door`'s own lesson, arriving one level
// up: "they agree" and "only one was driven" produce the same number, and only
// one of them is a pass.
//
// ⚠ TWO LIMBS, COVERING DIFFERENT SUBSETS, and this gate says which — a check
// that covers a subset and does not name it is a green reading wider than it is.
//
//   STATIC — EVERY pass, milliseconds. Every registry entry has a CONTRACT
//   naming the gate(s) it must move; every named gate exists in `GATES`; every
//   entry has a LITERAL `selfPlanted('<name>')` or `SELF_PLANT === '<name>'`
//   call site in this file, and every such call site is registered. Keyed to
//   the CODE, never to prose: delete a branch and its entry goes red, rename a
//   gate and its contract goes red, rename `selfPlanted` and all 33 go red at
//   once. 🔴 WHAT IT CANNOT SEE: a call site that still exists and no longer
//   does anything. That is the whole reason the second limb exists.
//
//   DRIVE — FULL PASS ONLY, measured 22.8 min. Every entry is driven as a
//   `--quick` child and its declared targets must MOVE relative to a clean
//   baseline measured IN THE SAME INVOCATION. Nothing is compared against a
//   remembered number. See PENDING_BUDGET.SPLNT for the cost and for what
//   `--quick` gives up; it is not sampled.
//
// 🔴 WHY TWO BASELINES AND NOT ONE. Everything below is a DIFFERENCE test —
// planted row vs clean row, state AND message — so it is sound only over a
// channel where two clean runs agree. A row that moves by itself would read as
// "the plant bit" for a plant that did nothing, which is the exact reading this
// gate exists to refuse. (Measured 2026-08-12 before writing it: three clean
// `--quick` runs produced byte-identical rows for all 58.)
//
// 🔴 HOW THIS GATE WOULD ANNOUNCE ITS OWN DEATH — asked plainly, because a
// checker that audits controls is itself a control:
//   - block deleted or throwing → the `PRODUCED NO RESULT` backstop below fails
//     it. A gate that does not report is not a gate that passed.
//   - row removed from SLICER-GATES.md → `GDOC`'s roster limb.
//   - the STATIC limb going permissive → `--self-plant splant-orphan`, which
//     audits a name with no call site and must redden this gate. It is driven
//     by DRIVE one level deep, with no recursion: children run `--quick`, where
//     DRIVE is a budgeted PENDING.
//   - a child that will not spawn, is refused (exit 2), or emits no row line →
//     DEAD INSTRUMENT, a FAIL. "No differences found" and "nothing was
//     measured" must not print the same word.
//   - 🔴 THE ONE IT CANNOT ANNOUNCE, NAMED RATHER THAN LEFT TO BE FOUND: the
//     DRIVE comparison itself going permissive has NO in-gate negative control,
//     because that control would have to be a self-plant and driving it would
//     mean a child that itself runs DRIVE — 34 grandchildren per plant, ~12 h.
//     It is witnessed OUT OF BAND, on copies of this file with one surgical
//     neutering each, and the transcripts are in SLICER-GATES.md under SPLNT.
//     If that comparison is later loosened, this gate will not tell you; the
//     document is the only record that it was ever tight.
//   - ⚠ AND ONE MORE: this gate cannot tell a self-plant that was RETIRED from
//     one that was DELETED — both leave a smaller registry with no orphan. It
//     PRINTS the audited set on every pass so the change is at least visible in
//     a diff, and does not gate on the count, because a hand-maintained number
//     is a false red waiting to happen.
{
  const problems = [];
  const notes = [];
  const names = Object.keys(SELF_PLANTS);
  // 🔴 THE FLOOR. Everything below is `.every()`-shaped and therefore vacuously
  // true over an empty list; without this, an emptied registry PASSES while
  // printing "All 0 self-plant(s) have a contract". See REGISTRY_FLOOR.
  if (names.length < REGISTRY_FLOOR.SPLNT) {
    problems.push(
      `REGISTRY SHRANK: ${names.length} self-plant(s) against a floor of ${REGISTRY_FLOOR.SPLNT}. Every check ` +
        'below is satisfied vacuously by a shorter list, so a control that disappears takes its own alarm with ' +
        'it. If a control was retired on purpose, lower REGISTRY_FLOOR.SPLNT in the same commit and say which.'
    );
  }

  // --- LIMB A (STATIC) — contract, roster, call site. Runs on EVERY pass. ----
  const gateIds = new Set(GATES.map((g) => g[0]));
  for (const id of SELF_PLANT_DERIVATIVE) {
    if (!gateIds.has(id)) problems.push(`SELF_PLANT_DERIVATIVE names \`${id}\`, which is not a gate — an exemption that outlived the thing it exempts`);
  }
  for (const n of names) {
    const c = SELF_PLANT_TARGETS[n];
    if (!c) {
      problems.push(
        `\`${n}\` is registered in SELF_PLANTS with NO CONTRACT in SELF_PLANT_TARGETS — nothing can drive it, so ` +
          'nothing would notice it going inert. That was the state of all 31 of them until 2026-08-12'
      );
      continue;
    }
    if (!Array.isArray(c.moves) || c.moves.length === 0) {
      problems.push(`\`${n}\`'s contract names no gate in \`moves\` — a control that reddens nothing in particular reddens nothing`);
    }
    for (const id of [...(c.moves ?? []), ...Object.keys(c.masked ?? {})]) {
      if (!gateIds.has(id)) {
        problems.push(
          `\`${n}\`'s contract names gate \`${id}\`, which is not in GATES — the gate was renamed or retired and its ` +
            'negative control now points at nothing. THIS is the limb keyed to something that moves when the target ' +
            'moves; the description beside the plant is prose and cannot be'
        );
      }
    }
  }
  for (const n of Object.keys(SELF_PLANT_TARGETS)) {
    if (!names.includes(n)) problems.push(`SELF_PLANT_TARGETS contracts \`${n}\`, which is not a registered self-plant — the two registries have drifted`);
  }

  // Only LITERAL call sites count. This gate builds its children's arguments
  // FROM the registry, so its own spawn cannot satisfy this limb on a branch's
  // behalf: the question is whether a REAL branch still reads the flag.
  const splntSrc = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const cited = new Set([
    ...[...splntSrc.matchAll(/selfPlanted\('([a-z0-9-]+)'\)/g)].map((m) => m[1]),
    ...[...splntSrc.matchAll(/SELF_PLANT === '([a-z0-9-]+)'/g)].map((m) => m[1]),
  ]);
  // `--self-plant splant-orphan` models the failure this limb exists for: a
  // registry entry whose branch was refactored away. The flag stays accepted,
  // and it patches nothing.
  for (const n of names.concat(selfPlanted('splant-orphan') ? ['splant-ghost'] : [])) {
    if (!cited.has(n)) {
      problems.push(
        `ORPHAN: \`${n}\` is registered and has NO LITERAL CALL SITE in this file — no \`selfPlanted('${n}')\`, no ` +
          `\`SELF_PLANT === '${n}'\`. The branch it patched is gone, so the flag is accepted, the run reports success ` +
          'and nothing reddens'
      );
    }
  }
  for (const c of cited) {
    if (!names.includes(c)) {
      problems.push(
        `this file branches on \`selfPlanted('${c}')\` and \`${c}\` is NOT registered — the flag parser refuses that ` +
          'name with exit 2, so the branch is unreachable and reads as covered'
      );
    }
  }

  // --- LIMB B (DRIVE) — full pass only. Every plant must MOVE its target. ----
  const driveWanted = !QUICK && !SPLNT_CHILD;
  let driveMsg = '';
  if (driveWanted) {
    const t0 = Date.now();
    const RANK = { PASS: 0, PENDING: 1, FAIL: 2 };
    const self = fileURLToPath(import.meta.url);
    const child = (args) => {
      const r = spawnSync(process.execPath, [self, '--quick', ...args], {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 128 * 1024 * 1024,
        env: { ...process.env, SLICER_GATE_SPLNT_CHILD: '1' },
      });
      if (r.status === 2) return { dead: `the runner REFUSED the invocation (exit 2): ${(r.stderr ?? '').trim().split('\n')[0]}` };
      const line = (r.stdout ?? '').split('\n').find((l) => l.startsWith(SPLNT_ROWS_TAG));
      if (!line) {
        return {
          dead:
            `the child emitted no \`${SPLNT_ROWS_TAG.trim()}\` line (exit ${r.status}) — NOTHING WAS MEASURED, and ` +
            'that must not print the same word as "nothing was found"',
        };
      }
      let parsed;
      try {
        parsed = JSON.parse(line.slice(SPLNT_ROWS_TAG.length));
      } catch (e) {
        return { dead: `the child's row line did not parse: ${e.message}` };
      }
      if (!Array.isArray(parsed.rows) || parsed.rows.length < GATES.length - 1) {
        return { dead: `the child reported ${parsed.rows?.length ?? 0} row(s) for ${GATES.length} gates — a truncated scorecard cannot be differenced` };
      }
      return {
        row: new Map(parsed.rows.map(([id, state, msg]) => [id, `${state} ${msg}`])),
        state: new Map(parsed.rows.map(([id, state]) => [id, state])),
        verdict: parsed.verdict,
      };
    };

    // ── THE TREE THIS LIMB MEASURES IS SHARED, AND IT MOVES UNDER IT ───────
    //
    // 🔴 THE DEFECT THIS CLOSES, MEASURED 2026-08-27. This limb reported 25
    // problems and every one of them read `<plant>: also moved CADT, which its
    // contract does not declare`. NO PLANT MOVED CADT. `web/tests/auth.test.ts`
    // — untracked, written by another session at 17:11:56 — landed BETWEEN the
    // clean baseline and the children, and CADT's row prints the file set it
    // DISCOVERED and its suite total, so the row went `54 file(s) … 922 passed`
    // in the baseline and `55 … 926` in every child after that minute.
    //
    // The comparison is TEXTUAL, so a concurrent write is indistinguishable
    // from a plant with an undeclared blast radius — and the fix this limb
    // printed ("declare it or narrow the plant") would have written a blast
    // radius that does not exist into 25 contracts and blinded the check.
    //
    // ⚠ `noisy` already existed for exactly this shape and could not see it:
    // two clean baselines taken back-to-back at minute 0 cannot disagree about
    // a file that arrives at minute 12. THE NOISE IS IN TIME, NOT IN THE RUNS.
    // So the baseline is taken at BOTH ENDS — b1/b2 before, b3 after — and any
    // row that drifted across the window is unmeasurable for this pass, on the
    // same terms a row two simultaneous baselines disagree on already was.
    //
    // 🔴 THE FINGERPRINT IS NOT THE DETECTOR — b3 IS. It exists to NAME THE
    // CAUSE. "CADT is noisy" sends the next reader into CADT; "auth.test.ts
    // appeared mid-run" sends them to the session that wrote it. A finding
    // nobody can act on is a finding that gets switched off.
    const fingerprint = () => {
      const seen = new Map();
      const walk = (rel, depth) => {
        const abs = join(ROOT, rel);
        if (!existsSync(abs)) return;
        for (const e of readdirSync(abs, { withFileTypes: true })) {
          if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'target') continue;
          const kid = `${rel}/${e.name}`;
          if (e.isDirectory()) {
            if (depth > 0) walk(kid, depth - 1);
            continue;
          }
          try {
            const st = statSync(join(ROOT, kid));
            seen.set(kid, `${st.size}:${st.mtimeMs}`);
          } catch {
            /* vanished between readdir and stat — that IS the finding, and the
             * missing key is how the diff below reports it. */
          }
        }
      };
      // 🔴 THE LIST IS THE INPUTS THE GATE ROWS MEASURE, NOT "the source tree".
      // A path missing from here does not break the DISCARD — b3 and the
      // per-child check are keyed on gate rows, not on files — but it breaks
      // the EXPLANATION, and the wrong explanation here is an accusation: with
      // no changed path to name, the note says the row is "genuinely unstable",
      // which blames the gate for someone else's write. `web/src/wasm` and
      // `cli/src` are on the list because K3 and STALE fingerprint them, and
      // `playwright.config.ts` because I1 is a different measurement under a
      // different `workers` value.
      for (const d of ['web/tests', 'web/e2e', 'web/src', 'web/src/wasm', 'core/src', 'cli/src', 'wasm/src', 'gates']) walk(d, 1);
      for (const f of ['web/playwright.config.ts', 'web/package.json', 'Cargo.toml', 'core/Cargo.toml']) {
        try {
          const st = statSync(join(ROOT, f));
          seen.set(f, `${st.size}:${st.mtimeMs}`);
        } catch {
          /* absent is a state too — the missing key is the diff. */
        }
      }
      return seen;
    };
    const fpBefore = fingerprint();
    /** What moved between two fingerprints, as paths a reader can chase. */
    const fpDiff = (before, after) => {
      const out = [];
      for (const [k, v] of after) if (before.get(k) !== v) out.push(before.has(k) ? `${k} (edited)` : `${k} (appeared)`);
      for (const k of before.keys()) if (!after.has(k)) out.push(`${k} (removed)`);
      return out;
    };

    const b1 = child([]);
    const b2 = child([]);
    if (b1.dead || b2.dead) {
      problems.push(`DEAD INSTRUMENT — the clean baseline could not be measured: ${b1.dead ?? b2.dead}`);
    } else {
      const noisy = new Set();
      for (const [id, v] of b1.row) if (b2.row.get(id) !== v) noisy.add(id);
      if (noisy.size) notes.push(`NOISY ROW(S): two clean runs of one tree disagreed on ${[...noisy].join(', ')}`);
      // Every undeclared move is HELD, never reported inside the loop, until the
      // closing baseline has said which rows were measurable at all. Reporting
      // as we went is what attributed one concurrent write to 25 innocent plants.
      const heldUndeclared = [];

      for (const n of names) {
        const contract = SELF_PLANT_TARGETS[n] ?? { moves: [] };
        // 🔴 THE TREE IS CHECKED BEFORE EVERY CHILD, NOT ONLY AT THE ENDS.
        //
        // The b1-vs-b3 window catches drift that PERSISTS. It is blind to drift
        // that reverts — a file edited at minute 20 and edited back at minute 40
        // leaves b1 and b3 agreeing while every child in between measured a
        // different tree. Measured on the run that wired this: `STALE`, `K3`,
        // `G2`, `MULTI`, `TOOL`, `DOOR` and `FLAG` were reported as the blast
        // radius of four plants, on a pass in which another session rebuilt the
        // wasm and then edited `core/src/job.rs` — none of those plants touches
        // any of those gates, and b3 could not see it because the fingerprints
        // had settled again by the end.
        // 🔴 THE WINDOW IS THE CHILD'S OWN RUN, NOT "EVERYTHING SINCE THE
        // START". Corrected 2026-08-27, hours after the per-child check was
        // added sampling `fpDiff(fpBefore, …)` BEFORE the child — which was
        // wrong in two ways at once:
        //
        //   OFF BY ONE, IN THE WRONG DIRECTION. A write landing DURING child N
        //   was invisible to child N's own flag and first appeared in N+1's.
        //   The child whose measurement was actually corrupted was the one
        //   marked clean, and an innocent successor wore it.
        //
        //   STICKY. The diff was always against `fpBefore`, so one touched file
        //   at minute 2 of a 50-minute pass marked EVERY remaining child
        //   mutated — which turns the undeclared-move detector off for the rest
        //   of the run (`if (muts.length) continue`) while SPLNT still goes red.
        //   Red every pass, for a reason nobody can act on, with the real
        //   detector silently disabled: the exact shape that teaches people to
        //   stop reading a gate.
        //
        // Bracketing the child straddles the write instead of accumulating it.
        const fpPre = fingerprint();
        const r = child(['--self-plant', n]);
        const childMutations = fpDiff(fpPre, fingerprint());
        if (r.dead) {
          problems.push(`\`${n}\`: DEAD INSTRUMENT — ${r.dead}`);
          continue;
        }
        if (r.verdict === 'GO') problems.push(`\`${n}\`: the self-planted run printed VERDICT: GO, which the foot of this file forbids`);
        const moved = new Set([...r.row.keys()].filter((id) => b1.row.get(id) !== r.row.get(id) && !noisy.has(id)));

        for (const id of contract.moves ?? []) {
          // A child that straddled a write cannot tell its own effect from the
          // writer's — in EITHER direction. Accusing it of planting nothing, or
          // of getting better, is the same unattributable claim the undeclared
          // limb already discards; it is reported once, below, as UNMEASURABLE.
          if (childMutations.length) break;
          if (noisy.has(id)) {
            problems.push(
              `\`${n}\`: its target \`${id}\` is a NOISY row on this box — two clean runs of the same tree disagreed ` +
                'there, so a difference on it proves nothing. UNMEASURABLE, which is not passing'
            );
          } else if (!moved.has(id)) {
            problems.push(
              `\`${n}\`: PLANTED NOTHING on its declared target \`${id}\` — that row is byte-identical to the clean ` +
                `baseline, where it was ${b1.state.get(id) ?? '—'}. The control applies, reports success and reddens ` +
                'nothing, which is indistinguishable from a gate that is fine'
            );
          } else {
            const before = RANK[b1.state.get(id)] ?? -1;
            const after = RANK[r.state.get(id)] ?? -1;
            if (after < before) {
              problems.push(
                `\`${n}\`: its target \`${id}\` got BETTER under the plant (${b1.state.get(id)} -> ${r.state.get(id)}) — ` +
                  'a self-plant may only remove greens'
              );
            }
          }
        }

        // A `masked` exemption is checked in BOTH directions so it cannot
        // outlive its reason: the gate must still be failing for the unrelated
        // cause, and the plant must still be unable to move it.
        //
        // 🔴 AND IT IS GATED ON THE SAME MUTATION CHECK AS THE LOOP ABOVE, which
        // it was not until 2026-08-27. The `break` was added to the declared-target
        // loop and this one three lines below kept asserting on the same `moved`
        // set — so a concurrent write that flipped a masked row made SPLNT tell
        // somebody to delete a LIVE exemption on the writer's evidence. That is
        // the exact class the fix was written to remove ("one child can no longer
        // carry both a verdict and its own retraction"), surviving because the
        // guard was applied to one of the two limbs that read `moved`.
        for (const [id, why] of Object.entries(contract.masked ?? {})) {
          if (b1.state.get(id) !== 'FAIL') {
            problems.push(
              `\`${n}\`: its \`masked\` exemption on \`${id}\` says the limb is unreachable behind an existing red, and ` +
                `\`${id}\` is ${b1.state.get(id)} in the clean baseline. THE PREMISE IS GONE — move \`${id}\` into ` +
                `\`moves\` and prove it. Recorded reason: ${why}`
            );
          } else if (moved.has(id) && !childMutations.length) {
            /* 🔴 ONLY THIS BRANCH NEEDS THE MUTATION GUARD, and gating the WHOLE
               loop on it (as the first attempt did, 2026-08-27) silently turned
               off the other one. The branch above reads `b1` — the OPENING
               baseline, measured before any child ran — so a write during child
               N cannot corrupt it, and "this exemption's premise is gone" stays
               answerable on a busy tree. The over-broad guard meant that on any
               pass where any fingerprinted file moved, which is the normal state
               of this tree, the premise check did not run AND NOTHING SAID SO:
               the mutation note speaks only of undeclared moves. A stale
               exemption then reads exactly like a live one, which is this row's
               own stated failure. */
            problems.push(
              `\`${n}\`: its \`masked\` exemption on \`${id}\` is STALE — the plant DID move that row. An exemption ` +
                'that outlives the thing it exempts reads exactly like a live one'
            );
          }
        }

        const undeclared = [...moved].filter(
          (id) => !(contract.moves ?? []).includes(id) && !Object.prototype.hasOwnProperty.call(contract.masked ?? {}, id)
        );
        heldUndeclared.push([n, undeclared, childMutations]);
      }

      // ── THE CLOSING BASELINE ────────────────────────────────────────────
      // Same invocation, same tree, no plant. A row that does not match the
      // OPENING baseline drifted for a reason no plant supplied, and every
      // "undeclared move" on it is unattributable — including the ones that are
      // real, which is why this is UNMEASURABLE and not an all-clear.
      const b3 = child([]);
      const drifted = new Set();
      if (b3.dead) {
        problems.push(
          `DEAD INSTRUMENT — the CLOSING clean baseline could not be measured: ${b3.dead}. Without it there is no ` +
            'way to tell a plant\'s blast radius from a concurrent write, and that difference is the whole limb'
        );
      } else {
        for (const [id, v] of b1.row) if (b3.row.get(id) !== v) drifted.add(id);
      }

      const changedPaths = fpDiff(fpBefore, fingerprint());

      if (drifted.size) {
        const why = changedPaths.length
          ? `${changedPaths.length} file(s) under the measured tree changed during this ${((Date.now() - t0) / 60000).toFixed(1)}-minute pass: ${changedPaths.slice(0, 6).join(', ')}${changedPaths.length > 6 ? ` …+${changedPaths.length - 6} more` : ''}`
          : 'nothing under web/tests, web/e2e, web/src, core/src or gates changed, so this is NOT a concurrent write and the row is genuinely unstable — a defect in that row, not in this limb';
        notes.push(
          `DRIFTED MID-PASS, so every undeclared move on ${[...drifted].join(', ')} is UNATTRIBUTABLE and was ` +
            `DISCARDED (which is not an all-clear on them): ${why}`
        );
      } else if (changedPaths.length) {
        notes.push(
          `${changedPaths.length} file(s) changed under the measured tree during this pass and NO gate row moved ` +
            `with them: ${changedPaths.slice(0, 4).join(', ')}${changedPaths.length > 4 ? ' …' : ''}`
        );
      }

      const mutatedChildren = heldUndeclared.filter(([, , muts]) => muts.length);
      if (mutatedChildren.length) {
        const worst = mutatedChildren.reduce((a, b) => (b[2].length > a[2].length ? b : a));
        notes.push(
          `${mutatedChildren.length} of ${names.length} plant(s) STRADDLED a write to the measured tree, ` +
            `so their undeclared moves — and the "this masked exemption is stale" half of their ` +
            `\`masked\` check — are UNATTRIBUTABLE and were DISCARDED (which is ` +
            `not an all-clear on them). Worst: \`${worst[0]}\` saw ${worst[2].length} changed path(s) — ` +
            `${worst[2].slice(0, 4).join(', ')}${worst[2].length > 4 ? ' …' : ''}`
        );
      }
      for (const [n, undeclared, muts] of heldUndeclared) {
        // A child that measured a different tree cannot tell its own blast
        // radius from the writer's. Discard rather than accuse: the accusation
        // is what sends someone to declare a blast radius that does not exist.
        if (muts.length) continue;
        const attributable = undeclared.filter((id) => !drifted.has(id));
        const derived = attributable.filter((id) => SELF_PLANT_DERIVATIVE.has(id));
        const real = attributable.filter((id) => !SELF_PLANT_DERIVATIVE.has(id));
        if (derived.length) notes.push(`${n} also moved derivative gate(s) ${derived.join(', ')}`);
        if (real.length) {
          problems.push(
            `\`${n}\`: also moved \`${real.join('`, `')}\`, which its contract does not declare. A plant whose blast ` +
              'radius reaches a gate nobody aimed at proves that gate can go red for a reason nobody planted, which ' +
              'is the opposite of a negative control — declare it or narrow the plant'
          );
        }
      }

      // A plant whose every declared target drifted proved NOTHING this pass —
      // the move the loop above counted as a hit may be the drift. Said out
      // loud: a hit that cannot be attributed is not a hit.
      const mutatedNames = new Set(mutatedChildren.map(([n]) => n));
      for (const n of names) {
        const targets = SELF_PLANT_TARGETS[n]?.moves ?? [];
        if (targets.length && mutatedNames.has(n)) {
          problems.push(
            `\`${n}\`: the tree was written to WHILE this plant ran, so the move recorded on its target(s) ` +
              `(${targets.join(', ')}) may be the writer's rather than the plant's. UNMEASURABLE, which is not passing`
          );
          continue;
        }
        if (targets.length && targets.every((id) => drifted.has(id))) {
          problems.push(
            `\`${n}\`: every declared target (${targets.join(', ')}) DRIFTED mid-pass, so the move recorded for it ` +
              'may be the drift rather than the plant. UNMEASURABLE, which is not passing'
          );
        }
      }
    }
    driveMsg = `${names.length} plant(s) + 3 clean baselines (two opening, one closing) driven as \`--quick\` children in ${((Date.now() - t0) / 60000).toFixed(1)} min`;
  }

  if (problems.length) {
    fail('SPLNT', `${problems.length} problem(s): ${problems.join(' | ')}${notes.length ? ` [${notes.join('; ')}]` : ''}`);
  } else if (!driveWanted) {
    pend(
      'SPLNT',
      `STATIC ONLY. All ${names.length} self-plant(s) have a contract, every contracted gate exists in GATES, and ` +
        `every entry has a literal call site in this file: ${names.join(', ')}. ⚠ WHAT THIS RUN DOES NOT COVER: ` +
        'whether each plant still CHANGES anything — a call site that exists and does nothing is identical from here' +
        (SPLNT_CHILD ? ', and this process is a SPLNT child, which may not audit its own audit' : '')
    );
  } else {
    pass(
      'SPLNT',
      `${names.length} self-plant(s): each has a contract naming gate(s) that exist, a literal call site in this ` +
        'file, and was DRIVEN — every declared target moved against a clean baseline measured in this same ' +
        'invocation, no target improved, every `masked` exemption still has its premise, and no undeclared ' +
        `non-derivative gate moved. ${driveMsg}. ⚠ NOT COVERED, said rather than implied: a plant that was RETIRED ` +
        'and one that was DELETED both leave a smaller registry with no orphan, so the audited set is printed and ' +
        'not gated on a count; and the DRIVE comparison has no in-gate negative control, because driving one would ' +
        'need a child that itself runs DRIVE. It is witnessed on copies in SLICER-GATES.md and nowhere else' +
        (notes.length ? `. ${notes.join('. ')}` : '')
    );
  }
}

for (const [id, name, , why] of GATES) {
  if (results.some((r) => r.id === id)) continue;
  fail(id, `${name} — THIS GATE PRODUCED NO RESULT. Its block did not run to a verdict, which is not a pass and not a gap. Guards: ${why}`);
}

// ---------------------------------------------------------------------------
// PENDING is scored, not discarded.
//
// Any PENDING outside PENDING_BUDGET becomes a FAIL here. That is the structural
// half of the fix: a defect that DISARMS a gate — deleting `web/src/wasm` so K3
// pends, taking `rotation_deg` out of `ClampCfg` so P7R pends, breaking the
// probe dump so PROBE pends — used to read GO. It now reads NO-GO, through the
// same line every negative control asserts on.
for (const r of results) {
  if (r.state !== 'PENDING') continue;
  const b = PENDING_BUDGET[r.id];
  const allowed = b && (b.when === 'always' || (b.when === 'quick' && QUICK));
  if (allowed) {
    r.gap = b.why;
    continue;
  }
  r.state = 'FAIL';
  r.msg =
    `DISARMED, not waiting — this gate reported PENDING and it is not in PENDING_BUDGET` +
    `${b ? ` for this invocation (budgeted only under --${b.when})` : ''}. ` +
    `A check that stops being able to run is a defect, not a gap: ${r.msg}`;
}

const byId = new Map(GATES.map((g) => [g[0], g]));
for (const r of results) {
  const name = byId.get(r.id)?.[1] ?? '';
  const mark = SELF_PLANT ? 'SELF-PLANTED ' : '';
  console.log(`  ${mark}${r.state.padEnd(7)} ${r.id.padEnd(5)} ${name.padEnd(22)} ${r.msg}`);
}

const failed = results.filter((r) => r.state === 'FAIL').length;
const passed = results.filter((r) => r.state === 'PASS').length;
const gaps = results.filter((r) => r.state === 'PENDING');

console.log(`\n================ ${passed} passed, ${failed} failed, ${gaps.length} could-not-run ==========`);
for (const g of gaps) console.log(`  COULD NOT RUN HERE  ${g.id} — ${g.gap}`);

// ---------------------------------------------------------------------------
// THE VERDICT — three states, because there are three answers, and the reasoning
// is written down because it was a deliberate choice between two wrong ones.
//
// The tempting fix was `GO requires failed === 0 && pending === 0`, i.e. fold
// PENDING into NO-GO. It is wrong for one reason that matters more than its
// tidiness: CTRL cannot pass on any box without a controller on the USB cable,
// so every full run would read NO-GO forever. A verdict that is permanently red
// stops being read, and then the day a REAL red arrives nobody sees it. That is
// not a hypothetical failure mode; it is how every alarm dies.
//
// The other tempting fix — a third verdict that still starts with the letters
// `GO` (`GO-WITH-GAPS`) — is worse than doing nothing. `grep 'VERDICT: GO'`
// matches it. Whatever a gap verdict is called, it must not be a PREFIX-MATCH
// for the string a clean run prints, or every control that greps for a pass
// keeps passing.
//
// So: INCOMPLETE. It shares no prefix with GO, it is not NO-GO, and it carries
// its own exit code so a shell can tell the two non-passes apart:
//
//   GO          exit 0   every gate ran and answered
//   INCOMPLETE  exit 3   nothing failed; a budgeted gate could not run HERE
//   NO-GO       exit 1   a gate ran and did not pass, OR a gate was disarmed
//
// ⚠ FOR ANYONE WRITING A NEGATIVE CONTROL: assert `VERDICT: NO-GO`, exactly and
// including the `NO-`. If your plant produces INCOMPLETE instead, that is the
// finding — your defect disarmed the gate rather than failing it, and the gate
// needs to be able to tell those apart before the control means anything.
const verdict = verdictOf(failed, gaps.length);
const exitCode = EXIT_OF[verdict];

// The child protocol for gate SPLNT, and the reason it is a JSON line rather
// than a scrape of the scorecard above: a parent that regex-parses a formatted
// column layout goes blind the day somebody widens a `padEnd`, and it goes
// blind SILENTLY — every row "unchanged", every plant "inert", the whole audit
// red for a reason that is not true. This line is the data structure, so a
// formatting change cannot reach it. It prints on EVERY exit path below,
// including the forbidden-GO one, because a run that ends early is exactly the
// run the parent must not read as "no rows".
if (SPLNT_CHILD) {
  console.log(SPLNT_ROWS_TAG + JSON.stringify({ rows: results.map((r) => [r.id, r.state, r.msg]), verdict }));
}

if (SELF_PLANT && verdict === 'GO') {
  // A self-plant that leaves the run clean planted NOTHING, and a control that
  // cannot fail is the thing this flag exists to detect in other people's work.
  console.log(
    `VERDICT: NO-GO — SELF-PLANT '${SELF_PLANT}' CHANGED NOTHING. The run is clean with the ` +
      `defect installed, so the check it targets is vacuous. That is the finding.`
  );
  process.exit(1);
}

console.log(verdictLine(verdict, failed, gaps));
// 🔴 FAIL CLOSED. `EXIT_OF[verdict]` is `undefined` for any word not in the map,
// and `process.exit(undefined)` exits **0** — measured 2026-09-04. That turns an
// unrecognised verdict into a PASS for everything downstream, and the exit code
// is the entire contract with CI: nothing else reads the scorecard.
//
// `VERD` now asserts `EXIT_OF` covers the range of `verdictOf`, so this branch
// should be unreachable. It is here anyway because the two failures are not the
// same size: VERD going red is a message somebody reads, and this is the line
// that decides whether a broken run is allowed to look green. A gate can be
// disabled, skipped or bypassed; the exit path cannot be.
if (!Number.isInteger(exitCode)) {
  console.log(
    `VERDICT: NO-GO — the verdict ${JSON.stringify(verdict)} has NO exit code in EXIT_OF, so this run cannot ` +
      'report its own result. Exiting 1 rather than 0: an unmapped verdict must never be readable as a pass.'
  );
  process.exit(1);
}
process.exit(exitCode);
