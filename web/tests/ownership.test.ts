// The per-row ownership control — `web/src/ownership.ts`, and its wiring in
// `App.tsx` / `ObjectPicker.tsx`. TODO #105.
//
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 WHAT THIS FILE CANNOT SEE, SAID FIRST
// ═══════════════════════════════════════════════════════════════════════════
//
// There is no browser here. Nothing below proves a `<select>` rendered, that a
// press reached IndexedDB, or that a row went grey. What is asserted is the set
// that would actually go wrong:
//
//   · the CHOICES, as pure functions — which verdicts are offered, which are
//     refused, and what each refusal says;
//   · the CONSEQUENCE sentences, which are the only warning an operator gets
//     before a press changes what every other row in the list means;
//   · the WIRING, as source text — that the writer touches the inventory
//     document and nothing else, and that the four pickers pass a control at
//     all.
//
// ⚠ SOURCE-TEXT ASSERTIONS GO BLIND RATHER THAN GREEN when the code they read is
// rewritten, so every one below asserts its needle was FOUND before asserting
// anything about it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  addOperatorEntry,
  EMPTY_INVENTORY,
  INVENTORY_KINDS,
  inventoryDefaultId,
  mergeInventory,
  removeEntry,
  type InventoryDoc,
  type InventoryKind,
} from '../src/inventory.ts';
import {
  firstMarkConsequence,
  KIND_NOTE,
  lastUnmarkConsequence,
  MACHINE_EXCLUSIVITY,
  machineCountNote,
  NOT_HELD_AND_THE_PLAN,
  ownershipChoices,
} from '../src/ownership.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const source = (...p: string[]) => readFileSync(join(HERE, '..', 'src', ...p), 'utf8');
const app = source('App.tsx');
const picker = source('ObjectPicker.tsx');

/** Comments removed, so a needle cannot match the prose that discusses it. */
const code = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[^\n]*?\/\/[^\n]*$/gm, ' ');
const appCode = code(app);

const CATALOGUE = [
  { id: 'a', name: 'A' },
  { id: 'b', name: 'B' },
];

/* ════════════════════════════════════════════════════════════════════════════
   1. THE PLANT: a tri-state rendering as two
   ════════════════════════════════════════════════════════════════════════════ */

/**
 * 🔴 `unchecked` AND `not-held` ARE DIFFERENT ANSWERS AND THE CONTROL MUST SAY
 * BOTH. A checkbox — the obvious build — has two positions and would have to
 * merge them; `docs/terminology.md` carries that merge as one of the nine
 * safety-bearing distinctions, and `inventory.ts`'s own header says collapsing
 * any pair *"is the defect, not a simplification"*.
 *
 * ⚠ WATCHED RED: dropping the `unchecked` entry from `ownershipChoices` fails
 * this on every kind and in both inventory states.
 */
test('every kind offers three distinct verdicts, never two', () => {
  for (const kind of INVENTORY_KINDS) {
    for (const heldInKind of [0, 1, 7]) {
      const values = ownershipChoices({ kind, heldInKind, state: 'unchecked' }).map((o) => o.value);
      assert.equal(new Set(values).size, values.length, `${kind}: an option is listed twice`);
      for (const needed of ['held', 'not-held', 'unchecked'] as const) {
        assert.ok(
          values.includes(needed),
          `${kind} at ${heldInKind}: "${needed}" is not offered — the tri-state is rendering as two`,
        );
      }
    }
  }
});

/**
 * 🔴 AN UNAVAILABLE OPTION IS LISTED WITH ITS REASON, NEVER DROPPED. Rule 1 of
 * the picker, applied to a control instead of a row: on screen a hidden option
 * and a non-existent one are identical, and the difference here decides whether
 * somebody imports an inventory file or concludes the app cannot record a "no".
 */
