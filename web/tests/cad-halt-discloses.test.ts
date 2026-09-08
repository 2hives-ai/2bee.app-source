/**
 * A halt must say that nothing after it was checked.
 *
 * 🔴 WHY: every `Halt` stops evaluation of the WHOLE program. The top-level
 * catch then builds a scene from what ran and reports the errors collected so
 * far — so the reader sees ONE error and has no way to know the rest of the file
 * was never evaluated. They fix it and re-run believing they saw everything.
 *
 * ⚠ Only the MAX_NODES and recursion messages said so. The loop cap, the call
 * depth cap and both assert paths reported their own problem and stopped
 * silently — and a SINGLE error is exactly the case where "that's all of them"
 * is most convincing. Same shape as this lane's drop list: *what we could not
 * assess* reading as *what was assessed and found fine*.
 *
 * Found 2026-09-06 sweeping web/src/cad/ runtime, an owed check ceo had recorded
 * against this lane rather than closed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseScad } from '../src/cad/scad.ts';

const parse = (src: string) => parseScad(src, { path: 't.scad' });
const DISCLOSURE = /EVALUATION STOPPED HERE|Nothing after this line was evaluated/;

test('a loop-cap halt says nothing after it was checked', () => {
  const r = parse('for (i = [0:1:9999999]) { cube(1); }\ncube(2);');
  assert.ok(r.errors.length > 0, 'the loop cap did not fire at all');
  assert.match(r.errors.map((e) => e.message).join(' | '), DISCLOSURE);
});

test('a failing assert says nothing after it was checked', () => {
  /* OpenSCAD halts here too, so the SEMANTICS were right — what was missing is
   * telling our reader that our error list is therefore truncated. */
  const r = parse('assert(false, "boom");\ncube(1);');
  assert.ok(r.errors.some((e) => e.message.includes('boom')), 'the assert did not report');
  assert.match(r.errors.map((e) => e.message).join(' | '), DISCLOSURE);
});

test('a clean file carries no truncation notice', () => {
  /* The negative control: a disclosure that appears on every file is noise, and
   * a reader who sees it everywhere stops reading it. */
  const r = parse('cube(1);\nsphere(2);');
  assert.equal(r.errors.length, 0, r.errors.map((e) => e.message).join(' | '));
  assert.doesNotMatch(r.errors.map((e) => e.message).join(' | '), DISCLOSURE);
});

test('an ordinary statement error does NOT claim evaluation stopped', () => {
  /* Statement-level failures skip that statement and keep going, so claiming a
   * halt would be the opposite error — telling a reader the list is truncated
   * when it is complete. */
  const r = parse('multmatrix(7) cube(1);\ncube(2);');
  assert.ok(r.errors.length > 0, 'multmatrix(7) produced no error');
  assert.doesNotMatch(r.errors.map((e) => e.message).join(' | '), DISCLOSURE);
});
