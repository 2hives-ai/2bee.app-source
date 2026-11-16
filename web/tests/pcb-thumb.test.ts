/* pcbThumb.ts — a PCB's saved picture (founder 2026-10-16: "when I open the pcb
 * in 3d view able to save the thumbnail"). The failure guarded: a board picking
 * up a DESIGN's picture (or the reverse) because both share one localStorage
 * store and a board id can equal a design name. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { pcbThumbKey, savedPcbPicture, savePcbPicture } from '../src/shop/pcbThumb';
import { readThumbnail, saveThumbnail, THUMB_PREFIX } from '../src/cnc/thumbnail';

function memoryStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    keys: () => [...m.keys()],
  };
}

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

test('the key is pcb:<boardId>', () => {
  assert.equal(pcbThumbKey('sensor_pod'), 'pcb:sensor_pod');
});

test('a saved board picture reads back under its board id, and only there', () => {
  const s = memoryStorage();
  (globalThis as { localStorage?: unknown }).localStorage = s;
  try {
    assert.equal(savedPcbPicture('sensor_pod'), null);
    assert.equal(savePcbPicture('sensor_pod', PNG), true);
    assert.deepEqual(s.keys(), [THUMB_PREFIX + 'pcb:sensor_pod']);
    assert.equal(savedPcbPicture('sensor_pod')?.dataUrl, PNG);
    assert.equal(savedPcbPicture('other_board'), null);
    // A design called the same as the board must not see the board's picture, nor the reverse.
    assert.equal(readThumbnail('sensor_pod'), null);
    saveThumbnail('relay_board', PNG);
    assert.equal(savedPcbPicture('relay_board'), null);
  } finally {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});

test('an empty board id is refused, not filed under "pcb:"', () => {
  const s = memoryStorage();
  (globalThis as { localStorage?: unknown }).localStorage = s;
  try {
    assert.equal(savePcbPicture('', PNG), false);
    assert.equal(savedPcbPicture(''), null);
    assert.deepEqual(s.keys(), []);
  } finally {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});

test('no storage at all: reads null, save reports false', () => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
  assert.equal(savedPcbPicture('sensor_pod'), null);
  // saveThumbnail alone returns true here (optional chaining); the read-back must catch it.
  assert.equal(saveThumbnail('x', PNG), true);
  assert.equal(savePcbPicture('sensor_pod', PNG), false);
});
