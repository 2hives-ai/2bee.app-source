// THE EXTERNAL SHELF'S LICENCE GATE, AND THE THREE STATES IT MUST NOT COLLAPSE.
//
// 🔴 THE GATE'S FOUNDING DEFECT IS IN HERE AS A TEST. The first collector run
// used only licence-qualified search queries and reported `refused: 0` across 130
// repositories — a control fed exclusively admissible input, which cannot fail
// and proves nothing. These cases feed `ruleLicence` the inputs a real search
// returns: `null`, `NOASSERTION`, non-commercial, no-derivatives, and licences
// nobody here has read.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ruleLicence,
  statusOf,
  statusLine,
  loadExternal,
  LICENCE_ALLOW,
  SHARE_ALIKE,
  type ExternalDesign,
  type ExternalIndex,
} from '../src/shop/external.ts';

function design(p: Partial<ExternalDesign> = {}): ExternalDesign {
  return {
    id: 'x', source: 'github', repo: 'o/r', url: 'https://github.com/o/r', commit: 'a'.repeat(40),
    title: 'r', description: '', stars: 0, licence: 'MIT', licenceUrl: '', attribution: 'o — o/r, MIT',
    shareAlike: false, files: [{ path: 'a.scad', ext: '.scad' }], ...p,
  };
}

test('an absent licence is refused, and the reason distinguishes absent from unreadable', () => {
  const none = ruleLicence(null);
  const noassert = ruleLicence('NOASSERTION');
  assert.equal(none.allowed, false);
  assert.equal(noassert.allowed, false);
  // 🔴 THE TWO MUST NOT SHARE A SENTENCE. "the author chose no licence" and "our
  // detector could not read the licence file" send a reader to different places,
  // and only the second can be cleared by a human reading the file.
  assert.notEqual(none.why, noassert.why);
  assert.match(none.why!, /all-rights-reserved/);
  assert.match(noassert.why!, /could not identify/);
});

test('non-commercial and no-derivatives are refused by CLASS, not by a list of ids', () => {
  for (const id of ['CC-BY-NC-4.0', 'CC-BY-NC-SA-4.0', 'CC-BY-NC-ND-3.0']) {
    const r = ruleLicence(id);
    assert.equal(r.allowed, false, `${id} must be refused`);
  }
  assert.match(ruleLicence('CC-BY-NC-4.0').why!, /NON-COMMERCIAL/);
  assert.match(ruleLicence('CC-BY-ND-4.0').why!, /derivative/);
});

test('an unreviewed licence is refused rather than admitted, and says it may well be fine', () => {
  const r = ruleLicence('EUPL-1.2');
  assert.equal(r.allowed, false);
  // The wording matters: a refusal that implied the licence is BAD would send
  // someone to argue with the licence instead of reading it and extending the list.
  assert.match(r.why!, /not on the reviewed allowlist/);
});

test('every allowed id is on the allowlist, and share-alike is recorded rather than refused', () => {
  for (const id of LICENCE_ALLOW) {
    const r = ruleLicence(id);
    assert.equal(r.allowed, true, `${id} is on the allowlist and must rule allowed`);
    assert.equal(r.shareAlike, SHARE_ALIKE.includes(id), `${id}: shareAlike must follow the list, not the verdict`);
  }
  // Share-alike is a fact carried FORWARD for a future hosting decision — it is
  // not a refusal, because linking to a copyleft design imposes nothing on us.
  assert.equal(ruleLicence('GPL-3.0').allowed, true);
  assert.equal(ruleLicence('GPL-3.0').shareAlike, true);
});

test('UNTESTED is a third state and is never rendered as a pass or a failure', () => {
  const untested = design();
  assert.equal(statusOf(untested), 'untested');
  assert.match(statusLine(untested), /Not tested/);
  // 🔴 The sentence must not imply anything about whether it opens. A reader who
  // takes "untested" as "broken" stops looking; one who takes it as "fine" ships it.
  assert.match(statusLine(untested), /says nothing about whether it opens/);

  const opens = design({
    verified: {
      checkedAt: '', entry: 'a.scad', opens: true, errors: 0, unsupported: [], parts: 1,
      triangles: 12, trust: 'trusted', trustDetail: '', sizeMm: [1, 1, 1],
      animation: { mentionsT: false, frames: 0, moves: false, note: '' },
    },
  });
  assert.equal(statusOf(opens), 'opens');

  const refused = design({
    verified: {
      checkedAt: '', entry: 'a.scad', opens: false, errors: 3, firstError: 'boom', unsupported: [],
      parts: 0, triangles: 0, trust: 'nothing', trustDetail: '', sizeMm: null,
      animation: { mentionsT: false, frames: 0, moves: false, note: '' },
    },
  });
  assert.equal(statusOf(refused), 'refused-by-reader');
  assert.match(statusLine(refused), /boom/);
});

test('a design that MENTIONS $t but does not move is not described as animated', () => {
  const still = design({
    verified: {
      checkedAt: '', entry: 'a.scad', opens: true, errors: 0, unsupported: [], parts: 1, triangles: 12,
      trust: 'trusted', trustDetail: '', sizeMm: [1, 1, 1],
      animation: { mentionsT: true, frames: 4, moves: false, note: 'still' },
    },
  });
  const line = statusLine(still);
  assert.match(line, /does not move/);
  assert.doesNotMatch(line, /animates over/);
});

test('a missing external.json is reported as a BUILD fact, never as an empty shelf', async () => {
  const state = await loadExternal((async () => new Response('', { status: 404 })) as unknown as typeof fetch);
  assert.equal(state.kind, 'absent');
  if (state.kind !== 'absent') return;
  assert.match(state.why, /designs:collect/);
});

test('a body without an entries array is absent, not an empty catalogue', async () => {
  const state = await loadExternal(
    (async () => new Response(JSON.stringify({ generatedAt: '' }), { status: 200 })) as unknown as typeof fetch,
  );
  assert.equal(state.kind, 'absent');
});

test('a real index loads and keeps refused/unchecked separate', async () => {
  const index: ExternalIndex = {
    generatedAt: '', note: '', queries: [], scanned: 3, listed: 1, refused: 1,
    refusedReasons: [{ repo: 'o/nc', why: 'NON-COMMERCIAL' }],
    unchecked: 1, uncheckedReasons: [{ repo: 'o/q', why: 'QUOTA' }],
    entries: [design()],
  };
  const state = await loadExternal(
    (async () => new Response(JSON.stringify(index), { status: 200 })) as unknown as typeof fetch,
  );
  assert.equal(state.kind, 'ready');
  if (state.kind !== 'ready') return;
  // 🔴 A run that folded a quota into `refused` would report a rate limit as a
  // licence finding and send the next reader hunting a legal problem.
  assert.equal(state.index.refused, 1);
  assert.equal(state.index.unchecked, 1);
  assert.notEqual(state.index.refusedReasons[0].why, state.index.uncheckedReasons[0].why);
});
