// The drawing list's verdicts, and the filter built on them.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT RUNS HERE, AND WHAT CANNOT
// ─────────────────────────────────────────────────────────────────────────────
//
// Founder, 2026-08-11: *"a filter on the drawings as well like in the tools
// (selected, usable, not chosen, not for this workpiece …)"*.
//
// ✅ PART A — THE WASM, EXERCISED, THROUGH THE BROWSER'S OWN BUNDLE. `web/src/wasm/`
//    is the artefact Vite ships, loaded here exactly as the page loads it. BOTH
//    the planner (`plan_import_many`) and the new export (`drawing_verdicts`)
//    are driven from that ONE module, so "they agree" is a statement about the
//    thing the operator runs and not about two builds that happen to be near
//    each other. (Whether that bundle is CURRENT is gate K3's question, not this
//    file's.)
//
//    🔴 BOTH ARMS, ALWAYS. Two overlapping drawings: the planner refuses and the
//    export refuses IN THE SAME WORDS. Two separated: the planner posts and
//    every row is `usable`. **Without the second arm the first proves only that
//    the export refuses everything** — which is the shape of green that this
//    lane keeps catching, and it would pass a boundary hard-wired to `false`.
//
// ✅ PART B — `splitDrawingParts`, EXERCISED. It is the one place a host can
//    silently produce a verdict about a DIFFERENT workpiece than the planner
//    judged, so both directions of mismatch are driven and both must REFUSE.
//
// ✅ PART C — THE PLANTS, and two of the three are behaviour rather than text:
//    the usability-keyed filter is run through `ObjectPicker.narrowingStages`
//    over REAL verdicts from the wasm, and the count it hides is asserted.
//
// ⚠ PART D — THE SOURCE, READ AS TEXT. `App.tsx` CANNOT BE IMPORTED IN NODE —
//    the loader stops at the sample asset imports (`Unknown file extension
//    ".dxf"`), measured again while writing this file and recorded in
//    `config-wiring.test.ts` before it. So `drawingUsabilityMark`,
//    `drawingFitMark`, `worstDrawingFit` and `drawingVerdictProps` are NOT
//    executed anywhere below, and no assertion here observes a React render.
//    **A text guard proves "unchanged", never "correct."** It is here because
//    the alternative is nothing at all, and because the defect it guards — a
//    filter re-keyed onto `usability`, or a safety sentence retyped in
//    TypeScript — is invisible to every other check we own.
//
// 🔴 NOT REACHED, stated rather than implied:
//   · Any pixel. Nobody has seen the facet dropdown, the row marks or the
//     suppressed label drawn. `web/e2e/` is that leg.
//   · The CLI. Deliberately: the point is the BROWSER's module.
//   · The `placement` rule refusing. `App.tsx` sends an offset of ZERO by
//     construction (the parts it hands back are already placed), so that rule
//     can only ever report `passed` through this wiring. It is exercised below
//     against the export DIRECTLY, which is the only door it is reachable
//     through, and the app's own limitation is written on `drawingVerdicts`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..', 'src', 'App.tsx');
const CAM = join(HERE, '..', 'src', 'cam.ts');
const GLUE = join(HERE, '..', 'src', 'wasm', 'twobee_cam_wasm.js');
const BG = join(HERE, '..', 'src', 'wasm', 'twobee_cam_wasm_bg.wasm');

/* ════════════════════════════════════════════════════════════════════════════
   PART A — THE BROWSER'S OWN WASM BUNDLE
   ════════════════════════════════════════════════════════════════════════════ */

const wasm: any = await import(pathToFileURL(GLUE).href);
wasm.initSync({ module: readFileSync(BG) });

const { splitDrawingParts } = await import('../src/cam.ts');
const { narrowingStages } = await import('../src/ObjectPicker.tsx');
const { labelRepeatsHeading } = await import('../src/ObjectPicker.tsx');

/** One closed 100 x 80mm square, drawn at (50,50). Written here rather than
 *  read from `gates/fixtures/` so the two arms differ ONLY by an offset — a
 *  comparison whose two sides also differ in geometry proves nothing about the
 *  offset. LWPOLYLINE because that is the entity the importer's own fixtures
 *  use, so this exercises the real intake path and not a special case. */
const SQUARE = new TextEncoder().encode(
  [
    '0', 'SECTION', '2', 'ENTITIES', '0', 'LWPOLYLINE', '70', '1',
    '10', '50.0', '20', '50.0',
    '10', '150.0', '20', '50.0',
    '10', '150.0', '20', '130.0',
    '10', '50.0', '20', '130.0',
    '0', 'ENDSEC', '0', 'EOF', '',
  ].join('\n')
);
const DRAWN_W = 100;

/** The config shape `App.tsx` sends — the SAME object both calls are handed,
 *  which is the whole guarantee the export was built for. */
