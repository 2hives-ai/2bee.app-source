/* PnP slice 1 — every refusal in `pnp`'s acceptance (08-45-33 §2) has a case that
 * MUST trip it, and a clean case that must not. A refusal is asserted by its rule
 * number AND the item it names, never by "something failed". */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  FIT,
  SPROCKET_MARGIN_MM,
  laneCapacity,
  parseCsv,
  parseOverrides,
  parseVspec,
  assemblyFromSidecar,
  preflight,
  type Overrides,
  type AssemblyMap,
  type TrayDef,
} from '../src/pnp/manifest';

/* `cad`'s generated file, read from disk — the same file the browser build imports. */
const VSPEC_JSON = JSON.parse(
  readFileSync(new URL('../../../../hardware/cad/2bee_pnp/pnp_blinds_vspec.json', import.meta.url), 'utf8')
);
const VS = parseVspec(VSPEC_JSON);

const BOM_HEAD = 'Reference,Qty,Value,Package,Manufacturer,Mfr_PN,LCSC_PN,Note,DNP,Consigned';
const CPL_HEAD = 'Ref,Val,Package,PosX,PosY,Rot,Side';
const bomRow = (refs: string[], value: string, pkg: string, pn: string, dnp = '', cons = '') =>
  `"${refs.join(',')}",${refs.length},${value},${pkg},M,${pn},,,${dnp},${cons}`;
const cplRows = (refs: string[], value: string, pkg: string) =>
  refs.map((r, i) => `${r},${value},${pkg},${i},0,0,top`);
const R100K = Array.from({ length: 9 }, (_, i) => `R${i + 1}`);

function job(
  lines: [string[], string, string, string, string?, string?][],
  trays: TrayDef[],
  boards = 1,
  cplOnly?: string[],
  overrides?: Overrides,
  assembly?: AssemblyMap
) {
  const bomCsv = [BOM_HEAD, ...lines.map((l) => bomRow(l[0], l[1], l[2], l[3], l[4], l[5]))].join('\n');
  const cpl = cplOnly ?? lines.filter((l) => !l[4] && !l[5]).flatMap((l) => cplRows(l[0], l[1], l[2]));
  return preflight({ bomCsv, cplCsv: [CPL_HEAD, ...cpl].join('\n'), trays, boards, overrides, vspec: VS, assembly });
}
const has = (r: ReturnType<typeof preflight>, rule: string, text: string) =>
  r.refusals.some((p) => p.rule === rule && p.message.includes(text));

test('vspec: every variant the fit table names exists in cad’s JSON (pnp 09-21-29)', () => {
  for (const [pkg, vs] of Object.entries(FIT))
    for (const v of vs) assert.ok(v in VS, `FIT sends ${pkg} to "${v}", which pnp_blinds_vspec.json does not have`);
});

test('vspec: the override formula reproduces every JSON row — margin cannot drift unseen', () => {
  for (const [v, s] of Object.entries(VS))
    assert.equal(
      Math.floor((s.tapeLengthMm - SPROCKET_MARGIN_MM) / s.pocketPitchMm),
      s.pocketsPerLane,
      `${v}: formula disagrees with the scad's count`
    );
  // 22 again since cad a1b1e86b7d (2026-10-15 16:18, founder via pnp 16-16-03: 8 mm tape_length
  // 64 -> 92), reversing 6a257e8b48 (92 -> 64, 15 pockets) the same day. Pinned on purpose: a
  // capacity change in cad's file must show up here as a red that somebody reads.
  assert.equal(laneCapacity(VS, '8paper'), 22);
  assert.equal(laneCapacity(VS, '0402'), 44);
  assert.equal(laneCapacity(VS, 'coupon0402'), 18);
});

test('vspec: a malformed file is refused by name, never read as empty', () => {
  assert.throws(() => parseVspec({}), /no "variants"/);
  assert.throws(() => parseVspec({ variants: [{ variant: 'x', lanes: 2 }] }), /x: tape_length_mm/);
  assert.throws(() => parseVspec({ variants: [VSPEC_JSON.variants[0], VSPEC_JSON.variants[0]] }), /listed twice/);
});

