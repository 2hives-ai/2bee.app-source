import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REACH, edgeClamps } from '../src/cnc/autoClamps.ts';

const stock = { x0: 0, y0: 0, w: 600, h: 900 };
const clamp = { id: 'toggle-clamp-horizontal', footprint: [103, 35] as [number, number], heightMm: 16.5 };

test('each clamp reaches exactly REACH mm onto the workpiece and no further', () => {
  for (const n of [2, 4, 6] as const) {
    const cs = edgeClamps(stock, clamp, n);
    assert.equal(cs.length, n);
    for (const c of cs) {
      const ix = Math.max(0, Math.min(c.x + c.w, 600) - Math.max(c.x, 0));
      const iy = Math.max(0, Math.min(c.y + c.h, 900) - Math.max(c.y, 0));
      const onWork = Math.min(ix, iy);
      assert.ok(Math.abs(onWork - REACH) < 1e-9, `${c.name} reaches ${onWork} mm onto the work`);
      assert.equal(c.height_mm, 16.5);
    }
  }
});

test('two clamps go on the LONG edges, centred', () => {
  const cs = edgeClamps(stock, clamp, 2);
  // 600 x 900: the long edges are left and right (x = 0 and x = 600).
  assert.ok(cs.some((c) => c.x < 0) && cs.some((c) => c.x + c.w > 600));
  for (const c of cs) assert.equal(c.y + c.h / 2, 450);
});
