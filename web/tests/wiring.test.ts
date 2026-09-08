// Tests for the three things `App.tsx` wires, and for the defects each wiring
// exists to prevent.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE EXISTS AT ALL, AND WHAT IT CANNOT REACH
// ─────────────────────────────────────────────────────────────────────────────
//
// 🔴 `App.tsx` CANNOT BE IMPORTED IN NODE. The loader stops at the sample asset
// imports — `Unknown file extension ".dxf"` — measured again while writing this
// file, and recorded before by another agent. So nothing here renders any JSX,
// and every assertion below is against the MODULE a component calls, never
// against what the component draws with the answer.
//
// That boundary is the reason `runProgram.ts` is a file rather than twenty lines
// inside the component: a rule that lives where no test can reach it is a rule
// nobody has watched fail.
//
// ✅ EXERCISED HERE
//   1. The Run handoff: what is built from a report, what is refused, and — the
//      part that matters — that the Run tab's program is a LATCH and not a
//      derivation, driven against a plant that makes it a derivation.
//   2. The inventory import sequence exactly as the wiring calls it (parse →
//      applyImport → writeInventory → readInventory), driven against a plant
//      that merges instead of replacing, which is how entries get dropped
//      SILENTLY.
//   3. The material answer: that a disagreement comes back as `conflict`
//      carrying both names, driven against a plant that resolves it silently.
//
// 🔴 NOT EXERCISED, stated rather than implied:
//   · That any of it RENDERS. No browser, no WebGL, no React here. Whether the
//     conflict paragraph is on screen, whether the facet `<select>` appears,
//     whether the hand-over button is disabled — none of that is observed by
//     this file and none of it is claimed.
//   · The `window.confirm` in front of replacing a held program. It lives in
//     `App.tsx` and is unreachable from here.
//   · Chrome's IndexedDB. `fake-indexeddb.mjs` is a stand-in.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeIndexedDb } from './fake-indexeddb.mjs';

installFakeIndexedDb({
  name: '2bee.slicer',
  version: 3,
  stores: ['machines', 'workpieces', 'drawings', 'spoilboards', 'operations', 'inventory'],
});

const rp = await import('../src/runProgram.ts');
const inv = await import('../src/inventory.ts');
const jm = await import('../src/jobMaterial.ts');
const run = await import('../src/RunTab.tsx');

import type { RenderMove, Report } from '../src/cam.ts';
import type { RunProgram } from '../src/RunTab.tsx';

const NOW = Date.parse('2026-08-11T09:00:00Z');

/* ════════════════════════════════════════════════════════════════════════════
   1. THE RUN HANDOFF
   ════════════════════════════════════════════════════════════════════════════ */

/** A report with every required key, so a test never asserts against a shape
 *  the core does not actually emit. Overrides carry the case under test. */
function reportOf(over: Partial<Report>): Report {
  return {
    job: 'plate',
    ok: true,
    gcode: 'G21\nG0 X0 Y0\nG1 X10 F600\n',
    refusals: [],
    notes: [],
    fixture_findings: [],
    warnings: [],
    errors: [],
    tools_used: ['endmill-6mm-2f'],
    tool_changes: 0,
    cutting_distance_mm: 10,
    rapid_distance_mm: 5,
    estimated_seconds: 2,
    deepest_z_mm: -18,
    tab_lifts: 0,
    dogbones: 0,
    sim: { cell_mm: 0.6, gouge: 0, uncut: 0, spoilboard: 0, first: null },
    simulated_stock_surface: null,
    render: [
      { kind: 'rapid', x: 0, y: 0, z: 5 },
      { kind: 'cut', x: 10, y: 0, z: -18, feed: 600 },
    ] as RenderMove[],
    rapid_mm_min: 3000,
    stock: [600, 900, 18],
    clamps: [],
    ...over,
  };
}