const config = (sizeX: number, sizeY: number, toolId = 'End Mill - Up-cut 6mm 2F') => ({
  machine: {
    travel_x_mm: 1250,
    travel_y_mm: 670,
    travel_z_mm: 100,
    safe_z_mm: 5,
    collet_mm: 6,
    spindle_max_rpm: 24000,
    supports_arcs: true,
  },
  stock: {
    size_x_mm: sizeX,
    size_y_mm: sizeY,
    thickness_mm: 12,
    z_zero_at_top: true,
    origin_x_mm: 0,
    origin_y_mm: 0,
    rotation_deg: 0,
  },
  material: 'Plywood',
  tool_id: toolId,
  op: { depth_per_pass_mm: 4, rpm: 18000, entry: 'Ramp', direction: 'Climb', dogbone: 'None' },
});

/** The planner, as the page calls it — one copy of `SQUARE` per drawing. */
function planWorkpiece(cfg: unknown, ids: string[], offsets: [number, number][]): any {
  const blob = new Uint8Array(SQUARE.length * ids.length);
  ids.forEach((_, i) => blob.set(SQUARE, i * SQUARE.length));
  const described = ids.map((id, i) => ({
    id,
    format: 'dxf',
    byte_len: SQUARE.length,
    offset_mm: offsets[i],
    rotation_deg: 0,
  }));
  return JSON.parse(
    wasm.plan_import_many(JSON.stringify(described), blob, JSON.stringify(cfg), 3, undefined, undefined)
  );
}

/**
 * The export, asked the way `App.tsx` asks it: the report's OWN geometry, split
 * back per drawing, at a zero delta because it is already placed.
 *
 * 🔴 This routes through the real `splitDrawingParts` rather than a local
 * re-implementation, so a change that broke the app's attribution would break
 * these assertions too. A test that inverted the naming itself would be
 * asserting that the test agrees with the test.
 */
function askVerdicts(cfg: unknown, report: any, ids: string[]): any {
  const split = splitDrawingParts(report.drawing, ids);
  assert.equal(split.ok, true, `attribution refused: ${split.ok ? '' : split.why}`);
  const rows = ids.map((id) => ({
    id,
    parts: split.ok ? (split.byId.get(id) ?? []) : [],
    offset_mm: [0, 0] as [number, number],
    rotation_deg: 0,
  }));
  return JSON.parse(wasm.drawing_verdicts(JSON.stringify(cfg), JSON.stringify(rows)));
}

const ruleOf = (row: any, rule: string) => row.rules.find((r: any) => r.rule === rule);

/* ── ARM 1: two overlapping drawings ───────────────────────────────────────── */

test('ARM 1 — the planner REFUSES two overlapping drawings and the export refuses in THE SAME WORDS', () => {
  const cfg = config(600, 400);
  // `b` 10mm to the right of `a`: 90mm of shared material in X. Not a corner
  // touch and not a full stack — a plain overlap, which is the condition the
  // planner emits zero bytes for.
  const report = planWorkpiece(cfg, ['a', 'b'], [[0, 0], [10, 0]]);

  assert.equal(report.ok, false, 'the planner accepted two overlapping drawings');
  assert.equal(report.gcode ?? '', '', 'a refused workpiece still printed G-code');
  assert.equal(report.refusals.length, 1, `expected one condemned pair, got ${report.refusals.length}`);

  const v = askVerdicts(cfg, report, ['a', 'b']);
  assert.equal(v.ok, true, `the export refused the call: ${v.why}`);
  assert.equal(v.verdicts.length, 2);

  for (const row of v.verdicts) {
    assert.equal(row.usability, 'invalidates', `${row.id} did not invalidate the workpiece`);
    const pair = ruleOf(row, 'pair-clearance');
    assert.equal(pair.outcome, 'refused', `${row.id}'s pair-clearance rule did not refuse`);

    // 🔴 CHARACTER FOR CHARACTER. Not `includes`, not a regex, not a normalised
    // comparison: the whole point of the export is that it hands back the
    // PLANNER'S OWN SENTENCE, from the same run of the same predicate. A
    // paraphrase that merely contained the same numbers would pass a looser
    // assertion and would still be a second copy of a safety message.
    assert.equal(
      pair.why,
      report.refusals[0],
      `${row.id}'s refusal is not the planner's, character for character`
    );
    assert.equal(row.why, report.refusals[0], `${row.id}'s summary sentence is not the refusal`);

    // The rule that fired is NAMED, because "invalidates the workpiece" is four
    // conditions and a red row that will not say which one cannot be acted on.
    const refusedRules = row.rules.filter((r: any) => r.outcome === 'refused').map((r: any) => r.rule);
    assert.deepEqual(refusedRules, ['pair-clearance']);
  }

  // Both drawings are condemned by ONE pair, and each row carries it — a pair
  // condemns both of its drawings. With only two on the workpiece there is no
  // third row to wrongly inherit it; that separation is the core's own test.
  assert.match(report.refusals[0], /a\/part1/);
  assert.match(report.refusals[0], /b\/part1/);
});

/* ── ARM 2: the same two drawings, separated ───────────────────────────────── */

