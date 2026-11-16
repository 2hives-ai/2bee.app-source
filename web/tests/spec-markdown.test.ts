/**
 * The spec renderer keeps snake_case paths intact (founder screenshot 2026-10-16:
 * "2bee_cnc_machine/anim_demo.scad" rendered as "2beecncmachine/animdemo.scad").
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown } from '../src/spec/Markdown.tsx';

const html = (text: string) => renderToStaticMarkup(createElement(Markdown, { text }));

test('underscores inside a word are text, not emphasis', () => {
  const h = html('Source: 2bee_cnc_machine/anim_demo.scad (uses lead_cnc_params.scad)');
  assert.match(h, /2bee_cnc_machine\/anim_demo\.scad/);
  assert.doesNotMatch(h, /<em>/);
});

test('_word_ at word edges is still emphasis', () => {
  assert.match(html('this is _important_ here'), /<em>important<\/em>/);
});
