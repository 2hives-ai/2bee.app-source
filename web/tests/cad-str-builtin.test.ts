// `str()` — ONE MISSING BUILTIN THAT WAS HOLDING MOST OF THE HARDWARE LEG RED.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHY THIS ONE, AND WHY IT IS NOT A GEOMETRY FEATURE
// ═══════════════════════════════════════════════════════════════════════════
//
// After `CAD1H` was repaired on 2026-09-02 (recursive scan + a library host),
// the live hardware leg reported 73 DIVERGES+ERROR of 296. Partitioning them by
// cause put **`str()` in 65 of the 73** — one absent string function, used in
// `echo` and in labels, taking its whole subtree with it on every refusal.
//
// It is not a geometry question at all, which is exactly why it was worth doing
// first: `mirror()` (18) and the dropped `$fn` on `offset()` cannot be assessed
// under 65 cases of string noise sitting on top of them.
//
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 THE NUMBER FORMAT IS MEASURED, NOT DERIVED — AND `%g` IS THE WRONG GUESS
// ═══════════════════════════════════════════════════════════════════════════
//
// Six significant digits, but the fixed/scientific choice is NOT `%g`'s.
// `%g` goes scientific below 1e-4, so it renders `str(0.000012345678)` as
// `1.23457e-05`; OpenSCAD gives `0.0000123457`. OpenSCAD uses
// double-conversion's precision mode, where the choice is about padding zeroes
// rather than magnitude.
//
// JavaScript's `toPrecision(6)` happens to break the same way at both ends, so
// the implementation is `toPrecision(6)` with trailing zeroes stripped. **That
// is two specifications coinciding, not a derivation** — which is why every row
// below is a value measured by running `openscad -o out.csg` (OpenSCAD version
// 2026.08.07, on this box) on 2026-09-02 and reading its ECHO lines, and not a
// value produced by the code under test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseScad } from '../src/cad/scad.ts';

/** The `str(...)` result, with `echo`'s own quoting removed. */
function strOf(expr: string): { text: string; refusals: string[] } {
  const r = parseScad(`echo(${expr});`, {});
  return {
    text: (r.console[0]?.message ?? '').replace(/^"|"$/g, ''),
    refusals: r.unsupported.map((u) => u.name),
  };
}

/** Measured from OpenSCAD 2026.08.07 — see the header. */
const OPENSCAD: [expr: string, expected: string][] = [
  ['str("a",1,2.5)', 'a12.5'],
  ['str()', ''],
  ['str("x",true,undef)', 'xtrueundef'],
  ['str("n=",5,"mm")', 'n=5mm'],
  // A TOP-LEVEL string is unquoted; a NESTED one is quoted. The asymmetry is
  // real and is why the top level is handled by the caller, not the formatter.
  ['str([1,2],"y")', '[1, 2]y'],
  ['str(["a","b"])', '["a", "b"]'],
  ['str([1,[2,"c"]])', '[1, [2, "c"]]'],
  // Six significant digits.
  ['str(1/3)', '0.333333'],
  ['str(-1/3)', '-0.333333'],
  ['str(3.14159265358979)', '3.14159'],
  ['str(0.1+0.2)', '0.3'],
  // Trailing zeroes stripped: an integral double prints as an integer.
  ['str(2)', '2'],
  ['str(2.0)', '2'],
  ['str(-0)', '0'],
  // Fixed vs scientific — the rows that rule out `%g`.
  ['str(0.000012345678)', '0.0000123457'],
  ['str(1e-10)', '1e-10'],
  ['str(1234567)', '1.23457e+6'],
  ['str(123456789)', '1.23457e+8'],
  ['str(100000000)', '1e+8'],
  // A range always prints its step, where `echo` omits a step of 1.
  ['str([0:2])', '[0 : 1 : 2]'],
];

for (const [expr, expected] of OPENSCAD) {
  test(`${expr} matches OpenSCAD exactly`, () => {
    const { text, refusals } = strOf(expr);
    assert.deepEqual(refusals, [], `${expr} must not be refused`);
    assert.equal(text, expected);
  });
}

test('str() is no longer refused at all — the refusal was the defect', () => {
  // 65 of 73 live hardware divergences touched this. A refusal does not merely
  // lose the string: it takes the whole subtree of whatever used it.
  const r = parseScad('x = str("n=", 5); echo(x);', {});
  assert.deepEqual(r.unsupported.map((u) => u.name), []);
  assert.deepEqual(r.errors.map((e) => e.message), []);
});

test('a DELIBERATE divergence: str(1/0) and str(0/0) — division by zero is refused upstream', () => {
  /*
   * 🔴 ASSERTED AS A DIVERGENCE SO IT CANNOT BE "FIXED" WITHOUT A DECISION.
   * OpenSCAD gives "inf" and "nan"; we give FAILED. That is NOT a `str()`
   * defect — `strNumber` renders inf/nan correctly when handed them. It is
   * `scad.ts`'s standing division-by-zero ruling, which predates this work:
   * *"OpenSCAD evaluates this to inf/nan and carries it into the geometry; this
   * file has no such value, so nothing is drawn for whatever used it."*
   * Refusing cannot produce a wrong part; carrying a NaN into a coordinate can.
   */
  assert.equal(strOf('str(1/0)').text, 'FAILED');
  assert.equal(strOf('str(0/0)').text, 'FAILED');
});

test('echo formatting is UNCHANGED — str() did not redefine how values print', () => {
  // `echo` quotes strings, prints full precision, and omits a step of 1. Those
  // are different from `str()` on purpose; a shared formatter would have moved
  // both and broken every existing echo assertion in the suite.
  const r = parseScad('echo("a"); echo(1/3); echo([0:2]);', {});
  assert.deepEqual(r.console.map((c) => c.message), ['"a"', '0.3333333333333333', '[0 : 2]']);
});