test('an option that cannot be chosen is present and says why', () => {
  const fresh = ownershipChoices({ kind: 'tool', heldInKind: 0, state: 'unchecked' });
  const no = fresh.find((o) => o.value === 'not-held')!;
  assert.ok(no.unavailable, 'with nothing recorded, "no" is offered as if it could be written');
  assert.match(no.unavailable!, /stores what you HAVE/);
  assert.match(no.unavailable!, /UNCHECKED/);

  const listed = ownershipChoices({ kind: 'tool', heldInKind: 3, state: 'not-held' });
  assert.equal(
    listed.find((o) => o.value === 'not-held')!.unavailable,
    undefined,
    'once a list exists, "no" is writable and must not be refused',
  );
  const unchecked = listed.find((o) => o.value === 'unchecked')!;
  assert.ok(unchecked.unavailable, '"not checked" is offered as a per-row choice, which it is not');
  assert.match(unchecked.unavailable!, /fact about every cutter at once/);
});

/**
 * ⚠ THE `unresolved` VERDICT IS RENDERABLE AND NOT CHOOSABLE. A `<select>` whose
 * value is absent from its options silently shows the FIRST one — a verdict
 * nobody holds, presented as the row's own.
 */
test('unresolved is offered only as the row’s current value, and never as a choice', () => {
  const notThere = ownershipChoices({ kind: 'tool', heldInKind: 2, state: 'held' });
  assert.ok(!notThere.some((o) => o.value === 'unresolved'));

  const there = ownershipChoices({ kind: 'tool', heldInKind: 2, state: 'unresolved' });
  const row = there.find((o) => o.value === 'unresolved');
  assert.ok(row, 'an unresolved row has no option matching its own value — the box would lie');
  assert.ok(row!.unavailable, 'unresolved is offered as something an operator can assert');
});

/* ════════════════════════════════════════════════════════════════════════════
   2. THE PLANT: a default that asserts ownership
   ════════════════════════════════════════════════════════════════════════════ */

/**
 * 🔴 NOTHING PRESELECTS. `WHY_NO_DEFAULT` exists because *"a default that looks
 * like a selection is a setup nobody chose, presented as one somebody did"*, and
 * a control whose opening position reads `held` would be that defect wearing a
 * dropdown.
 */
test('an empty inventory grants no default, and the control opens on the row’s own verdict', () => {
  for (const kind of INVENTORY_KINDS) {
    assert.equal(inventoryDefaultId(kind), null, `${kind} gained a default`);
    const view = mergeInventory({ kind, doc: EMPTY_INVENTORY, catalogue: CATALOGUE, now: 0 });
    for (const r of view.rows) {
      assert.equal(r.ownership.state, 'unchecked', `${kind}/${r.id} is not UNCHECKED with no file`);
      assert.equal(r.disabled, false, 'UNCHECKED disabled a row — that is not-held’s job');
    }
  }
  /* And the wiring reads the verdict rather than choosing one. */
  assert.match(
    appCode,
    /value: row\.ownership\.state,/,
    'the control no longer opens on the row’s own verdict — blind, not green',
  );
});

/* ════════════════════════════════════════════════════════════════════════════
   3. The consequence an operator is owed BEFORE the press
   ════════════════════════════════════════════════════════════════════════════ */

/**
 * 🔴 THE FIRST MARK CHANGES WHAT EVERY OTHER ROW MEANS. `unchecked` is a fact
 * about the KIND, so the moment one entry exists the rest of the list is
 * `not-held` and disabled. That is exercised against `inventory.ts` itself here,
 * not asserted from the sentence — the sentence is then checked to be about the
 * behaviour it describes.
 */
test('marking one row moves every other row of that kind from UNCHECKED to NOT OWNED', () => {
  const doc: InventoryDoc = addOperatorEntry(EMPTY_INVENTORY, { kind: 'tool', id: 'a' }, 0);
  const view = mergeInventory({ kind: 'tool', doc, catalogue: CATALOGUE, now: 0 });
  const a = view.rows.find((r) => r.id === 'a')!;
  const b = view.rows.find((r) => r.id === 'b')!;
  assert.equal(a.ownership.state, 'held');
  assert.equal(b.ownership.state, 'not-held', 'the untouched row stayed UNCHECKED');
  assert.equal(b.disabled, true, 'a NOT OWNED row is selectable');

  const warn = firstMarkConsequence({ kind: 'tool', heldInKind: 0, state: 'unchecked' });
  assert.ok(warn, 'the first mark carries no warning');
  assert.match(warn!, /every OTHER cutter/);
  assert.match(warn!, /NOT OWNED/);
  assert.equal(
    firstMarkConsequence({ kind: 'tool', heldInKind: 1, state: 'not-held' }),
    null,
    'the first-mark warning is permanent — one shown while untrue is one nobody reads',
  );
});

