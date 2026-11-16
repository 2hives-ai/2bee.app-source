/**
 * machines tab — 3D printers (src/machines/printers.ts). Same rules as the CNC
 * machine reader: one bad field refuses the whole patch; nothing is defaulted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NO_PRINTER_FIELDS, printerId, readPrinterProposal, readPrinters, writePrinters } from '../src/machines/printers.ts';

test('a stated build volume and name are read; unchanged values drop out', () => {
  const r = readPrinterProposal('{"patch":{"buildX":256,"buildY":256,"buildZ":256,"enclosed":true},"name":"Bambu Lab X1C","why":"page","missing":["maxBedC"]}', NO_PRINTER_FIELDS);
  assert.ok(r.ok);
  assert.deepEqual(r.ok && r.patch, { buildX: 256, buildY: 256, buildZ: 256, enclosed: true });
  assert.equal(r.ok && r.name, 'Bambu Lab X1C');
  assert.deepEqual(r.ok && r.missing, ['maxBedC']);
});

test('one bad field refuses the whole patch', () => {
  assert.equal(readPrinterProposal('{"patch":{"buildX":256,"nozzleMm":5}}', NO_PRINTER_FIELDS).ok, false);
});

test('a fractional slot count and an unknown key are refused', () => {
  assert.equal(readPrinterProposal('{"patch":{"filamentSlots":4.5}}', NO_PRINTER_FIELDS).ok, false);
  assert.equal(readPrinterProposal('{"patch":{"accessCode":"1234"}}', NO_PRINTER_FIELDS).ok, false);
});

test('the list round-trips and a broken store reads as empty, never throws', () => {
  const mem = new Map<string, string>();
  const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
  assert.equal(writePrinters(store, [{ id: 'x', name: 'X', fields: { ...NO_PRINTER_FIELDS, buildX: 200 }, source: 'operator', addedAt: 1 }]), null);
  assert.equal(readPrinters(store)[0].fields.buildX, 200);
  mem.set('2bee.app.machines.printers', '{not json');
  assert.deepEqual(readPrinters(store), []);
});

test('ids are unique', () => {
  assert.equal(printerId('Bambu Lab X2D', ['bambu-lab-x2d']), 'bambu-lab-x2d-2');
});

test('a stored field outside its bounds or not a number reads as NOT STATED (bughunt 2026-11-15)', () => {
  /* readPrinters merged stored fields unchecked. CadTab's "Fits a 3D printer" gate then compared
   * against the string "300" (`v <= "300" + 1e-6` is v <= "3000.000001") and passed a 2999 mm
   * part; a stored buildX 99999 the AI reader would refuse read back unchanged. */
  const raw = JSON.stringify([
    { id: 'a', name: 'A', source: 's', addedAt: 1, fields: { buildX: '300', buildY: 99999, buildZ: 256, nozzleMm: -1, maxBedC: 5000, filamentSlots: 2.5, enclosed: 'yes' } },
  ]);
  const [p] = readPrinters({ getItem: () => raw });
  assert.deepEqual(p.fields, { ...NO_PRINTER_FIELDS, buildZ: 256 });
});
