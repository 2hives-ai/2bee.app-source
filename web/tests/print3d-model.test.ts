// The 2bee.3d tab's pure half (web/src/print3d/model.ts, bridges.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EMPTY_JOB, finishAt, syncSlots, jobBody, plateFp, saveBody, splitShells, waitingReason, withoutRow, withQty, writeBinaryStl, type JobState } from '../src/print3d/model.ts';
import { bridgesForStorage, cleanUrl, readBridges, BRIDGES_KEY, client } from '../src/print3d/bridges.ts';

function cube(ox: number): number[] {
  const v = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0], [0, 0, 10], [10, 0, 10], [10, 10, 10], [0, 10, 10]].map(([x, y, z]) => [x + ox, y, z]);
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  return f.flatMap((t) => t.flatMap((k) => v[k]));
}

const slots = [{ id: 'ams1-3', label: 'AMS slot 3', type: 'PETG', color: '#2e9e5b' }, { id: 'ams1-1', label: 'AMS slot 1', type: '', color: '#ffffff' }];
const job: JobState = {
  ...EMPTY_JOB,
  name: 'cube',
  process: 'p',
  files: [{ name: 'cube.stl', size: 684, sha256: 'a'.repeat(64) }],
  objects: [{ uid: 1, gid: 1, file: 0, slot: 'ams1-3', placement: { x: 1, y: 2, rot: 0 }, plate: 1 }],
};

test('split: two separate cubes are two parts; one cube is one', () => {
  assert.equal(splitShells(writeBinaryStl(Float32Array.from([...cube(0), ...cube(30)]))).length, 2);
  assert.equal(splitShells(writeBinaryStl(Float32Array.from(cube(0)))).length, 1);
  // PLANT: touching cubes share a face's vertices and stay together.
  assert.equal(splitShells(writeBinaryStl(Float32Array.from([...cube(0), ...cube(10)]))).length, 1);
});

test('quantity adds unplaced copies in the same row, removal drops unused files', () => {
  let n = 10;
  const j3 = withQty(job, 1, 3, () => ++n);
  assert.equal(j3.objects.length, 3);
  assert.deepEqual(j3.objects.slice(1).map((o) => [o.gid, o.placement, o.plate]), [[1, null, null], [1, null, null]]);
  assert.equal(saveBody(j3, 'Textured PEI Plate').objects.length, 1);
  assert.equal((saveBody(j3, 'Textured PEI Plate').objects[0] as { qty?: number }).qty, 3);
  const gone = withoutRow(j3, 1);
  assert.equal(gone.objects.length, 0);
  assert.equal(gone.files.length, 0);
});

test('jobBody: arrange drops placements and plates; slicing keeps them', () => {
  assert.deepEqual(jobBody(job, 'Cool Plate', true).objects, [{ file: 0, slot: 'ams1-3', placement: null }]);
  assert.deepEqual(jobBody(job, 'Cool Plate').objects, [{ file: 0, slot: 'ams1-3', placement: { x: 1, y: 2, rot: 0 }, bed: 1 }]);
  assert.equal(jobBody(job, 'Cool Plate').bed, 'Cool Plate');
});

test('a plate fingerprint moves with every input of its G-code', () => {
  const f0 = plateFp(job, 1, 'Textured PEI Plate', slots);
  assert.notEqual(plateFp({ ...job, overrides: { wall_loops: '4' } }, 1, 'Textured PEI Plate', slots), f0);
  assert.notEqual(plateFp(job, 1, 'Cool Plate', slots), f0);
  assert.notEqual(plateFp({ ...job, process: 'q' }, 1, 'Textured PEI Plate', slots), f0);
  assert.equal(plateFp(job, 1, 'Textured PEI Plate', slots), f0);
  assert.equal(waitingReason(job, 1, slots), '');
  assert.match(waitingReason({ ...job, objects: [{ ...job.objects[0], slot: 'ams1-1' }] }, 1, slots), /AMS slot 1/);
});

