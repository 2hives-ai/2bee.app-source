// Mine card pictures (founder 2026-11-19: "save thumbnail -> image is not updated
// on the main screen", then "make sure there is a default thumbnail").
//
// The defect: the 3D viewer saved a Mine design's picture under its LABEL
// ("your design · X.scad") while the card read its TITLE ("X"), so the saved
// picture was never shown. Plant watched red: thumbKey removed from
// mineSubject -> test 1 fails.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { saveThumbnail, THUMB_PREFIX, THUMB_SAVED_EVENT } from '../src/cnc/thumbnail.ts';
import { savedPicture } from '../src/shop/savedPicture.ts';
import { mineSubject, type MineItem } from '../src/shop/mine.ts';
import { projectIso } from '../src/shop/autoPicture.ts';

function fakeStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    get length() { return m.size; },
    key: (i: number) => [...m.keys()][i] ?? null,
    clear: () => m.clear(),
    map: m,
  };
}

const item = (title: string): MineItem => ({
  id: `mine:${title}`, title, savedAt: 1, thumb: null, kind: 'cad', rec: null, verification: null, format: null, hasImports: false,
});
const PNG = 'data:image/png;base64,AAAA';

test('the viewer saves a Mine picture under the key the card reads', () => {
  const ls = fakeStorage();
  (globalThis as { localStorage?: unknown }).localStorage = ls;
  const m = item('Hive super panel');
  const subject = mineSubject(m);
  assert.equal(subject.thumbKey, 'Hive super panel');
  assert.equal(saveThumbnail(subject.thumbKey ?? subject.path, PNG), true);
  assert.equal(savedPicture(m)?.dataUrl, PNG);
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

test('a picture saved before the fix (under the viewer label) still shows', () => {
  const ls = fakeStorage();
  (globalThis as { localStorage?: unknown }).localStorage = ls;
  ls.setItem(`${THUMB_PREFIX}your design · Pot saucer 18.5cm.scad`, JSON.stringify({ dataUrl: PNG, savedAt: 1, from: 'cnc' }));
  assert.equal(savedPicture(item('Pot saucer 18.5cm'))?.dataUrl, PNG);
  assert.equal(savedPicture(item('Other')), null);
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

test('a save announces itself so the cards redraw', () => {
  (globalThis as { localStorage?: unknown }).localStorage = fakeStorage();
  // node's globalThis is not an EventTarget; give it the browser's window shape.
  const et = new EventTarget();
  const g = globalThis as unknown as { dispatchEvent?: EventTarget['dispatchEvent'] };
  g.dispatchEvent = et.dispatchEvent.bind(et);
  const seen: string[] = [];
  et.addEventListener(THUMB_SAVED_EVENT, (e) => seen.push((e as CustomEvent<{ key: string }>).detail.key));
  saveThumbnail('Feeder', PNG);
  delete g.dispatchEvent;
  assert.deepEqual(seen, ['Feeder']);
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

/** A closed unit cube, outward-facing triangles. */
function cube(): Float32Array {
  const v = (x: number, y: number, z: number) => [x, y, z];
  const q = (a: number[], b: number[], c: number[], d: number[]) => [...a, ...b, ...c, ...a, ...c, ...d];
  const P = [v(0, 0, 0), v(1, 0, 0), v(1, 1, 0), v(0, 1, 0), v(0, 0, 1), v(1, 0, 1), v(1, 1, 1), v(0, 1, 1)];
  return new Float32Array([
    ...q(P[0], P[3], P[2], P[1]), // bottom (-z)
    ...q(P[4], P[5], P[6], P[7]), // top (+z)
    ...q(P[0], P[1], P[5], P[4]), // -y
    ...q(P[2], P[3], P[7], P[6]), // +y
    ...q(P[1], P[2], P[6], P[5]), // +x
    ...q(P[3], P[0], P[4], P[7]), // -x
  ]);
}

test('default picture: a cube shows three faces, fitted inside the picture, far faces first', () => {
  const f = projectIso(cube(), 384, 288, 16);
  assert.equal(f.length, 6, 'three visible faces = six triangles; back faces dropped');
  for (const face of f) {
    for (let i = 0; i < 6; i += 2) {
      assert.ok(face.pts[i] >= 15.99 && face.pts[i] <= 368.01, `x ${face.pts[i]}`);
      assert.ok(face.pts[i + 1] >= 15.99 && face.pts[i + 1] <= 272.01, `y ${face.pts[i + 1]}`);
    }
    assert.ok(face.shade >= 0.25 && face.shade <= 1);
  }
  for (let i = 1; i < f.length; i++) assert.ok(f[i - 1].depth >= f[i].depth, 'painted back to front');
  assert.equal(new Set(f.map((x) => x.shade.toFixed(3))).size, 3, 'three faces, three shades');
  assert.deepEqual(projectIso(new Float32Array(0)), []);
});
