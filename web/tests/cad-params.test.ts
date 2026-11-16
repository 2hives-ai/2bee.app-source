// The design's variables (`src/cad/params.ts`, founder 2026-11-13: "turn on/off
// features"): what is listed, what is not and why, and the one-literal rewrite.
// The panel and the rebuilds were checked in a browser when they landed; this file
// covers the reading and the writing of the source text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanParams, setParam } from '../src/cad/params';

const SRC = `// lid on top
show_lid = true;
wall = 2.5;     // [1:0.5:5]
style = "round"; // [round, square]
holes = 4; // how many holes
_guard = true;
derived = wall * 2;
/* [Hidden] */
secret = false;
/* [Size] */
w = 10;
module box() {
  inner = 3;
  cube(w);
}
twice = 1;
twice = 2;
box();
`;

const byName = (n: string) => scanParams(SRC).params.find((p) => p.name === n);

test('top-level literals are listed with kind, line and description', () => {
  const lid = byName('show_lid')!;
  assert.equal(lid.kind, 'bool');
  assert.equal(lid.value, true);
  assert.equal(lid.line, 2);
  assert.equal(lid.description, 'lid on top');
  assert.equal(byName('holes')!.description, 'how many holes');
  assert.equal(byName('w')!.section, 'Size');
});

test('customizer hints: range and options', () => {
  assert.deepEqual(byName('wall')!.range, { min: 1, step: 0.5, max: 5 });
  assert.deepEqual(byName('style')!.options!.map((o) => o.value), ['round', 'square']);
});

test('NOT listed: _guard, derived, [Hidden], a module local, a name assigned twice', () => {
  const names = scanParams(SRC).params.map((p) => p.name);
  for (const n of ['_guard', 'derived', 'secret', 'inner', 'twice']) assert.ok(!names.includes(n), `${n} was listed`);
  assert.deepEqual(scanParams(SRC).skipped.map((s) => s.name), ['twice', 'twice']);
});

test('setParam rewrites exactly one literal and nothing else', () => {
  const out = setParam(SRC, byName('show_lid')!, false);
  assert.equal(out, SRC.replace('show_lid = true;', 'show_lid = false;'));
  assert.equal(setParam(SRC, byName('wall')!, 3), SRC.replace('wall = 2.5;', 'wall = 3;'));
  assert.equal(setParam(SRC, byName('style')!, 'square'), SRC.replace('"round";', '"square";'));
});

test('setParam refuses when the variable is no longer where the control says', () => {
  const p = byName('show_lid')!;
  assert.throws(() => setParam(SRC.replace('show_lid = true;', 'show_lid = !x;'), p, false));
});

test('braces inside strings and comments do not change depth', () => {
  const src = 'a = "{";\n// {\n/* { */\nb = true;\n';
  assert.deepEqual(scanParams(src).params.map((p) => p.name), ['a', 'b']);
});