test('finishAt names tomorrow', () => {
  assert.equal(finishAt(3600, new Date(2026, 9, 15, 23, 30)), 'done tomorrow 00:30');
  assert.equal(finishAt(0), '');
});

test('bridge addresses: loopback with a port only', () => {
  assert.equal(cleanUrl('http://127.0.0.1:8789/'), 'http://127.0.0.1:8789');
  assert.equal(cleanUrl('http://localhost:8788'), 'http://localhost:8788');
  for (const bad of ['https://2bee.app', 'http://192.168.1.5:8789', 'http://127.0.0.1', 'http://evil.example.com:8789']) assert.equal(cleanUrl(bad), '', bad);
});

test('a key is stored and read back only when "remember" was ticked', () => {
  const b = { engine: { url: 'http://127.0.0.1:8789', token: 'k'.repeat(20), remember: false }, printer: { url: 'http://127.0.0.1:8788', token: 'p'.repeat(20), remember: true } };
  const stored = bridgesForStorage(b) as { engine: Record<string, unknown>; printer: Record<string, unknown> };
  assert.equal('token' in stored.engine, false);
  assert.equal(stored.printer.token, 'p'.repeat(20));
  const forged = { getItem: (k: string) => (k === BRIDGES_KEY ? JSON.stringify({ engine: { url: 'http://127.0.0.1:8789', token: 'x'.repeat(20) } }) : null), setItem() {} };
  assert.equal(readBridges(forged).engine.token, '');
});

test('the client refuses before fetching when unset, and sends the bearer key', async () => {
  let calls = 0;
  const f = async (_u: string, init?: RequestInit) => {
    calls++;
    assert.equal((init?.headers as Record<string, string>).authorization, `Bearer ${'k'.repeat(20)}`);
    return new Response('{"ok":true}', { status: 200 });
  };
  await assert.rejects(client({ url: '', token: '', remember: false }, 'slicer bridge', f).json('GET', '/v1/health'), /not set up/);
  assert.equal(calls, 0);
  assert.deepEqual(await client({ url: 'http://127.0.0.1:8789', token: 'k'.repeat(20), remember: false }, 'slicer bridge', f).json('GET', '/v1/health'), { ok: true });
  const r401 = async () => new Response('{}', { status: 401 });
  await assert.rejects(client({ url: 'http://127.0.0.1:8789', token: 'k'.repeat(20), remember: false }, 'slicer bridge', r401).json('GET', '/v1/x'), /refused the key/);
});

test('syncSlots: the printer report wins; an unknown type is refused, never mapped; unreported slots keep their declaration', () => {
  const stored = [
    { id: 'ams1-1', label: 'AMS slot 1', type: '', color: '#ffffff' },
    { id: 'ams1-2', label: 'AMS slot 2', type: 'PLA', color: '#ff0000' },
    { id: 'ams1-3', label: 'AMS slot 3', type: 'PETG', color: '#2e9e5b' },
    { id: 'ext', label: 'External spool', type: 'TPU', color: '#111111' },
  ];
  const known = ['', 'PLA', 'PETG', 'TPU'];
  const r = syncSlots(stored, [
    { id: 'ams1-1', type: 'PETG', color: '#f2754e' }, // spool loaded on the printer
    { id: 'ams1-2', type: '', color: '#000000' }, // spool taken out: empty, colour kept
    { id: 'ams1-3', type: 'PLA-S', color: '#ffffff' }, // a type the slicer does not know
  ], known);
  assert.equal(r.changed, true);
  assert.deepEqual(r.slots.map((s) => [s.id, s.type, s.color]), [
    ['ams1-1', 'PETG', '#f2754e'],
    ['ams1-2', '', '#ff0000'],
    ['ams1-3', '', '#2e9e5b'],
    ['ext', 'TPU', '#111111'],
  ]);
  assert.deepEqual(r.unknown, [{ id: 'ams1-3', label: 'AMS slot 3', type: 'PLA-S' }]);
  assert.deepEqual(r.live, ['ams1-1', 'ams1-2', 'ams1-3']);
  // Already in line: nothing to save, so no write loop.
  const again = syncSlots(r.slots, [{ id: 'ams1-1', type: 'PETG', color: '#f2754e' }, { id: 'ams1-2', type: '', color: '#000000' }], known);
  assert.equal(again.changed, false);
  // A reported colour of null keeps the stored colour.
  assert.equal(syncSlots(stored, [{ id: 'ams1-2', type: 'PLA', color: null }], known).changed, false);
});

