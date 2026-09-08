// The 2bee.cad menu bar — `web/src/cad/menu.tsx`.
//
// WHAT THIS FILE EXERCISES
//
//   · 🔴 THAT NO ITEM EXISTS FOR A FUNCTION WE DO NOT HAVE. That is the same
//     rule the dock layout was held to, and it is the one that would fail
//     silently: a greyed-out `Export → AMF` looks like a considered decision
//     and is actually a promise nobody can keep. The command set is asserted
//     EXACTLY, so adding an item is a visible, reviewable edit rather than
//     something that slips in beside a real one.
//   · 🔴 THAT EVERY ADVERTISED ACCELERATOR IS A BOUND ONE. This assertion used
//     to be *"no accelerator is advertised"*, which was the right test while
//     the bar bound nothing. `Ctrl+S` is bound now (see below for why that one
//     and not the other three), so the test was INVERTED rather than deleted:
//     deleting it is what would eventually leave a printed `Ctrl+S` beside an
//     item that does nothing, which is the defect it was written for. Free text
//     in a label or a note still may not name a key at all — only the `accel`
//     field may, and only a key `BOUND_KEYS` lists.
//   · 🔴 THAT THE OMISSION LIST IS ONE KIND OF CLAIM AND ONLY ONE. An audit on
//     2026-08-11 found three entries that named things this tab HAS — the
//     camera, preferences, and six editor commands filed as the browser's job.
//     A list whose value is that "absent" means "impossible" cannot carry a
//     scope statement or a backlog item, so those moved to `GAPS` and the two
//     properties are asserted here AGAINST THE CODE that provides the
//     capability, not against a word list: if the camera ever leaves
//     `preview.tsx`, the first half goes red and says to move the entry back.
//   · That a disabled item carries its reason, because a disabled control with
//     no reason is a puzzle.
//   · The ARIA menubar wiring, because a keyboard user is the one who cannot
//     work around a broken menu.
//
// ⚠ NOT EXERCISED: nothing here presses a key. Arrow-key navigation is DOM
// behaviour and is asserted only as far as the attributes that make it possible
// — roving tabindex, `aria-haspopup`, `aria-expanded`. That the caret actually
// moves between items is a browser fact and is not claimed here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const HERE = dirname(fileURLToPath(import.meta.url));
const { BOUND_KEYS, GAPS, MenuBar, OMISSIONS, cadMenus, commandForKey, onCadKeyDown } = await import(
  '../src/cad/menu.tsx'
);
const { MOUNT_A_FOLDER } = await import('../src/cad/open.tsx');

/** The files this suite reads to check a claim against the code that makes it. */
const source = (...parts: string[]) => readFileSync(join(HERE, '..', 'src', ...parts), 'utf8');

/**
 * Everything a reader of the RUNNING APP could see — comments removed.
 *
 * 🔴 IT IS CRUDE ON PURPOSE AND IT IS ONLY EVER USED TO STRENGTHEN AN ABSENCE
 * CLAIM. A `//` inside a string literal would strip too much, which can only
 * make a `doesNotMatch` pass when it should fail — so any real use of this is
 * paired with a positive assertion that the replacement text IS present. It
 * exists because a scanner that matches the comment DISCUSSING what it scans for
 * is a false red, and a false red on a correctly-fixed file gets the assertion
 * deleted rather than narrowed.
 */
const withoutComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[^\n]*?\/\/[^\n]*$/gm, ' ');

const CTX = {
  dirty: false,
  saveBlocked: null,
  errorCount: 2,
  bottomTab: 'console',
  askVisible: true,
  savedName: null,
  axes: true,
  scaleMarkers: true,
  projection: 'perspective' as const,
  /* No history yet — both Edit items are disabled from this context. */
  undoLabel: null,
  redoLabel: null,
};

const idsOf = (ctx = CTX) => cadMenus(ctx).flatMap((m) => m.items.map((i) => i.id));

/* ════════════════════════════════════════════════════════════════════════════
   1. Only what we have
   ════════════════════════════════════════════════════════════════════════════ */

/**
 * 🔴 THE EXACT SET. OpenSCAD 2328d12c3 has 105 actions across six menus; this
 * bar carries these. Changing the list is meant to require changing this test —
 * that is the point of asserting it exactly rather than asserting a count.
 */
test('the command set is exactly the functions this tab actually has', () => {
  assert.deepEqual(idsOf(), [
    'file.new',
    'file.example',
    'file.open',
    'file.save',
    'file.save-as',
    'file.settings',
    'file.export.stl',
    'edit.undo',
    'edit.redo',
    'edit.jump-error',
    'design.check-validity',
    'design.csg-tree',
    'design.ask',
    'view.console',
    'view.tree',
    'view.ask',
    'view.axes',
    'view.scale-markers',
    'view.projection.perspective',
    'view.projection.orthogonal',
    'view.reset-layout',
    'help.about',
  ]);
});

/* ────────────────────────────────────────────────────────────────────────────
   The two view toggles, and the parent-child relationship between them
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * 🔴 THE SCALE ITEM IS DISABLED BY THE AXES ITEM, AND THAT IS OPENSCAD'S SHAPE
 * RATHER THAN A PREFERENCE. `MainWindow.cc:2761` runs
 * `viewActionShowScaleProportional->setEnabled(checked)` from the axes handler,
 * and `GLView.cc:198` renders on `showaxes && showscale`.
 *
 * The failure this guards is a stale green, not a crash: two independent
 * toggles would let an operator switch scale markers on, see nothing on screen,
 * and be told by the check mark that they ARE on.
 */