test('pnp example, on the real tray spec: a 0402 part forced onto the coupon spills, then is short by name', () => {
  // 9 refs x 5 boards = 45; the coupon holds 2 lanes x 18 = 36.
  const r = job([[R100K, '100k', 'R0402', '0402WGF1003TCE']], [{ trayId: 'T01', variant: 'coupon0402' }], 5, undefined, {
    '0402WGF1003TCE': { variant: 'coupon0402', pocketPitchMm: 2 },
  });
  assert.equal(r.exit, 1);
  assert.ok(
    has(r, '2', 'need 45, 2 lane(s) free hold 36 (tray T01 lane 1, tray T01 lane 2) — short 9'),
    JSON.stringify(r.refusals)
  );
});

test('overflow (pnp 09-27-11): need beyond one lane takes a second lane, and the split is warned', () => {
  const Q = ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7', 'Q8'];
  const r = job([[Q, 'P-FET', 'SOT-23-3', 'Si2301CDS']], [{ trayId: 'E', variant: '8emb' }], 3);
  assert.equal(r.exit, 0, JSON.stringify(r.refusals));
  assert.deepEqual(
    r.lanes.map((l) => [l.lane, l.need, l.capacity]),
    [
      [1, 22, 22],
      [2, 2, 22],
    ]
  );
  assert.ok(r.warnings.some((w) => w.includes('split over 2 lanes: 22 + 2')));
  assert.deepEqual(r.lanesNeeded, { '8emb': { lanes: 2, trays: 1 } });
});

test('lanesNeeded counts what the job needs even when the trays on hand do not have it', () => {
  const r = job([[['U1'], 'INA219', 'SOIC-8', 'INA']], [], 1);
  assert.ok(has(r, '1', 'no free lane in a 12 tray'));
  assert.deepEqual(r.lanesNeeded, { '12': { lanes: 1, trays: 1 } });
});

test('clean job: exit 0, every part in a lane', () => {
  const r = job(
    [
      [['R1', 'R2'], '10k', 'R0402', 'PN-R10K'],
      [['C1'], '100nF', 'C0603', 'PN-C100N'],
      [['C2'], '1uF', 'C0805', 'PN-C1U'],
      [['Q1'], '2N7002', 'SOT-23-3', 'PN-Q'],
    ],
    [
      { trayId: 'A', variant: '0402' },
      { trayId: 'B', variant: '8paper' },
      { trayId: 'C', variant: '8emb' },
    ],
    2
  );
  assert.equal(r.exit, 0, JSON.stringify(r.refusals));
  assert.equal(r.lanes.length, 4);
  assert.deepEqual(r.counts, { bomRows: 4, cplRows: 5, skippedDnp: 0, skippedConsigned: 0, skippedAssembly: 0, assembly: { '(blank)': 4 }, placedLines: 4, placedParts: 5 });
  assert.equal(r.lanes.find((l) => l.mfrPn === 'PN-R10K')!.need, 4);
  assert.deepEqual(r.traysUsed, ['A', 'B', 'C']);
});

test('1: a placed BOM line with no free lane is refused by Reference', () => {
  const lines: [string[], string, string, string][] = Array.from({ length: 13 }, (_, i) => [
    [`C${i}`],
    `${i}nF`,
    i % 2 ? 'C0603' : 'C0805',
    `PN${i}`,
  ]);
  const r = job(lines, [{ trayId: 'B', variant: '8paper' }]); // 12 lanes, 13 lines
  assert.ok(has(r, '1', 'C12'), JSON.stringify(r.refusals));
});

test('2: when every fitting lane is used and the part still is not covered, refuse with the shortfall', () => {
  // 100 SOIC-8 against one 12 mm tray: 8 lanes x 11 = 88.
  const r = job([[['U1'], 'INA219', 'SOIC-8', 'INA']], [{ trayId: 'S', variant: '12' }], 100);
  assert.ok(has(r, '2', 'need 100, 8 lane(s) free hold 88'), JSON.stringify(r.refusals));
  assert.ok(has(r, '2', '— short 12'));
});

