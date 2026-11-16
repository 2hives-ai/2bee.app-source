// The AI-change review must see a multi-file design's imports (added 2026-10-14).
//
// Before `evaluate`/`reviewProposal`/`askOnce` took ScadOptions, every
// `use <…>` was unresolved during the review. Both sides of the comparison were
// equally blind, so the shape delta came out EMPTY for a real change. That is the
// failure: an AI edit that moved the part was reviewed as "no change".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, reviewProposal, askOnce, type AskTransport } from '../src/cad/ask.tsx';
import { makeLibraryHost, type ScadLibrary } from '../src/cad/library.ts';

const lib: ScadLibrary = {
  files: new Map([
    ['d/lib.scad', 'module part(s) { cube(s); }\n'],
    ['d/main_3d.scad', 'use <lib.scad>\npart(10);\n'],
  ]),
  rootName: 'd',
  pickedAt: 0,
  skipped: [],
};
const opts = { path: 'd/main_3d.scad', host: makeLibraryHost(lib) };
const before = lib.files.get('d/main_3d.scad')!;
const after = 'use <lib.scad>\npart(20);\n';

test('with the host the import resolves; without it the part is not there', () => {
  assert.ok(evaluate(before, opts).mesh.stats.triangles > 0);
  assert.equal(evaluate(before).mesh.stats.triangles, 0);
});

test('a real change is a real shape delta only when the review can see the imports', () => {
  const seen = reviewProposal(evaluate(before, opts), after, opts);
  const blind = reviewProposal(evaluate(before), after);
  assert.notDeepEqual(seen.shape, blind.shape);
  assert.equal(JSON.stringify(blind.shape), JSON.stringify(reviewProposal(evaluate(before), before).shape),
    'the blind review reads a 10 -> 20 mm change exactly like no change, which is the defect');
});

test('askOnce passes the host through to its review', async () => {
  const transport: AskTransport = async () => ({
    status: 200,
    ok: true,
    text: JSON.stringify({ choices: [{ message: { content: '```openscad\n' + after + '```' } }] }),
  });
  const cfg = { endpoint: 'http://127.0.0.1:1/v1/chat/completions', model: 'm', apiKey: 'test-key', rememberKey: false, timeoutMs: 1000 };
  const run = (scad?: typeof opts) =>
    askOnce({ cfg, prompt: 'make it 20', source: before, online: true, transport, signal: new AbortController().signal, scad });
  const withHost = await run(opts);
  const without = await run();
  assert.ok(withHost.ok && without.ok, JSON.stringify([withHost, without]).slice(0, 300));
  if (withHost.ok && without.ok) assert.notDeepEqual(withHost.review.shape, without.review.shape);
});
