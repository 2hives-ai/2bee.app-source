/**
 * Functional specifications (src/spec/): the user's copy store, the label that says
 * whose text is on screen, the strict reader for the AI's review, and the lookups
 * that find the owning lane's spec.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SPEC_TICKET,
  readUserSpec,
  revertUserSpec,
  saveUserSpec,
  sourceLabel,
  specKey,
  undoUserSpec,
  type OwnerSpec,
  type SpecStore,
} from '../src/spec/specStore.ts';
import { buildReviewRequest, changeRequestText, missingHeadings, pcbRequestText, readReview, replyContent } from '../src/spec/specReview.ts';
import { findEntry, resolveDrawingName } from '../src/spec/cadSpecs.ts';
import { boardDir, pickPcbSpec } from '../src/spec/pick.ts';
import type { ShopEntry } from '../src/shop/catalogue.ts';

function memStore(): SpecStore & { m: Map<string, string> } {
  const m = new Map<string, string>();
  return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
}

const GOOD = { designChange: true, summary: 'Wall too thin for FR-2.', changes: ['Make the side wall 18 mm'], conflicts: ['FR-2: wall is 12 mm'] };

/* ── the AI review reader ─────────────────────────────────────────────────── */

test('review: a valid object is read', () => {
  const r = readReview(JSON.stringify(GOOD));
  assert.ok(r.ok);
  assert.deepEqual(r.ok && r.review, GOOD);
});

test('review: one ```json fence around the whole reply is tolerated, prose is not', () => {
  assert.ok(readReview('```json\n' + JSON.stringify(GOOD) + '\n```').ok);
  const r = readReview('Here is my review: ' + JSON.stringify(GOOD));
  assert.equal(r.ok, false);
});

test('review: an UNKNOWN key is refused and named', () => {
  const r = readReview(JSON.stringify({ ...GOOD, gcode: 'G0 X0' }));
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.problem : '', /gcode/);
});

test('review: a MISSING key is refused', () => {
  const { conflicts: _c, ...rest } = GOOD;
  const r = readReview(JSON.stringify(rest));
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.problem : '', /conflicts/);
});

test('review: WRONG TYPES are refused, one field at a time', () => {
  for (const bad of [
    { ...GOOD, designChange: 'yes' },
    { ...GOOD, summary: 3 },
    { ...GOOD, changes: 'make it bigger' },
    { ...GOOD, changes: ['ok', 5] },
    { ...GOOD, conflicts: null },
  ]) {
    assert.equal(readReview(JSON.stringify(bad)).ok, false, JSON.stringify(bad));
  }
  assert.equal(readReview('[1,2]').ok, false, 'an array is not the object');
  assert.equal(readReview('null').ok, false);
});

test('review: "the design must change" with no change named is refused', () => {
  assert.equal(readReview(JSON.stringify({ ...GOOD, changes: [' '] })).ok, false);
  const fine = readReview(JSON.stringify({ ...GOOD, designChange: false, changes: [] }));
  assert.ok(fine.ok);
});

test('review: reply envelope — refusal, not-JSON and the wrong shape each say so', () => {
  assert.equal(replyContent({ ok: false, status: 401, text: '{"error":{"message":"bad key"}}' }).ok, false);
  assert.equal(replyContent({ ok: true, status: 200, text: '<html>' }).ok, false);
  assert.equal(replyContent({ ok: true, status: 200, text: '{"output":"x"}' }).ok, false);
  const c = replyContent({ ok: true, status: 200, text: JSON.stringify({ choices: [{ message: { content: 'hi' } }] }) });
  assert.deepEqual(c, { ok: true, text: 'hi' });
});

test('review request carries old spec, new spec and the design, and nothing is lost silently', () => {
  const cfg = { endpoint: 'http://x/v1/chat/completions', model: 'm', apiKey: 'k', rememberKey: false, timeoutMs: 1000 };
  const { req, cut } = buildReviewRequest(cfg, { kind: 'cad', title: 'Quilt', oldSpec: 'OLD-SPEC', newSpec: 'NEW-SPEC', design: 'cube(10);' });
  const u = req.body.messages[1].content;
  assert.ok(u.includes('OLD-SPEC') && u.includes('NEW-SPEC') && u.includes('cube(10);'));
  assert.equal(cut, false);
  assert.equal(buildReviewRequest(cfg, { kind: 'cad', title: 'Q', oldSpec: '', newSpec: 'n', design: 'x'.repeat(70_000) }).cut, true);
});

test('change and pcb request texts carry every change', () => {
  const r = { ...GOOD, changes: ['A', 'B'] };
  assert.match(changeRequestText(r), /\(1\) A .*\(2\) B/);
  const t = pcbRequestText('outlet', r, 'SPEC');
  assert.ok(t.includes('1. A') && t.includes('2. B') && t.includes('SPEC') && t.includes('outlet'));
});

test('an AI draft missing a section is caught', () => {
  const all = ['Purpose', 'Functional requirements', 'Interfaces', 'Critical dimensions and tolerances', 'Material and process', 'Environment and loads', 'Acceptance checks', 'Not stated / open questions']
    .map((h, i) => `## ${i + 1}. ${h}\ntext`)
    .join('\n');
  assert.deepEqual(missingHeadings(all), []);
  assert.deepEqual(missingHeadings(all.replace('## 6. Environment and loads', '')), ['6. Environment and loads']);
});

/* ── the user's copy ──────────────────────────────────────────────────────── */