test('scale markers are a child of axes — disabled, with a reason, while axes are off', () => {
  const on = cadMenus({ ...CTX, axes: true }).find((m) => m.id === 'view')!;
  const off = cadMenus({ ...CTX, axes: false }).find((m) => m.id === 'view')!;
  const item = (ms: typeof on) => ms.items.find((i) => i.id === 'view.scale-markers')!;

  assert.equal(item(on).disabled, false);
  assert.equal(item(off).disabled, true);
  assert.ok(item(off).disabledReason && item(off).disabledReason!.length > 20);
});

/**
 * ⚠ AND THE CHECK MARK STILL SHOWS THE STORED CHOICE WHILE THE ITEM IS
 * DISABLED. It is what makes turning the axes back on predictable — the
 * alternative reads as the setting having been reset by something the operator
 * did not do.
 */
test('the scale check mark reports the STORED setting, not what is on screen', () => {
  const view = cadMenus({ ...CTX, axes: false, scaleMarkers: true }).find((m) => m.id === 'view')!;
  assert.equal(view.items.find((i) => i.id === 'view.scale-markers')!.checked, true);
});

/* ────────────────────────────────────────────────────────────────────────────
   The projection pair — what replaced the `perspective` banned word
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * 🔴 EXACTLY ONE OF THE TWO IS EVER CHECKED. OpenSCAD puts its two actions in
 * an EXCLUSIVE `QActionGroup` (`MainWindow.cc:3920-3923`), so there is no state
 * in which both or neither is selected. Rendering this pair as two independent
 * check items would produce exactly that state, and "neither" reads on screen as
 * a projection nobody chose.
 */
test('the projection pair is exclusive — one checked, never both, never neither', () => {
  for (const projection of ['perspective', 'orthographic'] as const) {
    const view = cadMenus({ ...CTX, projection }).find((m) => m.id === 'view')!;
    const pair = view.items.filter((i) => i.id.startsWith('view.projection.'));
    assert.equal(pair.length, 2, 'the projection pair is no longer a pair');
    assert.equal(pair.filter((i) => i.checked).length, 1, `both or neither checked at ${projection}`);
    assert.equal(
      pair.find((i) => i.checked)!.id,
      projection === 'perspective' ? 'view.projection.perspective' : 'view.projection.orthogonal',
      'the check mark is on the mode that is not selected',
    );
  }
});

/**
 * 🔴 AND THE ITEMS ARE NOT DEAD CONTROLS. The banned word came off the list
 * above, so this is what carries the claim now: the tab must handle both
 * commands, and the preview must actually receive the setting.
 *
 * ⚠ SOURCE-TEXT, and the reason is the usual one — the camera lives inside a
 * closure over a `WebGLRenderer` and there is no WebGL in this harness. This
 * catches the wiring being absent; `tests/projection.test.ts` carries the
 * arithmetic, and neither can show that the picture changed.
 */
test('both projection commands are handled, persisted, and reach the preview', () => {
  const tab = source('cad', 'CadTab.tsx');
  assert.match(tab, /case 'view\.projection\.perspective':\s*\n\s*patch\(\{ projection: 'perspective' \}\)/);
  assert.match(tab, /case 'view\.projection\.orthogonal':\s*\n\s*patch\(\{ projection: 'orthographic' \}\)/);
  // It is a field of the persisted layout, so the choice survives a reload.
  assert.match(tab, /projection: readProjection\(v\.projection, DEFAULT_LAYOUT\.projection\)/);
  // …and it is handed to the component that owns the camera.
  assert.match(tab, /projection=\{layout\.projection\}/);
});

/**
 * ⚠ THE NOTES CARRY THE MEASUREMENT WARNING, not a preference. A projection
 * control whose only description is "looks nicer" is the one that gets used to
 * judge a clearance.
 */
test('the perspective item warns that it is not the view to measure from', () => {
  const view = cadMenus(CTX).find((m) => m.id === 'view')!;
  const persp = view.items.find((i) => i.id === 'view.projection.perspective')!;
  const ortho = view.items.find((i) => i.id === 'view.projection.orthogonal')!;
  assert.match(persp.note ?? '', /parallel edges converge/i);
  assert.match(ortho.note ?? '', /parallel/i);
  /* And the orthogonal note states the property that makes the whole design
   * work — switching does not move the camera. */
  assert.match(ortho.note ?? '', /camera does not move/i);
});

test('both view toggles render their state as a check', () => {
  for (const axes of [true, false]) {
    const view = cadMenus({ ...CTX, axes }).find((m) => m.id === 'view')!;
    assert.equal(view.items.find((i) => i.id === 'view.axes')!.checked, axes);
  }
});

/**
 * 🔴 THE PANE WENT AND SO DID ITS ITEM (founder, 2026-08-11: *"remove What this
 * tab is not"*). A menu item pointing at a pane that no longer exists is the
 * same dead-control defect as an item for a capability we never had, so it is
 * asserted absent rather than left to the exact-set list above to catch.
 */
test('there is no item for the banner that was removed', () => {
  assert.ok(!idsOf().includes('view.about'));
  const view = cadMenus(CTX).find((m) => m.id === 'view')!;
  assert.ok(!view.items.some((i) => /what this tab is not/i.test(i.label)));
});

