// The CNC tab's menu bar — `web/src/cncMenu.tsx` and its wiring in `App.tsx`.
// TODO #108, founder 2026-08-11: *"create similar menu in 2bee.cnc what already
// exists in 2bee.cad (File … etc)"*.
//
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 WHAT THIS FILE CANNOT SEE
// ═══════════════════════════════════════════════════════════════════════════
//
// There is no browser here, so nothing below proves a popup opened, that Escape
// returned focus, or that a click outside closed anything. The keyboard contract
// is asserted as SOURCE — which is what {@link MENUBAR_PARITY} is for: a list a
// future extraction can be checked against instead of eyeballed.
//
// What IS asserted properly, as data:
//
//   · no item exists for a function this tab does not have;
//   · every item id has a branch in the handler — the dead-control rule, from
//     both ends;
//   · the projection pair is exclusive in both states;
//   · **the obligation that moved.** `540bab9d66` put the CNC projection control
//     in the sidebar with its move into a `View` menu written into the code, and
//     claimed *"tests/projection.test.ts asserts this note exists"*. 🔴 NO SUCH
//     ASSERTION EXISTED — measured 2026-08-11, the sentence appeared in no file
//     but `App.tsx` itself. The obligation was carried by a comment claiming to
//     be carried by a test. It is asserted here now, in the form that survives
//     the move: the control is in the menu, the sidebar does NOT still hold one,
//     and the warning is still on the tab.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BOUND_KEYS,
  CNC_MENU_ABSENT,
  cncMenus,
  MENUBAR_PARITY,
  type CncMenuContext,
} from '../src/cncMenu.tsx';

const HERE = dirname(fileURLToPath(import.meta.url));
const source = (...p: string[]) => readFileSync(join(HERE, '..', 'src', ...p), 'utf8');
const app = source('App.tsx');
const bar = source('cncMenu.tsx');

const CTX: CncMenuContext = {
  projection: 'orthographic',
  /* TODO #109. The unit rows are this file's business only as MENU ITEMS — that
   * they exist, that every id is handled, that the pair is exclusive. What they
   * MEAN (mm canonical, no write-back, a byte-identical program) belongs to
   * `tests/units.test.ts`, which can drive the arithmetic and the wasm. */
  unit: 'mm',
  saveBlocked: null,
  hasStoredSetup: true,
};

const allItems = (ctx: CncMenuContext = CTX) => cncMenus(ctx).flatMap((m) => m.items);

/* ════════════════════════════════════════════════════════════════════════════
   1. No dead controls, in either direction
   ════════════════════════════════════════════════════════════════════════════ */

/**
 * 🔴 EVERY ITEM IS HANDLED. An item whose id nothing handles is a control that
 * looks live and is not — the defect both bars exist to avoid, and the way it
 * arrives is somebody adding an item and not the case.
 */