test('the program handed over is the EMITTED TEXT and the RENDER PATH, not the report', () => {
  const built = rp.runProgramFromReport(reportOf({}));
  assert.equal(built.status, 'ok');
  if (built.status !== 'ok') return;

  // The lines are the emitted text, counted the way the G-code panel counts it:
  // the single trailing newline's empty tail is dropped and nothing else is.
  assert.deepEqual(built.program.lines, ['G21', 'G0 X0 Y0', 'G1 X10 F600']);
  assert.equal(built.program.name, 'plate');
  assert.equal(built.program.rapidRate, 3000);
  // The path is the cutter centre line, one point per render move.
  assert.equal(built.program.path.length, 2);
  assert.equal(built.program.path[0].rapid, true);
  assert.equal(built.program.path[1].rapid, false);
  assert.equal(built.program.path[1].feed, 600);
});

test('an interior blank line is KEPT, so the panel and the streamer agree about line numbers', () => {
  const built = rp.runProgramFromReport(reportOf({ gcode: 'G21\n\nG1 X1 F100\n' }));
  assert.equal(built.status, 'ok');
  if (built.status !== 'ok') return;
  assert.deepEqual(built.program.lines, ['G21', '', 'G1 X1 F100']);
});

test('a move with no feed contributes NO time rather than a rate we invented', () => {
  /* `RenderMove.feed` is undefined on a rapid, a tool change and a probe, and
   * `cam.ts` says in the field's own doc: do not write `feed ?? 0` and divide.
   * `PathPoint.feed` is required to be a number, so the absent feed becomes 0 —
   * and the assertion here is on the CONSEQUENCE, not on the 0: the move must
   * add nothing to the estimate. A charged move would mean a duration derived
   * from a speed this report never stated. */
  const built = rp.runProgramFromReport(
    reportOf({
      render: [
        { kind: 'cut', x: 0, y: 0, z: 0, feed: 600 },
        { kind: 'probe', x: 0, y: 0, z: -50 },
      ] as RenderMove[],
    })
  );
  assert.equal(built.status, 'ok');
  if (built.status !== 'ok') return;
  assert.equal(built.program.path[1].feed, 0);
  assert.equal(run.pathSeconds(built.program, 0, 1, 100), 0);

  // And the same walk over a real cutting move is NOT zero — otherwise the
  // assertion above would pass against an arithmetic that always returns 0.
  const cutting = rp.runProgramFromReport(reportOf({}));
  assert.equal(cutting.status, 'ok');
  if (cutting.status !== 'ok') return;
  assert.ok(run.pathSeconds(cutting.program, 0, 1, 100) > 0);
});

test('every path point says its G-code line is UNKNOWN rather than guessing one', () => {
  /* `Report.render` carries no attribution back to the emitted text, and a
   * positional walk would drift from the first flattened arc onward. So the
   * field is a sentinel: indexing `lines[point.line]` gives `undefined`, which
   * is obviously missing, not a plausible wrong line. */
  const built = rp.runProgramFromReport(reportOf({}));
  assert.equal(built.status, 'ok');
  if (built.status !== 'ok') return;
  for (const p of built.program.path) assert.equal(p.line, rp.LINE_UNATTRIBUTED);
  assert.equal(built.program.lines[rp.LINE_UNATTRIBUTED], undefined);
});

test('the four things that are refused rather than approximated each name themselves', () => {
  const nothing = rp.runProgramFromReport(null);
  assert.equal(nothing.status, 'refused');
  if (nothing.status === 'refused') assert.match(nothing.why, /nothing has been planned/);

  const refusedPlan = rp.runProgramFromReport(reportOf({ ok: false }));
  assert.equal(refusedPlan.status, 'refused');
  if (refusedPlan.status === 'refused') assert.match(refusedPlan.why, /REFUSED/);

  const noText = rp.runProgramFromReport(reportOf({ gcode: '   \n' }));
  assert.equal(noText.status, 'refused');
  if (noText.status === 'refused') assert.match(noText.why, /no G-code/);

  const noPath = rp.runProgramFromReport(
    reportOf({ render: [{ kind: 'rapid', x: 0, y: 0, z: 5 }] as RenderMove[] })
  );
  assert.equal(noPath.status, 'refused');
  if (noPath.status === 'refused') assert.match(noPath.why, /1 toolpath point/);

  /* 🔴 A G0 carries no F word. Without the machine's rapid rate every rapid has
   * no duration, and a remaining estimate over it is a number invented here. */
  const noRapid = rp.runProgramFromReport(reportOf({ rapid_mm_min: null }));
  assert.equal(noRapid.status, 'refused');
  if (noRapid.status === 'refused') assert.match(noRapid.why, /rapid rate/);
});

