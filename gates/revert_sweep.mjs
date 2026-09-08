#!/usr/bin/env node
/**
 * REVERT SWEEP — does this suite NOTICE if a behaviour is removed?
 *
 * ceo, 2026-09-05: *"COUNT THE PLANTS, NEVER THE RULES. Try the reverts. Only a
 * revert distinguishes 'this rule is GUARDED' from 'this rule is WRITTEN DOWN.'"*
 * `research` measured 7 of 9 of their own behaviours deletable with a fully green
 * selftest — the most heavily planted lane in the fleet.
 *
 * 🔴 WHAT THIS DOES NOT MEAN, AND ceo REQUIRES IT SAID HERE: a green sweep says
 * **"these N behaviours are guarded"**. It NEVER says the suite is sound. A
 * behaviour nobody thought to list is invisible to this sweep exactly as it is
 * invisible to the gate — `0 of N` is a statement about N things somebody
 * remembered, and the list below is hand-written.
 *
 * ⚠ WHY THE INTERESTING ENTRIES ARE HARNESS-SIDE. Every plant in this lane was
 * written against a GATE'S CONTRACT. `canon.mjs`, `openscad.mjs` and the oracle's
 * own argument handling are what those contracts REST ON, and nothing was ever
 * written against them — ceo's pattern, one lane over.
 *
 * 🔴 EDITS THE SHARED WORKING TREE IN PLACE, ONE FILE AT A TIME. The fleet shares
 * one checkout, so every revert is restored in a `finally` AND the restore is
 * verified by sha256 against the bytes read before the edit. If a restore ever
 * fails this exits non-zero and names the file, because leaving a reverted
 * behaviour in a tree other lanes commit from is worse than any finding here.
 *
 * 🔴 THE SABOTAGED CODE MUST ACTUALLY RUN, AND FOR ONE CLASS OF FILE IT CANNOT.
 * ceo relayed `backend`'s find 2026-09-06: two subprocess runs in the same
 * filesystem mtime tick let Python re-execute STALE BYTECODE, so a sweep reports
 * GUARDED about code that never ran. Checked here rather than assumed:
 *
 *   NODE_COMPILE_CACHE unset, NODE_OPTIONS unset, and a same-tick rewrite of an
 *   .mjs re-executed the NEW bytes (printed A, rewrote, printed B).
 *
 * ⇒ Node has no on-disk bytecode cache in this environment and the JS/TS entries
 * below genuinely execute. **But the same question has a WORSE answer one file
 * type over, and it is certain rather than probabilistic:** `runSuite()` drives
 * the gate with `--quick`, which SKIPS THE CARGO REBUILD BY DESIGN. Sabotage
 * anything under `core/` or `cli/` and the suite runs the PREVIOUSLY BUILT
 * binary — the revert is on disk, the diff is right, the restore is
 * byte-identical, and the behaviour was never executed.
 *
 * So a Rust entry is REFUSED rather than scored. There are none today, which is
 * exactly why the guard is written now: the lane's OPEN block already records
 * that nothing lists the Rust core or the post, so the first person to close
 * that gap is the person this would lie to.
 *
 * Usage:  node gates/revert_sweep.mjs [--list] [--only <name>]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sha = (s) => createHash('sha256').update(s).digest('hex');

/**
 * Each entry REMOVES one behaviour by textual substitution. `find` must occur
 * EXACTLY ONCE — a revert that matched nothing runs green and reads as "guarded",
 * which is the same false pass this whole sweep exists to find.
 */
