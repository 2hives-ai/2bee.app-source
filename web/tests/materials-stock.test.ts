/**
 * materials tab — stock sheets + filaments (src/materials/stock.ts). Same rules
 * as machines/printers.ts: one bad field refuses the whole patch; nothing is
 * defaulted; the store reads robustly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FILAMENTS_KEY,
  NO_FILAMENT_FIELDS,
  NO_SHEET_FIELDS,
  SHEETS_KEY,
  readFilamentProposal,
  readFilaments,
  readSheetProposal,
  readSheets,
  sheetLabel,
  stockId,
  writeFilaments,
  writeSheets,
  type Sheet,
} from '../src/materials/stock.ts';

const KNOWN = ['Plywood', 'MDF', 'Hardwood', 'Softwood', 'Acrylic', 'Aluminium'];
const mem = () => {
  const m = new Map<string, string>();
  return { m, store: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) } };
};

test('an added panel takes the planner spelling and names what was not stated', () => {
  const r = readSheetProposal(
    '{"action":"add","name":"18 mm birch ply 2440 × 1220","patch":{"material":"plywood","thicknessMm":18,"sizeX":2440,"sizeY":1220,"supplier":"Bunnings"},"why":"operator","missing":[]}',
    null,
    KNOWN,
  );
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.action, 'add');
  assert.equal(r.patch.material, 'Plywood');
  assert.deepEqual(r.flags, []);
  assert.deepEqual(r.missing, ['quantity']);
});

test('a material the planner does not carry is kept and flagged, never remapped', () => {
  const r = readSheetProposal('{"action":"add","patch":{"material":"HDPE","thicknessMm":10}}', null, KNOWN);
  assert.ok(r.ok);
  assert.equal(r.ok && r.patch.material, 'HDPE');
  assert.match(r.ok ? r.flags.join() : '', /not a material the planner carries/);
});

test('one out-of-bounds or unknown field refuses the WHOLE patch', () => {
  for (const patch of ['{"thicknessMm":0.2,"sizeX":1000}', '{"thicknessMm":101}', '{"sizeX":49}', '{"sizeY":5001}', '{"quantity":2.5}', '{"price":12}', '{"link":"javascript:alert(1)"}']) {
    const r = readSheetProposal(`{"action":"add","patch":${patch}}`, null, KNOWN);
    assert.equal(r.ok, false, patch);
  }
  // the bounds are inclusive
  assert.ok(readSheetProposal('{"action":"add","patch":{"thicknessMm":0.5,"sizeX":50,"sizeY":5000}}', null, KNOWN).ok);
});

test('a null is "not stated", never a value; edit with nothing selected is refused', () => {
  const r = readSheetProposal('{"action":"add","patch":{"material":"MDF","thicknessMm":null}}', null, KNOWN);
  assert.ok(r.ok);
  assert.equal(r.ok && 'thicknessMm' in r.patch, false);
  assert.ok(r.ok && r.missing.includes('thicknessMm'));
  assert.equal(readSheetProposal('{"action":"edit","patch":{"quantity":3}}', null, KNOWN).ok, false);
  assert.equal(readSheetProposal('{"action":"burn","patch":{}}', NO_SHEET_FIELDS, KNOWN).ok, false);
  assert.equal(readSheetProposal('no json here', NO_SHEET_FIELDS, KNOWN).ok, false);
});

test('an edit drops unchanged values', () => {
  const cur = { ...NO_SHEET_FIELDS, material: 'MDF', quantity: 3 };
  const r = readSheetProposal('```json\n{"action":"edit","patch":{"material":"MDF","quantity":4}}\n```', cur, KNOWN);
  assert.ok(r.ok);
  assert.deepEqual(r.ok && r.patch, { quantity: 4 });
});

test('filament: type, diameter and spool bounds; remaining cannot exceed the spool', () => {
  const ok = readFilamentProposal('{"action":"add","name":"Bambu PLA Basic Jade White","patch":{"type":"pla","colourName":"Jade White","diameterMm":1.75,"spoolG":1000,"brand":"Bambu Lab"}}', null);
  assert.ok(ok.ok);
  assert.equal(ok.ok && ok.patch.type, 'PLA');
  assert.deepEqual(ok.ok && ok.missing, []);
  assert.ok(readFilamentProposal('{"action":"add","patch":{"type":"PETG-CF"}}', null).ok);
  for (const patch of ['{"diameterMm":3}', '{"type":"WOOD"}', '{"spoolG":20}', '{"spoolG":10001}', '{"colourHex":"red"}', '{"spoolG":1000,"remainingG":1200}']) {
    assert.equal(readFilamentProposal(`{"action":"add","patch":${patch}}`, null).ok, false, patch);
  }
  // remaining checked against the SELECTED spool on an edit
  assert.equal(readFilamentProposal('{"action":"edit","patch":{"remainingG":600}}', { ...NO_FILAMENT_FIELDS, spoolG: 500 }).ok, false);
});

test('the lists round-trip; a broken store reads as empty and never throws', () => {
  const { m, store } = mem();
  const s: Sheet = { ...NO_SHEET_FIELDS, id: 'a', name: 'A', material: 'MDF', thicknessMm: 16, sizeX: 600, sizeY: 900, quantity: 2, source: 'operator', addedAt: 1 };
  assert.equal(writeSheets(store, [s]), null);
  assert.deepEqual(readSheets(store), [s]);
  m.set(SHEETS_KEY, '{not json');
  assert.deepEqual(readSheets(store), []);
  m.set(SHEETS_KEY, '{"a":1}');
  assert.deepEqual(readSheets(store), []);
  assert.deepEqual(readSheets(null), []);
  assert.deepEqual(readSheets({ getItem: () => { throw new Error('blocked'); } }), []);
  assert.match(writeSheets({ setItem: () => { throw new Error('quota'); } }, [s]) ?? '', /quota/);
  m.set(FILAMENTS_KEY, 'null');
  assert.deepEqual(readFilaments(store), []);
  assert.equal(writeFilaments(store, []), null);
});

test('a stored value outside the bounds reads as NOT STATED, so cnc never sees it', () => {
  const { m, store } = mem();
  m.set(SHEETS_KEY, JSON.stringify([{ id: 'x', name: 'X', thicknessMm: 0, sizeX: '600', sizeY: 900 }, { id: 'x', name: 'dup' }, { name: 'no id' }]));
  const r = readSheets(store);
  assert.equal(r.length, 1);
  assert.equal(r[0].thicknessMm, null);
  assert.equal(r[0].sizeX, null);
  assert.equal(r[0].sizeY, 900);
  assert.equal(r[0].quantity, null);
});

test('labels use only stated values; ids are unique', () => {
  assert.equal(sheetLabel({ ...NO_SHEET_FIELDS, thicknessMm: 18, material: 'Plywood' }), '18 mm Plywood');
  assert.equal(stockId('18 mm Plywood', ['18-mm-plywood']), '18-mm-plywood-2');
});
