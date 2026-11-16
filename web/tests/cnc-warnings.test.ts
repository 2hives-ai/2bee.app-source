import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cncWarnings } from '../src/cnc/warnings.ts';

test('the core\'s skipped-pocket warnings are read with the cutter they name', () => {
  const w = cncWarnings([
    'pocket: something else',
    "⚠ WARNING — pocket: NO TOOL IN THIS LIBRARY CAN CUT THIS POCKET. 1 tool(s) … This pocket is SKIPPED (NOT cut); the rest of the job is planned. No catalogue cutter can cut it; a generic cutter can cut it: 'GENERIC End Mill 4mm x 20mm cut, 6mm shank, 2F up-cut' — buy one",
    "⚠ WARNING — slot: NO TOOL … SKIPPED (NOT cut); … A catalogue cutter can cut it: 'End Mill - Down-cut 4mm 2F' — add it",
    '⚠ WARNING — notch: NO TOOL … SKIPPED (NOT cut); … No cutter in the whole catalogue can cut it either',
  ]);
  assert.deepEqual(w.map((x) => [x.op, x.tool]), [
    ['pocket', 'GENERIC End Mill 4mm x 20mm cut, 6mm shank, 2F up-cut'],
    ['slot', 'End Mill - Down-cut 4mm 2F'],
    ['notch', null],
  ]);
});