test('3: a package with no tape that fits is refused by name, never guessed', () => {
  const r = job([[['J1'], 'Terminal', 'Screw terminal 2p', 'KF']], [{ trayId: 'B', variant: '8paper' }]);
  assert.ok(has(r, '3', 'J1 (Screw terminal 2p, KF)'));
  assert.equal(r.lanes.length, 0);
});

test('3: a 0805 never lands in a 0402 lane even when that is the only free lane', () => {
  const r = job([[['C1'], '1uF', 'C0805', 'PN']], [{ trayId: 'T', variant: '0402' }]);
  assert.ok(has(r, '1', 'C1 (1uF, C0805)'), JSON.stringify(r.refusals));
  assert.equal(r.lanes.length, 0);
});

test('4: duplicate trayId', () => {
  const r = job([[['R1'], '1k', 'R0402', 'P']], [
    { trayId: 'T1', variant: '0402' },
    { trayId: 'T1', variant: '0402' },
  ]);
  assert.ok(has(r, '4', 'duplicate trayId T1'));
});

test('4: one Value+Package under two Mfr_PN is refused; same Value in two packages is not', () => {
  const r = job(
    [
      [['C1'], '100nF', 'C0603', 'PN-A'],
      [['C2'], '100nF', 'C0603', 'PN-B'],
      [['C3'], '100nF', 'C0805', 'PN-C'],
    ],
    [{ trayId: 'B', variant: '8paper' }]
  );
  assert.ok(has(r, '4', 'Value 100nF (C0603) maps to 2 Mfr_PN'));
  assert.ok(!has(r, '4', 'C0805'));
});

test('5: CPL Ref absent from the BOM, and BOM Reference absent from the CPL', () => {
  const r = job([[['R1', 'R2'], '1k', 'R0402', 'P']], [{ trayId: 'T', variant: '0402' }], 1, [
    ...cplRows(['R1'], '1k', 'R0402'),
    ...cplRows(['R9'], '1k', 'R0402'),
  ]);
  assert.ok(has(r, '5', 'CPL Ref R9 is not in the BOM'));
  assert.ok(has(r, '5', 'BOM Reference R2 has no CPL row'));
});

test('6: DNP and Consigned are counted as skipped, not placed', () => {
  const r = job(
    [
      [['R1'], '1k', 'R0402', 'P'],
      [['U1'], 'ESP32', 'ESP32-S3-WROOM-1U', 'E', '', 'yes'],
      [['R2'], '0R', 'R0402', 'Z', 'DNP'],
    ],
    [{ trayId: 'T', variant: '0402' }]
  );
  assert.equal(r.exit, 0, JSON.stringify(r.refusals));
  assert.equal(r.counts.skippedDnp, 1);
  assert.equal(r.counts.skippedConsigned, 1);
  assert.equal(r.counts.placedLines, 1);
});

test('6: zero rows read is exit 2 — could not run, never a pass', () => {
  const r = preflight({ bomCsv: BOM_HEAD + '\n', cplCsv: CPL_HEAD + '\n', trays: [], boards: 1, vspec: VS });
  assert.equal(r.exit, 2);
  assert.ok(has(r, '6', 'BOM: 0 rows read'));
});

test('6: a file in the wrong format is exit 2, not an empty pass', () => {
  const r = preflight({ bomCsv: 'a,b\n1,2', cplCsv: CPL_HEAD + '\nR1,1k,R0402,0,0,0,top', trays: [], boards: 1, vspec: VS });
  assert.equal(r.exit, 2);
  assert.ok(has(r, '6', 'BOM: missing column(s) Reference'));
});

