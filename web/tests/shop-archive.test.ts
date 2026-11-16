/**
 * The design page's Archive list (src/shop/archive.ts). It is a list of keys in
 * this browser and nothing more; the read must turn ANY stored value into a list
 * without throwing, because a throw here would take the whole design page down
 * over a hide-list.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ARCHIVE_STORAGE_KEY,
  archiveKeyOfEntry,
  archiveKeyOfMine,
  archiveKeyOfPcb,
  parseArchived,
  readArchived,
  withArchived,
  withoutArchived,
  writeArchived,
} from '../src/shop/archive.ts';

function memStore(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, v),
    m,
  };
}

test('garbage in the store reads as an empty list, never a throw', () => {
  const garbage: unknown[] = [null, undefined, '', 'not json', '{', '{"a":1}', '42', 'true', 'null', '"a string"', 42, {}, []];
  for (const g of garbage) assert.deepEqual(parseArchived(g), [], `value ${JSON.stringify(g)}`);
});

test('a list keeps only non-empty, trimmed, de-duplicated strings, in order', () => {
  assert.deepEqual(
    parseArchived(JSON.stringify(['a/b.scad', 1, null, '', '  ', ' pcb:x ', 'a/b.scad', { k: 1 }, 'mine:Mine 1', 'x'.repeat(600)])),
    ['a/b.scad', 'pcb:x', 'mine:Mine 1'],
  );
});

test('a store that throws on read or write is survived', () => {
  const bad = {
    getItem: () => {
      throw new Error('SecurityError');
    },
    setItem: () => {
      throw new Error('QuotaExceededError');
    },
  };
  assert.deepEqual(readArchived(bad), []);
  assert.equal(writeArchived(['a'], bad), false);
  assert.deepEqual(readArchived(null), []);
  assert.equal(writeArchived(['a'], null), false);
});

test('write then read round-trips under the documented key; archive/restore are idempotent', () => {
  const s = memStore();
  let k = withArchived([], archiveKeyOfEntry({ path: '2bee_hive/super_panel_wcnc.scad' }));
  k = withArchived(k, archiveKeyOfPcb('sensor-sub'));
  k = withArchived(k, archiveKeyOfMine({ id: 'mine:My lid' }));
  k = withArchived(k, 'pcb:sensor-sub');
  assert.equal(writeArchived(k, s), true);
  assert.ok(s.m.has(ARCHIVE_STORAGE_KEY));
  assert.deepEqual(readArchived(s), ['2bee_hive/super_panel_wcnc.scad', 'pcb:sensor-sub', 'mine:My lid']);
  assert.deepEqual(withoutArchived(readArchived(s), 'pcb:sensor-sub'), ['2bee_hive/super_panel_wcnc.scad', 'mine:My lid']);
  assert.deepEqual(withoutArchived(['a'], 'b'), ['a']);
});

test('the three key kinds cannot collide', () => {
  const keys = [archiveKeyOfEntry({ path: 'x' }), archiveKeyOfMine({ id: 'mine:x' }), archiveKeyOfPcb('x')];
  assert.equal(new Set(keys).size, 3);
});
