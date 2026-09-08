/*
 * `All (3)` OVER FOUR ROWS — the assertion that would have caught it without
 * anyone reading a screen.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT THIS GUARDS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A `Facet` carries TWO host-supplied answers to one question: `options[].count`,
 * which is printed in the dropdown, and `matches`, which decides membership.
 * Nothing has ever compared them, and they are computed from different
 * expressions at every call site in `App.tsx` — the tool picker counts
 * `lib.tools + toolInv.extras`, the drawing picker counts `drawingItems`, the
 * workpiece picker counts `SHEET_SIZES + saved`. The day one of those drifts from
 * the array actually handed to `items`, the dropdown says one number and the list
 * shows another, and on a machining list that is the difference between walking
 * to the drawer and concluding the cutter does not exist.
 *
 * 🔴 THE GENERAL FORM, AND WHY IT IS GENERAL. It is not "the machine picker's
 * count is right" — that is one call site and the next one written would not be
 * covered. It is a property of the COMPONENT's contract: *for every facet, for
 * every option, the stated count equals the rows that option's own rule leaves,
 * over the full set.* Every picker in the app gets it, including ones nobody has
 * written yet, and including the built-in *Selected* facet.
 *
 * ⚠ WHAT IT DOES NOT SAY. Both numbers can be wrong TOGETHER — a host deriving
 * its rows and its counts from one stale list is self-consistent and still lying.
 * This catches the disagreement, which is the case that is invisible on screen.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { facetCountMismatches, describeFacetCountMismatch, narrowingStages } = await import(
  '../src/ObjectPicker.tsx'
);
type ObjectItem = import('../src/ObjectPicker.tsx').ObjectItem;
type Facet = import('../src/ObjectPicker.tsx').Facet;

/** Three shipped rows and the one the operator saved — the founder's list. */
const PRESETS: ObjectItem[] = [
  { id: 'preset:Bellwether Lead 1250x670', name: 'Bellwether Lead 1250x670' },
  { id: 'preset:MakerSpace 6090', name: 'MakerSpace 6090' },
  { id: 'preset:Desktop 3018', name: 'Desktop 3018' },
];
const SAVED: ObjectItem = { id: 'saved:Desktop 3018', name: 'Desktop 3018' };

/** The built-in *Selected* facet, in the shape the component builds it. */
function selectedFacet(items: readonly ObjectItem[], selected: Set<string>, value = ''): Facet {
  const inSnap = items.filter((it) => selected.has(it.id)).length;
  return {
    label: 'Selected',
    value,
    options: [
      { value: '', label: 'All', count: items.length },
      { value: 'selected', label: 'Selected', count: inSnap },
      { value: 'unselected', label: 'Not selected', count: items.length - inSnap },
    ],
    onChange: () => {},
    matches: (it, v) => (v === 'selected' ? selected.has(it.id) : !selected.has(it.id)),
  };
}

test('a well-built facet reports nothing', () => {
  const items = [...PRESETS, SAVED];
  const f = selectedFacet(items, new Set(['preset:MakerSpace 6090']));
  assert.deepEqual(facetCountMismatches(items, [f]), []);
  /* The positive half, so a function that returned `[]` unconditionally could
   * not pass this file: the counts it agreed with are the right ones. */
  assert.equal(f.options[0].count, 4);
  assert.equal(f.options[1].count, 1);
  assert.equal(f.options[2].count, 3);
});

test('🔴 THE PLANT — a count taken over the CATALOGUE while the list also holds what was saved', () => {
  /* This is the founder's paste, reconstructed as code: four rows in `items`,
   * and a count computed from the three shipped presets because the expression
   * that produced it never learned about the saved one. Under the old component
   * this rendered as `All (3)` above four rows and nothing anywhere objected. */
  const items = [...PRESETS, SAVED];
  const stale: Facet = {
    ...selectedFacet(items, new Set(['preset:MakerSpace 6090'])),
    options: [
      { value: '', label: 'All', count: PRESETS.length },
      { value: 'selected', label: 'Selected', count: 1 },
      { value: 'unselected', label: 'Not selected', count: 2 },
    ],
  };
  const found = facetCountMismatches(items, [stale]);
  assert.equal(found.length, 2, 'the disagreement was not reported for every option it affects');
  assert.deepEqual(found[0], { facet: 'Selected', option: 'All', stated: 3, actual: 4 });
  assert.deepEqual(found[1], { facet: 'Selected', option: 'Not selected', stated: 2, actual: 3 });

  /* The operator's sentence names BOTH numbers and the control they came from —
   * "the counts are wrong" would send nobody anywhere. */
  const said = describeFacetCountMismatch(found[0]);
  assert.match(said, /Selected filter/);
  assert.match(said, /count of 3/);
  assert.match(said, /matches 4/);
});

test('the check compares against the FULL set, so a second active facet cannot false-red it', () => {
  /* 🔴 The failure mode a naive version would have: facets AND together, so with
   * one of them active the VISIBLE rows are fewer than any count. A check that
   * compared against the narrowed list would light up on every picker the moment
   * a filter was used — and a control that false-fires gets muted, and then the
   * real one is muted too. */
  const items = [...PRESETS, SAVED];
  const material: Facet = {
    label: 'Material',
    value: 'Plywood',
    options: [
      { value: '', label: 'All materials', count: 4 },
      { value: 'Plywood', label: 'Plywood', count: 1 },
    ],
    onChange: () => {},
    matches: (it) => it.id === 'saved:Desktop 3018',
  };
  const sel = selectedFacet(items, new Set(['preset:MakerSpace 6090']), 'unselected');

  // Both facets are active and between them the list shows ONE row...
  const stages = narrowingStages(items, [material, sel]);
  assert.equal(stages.rows.length, 1);
  // ...and nothing is reported, because every count is over the full four.
  assert.deepEqual(facetCountMismatches(items, [material, sel]), []);
});

test('an empty facet list and an empty item list are both quiet', () => {
  assert.deepEqual(facetCountMismatches([...PRESETS], []), []);
  assert.deepEqual(facetCountMismatches([], [selectedFacet([], new Set())]), []);
});