/* ── per-part settings and Clone (founder 2026-11-13) ── */
import { OBJECT_KEYS, rows, splitObjectKeys, withClonedRow, withRowOverrides } from '../src/print3d/model.ts';

test('Clone makes a NEW row with its own settings; quantity copies share one row', () => {
  let uid = 100;
  const base: JobState = { ...EMPTY_JOB, files: [{ name: 'b.stl', size: 1, sha256: 'a'.repeat(64) }], objects: [{ uid: 1, gid: 1, file: 0, slot: 'ams1-1', placement: null, plate: null }] };
  let j = withRowOverrides(base, 1, { wall_loops: '4', layer_height: '0.1' });
  assert.deepEqual(j.objects[0].overrides, { wall_loops: '4' }, 'a plate-wide key never becomes a part setting');
  j = withClonedRow(j, 1, () => ++uid, 2);
  assert.equal(rows(j).length, 2);
  assert.deepEqual(j.objects[1].overrides, { wall_loops: '4' });
  j = withRowOverrides(j, 2, { wall_loops: '6', sparse_infill_density: '40%' });
  assert.deepEqual(j.objects.map((o) => o.overrides), [{ wall_loops: '4' }, { wall_loops: '6', sparse_infill_density: '40%' }], 'the clone changes apart from the original');
  j = withQty(j, 1, 3, () => ++uid);
  assert.deepEqual(j.objects.filter((o) => o.gid === 1).map((o) => o.overrides?.wall_loops), ['4', '4', '4']);
  const body = jobBody(j, 'Textured PEI Plate');
  assert.deepEqual(body.objects.map((o) => (o as { overrides?: Record<string, string> }).overrides?.wall_loops ?? null), ['4', '4', '4', '6']);
  const saved = saveBody(j, 'Textured PEI Plate');
  assert.deepEqual(saved.objects.map((o) => [(o as { qty?: number }).qty ?? 1, (o as { overrides?: Record<string, string> }).overrides?.wall_loops]), [[3, '4'], [1, '6']]);
  j = withRowOverrides(j, 2, {});
  assert.equal(j.objects.find((o) => o.gid === 2)!.overrides, undefined, 'cleared = back to the plate');
});

test('per-part keys split from plate keys; a part setting changes the plate fingerprint', () => {
  assert.deepEqual(OBJECT_KEYS, ['wall_loops', 'top_shell_layers', 'bottom_shell_layers', 'sparse_infill_density']);
  assert.deepEqual(splitObjectKeys({ wall_loops: '3', layer_height: '0.12' }), { object: { wall_loops: '3' }, plate: { layer_height: '0.12' } });
  const j: JobState = { ...EMPTY_JOB, files: [{ name: 'b.stl', size: 1, sha256: 'a'.repeat(64) }], objects: [{ uid: 1, gid: 1, file: 0, slot: 'ams1-1', placement: { x: 1, y: 1, rot: 0 }, plate: 1 }] };
  assert.notEqual(plateFp(j, 1, 'Textured PEI Plate', []), plateFp(withRowOverrides(j, 1, { wall_loops: '5' }), 1, 'Textured PEI Plate', []));
});

import { hoursMin } from '../src/print3d/model.ts';
test('remaining time in hours and minutes', () => {
  assert.equal(hoursMin(228), '3 h 48 min');
  assert.equal(hoursMin(45), '45 min');
  assert.equal(hoursMin(120), '2 h 0 min');
  assert.equal(hoursMin(0), '0 min');
  assert.equal(hoursMin(null), '–');
  assert.equal(hoursMin(-5), '–');
});
