// Which SAVED row a picker ticks — founder, 2026-08-11: *"I have saved as a
// new Machine but I can't select it, why?"*, and the same defect found by
// inspection in the Workpiece list one section down.
//
// ⚠ RENAMED FROM `machine-selection.test.ts` when the workpiece picker was fixed
// with the same module. The rule was never the machine's; only the name was.
//
// ─────────────────────────────────────────────────────────────────────────────
// 🔴 WHAT THIS SUITE CANNOT DO, SAID FIRST
// ─────────────────────────────────────────────────────────────────────────────
//
// **No browser ran, and nobody has clicked a saved machine or a saved
// workpiece.** This does not prove the founder's bug is gone; it proves the RULE
// that produced it is gone. What is asserted here:
//
//   ✅ that the OLD rules — a ticked set derived from a shipped catalogue —
//      cannot contain a saved row, on the exact inputs a user would have. Both
//      are written against the old expressions themselves, so they are red on
//      the code that shipped them, by construction rather than by hope;
//   ✅ that the new rule ticks the row that was loaded;
//   ✅ that the tick DROPS as soon as any field on the panel moves — the
//      guarantee the old comments defended and which a latched id alone loses;
//   ✅ that a key added to the setup later is compared without anyone updating a
//      list here;
//   ✅ that the SNAPSHOT has to be what the panel will hold, not what the record
//      said — the case a workpiece with no stored material walks straight into.
//
//   🔴 NOT covered, and each needs `web/e2e/` or a human:
//      · that `savedMachines.items` / `savedWorkpieces.items` reach the pickers
//        in a real browser (read from IndexedDB through `useSaved`; the CHAIN
//        was read, not run);
//      · that the trigger visibly shows the row's name once ticked;
//      · that clicking the row loads the fields — `App.tsx`'s handlers are not
//        importable here (they pull three.js and the wasm bundle);
//      · that this was in fact the founder's bug. The diagnosis is structural: a
//        selection derived from a source that cannot represent the answer. If he
//        is ALSO hitting something else, this test will still pass.
//
// ⚠ `createElement`-free: everything under test is pure.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { sameSnapshot, selectedIdsWithLoaded } = await import('../src/savedSelection.ts');

const rowId = (kind: string, name: string) => `${kind}:${name}`;

/* ══════════════════════════════════════════════════════════════════════════
   THE MACHINE — the reported bug
   ══════════════════════════════════════════════════════════════════════════ */

/** The shipped rows, as `App.tsx` encodes them. */
const PRESETS = [
  { name: 'LEAD 1010', travel_x_mm: 1000, travel_y_mm: 1000 },
  { name: '6090', travel_x_mm: 900, travel_y_mm: 600 },
];

/** THE OLD RULE, copied here so it can be watched failing. It is the expression
 *  `App.tsx` carried until 2026-08-11 and nothing else. */
function oldMachineIds(travelX: number, travelY: number): string[] {
  return PRESETS.filter((m) => m.travel_x_mm === travelX && m.travel_y_mm === travelY).map((m) =>
    rowId('preset', m.name)
  );
}

/** A machine somebody built and saved: travels that match no preset. */
const MINE = {
  travelX: 1250,
  travelY: 670,
  travelZ: 100,
  safeZ: 5,
  colletMm: 6.35,
  spindleMax: 24000,
  probeEnabled: true,
  touchPlateMm: '1.6',
  touchPlateId: '',
  supportsArcs: true,
  spoilboardId: '',
  spoilboardX: '',
  spoilboardY: '',
  spoilboardSizeX: '',
  spoilboardSizeY: '',
  spoilboardName: '',
  spoilboardPos: 'assumed',
};
const MINE_ID = rowId('saved', 'My table');

test('THE DEFECT — the old rule cannot tick a saved machine, whatever is selected', () => {
  // 🔴 This is the founder's report, reduced. He saved a machine, chose it, and
  // the app agreed that NOTHING was selected — because the answer was derived
  // from the shipped catalogue, which structurally cannot contain his row.
  const old = oldMachineIds(MINE.travelX, MINE.travelY);
  assert.deepEqual(old, [], 'the old rule ticks nothing for a saved machine');
  /* `assert.deepEqual` is an ASSERTION SIGNATURE (`asserts actual is T`), so
   * from here the compiler believes `old` is `never[]` and rejects a `string`
   * argument to `.includes`. The runtime check below is deliberately
   * INDEPENDENT of the one above — it holds whether or not the array is empty —
   * so the type is restored for the line rather than the assertion dropped. */
  assert.ok(!(old as string[]).includes(MINE_ID), "the old rule cannot contain a saved machine's row id");

  // And the nastier form of the same defect: travels that DO match a preset make
  // the app name a DIFFERENT machine than the one that was loaded.
  const collides = oldMachineIds(900, 600);
  assert.deepEqual(collides, ['preset:6090']);
  assert.ok(!collides.includes(MINE_ID));
});

