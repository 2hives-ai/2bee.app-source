// `each` — THE SPLICE OPERATOR, AND THE GUARD THAT FIRED IN THE ONE POSITION
// NOBODY WRITES.
//
// ═══════════════════════════════════════════════════════════════════════════
// THE DEFECT THIS FILE EXISTS FOR
// ═══════════════════════════════════════════════════════════════════════════
//
// `scad.ts` carried a refusal for `each` — and it was reachable only when
// `each` was the FIRST token after `[`. Every real use in `hardware/cad/` is
//
//     function _amp_cov(ps) = [for (p = ps) each [p, p + 1]];
//
// where `isLCompStart()` has already dispatched to `parseListComp`, whose body
// was a bare `parseExpr()`. So `each` parsed as an ordinary VARIABLE and
// `[p, p + 1]` became an index on it, and the reader reported:
//
//     expected "]", found ","
//     variable v is not defined here; it evaluates to undef
//
// 🔴 BOTH DIAGNOSTICS NAME AN INNOCENT PARTY. The first blames a comma in a
// file that is correct OpenSCAD; the second blames a downstream variable for
// our missing operator. `unsupported` was EMPTY — so the one channel this tab
// promises ("a construct we cannot read is NAMED") said nothing at all, and a
// cad engineer sent to find a bracket typo would not have found one.
//
// 🔴 WHAT IT COST: `2bee_hive/2bee_hive_joinery.scad` and
// `2bee_hive/side_hive.scad` — the FLAGSHIP hive — could not be read, and the
// failure cascaded into every file importing them.
//
// ═══════════════════════════════════════════════════════════════════════════
// THE ORACLE IS OPENSCAD ITSELF, NOT MY RECOLLECTION
// ═══════════════════════════════════════════════════════════════════════════
//
// Every expected value below was MEASURED by running the same source through
// `openscad -o out.csg` (OpenSCAD version 2026.08.07, on this box) and reading
// its ECHO lines, on 2026-08-31. They are not derived from the implementation
// under test, which is the only way this file can fail when the reader drifts.
//
// ⚠ ONE ROW DELIBERATELY DIVERGES — `each undef`. OpenSCAD splices it to
// NOTHING, silently; this reader refuses it by name. That is a ruling recorded
// in `pushElement`'s header, not an omission, and the test asserts the
// DIVERGENCE so that quietly "fixing" it to match OpenSCAD goes red here and
// has to be argued for. Refusing cannot produce a wrong part; accepting an
// invisible empty splice can.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseScad } from '../src/cad/scad.ts';

/** The `echo()` payloads of a source, in order. */
function echoes(src: string): string[] {
  const r = parseScad(src, {});
  return r.console.map((c) => c.message);
}

/** Measured from OpenSCAD 2026.08.07 — see the header. */
const OPENSCAD: [name: string, src: string, expected: string][] = [
  ['the flagship form', 'function f(ps) = [for (p = ps) each [p, p+1]]; echo(f([0,2,5]));', '[0, 1, 2, 3, 5, 6]'],
  ['each a bound name', 'echo([for (p = [[1,2],[3,4]]) each p]);', '[1, 2, 3, 4]'],
  ['each mid-vector', 'echo([1, each [2,3], 4]);', '[1, 2, 3, 4]'],
  ['each leading', 'echo([each [7,8], 9]);', '[7, 8, 9]'],
  ['each a range', 'echo([each [0:2], 9]);', '[0, 1, 2, 9]'],
  ['each in the else body', 'echo([for (i=[0:2]) if (i==1) i else each [8,9]]);', '[8, 9, 1, 8, 9]'],
  ['each a scalar splices one', 'echo([each 5]);', '[5]'],
  // Precedence: `each` takes the WHOLE expression, not just the next primary.
  ['each binds loosely over +', 'echo([each [1,2] + [3,4]]);', '[4, 6]'],
  ['each binds loosely in a comprehension', 'echo([for (i=[0:1]) each [i] + [10]]);', '[10, 11]'],
  ['each binds loosely over scalar +', 'echo([each 1 + 2]);', '[3]'],
  ['indexing binds tighter than each', 'echo([each [[1,2],[3,4]][0]]);', '[1, 2]'],
];

for (const [name, src, expected] of OPENSCAD) {
  test(`${name} — matches OpenSCAD byte for byte`, () => {
    const r = parseScad(src, {});
    assert.deepEqual(r.errors.map((e) => e.message), [], 'no errors');
    assert.deepEqual(r.unsupported.map((u) => u.name), [], 'nothing refused');
    assert.deepEqual(echoes(src), [expected]);
  });
}

test('the exact line from the flagship hive reads, and is NAMED nowhere', () => {
  // Verbatim from hardware/cad/2bee_hive/2bee_hive_joinery.scad:289 and
  // hardware/cad/2bee_hive/side_hive.scad:297.
  const src = 'function _amp_cov(ps) = [for (p = ps) each [p, p + 1]];\necho(_amp_cov([0, 2, 5]));';
  const r = parseScad(src, {});
  assert.deepEqual(r.errors.map((e) => e.message), []);
  assert.deepEqual(r.unsupported.map((u) => u.name), []);
  assert.deepEqual(echoes(src), ['[0, 1, 2, 3, 5, 6]']);
});

test('the OLD failure is gone: no diagnostic blames the comma or a downstream name', () => {
  const r = parseScad('v = [for (p = [1,2]) each [p, p+1]]; echo(v);', {});
  const said = [...r.errors.map((e) => e.message), ...r.unsupported.map((u) => u.name)].join(' | ');
  assert.ok(!/expected "\]"/.test(said), `must not blame a bracket: ${said}`);
  assert.ok(!/variable v is not defined/.test(said), `must not blame v: ${said}`);
  assert.equal(said, '');
});

test('each undef is REFUSED BY NAME — a deliberate divergence from OpenSCAD', () => {
  // OpenSCAD 2026.08.07 answers `[]` here. We refuse: an `undef` operand is a
  // mistyped name, and a silently SHORTER list draws a part with elements
  // missing. Changing this to match OpenSCAD must be a decision, not a tidy-up.
  const r = parseScad('echo([each undef]);', {});
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.unsupported.map((u) => u.name), ['each undef']);
  assert.match(r.unsupported[0].detail, /silently/);
});

test('each outside element position is named, not read as a variable', () => {
  const r = parseScad('x = each [1,2]; echo(x);', {});
  assert.deepEqual(r.unsupported.map((u) => u.name), ['each outside a vector or list comprehension']);
  const errs = r.errors.map((e) => e.message).join(' | ');
  assert.ok(!/expected "\]"/.test(errs), `must not blame a bracket: ${errs}`);
});

test('vectors, ranges and comprehensions WITHOUT each are untouched', () => {
  assert.deepEqual(echoes('echo([1,2,[3,4]]);'), ['[1, 2, [3, 4]]']);
  assert.deepEqual(echoes('echo([for(i=[0:3]) if(i%2==0) i]);'), ['[0, 2]']);
  assert.deepEqual(echoes('echo([0:2]);'), ['[0 : 2]']);
  assert.deepEqual(echoes('echo([1,2,]);'), ['[1, 2]']); // trailing comma
  assert.deepEqual(echoes('echo([]);'), ['[]']);
});