test('ARM 2 — separated, the planner POSTS and every row is usable (without this the first arm proves nothing)', () => {
  const cfg = config(600, 400);
  const report = planWorkpiece(cfg, ['a', 'b'], [[0, 0], [300, 0]]);

  assert.equal(report.ok, true, `the planner refused a clear workpiece: ${JSON.stringify(report.refusals)}`);
  assert.ok((report.gcode ?? '').length > 0, 'a posted job emitted no G-code');
  assert.deepEqual(report.refusals, []);

  const v = askVerdicts(cfg, report, ['a', 'b']);
  assert.equal(v.ok, true, `the export refused the call: ${v.why}`);

  for (const row of v.verdicts) {
    assert.equal(row.usability, 'usable', `${row.id} was marked ${row.usability} on a workpiece that posted`);
    // 🔴 `why` is EMPTY for a pass, deliberately, so a host cannot write
    // `why || 'fine'` and have an unanswered rule read as an answered one.
    assert.equal(row.why, '');
    for (const r of row.rules)
      assert.equal(r.outcome, 'passed', `${row.id}'s ${r.rule} rule was ${r.outcome} on a job that posted`);
  }

  // The setup is echoed, so the answer says what produced it. A verdict quoted
  // without its setup is a verdict about a workpiece the reader has to guess at.
  assert.deepEqual(v.setup.workpiece_size_mm, [600, 400]);
  assert.equal(v.setup.cutter_id, 'End Mill - Up-cut 6mm 2F');
  assert.equal(v.setup.drawings, 2);
});

/* ── The two axes are two axes ─────────────────────────────────────────────── */

test('🔴 `fit` IS NOT `usability` — the planner POSTS an off-workpiece drawing, so it must never be drawn as an invalidation', () => {
  const cfg = config(600, 400);
  // `b` pushed until it hangs 70mm past the far X edge, and far enough from `a`
  // that the pair check has nothing to say. So the ONLY thing wrong with this
  // workpiece is that a part is not on the material.
  const report = planWorkpiece(cfg, ['a', 'b'], [[0, 0], [520, 0]]);

  // 🔴 THE WHOLE POINT: the planner does not refuse this. It posts, and the
  // cutter goes where the material is not. Anything rendering `off-workpiece`
  // as `🔴 INVALIDATES THE JOB` would be claiming a refusal that never happened.
  assert.equal(report.ok, true, 'the planner refused an off-workpiece drawing — this test is now wrong, not the app');
  assert.ok((report.gcode ?? '').length > 0, 'the off-workpiece job emitted no G-code');

  const v = askVerdicts(cfg, report, ['a', 'b']);
  const b = v.verdicts.find((r: any) => r.id === 'b');
  assert.equal(b.fit, 'off-workpiece');
  assert.equal(b.usability, 'usable', 'an off-workpiece drawing was marked as invalidating the job');
  // The sentence names the edge and the millimetres — the number a person moves
  // it by — and says nothing here will move it for them.
  assert.match(b.why_fit, /FITS THE WORKPIECE BY SIZE AND IS NOT ON IT/);
  assert.match(b.why_fit, /70\.000mm past the far X edge/);
  assert.equal(b.turn_that_fits_deg, null, 'a turn was offered for a drawing that fits by size');

  const a = v.verdicts.find((r: any) => r.id === 'a');
  assert.equal(a.fit, 'on-workpiece');
  // 🔴 A SENTENCE ON THE PASSING VALUE TOO. A blank beside a verdict reads as a
  // verdict nobody stood behind, and this one carries the cutter-radius caveat
  // the fit rule deliberately does NOT fold into its answer.
  assert.notEqual(a.why_fit, '');
  assert.match(a.why_fit, /NOT grown by a cutter radius/);
});

test('the two off-workpiece failures are told apart, because they have different fixes', () => {
  // LARGER THAN THE MATERIAL, and a quarter turn would fit it BY SIZE. The
  // drawing needs 100 x 80; the workpiece is 90 x 300.
  const turn = config(90, 300);
  const rTurn = planWorkpiece(turn, ['a'], [[0, 0]]);
  const vTurn = askVerdicts(turn, rTurn, ['a']);
  const rowTurn = vTurn.verdicts[0];
  assert.equal(rowTurn.fit, 'off-workpiece');
  assert.equal(rowTurn.turn_that_fits_deg, 90);
  assert.match(rowTurn.why_fit, /LARGER THAN THE WORKPIECE/);
  assert.match(rowTurn.why_fit, /size answer only/);

  // LARGER, and no turn helps. `null` here means the OPPOSITE of `null` on a
  // fitting drawing — which is exactly why `fit` is the answer and the turn is
  // only the detail behind it.
  const nope = config(60, 60);
  const rNope = planWorkpiece(nope, ['a'], [[0, 0]]);
  const vNope = askVerdicts(nope, rNope, ['a']);
  assert.equal(vNope.verdicts[0].fit, 'off-workpiece');
  assert.equal(vNope.verdicts[0].turn_that_fits_deg, null);
  assert.match(vNope.verdicts[0].why_fit, /no quarter turn helps/);

  // And the drawing genuinely is 100mm wide, so the two cases above are about
  // the workpiece and not about a geometry accident.
  assert.equal(rowTurn.placed_extent_mm[2] - rowTurn.placed_extent_mm[0], DRAWN_W);
});

