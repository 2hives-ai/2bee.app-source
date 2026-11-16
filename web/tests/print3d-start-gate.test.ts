/**
 * Gate START-STALE (src/print3d/startGate.ts): Start is offered only for the file
 * uploaded from the plate as it is sliced NOW, and the start request carries the
 * AMS mapping and types of THAT upload, never of a later slice.
 *
 * Physical failure guarded: a plate uploaded for PETG in AMS slot 3, then moved to
 * slot 1 (PLA) and re-sliced. The old code sent the OLD file with the NEW mapping
 * [0]/['PLA']: a PETG program on PLA, past the checklist and every upload gate.
 *
 * Plant: START_STALE_PLANT=1 runs the same assertions against the pre-fix decision
 * (no key check, mapping taken from the current slice); the test must go red.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plateKey, startBlock, startBody, type PlateKeyInput, type StartInput } from '../src/print3d/startGate.ts';

const PLANT = process.env.START_STALE_PLANT === '1';

const plate = (over: Partial<PlateKeyInput> = {}): PlateKeyInput => ({
  plate: 1,
  sliceId: '0123456789abcdef',
  buildPlate: 'Textured PEI Plate',
  objects: [{ index: 0, slot: 'ams1-3', placement: { x: 128, y: 128, rot: 0 } }],
  filaments: [{ id: 1, slot: 'ams1-3', type: 'PETG' }],
  filamentSlots: ['ams1-3'],
  types: ['PETG'],
  settings: ['0.20mm Standard @BBL X2D', {}],
  ...over,
});
const K1 = plateKey(plate())!;
const UP = { key: K1, slots: ['ams1-3'], amsMapping: [2], expectTypes: ['PETG'] };
const base: StartInput = { up: UP, plateReady: true, currentKey: K1, haveSerial: true, printerState: 'IDLE' };

// The decision as it was before the fix: no key, no plateReady; mapping from the CURRENT slice.
const preFix = (s: StartInput, cur: { mapping: number[]; types: string[] }) => ({
  why: !s.haveSerial ? 'no serial' : s.printerState && ['PREPARE', 'RUNNING', 'PAUSE', 'SLICING'].includes(s.printerState) ? 'busy' : '',
  body: { amsMapping: cur.mapping, expectTypes: cur.types },
});
const decide = (s: StartInput, cur: { mapping: number[]; types: string[] }) => {
  if (PLANT) return preFix(s, cur);
  const why = startBlock(s);
  return { why, body: why ? null : startBody(s, 'cube_abcdef01.gcode.3mf', 'x', 'Textured PEI Plate') };
};

test('START-STALE: the upload matching the current slice may start, with ITS mapping and types', () => {
  const d = decide(base, { mapping: [2], types: ['PETG'] });
  assert.equal(d.why, '');
  assert.deepEqual(d.body && { m: d.body.amsMapping, t: d.body.expectTypes }, { m: [2], t: ['PETG'] });
});

test('START-STALE: re-sliced onto another slot -> Start off, and nothing of the new slice is sent', () => {
  const K2 = plateKey(plate({ sliceId: 'fedcba9876543210', objects: [{ index: 0, slot: 'ams1-1' }], filaments: [{ id: 1, slot: 'ams1-1', type: 'PLA' }], filamentSlots: ['ams1-1'], types: ['PLA'] }))!;
  assert.notEqual(K2, K1);
  const d = decide({ ...base, currentKey: K2 }, { mapping: [0], types: ['PLA'] });
  assert.match(d.why, /plate changed since upload: upload again/);
  assert.equal(d.body, null, 'a stale upload must produce no start body at all');
});

test('START-STALE: every plate fact moves the key (placement, slot type, build plate, settings, slice id)', () => {
  for (const over of [
    { objects: [{ index: 0, slot: 'ams1-3', placement: { x: 100, y: 128, rot: 0 } }] },
    { types: ['PLA'] },
    { buildPlate: 'Cool Plate' },
    { settings: ['0.20mm Standard @BBL X2D', { wall_loops: '3' }] },
    { sliceId: 'fedcba9876543210' },
  ] as Partial<PlateKeyInput>[]) {
    const k = plateKey(plate(over));
    assert.notEqual(k, K1, JSON.stringify(over));
    assert.match(decide({ ...base, currentKey: k }, { mapping: [2], types: ['PETG'] }).why, /changed since upload/, JSON.stringify(over));
  }
});

test('START-STALE: a plate that is not sliced up to date never starts (no key to match)', () => {
  assert.equal(plateKey(plate({ sliceId: null })), null);
  const d = decide({ ...base, plateReady: false, currentKey: null }, { mapping: [2], types: ['PETG'] });
  assert.match(d.why, /not sliced up to date/);
  assert.equal(d.body, null);
});

test('START-STALE: no upload, no serial, busy printer, unmapped slot, untyped slot: each refuses', () => {
  if (PLANT) return; // the pre-fix decision had these as separate checks; this test is about the new function's own reasons
  assert.match(startBlock({ ...base, up: null }), /nothing has been uploaded/);
  assert.match(startBlock({ ...base, haveSerial: false }), /--serial/);
  assert.match(startBlock({ ...base, printerState: 'RUNNING' }), /busy \(RUNNING\)/);
  assert.match(startBlock({ ...base, up: { ...UP, slots: ['spare'], amsMapping: [null] } }), /slot spare is not an AMS slot/);
  assert.match(startBlock({ ...base, up: { ...UP, expectTypes: [''] } }), /no declared type/);
  assert.match(startBlock({ ...base, up: { ...UP, slots: [], amsMapping: [], expectTypes: [] } }), /filament order unknown/);
  assert.throws(() => startBody({ ...base, up: null }, 'r.gcode.3mf', 'x', 'p'), /Start refused/);
});
