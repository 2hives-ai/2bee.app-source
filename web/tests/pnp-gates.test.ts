/**
 * 2bee.pnp gates (src/pnp/pnpGates.ts). Every gate is driven to FAIL by a planted
 * defect and to PASS by a clean input; PENDING never lets a run through.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mayRun, pnpGates, traysFromNeed, type PnpGateInput } from '../src/pnp/pnpGates.ts';
import { parseVspec, preflight, type PreflightResult } from '../src/pnp/manifest.ts';
import { mayApplyPnp } from '../src/pnp/pnpAsk.ts';

const okPlan = (refs: string[]): PreflightResult => ({
  exit: 0,
  counts: { bomRows: 1, cplRows: refs.length, skippedDnp: 0, skippedConsigned: 0, skippedAssembly: 0, assembly: {}, placedLines: 1, placedParts: refs.length },
  lanes: [{ trayId: 'T01', lane: 1, variant: '0402', mfrPn: 'X', value: '10k', pkg: 'R0402', refs, need: refs.length, capacity: 50, tape: 'default', swapUndetectable: false }],
  traysUsed: ['T01'],
  lanesNeeded: { '0402': { lanes: 1, trays: 1 } },
  refusals: [],
  warnings: [],
});

const CLEAN: PnpGateInput = {
  boardId: 'sensor_pod',
  loaded: true,
  loadError: null,
  parts: {
    parts: [
      { ref: 'R1', by: 'machine', from: 'cpl' },
      { ref: 'R2', by: 'machine', from: 'cpl' },
      { ref: 'J1', by: 'hand-tht', from: 'kicad_pcb' },
    ],
    unplaced: [],
  },
  plan: okPlan(['R1', 'R2']),
  machine: { name: 'DIY', travel: { x: 410, y: 210 } },
  board: { w: 40, h: 30, x: 185, y: 90 },
  confirmedLoaded: true,
};
const state = (i: PnpGateInput, id: string) => pnpGates(i).find((g) => g.id === id)!.state;

test('a clean job passes every gate and may run', () => {
  const g = pnpGates(CLEAN);
  assert.deepEqual(g.map((x) => [x.id, x.state]), [
    ['board', 'PASS'], ['cpl', 'PASS'], ['trays', 'PASS'], ['machine', 'PASS'], ['travel', 'PASS'], ['hand', 'PASS'], ['loaded', 'PASS'],
  ]);
  assert.match(g.find((x) => x.id === 'hand')!.why, /J1/);
  assert.equal(mayRun(g), true);
});

test('PLANT: each defect fails its own gate and blocks a run', () => {
  const refused: PreflightResult = { ...okPlan(['R1', 'R2']), exit: 1, refusals: [{ rule: '1', message: 'R2: no free lane in a 0402 tray' }] };
  const plants: [string, Partial<PnpGateInput>][] = [
    ['board', { boardId: '' }],
    ['board', { loadError: 'Could not read this board: 404' }],
    ['cpl', { parts: { parts: [{ ref: 'R1', by: 'machine', from: 'cpl' }, { ref: 'R2', by: 'machine', from: 'kicad_pcb' }], unplaced: [] } }],
    ['cpl', { parts: { parts: [{ ref: 'R1', by: 'machine', from: 'cpl' }], unplaced: [{ ref: 'R2', by: 'machine' }] } }],
    ['trays', { plan: refused }],
    ['trays', { plan: 'Cannot read pnp_blinds_vspec.json' }],
    ['trays', { plan: okPlan(['R1']) }], // exit 0 but R2 has no lane: the OUTPUT is read
    ['machine', { machine: null }],
    ['machine', { machine: { name: 'LumenPnP', travel: { x: null, y: null } } }],
    ['travel', { board: { w: 40, h: 30, x: 380, y: 90 } }],
    ['travel', { board: { w: 500, h: 30, x: 0, y: 0 } }],
    ['travel', { board: { w: 40, h: 30, x: -1, y: 0 } }],
    ['loaded', { confirmedLoaded: false }],
  ];
  for (const [id, p] of plants) {
    const i = { ...CLEAN, ...p };
    assert.equal(state(i, id), 'FAIL', `${id} did not fail on ${JSON.stringify(p)}`);
    assert.equal(mayRun(pnpGates(i)), false);
  }
});

test('the physical gate asks a PERSON and is never cleared by the app', () => {
  const g = pnpGates({ ...CLEAN, confirmedLoaded: false }).find((x) => x.id === 'loaded')!;
  assert.equal(g.confirm, true);
});

test('PENDING is not a pass: loading / no plan / no board model block a run', () => {
  for (const p of [{ loaded: false }, { plan: null }, { board: null }, { parts: null, loaded: false }] as Partial<PnpGateInput>[]) {
    const g = pnpGates({ ...CLEAN, ...p });
    assert.ok(g.some((x) => x.state === 'PENDING'), JSON.stringify(p));
    assert.equal(mayRun(g), false);
  }
});

test('Fix: trays from the plan\'s own need pass the same check a chat proposal passes', () => {
  const VS = parseVspec(JSON.parse(readFileSync(new URL('../../../../hardware/cad/2bee_pnp/pnp_blinds_vspec.json', import.meta.url), 'utf8')));
  const bom = 'Reference,Qty,Value,Package,Manufacturer,Mfr_PN,LCSC_PN,Note,DNP,Consigned\n"U1",1,INA219,SOIC-8,M,INA,,,,';
  const cpl = 'Ref,Val,Package,PosX,PosY,Rot,Side\nU1,INA219,SOIC-8,0,0,0,top';
  const run = (trays: { trayId: string; variant: string }[]) => preflight({ bomCsv: bom, cplCsv: cpl, trays, boards: 1, overrides: {}, vspec: VS, assembly: {} });
  const before = run([]);
  assert.equal(before.exit, 1);
  const trays = traysFromNeed(before, 24);
  assert.deepEqual(trays, [{ trayId: 'T01', variant: '12' }]);
  const after = run(trays!);
  assert.equal(after.exit, 0);
  assert.equal(mayApplyPnp(before, after), true);
  assert.equal(traysFromNeed(before, 0), null);
});
