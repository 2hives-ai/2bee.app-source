/**
 * The stored 2bee.cad layout. Founder 2026-10-12: the left code column can be
 * hidden. The rule under test is the one `readLayout` states: only a stored
 * literal `true` hides the editor, so a corrupt preference blob can never leave
 * the operator with no code on screen.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LAYOUT, readLayout } from '../src/cad/CadTab.tsx';

test('the editor is shown by default and on every corrupt or missing value', () => {
  assert.equal(DEFAULT_LAYOUT.editorHidden, false);
  for (const raw of [null, '', 'not json', '[]', '{}', '{"editorHidden":1}', '{"editorHidden":"true"}', '{"editorHidden":null}']) {
    assert.equal(readLayout(raw).editorHidden, false, `raw=${raw}`);
  }
});

test('a stored true hides it, and the other fields survive alongside', () => {
  const l = readLayout(JSON.stringify({ ...DEFAULT_LAYOUT, editorHidden: true, split: 0.6 }));
  assert.equal(l.editorHidden, true);
  assert.equal(l.split, 0.6);
});