/**
 * 🔴 AND THE SCENE TREE'S ITEMS STAYED, because the pane did — it is menu-
 * toggled rather than a permanent tab (founder: *"Remove Scene Tree"*). Removing
 * the pane and keeping these would have been a command with nothing behind it;
 * removing these and keeping the pane would have made it unreachable.
 */
test('the scene tree is still reachable from both menus that claim to open it', () => {
  const ids = idsOf();
  assert.ok(ids.includes('design.csg-tree'));
  assert.ok(ids.includes('view.tree'));
});

test('and CadTab actually renders that pane, so neither item is a dead control', () => {
  const src = readFileSync(join(HERE, '..', 'src', 'cad', 'CadTab.tsx'), 'utf8');
  assert.match(src, /case 'design\.csg-tree':\s*\n\s*patch\(\{ tab: 'tree' \}\)/);
  assert.match(src, /id: 'tree', label: 'Scene tree', pinned: false/);
});

/**
 * 🔴 ONE DOOR NOW, AND THE TEST WAS INVERTED RATHER THAN DELETED. It used to
 * assert that `Open library folder…` was a SEPARATE item — the two actions
 * differ in what they destroy, and a label is the one place that difference is a
 * promise. The founder merged them (*"have just 1 open!"*, 2026-08-11), so the
 * item is gone; the property it protected is not, and deleting the test is how
 * the panel would eventually stop carrying it.
 *
 * So what is asserted now is that the ONE item still tells an operator both
 * things before they press it: that a folder can be mounted and that mounting
 * replaces nothing, and that opening replaces the editor.
 */
test('the one Open item carries both sources, and still says which of them destroys', () => {
  const file = cadMenus(CTX).find((m) => m.id === 'file')!;
  assert.ok(!file.items.some((i) => i.id === 'file.library'), 'the merged item came back');

  const open = file.items.find((i) => i.id === 'file.open')!;
  assert.match(open.note ?? '', /folder/i);
  assert.match(open.note ?? '', /replaces nothing/);
  assert.match(open.note ?? '', /replaces the editor/);
  assert.match(open.note ?? '', /include and use/i);
});

/**
 * 🔴 THE REFUSAL MUST NAME A CONTROL THAT EXISTS. An unresolved import is
 * reported in the console AND on the editor's gutter, and the sentence ends with
 * the menu path that fixes it. It named `File → Open library folder…` — an item
 * that no longer exists — until the merge changed both in one commit.
 *
 * A refusal naming a non-existent fix is worse than a refusal with no fix in it:
 * it sends the operator hunting through a menu, and the best case is that they
 * conclude the message is wrong. This compares the sentence against the menu
 * rather than against a copy of the sentence.
 */
test('the unresolved-import sentence names a menu item that is actually in the bar', () => {
  const labels = cadMenus(CTX).flatMap((m) => m.items.map((i) => i.label));
  // `MOUNT_A_FOLDER` is "File → Open… , then …" — take the item name out of it.
  const named = MOUNT_A_FOLDER.match(/File → ([^,]+)/)![1].trim();
  assert.ok(labels.includes(named), `the refusal names "${named}", which is not a File item`);
  assert.ok(!/library folder/i.test(MOUNT_A_FOLDER), 'the refusal still names the retired item');

  // And it is the sentence the tab actually prints, not a second copy of it.
  const tab = source('cad', 'CadTab.tsx');
  assert.match(tab, /MOUNT_A_FOLDER/);
  /* ⚠ COMMENTS STRIPPED FIRST, AND THE FIRST DRAFT OF THIS LINE DID NOT — it
   * scanned the whole file and went red on the two comments that RECORD the
   * merge, including the one that predicted this exact staleness. That is this
   * lane's own named defect (*"a scanner matches the text that discusses what it
   * scans for"*), and it has now happened three times in this tree. What must
   * not contain the retired path is what an OPERATOR can read. */
  assert.doesNotMatch(withoutComments(tab), /Open library folder/);
});

test('the five menus are OpenSCAD’s, minus the one whose whole subject is windows', () => {
  assert.deepEqual(
    cadMenus(CTX).map((m) => m.label),
    ['File', 'Edit', 'Design', 'View', 'Help'],
  );
});

/**
 * The things most likely to be reproduced as costume. Each is named in
 * `OMISSIONS` with the reason it is absent — and absent from the command set.
 */
test('nothing exists for a capability we do not have', () => {
  const ids = idsOf().join(' ');
  for (const banned of [
    'preview',
    'render',
    'customizer',
    /* ⚠ `undo` AND `redo` LEFT THIS LIST ON 2026-08-11, when they were built
     * (founder: *"2bee.cad: Have an undo, redo option"*). What this tab still
     * does not have is an undo for TYPING — that is the browser's, `Ctrl+Z` is
     * left unbound for it, and the assertion that watches it is the accelerator
     * pair below plus `BOUND_KEYS` holding exactly one key. Removing the words
     * without saying so is how a banned-word list quietly stops meaning
     * anything. */
    'reload',
    'quit',
    'recent',
    'amf',
    '3mf',
    'obj',
    'dxf',
    'svg',
    'pdf',
    'ast',
    'font',
    /* ⚠ NOT the bare word `library`. `file.library` mounts ONE folder the
     * operator picks and is a real capability; OpenSCAD's omitted action is
     * `Library info`, a dialog describing a SEARCH PATH ORDER that does not
     * exist here. Narrowing the needle rather than deleting it keeps the
     * omission asserted — deleting it would have stopped watching for the
     * thing we still do not have. */
    'library.info',
    'libraryinfo',
    'preferences',
    'zoom',
    /* ⚠ `perspective` LEFT THIS LIST ON 2026-08-11, when it was built (founder:
     * *"add perspective / orthogonal view change capability in all 3d canvas"*).
     * View → Perspective and View → Orthogonal are real, exclusive, persisted
     * items now, so the word would be a false red on a capability the tab has —
     * and a banned-word list that fires on a built feature is one somebody
     * deletes. It is named rather than silently dropped, exactly as `undo` and
     * `redo` were above: the whole value of this list is that a reader can trust
     * it to still mean something. What replaced it is the pair of assertions
     * below, which check the items against the CODE that provides them. */
  ]) {
    assert.ok(!ids.includes(banned), `a menu item exists for "${banned}", which this tab cannot do`);
  }
});

