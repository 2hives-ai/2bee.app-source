/* 2bee.pnp chat view — the checks between a model's reply and the tab's settings
 * (`pnpAsk.ts`), the board model the 3D view draws (`boardModel.ts`), and the
 * machine facts' citations (`pnpMachines.ts`). Every refusal is asserted by WHAT
 * it names, and every gate has a case that must trip it. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { mayApplyPnp, readPnpProposal, patchIsEmpty, pnpRows, describeContext, type PnpSettings } from '../src/pnp/pnpAsk';
import { parseVspec, preflight, type PreflightResult } from '../src/pnp/manifest';
import { boardModel, bodySize, PLATE_MARGIN_MM } from '../src/pnp/boardModel';
import { PNP_MACHINES, pnpMachineById, DEFAULT_PNP_MACHINE_ID } from '../src/pnp/pnpMachines';

const REPO = new URL('../../../../', import.meta.url);
const VS = parseVspec(JSON.parse(readFileSync(new URL('hardware/cad/2bee_pnp/pnp_blinds_vspec.json', REPO), 'utf8')));
const CUR: PnpSettings = { boards: 1, trays: [{ trayId: 'T01', variant: '0402' }] };

test('proposal: a valid patch is read, and an unchanged field drops out', () => {
  const r = readPnpProposal(
    '```json\n{"answer":"ok","patch":{"boards":5,"trays":[{"trayId":"T01","variant":"0402"},{"trayId":"T02","variant":"8paper"}]}}\n```',
    CUR,
    VS
  );
  assert.ok(r.ok);
  assert.equal(r.patch.boards, 5);
  assert.equal(r.patch.trays?.length, 2);
  const same = readPnpProposal('{"answer":"x","patch":{"boards":1}}', CUR, VS);
  assert.ok(same.ok && patchIsEmpty(same.patch));
});

test('proposal: plain text is an ANSWER with no change, not a failure', () => {
  const r = readPnpProposal('The 0402 tray holds 12 lanes.', CUR, VS);
  assert.ok(r.ok && patchIsEmpty(r.patch) && r.answer.includes('12 lanes'));
});

test('proposal: every out-of-rules field refuses the WHOLE patch, by name', () => {
  const cases: [string, RegExp][] = [
    ['{"patch":{"overrides":{}}}', /"overrides" is not a setting/],
    ['{"patch":{"boards":0}}', /boards must be a whole number/],
    ['{"patch":{"boards":2.5}}', /boards must be a whole number/],
    ['{"patch":{"boards":"3"}}', /boards must be a whole number/],
    ['{"patch":{"trays":[{"trayId":"T9","variant":"99mm"}]}}', /"99mm" is not a variant/],
    ['{"patch":{"trays":[{"trayId":"A","variant":"0402"},{"trayId":"A","variant":"12"}]}}', /tray A listed twice/],
    ['{"patch":{"trays":[{"trayId":"bad id!","variant":"0402"}]}}', /trayId must be/],
    ['{"patch":{"boards":4,"machine":"x"}}', /"machine" is not a setting/],
  ];
  for (const [raw, re] of cases) {
    const r = readPnpProposal(raw, CUR, VS);
    assert.ok(!r.ok, raw);
    assert.ok(r.problems.some((p) => re.test(p)), `${raw} → ${r.problems.join(' | ')}`);
  }
});

test('rows say from → to', () => {
  assert.deepEqual(pnpRows(CUR, { boards: 3 }), ['Boards: 1 → 3']);
});

const BOM = ['Reference,Qty,Value,Package,Manufacturer,Mfr_PN,LCSC_PN,Note,DNP,Consigned', '"R1,R2",2,100k,R0402,M,PN-R,,,,'].join('\n');
const CPL = ['Ref,Val,Package,PosX,PosY,Rot,Side', 'R1,100k,R0402,0,0,0,top', 'R2,100k,R0402,10,-5,90,top'].join('\n');
const plan = (boards: number, trays = CUR.trays): PreflightResult =>
  preflight({ bomCsv: BOM, cplCsv: CPL, trays, boards, vspec: VS });

test('mayApplyPnp: OK applies; could-not-run never; refused only when strictly better', () => {
  const ok = plan(1);
  const short = plan(1000); // 2000 parts, one 0402 tray — refused (rule 2)
  const none = plan(1, []); // no tray at all — refused (rule 1)
  const broken = plan(0); // boards 0 — could not run
  assert.equal(ok.exit, 0);
  assert.equal(short.exit, 1);
  assert.equal(broken.exit, 2);
  assert.equal(mayApplyPnp(short, ok), true);
  assert.equal(mayApplyPnp(ok, broken), false);
  assert.equal(mayApplyPnp(ok, short), false, 'OK → REFUSED must not apply');
  assert.equal(mayApplyPnp(short, short), false, 'lateral must not apply');
  assert.equal(mayApplyPnp(null, short), false);
  assert.equal(mayApplyPnp(short, null), false);
  assert.equal(mayApplyPnp(short, 'could not read'), false);
  assert.ok(none.refusals.length >= 1);
});

test('context carries the verdict and the refusals the model is asked about', () => {
  const t = describeContext({ board: 'x', settings: { boards: 1000, trays: CUR.trays }, vspec: VS, result: plan(1000), machine: 'm' });
  assert.match(t, /Plan: REFUSED/);
  assert.match(t, /Refusal \[2\]/);
});

test('bodySize: table, name, unknown — and says which', () => {
  assert.deepEqual(bodySize('R0402'), { l: 1, w: 0.5, h: 0.35, from: 'table' });
  assert.equal(bodySize('C 0805').from, 'table');
  assert.equal(bodySize('0603 2-term').from, 'table');
  assert.equal(bodySize('SOT-23-5 (DBV)').from, 'table');
  const q = bodySize('QFN-64 9x9mm 0.5p + EP (CP2108)');
  assert.equal(q.from, 'name');
  assert.equal(q.l, 9);
  assert.equal(bodySize('Bosch BME280 LGA-8 2.5x2.5x0.93mm').h, 0.93);
  assert.equal(bodySize('Inductor 4030 SMD').from, 'unknown');
  assert.equal(bodySize('').from, 'unknown');
});

test('boardModel: positions, bottom side, unreadable rows, plate = extent + margin', () => {
  const m = boardModel(['Ref,Val,Package,PosX,PosY,Rot,Side', 'A,1,R0402,0,0,0,top', 'B,1,R0402,10,-4,90,bottom', 'C,1,R0402,,1,0,top'].join('\n'));
  assert.equal(m.parts.length, 2);
  assert.deepEqual(m.unreadable, ['C']);
  assert.equal(m.parts[1].side, 'bottom');
  assert.deepEqual(m.plate, { minX: -PLATE_MARGIN_MM, minY: -4 - PLATE_MARGIN_MM, maxX: 10 + PLATE_MARGIN_MM, maxY: PLATE_MARGIN_MM });
});

test("boardModel on every pcb fab CPL: every row is a part or named unreadable", () => {
  const pcb = new URL('hardware/pcb/', REPO);
  let boards = 0;
  for (const d of readdirSync(pcb, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const fab = new URL(`${d.name}/fab/`, pcb);
    if (!existsSync(fab)) continue;
    const files = readdirSync(fab, { recursive: true }).map(String).filter((f) => f.endsWith('-cpl.csv'));
    for (const f of files) {
      const text = readFileSync(new URL(f, fab), 'utf8');
      const rows = text.split(/\r?\n/).filter((l) => l.trim()).length - 1;
      const m = boardModel(text);
      // Rows with quoted newlines would break this count; none of pcb's CPLs have one.
      assert.equal(m.parts.length + m.unreadable.length, rows, `${d.name}/${f}`);
      assert.equal(m.sizes.table + m.sizes.name + m.sizes.unknown, m.parts.length);
      boards++;
    }
  }
  assert.ok(boards >= 10, `read ${boards} CPLs — an empty population is not a pass`);
});

// `hardware/pnp/` left this repo in db8fb08ace (2026-10-19) for 2hives-ai/2bee-smt-manufacturing,
// byte-identical at the cited lines. The citations resolve against that checkout, beside this one.
// Without it the check cannot run, and it SKIPS by name rather than reading a missing file as fine.
const SMT_REPO = new URL('../2bee-smt-manufacturing/', REPO);

test('pnpMachines: every citation resolves to a file and a line that exists', (t) => {
  if (!existsSync(new URL('hardware/pnp/', SMT_REPO))) {
    t.skip(`PENDING: ${SMT_REPO.pathname} not checked out, so no citation was checked`);
    return;
  }
  assert.equal(pnpMachineById('nope').id, DEFAULT_PNP_MACHINE_ID);
  assert.ok(PNP_MACHINES.length >= 2);
  for (const m of PNP_MACHINES) {
    assert.ok(m.sources.length > 0, m.id);
    for (const s of m.sources) {
      const mm = /^(hardware\/pnp\/[^:]+):(\d+)(?:-(\d+))?$/.exec(s);
      assert.ok(mm, `${m.id}: "${s}" is not file:line`);
      const lines = readFileSync(new URL(mm[1], SMT_REPO), 'utf8').split('\n').length;
      assert.ok(Number(mm[3] ?? mm[2]) <= lines, `${s}: file has ${lines} lines`);
    }
    for (const v of [m.travel.x, m.travel.y, m.travel.z]) assert.ok(v === null || v > 0, m.id);
  }
});

import { openInPnp, claimPendingPnp, subscribePnp, resetPnpHandoff } from '../src/pnp/pnpHandoff';
import { boardThumbnailSvg } from '../src/pnp/boardModel';

test('handoff: held until claimed, claim clears, latest click wins, listeners get it live', () => {
  resetPnpHandoff();
  openInPnp('a');
  openInPnp('b');
  assert.equal(claimPendingPnp(), 'b');
  assert.equal(claimPendingPnp(), null, 'a claim must clear the slot');
  const got: string[] = [];
  const off = subscribePnp((id) => got.push(id));
  openInPnp('outlet');
  assert.deepEqual(got, ['outlet']);
  assert.equal(claimPendingPnp(), null, 'a delivered request is not also pending');
  off();
  openInPnp('c');
  assert.equal(claimPendingPnp(), 'c');
  resetPnpHandoff();
});

test('thumbnail: an SVG data URL with one rect per part plus the plate', () => {
  const m = boardModel(['Ref,Val,Package,PosX,PosY,Rot,Side', 'A,1,R0402,0,0,0,top', 'B,1,SOIC-8,10,-4,90,bottom'].join('\n'));
  const url = boardThumbnailSvg(m);
  assert.ok(url.startsWith('data:image/svg+xml;utf8,'));
  const svg = decodeURIComponent(url.slice(url.indexOf(',') + 1));
  assert.equal((svg.match(/<rect /g) ?? []).length, 3);
  assert.match(svg, /fill="none"/, 'the bottom-side part is hollow');
});

import { placeOnTravel, defaultPlacement } from '../src/pnp/boardModel';

test('placeOnTravel: inside is kept, outside is HELD at the edge and says so, no travel = unchecked', () => {
  const T = { x: 410, y: 210 };
  const S = { w: 100, h: 60 };
  assert.deepEqual(placeOnTravel({ x: 10, y: 20 }, S, T), { x: 10, y: 20, held: false, fits: true, checked: true });
  const far = placeOnTravel({ x: 400, y: -5 }, S, T);
  assert.deepEqual([far.x, far.y, far.held], [310, 0, true]);
  const big = placeOnTravel({ x: 5, y: 5 }, { w: 500, h: 60 }, T);
  assert.equal(big.fits, false);
  assert.equal(big.x, 0);
  const none = placeOnTravel({ x: -50, y: 9999 }, S, null);
  assert.deepEqual(none, { x: -50, y: 9999, held: false, fits: true, checked: false });
  const d = defaultPlacement(S, T);
  assert.deepEqual([d.x, d.y, d.held], [155, 75, false]);
});

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test("gerber render: every fab board rendered, real outline size, CPL parts inside it, missing layers named", () => {
  const out = join(mkdtempSync(join(tmpdir(), 'pnp-stk-')), 'o');
  try {
    execFileSync(process.execPath, ['--import', './tests/register.mjs', 'scripts/build-pnp-stackup.ts', '--out', out], {
      cwd: new URL('..', import.meta.url),
      stdio: 'pipe',
    });
    const idx = JSON.parse(readFileSync(join(out, 'index.json'), 'utf8')) as {
      boards: { id: string; source: string; box?: { minX: number; minY: number; w: number; h: number }; missing: string[]; error?: string }[];
    };
    assert.ok(idx.boards.length >= 10, `${idx.boards.length} boards — an empty population is not a pass`);
    const outlet = idx.boards.find((b) => b.id === 'outlet')!;
    // outlet's Edge_Cuts gerber: X 0..130.048, Y -100.076..0 (read from the file, 2026-10-15)
    assert.deepEqual(outlet.box, { minX: 0, minY: -100.076, w: 130.048, h: 100.076 });
    assert.deepEqual(idx.boards.find((b) => b.id === 'buck48_05')!.missing, ['F_Cu', 'F_Mask']);
    for (const b of idx.boards) {
      assert.equal(b.error, undefined, `${b.id}: ${b.error}`);
      const cplPath = new URL(`${b.source}/${b.id}-cpl.csv`, REPO);
      if (!existsSync(cplPath)) continue;
      const m = boardModel(readFileSync(cplPath, 'utf8'));
      const x = b.box!;
      const outside = m.parts.filter((p) => p.x < x.minX || p.x > x.minX + x.w || p.y < x.minY || p.y > x.minY + x.h);
      assert.deepEqual(outside.map((p) => p.ref), [], `${b.id}: CPL parts outside the gerber outline box — frames disagree`);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

import { boardParts, countLine, parseKicadFootprints, byOfTier } from '../src/pnp/parts';

test('parts: every BOM part with who fits it — buck48_05 is 13 parts, 5 by machine, 8 by hand', () => {
  const d = new URL('hardware/pcb/buck48_05/', REPO);
  const b = boardParts({
    bom: readFileSync(new URL('fab/buck48_05-bom.csv', d), 'utf8'),
    cpl: readFileSync(new URL('fab/buck48_05-cpl.csv', d), 'utf8'),
    sidecar: readFileSync(new URL('buck48_05-pns.csv', d), 'utf8'),
    kicad: readFileSync(new URL('buck48_05.kicad_pcb', d), 'utf8'),
  });
  // pcb's buck48_05 as of 2026-10-15; re-measure here if pcb changes the board.
  assert.equal(countLine(b), '13 parts: 5 by machine (bottom), 8 by hand (7 THT)');
  assert.equal(b.parts.length, 13, 'every part has a position (CPL or .kicad_pcb)');
  assert.equal(b.nonParts, 9);
  assert.equal(b.parts.find((p) => p.ref === 'U_DC')?.by, 'hand');
  assert.equal(b.parts.find((p) => p.ref === 'J_IN')?.from, 'kicad_pcb');
  assert.equal(byOfTier('SOMETHING-NEW', false), 'unknown');
  assert.equal(byOfTier('INHOUSE', true), 'dnp');
});

test("parts: .kicad_pcb positions agree with the CPL (x, −y) on every board that has both", () => {
  const pcb = new URL('hardware/pcb/', REPO);
  let compared = 0;
  for (const d of readdirSync(pcb, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const fab = new URL(`${d.name}/fab/`, pcb);
    if (!existsSync(fab)) continue;
    for (const f of readdirSync(fab, { recursive: true }).map(String).filter((x) => x.endsWith('-cpl.csv'))) {
      const id = f.split('/').pop()!.replace(/-cpl\.csv$/, '');
      const kp = new URL(`${d.name}/${id}.kicad_pcb`, pcb);
      if (!existsSync(kp)) continue;
      const fps = new Map(parseKicadFootprints(readFileSync(kp, 'utf8')).map((x) => [x.ref, x]));
      for (const p of boardModel(readFileSync(new URL(f, fab), 'utf8')).parts) {
        const k = fps.get(p.ref);
        if (!k) continue;
        assert.ok(Math.hypot(k.x - p.x, k.y - p.y) < 0.01, `${id} ${p.ref}: kicad (${k.x}, ${k.y}) vs CPL (${p.x}, ${p.y})`);
        assert.equal(k.side, p.side, `${id} ${p.ref} side`);
        compared++;
      }
    }
  }
  assert.ok(compared > 300, `compared ${compared} parts — an empty population is not a pass`);
});

test('parseKicadFootprints: a footprint at column 0 and a multi-line KiCad 9 (model …) are both read', () => {
  const fps = parseKicadFootprints(readFileSync(new URL('hardware/pcb/hbs57_usb6/hbs57_usb6.kicad_pcb', REPO), 'utf8'));
  const y1 = fps.find((f) => f.ref === 'Y1');
  assert.ok(y1, 'Y1 (pasted at column 0) found');
  assert.deepEqual(
    y1!.models.map((m) => m.path),
    ['${KICAD9_3DMODEL_DIR}/Crystal.3dshapes/Crystal_SMD_3225-4Pin_3.2x2.5mm.step']
  );
  assert.deepEqual(y1!.models[0].scale, [1, 1, 1]);
  const synthetic = parseKicadFootprints(
    '(kicad_pcb\n\t(footprint "X"\n\t\t(layer "B.Cu")\n\t\t(at 1 2 90)\n\t\t(property "Reference" "U9"\n\t\t)\n\t\t(model "m.step"\n\t\t\t(offset\n\t\t\t\t(xyz 1 2 3)\n\t\t\t)\n\t\t\t(scale\n\t\t\t\t(xyz 1 1 1)\n\t\t\t)\n\t\t\t(rotate\n\t\t\t\t(xyz 0 0 -90)\n\t\t\t)\n\t\t)\n\t)\n)'
  );
  assert.deepEqual(synthetic, [
    { ref: 'U9', footprint: 'X', side: 'bottom', x: 1, y: -2, rot: 90, models: [{ path: 'm.step', offset: [1, 2, 3], scale: [1, 1, 1], rotate: [0, 0, -90] }], pads: { tht: 0, smd: 0 } },
  ]);
  // Pad types: buck48_05's Mornsun DC/DC is a 6-pin DIP (5 pads fitted), every one thru_hole.
  const udc = parseKicadFootprints(readFileSync(new URL('hardware/pcb/buck48_05/buck48_05.kicad_pcb', REPO), 'utf8')).find((f) => f.ref === 'U_DC');
  assert.deepEqual(udc?.pads, { tht: 5, smd: 0 });
  assert.ok((y1!.pads.smd) > 0 && y1!.pads.tht === 0, 'the SMD crystal has smd pads only');
});

import { assemblySequence, placementRank, SIDE_RULINGS } from '../src/pnp/parts';

test('assembly sequence: machine side(s) first, then THT lowest first, then hand; pcb rulings cited', () => {
  const load = (d: string, id: string, sub = '') => {
    const fab = new URL(`hardware/pcb/${d}/fab/${sub}`, REPO);
    const side = new URL(`hardware/pcb/${d}/${id}-pns.csv`, REPO);
    return boardParts({
      bom: readFileSync(new URL(`${id}-bom.csv`, fab), 'utf8'),
      cpl: readFileSync(new URL(`${id}-cpl.csv`, fab), 'utf8'),
      sidecar: existsSync(side) ? readFileSync(side, 'utf8') : '',
      kicad: readFileSync(new URL(`hardware/pcb/${d}/${id}.kicad_pcb`, REPO), 'utf8'),
    });
  };
  const buck = assemblySequence('buck48_05', load('buck48_05', 'buck48_05').parts);
  assert.deepEqual(buck.map((g) => g.title), ['1. Bottom reflow · machine', '2. Top · hand, THT', '3. Hand-fitted']);
  // THT lowest first: the 330 µF electrolytics (box_…x27) after the connectors; U_DC (HAND) last of all
  const tht = buck[1].refs;
  assert.ok(tht.indexOf('C0') > tht.indexOf('J_IN') && tht.indexOf('C3') > tht.indexOf('J_IN'), tht.join(' '));
  assert.deepEqual(buck[2].refs, ['U_DC']);
  const io = assemblySequence('sensor_pod_v3_io', load('sensor_pod_v3', 'sensor_pod_v3_io', 'io/').parts);
  const topFirst = io.findIndex((g) => g.title.includes('Top reflow (first)'));
  const bottomSecond = io.findIndex((g) => g.title.includes('Bottom reflow (second)'));
  assert.ok(topFirst >= 0 && topFirst < bottomSecond, io.map((g) => g.title).join(' | '));
  assert.match(io[topFirst].basis, /sensor_pod_v3_io-assembly-notes\.md/);
  for (const r of Object.values(SIDE_RULINGS)) assert.ok(existsSync(new URL(r.source.split(' ')[0], REPO)), r.source);
  assert.ok(placementRank('R0402') < placementRank('C0603') && placementRank('C1206') < placementRank('SOT-23-3') && placementRank('SOT-23-3') < placementRank('SOIC-8'));
});

test('a CPL row with no Y or no rotation is not a position (bughunt 2026-11-15)', () => {
  // `Number('')` is 0: R1 was placed at y=0 and G-CPL passed; an empty Rot became 0°.
  const bom = 'Reference,Value,Package,Mfr_PN,DNP,Consigned\nR1,10k,R0603,PN1,,\nR2,10k,R0603,PN1,,\n';
  const cpl = 'Ref,Val,Package,PosX,PosY,Rot,Side\nR1,10k,R0603,12.5,,90,top\nR2,10k,R0603,3,4,,top\n';
  const b = boardParts({ bom, cpl });
  assert.deepEqual(b.parts.map((p) => p.ref), []);
  assert.deepEqual(b.unplaced.map((u) => u.ref).sort(), ['R1', 'R2']);
});