test('every menu item has a branch in the command handler', () => {
  const handler = /const runMenuCommand = \(id: string\) => \{([\s\S]*?)\n  \};/.exec(app);
  assert.ok(handler, 'the command handler was renamed — blind, not green');
  for (const it of allItems()) {
    assert.ok(
      handler![1].includes(`case '${it.id}':`),
      `"${it.id}" is in the menu and nothing handles it`,
    );
  }
  /* And the other direction: an unknown id is REPORTED, not swallowed. */
  assert.match(handler![1], /default:\s*\n\s*setJobNote\(/, 'an unhandled command is silent');
});

/**
 * 🔴 AN ACCELERATOR MAY ONLY NAME A KEY THIS BAR BINDS — and it binds none, for
 * a reason that is NOT the CAD tab's reason inverted: this tab has no unsaved
 * work, because the setup is written on every change.
 */
test('no accelerator is printed, because none is bound', () => {
  assert.deepEqual(Object.keys(BOUND_KEYS), [], 'this bar started binding keys');
  for (const it of allItems()) {
    assert.equal(it.accel, undefined, `"${it.id}" prints a key nothing binds`);
  }
  /* ⚠ AND NO SENTENCE NAMES ONE EITHER. A key inside free text cannot be
   * compared to `BOUND_KEYS`, which is how a four-keys-one-reason footnote went
   * unexamined in the CAD bar for weeks. The one place `Ctrl+S` may appear is
   * the explanation of why it is NOT bound. */
  const prose = cncMenus(CTX)
    .flatMap((m) => [m.footnote ?? '', ...m.items.map((i) => `${i.label} ${i.note ?? ''}`)])
    .join(' ');
  assert.doesNotMatch(prose, /Ctrl\+|Cmd\+|F5|F6/, 'a menu label or note advertises a key');
});

/** Every disabled item says why. A disabled control with no reason is a puzzle. */
test('a disabled item carries its reason', () => {
  const blocked = cncMenus({
    ...CTX,
    /* A realistic reason, not a placeholder: the assertion below is that a
       disabled item carries a SENTENCE, and a three-word fixture would let it
       pass over a bar that only ever prints three words. */
    saveBlocked:
      'The core and your stored setup are still loading, so a job saved now would carry the wrong cutter.',
    hasStoredSetup: false,
  });
  const disabled = blocked.flatMap((m) => m.items).filter((i) => i.disabled);
  assert.ok(disabled.length >= 2, 'nothing went disabled — this test is watching nothing');
  for (const it of disabled) {
    assert.ok(it.disabledReason && it.disabledReason.length > 30, `"${it.id}" is grey with no reason`);
  }
});

/* ════════════════════════════════════════════════════════════════════════════
   2. The projection pair, and the obligation that moved
   ════════════════════════════════════════════════════════════════════════════ */

/**
 * 🔴 EXCLUSIVE: one checked, never both, never neither. A single "Perspective"
 * checkbox would render the same state and say a different thing — it makes
 * orthographic the un-named absence of a mode, when on THIS tab it is the one a
 * fit or a clearance may be judged from.
 */
test('the projection pair is exclusive in both states', () => {
  for (const projection of ['perspective', 'orthographic'] as const) {
    const view = cncMenus({ ...CTX, projection }).find((m) => m.id === 'view')!;
    const pair = view.items.filter((i) => i.id.startsWith('view.projection.'));
    assert.equal(pair.length, 2, 'the projection pair is no longer a pair');
    assert.equal(pair.filter((i) => i.checked).length, 1, `both or neither checked at ${projection}`);
    assert.equal(
      pair.find((i) => i.checked)!.id,
      projection === 'perspective' ? 'view.projection.perspective' : 'view.projection.orthogonal',
    );
  }
});

/**
 * 🔴 THE OBLIGATION, DISCHARGED AND ASSERTED. The sidebar block MOVED — it did
 * not get copied. Two controls over one piece of state can disagree, and the
 * note that used to sit beside the sidebar control said so in as many words.
 */
test('the projection control moved into the menu and did NOT stay in the sidebar', () => {
  /* It drives the state that already existed, through the same setter. */
  assert.match(app, /case 'view\.projection\.orthogonal':\s*\n\s*chooseProjection\('orthographic'\)/);
  assert.match(app, /case 'view\.projection\.perspective':\s*\n\s*chooseProjection\('perspective'\)/);
  /* And the sidebar panel is gone: no second control, no second pair of buttons. */
  assert.ok(!app.includes('data-testid="view-projection"'), 'the sidebar still holds a Projection panel');
  assert.ok(
    !app.includes('data-testid={`projection-${p}`}'),
    'the sidebar still renders the projection buttons — two controls, one setting',
  );
  /* ⚠ THE WARNING DID NOT GO INTO THE MENU. A menu note is visible only while
   * the menu is open, and that sentence exists because a tooltip is something
   * you find after you already believe the picture. */
  assert.ok(app.includes('data-testid="projection-warning"'), 'the perspective warning left the tab');
  const menuProse = JSON.stringify(cncMenus(CTX));
  assert.doesNotMatch(
    menuProse,
    /Judge a fit or a clearance in orthographic/,
    'the on-screen warning was moved into the menu, where it is only visible while the menu is open',
  );
});

/**
 * ⚠ A `View` MENU MUST DRIVE EXISTING STATE, NEVER DUPLICATE IT. The layer eyes,
 * the section collapses and the panel widths are real controls in the sidebar.
 * The obvious next edit to this menu is a "Show/hide layers" item; the footnote
 * is where somebody about to write it is told not to.
 */
test('the View menu adds no second control over state the sidebar owns', () => {
  const view = cncMenus(CTX).find((m) => m.id === 'view')!;
  /* 🔴 THIS LIST GREW ON 2026-08-11 AND THE TEST WENT RED FIRST, WHICH IS THE
   * POINT OF IT. TODO #109 added the display-unit pair. It is allowed here on a
   * property, not on a judgement: **the unit setting has no sidebar control and
   * no other surface at all**, so the menu is its ONE control rather than a
   * second one — which `tests/units.test.ts` asserts from the other end by
   * counting `chooseUnit` call sites and sweeping `App.tsx` for a units chip.
   *
   * ⚠ THE NEXT PERSON ADDING A ROW STILL HAS TO ARGUE WITH THIS LINE. Widening
   * it to "any view-ish item" would turn the guard off; naming the four ids
   * keeps the cost of a duplicate exactly where it was. */
  assert.deepEqual(
    view.items.map((i) => i.id),
    [
      'view.projection.orthogonal',
      'view.projection.perspective',
      'view.units.mm',
      'view.units.in',
    ],
    'the View menu grew an item — check it is not a second copy of a sidebar control',
  );
  assert.ok(view.footnote, 'the View menu lost the footnote that says where the rest live');
  assert.match(view.footnote!, /NOT repeated here/);
  assert.match(view.footnote!, /can disagree/);
});

/* ════════════════════════════════════════════════════════════════════════════
   3. File — the bound, stated at save time
   ════════════════════════════════════════════════════════════════════════════ */

test('the File menu states what a job file cannot carry, before it is written', () => {
  const file = cncMenus(CTX).find((m) => m.id === 'file')!;
  assert.ok(file.footnote, 'the File menu lost its bound');
  for (const named of [/bed is clear|machine is clear/, /workpiece-edge/, /plant/]) {
    assert.match(file.footnote!, named, 'the bound does not name all three');
  }
  assert.match(file.footnote!, /SETUP, not the program/);
  /* Save is blocked while the async restore is in flight — a job written then
   * carries this build's default cutter over the operator's stored one. */
  const blocked = cncMenus({ ...CTX, saveBlocked: 'still loading' })
    .find((m) => m.id === 'file')!
    .items.find((i) => i.id === 'file.save-job')!;
  assert.equal(blocked.disabled, true, 'a job can be saved before the restore lands');
  /* ⚠ AND THE HANDLER REFUSES TOO. A disabled item is a picture; a keyboard or a
   * driver still reaches the handler. */
  const handler = /case 'file\.save-job': \{([\s\S]*?)\n      \}/.exec(app);
  assert.ok(handler, 'the save branch moved — blind, not green');
  assert.match(handler![1], /if \(!ready\)/, 'the save handler has no second lock');
});

/* ════════════════════════════════════════════════════════════════════════════
   4. Help → About — one constant, not a second list
   ════════════════════════════════════════════════════════════════════════════ */

test('Help → About renders the existing constants and the menu’s own omissions', () => {
  assert.match(app, /case 'help\.about':\s*\n\s*setAboutOpen\(true\)/);
  assert.match(app, /\{CNC_ABOUT_LINES\.map\(/, 'About stopped rendering the shared list');
  assert.match(app, /\{CNC_MENU_ABSENT\.map\(/, 'the menu’s omissions are recorded and shown nowhere');
  assert.ok(CNC_MENU_ABSENT.length >= 3);
  for (const line of CNC_MENU_ABSENT) {
    /* 🔴 EVERY LINE IS "the thing it would control does not exist here", never
     * "we did not get to it". One entry meaning the second devalues every other,
     * because a reader cannot tell them apart from the outside — the CAD bar had
     * to split its list in two the day that happened. */
    assert.ok(line.length > 80, 'an omission with no reason');
    assert.doesNotMatch(line, /not yet|to do|TODO|later/i, `an unbuilt thing is filed as a decision: ${line}`);
  }
});

/* ════════════════════════════════════════════════════════════════════════════
   5. The parity list — what a future extraction has to keep
   ════════════════════════════════════════════════════════════════════════════ */

/**
 * 🔴 THIS FILE IS A SECOND IMPLEMENTATION AND SAYS SO. The only structural
 * difference from `cad/menu.tsx` is that `label` is a required prop here and a
 * hard-coded string there — which is exactly why importing that one would give
 * this tab a bar a screen reader announces as the CAD tab's.
 */
test('the second implementation keeps the contract it declares', () => {
  assert.ok(MENUBAR_PARITY.length >= 6);
  for (const needle of [
    /role="menubar"/,
    /role="menu"/,
    /role="menuitem"/,
    /aria-haspopup="true"/,
    /aria-expanded=\{open === m\.id\}/,
    /tabIndex=\{focused === i \? 0 : -1\}/,
    /case 'Escape':/,
    /document\.addEventListener\('mousedown', away\)/,
  ]) {
    assert.match(bar, needle, `the menubar lost a property MENUBAR_PARITY claims it has: ${needle}`);
  }
  /* The label is a REQUIRED prop, and the caller passes this tab's own name. */
  assert.match(bar, /\blabel: string;/, 'the label became optional — the reason this file exists');
  assert.match(bar, /aria-label=\{label\}/, 'the bar hard-coded its own name, like the one it forked');
  assert.match(app, /label="2bee\.cnc menu"/, 'the CNC bar is not named, or is named as another tab');
  /* And the CAD bar is untouched — this change reads it and does not edit it. */
  assert.match(source('cad', 'menu.tsx'), /aria-label="2bee\.cad menu"/);
});