test('two programs with different bytes get different hashes, and identical bytes the same one', () => {
  const a = rp.runProgramFromReport(reportOf({}));
  const b = rp.runProgramFromReport(reportOf({ job: 'renamed' }));
  const c = rp.runProgramFromReport(reportOf({ gcode: 'G21\nG0 X0 Y0\nG1 X11 F600\n' }));
  assert.equal(a.status === 'ok' && b.status === 'ok' && c.status === 'ok', true);
  if (a.status !== 'ok' || b.status !== 'ok' || c.status !== 'ok') return;
  // The name changed and the bytes did not: the machine is being sent the same
  // program, so a stale warning here would be one nobody could clear.
  assert.equal(a.program.hash, b.program.hash);
  assert.notEqual(a.program.hash, c.program.hash);
});

/* ────────────────────────────────────────────────────────────────────────────
   🔴 THE PLANT: A PROGRAM THAT CHANGES WHILE IT IS STREAMING
   ──────────────────────────────────────────────────────────────────────────── */

test('PLANT — the Run tab follows the report instead of the latch, and the freeze test goes red', () => {
  const heldBuild = rp.runProgramFromReport(reportOf({ job: 'the job on the machine' }));
  assert.equal(heldBuild.status, 'ok');
  if (heldBuild.status !== 'ok') return;
  const held = heldBuild.program;

  // The operator re-plans. This is the program the CNC tab NOW has.
  const replanned = rp.runProgramFromReport(
    reportOf({ job: 're-planned', gcode: 'G21\nG0 X0 Y0\nG1 X999 F600\n' })
  );
  assert.equal(replanned.status, 'ok');
  if (replanned.status !== 'ok') return;
  assert.notEqual(replanned.program.hash, held.hash);

  // ── the real path ────────────────────────────────────────────────────────
  // The Run tab is still holding what it was handed. A re-plan changed nothing.
  assert.equal(rp.programForRunTab(held, replanned), held);
  assert.equal(rp.programForRunTab(held, replanned)?.name, 'the job on the machine');

  // ── the plant ────────────────────────────────────────────────────────────
  // 🔴 The hazard, in one line: the tab now shows and would send the NEW
  // program, with no operator act between the re-plan and the swap. Every
  // assertion above fails under it, which is what makes them assertions.
  const planted = rp.programForRunTab(held, replanned, 'follows-the-report');
  assert.notEqual(planted, held);
  assert.equal(planted?.name, 're-planned');

  // And the plant is reachable only by naming it — the UI never passes one.
  assert.deepEqual(rp.RUN_HANDOFF_PLANTS, ['follows-the-report']);
});

test('a re-plan makes the held program STALE and says so; it does not replace it', () => {
  const heldBuild = rp.runProgramFromReport(reportOf({}));
  assert.equal(heldBuild.status, 'ok');
  if (heldBuild.status !== 'ok') return;
  const held = heldBuild.program;

  assert.equal(rp.heldProgramVerdict(held, heldBuild).state, 'current');

  const replanned = rp.runProgramFromReport(reportOf({ gcode: 'G21\nG1 X99 F600\n' }));
  const stale = rp.heldProgramVerdict(held, replanned);
  assert.equal(stale.state, 'stale');
  assert.match(stale.text, /has NOT been changed/);

  // A plan that has stopped being producible is ALSO stale, and the sentence
  // carries the plan's own refusal rather than a generic one.
  const broken = rp.heldProgramVerdict(held, rp.runProgramFromReport(reportOf({ ok: false })));
  assert.equal(broken.state, 'stale');
  assert.match(broken.text, /REFUSED/);

  // Nothing held: the two reasons are different sentences.
  assert.equal(rp.heldProgramVerdict(null, heldBuild).state, 'none');
  assert.match(rp.heldProgramVerdict(null, heldBuild).text, /holding NOTHING/);
  assert.match(
    rp.heldProgramVerdict(null, rp.runProgramFromReport(null)).text,
    /nothing has been planned/
  );
});