test('the omission list gives a REASON for each, and covers the tempting ones', () => {
  assert.ok(OMISSIONS.length >= 6);
  const all = OMISSIONS.join(' ');
  for (const t of ['Customizer', 'Preview (F5)', 'Undo', 'Reload', 'export format', 'Library info']) {
    assert.ok(all.includes(t), `${t} is not accounted for`);
  }
  for (const o of OMISSIONS) assert.ok(o.length > 60, `an omission with no reason: ${o}`);
});

/* ════════════════════════════════════════════════════════════════════════════
   1a. The omission list says only ONE kind of thing — asserted against the code
   ════════════════════════════════════════════════════════════════════════════ */

/**
 * 🔴 THE ASSERTION THE OLD SUITE DID NOT HAVE, AND THE REASON THREE FALSE
 * ENTRIES SURVIVED. What was checked was that each entry is longer than 60
 * characters and that five keywords appear somewhere in the joined string.
 * Length is not a reason and a keyword is not a capability claim — and the three
 * entries that failed the header's own rule are exactly the ones a length check
 * waves through.
 *
 * ⚠ THE NEEDLE IS DELIBERATELY NOT A WORD LIST OF MY OWN CHOOSING. Each pair
 * below first asserts the capability EXISTS, at the file that implements it, and
 * only then asserts that `OMISSIONS` does not call it absent. So the test cannot
 * be satisfied by narrowing what it looks at: remove the camera from
 * `preview.tsx` and the first half goes red, telling the next person to move the
 * entry back rather than leaving a silently-true assertion behind.
 */
