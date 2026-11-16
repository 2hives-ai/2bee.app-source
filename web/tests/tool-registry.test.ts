// Tools page — pure logic: the registry (toolRegistry.ts) and the photo store
// (toolPhotos.ts, with an in-memory fake; node has no IndexedDB).
//
// Guards: a shop-defined cutter with no type or no diameter is NOT registered
// and the refusal names the field; add/remove round-trips through
// inventory.ts's one document; removing a cutter removes its photo; the
// downscale size math keeps aspect, never upscales, refuses a 0×0 decode.
//
// What this cannot see: the browser path (canvas encode, IndexedDB, the file
// input opening a phone camera). Those are not exercised by any test here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EMPTY_INVENTORY, mergeInventory, ownershipOf } from '../src/inventory.ts';
import {
  EMPTY_DRAFT,
  FIELD_GUIDES,
  registerCatalogueTool,
  registerShopTool,
  registeredTools,
  removeToolAndPhoto,
  unregisterTool,
  validateToolDraft,
  type ToolDraft,
} from '../src/shop-setup/toolRegistry.ts';
import { fitWithin, memoryPhotoStore } from '../src/shop-setup/toolPhotos.ts';
import type { ToolRow } from '../src/cam.ts';

const NOW = Date.UTC(2026, 9, 14);
const good: ToolDraft = { ...EMPTY_DRAFT, type: 'End Mill', diameter_mm: '6', flutes: '2', cutting_length_mm: '22', shank_mm: '6', overall_length_mm: '50' };

const catRow = (id: string): ToolRow =>
  ({ id, category: 'End Mill', diameter_mm: 6, flutes: 2, shank_mm: 6, cutting_length_mm: 25 }) as unknown as ToolRow;

test('validation refuses a missing diameter and names the field', () => {
  const v = validateToolDraft({ ...good, diameter_mm: '' });
  assert.equal(v.ok, false);
  if (v.ok) return;
  assert.deepEqual(v.problems.map((p) => p.field), ['diameter_mm']);
  assert.match(v.problems[0].why, /Cutting diameter is missing/);
});

test('validation refuses a missing type and names the field', () => {
  const v = validateToolDraft({ ...good, type: '' });
  assert.equal(v.ok, false);
  if (v.ok) return;
  assert.deepEqual(v.problems.map((p) => p.field), ['type']);
  assert.match(v.problems[0].why, /Type is missing/);
});

test('both missing → both named, at once', () => {
  const v = validateToolDraft({ ...EMPTY_DRAFT });
  assert.equal(v.ok, false);
  if (v.ok) return;
  assert.deepEqual(v.problems.map((p) => p.field).sort(), ['diameter_mm', 'type']);
});

test('a refused draft writes NOTHING to the registry', () => {
  const r = registerShopTool(EMPTY_INVENTORY, { ...good, diameter_mm: '0' }, NOW);
  assert.equal(r.ok, false);
  assert.equal(EMPTY_INVENTORY.entries.length, 0);
});

test('bad values are refused, not coerced: non-number, zero, fractional flutes, cutting > overall', () => {
  for (const [patch, field] of [
    [{ diameter_mm: 'abc' }, 'diameter_mm'],
    [{ diameter_mm: '-1' }, 'diameter_mm'],
    [{ flutes: '2.5' }, 'flutes'],
    [{ cutting_length_mm: '60' }, 'cutting_length_mm'],
  ] as const) {
    const v = validateToolDraft({ ...good, ...patch });
    assert.equal(v.ok, false, JSON.stringify(patch));
    if (!v.ok) assert.ok(v.problems.some((p) => p.field === field), JSON.stringify(v.problems));
  }
});

test('angular type requires the included angle (core ToolFault::MissingAngle)', () => {
  const v = validateToolDraft({ ...good, type: 'V-Bit' });
  assert.equal(v.ok, false);
  if (!v.ok) assert.deepEqual(v.problems.map((p) => p.field), ['included_angle_deg']);
  assert.equal(validateToolDraft({ ...good, type: 'V-Bit', included_angle_deg: '60' }).ok, true);
});

