// The printer card's plate picture (plateMap.ts): drawn from the printing file's own outlines,
// and an object without one is LISTED as unplaced, never drawn at a guessed spot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plateMap } from '../src/print3d/plateMap.ts';

const sq = (x: number, y: number, s = 10): [number, number][] => [[x, y], [x + s, y], [x + s, y + s], [x, y + s]];

test('two outlines on a stated printable area: it frames the picture and Y is flipped for SVG', () => {
  const m = plateMap([{ id: 1, name: 'a', hull: sq(0, 0) }, { id: 2, name: 'b', hull: sq(50, 50) }], [[0, 0], [256, 0], [256, 256], [0, 256]]);
  assert.ok(m);
  assert.equal(m.viewBox, '-2 -258 260 260');
  assert.equal(m.shapes.length, 2);
  assert.match(m.shapes[1].path, /^M50 -50 L60 -50/);
  assert.deepEqual(m.shapes[0].label, [5, -5]);
  assert.deepEqual(m.unplaced, []);
});

test('no outline for an object: listed, not drawn; nothing to draw at all is null', () => {
  const m = plateMap([{ id: 1, name: 'a', hull: sq(0, 0) }, { id: 2, name: 'b' }], null);
  assert.ok(m);
  assert.equal(m.plate, null);
  assert.deepEqual(m.unplaced, [{ id: 2, name: 'b' }]);
  assert.deepEqual(m.shapes.map((s) => s.id), [1]);
  assert.equal(plateMap([{ id: 2, name: 'b' }], null), null);
});
