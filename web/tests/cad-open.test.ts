// Opening a saved 2bee.cad model back into the editor.
//
// WHAT THIS FILE EXERCISES
//   · 🔴 that a record whose verification FAILS cannot open silently. This is
//     the one rule in the open path whose failure is invisible: a stale record
//     that opens without a word looks exactly like a good one that opened, and
//     the user is then editing source that does not describe the mesh the CNC
//     tab would cut.
//   · that the decision keys on the ONE good status, so a verification status
//     added later confirms by construction rather than falling through to
//     silence.
//
// ⚠ WHAT MOVED OUT OF THIS FILE, 2026-08-11. `openDecision` used to take
// `dirty` as well, and confirmed whenever the editor held unsaved work. That
// confirm is gone (founder: *"remove … alerts"*) and the recovery it was
// standing in for is real: `replace.ts` stashes what every replacement
// displaced and the toolbar puts it back. **The assertions about not losing
// unsaved work moved WITH the mechanism to `cad-replace.test.ts` — they were
// not weakened and they were not dropped.** What is asserted here is what is
// still decided here: a record that does not verify.
//
// The records are REAL: parsed, meshed and built through `buildCadRecord`, then
// staled by editing the stored bytes or the stored source the way drift would.
// A hand-written fixture would be a record that agrees with the checker because
// the same author wrote both.
//
// 🔴 NOT EXERCISED: `CadOpen` itself is not rendered here. It reads IndexedDB in
// an effect and its decision runs inside an async click handler, neither of
// which this harness has. What is asserted is the RULE the handler calls —
// which is why the rule was lifted out of the handler in the first place.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { parseScad } = await import('../src/cad/scad.ts');
const { meshScene } = await import('../src/cad/mesh.ts');
const { buildCadRecord, verifyCadRecord } = await import('../src/cad/record.ts');
const { openDecision } = await import('../src/cad/open.tsx');

const SRC = 'cube([20, 10, 5]);\n';

function record(source = SRC, name = 'part') {
  const parse = parseScad(source);
  const mesh = meshScene(parse.scene);
  const built = buildCadRecord({ name, source, parse, mesh, now: 1 });
  assert.ok(built.ok, `fixture should build: ${built.ok ? '' : built.refusal.headline}`);
  return built.record;
}

test('the fixture verifies before anything is done to it', () => {
  assert.equal(verifyCadRecord(record()).status, 'ok');
});

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

test('a verified record opens straight away', () => {
  assert.equal(openDecision(verifyCadRecord(record())), 'open');
});

/**
 * 🔴 THE PLANT TARGET. Make this return `'open'` and this test goes red — which
 * is the only way to know it was ever a real check.
 */
test('a record whose SOURCE moved must not open silently', () => {
  const rec = record();
  rec.cad.source += '\n// edited after the mesh was made\n';
  const v = verifyCadRecord(rec);
  assert.equal(v.status, 'stale');
  assert.match(v.why, /SOURCE has changed/);
  assert.equal(openDecision(v), 'confirm');
});

test('a record whose MESH moved must not open silently either', () => {
  const rec = record();
  // Flip a byte well past the 84-byte header, so it is triangle data.
  rec.bytes[120] ^= 0xff;
  const v = verifyCadRecord(rec);
  assert.equal(v.status, 'stale');
  assert.match(v.why, /MESH has changed/);
  assert.equal(openDecision(v), 'confirm');
});

test('a record written by another schema must not open silently', () => {
  const rec = record();
  rec.cad.version = 999;
  const v = verifyCadRecord(rec);
  assert.equal(v.status, 'incompatible');
  assert.equal(openDecision(v), 'confirm');
});

test('verification reports WHICH half moved, and the two messages differ', () => {
  const srcMoved = record();
  srcMoved.cad.source += 'x';
  const meshMoved = record();
  meshMoved.bytes[120] ^= 0xff;
  const a = verifyCadRecord(srcMoved);
  const b = verifyCadRecord(meshMoved);
  assert.equal(a.status, 'stale');
  assert.equal(b.status, 'stale');
  assert.notEqual(a.why, b.why, 'a caller that shows one sentence for both hides which half moved');
});

// ---------------------------------------------------------------------------
// The one status that opens, and everything else
// ---------------------------------------------------------------------------

/**
 * ⚠ `'open'` is the narrow case, written as an equality against the ONE good
 * status. A fourth `CadVerification` status added later must confirm by
 * construction — the failure mode of a `switch` over the bad cases is that the
 * new one falls through to silence, which here means opening a record nothing
 * checked.
 */
test('an unknown verification status confirms rather than opening', () => {
  const invented = { status: 'something-new-nobody-has-written-yet' } as never;
  assert.equal(openDecision(invented), 'confirm');
});

/**
 * 🔴 THE CONFIRM THAT SURVIVED IS A REFUSAL, NOT A PERMISSION REQUEST. Unsaved
 * work in the editor no longer forces one — `cad-replace.test.ts` holds the
 * assertions that opening stashes what it replaced. A record whose mesh no
 * longer belongs to its source still does, because nothing can put THAT right.
 */
test('the surviving confirm fires on the record, and on nothing else', () => {
  assert.equal(openDecision(verifyCadRecord(record())), 'open', 'a verified record must not interrupt');
  const rec = record();
  rec.cad.source += 'x';
  assert.equal(openDecision(verifyCadRecord(rec)), 'confirm');
});

// ---------------------------------------------------------------------------
// What opening puts in the editor
// ---------------------------------------------------------------------------

test('the stored source is the exact text that was meshed, so opening round-trips it', () => {
  const rec = record();
  assert.equal(rec.cad.source, SRC);
  const reparsed = parseScad(rec.cad.source);
  assert.equal(reparsed.errors.length, 0);
  assert.deepEqual(
    meshScene(reparsed.scene).stats.triangles,
    meshScene(parseScad(SRC).scene).stats.triangles,
  );
});
