// THE IMPORT BUDGET COUNTS FILES, NOT MENTIONS — TODO #165.
//
// 🔴 WHAT WENT WRONG, MEASURED. `MAX_IMPORTS` is documented as *"files pulled
// into one parse"* and was charged per ENCOUNTER, so a file imported by ten
// siblings cost ten. On `2bee_hive/2bee_hive_panels_18mm_inner_wcnc.scad`:
//
//     146 host reads · 33 DISTINCT files · budget 128
//
// The budget ran out before `2bee_hive_floor_wcnc.scad` was ever read, so
// `bb_floor_flat()` came back as "not a module this subset knows" — while the
// source names that file on line 18. ⚠ THE MESSAGE NAMED A MODULE, so a reader
// goes hunting a missing definition that is right there.
//
// ⚠ THE BUDGET ITSELF IS UNCHANGED, and that is the point. Raising it was tried
// and produced 154 evaluation errors: the fan-out was the disease and the budget
// was containing it. Only the QUANTITY being charged changed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseScad } from '../src/cad/scad.ts';

/** A host that counts reads and can report how many distinct files it served. */
function countingHost(files: Map<string, string>) {
  const served = new Set<string>();
  let reads = 0;
  return {
    served,
    get reads() { return reads; },
    read(spec: string, _from: string) {
      reads++;
      const src = files.get(spec);
      if (src === undefined) return null;
      served.add(spec);
      return { path: spec, source: src };
    },
  };
}

test('a file imported by many siblings is charged ONCE', () => {
  /* 🔴 THE SHAPE MATTERS AND MY FIRST VERSION HAD IT WRONG. It put 200
   * `use <shared.scad>` lines in ONE file and asserted `shared()` resolved —
   * which it did even with per-encounter charging, because the FIRST use binds
   * the name and the later refusals take nothing away. **The plant that reverted
   * the fix left that test green.**
   *
   * The real shape is `hardware/cad`'s: MANY DIFFERENT files each importing one
   * shared library, with the name needed by the LAST of them. Per-encounter, the
   * budget is gone by the time that file is reached; per-file, two are charged. */
  /* 🔴 SIZED SO THE TWO ACCOUNTINGS DISAGREE, AND THAT SIZING IS THE TEST.
   * Per FILE the parse pulls in SIBLINGS + 2 = 102, inside the 128 budget.
   * Per ENCOUNTER it costs 2 per sibling (the sibling, then its `use <shared>`)
   * = 202, and the budget is gone long before `last.scad`.
   * ⚠ A FIRST ATTEMPT USED 200 SIBLINGS AND FAILED ON THE FIXED CODE — 202
   * distinct files genuinely exceed 128, so it was measuring the limit doing its
   * job and calling that the bug. A test whose input is outside the valid range
   * reports the guard as the defect. */
  const SIBLINGS = 100;
  const files = new Map<string, string>();
  files.set('shared.scad', 'module shared() { cube(1); }\n');
  let root = '';
  for (let i = 0; i < SIBLINGS; i++) {
    files.set(`sib${i}.scad`, `use <shared.scad>;\nmodule sib${i}() { cube(1); }\n`);
    root += `use <sib${i}.scad>;\n`;
  }
  /* The LAST sibling's own import is the one a per-encounter budget cannot pay
   * for, so this is the design that goes dark. */
  files.set('last.scad', 'use <shared.scad>;\nmodule last() { shared(); }\n');
  root += 'use <last.scad>;\nlast();\n';

  const host = countingHost(files);
  const r = parseScad(root, { host, path: 'root.scad' });

  assert.equal(
    r.counts.primitives,
    1,
    'the shared module never resolved — the budget was spent on repeat mentions of one file, ' +
      `unsupported: ${JSON.stringify(r.unsupported.map((u) => u.name).slice(0, 3))}`,
  );
  assert.deepEqual(r.unsupported.map((u) => u.name), [], 'a name went unresolved');
});

