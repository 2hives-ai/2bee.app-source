// Two narrowing controls that AND together, and who gets the blame for a short list.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE
// ─────────────────────────────────────────────────────────────────────────────
//
// Founder, 2026-08-11: *"in the tool section add a drop down filter: Selected
// (this will show the selected tools); same for all other lists"*.
//
// 🔴 IT IS A SECOND, INDEPENDENT AXIS — not an alternative to the facet that
// already exists. A tool can be **selected and not recommended**, which is
// exactly the case an operator most wants to look at, so *Selected* and
// *Recommendation* have to AND together. `ObjectPicker`'s `facet` prop was
// singular; making it plural is the substance of the change.
//
// 🔴 AND THE THING THAT WILL BE GOT WRONG IS THE ATTRIBUTION. `ObjectPicker`'s
// rule 1 is that a hidden row is COUNTED and named — *"12 hidden (9 by the
// Material filter, 3 by search)"* — because on screen a hidden item and a
// non-existent item are identical, and a bare total sends the operator to clear
// the wrong control. A third filter means a third column in that sentence, and
// with ANDed filters the counts only add up if they are taken SEQUENTIALLY.
//
// ⚠ WHAT THIS FILE CANNOT REACH. There is no browser here, so nothing below
// clicks a dropdown or observes a re-render. It drives `narrowingStages`, which
// is the rule itself, pure and exported for exactly that reason. The control
// wiring is `web/e2e/`'s leg.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { narrowingStages, SELECTED_FACET_LABEL } = await import('../src/ObjectPicker.tsx');
type ObjectItem = import('../src/ObjectPicker.tsx').ObjectItem;
type Facet = import('../src/ObjectPicker.tsx').Facet;

const item = (id: string, facet?: string): ObjectItem => ({ id, name: id, facet });

/** Six rows: three recommended, and a selection that CROSSES that split — which
 *  is the whole reason the two axes cannot be one control. */
const ITEMS: ObjectItem[] = [
  item('a', 'recommended'),
  item('b', 'recommended'),
  item('c', 'recommended'),
  item('d', 'not-for-this-job'),
  item('e', 'not-for-this-job'),
  item('f'), // states nothing ⇒ `unknown`
];
const SELECTED = new Set(['a', 'd']); // one recommended, one not

const recommendation = (value: string): Facet => ({
  label: 'Recommendation',
  value,
  options: [],
  onChange: () => {},
  matches: (it, v) => (it.facet ?? 'unknown') === v,
});

const selectedFacet = (value: string, snap: Set<string> = SELECTED): Facet => ({
  label: SELECTED_FACET_LABEL,
  value,
  options: [],
  onChange: () => {},
  matches: (it, v) => (v === 'selected' ? snap.has(it.id) : !snap.has(it.id)),
});

test('a facet that is not set narrows nothing and claims nothing', () => {
  const s = narrowingStages(ITEMS, [recommendation(''), selectedFacet('')]);
  assert.equal(s.rows.length, 6);
  assert.deepEqual(s.byFacet, [], 'an inactive filter appeared in the attribution');
});

test('the two axes AND together — selected AND not recommended is a reachable view', () => {
  /* 🔴 THE CASE THE FOUNDER ASKED FOR, AND THE ONE A SINGLE FACET COULD NOT
   * EXPRESS. `d` is selected and NOT recommended. If the new filter had replaced
   * the old one, this view would not exist. */
  const s = narrowingStages(ITEMS, [recommendation('not-for-this-job'), selectedFacet('selected')]);
  assert.deepEqual(s.rows.map((r) => r.id), ['d']);

  const both = narrowingStages(ITEMS, [recommendation('recommended'), selectedFacet('selected')]);
  assert.deepEqual(both.rows.map((r) => r.id), ['a']);
});