test('blank optional measurements are stored ABSENT, never as zero', () => {
  const v = validateToolDraft({ ...EMPTY_DRAFT, type: 'Drill', diameter_mm: '5' });
  assert.equal(v.ok, true);
  if (!v.ok) return;
  assert.deepEqual(Object.keys(v.fields).sort(), ['category', 'diameter_mm']);
});

test('add (shop-defined) then remove round-trips through inventory.ts', () => {
  const r = registerShopTool(EMPTY_INVENTORY, good, NOW);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const listed = registeredTools(r.doc, []);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].origin, 'typed');
  assert.match(listed[0].detail, /Ø 6 mm/);
  // The rest of the app sees it: an owned 'tool' entry.
  assert.equal(ownershipOf(r.doc, 'tool', r.id, []).state, 'held');
  const back = unregisterTool(r.doc, r.id);
  assert.deepEqual(back, EMPTY_INVENTORY);
});

test('add from catalogue: owned in the merged view; unknown id refused, not matched', () => {
  const cat = [catRow('End Mill - Down-cut 6mm 2F'), catRow('End Mill - Up-cut 6mm 2F')];
  const ids = cat.map((c) => c.id);
  const r = registerCatalogueTool(EMPTY_INVENTORY, ids[0], ids, NOW);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const view = mergeInventory({ kind: 'tool', doc: r.doc, catalogue: cat.map((c) => ({ id: c.id, name: c.id })), now: NOW });
  assert.deepEqual(view.selectableIds, [ids[0]]);
  const bad = registerCatalogueTool(EMPTY_INVENTORY, 'End Mill - Down-cut 6mm', ids, NOW);
  assert.equal(bad.ok, false);
});

test('removing a cutter removes its photo', async () => {
  const photos = memoryPhotoStore();
  const r = registerShopTool(EMPTY_INVENTORY, good, NOW);
  assert.ok(r.ok);
  if (!r.ok) return;
  await photos.put(r.id, new Blob(['jpeg']));
  await photos.put('other-tool', new Blob(['jpeg']));
  let written = null as unknown;
  const out = await removeToolAndPhoto(r.doc, r.id, async (d) => void (written = d), photos);
  assert.equal(out.photoError, null);
  assert.deepEqual(written, EMPTY_INVENTORY);
  assert.equal(await photos.get(r.id), null);
  assert.ok(await photos.get('other-tool'), 'another cutter\'s photo must survive');
  assert.equal(photos.size(), 1);
});

test('a photo delete that fails is REPORTED, and the record is still removed', async () => {
  const r = registerShopTool(EMPTY_INVENTORY, good, NOW);
  if (!r.ok) throw new Error('setup');
  const out = await removeToolAndPhoto(r.doc, r.id, async () => {}, {
    delete: async () => {
      throw new Error('quota');
    },
  });
  assert.equal(out.doc.entries.length, 0);
  assert.match(out.photoError ?? '', /photo could not be deleted: quota/);
});

test('downscale size math: long edge 1024, aspect kept, no upscale, 0×0 refused', () => {
  assert.deepEqual(fitWithin(4032, 3024), { width: 1024, height: 768, scaled: true });
  assert.deepEqual(fitWithin(3024, 4032), { width: 768, height: 1024, scaled: true });
  assert.deepEqual(fitWithin(800, 600), { width: 800, height: 600, scaled: false });
  assert.deepEqual(fitWithin(1024, 10), { width: 1024, height: 10, scaled: false });
  assert.deepEqual(fitWithin(10000, 1), { width: 1024, height: 1, scaled: true });
  assert.throws(() => fitWithin(0, 0), /could not be read/);
  assert.throws(() => fitWithin(NaN, 10), /could not be read/);
});

test('every measured field has a what AND a how sentence', () => {
  for (const g of FIELD_GUIDES) {
    assert.ok(g.what.trim().length > 10, `${g.key} what`);
    assert.ok(g.how.trim().length > 10, `${g.key} how`);
  }
  assert.match(FIELD_GUIDES.find((g) => g.key === 'diameter_mm')!.how, /not across the shank/);
});