const BEHAVIOURS = [
  {
    name: 'canon-multmatrix',
    file: 'tools/scad_oracle/canon.mjs',
    why: 'canon carried a group\'s multmatrix into the comparison tree. Dropping it made every transformed subtree compare as if untransformed — it had been doing exactly that until 2026-09-02, and it retired NINE tree-leg divergences that were the instrument, not the kernel',
    // `n.multmatrix` alone matched TWICE (the guard and the destructure on the
    // next line). The guard line is unique and is the behaviour.
    find: 'if (n.multmatrix) {',
    replace: 'if (false && n.multmatrix) {',
  },
  {
    name: 'mesh-winding-flip',
    file: 'web/src/cad/mesh.ts',
    why: 'an orientation-reversing transform (negative determinant, e.g. the shipped scale([-1,1,1])) must flip polygon winding BEFORE the children\'s booleans run, or every boolean downstream is computed against inside-out solids',
    find: 'const flip = det3(x.m) < 0;',
    replace: 'const flip = false; // REVERT SWEEP',
  },
  {
    name: 'csg-read-cap',
    // TRUE iff the cap is disabled: a 1-byte cap against a trivial model must
    // refuse; if it returns ok the guard is not running.
    probe: `const {mkdtempSync,writeFileSync}=await import('node:fs');const {tmpdir}=await import('node:os');` +
      `const {join}=await import('node:path');const {exportCsg}=await import('./tools/scad_oracle/openscad.mjs');` +
      `const d=mkdtempSync(join(tmpdir(),'pr-'));const f=join(d,'t.scad');writeFileSync(f,'cube(1);');` +
      `const r=exportCsg('openscad',f,60000,1);console.log(r.ok===true?'LIVE':'GUARD-PRESENT');`,
    file: 'tools/scad_oracle/openscad.mjs',
    why: 'the cap that stops a 485 MB CSG export OOM-killing the whole run and taking 302 unrelated cases with it',
    // ⚠ THIS STRING WENT STALE WITHIN THE HOUR. It read `> MAX_CSG_BYTES` until
    // the cap was made injectable so a test could reach it; the sweep then
    // matched 0 times and SKIPPED — which is exactly the failure the arity check
    // exists for. A `find` is a second copy of the source and drifts like any
    // other; the skip is the only reason it was noticed.
    find: 'if (csgSize > cap) {',
    replace: 'if (false && csgSize > cap) {',
  },
  {
    name: 'oracle-load-guard',
    file: 'tools/scad_oracle/oracle.mjs',
    why: 'the missing-flag guard reports exit 2 (COULD NOT RUN) instead of exit 1 (RAN AND FOUND PROBLEMS). Reverted by restoring the static import that made it unreachable',
    find: "import { fileURLToPath } from 'node:url';",
    replace: "import { fileURLToPath } from 'node:url';\nimport { EMPTY as _SWEEP } from './canon.mjs';",
  },
  {
    name: 'mesh-budget-tick',
    probe: `const {parseScad}=await import('./web/src/cad/scad.ts');` +
      `const {meshScene}=await import('./web/src/cad/mesh.ts');` +
      `console.log(meshScene(parseScad('sphere(5);').scene,undefined,-1).stats.solids>0?'LIVE':'GUARD-PRESENT');`,
    file: 'web/src/cad/mesh.ts',
    why: 'MAX_MS is documented as the wall-clock for the WHOLE evaluation; without this tick it is enforced only inside the BSP loops, so a model that spends its time GENERATING geometry is bounded by nothing',
    find: '    this.budget.tick();\n    switch (node.kind) {',
    replace: '    switch (node.kind) {',
  },
  {
    // 🔴 THE FIRST RUST ENTRY, AND IT IS HERE TO BE REFUSED. `--quick` skips the
    // cargo rebuild, so this one cannot be scored from this harness — which is
    // the whole point of listing it: the lane's OPEN block records that NOTHING
    // lists the Rust core or the post, and an empty list is indistinguishable
    // from a guarded one. A REFUSED row is a visible gap; an absent row is not.
    name: 'probe-g38-2-not-g38-3',
    file: 'core/src/post_grblhal.rs',
    why:
      'the touch-off probes with G38.2, which ALARMS on no contact. G38.3 returns silently, so the G10 that ' +
      'follows would write end-of-travel as the datum and PERSIST it — a missed touch must stop the machine, ' +
      'not set a garbage origin. Verified against grblHAL core/alarms.c (ALARM:5 Probe fail) rather than assumed',
    find: 'G38.2 Z-{} F{}\n',
    replace: 'G38.3 Z-{} F{}\n',
  },
  {
    name: 'stl-completeness',
    // ⚠ THE PROBE MUST TARGET WHAT THE REVERT DISABLES, NOT THE BEHAVIOUR'S NAME.
    // The first version fed an STL truncated MID-FACET, which the separate
    // facet/endfacet COUNT check still catches — so it read GUARD-PRESENT with
    // the sabotage installed and the arm was correctly DISCARDED. The revert
    // switches off the `endsolid` test alone, so the input has to be one that
    // ONLY that test can reject: complete facets, balanced counts, no endsolid.
    probe: `const {parseAsciiStl}=await import('./tools/scad_oracle/openscad.mjs');` +
      `const t='solid x\\nfacet normal 0 0 1\\n outer loop\\n  vertex 0 0 0\\n  vertex 1 0 0\\n  vertex 0 1 0\\n endloop\\nendfacet\\n';` +
      `console.log(parseAsciiStl(t).ok===true?'LIVE':'GUARD-PRESENT');`,
    file: 'tools/scad_oracle/openscad.mjs',
    why: 'a TRUNCATED STL from the oracle is a FALSE GROUND TRUTH — without the endsolid/endfacet check a partial export is silently rounded down to a shorter valid mesh and compared as if whole',
    find: "if (!/(^|\\s)endsolid(\\s|$)/.test(text)) {",
    replace: "if (false && !/(^|\\s)endsolid(\\s|$)/.test(text)) {",
  },
];