test('attribution is SEQUENTIAL and the counts sum to the total exactly', () => {
  /* Recommendation removes 3 (d, e, f). Selected then removes 2 more (b, c) from
   * what is left. 3 + 2 = 5 hidden of 6, one shown — and a per-facet "this one
   * alone would hide N" would have said 3 and 4, which sums to 7 of 6. */
  const s = narrowingStages(ITEMS, [recommendation('recommended'), selectedFacet('selected')]);
  assert.deepEqual(s.byFacet, [
    { label: 'Recommendation', hidden: 3 },
    { label: SELECTED_FACET_LABEL, hidden: 2 },
  ]);
  const summed = s.byFacet.reduce((n, f) => n + f.hidden, 0);
  assert.equal(summed + s.rows.length, ITEMS.length, 'the attributed counts do not add up');
});

test('a row hidden by two controls is reported under the FIRST, and moves when it is cleared', () => {
  /* 🔴 THE PROPERTY THAT MAKES SEQUENTIAL ATTRIBUTION HONEST rather than merely
   * arithmetic: it matches what the operator experiences when they clear one
   * control at a time. `e` fails both filters; while both are on it is counted
   * against Recommendation, and clearing Recommendation moves it to Selected
   * rather than making it appear. */
  const both = narrowingStages(ITEMS, [recommendation('recommended'), selectedFacet('selected')]);
  assert.equal(both.byFacet[0].hidden, 3);

  const cleared = narrowingStages(ITEMS, [recommendation(''), selectedFacet('selected')]);
  assert.deepEqual(cleared.byFacet, [{ label: SELECTED_FACET_LABEL, hidden: 4 }]);
  assert.deepEqual(cleared.rows.map((r) => r.id), ['a', 'd']);
});

test('“Not selected” is the exact complement, so the two options partition the rows', () => {
  const sel = narrowingStages(ITEMS, [selectedFacet('selected')]).rows.map((r) => r.id);
  const un = narrowingStages(ITEMS, [selectedFacet('unselected')]).rows.map((r) => r.id);
  assert.deepEqual(sel, ['a', 'd']);
  assert.deepEqual(un, ['b', 'c', 'e', 'f']);
  assert.equal(sel.length + un.length, ITEMS.length);
  assert.equal(sel.some((id) => un.includes(id)), false, 'a row is in both halves');
});

test('the empty result is a real state, and the attribution still names who caused it', () => {
  /* 🔴 THE FAILURE CASE: with *Selected* active, deselecting the last row empties
   * the list. That must not read as "the app lost my tools" — the count says
   * which control emptied it, and the total still adds up, which is what the
   * foot's "show all N" is offered against. */
  const s = narrowingStages(ITEMS, [selectedFacet('selected', new Set())]);
  assert.deepEqual(s.rows, []);
  assert.deepEqual(s.byFacet, [{ label: SELECTED_FACET_LABEL, hidden: 6 }]);
  assert.equal(s.byFacet[0].hidden, ITEMS.length, 'an empty list with an unattributed cause');
});

test('a DISABLED row is narrowed exactly like any other — rule 1 is not bent by a facet', () => {
  /* 🔴 Nothing in this component may hide a row for being unusable: a disabled
   * row is the one an operator most needs to see, because its reason is why they
   * cannot use it. `narrowingStages` never reads `disabled`, and the proof is
   * that a disabled row survives a filter it matches. */
  const rows: ObjectItem[] = [
    { id: 'x', name: 'x', facet: 'recommended', disabled: true, disabledReason: 'no collet holds it' },
    { id: 'y', name: 'y', facet: 'recommended' },
  ];
  const s = narrowingStages(rows, [recommendation('recommended')]);
  assert.deepEqual(s.rows.map((r) => r.id), ['x', 'y']);
  assert.deepEqual(s.byFacet, [{ label: 'Recommendation', hidden: 0 }]);
});

test('the built-in facet goes LAST, so adding it cannot re-attribute a host facet', () => {
  /* Order is a contract here, not an accident: inserting a filter ahead of an
   * existing one silently moves rows from one control's column to another's, and
   * the host's number would change for a reason the host did not cause. */
  const hostFirst = narrowingStages(ITEMS, [recommendation('recommended'), selectedFacet('selected')]);
  const hostAlone = narrowingStages(ITEMS, [recommendation('recommended')]);
  assert.equal(
    hostFirst.byFacet[0].hidden,
    hostAlone.byFacet[0].hidden,
    'the host facet’s own count changed when the built-in one was added'
  );
});