test('THE FIX — the machine that was loaded is the machine that is ticked', () => {
  const ids = selectedIdsWithLoaded(
    oldMachineIds(MINE.travelX, MINE.travelY),
    { id: MINE_ID, snapshot: MINE },
    MINE
  );
  assert.deepEqual(ids, [MINE_ID]);
});

test('a saved machine whose travels match a preset ticks BOTH, and never twice', () => {
  const copy = { ...MINE, travelX: 900, travelY: 600 };
  const ids = selectedIdsWithLoaded(
    oldMachineIds(900, 600),
    { id: rowId('saved', 'Copy'), snapshot: copy },
    copy
  );
  assert.deepEqual(ids, ['preset:6090', 'saved:Copy'], 'choosing a saved copy must not unselect its preset');

  // The same row arriving through both routes is not two ticks.
  const dup = selectedIdsWithLoaded(['preset:6090'], { id: 'preset:6090', snapshot: copy }, copy);
  assert.deepEqual(dup, ['preset:6090']);
});

test('the machine tick DROPS the moment any field on the panel moves', () => {
  // The old code refused to tick a saved machine on the grounds that a tick
  // surviving an edit would claim the panel still describes the saved object.
  // That objection was right, and this is it holding: the tick is declared AND
  // still true, never merely declared.
  const loaded = { id: MINE_ID, snapshot: MINE };
  for (const [field, value] of [
    ['travelX', 1251],
    ['safeZ', 6],
    ['colletMm', 8],
    ['spindleMax', 18000],
    ['probeEnabled', false],
    ['touchPlateMm', '2.0'],
    ['supportsArcs', false],
    ['spoilboardId', 'mdf-18'],
    ['spoilboardPos', 'entered'],
  ] as Array<[string, unknown]>) {
    const edited = { ...MINE, [field]: value };
    assert.deepEqual(
      selectedIdsWithLoaded([], loaded, edited),
      [],
      `editing ${field} left the machine ticked — the panel no longer describes it`
    );
  }
});

test('nothing loaded ticks nothing beyond the presets', () => {
  assert.deepEqual(selectedIdsWithLoaded(['preset:6090'], null, MINE), ['preset:6090']);
});

/* ══════════════════════════════════════════════════════════════════════════
   THE WORKPIECE — the same defect, found by looking rather than by report
   ══════════════════════════════════════════════════════════════════════════ */

/** Three rows of the shipped sheet catalogue, in the shape `materials.ts` holds
 *  them. Only the two dimensions and the id matter to the rule under test. */
const SHEETS = [
  { id: 'au-2400x1200', w: 2400, h: 1200 },
  { id: 'eu-2500x1250', w: 2500, h: 1250 },
  { id: 'ops-900x600', w: 900, h: 600 },
];

/** THE OLD RULE, copied so it can be watched failing — the expression `App.tsx`
 *  carried at `:6447` until this change. Note it is matched UNORDERED, which is
 *  correct and is kept: a sheet is the same sheet whichever way it is laid. */
function oldWorkpieceIds(stockX: number, stockY: number): string[] {
  return SHEETS.filter(
    (s) => (s.w === stockX && s.h === stockY) || (s.h === stockX && s.w === stockY)
  ).map((s) => rowId('sheet', s.id));
}

/** A workpiece somebody cut down and saved: an offcut, matching no stock size. */
const OFFCUT = {
  stockX: 1234,
  stockY: 610,
  thickness: 18,
  material: 'Plywood',
  originX: 0,
  originY: 0,
  rotation: 0,
  zZeroTop: true,
};
const OFFCUT_ID = rowId('saved', 'Offcut from the door job');

test('THE DEFECT — the old rule cannot tick a saved workpiece either', () => {
  // 🔴 The machine bug verbatim, one section down, and it shipped for one commit
  // after the machine one was fixed. Same shape: the ticked set is the SHIPPED
  // CATALOGUE filtered by a dimension, so no workpiece the operator saved can
  // ever appear in it.
  const old = oldWorkpieceIds(OFFCUT.stockX, OFFCUT.stockY);
  assert.deepEqual(old, [], 'the old rule ticks nothing for a saved workpiece');
  /* `never[]` after the assertion signature above — see the machine case. */
  assert.ok(!(old as string[]).includes(OFFCUT_ID));

  // And the collision case, which is worse than showing nothing: a saved
  // workpiece cut to a full sheet size makes the app tick the CATALOGUE ROW —
  // naming a published stock size when what was loaded was the operator's own
  // record, including its thickness, datum and material.
  const collides = oldWorkpieceIds(1200, 2400);
  assert.deepEqual(collides, ['sheet:au-2400x1200'], 'unordered matching, kept');
  assert.ok(!collides.includes(rowId('saved', 'Full sheet')));
});