/* ── UNCHECKED is not a pass ───────────────────────────────────────────────── */

test('🔴 with no cutter resolved, the pair check is UNCHECKED — not clear, and not usable', () => {
  const cfg = config(600, 400, '');
  const report = planWorkpiece(cfg, ['a', 'b'], [[0, 0], [300, 0]]);
  // The planner refuses the whole job for the same reason; this is the state an
  // operator is in before they have picked a cutter.
  assert.equal(report.ok, false);

  const v = askVerdicts(cfg, report, ['a', 'b']);
  for (const row of v.verdicts) {
    assert.equal(row.usability, 'unknown', `${row.id} was ${row.usability} with no cutter resolved`);
    const pair = ruleOf(row, 'pair-clearance');
    assert.equal(pair.outcome, 'unchecked');
    assert.match(pair.why, /NO PAIR OF PARTS WAS CHECKED/);
  }
  assert.equal(v.setup.cutter_id, null);
  assert.equal(v.setup.cutter_diameter_mm, null);
});

test('🔴 with no workpiece size declared, `fit` is UNKNOWN — never "on the workpiece"', () => {
  // The stock carries a thickness and NO size. `intake_stock` would fill the
  // missing rectangle from `Stock::default()`; this export deliberately will
  // not, because a confident verdict about material nobody declared is worse
  // than a grey row.
  const cfg = { ...config(600, 400), stock: { thickness_mm: 12 } };
  const report = planWorkpiece(config(600, 400), ['a'], [[0, 0]]);
  const v = askVerdicts(cfg, report, ['a']);
  assert.equal(v.setup.workpiece_size_mm, null);
  assert.equal(v.verdicts[0].fit, 'unknown');
  assert.match(v.verdicts[0].why_fit, /UNCHECKED, not on the workpiece/);
  // The drawing itself is fine — the two axes stay apart even when one of them
  // could not be asked.
  assert.equal(v.verdicts[0].usability, 'usable');
});

test('the three caveats the core ships are IN the payload, so a host has no reason to invent them', () => {
  const cfg = config(600, 400);
  const report = planWorkpiece(cfg, ['a'], [[0, 0]]);
  const v = askVerdicts(cfg, report, ['a']);
  const joined = v.caveats.join('\n');
  assert.match(joined, /answer DIFFERENT QUESTIONS and must not be merged/);
  assert.match(joined, /UNKNOWN IS NOT USABLE/);
  assert.match(joined, /`selected` and `not chosen` are HOST STATE/);
});

test('a configuration that will not parse is REFUSED, never replaced with defaults', () => {
  const out = JSON.parse(wasm.drawing_verdicts('{ not json', '[]'));
  assert.equal(out.ok, false);
  assert.match(out.why, /configuration rejected/);
  // 🔴 A refusal carries `why` AND NOTHING ELSE. A `verdicts: []` beside it is a
  // field a caller can read past the refusal and render as "no drawing has a
  // problem".
  assert.deepEqual(Object.keys(out).sort(), ['ok', 'why']);
});

test('zero drawings is a real answer of zero rows — the list exists before a file is dropped', () => {
  for (const empty of ['[]', '']) {
    const out = JSON.parse(wasm.drawing_verdicts(JSON.stringify(config(600, 400)), empty));
    assert.equal(out.ok, true);
    assert.deepEqual(out.verdicts, []);
    assert.equal(out.setup.drawings, 0);
  }
});

/* ── The rules `App.tsx` cannot reach through its own wiring ───────────────── */

test('the identity and placement rules refuse at the export, where they ARE reachable', () => {
  const cfg = JSON.stringify(config(600, 400));
  const part = {
    name: 'part1',
    outer: {
      verts: [
        { x: 0, y: 0, bulge: 0 },
        { x: 10, y: 0, bulge: 0 },
        { x: 10, y: 10, bulge: 0 },
        { x: 0, y: 10, bulge: 0 },
      ],
      closed: true,
    },
    inners: [],
  };

  // Two drawings with ONE name. The planner refuses a duplicate id rather than
  // renaming it, because a silently renamed drawing is one the user cannot find.
  const dup = JSON.parse(
    wasm.drawing_verdicts(cfg, JSON.stringify([
      { id: 'same', parts: [part] },
      { id: 'same', parts: [part] },
    ]))
  );
  assert.equal(dup.verdicts[1].usability, 'invalidates');
  assert.equal(ruleOf(dup.verdicts[1], 'identity').outcome, 'refused');
  assert.match(ruleOf(dup.verdicts[1], 'identity').why, /different names/);

  // A non-finite placement is REFUSED, never clamped: NaN compares false against
  // every window test, so a drawing placed there would pass the fit rule having
  // tested nothing.
  const nan = JSON.parse(
    wasm.drawing_verdicts(cfg, JSON.stringify([
      { id: 'a', parts: [part], offset_mm: [null, 0] },
    ]))
  );
  // `null` deserialises as a rejected list rather than a NaN — the boundary
  // refuses the whole call, which is the same fail-closed direction.
  assert.equal(nan.ok, false);
  assert.match(nan.why, /NOTHING was read from it/);

  // An empty parts list is a real answer and the core names it, pointing at the
  // import notes for the cause it cannot see from here.
  const none = JSON.parse(wasm.drawing_verdicts(cfg, JSON.stringify([{ id: 'a', parts: [] }])));
  assert.equal(none.verdicts[0].usability, 'invalidates');
  assert.equal(ruleOf(none.verdicts[0], 'geometry').outcome, 'refused');
  assert.match(ruleOf(none.verdicts[0], 'geometry').why, /import notes on the report carry the cause/);
  // 🔴 And the pair check does NOT report a clear workpiece computed from the
  // drawings that happened to work.
  assert.equal(ruleOf(none.verdicts[0], 'pair-clearance').outcome, 'unchecked');
  assert.match(ruleOf(none.verdicts[0], 'pair-clearance').why, /is not this workpiece/);
});