test('the camera EXISTS in preview.tsx, so no omission may say it does not', () => {
  const preview = source('cad', 'preview.tsx');
  /* The capability, at the code. `preview.tsx` is another agent's file and is
   * only read here. */
  assert.match(preview, /addEventListener\('pointerdown'/, 'orbit/pan need a pointer handler');
  assert.match(preview, /addEventListener\('wheel'/, 'wheel-zoom');
  assert.match(preview, /cad-preview-fit/, 'the Fit control');

  for (const entry of OMISSIONS) {
    assert.ok(
      !/\bcamera\b/i.test(entry),
      `an omission entry names the camera, which this tab HAS: ${entry.slice(0, 90)}…`,
    );
  }
  /* And it is accounted for — moved, not deleted. */
  assert.ok(GAPS.some((g) => /\bcamera\b/i.test(g)), 'the camera left the omissions and landed nowhere');
});

test('preferences ARE persisted, so no omission may list them as unimplemented', () => {
  const tab = source('cad', 'CadTab.tsx');
  const ask = source('cad', 'ask.tsx');
  assert.match(tab, /LAYOUT_KEY = '2bee\.app\.cad\.layout'/, 'the pane-layout preference');
  assert.match(tab, /setItem\(LAYOUT_KEY/, 'and it is actually written');
  assert.match(ask, /ASK_CONFIG_KEY = '2bee\.app\.cad\.ask'/, 'the endpoint/model/key preference');

  for (const entry of OMISSIONS) {
    assert.ok(
      !/Nothing here implements[^.]*\bpreferences\b/i.test(entry),
      `an omission entry says preferences are unimplemented: ${entry.slice(0, 90)}…`,
    );
  }
  assert.ok(GAPS.some((g) => /preferences/i.test(g)), 'preferences left the omissions and landed nowhere');
});

/**
 * 🔴 THE DELEGATION CLAIM IS TRUE OF FIVE KEYS AND WAS ASSERTED FOR ELEVEN.
 * "The browser already owns those keys" covers Undo, Redo, Cut, Copy and Paste.
 * It does not cover comment/uncomment, indent/unindent, bookmarks or
 * tab-conversion — those have no native equivalent, so filing them there made
 * six absent capabilities somebody else's job, and a thing nobody owns is built
 * by nobody. Comment-toggling is the one with a measurable cost: the example
 * this tab ships instructs the user to perform it.
 */
test('the delegation entry claims only the five keys the browser actually owns', () => {
  /* ⚠ THE ENTRY WAS NARROWED WHEN UNDO/REDO WERE BUILT, so the needle moved with
   * it. The delegation claim is now about the TYPING undo specifically, which is
   * still the browser's; the menu items are a document history over whole-buffer
   * replacements, which is a different thing and says so in the same entry. */
  const delegated = OMISSIONS.find((o) => /^Cut, Copy and Paste as menu items/.test(o));
  assert.ok(delegated, 'the delegated-editor-commands entry should still exist');
  for (const notDelegated of ['Indent', 'bookmarks', 'tab-conversion', 'Comment', 'Find']) {
    assert.ok(
      !new RegExp(`\\b${notDelegated}\\b`, 'i').test(delegated),
      `"${notDelegated}" is claimed as browser-owned and it is not`,
    );
  }
  const gaps = GAPS.join(' ');
  for (const unbuilt of ['Comment', 'uncomment', 'indent', 'bookmarks', 'tab-to-space', 'Find']) {
    assert.ok(new RegExp(unbuilt, 'i').test(gaps), `"${unbuilt}" is accounted for nowhere`);
  }
  /* ⚠ The example is what makes comment-toggling the top of that list. If the
   * example stops asking for it, this test should be re-argued, not deleted. */
  assert.match(source('cad', 'CadTab.tsx'), /Try uncommenting either line below/);
});

test('the gaps list gives a reason for each, and says it is not a decision', () => {
  assert.ok(GAPS.length >= 4);
  for (const g of GAPS) assert.ok(g.length > 60, `a gap with no reason: ${g}`);
  /* The header of the report keeps the two apart. Without it the split is a
   * refactor nobody can see. */
  const tab = source('cad', 'CadTab.tsx');
  assert.match(tab, /WHAT DOES NOT EXIST HERE/);
  assert.match(tab, /AND WHAT IS SIMPLY MISSING/);
  assert.match(tab, /\.\.\.OMISSIONS,/);
  assert.match(tab, /\.\.\.GAPS,/);
});

/* ════════════════════════════════════════════════════════════════════════════
   2. Every advertised accelerator is a bound one
   ════════════════════════════════════════════════════════════════════════════ */

/**
 * The half of the old assertion that survives unchanged: free text may not name
 * a key. A key inside a sentence cannot be compared to anything, so it would be
 * an accelerator claim no test could check — which is how the four-keys-one-
 * reason footnote went unexamined for as long as it did.
 */
test('no item label or note advertises a keyboard shortcut in free text', () => {
  for (const m of cadMenus(CTX)) {
    for (const i of m.items) {
      for (const text of [i.label, i.note ?? '', i.disabledReason ?? '']) {
        assert.ok(
          !/\bF\d\b|Ctrl\+|Cmd\+|⌘/.test(text),
          `"${i.id}" names a key in free text; use the accel field: ${text}`,
        );
      }
    }
  }
});

/**
 * 🔴 THE INVERSION. While nothing was bound the honest assertion was "no key is
 * printed"; with one key bound it becomes "every printed key is a bound key".
 * Deleting it instead is what would eventually put a printed `Ctrl+S` beside an
 * item that does nothing.
 */
test('every printed accelerator names a key BOUND_KEYS binds, to the command it binds', () => {
  const printed = cadMenus(CTX)
    .flatMap((m) => m.items)
    .filter((i) => i.accel);
  assert.ok(printed.length > 0, 'a bound key that is printed nowhere is a secret, not a shortcut');
  for (const i of printed) {
    assert.ok(i.accel! in BOUND_KEYS, `"${i.id}" prints ${i.accel}, which nothing binds`);
    assert.equal(
      BOUND_KEYS[i.accel!],
      i.id,
      `"${i.id}" prints ${i.accel}, which is bound to a different command`,
    );
  }
});

test('and every bound key is printed on the item it runs — a secret shortcut is a dead one', () => {
  const byId = new Map(cadMenus(CTX).flatMap((m) => m.items.map((i) => [i.id, i] as const)));
  for (const [key, command] of Object.entries(BOUND_KEYS)) {
    const item = byId.get(command);
    assert.ok(item, `${key} runs "${command}", which is not an item in this bar`);
    assert.equal(item.accel, key, `${key} is bound but "${command}" does not print it`);
  }
  /* And on the other form of the same item, so the key does not appear to come
   * and go with the label. */
  const named = cadMenus({ ...CTX, savedName: 'bracket' })
    .find((m) => m.id === 'file')!
    .items.find((i) => i.id === 'file.save')!;
  assert.equal(named.accel, 'Ctrl+S');
});

/* ---- what the key actually does, driven rather than grepped --------------- */

const press = (e: Record<string, unknown>) => {
  let prevented = 0;
  const ran: string[] = [];
  const handled = onCadKeyDown(
    { key: 'x', ...e, preventDefault: () => (prevented += 1) } as never,
    (id: string) => ran.push(id),
  );
  return { handled, prevented, ran };
};

/**
 * 🔴 THE PLANT THIS EXISTS FOR: `Ctrl+S` bound but not prevented from reaching
 * the browser. That state is strictly worse than not binding it — the operator
 * gets a real save AND a Save Page dialog, with no way to tell which one the
 * dialog was about, so the false belief the binding exists to remove survives
 * its own fix. Asserted by DRIVING the handler, because a source regex proves
 * the characters are present and not that the path runs.
 */
test('Ctrl+S saves AND stops the browser — both, or the binding is worse than nothing', () => {
  const ctrl = press({ key: 's', ctrlKey: true });
  assert.equal(ctrl.handled, true);
  assert.equal(ctrl.prevented, 1, 'the browser’s Save Page would still appear');
  assert.deepEqual(ctrl.ran, ['file.save']);

  /* A Mac operator's muscle memory is Cmd+S and the hazard is identical. */
  const cmd = press({ key: 's', metaKey: true });
  assert.equal(cmd.prevented, 1);
  assert.deepEqual(cmd.ran, ['file.save']);

  /* Capitals reach the handler as 'S' when caps-lock is on. */
  assert.deepEqual(press({ key: 'S', ctrlKey: true }).ran, ['file.save']);
});

/**
 * 🔴 THE THREE KEYS THAT MUST STAY THE BROWSER'S, each for its own reason —
 * see `menu.tsx`'s header. `Ctrl+Z` is the one that would break a claim this
 * file makes elsewhere: `OMISSIONS` delegates typing-undo to the browser, so
 * binding it would make the omission list false.
 */
test('F5, Ctrl+N, Ctrl+Z and a bare S are left alone — nothing is prevented', () => {
  for (const e of [
    { key: 'F5' },
    { key: 'n', ctrlKey: true },
    { key: 'z', ctrlKey: true },
    { key: 'z', metaKey: true },
    { key: 'y', ctrlKey: true },
    { key: 's' },
    { key: 's', ctrlKey: true, shiftKey: true },
    { key: 's', ctrlKey: true, altKey: true },
    { key: 'o', ctrlKey: true },
  ]) {
    const r = press(e);
    assert.equal(r.handled, false, `${JSON.stringify(e)} was taken from the browser`);
    assert.equal(r.prevented, 0);
    assert.deepEqual(r.ran, []);
  }
  assert.equal(commandForKey({ key: 'z', ctrlKey: true }), null);
});

/**
 * 🔴 AND THE FOOTNOTE IS WHERE THE MUSCLE MEMORY IS. The File menu is where an
 * OpenSCAD user reaches for Ctrl+S, so that is where the policy is stated — all
 * four keys, each with the reason that applies to IT.
 *
 * 🔴 THE PLANT: the footnote still describing the hazard after it is fixed. It
 * used to say Ctrl+S "saves the page" and name that as lost work, then offer the
 * leave-page warning as the answer to both keys. It covered one. A stale
 * explanation of a fixed problem is its own defect, so the old sentence is
 * asserted ABSENT, not merely the new one present.
 */
test('the File footnote states the per-key policy and no longer describes the fixed hazard', () => {
  const foot = cadMenus(CTX).find((m) => m.id === 'file')!.footnote ?? '';
  for (const key of ['F5', 'Ctrl+S', 'Ctrl+N', 'Ctrl+Z']) {
    assert.ok(foot.includes(key), `${key} is not accounted for in the footnote`);
  }
  assert.match(foot, /Ctrl\+S is bound/, 'the bound key must say it is bound');
  assert.match(foot, /leave-page|beforeunload|warning/i, 'F5’s guard must still be named');
  assert.ok(
    !/Ctrl\+S saves the page/i.test(foot),
    'the footnote still describes the hazard that binding the key removed',
  );
  assert.ok(
    !/No keyboard shortcuts are bound/i.test(foot),
    'the footnote contradicts the binding above it',
  );
});

test('and CadTab actually wires the key, scoped so a hidden tab cannot answer it', () => {
  const src = source('cad', 'CadTab.tsx');
  assert.match(src, /addEventListener\('keydown', onKey\)/);
  assert.match(src, /onCadKeyDown\(e, runCommand\)/);
  /* 🔴 Tabs.tsx keeps every panel mounted behind `display: none`, so a window
   * listener outlives the tab being visible. Without this, Ctrl+S in the CNC tab
   * would silently write the CAD model and report its refusals off-screen. */
  assert.match(src, /getClientRects\(\)\.length === 0/);
});

test('and CadTab actually registers the guard the footnote promises', () => {
  const src = source('cad', 'CadTab.tsx');
  assert.match(src, /addEventListener\('beforeunload'/);
  assert.match(src, /if \(!dirty \|\| typeof window === 'undefined'\) return;/);
});

/* ════════════════════════════════════════════════════════════════════════════
   3. Destructive items, and disabled ones
   ════════════════════════════════════════════════════════════════════════════ */

/**
 * 🔴 THE SENTENCE MOVED WITH THE MECHANISM, IT WAS NOT WEAKENED. `New` used to
 * promise *"This asks first — there is no undo"*, and it no longer asks
 * (founder, 2026-08-11: *"remove … alerts"*). Keeping the old assertion would
 * have vouched for a confirm that is gone; dropping it would have let the item
 * say nothing about destroying unsaved work. So it now asserts the TRUE
 * sentence — that the toolbar will offer to put the work back, one step — and
 * only when there is work to lose.
 */
test('New says what recovers your work, and only when there is something to lose', () => {
  const clean = cadMenus(CTX).find((m) => m.id === 'file')!.items.find((i) => i.id === 'file.new')!;
  const dirty = cadMenus({ ...CTX, dirty: true })
    .find((m) => m.id === 'file')!
    .items.find((i) => i.id === 'file.new')!;
  assert.ok(!/put them back|not saved/.test(clean.note ?? ''), 'a clean editor needs no warning');
  assert.match(dirty.note ?? '', /not saved anywhere/);
  assert.match(dirty.note ?? '', /put them back, one step/);
  assert.ok(
    !/asks first|confirm/i.test(dirty.note ?? ''),
    'the note must not promise a confirm that was removed',
  );
});

/**
 * 🔴 `Save` AND `Save as…` ARE DIFFERENT ITEMS AND THE LABEL SAYS WHICH IS
 * WHICH. The ellipsis is a promise that a chooser appears; a `Save` that acts
 * immediately must not carry it, and a model that has never been saved has no
 * name to act on, so that one does.
 */
test('Save carries the ellipsis only when it will actually open the dialog', () => {
  const unnamed = cadMenus(CTX).find((m) => m.id === 'file')!.items.find((i) => i.id === 'file.save')!;
  const named = cadMenus({ ...CTX, savedName: 'bracket' })
    .find((m) => m.id === 'file')!
    .items.find((i) => i.id === 'file.save')!;
  assert.equal(unnamed.label, 'Save…');
  assert.equal(named.label, 'Save "bracket"');
  assert.match(named.note ?? '', /No dialog/);
  /* The destruction, stated at the control that does it silently. */
  assert.match(named.note ?? '', /the record it replaces is gone/);

  const saveAs = cadMenus(CTX).find((m) => m.id === 'file')!.items.find((i) => i.id === 'file.save-as')!;
  assert.equal(saveAs.label, 'Save as…');
  assert.match(saveAs.note ?? '', /BEFORE the save that would replace it/);
});

/**
 * ⚠ A silent `Save` must not be silently refused either. When the model has a
 * name AND the audit blocks it, the item is dead with the refusal's own words —
 * the same treatment the export already had.
 */
test('a named Save is disabled by the same refusal that blocks an export', () => {
  const why = 'the mesh audit says "open" — this model cannot go in the drawings list';
  const item = cadMenus({ ...CTX, savedName: 'bracket', saveBlocked: why })
    .find((m) => m.id === 'file')!
    .items.find((i) => i.id === 'file.save')!;
  assert.equal(item.disabled, true);
  assert.equal(item.disabledReason, why);
});

test('a blocked export is disabled AND carries the refusal’s own words', () => {
  const why = 'the mesh audit says "open" — this model cannot go in the drawings list';
  const item = cadMenus({ ...CTX, saveBlocked: why })
    .find((m) => m.id === 'file')!
    .items.find((i) => i.id === 'file.export.stl')!;
  assert.equal(item.disabled, true);
  assert.equal(item.disabledReason, why);
});

test('jump-to-error is dead when there is nothing to jump to, and says so', () => {
  const item = cadMenus({ ...CTX, errorCount: 0 })
    .find((m) => m.id === 'edit')!
    .items.find((i) => i.id === 'edit.jump-error')!;
  assert.equal(item.disabled, true);
  assert.ok((item.disabledReason ?? '').length > 20);
});

test('hiding the model pane removes BOTH its entries, not just the one', () => {
  const ids = idsOf({ ...CTX, askVisible: false }).join(' ');
  assert.ok(!ids.includes('design.ask'));
  assert.ok(!ids.includes('view.ask'));
});

test('the View menu marks which pane is showing', () => {
  const view = cadMenus({ ...CTX, bottomTab: 'tree' }).find((m) => m.id === 'view')!;
  assert.equal(view.items.find((i) => i.id === 'view.tree')!.checked, true);
  assert.equal(view.items.find((i) => i.id === 'view.console')!.checked, false);
});

/* ════════════════════════════════════════════════════════════════════════════
   4. The ARIA wiring
   ════════════════════════════════════════════════════════════════════════════ */

const bar = () => renderToStaticMarkup(h(MenuBar, { menus: cadMenus(CTX), onCommand: () => {} }));

test('it is a menubar, not a row of divs', () => {
  const html = bar();
  assert.match(html, /role="menubar"/);
  assert.match(html, /aria-label="2bee\.cad menu"/);
  for (const m of cadMenus(CTX)) {
    assert.match(html, new RegExp(`data-testid="cad-menu-${m.id}"`));
  }
});

test('every top-level button declares its popup and its state', () => {
  const html = bar();
  const buttons = html.match(/<button[^>]*data-testid="cad-menu-[a-z]+"[^>]*>/g) ?? [];
  assert.equal(buttons.length, 5);
  for (const b of buttons) {
    assert.match(b, /aria-haspopup="true"/);
    assert.match(b, /aria-expanded="false"/);
    assert.match(b, /role="menuitem"/);
  }
});

/** Roving tabindex: exactly one stop on the bar, not five and not none. */
test('the bar is one tab stop', () => {
  const html = bar();
  assert.equal((html.match(/tabindex="0"/g) ?? []).length, 1);
  assert.equal((html.match(/tabindex="-1"/g) ?? []).length, 4);
});

test('closed menus render no popup at all — a hidden menu is not a rendered one', () => {
  assert.ok(!bar().includes('role="menu"'));
});

/* ════════════════════════════════════════════════════════════════════════════
   5. `Reset to example` was removed, and the command it called was not
   ════════════════════════════════════════════════════════════════════════════ */

/**
 * 🔴 A REMOVAL MUST TAKE ITS WIRING AND LEAVE EVERYTHING THAT WAS NEVER ITS.
 * Founder, 2026-08-11: *"remove the Reset to example"*. That button was a
 * SECOND door onto `file.example` — a destructive replacement — parked at
 * `marginLeft: auto` where a mis-aimed click lands. What it called is a real
 * menu command with a real menu item, and the constant it used seeds a fresh
 * tab, so both stay. Asserting only the button's absence would let a later edit
 * take the command with it and stay green.
 */
test('the toolbar reset is gone, and File → Example survives it', () => {
  const tab = source('cad', 'CadTab.tsx');
  /* ⚠ COMMENTS ARE STRIPPED FIRST, and the first cut of this test did not do it
   * and went red on the comment RECORDING the removal. A scanner that matches
   * the text discussing what it scans for cannot tell a live control from a note
   * about a dead one — and this file explains every removal in prose, so that is
   * not an edge case here, it is the norm. */
  const code = tab.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!code.includes('cad-reset'), 'the reset button is still rendered');
  assert.ok(!/Reset to example/.test(code), 'the reset button is still rendered');

  /* Its command keeps its own door… */
  assert.ok(idsOf().includes('file.example'));
  assert.match(tab, /case 'file\.example':\s*\n\s*replaceEditor\('Example', EXAMPLE\)/);
  /* …and the constant has a caller that was never the button's. */
  assert.match(tab, /initialEditor\(EXAMPLE\)/);
});

/* ════════════════════════════════════════════════════════════════════════════
   Undo and redo — built, and still not taking Ctrl+Z
   ════════════════════════════════════════════════════════════════════════════ */

/**
 * 🔴 THE ITEMS EXIST AND THE KEY DOES NOT MOVE. Founder 2026-08-11: *"2bee.cad:
 * Have an undo, redo option"*. What was built is a history over BUFFER-REPLACING
 * actions; what was deliberately not built is an undo for typing, because the
 * browser already gives the textarea one with a granularity nothing here can
 * match. Binding `Ctrl+Z` would trade a whole typing history for a handful of
 * document steps AND make `OMISSIONS`'s own delegation claim false.
 *
 * ⚠ SO THE TWO HALVES ARE ASSERTED TOGETHER. Either one alone is satisfiable by
 * the wrong build: items with no key could be items nobody can reach, and an
 * unbound `Ctrl+Z` alone was already true yesterday.
 */
test('Edit → Undo and Redo exist, carry no accelerator, and Ctrl+Z stays unbound', () => {
  const edit = cadMenus(CTX).find((m) => m.id === 'edit')!;
  const undo = edit.items.find((i) => i.id === 'edit.undo')!;
  const redo = edit.items.find((i) => i.id === 'edit.redo')!;

  assert.equal(undo.accel, undefined, 'an accelerator was printed for an unbound key');
  assert.equal(redo.accel, undefined);
  assert.deepEqual(Object.keys(BOUND_KEYS), ['Ctrl+S'], 'a second key was bound');
  assert.equal(commandForKey({ key: 'z', ctrlKey: true }), null, 'Ctrl+Z was taken');
  assert.equal(commandForKey({ key: 'z', metaKey: true }), null, 'Cmd+Z was taken');
  assert.equal(commandForKey({ key: 'y', ctrlKey: true }), null, 'Ctrl+Y was taken');
});

/**
 * 🔴 THE LABEL NAMES THE ACTION, WHICH IS THE WHOLE REASON THIS WAS SAFE TO
 * BUILD. A bare *"Undo"* is read as an undo for typing by everybody who has ever
 * used an editor, and this one will not take back a keystroke. `replace.ts` is
 * the single writer of both sentences.
 */
test('the undo/redo items name what they reverse, and say what they are not', () => {
  const withHistory = { ...CTX, undoLabel: 'Put back what Example replaced', redoLabel: 'Redo New' };
  const edit = cadMenus(withHistory).find((m) => m.id === 'edit')!;
  assert.equal(edit.items.find((i) => i.id === 'edit.undo')!.label, 'Put back what Example replaced');
  assert.equal(edit.items.find((i) => i.id === 'edit.redo')!.label, 'Redo New');
  assert.match(edit.items.find((i) => i.id === 'edit.undo')!.note ?? '', /Not an undo for typing/i);
});

/** With nothing to reverse, both are disabled and both say why. */
test('undo and redo are disabled with a reason when there is no history', () => {
  const edit = cadMenus(CTX).find((m) => m.id === 'edit')!;
  for (const id of ['edit.undo', 'edit.redo']) {
    const item = edit.items.find((i) => i.id === id)!;
    assert.equal(item.disabled, true, `${id} is live with nothing to do`);
    assert.ok((item.disabledReason ?? '').length > 40, `${id} is disabled with no reason`);
  }
});

/**
 * 🔴 ONE MECHANISM, TWO DOORS. The toolbar button was a one-step put-back before
 * the founder asked for undo/redo, and the temptation was to leave it beside the
 * new menu items. Two undo systems over two stacks is how the wrong one gets
 * pressed — and with a model's reply now landing unpressed, that is the control
 * an operator reaches for under pressure.
 */
test('the toolbar button and the menu item drive the same history', () => {
  const tab = source('cad', 'CadTab.tsx');
  assert.match(tab, /case 'edit\.undo':[\s\S]{0,900}?setEd\(undoEditor\);/);
  assert.match(tab, /data-testid="cad-put-back"[\s\S]{0,200}?onClick=\{\(\) => setEd\(undoEditor\)\}/);
  assert.match(tab, /data-testid="cad-redo"[\s\S]{0,200}?onClick=\{\(\) => setEd\(redoEditor\)\}/);
  // No second stash left behind: `replace.ts` is the only history module.
  assert.ok(!/putBack|mayPutBack|PUT_BACK_WHAT/.test(withoutComments(tab)), 'the old one-slot API is still wired');
});