/** And the way back is symmetrical, and is NOT "you own none of them". */
test('removing the last entry returns the kind to UNCHECKED, and says so', () => {
  const doc = addOperatorEntry(EMPTY_INVENTORY, { kind: 'tool', id: 'a' }, 0);
  const back = removeEntry(doc, 'tool', 'a');
  const view = mergeInventory({ kind: 'tool', doc: back, catalogue: CATALOGUE, now: 0 });
  for (const r of view.rows) assert.equal(r.ownership.state, 'unchecked');

  const warn = lastUnmarkConsequence({ kind: 'tool', heldInKind: 1, state: 'held' });
  assert.ok(warn, 'the last unmark carries no warning');
  assert.match(warn!, /NOT the/);
  assert.match(warn!, /UNCHECKED/);
  assert.equal(lastUnmarkConsequence({ kind: 'tool', heldInKind: 4, state: 'held' }), null);
});

/* ════════════════════════════════════════════════════════════════════════════
   4. The three kinds that are not the same question
   ════════════════════════════════════════════════════════════════════════════ */

/**
 * ⚠ A BOARD IS STOCK. *"Do I have this"* is a quantity question there, and the
 * answer this app records is PRESENCE — so the control says so rather than
 * letting a shop with one board left read identically to one with forty.
 */
test('the spoilboard control states that it records presence and not a count', () => {
  assert.match(KIND_NOTE.spoilboard, /PRESENCE, not a count/);
  assert.match(KIND_NOTE.spoilboard, /three answers and not two/);
  /* And no quantity exists anywhere in the model to contradict it. */
  const inv = source('inventory.ts');
  assert.ok(
    !/\bquantity\b|\bqty\b|on_hand/i.test(inv.replace(/no quantities-on-hand economics/, '')),
    'a quantity crept into the inventory model while the control says there is none',
  );
});

/**
 * 🔴 OWNING A CLAMP IS NOT THE MACHINE BEING CLEAR. `Fixturing::confirmed_clear`
 * is an attestation about TODAY which `App.tsx` deliberately refuses to restore,
 * and the hold-down control lands next to it.
 */
test('the work-holding control says it is not the bed-clear attestation, and does not touch it', () => {
  assert.match(KIND_NOTE.workholding, /NOT the statement that the machine/);
  assert.match(KIND_NOTE.workholding, /never restored/);

  const writer = /const claimOwnership = useCallback\(([\s\S]*?)\n  \);/.exec(appCode);
  assert.ok(writer, 'the ownership writer was renamed — blind, not green');
  assert.doesNotMatch(
    writer![1],
    /confirmedClear|setConfirmedClear/,
    'the ownership writer reaches the bed-clear attestation',
  );
  /* It touches the inventory document and nothing else — no selection either. */
  assert.doesNotMatch(
    writer![1],
    /setToolIds|setWorkholdingId|setSpoilboardId|setTravel/,
    'the ownership writer edits the operator’s selection as a side effect of a stock-take',
  );
});

/**
 * 🔴 THE MACHINE DECISION: no silent exclusivity. Marking a second machine does
 * not unmark the first, because that would be this app deleting a claim a human
 * made as a side effect of a different press.
 */