const argv = process.argv.slice(2);
const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null;
/* ⚠ A TYPO'D `--only` SELECTED NOTHING AND EXITED 0. The main runner refuses
 * `--only` BY NAME for the mirror-image hazard (slicer_gate_check.mjs:110 — "if
 * you passed it and read the result as scoped, that result was the WHOLE
 * suite"). Here the scoped result was EMPTY and read as green. */
if (only && !BEHAVIOURS.some((b) => b.name === only)) {
  console.error(`--only '${only}' matches no entry. Known: ${BEHAVIOURS.map((b) => b.name).join(', ')}`);
  process.exit(2);
}

if (argv.includes('--list')) {
  for (const b of BEHAVIOURS) console.log(`${b.name.padEnd(22)} ${b.file}\n${' '.repeat(23)}${b.why}\n`);
  console.log(`${BEHAVIOURS.length} listed. This count is what somebody remembered, not what exists.`);
  process.exit(0);
}

/**
 * Run one entry's `probe` in a CHILD (so it loads the file as it is on disk NOW)
 * and report whether the sabotage is LIVE.
 *
 * 🔴 curriculum's instrument, relayed by ceo 2026-09-06, and it closes a real
 * gap here: this sweep INFERRED that the reverted code ran — the arity assert
 * fired, Node has no bytecode cache, the bytes are on disk — and inference is
 * not observation. An arm whose sabotage never executed reports `HOLE` about
 * code that was never the code under test.
 *
 * ⚠ THE NEGATIVE CONTROL IS THE HALF THAT MATTERS. A probe that reads LIVE on
 * ORIGINAL code arms its verdict for the wrong reason, so every probe is run
 * against the UNPATCHED file first and must read GUARD-PRESENT. A probe that
 * cannot tell the two states apart is worse than no probe.
 */
const runProbe = (src) => {
  const r = spawnSync(
    process.execPath,
    ['--experimental-transform-types', '--disable-warning=ExperimentalWarning', '--input-type=module', '-e', src],
    { cwd: ROOT, encoding: 'utf8', timeout: 10 * 60 * 1000 }
  );
  const out = `${r.stdout ?? ''}`.trim();
  if (out.includes('LIVE')) return 'LIVE';
  if (out.includes('GUARD-PRESENT')) return 'GUARD-PRESENT';
  return `INDETERMINATE (${(`${out}${r.stderr ?? ''}`).trim().split('\n').pop()?.slice(0, 90) ?? 'no output'})`;
};