test('THE BUDGET STILL REFUSES — it bounds distinct files, it is not removed', () => {
  /* 🔴 WITHOUT THIS, THE FIX ABOVE IS INDISTINGUISHABLE FROM DELETING THE LIMIT.
   * 300 DIFFERENT files, each defining a module the root then calls: at most 128
   * may resolve, and the rest must come back as unknown modules.
   *
   * ⚠ THIS ASSERTED `host.served.size <= 128` FIRST AND FAILED AT 300 — and the
   * code was right. The budget is now charged AFTER resolution, because the
   * resolved path is not known before it, so a file past the ceiling is still
   * READ and then refused. ⇒ The quantity `MAX_IMPORTS` bounds is what the parse
   * TAKES IN, not how many times the host was asked. **A test that measured the
   * host would have sent me to "fix" a limit that was working.** The behavioural
   * change is real and is stated rather than hidden: host reads are no longer
   * bounded by this constant; parsed and bound files are. */
  const files = new Map<string, string>();
  let root = '';
  for (let i = 0; i < 300; i++) {
    files.set(`f${i}.scad`, `module m${i}() { cube(1); }\n`);
    root += `use <f${i}.scad>;\n`;
  }
  for (let i = 0; i < 300; i++) root += `m${i}();\n`;

  const r = parseScad(root, { host: countingHost(files), path: 'root.scad' });
  assert.ok(
    r.counts.primitives <= 128,
    `${r.counts.primitives} modules resolved from 300 distinct files — MAX_IMPORTS no longer bounds the parse`,
  );
  assert.ok(
    r.counts.primitives > 0,
    'nothing resolved at all — the budget is not bounding, it is blocking',
  );
  assert.ok(
    r.unsupported.length > 0,
    'every one of 300 files resolved past a 128 budget, or the overflow was SILENT — ' +
      'both are failures, and the silent one is worse',
  );
});

test('the refusal says how many files, not how many mentions', () => {
  const files = new Map<string, string>();
  let root = '';
  for (let i = 0; i < 300; i++) {
    files.set(`g${i}.scad`, `module g${i}() { cube(1); }\n`);
    root += `use <g${i}.scad>;\n`;
  }
  const r = parseScad(root, { host: countingHost(files), path: 'root.scad' });
  const text = [...r.errors.map((e) => e.message), ...r.unsupported.map((u) => u.detail)].join(' ');
  assert.match(text, /128 files pulled into one parse|not a module this subset knows/,
    'nothing reported the budget being reached');
});

// ═══════════════════════════════════════════════════════════════════════════
// A CYCLED FILE'S OWN TOP-LEVEL VARIABLES — TODO #165, second half.
// ═══════════════════════════════════════════════════════════════════════════
//
// A circular `use` is re-read for DEFINITIONS ONLY. That filter kept `module`
// and `function` and dropped top-level assignments — so a module whose DEFAULT
// PARAMETER names a variable from its own file lost it:
//
//     inwall_cut_pilots_default = false;                       // line 249
//     module inwall_node_wall_cut(..., cnc_pilots = inwall_cut_pilots_default,  // 291
//
// gave `variable inwall_cut_pilots_default is not defined`, 38 errors on
// `2bee_hive_panels_18mm_inner_wcnc.scad` and 19 on `cnc_nest/nest_flat.scad`.
//
// 🔴 KEEPING THE ASSIGNMENTS DOES NOT EXPORT THEM. `use` imports names, not
// variables, and `execUse` still copies only `modules` and `functions` out to
// the importer. The assignments are bound in the USED FILE'S OWN scope, which is
// where OpenSCAD evaluates those defaults. ⚠ If they leaked to the importer this
// would be a silent semantic change — a `use`d file could then overwrite a
// caller's variable — so the test below asserts BOTH halves.

// ═══════════════════════════════════════════════════════════════════════════
// A CYCLED FILE'S OWN TOP-LEVEL VARIABLES — TODO #165, second half.
// ═══════════════════════════════════════════════════════════════════════════
//
//     inwall_cut_pilots_default = false;                                       // 249
//     module inwall_node_wall_cut(..., cnc_pilots = inwall_cut_pilots_default,  // 291
//
// The definitions-only re-read kept `module`/`function` and dropped top-level
// assignments, so that default resolved to nothing: 38 errors on
// `2bee_hive_panels_18mm_inner_wcnc.scad`, 19 on `cnc_nest/nest_flat.scad`.
//
// 🔴 KEEPING THEM AND REPORTING THEIR FAILURES WAS TRIED FIRST AND BROKE A REAL
// CONTROL. A cycled file's own `x = b_zbot()` is evaluated in a re-read where
// `b_zbot` does not exist yet, so a function that IS defined became an
// unsupported construct — the exact failure the circular-`use` fix was written
// to remove. They are now bound QUIETLY: the bindings exist, the diagnostics do
// not. ⚠ Nothing that was previously reported became silent — these assignments
// were not evaluated at all before, so there was never a report to lose.

