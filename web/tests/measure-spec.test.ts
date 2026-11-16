// measureSpec.ts — the pure "what to measure" scenes — and Measure3D's no-WebGL
// fallback. Node has no WebGL, so the 3D path itself is NOT exercised here: a
// green says the scene data is right and the fallback is not blank, nothing
// about what a GPU draws.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { END_MILL_DIM_LABEL, END_MILL_FIELDS, endMillScene } from '../src/shop-setup/measureSpec.ts';
import { FIELD_GUIDES } from '../src/shop-setup/toolRegistry.ts';

const { default: Measure3D, MEASURE3D_UNAVAILABLE } = await import('../src/shop-setup/Measure3D.tsx');

test('every measured tool field has a scene: ≥1 highlight part, exactly one DimLine naming the field', () => {
  for (const f of END_MILL_FIELDS) {
    const s = endMillScene(f);
    assert.ok(s.parts.some((p) => p.role === 'highlight'), `${f}: no highlighted part`);
    assert.equal(s.dims.length, 1, `${f}: dims`);
    assert.equal(s.dims[0].label, END_MILL_DIM_LABEL[f]);
    const d = s.dims[0];
    const len = Math.hypot(d.to[0] - d.from[0], d.to[1] - d.from[1], d.to[2] - d.from[2]);
    assert.ok(len > 0, `${f}: zero-length dimension line`);
    for (const p of s.parts) assert.ok(p.size.every((n) => Number.isFinite(n) && n >= 0), `${f}: bad size`);
  }
});

test('the scene label and the form label name the same field', () => {
  for (const g of FIELD_GUIDES) {
    assert.ok(END_MILL_FIELDS.includes(g.key), `${g.key} has a guide but no scene`);
    assert.ok(END_MILL_DIM_LABEL[g.key].startsWith(g.label.split(' ')[0]), `${g.key}: "${END_MILL_DIM_LABEL[g.key]}" vs "${g.label}"`);
  }
  assert.equal(FIELD_GUIDES.length, END_MILL_FIELDS.length);
});

test('without WebGL the picture is NOT blank: label, how-to text and the unavailable line', () => {
  for (const f of END_MILL_FIELDS) {
    const html = renderToStaticMarkup(
      h(Measure3D, { scene: endMillScene(f), label: `Where to measure: ${f}`, howTo: 'Calipers across the edges.' })
    );
    assert.match(html, /data-testid="measure3d-fallback"/);
    assert.ok(html.includes(MEASURE3D_UNAVAILABLE), html);
    assert.ok(html.includes(`aria-label="Where to measure: ${f}"`), html);
    assert.ok(html.includes('Calipers across the edges.'));
    assert.ok(!html.includes('<canvas'), 'a canvas with no context is a blank box');
  }
});