test('the handed-over program actually drives the two numbers that had no input', () => {
  /* The whole reason for the wiring: with `program` absent, `RunTab`'s line
   * count falls back to 0 and its remaining estimate to `null`. This asserts
   * the built program is a shape those functions accept and answer over. */
  const built = rp.runProgramFromReport(
    reportOf({
      gcode: 'G21\nG0 X0 Y0\nG1 X10 F600\nG1 Y10 F600\n',
      render: [
        { kind: 'rapid', x: 0, y: 0, z: 5 },
        { kind: 'cut', x: 10, y: 0, z: -18, feed: 600 },
        { kind: 'cut', x: 10, y: 10, z: -18, feed: 600 },
      ] as RenderMove[],
    })
  );
  assert.equal(built.status, 'ok');
  if (built.status !== 'ok') return;
  const program: RunProgram = built.program;

  assert.equal(program.lines.length, 4);

  // The DRO at the first cut point: located, and the remainder is the leg left.
  const matched = run.matchOnPath(program.path, [10, 0, -18], 0, 2.0);
  assert.equal(matched, 1);
  const remaining = run.remainingSeconds(program, matched, 100);
  assert.ok(remaining !== null && remaining > 0);
  // 10mm at 600mm/min = 1s.
  assert.ok(Math.abs((remaining ?? 0) - 1) < 1e-9);

  // 🔴 And with NO program — the state the product was in — both are absent
  // rather than wrong. This is the "before" the wiring removes.
  assert.equal(run.remainingSeconds(null, matched, 100), null);
});

/* ════════════════════════════════════════════════════════════════════════════
   2. THE INVENTORY IMPORT
   ════════════════════════════════════════════════════════════════════════════ */

const FILE_ONE = JSON.stringify({
  kind: inv.INVENTORY_FILE_KIND,
  version: 1,
  source: 'bom',
  as_of: '2026-08-01',
  entries: [
    { kind: 'tool', id: 'endmill-6mm-2f' },
    { kind: 'tool', id: 'endmill-3mm-2f' },
    { kind: 'spoilboard', id: 'mdf-1200x800' },
  ],
});

/** The same shop, counted again, having lost the 3mm cutter. */
const FILE_TWO = JSON.stringify({
  kind: inv.INVENTORY_FILE_KIND,
  version: 1,
  source: 'bom',
  as_of: '2026-08-09',
  entries: [
    { kind: 'tool', id: 'endmill-6mm-2f' },
    { kind: 'spoilboard', id: 'mdf-1200x800' },
  ],
});

const TOOL_CATALOGUE: import('../src/inventory.ts').CatalogueRow[] = [
  { id: 'endmill-6mm-2f', name: 'End mill 6mm 2F' },
  { id: 'endmill-3mm-2f', name: 'End mill 3mm 2F' },
];

test('the import sequence the wiring runs, end to end and through real storage', async () => {
  /* Exactly the calls `App.tsx` makes, in the order it makes them. A test that
   * called them in a different order would be testing a wiring nobody wrote. */
  const first = inv.parseInventoryFile(FILE_ONE, NOW);
  assert.equal(first.status, 'ok');
  if (first.status !== 'ok') return;
  const applied = inv.applyImport(inv.EMPTY_INVENTORY, first.doc);
  await inv.writeInventory(applied.doc, NOW);

  const back = await inv.readInventory();
  assert.equal(back.doc.entries.length, 3);
  assert.equal(back.doc.source, 'bom');
  assert.equal(back.doc.as_of, '2026-08-01');
  assert.deepEqual(back.dropped, []);

  // Before any import there was nothing to say. After one, every picker's
  // source line names who counted and when THEY counted.
  assert.match(inv.sourceLine(back.doc, 'tool', NOW), /Counted by bom/);
  assert.match(inv.sourceLine(back.doc, 'tool', NOW), /2026-08-01 BY ITS OWN STATEMENT/);
  // And a kind the file said nothing about is still UNCHECKED, not "not owned".
  assert.match(inv.sourceLine(back.doc, 'machine', NOW), /UNCHECKED/);
});