test("a cycled file's module sees its own file-level variables", () => {
  /* 🔴 THE SHAPE IS THE TEST, AND TWO EARLIER ATTEMPTS WERE VACUOUS — the plant
   * that drops assignments left them green, because the module under test was
   * resolved from the NORMAL read of its file, not the defs-only re-read.
   * The defs-only copy only matters when the CALLER is inside the cycle:
   *     root -> a -> b -> a   (a re-read defs-only, its defs bound into b)
   *     b calls a's `helper`, whose default names a's own file-level variable */
  const files = new Map<string, string>();
  files.set('a.scad', 'use <b.scad>;\nadefault = 7;\nmodule am() { bm(); }\nmodule helper(n = adefault) { cube(n); }\n');
  files.set('b.scad', 'use <a.scad>;\nmodule bm() { helper(); }\n');

  const r = parseScad('use <a.scad>;\nam();\n', { host: countingHost(files), path: 'root.scad' });
  assert.deepEqual(r.errors.map((e) => e.message), [], 'the cycled file lost its own top-level variable');
  assert.equal(r.counts.primitives, 1, 'the module never drew — its default parameter did not resolve');
});

test('a cycled file whose own assignment cannot evaluate stays SILENT, not unsupported', () => {
  /* 🔴 THE REGRESSION THAT MADE THE FIRST ATTEMPT UNSHIPPABLE, asserted here so
   * it cannot come back. `a` assigns `x = b_zbot()` at file level; when `a` is
   * re-read defs-only inside `b`'s parse, `b_zbot` does not exist yet. That must
   * bind nothing and REPORT nothing — reporting it turns a defined function into
   * an unsupported construct in the outer parse. */
  const files = new Map<string, string>();
  files.set('a.scad', 'use <b.scad>;\nfunction a_yc() = 112.5;\nx = b_zbot();\ncube([x, 1, 1]);\n');
  files.set('b.scad', 'use <a.scad>;\nfunction b_zbot() = 118;\ny = a_yc();\n');

  const r = parseScad(files.get('a.scad')!, { host: countingHost(files), path: 'a.scad' });
  assert.deepEqual(r.errors.map((e) => e.message), []);
  assert.deepEqual(
    r.unsupported.map((u) => u.name),
    [],
    'a defined function was reported as an unsupported construct — the quiet bind is leaking diagnostics',
  );
});

test('the suppression is SCOPED to a defs-only body — a NORMAL `use`d file still reports', () => {
  /* 🔴 WITHOUT THIS, "BIND QUIETLY" IS INDISTINGUISHABLE FROM "STOP REPORTING".
   *
   * ⚠ MY FIRST VERSION OF THIS TEST WAS VACUOUS AND THE PLANT PROVED IT. It put
   * an undefined module CALL in the root and asserted it still reported — but the
   * quiet window only ever wraps ASSIGNMENT evaluation, so forcing `quiet` on for
   * every `use` left that call as loud as before and the test stayed green.
   * ⇒ **A scoping test has to exercise the thing inside the widened scope, not
   * something the scope never covered.**
   *
   * `c.scad` is NOT in a cycle, so its failing top-level assignment must still be
   * reported. Turning the suppression on for every `use` silences exactly this. */
  const files = new Map<string, string>();
  files.set('c.scad', 'bad = missing_fn();\nmodule cm(n = bad) { cube(1); }\n');

  const r = parseScad('use <c.scad>;\ncm();\n', { host: countingHost(files), path: 'root.scad' });
  assert.ok(
    r.unsupported.some((u) => /missing_fn/.test(u.name)),
    'a non-cycled `use`d file\'s failing assignment was swallowed — the quiet bind is no longer scoped ' +
      'to definitions-only re-reads, and real diagnostics are being dropped',
  );
});
