// Founder 2026-11-12: "when I click save in the cad automatically add a name for the design (prefill)".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nameFromPath, nameFromSource, suggestSaveName, uniqueName } from '../src/cad/saveName';

test('an already-saved model keeps its name', () => {
  assert.equal(suggestSaveName({ savedName: 'My lid', title: 'Hive lid', path: 'a/b.scad' }), 'My lid');
});

test('order: card title, then file name, then first comment, then a dated name', () => {
  assert.equal(suggestSaveName({ savedName: null, title: 'Pot saucer 18cm', path: '2bee_household/pot_saucer_18cm_3d.scad' }), 'Pot saucer 18cm');
  assert.equal(suggestSaveName({ savedName: null, path: '2bee_household/pot_saucer_18cm_3d.scad' }), 'Pot saucer 18cm 3d');
  assert.equal(suggestSaveName({ savedName: null, source: '// pot_saucer_18cm_3d.scad — plain saucer for the pot.\ncube(1);' }), 'plain saucer for the pot');
  assert.equal(suggestSaveName({ savedName: null, source: 'cube(1);', now: new Date(2026, 10, 12, 9, 5) }), 'Design 2026-11-12 09.05');
});

test('helpers', () => {
  assert.equal(nameFromPath(''), '');
  assert.equal(nameFromSource('cube(1); // late comment'), '', 'code before any comment: no name from the source');
});

test('the prefill never silently replaces a saved record', () => {
  assert.equal(uniqueName('Pot saucer 18cm', []), 'Pot saucer 18cm');
  assert.equal(uniqueName('Pot saucer 18cm', ['Pot saucer 18cm']), 'Pot saucer 18cm 2');
  assert.equal(uniqueName('Pot saucer 18cm', ['Pot saucer 18cm', 'Pot saucer 18cm 2']), 'Pot saucer 18cm 3');
  assert.ok(uniqueName('x'.repeat(120), ['x'.repeat(120)]).length <= 120);
});