test('THE FIX — the workpiece that was loaded is the workpiece that is ticked', () => {
  const ids = selectedIdsWithLoaded(
    oldWorkpieceIds(OFFCUT.stockX, OFFCUT.stockY),
    { id: OFFCUT_ID, snapshot: OFFCUT },
    OFFCUT
  );
  assert.deepEqual(ids, [OFFCUT_ID]);
});

test('a saved workpiece the size of a catalogue sheet ticks BOTH', () => {
  const full = { ...OFFCUT, stockX: 2400, stockY: 1200 };
  const id = rowId('saved', 'Full sheet');
  assert.deepEqual(
    selectedIdsWithLoaded(oldWorkpieceIds(2400, 1200), { id, snapshot: full }, full),
    ['sheet:au-2400x1200', id],
    'a saved workpiece cut from a stock size must not unselect that stock size'
  );
});

test('the workpiece tick DROPS the moment any of the eight fields moves', () => {
  // 🔴 INCLUDING THE MATERIAL, which is the field this change moved into the
  // workpiece. A tick that survived a material change would say "this is the
  // saved workpiece" over a panel whose feeds have all been rescaled.
  const loaded = { id: OFFCUT_ID, snapshot: OFFCUT };
  for (const [field, value] of [
    ['stockX', 1235],
    ['stockY', 611],
    ['thickness', 17.6],
    ['material', 'MDF'],
    ['originX', 10],
    ['originY', 10],
    ['rotation', 90],
    ['zZeroTop', false],
  ] as Array<[string, unknown]>) {
    const edited = { ...OFFCUT, [field]: value };
    assert.deepEqual(
      selectedIdsWithLoaded([], loaded, edited),
      [],
      `editing ${field} left the workpiece ticked — the panel no longer describes it`
    );
  }
});

test('a workpiece with NO stored material — the snapshot is what the panel WILL hold', () => {
  /* 🔴 THE CASE THAT MAKES THE SNAPSHOT RULE LOAD-BEARING RATHER THAN STYLISTIC.
   * A workpiece saved before this app recorded a material comes back with
   * `material: undefined`. `App.tsx` deliberately does NOT write that into the
   * job — an undefined material reaches `JobConfig.material` and from there the
   * chipload — so the panel KEEPS the material it already had.
   *
   * Therefore the snapshot must carry the material the panel will hold, not the
   * one the record stated. Snapshotting the record would compare `undefined`
   * against `'Plywood'` on the very first render, the tick would never appear,
   * and the fix would look like it had not worked. */
  const record = { ...OFFCUT, material: undefined };
  const panelAfterLoad = { ...OFFCUT, material: 'Plywood' }; // the job's existing material, kept

  const wrong = selectedIdsWithLoaded([], { id: OFFCUT_ID, snapshot: record }, panelAfterLoad);
  assert.deepEqual(wrong, [], 'snapshotting the raw record ticks nothing — this is the trap');

  const right = selectedIdsWithLoaded(
    [],
    { id: OFFCUT_ID, snapshot: panelAfterLoad },
    panelAfterLoad
  );
  assert.deepEqual(right, [OFFCUT_ID]);

  // And it still drops on an edit — the guarantee is not weakened by the case.
  assert.deepEqual(
    selectedIdsWithLoaded([], { id: OFFCUT_ID, snapshot: panelAfterLoad }, {
      ...panelAfterLoad,
      material: 'MDF',
    }),
    []
  );
});

/* ══════════════════════════════════════════════════════════════════════════
   THE COMPARISON ITSELF — shared by both callers
   ══════════════════════════════════════════════════════════════════════════ */

test('a field added to the setup later is compared without editing any list', () => {
  // 🔴 The point of the key-union walk. A hand-written field list here would go
  // stale the next time `SavedMachine` or `SavedWorkpiece` grows, and a
  // comparison blind to a new field reports "unchanged" for a setup that
  // changed — this file's own defect, one level down.
  const withNew = { ...MINE, someFieldAddedIn2027: 12 };
  assert.equal(sameSnapshot(MINE, withNew), false, 'a key present on one side only is a difference');
  assert.equal(sameSnapshot(withNew, MINE), false, 'and in the other direction');
});