test('warn: same package, different value is marked undetectable, and NOT refused', () => {
  const r = job(
    [
      [['R1'], '10k', 'R0402', 'P1'],
      [['R2'], '100k', 'R0402', 'P2'],
    ],
    [
      { trayId: 'T1', variant: '0402' },
      { trayId: 'T2', variant: '0402' },
    ]
  );
  assert.equal(r.exit, 0, JSON.stringify(r.refusals));
  assert.ok(r.lanes.every((l) => l.swapUndetectable));
  assert.ok(r.warnings.some((w) => w.includes('R0402: 2 values') && w.includes('swap undetectable by camera')));
});

test('ruling 1: two of one package side by side is FINE — no refusal, no spacer lane', () => {
  const r = job(
    [
      [['R1'], '1k', 'R0402', 'P1'],
      [['R2'], '2k', 'R0402', 'P2'],
    ],
    [{ trayId: 'T', variant: '0402' }]
  );
  assert.equal(r.exit, 0, JSON.stringify(r.refusals));
  assert.deepEqual(r.lanes.map((l) => l.lane), [1, 2]);
  assert.ok(r.warnings.some((w) => w.includes('swap undetectable by camera')));
});

test('ruling 3: one Mfr_PN on two BOM lines is ONE lane with the counts summed', () => {
  const r = job(
    [
      [['Q1', 'Q2', 'Q3', 'Q4'], 'P-FET-LOGIC', 'SOT-23-3', 'Si2301CDS'],
      [['Q5', 'Q6', 'Q7', 'Q8'], 'P-FET-SIG', 'SOT-23-3', 'Si2301CDS'],
    ],
    [{ trayId: 'E', variant: '8emb' }],
    // 1 board: a single lane must hold the summed need (8) whatever cad's lane capacity is (15 at
    // 6a257e8b48, 22 since a1b1e86b7d); a split would test the overflow path, not the summing.
    1
  );
  assert.equal(r.exit, 0, JSON.stringify(r.refusals));
  assert.equal(r.lanes.length, 1);
  assert.equal(r.lanes[0].need, 8);
  assert.equal(r.lanes[0].value, 'P-FET-LOGIC / P-FET-SIG');
  assert.ok(!r.warnings.some((w) => w.includes('swap undetectable')), 'one part number cannot be swapped with itself');
});

test('ruling 3: one Mfr_PN under two packages is refused', () => {
  const r = job(
    [
      [['C1'], '1uF', 'C0603', 'PN'],
      [['C2'], '1uF', 'C0805', 'PN'],
    ],
    [{ trayId: 'B', variant: '8paper' }]
  );
  assert.ok(has(r, 'extra', 'Mfr_PN PN is listed as C0603 and as C0805'));
});

test('ruling 2: a package with no default tape is refused until a Mfr_PN override names one', () => {
  const lines: [string[], string, string, string][] = [[['R1', 'R2'], '10mR', 'R2512', 'RLP25']];
  const trays: TrayDef[] = [{ trayId: 'S', variant: '12' }];
  assert.ok(has(job(lines, trays), '3', 'R1,R2 (R2512, RLP25)'));
  const r = job(lines, trays, 3, undefined, { RLP25: { variant: '12', pocketPitchMm: 4 } });
  assert.equal(r.exit, 0, JSON.stringify(r.refusals));
  assert.equal(r.lanes[0].tape, 'override');
  assert.equal(r.lanes[0].capacity, 22, 'capacity must use the override pitch ((92-4)/4), not the variant’s ((92-4)/8)');
});

test('ruling 2: an override moves a part to the tape it really comes on', () => {
  const r = job([[['C1'], '22uF', 'C0805', 'TALL']], [
    { trayId: 'P', variant: '8paper' },
    { trayId: 'E', variant: '8emb' },
  ], 1, undefined, { TALL: { variant: '8emb', pocketPitchMm: 4 } });
  assert.equal(r.lanes[0].trayId, 'E');
});

test('ruling 2: 0805 without an override is placed but WARNED — its tape depends on height', () => {
  const r = job([[['C1'], '22uF', 'C0805', 'TALL']], [{ trayId: 'P', variant: '8paper' }]);
  assert.equal(r.exit, 0);
  assert.equal(r.lanes[0].tape, 'default-ambiguous');
  assert.ok(r.warnings.some((w) => w.includes('TALL') && w.includes('confirm the reel')));
});