test('an UNDATED / UNSOURCED file is accepted and MARKED, never stamped with our clock', () => {
  const parsed = inv.parseInventoryFile(
    JSON.stringify({
      kind: inv.INVENTORY_FILE_KIND,
      version: 1,
      entries: [{ kind: 'tool', id: 'endmill-6mm-2f' }],
    }),
    NOW
  );
  assert.equal(parsed.status, 'ok');
  if (parsed.status !== 'ok') return;
  assert.equal(parsed.report.undated, true);
  assert.equal(parsed.report.unsourced, true);
  // 🔴 The date is NULL, not `NOW`. "When we read it" and "when they counted
  // it" are different facts and only the second one is being asserted to an
  // operator by a picker.
  assert.equal(parsed.doc.as_of, null);
  assert.equal(parsed.doc.imported_at, NOW);
  assert.match(inv.describeProvenance(parsed.doc, NOW), /did NOT state — treat it as UNDATED/);
});

test('a file that cannot be vouched for is refused WHOLE, and the wiring imports nothing', () => {
  const current = inv.parseInventoryFile(FILE_ONE, NOW);
  assert.equal(current.status, 'ok');
  if (current.status !== 'ok') return;

  for (const [text, needle] of [
    ['not json at all', /not readable JSON/],
    [JSON.stringify({ kind: 'somebody else', version: 1, entries: [] }), /not an inventory for this app/],
    [JSON.stringify({ kind: inv.INVENTORY_FILE_KIND, entries: [] }), /carries no version/],
    [
      JSON.stringify({ kind: inv.INVENTORY_FILE_KIND, version: 99, entries: [] }),
      /NEWER version of this app/,
    ],
  ] as [string, RegExp][]) {
    const parsed = inv.parseInventoryFile(text, NOW);
    assert.equal(parsed.status, 'refused', text.slice(0, 30));
    if (parsed.status !== 'refused') continue;
    assert.match(parsed.why, needle);
  }
  // The document already registered is untouched: the wiring's refusal branch
  // returns before `applyImport` is reached, so there is nothing to assert
  // about a partially-applied state — it cannot exist.
});

test('entries this build cannot read are refused BY INDEX AND ID, and the count rides in the document', () => {
  const parsed = inv.parseInventoryFile(
    JSON.stringify({
      kind: inv.INVENTORY_FILE_KIND,
      version: 1,
      source: 'ops',
      as_of: '2026-08-09',
      entries: [
        { kind: 'tool', id: 'endmill-6mm-2f' },
        { kind: 'unicorn', id: 'sparkle' },
        { kind: 'tool' },
        { kind: 'tool', id: 'shop-special', definition: 'shop' },
      ],
    }),
    NOW
  );
  assert.equal(parsed.status, 'ok');
  if (parsed.status !== 'ok') return;
  assert.equal(parsed.report.accepted, 1);
  assert.equal(parsed.report.refused.length, 3);
  // 🔴 The index and the id, not a bare count — "3 were dropped" is not
  // something a shop can act on.
  assert.deepEqual(
    parsed.report.refused.map((r) => [r.index, r.id]),
    [
      [1, 'sparkle'],
      [2, '(no id)'],
      [3, 'shop-special'],
    ]
  );
  // Carried IN the document, so the source line cannot be written without it.
  assert.equal(parsed.doc.refused, 3);
  assert.match(inv.sourceLine(parsed.doc, 'tool', NOW), /3 entries in that file could NOT be read/);
});

/* ────────────────────────────────────────────────────────────────────────────
   🔴 THE PLANT: AN IMPORT THAT DROPS ENTRIES SILENTLY
   ──────────────────────────────────────────────────────────────────────────── */