test('an omitted key and an undefined key are the same answer', () => {
  // `currentMachine()` OMITS `spoilboardTravels` when there is none rather than
  // writing null. A comparison that called absent-vs-undefined a change would
  // drop the tick immediately on every machine with no declared board — i.e. on
  // the ordinary case.
  assert.equal(sameSnapshot(MINE, { ...MINE, spoilboardTravels: undefined }), true);
  assert.equal(sameSnapshot({ ...MINE, spoilboardTravels: [600, 900, 100] }, MINE), false);
  assert.equal(
    sameSnapshot(
      { ...MINE, spoilboardTravels: [600, 900, 100] },
      { ...MINE, spoilboardTravels: [600, 900, 100] }
    ),
    true,
    'the travels fingerprint is compared element-wise, not by reference'
  );
  assert.equal(
    sameSnapshot(
      { ...MINE, spoilboardTravels: [600, 900, 100] },
      { ...MINE, spoilboardTravels: [600, 900, 101] }
    ),
    false
  );
});

test('a null snapshot is never "the same" — absence is not a match', () => {
  assert.equal(sameSnapshot(null, MINE), false);
  assert.equal(sameSnapshot(MINE, null), false);
  assert.equal(sameSnapshot(null, null), false);
});

/* ══════════════════════════════════════════════════════════════════════════
   THE CALLERS — because a rule nothing calls is not a fix
   ══════════════════════════════════════════════════════════════════════════

   🔴 EVERY TEST ABOVE PASSES ON THE BROKEN APP. They exercise the module; the
   defect was in `App.tsx`, which could go on computing its ticked set from the
   catalogue with this file green beside it. That is the guard-armed-in-the-
   callee-but-never-by-the-caller shape, and it is the reason these two text
   guards exist at all.

   ⚠ A TEXT GUARD PROVES "UNCHANGED", NEVER "CORRECT". It proves the pickers are
   wired through this module with the loaded row in hand. It does not prove a
   tick appears on screen — no browser here, and `App.tsx` does not import in
   node (`Unknown file extension ".dxf"`). */

const APP = new URL('../src/App.tsx', import.meta.url);
const appSrc = (await import('node:fs')).readFileSync(APP, 'utf8');
/* CODE, NOT PROSE: `App.tsx` quotes the old expressions in the comments that
 * record why they went. A guard matching those would vouch for the defect it is
 * meant to catch. */
const appCode = appSrc.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

test('BOTH pickers compute their tick through this module, with the loaded row', () => {
  assert.ok(appCode.length > 40_000, 'comment stripping ate App.tsx — this guard is blind');

  // The machine — the reported bug.
  assert.ok(
    /selectedIds=\{selectedIdsWithLoaded\(\s*MACHINE_PRESETS\.filter\(/.test(appCode),
    'the Machine picker no longer goes through selectedIdsWithLoaded'
  );
  assert.ok(/loadedMachine,/.test(appCode), 'the Machine picker does not pass what was loaded');

  // The workpiece — the same defect, and the one this change fixes.
  assert.ok(
    /selectedIds=\{selectedIdsWithLoaded\(\s*SHEET_SIZES\.filter\(/.test(appCode),
    'the Workpiece picker computes its tick from the sheet catalogue alone again — a saved ' +
      'workpiece can never appear in that set'
  );
  assert.ok(
    /loadedWorkpiece,/.test(appCode),
    'the Workpiece picker does not pass what was loaded, so the module has nothing to add'
  );

  // And the latch is CLEARED on the catalogue arms, or a stale record stays
  // ticked over a setup it no longer describes.
  assert.ok(
    /setLoadedMachine\(null\);/.test(appCode) && /setLoadedWorkpiece\(null\);/.test(appCode),
    'a preset/sheet choice no longer clears the saved latch'
  );
});

test('the workpiece snapshot is the PANEL it will hold, not the record it came from', () => {
  /* 🔴 ARMED AT THE CALLER, because the module test above proves only that the
   * trap exists — planted: change `App.tsx` to snapshot `w.material` and every
   * other test in this repo stays green while the tick never appears again.
   *
   * The two differ on exactly one field and only for one kind of record: a
   * workpiece saved before this app kept a material states none, `App.tsx`
   * deliberately does not write `undefined` into the job, so the panel keeps the
   * material it had — and THAT is what the tick must compare against. */
  assert.ok(
    /material: stated \?\? material,/.test(appCode),
    'the workpiece snapshot no longer records the material the panel will actually hold, so a ' +
      'record that states none can never tick'
  );
});