test('6: a malformed override is could-not-run, not ignored', () => {
  const r = job([[['R1'], '1k', 'R0402', 'P']], [{ trayId: 'T', variant: '0402' }], 1, undefined, {
    P: { variant: 'nope' as never, pocketPitchMm: 2 },
  });
  assert.equal(r.exit, 2);
  assert.ok(has(r, '6', 'override P'));
});

test('bottom side: a CPL row not on top is refused by Ref, never silently placed', () => {
  const r = job([[['R1'], '1k', 'R0402', 'P']], [{ trayId: 'T', variant: '0402' }], 1, [
    'R1,1k,R0402,0,0,0,bottom',
  ]);
  assert.ok(has(r, 'extra', 'CPL Ref R1 is on side "bottom"'));
});

test('csv: quoted Reference lists with commas parse as one field', () => {
  const rows = parseCsv('"Reference","Qty"\n"R1,R2,R3","3"\r\n');
  assert.deepEqual(rows, [{ Reference: 'R1,R2,R3', Qty: '3' }]);
});

test('Assembly column: JLCPCB / HAND / NOT-PLACED skipped and counted; INHOUSE and blank placed', () => {
  const bomCsv = [
    BOM_HEAD + ',Assembly',
    bomRow(['R1'], '1k', 'R0402', 'P') + ',INHOUSE',
    bomRow(['R2'], '2k', 'R0402', 'P2') + ',',
    bomRow(['F1'], 'PPTC', 'Fuse 1812', 'F') + ',JLCPCB',
    bomRow(['J1'], 'Terminal', 'Screw terminal 2p', 'KF') + ',HAND',
    bomRow(['X1'], 'x', 'Weird', 'X') + ',NOT-PLACED',
    bomRow(['J2'], 'Hdr', 'Pin header 6p r1', 'H') + ',THT-HAND',
  ].join('\n');
  const r = preflight({
    bomCsv,
    cplCsv: [CPL_HEAD, ...cplRows(['R1'], '1k', 'R0402'), ...cplRows(['R2'], '2k', 'R0402')].join('\n'),
    trays: [{ trayId: 'T', variant: '0402' }],
    boards: 1,
    vspec: VS,
  });
  assert.equal(r.exit, 0, JSON.stringify(r.refusals));
  assert.equal(r.counts.skippedAssembly, 4);
  assert.equal(r.counts.placedLines, 2);
  assert.deepEqual(r.counts.assembly, { INHOUSE: 1, '(blank)': 1, JLCPCB: 1, HAND: 1, 'NOT-PLACED': 1, 'THT-HAND': 1 });
});

test('Assembly: an unknown tier is refused by name, never read as ours or as skipped', () => {
  const bomCsv = [BOM_HEAD + ',Assembly', bomRow(['J1'], 'T', 'Screw terminal 2p', 'KF') + ',THT-SOMETHING'].join('\n');
  const r = preflight({ bomCsv, cplCsv: CPL_HEAD + '\nZ9,0,R0402,0,0,0,top', trays: [], boards: 1, vspec: VS });
  assert.ok(has(r, 'extra', 'Assembly "THT-SOMETHING" is a tier this tool does not know'), JSON.stringify(r.refusals));
});

test('Assembly from the sidecar joins on Mfr_PN when the BOM has no column', () => {
  const sc = assemblyFromSidecar(
    'Value,Package,Manufacturer,Mfr_PN,LCSC,Note,DNP,Assembly\nPPTC,Fuse 1812,B,F,C1,,,JLCPCB\n1k,R0402,U,P,C2,,,INHOUSE\n'
  );
  assert.deepEqual(sc, { map: { F: 'JLCPCB', P: 'INHOUSE' }, problems: [] });
  const r = job(
    [
      [['R1'], '1k', 'R0402', 'P'],
      [['F1'], 'PPTC', 'Fuse 1812', 'F'],
    ],
    [{ trayId: 'T', variant: '0402' }],
    1,
    cplRows(['R1'], '1k', 'R0402'),
    undefined,
    sc.map
  );
  assert.equal(r.exit, 0, JSON.stringify(r.refusals));
  assert.equal(r.counts.skippedAssembly, 1);
});