const runSuite = () => {
  const r = spawnSync(process.execPath, [join(ROOT, 'gates/slicer_gate_check.mjs'), '--quick'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    timeout: 30 * 60 * 1000,
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const m = out.match(/=+ (\d+) passed, (\d+) failed, (\d+) could-not-run =+/);
  const verdict = (out.match(/^VERDICT: (\w+(?:-\w+)?)/m) || [])[1] ?? 'NO-VERDICT-LINE';
  const failed = m ? Number(m[2]) : null;
  const names = [...out.matchAll(/^ {2}FAIL {4}(\w+)/gm)].map((x) => x[1]);
  return { verdict, failed, names, status: r.status };
};

console.log('REVERT SWEEP — one behaviour removed at a time, suite re-run, ANY red counted as guarded\n');
console.log('🔴 A GREEN ROW IS A HOLE: the behaviour could be deleted and this suite would not say so.\n');

const results = [];
for (const b of BEHAVIOURS) {
  if (only && b.name !== only) continue;
  // 🔴 CAN `--quick` EVEN SEE THIS FILE? Rust is compiled ahead of the run and
  // `--quick` skips the rebuild, so a sabotaged core/ or cli/ source is never
  // the code under test. Scoring it would produce a confident GUARDED or HOLE
  // about bytes that did not execute.
  if (/^(core|cli)\//.test(b.file)) {
    console.log(
      `  ⛔ REFUSED ${b.name.padEnd(22)} ${b.file} is RUST and runSuite() uses --quick, which skips the ` +
        'cargo rebuild — the suite would run the previously built binary and this revert would never ' +
        'execute. Rebuild before scoring it, or drive the full pass; do not read a verdict from here'
    );
    results.push({ name: b.name, guarded: null, note: 'rust: --quick runs a stale binary' });
    continue;
  }
  const path = join(ROOT, b.file);
  const original = readFileSync(path, 'utf8');
  const before = sha(original);
  const n = original.split(b.find).length - 1;
  if (n !== 1) {
    console.log(`  ⚠ SKIP  ${b.name.padEnd(22)} its \`find\` matched ${n} times in ${b.file}, not once — ` +
      'a revert that matches nothing runs GREEN and reads as guarded, so it is reported, never applied');
    results.push({ name: b.name, guarded: null, note: `find matched ${n}x` });
    continue;
  }
  // NEGATIVE CONTROL FIRST: on the ORIGINAL file the probe must NOT read LIVE.
  if (b.probe) {
    const before = runProbe(b.probe);
    if (before !== 'GUARD-PRESENT') {
      console.log(
        `  ⚠ SKIP  ${b.name.padEnd(22)} its probe reads ${JSON.stringify(before)} against UNPATCHED code — it ` +
          'cannot separate sabotaged from original, so any verdict it armed would be armed for the wrong reason'
      );
      results.push({ name: b.name, guarded: null, note: `probe unsound: ${before} on original` });
      continue;
    }
  }
  let r;
  let live = null;
  try {
    writeFileSync(path, original.replace(b.find, b.replace));
    if (b.probe) live = runProbe(b.probe);
    r = runSuite();
  } finally {
    writeFileSync(path, original);
    const after = sha(readFileSync(path, 'utf8'));
    if (after !== before) {
      console.error(`\n🔴 RESTORE FAILED for ${b.file} — the working tree is NOT as it was. Fix before committing anything.`);
      process.exit(4);
    }
  }
  // 🔴 AN ARM WHOSE SABOTAGE DID NOT RUN HAS NO VERDICT — it is DISCARDED, never
  // reported as a hole. "The suite did not notice" and "there was nothing to
  // notice" are different facts and only the first is a finding.
  if (b.probe && live !== 'LIVE') {
    console.log(
      `  ⚠ DISCARD ${b.name.padEnd(22)} the sabotage was NOT observed live (probe: ${live}), so this run says ` +
        'nothing about whether the suite guards it — reported as unmeasured, not as a hole'
    );
    results.push({ name: b.name, guarded: null, note: `sabotage not live: ${live}` });
    continue;
  }
  const guarded = r.failed !== null && r.failed > 0;
  results.push({ name: b.name, guarded, r });
  const liveNote = b.probe ? ' (sabotage confirmed live)' : ' (UNPROBED — liveness inferred, not observed)';
  console.log(
    `  ${guarded ? '🟢 GUARDED' : '🔴 HOLE   '} ${b.name.padEnd(22)} ` +
      `${guarded ? `${r.failed} gate(s) red: ${r.names.join(', ')}` : `suite still ${r.verdict} — nothing noticed`}` +
      liveNote
  );
}

const scored = results.filter((x) => x.guarded !== null);
/* 🔴 A SWEEP THAT MEASURED NOTHING EXITED 0 (found 2026-09-07).
 * Every arm can legitimately set `guarded: null` and continue — a Rust entry is
 * REFUSED, a `find` string that matched != 1 time SKIPs, an unsound probe SKIPs,
 * an unobserved sabotage is DISCARDed. If ALL of them do, `scored` is empty,
 * `holes` is empty, and this printed "0 of 0 listed behaviours are GUARDED" and
 * exited 0. ⇒ The one instrument here whose whole subject is telling GUARDED
 * from merely WRITTEN DOWN could not tell "all guarded" from "nothing measured".
 * ⚠ Reachable by ordinary drift, not sabotage: 1 of 7 entries is permanently
 * REFUSED and 3 more are find-string-coupled to another lane's tree. This file
 * already RECORDS that happening at :97 — the arity check reported the skip on
 * stdout while the exit code still read it as success. */
if (scored.length === 0) {
  console.log(
    `\n🔴 NOTHING WAS MEASURED — ${results.length} entr(y/ies) all skipped, refused or discarded, ` +
      'so "0 of 0 GUARDED" is not a pass. Read the per-entry notes above: a sweep that scored ' +
      'nothing cannot distinguish a sound suite from a dead probe.',
  );
  process.exit(1);
}
const holes = scored.filter((x) => !x.guarded);
console.log(`\n${scored.length - holes.length} of ${scored.length} listed behaviours are GUARDED.`);
if (holes.length) console.log(`🔴 ${holes.length} HOLE(S): ${holes.map((h) => h.name).join(', ')}`);
console.log('\n⚠ This says nothing about behaviours nobody listed. It is not a statement that the suite is sound.');
process.exit(holes.length ? 1 : 0);
