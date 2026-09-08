// Tests for "what material is this job being planned against?"
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT RUNS HERE, AND WHAT CANNOT
// ─────────────────────────────────────────────────────────────────────────────
//
// `npm run test:node`. No browser, no bundler, no React, no wasm.
//
// ✅ EXERCISED by the real module: the resolution of a stated material against
// the CORE's list, the refusal to substitute a near name, the four agreement
// states, the facet options and the facet match. Plus one assertion over the
// shipped sheet catalogue: every material it states is one the planner carries.
//
// 🔴 NOT EXERCISED, stated rather than implied:
//   · The core. `MATERIALS` below is a LITERAL second copy of
//     `core/src/tools.rs::Material::as_str`, on purpose: a test that imported
//     the app's own idea of the list would assert only that the module agrees
//     with itself. If the core renames a material, the catalogue assertion here
//     goes red — which is the point. At RUNTIME the list comes from the wasm
//     library and a mismatch is reported as UNKNOWN rather than coerced, so
//     drift is a visible refusal either way.
//   · Any feed number. Nothing here asserts a chipload, an rpm or a depth —
//     those are the core's and re-deriving one in TypeScript is the defect this
//     lane keeps writing down.
//   · That `App.tsx` renders the conflict. The wiring is not written by this
//     change; what is tested is the API it will call.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const jm = await import('../src/jobMaterial.ts');
const { SHEET_SIZES } = await import('../src/materials.ts');

/** `core/src/tools.rs::Material::as_str`, typed out rather than imported. */
const MATERIALS = ['Plywood', 'MDF', 'Hardwood', 'Softwood', 'Acrylic', 'Aluminium'];

/* ═══ Resolution — and the substitution that must not happen ════════════════ */

test('a stated material the planner carries resolves; one it does not is UNKNOWN, not the nearest', () => {
  assert.deepEqual(jm.resolveMaterial('Plywood', MATERIALS), { state: 'known', name: 'Plywood' });

  const v = jm.resolveMaterial('Ply', MATERIALS);
  assert.equal(v.state, 'unknown');
  // 🔴 The whole rule: "Ply" is one character away from "Plywood" and is NOT
  // resolved to it. A substituted material scales every feed in the program.
  assert.match(v.state === 'unknown' ? v.why : '', /NOT been matched to a similar one/);
  assert.match(v.state === 'unknown' ? v.why : '', /Plywood, MDF/);
});

test('an absent material is NOT STATED — a real answer, and not "plywood"', () => {
  for (const empty of [undefined, null, '', '   ']) {
    const v = jm.resolveMaterial(empty, MATERIALS);
    assert.equal(v.state, 'not-stated', `expected not-stated for ${JSON.stringify(empty)}`);
  }
  assert.match(jm.NOT_STATED_WHY, /left UNKNOWN rather than filled in/);
});

test('an empty library does not silently accept everything', () => {
  const v = jm.resolveMaterial('Plywood', []);
  assert.equal(v.state, 'unknown');
  assert.match(v.state === 'unknown' ? v.why : '', /the library has not loaded/);
});

/* ═══ Exactly one answer, and a conflict that is never resolved here ════════ */

test('choosing a workpiece answers an unset job material, and says where the answer came from', () => {
  const a = jm.checkMaterialAgreement('', { name: 'Bay 2 ply sheet', material: 'Plywood' }, MATERIALS);
  assert.equal(a.state, 'agreed');
  assert.equal(a.state === 'agreed' ? a.name : '', 'Plywood');
  assert.equal(a.state === 'agreed' ? a.from : '', 'the selected workpiece');
});

test('🔴 a stored material that differs from the job material is a CONFLICT, not a preference', () => {
  const a = jm.checkMaterialAgreement('Acrylic', { name: 'Bay 2 ply sheet', material: 'Plywood' }, MATERIALS);
  assert.equal(a.state, 'conflict');
  if (a.state !== 'conflict') return;
  // BOTH names are carried. A module that returned one of them would be
  // deciding which of the two numbers on screen is a lie.
  assert.equal(a.job, 'Acrylic');
  assert.equal(a.workpiece, 'Plywood');
  assert.equal(a.workpieceName, 'Bay 2 ply sheet');
  // And it states which one the program will actually carry, because that is
  // the fact the operator needs and the one the UI cannot infer.
  assert.match(a.why, /it is "Acrylic"/);
  assert.match(a.why, /nothing here will choose for you/);
});

test('an ad-hoc sheet — typed, not picked — is not a conflict', () => {
  const a = jm.checkMaterialAgreement('Plywood', null, MATERIALS);
  assert.equal(a.state, 'agreed');
  assert.equal(a.state === 'agreed' ? a.from : '', 'the job material control');
});

test('a workpiece that states nothing neither confirms nor contradicts', () => {
  const a = jm.checkMaterialAgreement('Plywood', { name: 'US 4 x 8 ft' }, MATERIALS);
  assert.equal(a.state, 'agreed');
  assert.match(a.state === 'agreed' ? (a.note ?? '') : '', /nothing contradicts.*and nothing confirms it either/);
});