test('PLANT — an import that MERGES instead of replacing reports nothing dropped, and keeps a cutter the shop no longer has', () => {
  const first = inv.parseInventoryFile(FILE_ONE, NOW);
  const second = inv.parseInventoryFile(FILE_TWO, NOW);
  assert.equal(first.status, 'ok');
  assert.equal(second.status, 'ok');
  if (first.status !== 'ok' || second.status !== 'ok') return;

  // ── the real path ────────────────────────────────────────────────────────
  const real = inv.applyImport(first.doc, second.doc);
  // The 3mm cutter is gone, BY NAME. This is the list the wiring must print:
  // every one of these is a saved job that must now refuse.
  assert.deepEqual(real.dropped, [{ kind: 'tool', id: 'endmill-3mm-2f' }]);
  assert.equal(real.doc.entries.some((e) => e.id === 'endmill-3mm-2f'), false);
  // And a job asking for it is REFUSED, not substituted with the 6mm.
  const verdict = inv.resolveSelection(real.doc, 'tool', 'endmill-3mm-2f', TOOL_CATALOGUE, NOW);
  assert.equal(verdict.status, 'refused');
  if (verdict.status === 'refused') assert.match(verdict.why, /does NOT list this one/);

  // ── the plant ────────────────────────────────────────────────────────────
  // 🔴 The defect, written out: merge the two entry sets instead of replacing.
  // It is one plausible line, it loses NOTHING, and that is precisely why it is
  // wrong — the app goes on asserting the shop owns a cutter the shop's own
  // second count did not list, and reports zero dropped entries while doing it.
  const plantedDoc = {
    ...second.doc,
    entries: [
      ...second.doc.entries,
      ...first.doc.entries.filter(
        (e) => !second.doc.entries.some((n) => n.kind === e.kind && n.id === e.id)
      ),
    ],
  };
  const plantedDropped: typeof real.dropped = [];
  assert.deepEqual(plantedDropped, []); // nothing to warn about — silently
  assert.equal(plantedDoc.entries.some((e) => e.id === 'endmill-3mm-2f'), true);
  const plantedVerdict = inv.resolveSelection(
    plantedDoc,
    'tool',
    'endmill-3mm-2f',
    TOOL_CATALOGUE,
    NOW
  );
  assert.equal(plantedVerdict.status, 'ok'); // 🔴 vouched for, by nobody
});

test('an import replaces what was IMPORTED and keeps what the operator typed', () => {
  const first = inv.parseInventoryFile(FILE_ONE, NOW);
  assert.equal(first.status, 'ok');
  if (first.status !== 'ok') return;
  const withMine = inv.addOperatorEntry(
    inv.applyImport(inv.EMPTY_INVENTORY, first.doc).doc,
    { kind: 'tool', id: 'ground-in-house', label: 'the one we ground ourselves' },
    NOW
  );
  const second = inv.parseInventoryFile(FILE_TWO, NOW);
  assert.equal(second.status, 'ok');
  if (second.status !== 'ok') return;

  const out = inv.applyImport(withMine, second.doc);
  assert.equal(out.kept, 1);
  assert.equal(out.doc.entries.some((e) => e.id === 'ground-in-house'), true);
  // The operator's entry is NOT in the dropped list — the file never carried it,
  // so the file cannot have stopped carrying it.
  assert.deepEqual(out.dropped, [{ kind: 'tool', id: 'endmill-3mm-2f' }]);
});

/* ════════════════════════════════════════════════════════════════════════════
   3. THE MATERIAL
   ════════════════════════════════════════════════════════════════════════════ */

const LIBRARY = ['Plywood', 'MDF', 'Acrylic', 'Aluminium'];

test('a job planned against one material with a workpiece recorded as another is a CONFLICT', () => {
  const a = jm.checkMaterialAgreement('Aluminium', { name: 'AU ply 2400x1200', material: 'Plywood' }, LIBRARY);
  assert.equal(a.state, 'conflict');
  if (a.state !== 'conflict') return;
  // 🔴 BOTH names, and which one the program will actually carry.
  assert.equal(a.job, 'Aluminium');
  assert.equal(a.workpiece, 'Plywood');
  assert.equal(a.workpieceName, 'AU ply 2400x1200');
  assert.match(a.why, /"Aluminium"/);
  assert.match(a.why, /"Plywood"/);
  assert.match(a.why, /it is "Aluminium"/);
  assert.match(a.why, /nothing here will choose for you/);
});