test('store: save keeps what it replaced, undo puts it back, revert removes the copy', () => {
  const s = memStore();
  const k = specKey('cad', '2bee_hive/quilt.scad');
  assert.equal(k, '2bee.app.spec.2bee_hive/quilt.scad');
  assert.equal(readUserSpec(s, k), null);
  assert.ok(saveUserSpec(s, k, 'v1', 'cad text', 'edited', 1));
  assert.ok(saveUserSpec(s, k, 'v2', 'v1', 'edited', 2));
  assert.equal(readUserSpec(s, k)!.text, 'v2');
  assert.equal(undoUserSpec(s, k)!.text, 'v1');
  assert.equal(undoUserSpec(s, k)!.text, 'cad text');
  assert.equal(undoUserSpec(s, k), null, 'nothing left to undo');
  assert.ok(revertUserSpec(s, k));
  assert.equal(readUserSpec(s, k), null);
});

test('store: pcb keys never collide with a design called the same', () => {
  assert.notEqual(specKey('pcb', 'outlet'), specKey('cad', 'outlet'));
});

test('store: a corrupt record reads as ABSENT, not half-used', () => {
  const s = memStore();
  for (const raw of ['{', '[]', '{"text":3,"origin":"edited"}', '{"text":"x","origin":"cad"}']) {
    s.m.set('k', raw);
    assert.equal(readUserSpec(s, 'k'), null, raw);
  }
});

test('store: an AI draft stays marked as one after the user edits it', () => {
  const s = memStore();
  saveUserSpec(s, 'k', 'draft', '', 'ai-draft');
  saveUserSpec(s, 'k', 'draft, edited', 'draft', 'edited');
  assert.equal(readUserSpec(s, 'k')!.origin, 'ai-draft');
});

test('store: a browser that refuses the write reports false', () => {
  const s: SpecStore = { getItem: () => null, setItem: () => { throw new Error('quota'); }, removeItem: () => {} };
  assert.equal(saveUserSpec(s, 'k', 'x', '', 'edited'), false);
});

/* ── whose text is on screen ──────────────────────────────────────────────── */

test('label: owner, user copy, AI draft and none each say whose text it is', () => {
  const cad: OwnerSpec = { kind: 'per-file', owner: 'cad', path: 'hardware/cad/a/b.spec.md', text: 'x', tracked: true };
  assert.equal(sourceLabel(cad, null), 'From cad: hardware/cad/a/b.spec.md');
  assert.match(sourceLabel({ ...cad, tracked: false }, null), /not yet committed/);
  assert.match(sourceLabel({ kind: 'directory', owner: 'cad', path: 'p', text: 'x', tracked: true }, null), /directory/);
  assert.equal(sourceLabel(cad, { text: 'y', origin: 'edited', savedAt: 0, undo: [] }), 'Your edited copy (saved in this browser)');
  const ai = sourceLabel(cad, { text: 'y', origin: 'ai-draft', savedAt: 0, undo: [] });
  assert.match(ai, /AI draft — not from cad/);
  assert.doesNotMatch(ai, /^From cad/);
  assert.equal(sourceLabel({ kind: 'none', owner: 'pcb' }, null), `No specification yet — pcb was asked (${SPEC_TICKET})`);
});

/* ── finding the owner's spec ─────────────────────────────────────────────── */

const entry = (o: Partial<ShopEntry>): ShopEntry =>
  ({ id: 'x', path: 'd/x.scad', title: 'X', family: 'F', familyBlurb: '', kind: '', parts: 1, triangles: 1, trust: 'trusted', trustDetail: '', sizeMm: null, files: 1, bytes: 1, thumb: null, ...o }) as ShopEntry;

test('cnc drawing name → catalogue design: unique title or file stem only', () => {
  const es = [entry({ id: 'a', path: '2bee_hive/quilt.scad', title: 'Quilt' }), entry({ id: 'b', path: '2bee_hive/lid.scad', title: 'Lid' }), entry({ id: 'c', path: 'other/lid.scad', title: 'Other lid' })];
  assert.equal((resolveDrawingName(es, 'Quilt (2)') as { entry: ShopEntry }).entry.id, 'a');
  assert.equal((resolveDrawingName(es, 'quilt') as { entry: ShopEntry }).entry.id, 'a');
  const amb = resolveDrawingName(es, 'lid');
  assert.equal(amb.entry, null, 'two files called lid: not a guess');
  assert.equal(resolveDrawingName(es, 'my drawing').entry, null);
  assert.equal(findEntry(es, '2bee_hive/lid.scad')!.id, 'b');
  assert.equal(findEntry(es, null), null);
});

test('pcb: SPEC.md first, then the directory spec, else none', () => {
  assert.equal(boardDir('hardware/pcb/solar_box/fab/sub/x-cpl.csv'), 'solar_box');
  const avail = ['hardware/pcb/solar_box/solar-box-spec.md', 'hardware/pcb/outlet/SPEC.md', 'hardware/pcb/outlet/old-spec.md'];
  assert.deepEqual(pickPcbSpec('outlet', avail), { kind: 'per-file', path: 'hardware/pcb/outlet/SPEC.md' });
  assert.deepEqual(pickPcbSpec('solar_box', avail), { kind: 'directory', path: 'hardware/pcb/solar_box/solar-box-spec.md' });
  assert.equal(pickPcbSpec('sensor_pod', avail), null);
  assert.equal(pickPcbSpec('solar', avail), null, 'a prefix of a directory name is not that directory');
});
