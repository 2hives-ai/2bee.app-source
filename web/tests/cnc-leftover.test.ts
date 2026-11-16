import { test } from 'node:test';
import assert from 'node:assert/strict';
import { leftoverSurface } from '../src/cnc/leftover.ts';
import { decodeStockSurface, type StockSurface } from '../src/cam.ts';

function flat(cols: number, rows: number): StockSurface {
  const z = new Float32Array(cols * rows); // all uncut (0)
  const b = new Uint8Array(z.buffer);
  let s = ''; for (const x of b) s += String.fromCharCode(x);
  return { cols, rows, cell_mm: 1, origin_x_mm: 0, origin_y_mm: 0, z_mm_b64: btoa(s) };
}
const sq = (x0: number, y0: number, x1: number, y1: number) => ({ verts: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([x, y]) => ({ x, y, bulge: 0 })), closed: true });

test('a part with a hole: the part area is removed, the hole and the outside are kept', () => {
  const s = leftoverSurface(flat(20, 20), [{ name: 'p', outer: sq(2, 2, 12, 12), inners: [sq(5, 5, 8, 8)] }], null, -18);
  const z = decodeStockSurface(s).z_mm;
  const at = (x: number, y: number) => z[y * 20 + x];
  assert.equal(at(3, 3), -18, 'inside the part: removed');
  assert.equal(at(6, 6), 0, 'inside the hole: panel material stays');
  assert.equal(at(15, 15), 0, 'outside the part: panel stays');
});
