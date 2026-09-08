// THE CATALOGUE LOADER — AND "NO DESIGNS" vs "NO CATALOGUE".
//
// 🔴 THE ONE THAT MATTERS is that a missing `public/shop/` is reported as a
// BUILD fact and never rendered as an empty shop. The two look identical on
// screen and mean opposite things, and the wrong one is the reassuring
// direction: a page saying "0 designs" tells every viewer cad's library is
// empty, and nobody escalates a number that looks like an answer.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { byFamily, loadCatalogue, loadDesign, trustLine, type ShopEntry } from '../src/shop/catalogue.ts';

function entry(p: Partial<ShopEntry> = {}): ShopEntry {
  return {
    id: 'x', path: '2bee_hive/x.scad', title: 'X', family: 'Hive', familyBlurb: 'b',
    kind: 'model', parts: 1, triangles: 12, trust: 'trusted', trustDetail: 'd',
    sizeMm: [1, 2, 3], files: 1, bytes: 10, thumb: null, ...p,
  };
}

const ok = (body: unknown): typeof fetch =>
  (async () => ({ ok: true, status: 200, json: async () => body })) as unknown as typeof fetch;

test('a 404 is ABSENT with a reason, never an empty catalogue', async () => {
  const f = (async () => ({ ok: false, status: 404 })) as unknown as typeof fetch;
  const s = await loadCatalogue(f);
  assert.equal(s.kind, 'absent');
  assert.match(s.kind === 'absent' ? s.why : '', /npm run shop/);
});

test('a network failure is ABSENT, not a crash and not an empty catalogue', async () => {
  const f = (async () => {
    throw new Error('offline');
  }) as unknown as typeof fetch;
  const s = await loadCatalogue(f);
  assert.equal(s.kind, 'absent');
});

test('a catalogue with no `entries` array is ABSENT — it is not a catalogue', async () => {
  const s = await loadCatalogue(ok({ listed: 0 }));
  assert.equal(s.kind, 'absent');
});

test('a catalogue that is genuinely EMPTY is ready with zero entries', async () => {
  // The other half of the distinction: zero designs is a real, reportable
  // state and must NOT be reported as a missing build.
  const s = await loadCatalogue(ok({ entries: [], listed: 0, dropped: 0, droppedReasons: [] }));
  assert.equal(s.kind, 'ready');
  assert.equal(s.kind === 'ready' ? s.index.entries.length : -1, 0);
});

test('a design missing its own entry source is REFUSED, not opened empty', async () => {
  const f = ok({ path: '2bee_hive/x.scad', sources: { 'other.scad': 'cube(1);' } });
  await assert.rejects(() => loadDesign('x', f), /missing its entry source/);
});

test('a well-formed design comes back with its closure', async () => {
  const f = ok({ path: 'a/b.scad', sources: { 'a/b.scad': 'cube(1);', 'a/c.scad': 'x=1;' } });
  const d = await loadDesign('x', f);
  assert.equal(d.path, 'a/b.scad');
  assert.equal(Object.keys(d.sources).length, 2);
});

test('families keep catalogue order and gather their items', () => {
  const rows = byFamily([
    entry({ id: '1', family: 'Hive' }),
    entry({ id: '2', family: 'Feeder' }),
    entry({ id: '3', family: 'Hive' }),
  ]);
  assert.deepEqual(rows.map((r) => r.family), ['Hive', 'Feeder']);
  assert.deepEqual(rows[0].items.map((i) => i.id), ['1', '3']);
});

test('a non-trusted card QUOTES the mesher, it does not paraphrase the verdict', () => {
  // 🔴 The regression this guards: `suspect` used to render as "Parts of this
  // model were REFUSED", which became false when `suspect` gained a second
  // cause with nothing refused. A card must not name a mechanism that did not
  // occur — the reader would go looking for an empty refusal list.
  const altered = entry({
    trust: 'suspect',
    trustDetail: 'nothing was refused — but 1 construct(s) did not draw what the source describes',
  });
  assert.equal(trustLine(altered), altered.trustDetail);
  assert.ok(!/REFUSED and are missing/.test(trustLine(altered)));

  const refused = entry({ trust: 'suspect', trustDetail: '3 construct(s) were REFUSED and are missing' });
  assert.equal(trustLine(refused), refused.trustDetail);

  assert.match(trustLine(entry({ trust: 'trusted' })), /closed|manifold/);
  assert.ok(trustLine(entry({ trust: 'nothing', trustDetail: '' })).length > 0, 'never empty');
});
