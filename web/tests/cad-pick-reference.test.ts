// A click on a part in the cad 3D view puts a reference to it in the AI prompt
// (founder 2026-11-13). This file covers the TEXT: what the reference says and
// how it joins a prompt. The click itself (raycast, drag-vs-click) runs inside
// `CadPreview`'s effect and is not exercised here; it was checked in a browser
// when it landed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickReference } from '../src/cad/preview';
import { withReference } from '../src/cad/ask';

const ref = pickReference({ id: 's6@37', label: 'cube', line: 37, point: [79.54, 15, 30.849] });

test('the reference names the part, its source line and the point, to 0.1 mm', () => {
  assert.equal(ref, '[cube at line 37, point (79.5, 15, 30.8) mm]');
});

test('a reference joins the end of the prompt with one space', () => {
  assert.equal(withReference('', ref), `${ref} `);
  assert.equal(withReference('make this thicker:  ', ref), `make this thicker: ${ref} `);
});

test('the same reference twice in a row is added once (a double-click is two clicks)', () => {
  const once = withReference('make', ref);
  assert.equal(withReference(once, ref), once);
});

test('a different point is added, not swapped', () => {
  const other = pickReference({ id: 's2@12', label: 'cylinder', line: 12, point: [0, 0, 5] });
  assert.equal(withReference(withReference('', ref), other), `${ref} ${other} `);
});
