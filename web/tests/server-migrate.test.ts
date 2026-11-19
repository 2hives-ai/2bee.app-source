// One-time migration of browser data to the server store (src/serverMigrate.ts).
// Guards: no overwrite of a different server copy, no two sources on one doc,
// keys the server's id pattern refuses still get a stable id, a dry run writes
// nothing, and a failure is never reported as done.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { docIdFor, planMigration, runMigration, type Snapshot } from '../src/serverMigrate.ts';
import { DOC_ID_RE, type ServerStore } from '../src/serverStore.ts';

const snap = (p: Partial<Snapshot> = {}): Snapshot => ({
  origin: 'http://localhost:5178', exported_at: '2026-11-19T04:22:00Z',
  localStorage: {
    '2bee.app.cncjob.machines': '{"machines":[1]}',
    '2bee.app.machines.printers': '[{"id":"x2d"}]',
    '2bee.app.cad.session': '{"text":"cube();"}',
    '2bee.app.session': '{"tab":"cnc"}',
    '2bee.app.tab': '"cad"',
    '2bee.app.thumb.pcb:outlet': 'data:image/png;base64,AAAA',
    '2bee.app.spec.my part': 'not json at all',
  },
  indexedDB: {
    '2bee.slicer': {
      drawings: [
        { key: 'Feeder', value: { name: 'Feeder', data: { bytes: { __bytes: 'Uint8Array', b64: 'AQID' } } } },
        { key: '2bee_hive_fan_box_panel_wcnc (2)', value: { name: 'a' } },
        { key: '2bee_hive_fan_box_panel_wcnc (3)', value: { name: 'b' } },
      ],
      machines: [{ key: 'H-1325EOT', value: { travelX: 1300 } }],
      operations: [],
    },
  },
  ...p,
});

test('docIdFor: a valid key is kept; any other key gets a valid, stable, distinct id', () => {
  assert.equal(docIdFor('H-1325EOT'), 'H-1325EOT');
  const a = docIdFor('2bee_hive_fan_box_panel_wcnc (2)');
  const b = docIdFor('2bee_hive_fan_box_panel_wcnc (3)');
  const c = docIdFor('sill planter bracket (personal project, NOT a fleet part)');
  for (const id of [a, b, c]) assert.match(id, DOC_ID_RE);
  assert.notEqual(a, b);
  assert.notEqual(docIdFor('a b'), docIdFor('a/b'), 'keys whose slugs collide still get distinct ids');
  assert.equal(a, docIdFor('2bee_hive_fan_box_panel_wcnc (2)'), 'same key, same id on every run');
  assert.match(docIdFor('x'.repeat(300)), DOC_ID_RE);
});

test('plan: (b) data moves, UI settings and caches do not, every row is accounted for', () => {
  const { docs, skipped } = planMigration(snap());
  const ids = docs.map((d) => `${d.kind}/${d.docId}`).sort();
  assert.deepEqual(ids.filter((i) => !i.startsWith('drawing/2bee_hive')), [
    'cad-session/session', 'cnc-session/session', 'drawing/Feeder', 'machine-registry/registry',
    'machine/H-1325EOT', 'printers/printers', `spec/${docIdFor('my part')}`,
  ]);
  assert.equal(docs.filter((d) => d.kind === 'drawing').length, 3);
  assert.ok(skipped.some((s) => s.includes('2bee.app.tab')));
  assert.ok(skipped.some((s) => s.includes('2bee.app.thumb.pcb:outlet')));
  const feeder = docs.find((d) => d.docId === 'Feeder')!;
  assert.deepEqual(feeder.data.record, { name: 'Feeder', data: { bytes: { __bytes: 'Uint8Array', b64: 'AQID' } } }, 'stored as it was');
  assert.equal(feeder.data.source_key, 'Feeder');
  const spec = docs.find((d) => d.kind === 'spec')!;
  assert.equal(spec.data.record, 'not json at all');
  assert.equal(spec.data.record_is_text, true);
});

test('plan: two sources that would land on one doc are refused, not merged', () => {
  const s = snap({ indexedDB: { '2bee.slicer': { drawings: [{ key: 'a b', value: 1 }, { key: docIdFor('a b'), value: 2 }] } } });
  assert.throws(() => planMigration(s), /two sources map to drawing\//);
});

function fakeStore(server: Map<string, unknown>, failPut = false) {
  const puts: string[] = [];
  const store = {
    async get(kind: string, id: string) {
      const k = `${kind}/${id}`;
      return server.has(k)
        ? { ok: true, value: { kind, doc_id: id, version: 3, size: 1, has_body: false, created_at: 0, updated_at: 0, data: server.get(k) } }
        : { ok: false, reason: 'not_found', status: 404, message: 'Not found on the server.' };
    },
    async put(kind: string, id: string, data: unknown, base: number) {
      puts.push(`${kind}/${id}@${base}`);
      if (failPut) return { ok: false, reason: 'offline', status: 0, message: 'Could not reach the server. Nothing was stored on the server.' };
      server.set(`${kind}/${id}`, data);
      return { ok: true, value: { kind, doc_id: id, version: 1, size: 1, has_body: false, created_at: 0, updated_at: 0 } };
    },
  } as unknown as ServerStore;
  return { store, puts };
}

test('run: dry run writes nothing; apply creates only missing docs with base_version 0', async () => {
  const { docs } = planMigration(snap());
  const server = new Map<string, unknown>();
  const { store, puts } = fakeStore(server);
  const dry = await runMigration(store, docs, { apply: false });
  assert.equal(puts.length, 0);
  assert.ok(dry.lines.every((l) => l.outcome === 'would-create'));
  const run = await runMigration(store, docs, { apply: true });
  assert.equal(run.ok, true);
  assert.ok(puts.every((p) => p.endsWith('@0')));
  assert.equal(run.lines.filter((l) => l.outcome === 'created').length, docs.length);
  // A second run, from a later export of the same data, finds it all there.
  const later = planMigration(snap({ exported_at: '2026-11-20T00:00:00Z' })).docs;
  const again = await runMigration(store, later, { apply: true });
  assert.ok(again.lines.every((l) => l.outcome === 'already-there'), JSON.stringify(again.lines));
  assert.equal(puts.length, docs.length, 'nothing written twice');
});

test('run: a different server copy is a conflict, left alone, and the run is not ok', async () => {
  const { docs } = planMigration(snap());
  const server = new Map<string, unknown>([['machine/H-1325EOT', { record: { travelX: 999 } }]]);
  const { store, puts } = fakeStore(server);
  const r = await runMigration(store, docs, { apply: true });
  assert.equal(r.ok, false);
  assert.equal(r.lines.find((l) => l.docId === 'H-1325EOT')!.outcome, 'conflict');
  assert.ok(!puts.includes('machine/H-1325EOT@0'));
  assert.deepEqual(server.get('machine/H-1325EOT'), { record: { travelX: 999 } });
});

test('run: a failed put is reported failed and the run is not ok', async () => {
  const { docs } = planMigration(snap());
  const { store } = fakeStore(new Map(), true);
  const r = await runMigration(store, docs, { apply: true });
  assert.equal(r.ok, false);
  assert.ok(r.lines.every((l) => l.outcome === 'failed'));
  assert.match(r.lines[0].detail, /Nothing was stored/);
});