test('Assembly sidecar: a BOM part missing from the sidecar is refused, never placed as blank', () => {
  const r = job(
    [
      [['R1'], '1k', 'R0402', 'P'],
      [['R2'], '2k', 'R0402', 'P-NEW'],
    ],
    [{ trayId: 'T', variant: '0402' }],
    1,
    undefined,
    undefined,
    { P: 'INHOUSE' }
  );
  assert.ok(has(r, 'extra', 'Mfr_PN P-NEW is not in the sidecar'), JSON.stringify(r.refusals));
  assert.equal(r.counts.assembly['(not in sidecar)'], 1);
});

test('Assembly sidecar: one Mfr_PN with two tiers is a problem, not a pick; no column is a problem', () => {
  assert.ok(assemblyFromSidecar('Mfr_PN,Assembly\nKF,INHOUSE\nKF,JLCPCB\n').problems.some((p) => p.includes('KF has Assembly INHOUSE and JLCPCB')));
  assert.ok(assemblyFromSidecar('Mfr_PN,PlacedBy\nKF,tht\n').problems.some((p) => p.includes('no Assembly')));
});

test('bundled tape overrides: every entry names a variant cad’s JSON has, and parses', () => {
  const o = parseOverrides(JSON.parse(readFileSync(new URL('../src/pnp/tape-overrides.json', import.meta.url), 'utf8')));
  assert.ok(Object.keys(o).length >= 3);
  for (const [pn, e] of Object.entries(o)) {
    assert.ok(e.variant in VS, `${pn}: variant ${e.variant} not in pnp_blinds_vspec.json`);
    assert.ok(e.pocketPitchMm > 0 && typeof e.source === 'string', `${pn}: needs a pitch and a source`);
  }
});

test('an override marked unverified says tape unverified on every run', () => {
  const r = job([[['R1'], '10mR', 'R2512', 'RLP']], [{ trayId: 'S', variant: '12' }], 1, undefined, {
    RLP: { variant: '12', pocketPitchMm: 8, verified: false, source: 'pitch not stated' },
  });
  assert.equal(r.exit, 0);
  assert.ok(r.warnings.some((w) => w.includes('RLP (R2512): tape unverified — pitch not stated')));
});

// ── bughunt 2026-11-15 ─────────────────────────────────────────────────────
test('a placed line with no Mfr_PN is refused, never merged with another into one lane', () => {
  const bom = [BOM_HEAD, bomRow(['R1'], '10k', 'R0603', ''), bomRow(['R2'], '100k', 'R0603', '')].join('\n');
  const cpl = [CPL_HEAD, ...cplRows(['R1'], '10k', 'R0603'), ...cplRows(['R2'], '100k', 'R0603')].join('\n');
  const r = preflight({ bomCsv: bom, cplCsv: cpl, trays: [{ trayId: 'T1', variant: '8paper' }], boards: 1, vspec: VS });
  assert.equal(r.exit, 1);
  assert.ok(r.refusals.some((x) => /no Mfr_PN/.test(x.message)), JSON.stringify(r.refusals));
});

test('a part that overflows its lanes spills only into trays of the SAME tape variant', () => {
  const refs = Array.from({ length: 400 }, (_, i) => `C${i + 1}`);
  const bom = [BOM_HEAD, bomRow(refs, '100n', 'C0805', 'PNX')].join('\n');
  const cpl = [CPL_HEAD, ...cplRows(refs, '100n', 'C0805')].join('\n');
  const r = preflight({ bomCsv: bom, cplCsv: cpl, trays: [{ trayId: 'P', variant: '8paper' }, { trayId: 'E', variant: '8emb' }], boards: 1, vspec: VS });
  assert.equal(new Set(r.lanes.map((l) => l.variant)).size, 1, r.lanes.map((l) => l.variant).join(','));
});
