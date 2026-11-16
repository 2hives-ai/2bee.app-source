/**
 * The design page's assistant (src/shop/shopAsk.ts). Every action the model
 * returns is checked against the page's real lists; one bad action refuses the
 * whole set, and nothing opens without an id that exists.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildShopRequest, catalogueSummary, readShopReply, type ShopAskContext } from '../src/shop/shopAsk.ts';
import { readAskConfig } from '../src/cad/ask.tsx';

const ctx: ShopAskContext = {
  entries: [
    {
      id: 'hive-super-panel',
      title: 'Super panel',
      family: 'Hive',
      kind: 'cnc part',
      path: '2bee_hive/super_panel_wcnc.scad',
      sizeMm: [465, 240, 18],
      trust: 'trusted',
      describes: [{ part: 'super_panel', text: 'One side wall of a super.' }],
      partNames: ['super_panel'],
      parts: 1,
    },
    {
      id: 'hive-tray',
      title: 'Entrance tray',
      family: 'Hive',
      kind: '3D print',
      path: '2bee_hive/entrance_tray_3d.scad',
      sizeMm: [100, 40, 10],
      trust: 'suspect',
      parts: 1,
    },
  ],
  boards: [{ id: 'sensor-sub', name: 'Sensor sub', detail: '2-layer' }],
  families: ['Hive', 'Tools'],
  view: { search: '', show: 'all', family: 'all' },
  machineOf: (p) => (/_3d\.scad$/.test(p) ? 'printer' : /_wcnc\.scad$/.test(p) ? 'router' : null),
};

test('valid actions are read, and the open is ordered last', () => {
  const r = readShopReply(
    '```json\n{"answer":"Here are the hive cnc parts.","actions":[{"type":"open","id":"hive-super-panel","target":"cad"},{"type":"show","value":"cad"},{"type":"family","value":"hive"},{"type":"search","text":""},{"type":"view","id":"hive-tray"}]}\n```',
    ctx,
  );
  assert.ok(r.ok);
  assert.deepEqual(r.ok && r.actions, [
    { type: 'show', value: 'cad' },
    { type: 'family', value: 'Hive' },
    { type: 'search', text: '' },
    { type: 'view', id: 'hive-tray' },
    { type: 'open', id: 'hive-super-panel', target: 'cad' },
  ]);
});

test('an unknown id is refused and nothing is opened', () => {
  const r = readShopReply('{"answer":"Opening.","actions":[{"type":"open","id":"hive-super-pannel","target":"cad"}]}', ctx);
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.problems.join(' ') : '', /No design or board has the id "hive-super-pannel"/);
  assert.equal(readShopReply('{"actions":[{"type":"view","id":"nope"}]}', ctx).ok, false);
});

test('a bad filter refuses the whole set, good actions included', () => {
  const r = readShopReply('{"answer":"x","actions":[{"type":"family","value":"Hive"},{"type":"show","value":"cnc"}]}', ctx);
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.problems.join(' ') : '', /"cnc" is not a filter/);
  assert.equal(r.answer, 'x');
  assert.equal(readShopReply('{"actions":[{"type":"family","value":"Boats"}]}', ctx).ok, false);
});

test('targets must match the item: designs not in pnp, boards only in pnp', () => {
  assert.equal(readShopReply('{"actions":[{"type":"open","id":"hive-tray","target":"pnp"}]}', ctx).ok, false);
  assert.equal(readShopReply('{"actions":[{"type":"open","id":"sensor-sub","target":"cad"}]}', ctx).ok, false);
  assert.equal(readShopReply('{"actions":[{"type":"open","id":"hive-tray","target":"laser"}]}', ctx).ok, false);
  const ok = readShopReply('{"actions":[{"type":"open","id":"sensor-sub","target":"pnp"}]}', ctx);
  assert.deepEqual(ok.ok && ok.actions, [{ type: 'open', id: 'sensor-sub', target: 'pnp' }]);
});

test('two opens, an unknown action type, or actions that are not a list are refused', () => {
  assert.equal(
    readShopReply('{"actions":[{"type":"open","id":"hive-tray","target":"3d"},{"type":"open","id":"hive-super-panel","target":"cad"}]}', ctx).ok,
    false,
  );
  assert.equal(readShopReply('{"actions":[{"type":"delete","id":"hive-tray"}]}', ctx).ok, false);
  assert.equal(readShopReply('{"answer":"a","actions":"show cad"}', ctx).ok, false);
});

test('a plain-text reply is shown, with no actions', () => {
  const r = readShopReply('The entrance tray sits at the hive entrance.', ctx);
  assert.equal(r.ok, false);
  assert.equal(r.answer, 'The entrance tray sits at the hive entrance.');
  assert.match(!r.ok ? r.problems[0] : '', /nothing on the page was changed/);
});

test('an answer with no actions is fine', () => {
  const r = readShopReply('{"answer":"It is 100 x 40 x 10 mm.","actions":[]}', ctx);
  assert.ok(r.ok);
  assert.deepEqual(r.ok && r.actions, []);
});

test('the summary carries what the cards show and no sources', () => {
  const s = catalogueSummary(ctx);
  assert.match(s, /hive-super-panel \| Super panel \| family Hive \| cnc-cut .* \| 465x240x18 mm \| mesh trusted/);
  assert.match(s, /hive-tray \| Entrance tray .* 3d-printed/);
  assert.match(s, /sensor-sub \| Sensor sub \| PCB \(opens in pnp only\)/);
  const req = buildShopRequest(readAskConfig(null), 'what is the tray for?', ctx);
  const body = req.body as { messages: { content: string }[] };
  assert.match(body.messages[1].content, /CURRENT VIEW: show=all family=all/);
  assert.doesNotMatch(body.messages[1].content, /module|cube\(/);
});

/* Founder 2026-10-16 "in the design able to archive": archive/restore are checked like open. */
test('archive and restore are checked against the real ids and the archived list', () => {
  const c = { ...ctx, archivedIds: ['hive-tray'] };
  const ok = readShopReply('{"answer":"Hidden.","actions":[{"type":"archive","id":"hive-super-panel"},{"type":"restore","id":"hive-tray"},{"type":"show","value":"archived"}]}', c);
  assert.ok(ok.ok);
  assert.deepEqual(ok.ok && ok.actions, [
    { type: 'archive', id: 'hive-super-panel' },
    { type: 'restore', id: 'hive-tray' },
    { type: 'show', value: 'archived' },
  ]);
  for (const [a, re] of [
    ['{"type":"archive","id":"no-such"}', /No design or board has the id "no-such"/],
    ['{"type":"archive","id":"hive-tray"}', /already archived/],
    ['{"type":"restore","id":"sensor-sub"}', /not archived/],
  ] as const) {
    const r = readShopReply(`{"answer":"x","actions":[${a}]}`, c);
    assert.equal(r.ok, false, a);
    assert.match(!r.ok ? r.problems.join(' ') : '', re);
  }
  assert.match(catalogueSummary(c), /hive-tray \|.*ARCHIVED/);
  assert.doesNotMatch(catalogueSummary(c), /hive-super-panel \|.*ARCHIVED/);
});
