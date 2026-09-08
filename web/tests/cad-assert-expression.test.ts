/**
 * `assert(cond, msg) expr` — OpenSCAD's EXPRESSION form.
 *
 * 🔴 WHAT THIS GUARDS: an assert that parses but never fires is worse than one
 * the reader rejects. The reader used to reject this construct outright
 * (`expected ")"`), which dropped the whole file — visible, and safe. Now it is
 * accepted, so the failure mode moves: a condition that silently yielded the
 * trailing expression regardless would turn cad's index-bounds check into
 * decoration, and the file would render a plausible wrong picture instead of
 * refusing.
 *
 * 🟢 SIGNED EXPECTATION, stated before the measurement and then measured (cad's
 * rule, 2026-09-06: *a capability gain has a signed expectation; state it before
 * the re-run and the pass becomes a test rather than a baseline refresh*).
 * Accepting this construct can only make MORE files parse, so GAINED >= 1 and
 * REGRESSED == 0. Reconstructed the old parser by disabling the rule and parsed
 * all 620 hardware .scad both ways:
 *
 *     without the rule   522 clean / 98 errors
 *     with the rule      526 clean / 94 errors
 *     GAINED 4 — 2bee_pnp/{pnp_belt2d, pnp_drive_assembly, pnp_drive_enclosure_3d,
 *                          pnp_drive_straight_assembly}
 *     REGRESSED 0                                             -> PASS
 *
 * ⚠ The file that MOTIVATED this fix moved: cad dissolved
 * 2bee_cnc_machine/anim_s7_brackets.scad hours later. 🔴 I first wrote that it
 * "no longer exists" — WRONG, corrected 2026-09-06 (ceo). It is ARCHIVED and
 * TRACKED at `hardware/cad/archive/anim_s7_brackets.scad`, and still carries the
 * construct at line 776. ⇒ I ran `git log` on the old path, saw a commit, found
 * nothing there, and concluded deletion — searching where the file HAD been and
 * never where it went. Cite the archive path; the exhibit is openable.
 *
 * ⚠ Found 2026-09-06 because a design vanished from the Designs catalogue and
 * the listed-count band refused the build. cad had moved an assert into
 * expression position, and real OpenSCAD accepts it (verified, rc=0).
 *
 * ⚠ THE REASON CAD GAVE FOR MOVING IT IS RETRACTED (cad, 2026-09-06, by their own
 * plant): both forms behave identically, and a statement assert above its operand
 * renders cleanly. 🔴 The corrected rule, as ceo restated it to the three lanes
 * that had built on the wrong one: PLACEMENT is the variable — an assert must sit
 * ABOVE its operand, and expression position buys nothing on its own. The measured rule is that a STATEMENT sees the final value of
 * every top-level variable in scope while an ASSIGNMENT sees only what is defined
 * above it — so the hazard is a derived constant above its inputs, not an assert's
 * position. These tests are unaffected: the construct is legal OpenSCAD and this
 * reader rejected it, which is a reader gap whatever prompted its discovery.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseScad } from '../src/cad/scad.ts';

const parse = (src: string) => parseScad(src, { path: 't.scad' });

test('a passing assert yields the trailing expression', () => {
  const r = parse('function f(x) = x;\nlst = [10, 20, 30];\nv = f(assert(1 < len(lst), "bad") lst[1]);\ncube(v);');
  assert.equal(r.errors.length, 0, r.errors.map((e) => e.message).join(' | '));
  assert.equal(r.unsupported.length, 0);
});

/* ⚠ NAMED FOR WHAT IT CHECKS. This said "and stops", which the assertions do
 * not reach — they read the reported errors, not whether evaluation halted.
 * The test name is the pass message (ceo/pcb, 2026-09-06). */
test('a FAILING assert reports its own message', () => {
  /* The control that matters: accepting the syntax is worthless if the check
   * never bites. Asserted on the MESSAGE, so a generic parse failure cannot
   * masquerade as the assert firing. */
  const r = parse('function f(x) = x;\nlst = [10];\nv = f(assert(5 < len(lst), "index 5 outside 0..0") lst[5]);\ncube(v);');
  assert.ok(r.errors.length > 0, 'a false assert produced no error at all');
  assert.ok(
    r.errors.some((e) => e.message.includes('index 5 outside 0..0')),
    `the assert did not report its own message: ${r.errors.map((e) => e.message).join(' | ')}`,
  );
});

test('assert with no trailing expression is legal', () => {
  const r = parse('function g(x) = 1;\nv = g(assert(true));\ncube([v, 1, 1]);');
  assert.equal(r.errors.length, 0, r.errors.map((e) => e.message).join(' | '));
});

test('an identifier starting with assert is not swallowed by the new rule', () => {
  /* The rule fires only on `assert` immediately followed by `(`. Without that
   * guard it would eat an identifier and break files that never used the form. */
  const r = parse('assert_ok = 3;\ncube([assert_ok, 1, 1]);');
  assert.equal(r.errors.length, 0, r.errors.map((e) => e.message).join(' | '));
});

test('the statement form still fires, and with the same message', () => {
  /* Both positions must agree. A file getting one answer from a check and a
   * different one from the same check written the other way is the defect this
   * lane keeps finding in other shapes. */
  const r = parse('assert(false, "same message");\ncube(1);');
  assert.ok(r.errors.some((e) => e.message.includes('same message')), 'the statement form stopped reporting');
});
