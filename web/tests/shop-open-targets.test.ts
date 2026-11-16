// Founder 2026-10-15: "in the design able to open every item in cad , cnc or 3d"
// and "filter to see only my designs what I changed and saved".
//
// The handoff now has one slot PER TARGET. The property that matters is
// isolation: a cnc or 3d request must never be claimed by the cad tab (that
// would replace the editor's text for a click that never asked for it).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  claimPending,
  claimPendingFor,
  requestOpen,
  requestOpenIn,
  resetHandoff,
  subscribeHandoff,
  subscribeHandoffFor,
  type Pending3d,
  type PendingDesign,
} from '../src/shop/handoff.ts';
import { freeDrawingName } from '../src/shop/toCnc.ts';
import { mineDesign, mineNote, toMineItem } from '../src/shop/mine.ts';

const design = (id: string): PendingDesign => ({
  id,
  title: id,
  path: `${id}.scad`,
  source: 'cube(1);',
  files: { [`${id}.scad`]: 'cube(1);' },
});
// The 3d slot carries the design PLUS its STL (`Pending3d`); the bytes are
// irrelevant to slot isolation, so an empty STL stands in.
const design3d = (id: string): Pending3d => ({
  ...design(id),
  stl: { name: `${id}.stl`, bytes: new Uint8Array(), note: 'test' },
});

test('each target has its own slot: a 3d or cnc request is NOT claimable by cad', () => {
  resetHandoff();
  requestOpenIn('3d', design3d('a'));
  requestOpenIn('cnc', { id: 'b', title: 'b', cnc: { drawingName: 'b', note: 'ONE section at z = 1 mm' } });
  assert.equal(claimPending(), null, 'cad must see nothing');
  assert.equal(claimPendingFor('3d')?.id, 'a');
  assert.equal(claimPendingFor('cnc')?.cnc.drawingName, 'b');
  assert.equal(claimPendingFor('3d'), null, 'claiming clears');
});

test('a listener on one target does not receive another target\'s request', () => {
  resetHandoff();
  const cad: string[] = [];
  const d3: string[] = [];
  subscribeHandoff((d) => cad.push(d.id));
  subscribeHandoffFor('3d', (d) => d3.push(d.id));
  requestOpenIn('3d', design3d('x'));
  requestOpen(design('y'));
  assert.deepEqual(cad, ['y']);
  assert.deepEqual(d3, ['x']);
});

test('freeDrawingName never overwrites someone else\'s drawing of the same name', async () => {
  const store = new Map<string, unknown>([
    ['Hive cleat', { bytes: new Uint8Array(), format: 'dxf', name: 'Hive cleat' }],
  ]);
  const load = async (n: string) => (store.has(n) ? { data: store.get(n) } : null);
  assert.equal(await freeDrawingName('Hive cleat', 'cube(1);', load), 'Hive cleat (2)');
  assert.equal(await freeDrawingName('Other', 'cube(1);', load), 'Other');
});

test('Mine: a saved drawing FILE has no source — no cad/3d design, and the note says cnc only', () => {
  const m = toMineItem({ name: 'plate', saved_at: 1, data: { bytes: new Uint8Array(), format: 'dxf', name: 'plate' } });
  assert.equal(m.kind, 'drawing');
  assert.equal(mineDesign(m), null);
  assert.match(mineNote(m), /cnc only/);
});
