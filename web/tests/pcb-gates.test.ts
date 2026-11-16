/**
 * The pcb tab's gates (src/pcbtab/pcbGates.ts). Each rule is driven to PASS by a
 * clean input and away from PASS by the defect it guards: a recorded PASS shows
 * PASS only while the record is tied to today's board; a missing record, a stale
 * record or an untied snapshot is PENDING; parts on a side with no copper FAIL.
 *
 * NEGATIVE CONTROL: `PCB_GATES_MODULE=<path>` loads a planted copy of the module
 * instead (see the commit body for the red run).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import type * as Mod from '../src/pcbtab/pcbGates.ts';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const M: typeof Mod = await import(process.env.PCB_GATES_MODULE ? pathToFileURL(resolve(process.env.PCB_GATES_MODULE)).href : '../src/pcbtab/pcbGates.ts');
const { pcbGates, parseRpt, parseDrcJson, staleness } = M;
type Snap = Mod.GatesSnapshot;
type Rec = Mod.BoardRecords;
type In = Mod.PcbGateInput;

const BOARD_SHA = 'a'.repeat(64);
const GEN_SHA = 'b'.repeat(64);

function rec(over: Partial<Rec> = {}): Rec {
  return {
    id: 'demo',
    dir: 'hardware/pcb/demo',
    fabDir: 'hardware/pcb/demo/fab',
    board: {
      kicadPcb: 'hardware/pcb/demo/demo.kicad_pcb',
      sha256: BOARD_SHA,
      pcbChanged: { file: 'hardware/pcb/demo/demo.kicad_pcb', date: '2026-10-10T00:00:00.000Z', how: 'commit' },
      schChanged: { file: 'hardware/pcb/demo/demo.kicad_sch', date: '2026-10-10T00:00:00.000Z', how: 'commit' },
      generator: 'hardware/pcb/demo/pcb_demo.py',
      generatorSha: GEN_SHA,
    },
    fab: {
      files: ['demo-F_Cu.gbr', 'demo-B_Cu.gbr', 'demo-F_Mask.gbr', 'demo-B_Mask.gbr', 'demo-F_Silkscreen.gbr', 'demo-B_Silkscreen.gbr', 'demo-Edge_Cuts.gbr', 'demo-PTH.drl', 'demo-assembly-notes.md'],
      sourceSha: BOARD_SHA,
      gerberCreated: '2026-10-11T00:00:00+11:00',
      jobCopperLayers: 2,
      doNotOrder: [],
      ordered: null,
    },
    erc: [{ file: 'hardware/pcb/demo/demo-erc.rpt', kind: 'erc', date: '2026-10-12T00:00:00+11:00', errors: 0, warnings: 0, types: {} }],
    drc: [],
    verifiers: [],
    adjudications: [],
    matrix: { file: 'hardware/pcb/docs/fleet-gate-matrix-2026-06-29.json', committed: '2026-10-15T06:32:18+11:00', generatorSha: GEN_SHA, rows: { '1': { status: 'PASS', detail: '0 ERC errors' }, '3': { status: 'FAIL', detail: '2 unconnected' }, '7': { status: 'WARN', detail: 'advisory' } } },
    ...over,
  };
}
const snap = (r: Rec = rec()): Snap => ({ generatedAt: '2026-10-16T00:00:00Z', generator: 't', gateNames: { '1': 'G1 ERC', '3': 'G3 Route' }, guards: { '3': 'stops the bare-board order: unconnected nets' }, order: ['1', '3', '7'], boards: [r] });
const CLEAN: In = {
  boardId: 'demo',
  snapshot: snap(),
  liveBoardSha: BOARD_SHA,
  parts: { parts: [{ ref: 'R1', side: 'top', by: 'machine', from: 'cpl' }, { ref: 'J1', side: 'bottom', by: 'hand-tht', from: 'kicad_pcb' }], unplaced: [] },
  bomRefs: ['R1', 'J1'],
  cplRefs: ['R1'],
  footprintRefs: ['R1', 'J1', 'FID1'],
};
const gate = (i: In, id: string) => {
  const g = pcbGates(i).find((x) => x.id === id);
  assert.ok(g, `gate ${id} exists`);
  return g!;
};

test('a recorded PASS, tied to the live board, is PASS — and names its source file', () => {
  const g = gate(CLEAN, 'm-1');
  assert.equal(g.state, 'PASS');
  assert.equal(g.name, 'G1 ERC');
  assert.match(g.source, /fleet-gate-matrix-2026-06-29\.json \[demo\]\[1\]/);
  assert.equal(gate(CLEAN, 'm-3').state, 'FAIL');
  assert.equal(gate(CLEAN, 'm-3').guards, 'stops the bare-board order: unconnected nets');
  assert.equal(gate(CLEAN, 'm-7').state, 'PENDING', 'WARN is not a pass');
  assert.equal(gate(CLEAN, 'erc').state, 'PASS');
  assert.match(gate(CLEAN, 'erc').source, /demo-erc\.rpt \(2026-10-11 13:00 UTC\)/);
  for (const id of ['snapshot', 'fab-top', 'fab-bottom', 'fab-outline', 'fab-drill', 'fab-fresh', 'fab-cpl', 'fab-bom', 'fab-notes', 'order-hold'])
    assert.equal(gate(CLEAN, id).state, 'PASS', id);
});

test('a missing record is PENDING, never PASS', () => {
  assert.equal(gate({ ...CLEAN, snapshot: snap(rec({ erc: [] })) }, 'erc').state, 'PENDING');
  assert.equal(gate({ ...CLEAN, snapshot: snap(rec({ drc: [] })) }, 'drc').state, 'PENDING');
  const noMatrix = pcbGates({ ...CLEAN, snapshot: snap(rec({ matrix: null })) });
  assert.equal(noMatrix.find((x) => x.id === 'matrix')!.state, 'PENDING');
  assert.ok(!noMatrix.some((x) => x.id.startsWith('m-')));
  // No snapshot at all: every gate read from it is PENDING.
  const none = pcbGates({ ...CLEAN, snapshot: 'no gate records collected (HTTP 404) — run npm run pcb:gates' });
  for (const g of none) if (!['fab-cpl', 'fab-bom'].includes(g.id)) assert.notEqual(g.state, 'PASS', g.id);
  assert.equal(none.find((x) => x.id === 'fab-fresh')!.state, 'PENDING');
  // A row with no _generator_sha cannot be tied: PENDING even when it says PASS.
  const r = rec();
  const unstamped = gate({ ...CLEAN, snapshot: snap({ ...r, matrix: { ...r.matrix!, generatorSha: null } }) }, 'm-1');
  assert.equal(unstamped.state, 'PENDING');
  assert.match(unstamped.why, /no _generator_sha/);
  // A verifier is never PASS from here — its result is not on disk.
  assert.equal(gate({ ...CLEAN, snapshot: snap(rec({ verifiers: ['hardware/pcb/demo/verify_demo.py'] })) }, 'verify-verify_demo.py').state, 'PENDING');
});

test('a stale record is PENDING and says when it was recorded and when the board changed', () => {
  const stale = rec({ erc: [{ file: 'hardware/pcb/demo/demo-erc.rpt', kind: 'erc', date: '2026-10-01T00:00:00+10:00', errors: 0, warnings: 0, types: {} }] });
  const g = gate({ ...CLEAN, snapshot: snap(stale) }, 'erc');
  assert.equal(g.state, 'PENDING');
  assert.match(g.why, /stale: recorded 2026-09-30 14:00 UTC, schematic changed 2026-10-10 00:00 UTC/);
  // Matrix row recorded against an older generator.
  const r = rec();
  const old = gate({ ...CLEAN, snapshot: snap({ ...r, matrix: { ...r.matrix!, generatorSha: 'c'.repeat(64) } }) }, 'm-1');
  assert.equal(old.state, 'PENDING');
  assert.match(old.why, /stale: recorded against .*pcb_demo\.py/);
  // The board changed after the snapshot was taken: nothing recorded may PASS.
  const moved = pcbGates({ ...CLEAN, liveBoardSha: 'd'.repeat(64) });
  assert.equal(moved.find((x) => x.id === 'snapshot')!.state, 'PENDING');
  for (const x of moved) if (x.group !== 'fab' || !['fab-cpl', 'fab-bom'].includes(x.id)) assert.notEqual(x.state, 'PASS', `${x.id} must not PASS untied`);
  assert.equal(moved.find((x) => x.id === 'fab-fresh')!.state, 'FAIL', 'fab exported from another board');
  // staleness itself.
  assert.equal(staleness('2026-10-11T00:00:00Z', { file: 'x', date: '2026-10-10T00:00:00Z', how: 'commit' }), null);
  assert.match(staleness(null, null)!, /no date/);
});

test('missing F_Cu where top parts exist: FAIL for SMD, PENDING (with the reason) for THT only', () => {
  const noTop = rec();
  noTop.fab = { ...noTop.fab, files: noTop.fab.files.filter((f) => !/F_(Cu|Mask)/.test(f)), jobCopperLayers: 1 };
  const smd = gate({ ...CLEAN, snapshot: snap(noTop) }, 'fab-top');
  assert.equal(smd.state, 'FAIL');
  assert.match(smd.why, /R1 machine.*no F_Cu, F_Mask gerber/);
  const thtOnly: In = { ...CLEAN, snapshot: snap(noTop), parts: { parts: [{ ref: 'C0', side: 'top', by: 'hand-tht', from: 'kicad_pcb' }, { ref: 'C1', side: 'bottom', by: 'machine', from: 'cpl' }], unplaced: [] }, cplRefs: ['C1'], bomRefs: ['C0', 'C1'] };
  const t = gate(thtOnly, 'fab-top');
  assert.equal(t.state, 'PENDING');
  assert.match(t.why, /THT .*C0.*no F_Cu, F_Mask.*job file says 1 copper layer/);
  assert.equal(gate(thtOnly, 'fab-bottom').state, 'PASS');
  // The copper count must agree with the job file.
  const lying = rec();
  lying.fab = { ...lying.fab, jobCopperLayers: 4 };
  assert.equal(gate({ ...CLEAN, snapshot: snap(lying) }, 'fab-outline').state, 'FAIL');
});

test('CPL and BOM coverage; order hold; drill', () => {
  const noCpl = gate({ ...CLEAN, cplRefs: [] }, 'fab-cpl');
  assert.equal(noCpl.state, 'FAIL');
  assert.match(noCpl.why, /R1/);
  const orphan = gate({ ...CLEAN, cplRefs: ['R1', 'R9'] }, 'fab-bom');
  assert.equal(orphan.state, 'FAIL');
  assert.match(orphan.why, /R9/);
  const held = rec();
  held.fab = { ...held.fab, doNotOrder: [{ file: '_DO-NOT-ORDER.md', title: 'DO NOT ORDER — retired' }] };
  assert.equal(gate({ ...CLEAN, snapshot: snap(held) }, 'order-hold').state, 'FAIL');
  const noDrill = rec();
  noDrill.fab = { ...noDrill.fab, files: noDrill.fab.files.filter((f) => !f.endsWith('.drl')) };
  assert.equal(gate({ ...CLEAN, snapshot: snap(noDrill) }, 'fab-drill').state, 'FAIL');
});

test('kicad-cli reports parse, including the +1000 offset', () => {
  const erc = parseRpt('x-erc.rpt', 'ERC report (2026-10-15T06:20:24+1100, Encoding UTF8)\n\n***** Sheet /\n[pin_not_connected]: x\n ** ERC messages: 3  Errors 1  Warnings 2\n');
  assert.deepEqual([erc.kind, erc.date, erc.errors, erc.warnings, erc.types.pin_not_connected], ['erc', '2026-10-15T06:20:24+11:00', 1, 2, 1]);
  const drc = parseRpt(
    'x-drc.rpt',
    '** Drc report for x.kicad_pcb **\n** Created on 2026-09-06T05:06:03+1000 **\n\n** Found 3 DRC violations **\n[silk_overlap]: a\n    Rule: x; warning\n[clearance]: b\n    Rule: y; error\n[clearance]: c\n    Rule: y; error\n** Found 1 unconnected pads **\n** Found 0 Footprint errors **\n'
  );
  assert.deepEqual([drc.violations, drc.errors, drc.warnings, drc.unconnected, drc.types.clearance], [3, 2, 1, 1, 2]);
  assert.ok(Number.isFinite(Date.parse(drc.date!)));
  const j = parseDrcJson('x.json', JSON.stringify({ date: '2026-09-17T20:51:55+1000', violations: [{ type: 'clearance', severity: 'error' }], unconnected_items: [{}, {}] }));
  assert.deepEqual([j.errors, j.unconnected, j.date], [1, 2, '2026-09-17T20:51:55+10:00']);
  assert.equal(parseRpt('junk.rpt', 'not a report').violations, null);
});

test('on the real tree: buck48_05 has no F_Cu/F_Mask by design (pcb: single-sided) — PASS only while every top part is THT', { skip: !existsSync(resolve(HERE, '../../../../hardware/pcb/buck48_05')) }, async () => {
  const out = join(mkdtempSync(join(tmpdir(), 'pcb-gates-')), 'index.json');
  execFileSync(process.execPath, ['--import', './tests/register.mjs', 'scripts/build-pcb-gates.ts', '--out', out], { cwd: resolve(HERE, '..'), stdio: 'pipe' });
  const s = JSON.parse(readFileSync(out, 'utf8')) as Snap;
  assert.ok(s.boards.length >= 10, `boards collected: ${s.boards.length}`);
  assert.ok(Object.keys(s.gateNames).length > 100, 'gate register read from gate_check.py');
  const b = s.boards.find((x) => x.id === 'buck48_05');
  assert.ok(b, 'buck48_05 collected');
  if (b.fab.files.includes('buck48_05-F_Cu.gbr')) return; // pcb added it: nothing left to assert
  const { boardParts } = await import('../src/pnp/parts.ts');
  const pcb = resolve(HERE, '../../../../hardware/pcb/buck48_05');
  const bom = readFileSync(join(pcb, 'fab/buck48_05-bom.csv'), 'utf8');
  const cpl = readFileSync(join(pcb, 'fab/buck48_05-cpl.csv'), 'utf8');
  const kicad = readFileSync(join(pcb, 'buck48_05.kicad_pcb'), 'utf8');
  const parts = boardParts({ bom, cpl, kicad, sidecar: readFileSync(join(pcb, 'buck48_05-pns.csv'), 'utf8') });
  const run = (pp: typeof parts) => pcbGates({ boardId: 'buck48_05', snapshot: s, liveBoardSha: b.board.sha256, parts: pp, bomRefs: [], cplRefs: [], footprintRefs: [] }).find((x) => x.id === 'fab-top')!;
  const top = run(parts);
  assert.equal(top.state, 'PASS', top.why);
  assert.match(top.why, /no copper \(single-sided board\)/);
  assert.match(top.why, /no F_Cu, F_Mask gerber by design/);
  // PLANT: one SMD part (an smd pad, not BOM-tagged THT) on the top of the same board still fails — the declaration
  // explains missing top copper for THT bodies only.
  const firstTop = parts.parts.findIndex((p) => p.side === 'top');
  assert.ok(firstTop >= 0, 'buck48_05 has top-side parts');
  const planted = { ...parts, parts: parts.parts.map((p, k) => (k === firstTop ? { ...p, by: 'machine' as const, allThroughHole: false } : p)) };
  assert.equal(run(planted).state, 'FAIL');
});