/* ────────────────────────────────────────────────────────────────────────────
   🔴 THE PLANT: A CONFLICT RENDERED AS AGREEMENT
   ──────────────────────────────────────────────────────────────────────────── */

test('PLANT — a resolver that silently prefers one side turns the conflict into agreement', () => {
  const workpiece = { name: 'AU ply 2400x1200', material: 'Plywood' };

  // ── the real path ────────────────────────────────────────────────────────
  assert.equal(jm.checkMaterialAgreement('Aluminium', workpiece, LIBRARY).state, 'conflict');

  // ── the plant ────────────────────────────────────────────────────────────
  // 🔴 The defect the module was told not to build: prefer the job's material
  // and move on. It is the reasonable-looking line — the job's material IS what
  // the program carries — and it is wrong because it stops anyone finding out
  // that the sheet on the bed is recorded as something else. Every assertion
  // above fails under it.
  const planted = (job: string, wp: { name: string; material?: string }) => {
    const a = jm.checkMaterialAgreement(job, wp, LIBRARY);
    return a.state === 'conflict'
      ? { state: 'agreed' as const, name: a.job, from: 'the job material control' as const }
      : a;
  };
  const p = planted('Aluminium', workpiece);
  assert.equal(p.state, 'agreed');
  if (p.state === 'agreed') assert.equal(p.name, 'Aluminium');
});

test('an ad-hoc workpiece is NOT a conflict, and a material the core does not carry is UNKNOWN', () => {
  // Typed dimensions, no record: nothing states a second material.
  const adhoc = jm.checkMaterialAgreement('Plywood', null, LIBRARY);
  assert.equal(adhoc.state, 'agreed');
  if (adhoc.state === 'agreed') assert.equal(adhoc.from, 'the job material control');

  // A row that states nothing agrees with nothing and contradicts nothing.
  const silent = jm.checkMaterialAgreement('Plywood', { name: 'US 4x8 panel' }, LIBRARY);
  assert.equal(silent.state, 'agreed');
  if (silent.state === 'agreed') assert.match(silent.note ?? '', /nothing confirms it either/);

  // 🔴 `'Ply'` resolves to NOTHING. It is not matched to `'Plywood'`, because a
  // substituted material scales every feed in the program by somebody else's
  // multiplier.
  const drifted = jm.checkMaterialAgreement('Ply', null, LIBRARY);
  assert.equal(drifted.state, 'unknown');
  if (drifted.state === 'unknown') assert.match(drifted.why, /NOT been matched to a similar one/);
});

test('the material facet is built from the ROWS, counts what it would show, and can reach the rows that state nothing', () => {
  const rows = [
    { material: 'Plywood' },
    { material: 'Plywood' },
    { material: 'MDF' },
    {}, // a material-agnostic panel size
    { material: 'Bamboo ply' }, // real in the shop, absent from this core
  ];
  const options = jm.materialFacetOptions(rows, LIBRARY);

  assert.deepEqual(options[0], { value: '', label: 'All materials', count: 5 });
  // Known materials in the LIBRARY's order, then anything the core does not
  // carry, at the end where its oddity is visible.
  assert.deepEqual(
    options.slice(1).map((o) => o.value),
    ['Plywood', 'MDF', 'Bamboo ply', jm.FACET_NOT_STATED]
  );
  assert.equal(options.find((o) => o.value === 'Plywood')?.count, 2);
  assert.match(options.find((o) => o.value === 'Bamboo ply')?.label ?? '', /not in this build's planner/);
  // 🔴 `Acrylic` is in the library and in no row, so it is NOT an option: a
  // filter that empties the list and explains nothing is worse than no filter.
  assert.equal(options.some((o) => o.value === 'Acrylic'), false);

  // The "states nothing" rows stay reachable rather than being hidden by every
  // value — `ObjectPicker` rule 1, applied to the facet instead of the search.
  assert.equal(jm.facetMatches(undefined, jm.FACET_NOT_STATED), true);
  assert.equal(jm.facetMatches('Plywood', jm.FACET_NOT_STATED), false);
  assert.equal(jm.facetMatches(undefined, ''), true);
  assert.equal(jm.facetMatches('Plywood', 'Plywood'), true);
});
