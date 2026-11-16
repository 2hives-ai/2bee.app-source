/** cnc/findings.ts — the core's fixture findings in words, with the fix. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeFinding } from '../src/cnc/findings.ts';

test('RapidBelowClamp: the founder\'s exact text becomes a sentence and a safe Z', () => {
  const f = describeFinding('RapidBelowClamp { clamp: "toggle-clamp-vertical-2", z: 5.0, clamp_height: 42.4 }');
  assert.match(f.text, /fast move at 5 mm height would cross clamp "toggle-clamp-vertical-2", which stands 42\.4 mm tall/);
  assert.equal(f.safeZNeeded, 48);
  assert.equal(f.clamp, 'toggle-clamp-vertical-2');
});

test('CutsClamp and ClampHeightUndeclared are named; unknown text passes through', () => {
  assert.match(describeFinding('CutsClamp { clamp: "c1", x: 10.25, y: 3.0 }').text, /cut passes through clamp "c1" at X 10\.3, Y 3\.0/);
  assert.match(describeFinding('ClampHeightUndeclared { clamp: "c2" }').text, /has no height/);
  assert.equal(describeFinding('move outside X travel: -3').text, 'move outside X travel: -3');
});