test('no material anywhere is UNKNOWN — the job cannot be planned and the UI must say so', () => {
  const a = jm.checkMaterialAgreement('', { name: 'US 4 x 8 ft' }, MATERIALS);
  assert.equal(a.state, 'unknown');
  assert.match(a.state === 'unknown' ? a.why : '', /no material is set for this job/);

  const b = jm.checkMaterialAgreement('', null, MATERIALS);
  assert.equal(b.state, 'unknown');
});

test('a job material the planner does not carry blocks, rather than being compared', () => {
  const a = jm.checkMaterialAgreement('Unobtainium', { name: 'sheet', material: 'Plywood' }, MATERIALS);
  assert.equal(a.state, 'unknown');
  assert.match(a.state === 'unknown' ? a.why : '', /Unobtainium/);
});

test('a workpiece stating a material the planner lacks is REPORTED, and the job still wins', () => {
  const a = jm.checkMaterialAgreement('Plywood', { name: 'old sheet', material: 'Ply' }, MATERIALS);
  assert.equal(a.state, 'agreed');
  assert.equal(a.state === 'agreed' ? a.name : '', 'Plywood');
  assert.match(a.state === 'agreed' ? (a.note ?? '') : '', /could not be compared/);
});

/* ═══ The facet ════════════════════════════════════════════════════════════ */

test('the facet options come from the ROWS, carry counts, and always offer "not stated"', () => {
  const rows = [
    { material: 'Plywood' },
    { material: 'Plywood' },
    { material: 'MDF' },
    {},
    { material: 'Ply' }, // states something the planner does not carry
  ];
  const opts = jm.materialFacetOptions(rows, MATERIALS);
  assert.deepEqual(opts[0], { value: '', label: 'All materials', count: 5 });

  const byValue = Object.fromEntries(opts.map((o) => [o.value, o]));
  assert.equal(byValue['Plywood'].count, 2);
  assert.equal(byValue['MDF'].count, 1);
  // Aluminium is in the planner and in NO row, so it is not offered: a filter
  // that empties the list tells the operator nothing about why.
  assert.equal(byValue['Aluminium'], undefined);
  // A value the planner does not carry is offered LAST and is labelled odd.
  assert.match(byValue['Ply'].label, /not in this build's planner/);
  // 🔴 And the unstated rows are REACHABLE. Without this option, filtering to
  // Plywood would hide them with no way back — a hidden row and a non-existent
  // row are identical on screen.
  assert.equal(byValue[jm.FACET_NOT_STATED].count, 1);
});

test('"not stated" is not offered when every row states one', () => {
  const opts = jm.materialFacetOptions([{ material: 'MDF' }], MATERIALS);
  assert.equal(opts.find((o) => o.value === jm.FACET_NOT_STATED), undefined);
});

test('the facet match: "" passes everything, and the sentinel finds only the silent rows', () => {
  assert.equal(jm.facetMatches('Plywood', ''), true);
  assert.equal(jm.facetMatches(undefined, ''), true);
  assert.equal(jm.facetMatches('Plywood', 'Plywood'), true);
  assert.equal(jm.facetMatches('MDF', 'Plywood'), false);
  assert.equal(jm.facetMatches(undefined, jm.FACET_NOT_STATED), true);
  assert.equal(jm.facetMatches('  ', jm.FACET_NOT_STATED), true);
  assert.equal(jm.facetMatches('Plywood', jm.FACET_NOT_STATED), false);
});

/* ═══ The shipped sheet catalogue ═══════════════════════════════════════════ */

test('every material the shipped sheet catalogue states is one the planner carries', () => {
  const stated = SHEET_SIZES.map((s) => jm.materialOfSheet(s)).filter((m): m is string => m !== undefined);
  assert.ok(stated.length > 0, 'the catalogue states some materials');
  for (const m of stated) {
    assert.ok(MATERIALS.includes(m), `the sheet catalogue states "${m}", which core/src/tools.rs does not carry`);
  }
});

test('the material-agnostic panel sizes state NOTHING, and are not filled in with a plausible one', () => {
  // A US 4x8 is sold in ply, MDF, acrylic and aluminium alike. Guessing here
  // would make the picker say confidently what the sheet does not say at all.
  for (const id of ['sheet-us-4x8', 'sheet-eu-2440x1220', 'sheet-eu-3050x1220', 'sheet-eu-2500x1250']) {
    const s = SHEET_SIZES.find((x) => x.id === id);
    assert.ok(s, `${id} is in the catalogue`);
    assert.equal(jm.materialOfSheet(s!), undefined, `${id} must not state a material`);
  }
  // and the ones that DO name a material in their own name carry it as data
  assert.equal(SHEET_SIZES.find((s) => s.id === 'mdf-au-2400x1200')!.material, 'MDF');
  assert.equal(SHEET_SIZES.find((s) => s.id === 'ply-baltic-1525x1525')!.material, 'Plywood');
  assert.equal(SHEET_SIZES.find((s) => s.id === 'alu-au-3000x1500')!.material, 'Aluminium');
});