/* ════════════════════════════════════════════════════════════════════════════
   PART B — `splitDrawingParts`, the one place a host can judge the wrong
   workpiece
   ════════════════════════════════════════════════════════════════════════════ */

const namedPart = (name: string) => ({
  name,
  outer: { verts: [{ x: 0, y: 0, bulge: 0 }], closed: true },
  inners: [],
});

test('attribution inverts the core\'s own `drawing/part` naming exactly', () => {
  const out = splitDrawingParts([namedPart('a/part1'), namedPart('b/hole'), namedPart('a/part2')], ['a', 'b']);
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.deepEqual(out.byId.get('a')!.map((p) => p.name), ['part1', 'part2']);
  assert.deepEqual(out.byId.get('b')!.map((p) => p.name), ['hole']);
});

test('🔴 a longer id wins, so a copy cannot steal the original\'s parts', () => {
  // `Hive super end` and `Hive super end #2` are exactly what `mintInstance`
  // produces for the ⧉ control, and the first is a PREFIX of the second. A
  // first-match-wins split would hand `#2`'s parts to the original and the two
  // copies would then be judged as one drawing carrying twice the geometry.
  const out = splitDrawingParts(
    [namedPart('Hive super end #2/part1'), namedPart('Hive super end/part1')],
    ['Hive super end', 'Hive super end #2']
  );
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.byId.get('Hive super end')!.length, 1);
  assert.equal(out.byId.get('Hive super end #2')!.length, 1);
});

test('🔴 a part belonging to no listed drawing REFUSES — the pair check must not run on a short workpiece', () => {
  const out = splitDrawingParts([namedPart('a/part1'), namedPart('ghost/part1')], ['a']);
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.match(out.why, /belong to no drawing on this list/);
  assert.match(out.why, /nothing was judged/);
});

