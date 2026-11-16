/**
 * Work tabs are disabled until something is opened into them (src/loaded.ts,
 * founder 2026-10-16). A broken or hostile stored value never enables a tab.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readLoaded, tabEnabled } from '../src/loaded.ts';

const st = (v: string | null) => ({ getItem: () => v });

test('nothing stored: every work tab is disabled, catalogue/setup tabs are not', () => {
  const m = readLoaded(st(null));
  for (const id of ['cad', 'cnc', 'run', 'pnp', 'print3d'] as const) assert.equal(tabEnabled(id, m), false, id);
  for (const id of ['shop', 'tools', 'machines'] as const) assert.equal(tabEnabled(id, m), true, id);
});

test('a marked tab is enabled, and only that one', () => {
  const m = readLoaded(st('{"cad":true}'));
  assert.equal(tabEnabled('cad', m), true);
  assert.equal(tabEnabled('print3d', m), false);
});

test('garbage, non-true values and unknown keys enable nothing', () => {
  for (const raw of ['{not json', '[true]', '{"cad":"yes","cnc":1,"evil":true}', 'null']) {
    const m = readLoaded(st(raw));
    assert.deepEqual(m, {}, raw);
  }
});