test('a second machine is accepted and reported, never silently swapped', () => {
  let doc = addOperatorEntry(EMPTY_INVENTORY, { kind: 'machine', id: 'one' }, 0);
  doc = addOperatorEntry(doc, { kind: 'machine', id: 'two' }, 0);
  const kept = doc.entries.filter((e) => e.kind === 'machine').map((e) => e.id).sort();
  assert.deepEqual(kept, ['one', 'two'], 'marking a second machine unmarked the first');

  assert.match(MACHINE_EXCLUSIVITY, /Nothing here unmarks another machine/);
  const note = machineCountNote('machine', 2);
  assert.ok(note, 'two marked machines are not reported');
  assert.match(note!, /2 machines/);
  assert.equal(machineCountNote('machine', 1), null, 'one machine is reported as a problem');
  assert.equal(machineCountNote('tool', 9), null, 'the machine note fired on another kind');

  /* And the writer adds ONE id — no loop over the kind. */
  const writer = /const claimOwnership = useCallback\(([\s\S]*?)\n  \);/.exec(appCode);
  assert.ok(writer);
  assert.match(writer![1], /addOperatorEntry\(inventory, \{ kind, id \}, now\)/);
  assert.doesNotMatch(writer![1], /\.filter\(|for \(/, 'the writer walks the kind — exclusivity by stealth');
});

/* ════════════════════════════════════════════════════════════════════════════
   5. THE PLANT: a not-held item reaching the plan with no note
   ════════════════════════════════════════════════════════════════════════════ */

/**
 * 🔴 WHETHER THE PLANNER MAY USE SOMETHING MARKED `not-held` IS A STATED
 * DECISION. It may, the selection is not edited for the operator, and the job
 * carries a refusal NAMING the item. All four pickers must have that sentence —
 * and the machine one did not exist until this change, because a machine is ten
 * numbers rather than an id and there was nothing to resolve.
 */
test('every picker can name an unowned selection — including the machine', () => {
  assert.match(NOT_HELD_AND_THE_PLAN, /does not deselect it/);
  assert.match(NOT_HELD_AND_THE_PLAN, /does not stop/);
  for (const id of [
    'spoilboard-inventory-refused',
    'workholding-inventory-refused',
    'tool-inventory-refused',
    'machine-inventory-refused',
  ]) {
    assert.ok(app.includes(`data-testid="${id}"`), `${id} is not rendered — an unowned selection is silent`);
  }
  /* The machine one hedges, because matching travels is not identity. */
  const m = /data-testid="machine-inventory-refused"[\s\S]{0,900}?<\/p>/.exec(app);
  assert.ok(m, 'the machine refusal moved — blind, not green');
  assert.match(m![0], /travels set up here match/);
  assert.match(m![0], /still be planned/);
});

/* ════════════════════════════════════════════════════════════════════════════
   6. It is wired, on all four
   ════════════════════════════════════════════════════════════════════════════ */

test('all four inventory-backed pickers pass an ownership control', () => {
  const kinds: InventoryKind[] = ['machine', 'spoilboard', 'workholding', 'tool'];
  for (const k of kinds) {
    assert.match(
      appCode,
      new RegExp(`claim: ownershipClaim\\(\\s*'${k}'`),
      `the ${k} picker has no per-row ownership control`,
    );
  }
  /* 🔴 AND THE STATED DECISION REACHES A SCREEN. `NOT_HELD_AND_THE_PLAN` is the
   * answer to "may the planner use something marked not-held" — a constant with
   * no consumer would be a decision accruing authority nobody reads. It is shown
   * on the rows where it is true, which is the ones currently in the setup. */
  assert.match(
    appCode,
    /selected \? `\$\{KIND_NOTE\[kind\]\} \$\{NOT_HELD_AND_THE_PLAN\}` : KIND_NOTE\[kind\]/,
    'the planner decision is stated in a constant and rendered nowhere',
  );
  /* And the picker renders one when it is given one. */
  assert.match(picker, /previewItem\.claim \?/, 'ObjectPicker stopped rendering the claim control');
  assert.match(picker, /data-testid=\{`\$\{testid\}-claim-select`\}/);
  /* 🔴 THE SECOND LOCK. `disabled` on an <option> stops a pointer and a
   * keyboard; a driver setting `.value` directly is stopped here. */
  assert.match(picker, /if \(!next \|\| next\.unavailable\) return;/);
});

/**
 * ⚠ THE CONTROL IS ON THE PROPERTIES PANEL, NOT IN THE LIST — a `role="option"`
 * must not contain a focusable control, and a claim is not a mouse-only
 * shortcut like the row's remove `×`.
 */
test('the claim control is not inside a listbox option', () => {
  const li = /<li\s+key=\{it\.id\}([\s\S]*?)<\/li>/.exec(picker);
  assert.ok(li, 'the option row moved — blind, not green');
  assert.doesNotMatch(li![1], /claim/, 'the claim control is rendered inside a listbox option');
});