test('🔴 a listed drawing the report never saw REFUSES — it is not "it carries no geometry"', () => {
  const out = splitDrawingParts([namedPart('a/part1')], ['a', 'b']);
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.match(out.why, /appear nowhere in the report's geometry/);
  // The distinction that keeps a false red out: the core gives the
  // no-geometry verdict, and it cannot be given from a report that never saw
  // the drawing.
  assert.match(out.why, /NOT "they carry no geometry"/);
});

test('an empty report with drawings on the table is NOT ASKED, and says which fact it is', () => {
  const out = splitDrawingParts([], ['a']);
  assert.equal(out.ok, false);
  if (out.ok) return;
  assert.match(out.why, /NOT "they are fine"/);
  // And zero drawings with an empty report is a legitimate empty answer, not a
  // refusal — the drawing list exists before a file is dropped.
  const none = splitDrawingParts([], []);
  assert.equal(none.ok, true);
});

/* ════════════════════════════════════════════════════════════════════════════
   PART C — THE PLANTS
   ════════════════════════════════════════════════════════════════════════════ */

test('🔴 PLANT — a filter keyed on `usability` HIDES THE ROWS THAT ARE WHY THE JOB IS REFUSED', () => {
  /* The founder's ⧉ copy case, at the size it stops being a curiosity: six
   * copies of one drawing landing on top of each other (which is what the copy
   * control does, on purpose — see `drawing-copy-N`) plus one placed clear.
   *
   * Every one of the six is condemned. A filter offering *"usable"* — the exact
   * word the founder used, and the obvious thing to build — leaves a ONE-ROW
   * LIST WITH NOTHING RED IN IT, over a workpiece the planner refuses and emits
   * zero bytes for. That is `ObjectPicker` rule 1 turned against the person
   * using it, and it is why the shipped facet is keyed on `fit`. */
  const cfg = config(1200, 600);
  const ids = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'clear'];
  const offsets: [number, number][] = [
    [0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [600, 0],
  ];
  const report = planWorkpiece(cfg, ids, offsets);
  assert.equal(report.ok, false, 'six stacked copies were not refused');
  assert.equal(report.gcode ?? '', '');

  const v = askVerdicts(cfg, report, ids);
  const invalidating = v.verdicts.filter((r: any) => r.usability === 'invalidates');
  assert.equal(invalidating.length, 6, `expected six condemned rows, got ${invalidating.length}`);

  // The plant: build the facet the shipped one deliberately is NOT, and run it
  // through the picker's real narrowing pipeline.
  const items = v.verdicts.map((r: any) => ({ id: r.id, name: r.id, facet: r.usability }));
  const planted = {
    label: 'Usability',
    value: 'usable',
    options: [],
    onChange: () => {},
    matches: (it: any, val: string) => (it.facet ?? 'unknown') === val,
  };
  const staged = narrowingStages(items as any, [planted as any]);

  assert.equal(staged.rows.length, 1, 'the planted filter left more than the one clear row');
  assert.deepEqual(staged.byFacet, [{ label: 'Usability', hidden: 6 }]);
  // Named as a number, because that is the thing an operator would never see:
  // six drawings, every one of them the reason there is no program, hidden by a
  // control that says "usable".
  assert.equal(staged.byFacet[0].hidden, invalidating.length);
  assert.ok(
    staged.rows.every((r: any) => r.facet === 'usable'),
    'the planted filter kept a row that does not invalidate — the plant is wrong, not the app'
  );

  // And the SHIPPED key hides none of them: all seven are on the workpiece.
  const shipped = {
    label: 'On the workpiece',
    value: 'on-workpiece',
    options: [],
    onChange: () => {},
    matches: (it: any, val: string) => (it.facet ?? 'unknown') === val,
  };
  const fitItems = v.verdicts.map((r: any) => ({ id: r.id, name: r.id, facet: r.fit }));
  const fitStaged = narrowingStages(fitItems as any, [shipped as any]);
  assert.equal(fitStaged.byFacet[0].hidden, 0, 'the fit filter hid a row that invalidates the job');
});

test('🔴 PLANT — `fit` rendered as an invalidation asserts a refusal the planner never made', () => {
  const cfg = config(600, 400);
  const report = planWorkpiece(cfg, ['a', 'b'], [[0, 0], [520, 0]]);
  const v = askVerdicts(cfg, report, ['a', 'b']);
  const b = v.verdicts.find((r: any) => r.id === 'b');

  // The plant, written out as the sentence a merged renderer would put on
  // screen, and the measurement that makes it false.
  const merged = (row: any) =>
    row.usability === 'invalidates' || row.fit === 'off-workpiece'
      ? '🔴 INVALIDATES THE JOB'
      : '✅ usable';
  assert.equal(merged(b), '🔴 INVALIDATES THE JOB');
  assert.equal(
    report.ok,
    true,
    'the merged renderer would be RIGHT here — meaning the planner has started refusing off-workpiece drawings and the two axes may now be one'
  );
  assert.ok(
    (report.gcode ?? '').length > 0,
    'the merged mark would claim no program exists while the report carries one'
  );

  // What the app does instead: two marks, and only the first is ever red.
  assert.equal(b.usability, 'usable');
  assert.equal(b.fit, 'off-workpiece');
});

test('🔴 PLANT — a refusal paraphrased rather than passed through', () => {
  const cfg = config(600, 400);
  const report = planWorkpiece(cfg, ['a', 'b'], [[0, 0], [10, 0]]);
  const refusal: string = report.refusals[0];

  /* The paraphrase, written the way a host actually writes one: same numbers,
   * shorter words, and it would sail past any assertion that checked the
   * numbers or used `includes`. It fails ONLY against character-for-character
   * equality — which is why ARM 1 asserts that and not a match. */
  const paraphrase = 'Parts a/part1 and b/part1 overlap by 90.000mm x 80.000mm — move one of them.';
  assert.notEqual(paraphrase, refusal);
  assert.match(paraphrase, /90\.000mm/, 'the paraphrase must be plausible or the plant proves nothing');

  /* And the standing guard: no distinctive run of the core's refusal may appear
   * in this app's source at all. A sentence retyped into TypeScript is a second
   * copy that drifts from the predicate doing the refusing, and it would render
   * identically on the day it stopped being true.
   *
   * ⚠ SOURCE READ AS TEXT — see this file's header. It proves the phrases are
   * absent today; it cannot prove the renderer uses the core's copy.
   *
   * ⚠ THE WINDOW IS MEASURED, NOT ROUND. Against this refusal and today's
   * source, 2026-08-11: 8 words → 0 hits · 7 → 0 · 6 → 1 · 5 → 2 · 4 → 5. The
   * short windows catch this lane's own DOCTRINE — *"the clamps stay bolted to
   * the machine while the parts do not"* is reasoning that legitimately appears
   * in design comments, not a copy of a refusal — so a window that flagged it
   * would be a guard that gets muted. 8 leaves exactly one word of slack over
   * the tightest clean width, and a genuinely retyped refusal is far longer than
   * 8 words and would light up dozens of shingles at any of these widths.
   *
   * 🔴 IT HAS ALREADY FIRED ONCE, on its first run: `cam.ts` carried
   * *"Cutting one destroys the other and leaves it loose under the spindle"* —
   * the core's sentence, verbatim, in a TSDoc comment on `OverlapFinding`. Never
   * rendered, so never a live defect. The comment was removed rather than the
   * guard relaxed, and the reason is written where the comment was. */
  const src = readFileSync(APP, 'utf8') + '\n' + readFileSync(CAM, 'utf8');
  const words = refusal.split(/\s+/);
  const shingles: string[] = [];
  for (let i = 0; i + 8 <= words.length; i++) shingles.push(words.slice(i, i + 8).join(' '));
  assert.ok(shingles.length > 5, 'the refusal is too short to shingle — this guard has stopped working');
  const leaked = shingles.filter((s) => src.includes(s));
  assert.deepEqual(leaked, [], `a core refusal phrase has been retyped into the app: ${leaked[0]}`);
});

/* ════════════════════════════════════════════════════════════════════════════
   PART D — THE SOURCE, READ AS TEXT
   ════════════════════════════════════════════════════════════════════════════ */

test('the drawing facet is keyed on `fit` and the word `usability` does not appear inside it', () => {
  const src = readFileSync(APP, 'utf8');
  /* ⚠ RE-ANCHORED 2026-08-11, and the guard is what noticed. The facet was
     called `On the workpiece`; it is now `Outline on the workpiece`, because
     "can be cut from this workpiece" is three questions and `fit` answers only
     the first — see `FIT_OPTIONS`. The guard went red on the rename exactly as
     its own message says it would, which is the one thing a text anchor is good
     for: it cannot tell you the label is honest, only that nobody changed it
     behind your back. */
  const start = src.indexOf("label: 'Outline on the workpiece',");
  assert.ok(start > 0, 'the drawing facet is gone or renamed — this guard no longer guards anything');
  const end = src.indexOf('=== value,', start);
  assert.ok(end > start, 'could not find the end of the facet block');
  const block = src.slice(start, end);

  assert.match(block, /value: drawingFitFilter/);
  assert.match(block, /onChange: setDrawingFitFilter/);
  // 🔴 The rule, as a property of the text rather than a habit.
  assert.equal(
    /usability/.test(block),
    false,
    'the drawing filter now mentions `usability` — hiding those rows hides why the job is refused'
  );

  // And the value the facet narrows on comes from `worstDrawingFit`, which is
  // itself keyed on `fit` alone. (Extracted to `panels/verdictHelpers.ts` by
  // `9e2d67fb9e`; the guard reads it where it lives, not where it was.)
  const helpers = readFileSync(join(HERE, '..', 'src', 'panels', 'verdictHelpers.ts'), 'utf8');
  const wStart = helpers.indexOf('function worstDrawingFit(');
  assert.ok(wStart > 0);
  const wBody = helpers.slice(wStart, helpers.indexOf('\n}', wStart));
  assert.equal(/usability/.test(wBody), false, '`worstDrawingFit` now reads `usability`');
  assert.match(wBody, /off-workpiece/);
});

test('the row renders the core\'s own sentences, by field, rather than any sentence of its own', () => {
  const src = readFileSync(APP, 'utf8');
  // The per-instance row: `why` under the usability mark, `why_fit` under the
  // fit mark, both interpolated verbatim.
  assert.match(src, /data-testid=\{`drawing-row-verdict-\$\{i\}`\}/);
  assert.match(src, /data-testid=\{`drawing-row-fit-\$\{i\}`\}/);
  assert.match(src, /\{v\.why \? ` — \$\{v\.why\}` : ''\}/);
  assert.match(src, /\{v\.why_fit \? ` — \$\{v\.why_fit\}` : ''\}/);
  // The core's caveats are shown, not rewritten.
  assert.match(src, /data-testid="drawing-verdict-caveats"/);
  // A failed ask is stated. A silent failure would leave a list with no marks,
  // which reads as a list where nothing invalidates the workpiece.
  assert.match(src, /data-testid="drawing-verdicts-failed"/);
});

test('the app sends a ZERO delta, because the parts it hands back are already placed', () => {
  const src = readFileSync(APP, 'utf8');
  const start = src.indexOf('drawingVerdicts(');
  assert.ok(start > 0, 'App.tsx no longer asks for drawing verdicts');
  const call = src.slice(start, start + 600);
  assert.match(call, /offset_mm: \[0, 0\]/);
  assert.match(call, /rotation_deg: 0/);
  // 🔴 Sending Part X/Y here as well would apply the placement twice and judge a
  // drawing that is nowhere on the machine.
  assert.equal(/partX|partY/.test(call), false, 'the app is applying the placement a second time');
});

/* ════════════════════════════════════════════════════════════════════════════
   PART D2 — item #77, the heading said twice
   ════════════════════════════════════════════════════════════════════════════ */

test('#77 — a label that repeats its heading is suppressed; a label that merely sits inside one is not', () => {
  // The four measured repeats, 2026-08-11.
  for (const both of ['Machine', 'Spoilboard', 'Workpiece', 'Drawing'])
    assert.equal(labelRepeatsHeading(both, both), true, `${both} should be suppressed`);

  // 🔴 The pairs that must NOT be suppressed — a heading and a thing inside it.
  // Suppressing these leaves a control with no visible name at all.
  assert.equal(labelRepeatsHeading('Tool', 'Tooling'), false);
  assert.equal(labelRepeatsHeading('Hold-down', 'Work holding'), false);
  assert.equal(labelRepeatsHeading('Touch plate', 'Machine'), false);
  assert.equal(labelRepeatsHeading('Material', 'Workpiece'), false);

  // Case and surrounding space are noise; nothing else is.
  assert.equal(labelRepeatsHeading('  machine ', 'Machine'), true);
  // Outside any provider the heading is empty and NOTHING is ever suppressed —
  // which is what keeps this from reaching `web/src/cad/`.
  assert.equal(labelRepeatsHeading('Drawing', ''), false);
});

test('#77 — the ANNOUNCED label survives, and the mechanism is one rule rather than eight call sites', () => {
  const picker = readFileSync(join(HERE, '..', 'src', 'ObjectPicker.tsx'), 'utf8');
  const app = readFileSync(APP, 'utf8');

  // 🔴 The listbox is named BY THAT SPAN. If the span is ever removed rather
  // than clipped, a screen reader announces the list as nothing — a worse
  // defect than the duplication, and an invisible one.
  assert.match(picker, /aria-labelledby=\{`\$\{uid\}-label`\}/);
  assert.match(picker, /id=\{`\$\{uid\}-label`\}/);

  // Clipped, never `display:none` / `visibility:hidden` — both of those remove
  // the element from the accessibility tree.
  const cssStart = picker.indexOf('.op-label-quiet {');
  assert.ok(cssStart > 0, 'the suppressed-label class is gone');
  const css = picker.slice(cssStart, picker.indexOf('}', cssStart));
  assert.match(css, /clip-path: inset\(50%\)/);
  assert.equal(/display:\s*none/.test(css), false);
  assert.equal(/visibility:\s*hidden/.test(css), false);

  // ONE rule, published once. Eight hand-edited call sites would be eight
  // chances to forget, and the forgotten one is the defect. (The publisher
  // moved with `Section` itself to `panels/SectionPanel.tsx` in `e076313391`
  // — every panel goes through that one component, which is exactly the
  // one-publisher property this asserts, so the needle reads it there.)
  const sectionPanel = readFileSync(join(HERE, '..', 'src', 'panels', 'SectionPanel.tsx'), 'utf8');
  assert.match(sectionPanel, /<SectionHeadingContext\.Provider value=\{title\}>/);
  assert.equal(
    // OPENING tags only — a closing `</…Provider>` is the same tag, not a
    // second publisher, and counting both would make this assertion unable to
    // ever pass.
    (sectionPanel.match(/<SectionHeadingContext\.Provider/g) ?? []).length,
    1,
    'the heading is published from more than one place'
  );
  assert.equal(
    (app.match(/<SectionHeadingContext\.Provider/g) ?? []).length,
    0,
    'App.tsx publishes the heading itself again — a second publisher beside SectionPanel'
  );
  assert.match(picker, /const quietLabel = labelRepeatsHeading\(label, useContext\(SectionHeadingContext\)\)/);
});

test('#77 — the empty state still names what is unchosen once the repeated label is gone', () => {
  const app = readFileSync(APP, 'utf8');
  /* With the visible label suppressed, the placeholder and the trigger's action
   * verb are all that name the control. The bare `choose…` default said nothing,
   * so the four affected pickers each carry a named empty state. (`Machine`,
   * `Spoilboard` and `Drawing` already did; `Workpiece` did not.) */
  for (const named of [
    'choose a machine…',
    'none declared — position UNCHECKED',
    'choose a workpiece…',
    'choose drawings…',
  ])
    assert.ok(app.includes(named), `a suppressed-label picker lost its named empty state: ${named}`);

  /* And the trigger's action still carries the noun — it is the button's
   * accessible name (`aria-labelledby`).
   *
   * ⚠ THE SHAPE CHANGED ON 2026-08-11 and this assertion changed with it. The
   * three template literals it used to match — `` `Choose ${label}` `` and its
   * siblings — put the noun on SCREEN under a heading that already said it,
   * which is the second half of the founder's own `Machine / Machine`
   * complaint. The verb and the noun are now two elements so the same
   * `quietLabel` decision can clip the noun and leave it announced. What is
   * asserted is therefore the pair, not the concatenation.
   *
   * 🔴 The behavioural form of this — rendered markup, noun present, noun
   * clipped, verb visible — is in `tests/ui-text-sweep.test.ts`, with the
   * plants. This stays a source check because it lives beside the other #77
   * source checks above and they share the file read. */
  const picker = readFileSync(join(HERE, '..', 'src', 'ObjectPicker.tsx'), 'utf8');
  assert.match(picker, /const actionVerb =/);
  for (const verb of ["'Add'", "'Change'", "'Choose'"]) assert.ok(picker.includes(verb), verb);
  assert.match(
    picker,
    /className=\{quietLabel \? 'op-label-quiet' : undefined\}[\s\S]{0,240}\{` \$\{label\}`\}/,
    'the trigger action no longer renders the noun under the quiet-label rule'
  );
});
