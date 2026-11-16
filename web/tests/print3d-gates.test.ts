/**
 * 2bee.3d upload gates (src/print3d/printGates.ts). Every gate is driven to FAIL
 * by a planted defect and to PASS by a clean input; PENDING never opens Upload.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignSlots, mayUpload, printGates, type PrintGateInput } from '../src/print3d/printGates.ts';

const CLEAN: PrintGateInput = {
  parts: 2,
  plate: 1,
  slice: { status: 'current', warnings: [], slotChecks: [{ slot: 'ams1-1', slotType: 'PETG', preset: 'Bambu PETG', presetType: 'PETG', ok: true }], bedType: 'Textured PEI Plate', bedRequested: 'Textured PEI Plate', layers: 50 },
  tooBig: [],
  unplaced: 0,
  arrangeError: null,
  partSlots: ['ams1-1', 'ams1-1'],
  slots: [{ id: 'ams1-1', label: 'AMS 1 slot 1', type: 'PETG' }, { id: 'ams1-2', label: 'AMS 1 slot 2', type: '' }],
  printer: { kind: 'done', reachable: true, haveCode: true, printer: '192.168.50.151' },
  checklistTicked: true,
  engine: { name: '2bee.fdm (this app’s own engine)', printed: false },
  calibrationAck: true,
};
const state = (i: PrintGateInput, id: string) => printGates(i).find((g) => g.id === id)!.state;

test('a clean plate passes every gate and may upload', () => {
  const g = printGates(CLEAN);
  assert.deepEqual(g.map((x) => [x.id, x.state]), [
    ['parts', 'PASS'], ['sliced', 'PASS'], ['engine', 'PASS'], ['fit', 'PASS'], ['filament', 'PASS'], ['bridge', 'PASS'], ['code', 'PASS'], ['checklist', 'PASS'],
  ]);
  assert.equal(mayUpload(g), true);
});

test('PLANT: each defect fails its own gate and keeps Upload off', () => {
  const cur = CLEAN.slice as Extract<PrintGateInput['slice'], { status: 'current' }>;
  const plants: [string, Partial<PrintGateInput>][] = [
    ['parts', { parts: 0 }],
    ['sliced', { slice: { status: 'failed', error: 'Orca exited 255\nlog…' } }],
    ['sliced', { slice: { ...cur, warnings: ['object 2 extends beyond the plate at this placement'] } }],
    ['sliced', { slice: { ...cur, bedType: 'Cool Plate' } }],
    ['sliced', { slice: { ...cur, layers: null } }], // G-code came back, no layer count: not a slice
    ['sliced', { slice: { ...cur, layers: 0 } }],
    ['engine', { calibrationAck: false }], // never printed, nobody marked it a calibration print
    ['engine', { engine: null }], // the reply did not name the engine
    ['fit', { tooBig: [{ name: 'lid.stl', reason: '300 mm is wider than the 256 mm plate' }] }],
    ['fit', { arrangeError: 'Arranging failed: bridge down' }],
    ['filament', { partSlots: ['ams1-1', 'ams1-2'] }],
    ['filament', { slice: { ...cur, slotChecks: [{ slot: 'ams1-1', slotType: 'PETG', preset: 'Bambu PLA Basic', presetType: 'PLA', ok: false }] } }],
    ['bridge', { printer: { kind: 'unset' } }],
    ['bridge', { printer: { kind: 'failed', why: 'connect ECONNREFUSED 127.0.0.1:8788' } }],
    ['bridge', { printer: { kind: 'done', reachable: false, haveCode: true, printer: '192.168.50.151' } }],
    ['code', { printer: { kind: 'done', reachable: true, haveCode: false, printer: '192.168.50.151' } }],
    ['checklist', { checklistTicked: false }],
    // The printer says the spool changed and the app still holds the old one (sync pending or failed).
    ['filament', { reported: [{ id: 'ams1-1', type: 'PLA' }] }],
    // The printer reports the part's slot empty while the app still holds PETG.
    ['filament', { reported: [{ id: 'ams1-1', type: '' }] }],
  ];
  for (const [id, p] of plants) {
    const i = { ...CLEAN, ...p };
    assert.equal(state(i, id), 'FAIL', `${id} did not fail on ${JSON.stringify(p)}`);
    assert.equal(mayUpload(printGates(i)), false);
  }
});

test('this machine today: no access code → FAIL, and it is a PERSON\'s action', () => {
  const g = printGates({ ...CLEAN, printer: { kind: 'done', reachable: true, haveCode: false, printer: 'x2d' } }).find((x) => x.id === 'code')!;
  assert.equal(g.state, 'FAIL');
  assert.equal(g.person, true);
  assert.match(g.why, /access code/);
});

test('ENGINE: an engine that has never printed is a PERSON\'s gate; only a printed engine passes without the tick', () => {
  const g = printGates({ ...CLEAN, calibrationAck: false }).find((x) => x.id === 'engine')!;
  assert.equal(g.state, 'FAIL');
  assert.equal(g.person, true);
  assert.match(g.why, /has not printed yet/);
  assert.match(g.why, /calibration print/);
  assert.equal(state({ ...CLEAN, calibrationAck: false, engine: { name: 'x', printed: true } }, 'engine'), 'PASS');
  assert.match(printGates(CLEAN).find((x) => x.id === 'engine')!.why, /marked this as a calibration print/);
  // no user-facing gate text names another slicer program
  for (const x of printGates({ ...CLEAN, slice: { status: 'failed', error: 'exit 3' } })) assert.doesNotMatch(`${x.name} ${x.why} ${x.guards}`, /orca/i);
});

test('an unrecognised slicer warning is listed but does not fail the slice', () => {
  const cur = CLEAN.slice as Extract<PrintGateInput['slice'], { status: 'current' }>;
  const g = printGates({ ...CLEAN, slice: { ...cur, warnings: ['object 1: footprint computed from the placement differs from Orca\'s by 3.20 mm (rotation read-back suspect)'] } }).find((x) => x.id === 'sliced')!;
  assert.equal(g.state, 'PASS');
  assert.match(g.why, /Note \(1\)/);
});

test('PENDING is not a pass: slicing / slots not loaded / printer not answered block Upload', () => {
  const pend: Partial<PrintGateInput>[] = [
    { slice: { status: 'slicing', detail: 'Slicing…' } },
    { slots: null },
    { printer: { kind: 'checking' } },
    { unplaced: 1 },
    { plate: null },
  ];
  for (const p of pend) {
    const g = printGates({ ...CLEAN, ...p });
    assert.ok(g.some((x) => x.state === 'PENDING'), JSON.stringify(p));
    assert.equal(mayUpload(g), false);
  }
});

test('Fix: unassigned parts go to a declared slot; the AI may only pick a declared one', () => {
  const slots = [{ id: 'a', type: '' }, { id: 'b', type: 'PLA' }, { id: 'c', type: 'PETG' }];
  assert.deepEqual(assignSlots(['a', 'c'], slots), ['b', 'c']);
  assert.deepEqual(assignSlots(['a', 'c'], slots, 'c'), ['c', 'c']);
  assert.deepEqual(assignSlots(['a'], slots, 'a'), ['b']); // the AI named an empty slot: ignored
  assert.equal(assignSlots(['a'], [{ id: 'a', type: '' }]), null);
});

test('filament: agreeing with the printer passes and says so; a slot the printer does not report keeps the declared wording', () => {
  const live = printGates({ ...CLEAN, reported: [{ id: 'ams1-1', type: 'PETG' }, { id: 'ams1-2', type: '' }] }).find((g) => g.id === 'filament')!;
  assert.equal(live.state, 'PASS');
  assert.match(live.why, /read from the printer/);
  const hand = printGates({ ...CLEAN, reported: null }).find((g) => g.id === 'filament')!;
  assert.equal(hand.state, 'PASS');
  assert.match(hand.why, /declared by you/);
  const bad = printGates({ ...CLEAN, reported: [{ id: 'ams1-1', type: 'PLA' }] }).find((g) => g.id === 'filament')!;
  assert.match(bad.why, /printer reports PLA in AMS 1 slot 1, the app holds PETG/);
});
