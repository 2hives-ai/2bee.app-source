// TODO #104 — the spoilboard could not be saved and its dimensions could not be
// edited, and TODO #107 — the CNC tab said nothing about what it has never done.
//
// ══════════════════════════════════════════════════════════════════════════
//  🔴 WHAT THIS DELIBERATELY CANNOT SEE — read this before trusting a green
// ══════════════════════════════════════════════════════════════════════════
//
//  1. **HALF OF IT IS A SOURCE-TEXT CHECK.** `App.tsx` cannot be imported in
//     node — it pulls in the wasm bridge and a DOM — so the rules that live
//     inside its render (the config branch, the input's type, what the panel
//     renders) are asserted over BYTES. That can say the hazard is not spelled
//     in the file; it cannot say the app behaves. Where a rule could be moved
//     into a pure function it was: `store.ts`'s half is EXERCISED below.
//
//  2. **IT CANNOT SEE THE SCREEN.** Whether the reach verdict is legible, in
//     the right place, or read before somebody presses Export needs a browser
//     and belongs in `web/e2e/`. Nothing here is evidence that anything was
//     rendered.
//
//  3. **THE ABOUT CHECKS COMPARE TWO FILES, NOT REALITY.** They assert that a
//     sentence in the panel agrees with the Rust it describes. A claim whose
//     Rust is itself wrong passes — that is the core's own tests' job. What
//     these stop is the failure this lane actually had: a capability list that
//     drifted away from the code and was still being read as current.
//
// ══════════════════════════════════════════════════════════════════════════

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readSpoilboard, spoilboardForMachine } from '../src/store.ts';

const here = dirname(fileURLToPath(import.meta.url));
const app = () => readFileSync(join(here, '..', 'src', 'App.tsx'), 'utf8');
const coreFile = (name: string) =>
  readFileSync(join(here, '..', '..', 'core', 'src', name), 'utf8');

// ---------------------------------------------------------------------------
// LEG 1 — `thickness_mm` is an Option and `None` is load-bearing.
//
// 🔴 THE HAZARD, NAMED ONCE: `Number('')` is `0`. A board `0mm` thick is not a
// board nobody measured — the first is an answer and the second is a question,
// and `sim::BoardDepth` treats them completely differently. Every check in this
// leg is about keeping those two apart across one more boundary.
// ---------------------------------------------------------------------------

test('a saved board carries its thickness, and anything that is not a string is NOT DECLARED', () => {
  const base = { id: 'b', x: '', y: '', sizeX: '600', sizeY: '900', name: 'mine' };

  assert.equal(readSpoilboard({ ...base, thickness: '18' }, [1, 2, 3], 0).values.thickness, '18');
  // Absent — every record written before 2026-08-11.
  assert.equal(readSpoilboard(base, [1, 2, 3], 0).values.thickness, '');
  // A blank the operator left blank stays blank, and does not become '0'.
  assert.equal(readSpoilboard({ ...base, thickness: '' }, [1, 2, 3], 0).values.thickness, '');

  /* 🔴 THE `String(rec.thickness)` TEMPTATION, refused in four directions. It
   * looks like a kindness on a stored number and produces the string `'null'`,
   * `'undefined'` or `'NaN'` on the others — each of which is a thickness the
   * panel would PRINT and `typedMm` would then refuse, i.e. an unparseable
   * field nobody typed. All four land on "not declared", which is the only one
   * of the five states that is true of a wrecked value. */
  for (const junk of [18, null, undefined, NaN, {}, []]) {
    const r = readSpoilboard({ ...base, thickness: junk as never }, [1, 2, 3], 0);
    assert.equal(r.values.thickness, '', `a ${String(junk)} thickness survived as something`);
  }
});

test('a machine mismatch drops the CORNER and never the DEPTH', () => {
  // 🔴 POSITION AND DEPTH ARE SEPARATE LIMBS — TODO #104's third constraint,
  // from the other end. X and Y are machine coordinates and mean a different
  // place on a different machine; an 18mm board is 18mm thick on any machine.
  // Clearing the thickness here would turn a declared depth into PENDING for a
  // reason that is not true, and PENDING is the state an operator stops reading.
  const r = spoilboardForMachine(
    {
      id: 'b',
      x: '40',
      y: '15',
      sizeX: '600',
      sizeY: '900',
      thickness: '18',
      name: 'mine',
      pos: 'entered',
      travels: [1250, 670, 100],
    },
    [600, 900, 100],
    0
  );
  assert.equal(r.values.x, '', 'the corner survived a machine it was not measured on');
  assert.equal(r.values.y, '');
  assert.equal(r.values.pos, 'assumed', 'a dropped corner kept a human’s authority');
  assert.equal(r.values.thickness, '18', 'the depth was dropped with the corner');
  assert.equal(r.values.sizeX, '600', 'the size was dropped with the corner');
  assert.equal(r.dropped[0].field, 'spoilboardPosition');
});

// ---------------------------------------------------------------------------
// LEG 2 — the rules that live inside `App.tsx`'s render. Source text, and the
// header says what that is worth.
// ---------------------------------------------------------------------------

/** The checks below, as predicates over arbitrary source — see LEG 4. */
const CHECKS = {
  /* 🔴 A BLANK THICKNESS MUST OMIT THE KEY, NOT SEND A ZERO. The core's
   * `SpoilboardCfg::thickness_mm` is an `Option<f64>`; an absent key installs
   * the board with `None` and the depth limb reports PENDING with its reason. */
  blankThicknessOmitted: (t: string) => {
    assert.match(
      t,
      /\.\.\.\(typedMm\(spoilboardThickness\) === undefined\s*\n?\s*\?\s*\{\}\s*\n?\s*:\s*\{ thickness_mm: typedMm\(spoilboardThickness\) \}\),/,
      'the measured board no longer omits an undeclared thickness'
    );
    assert.ok(
      !/thickness_mm: Number\(spoilboardThickness\)/.test(t),
      '`Number()` reached the thickness — a blank field now installs a 0mm board'
    );
  },
  /* 🔴 TEXT INPUT, NOT `type="number"`. A number input hands `''` back through
   * `Number()` as `0`, which is the same defect one layer up the stack. */
  thicknessIsText: (t: string) => {
    /* The window is the `<input …>` element the testid sits in, taken BACKWARDS
     * from the testid to the nearest `<input` — forwards from `<input` would
     * have to cross a multi-line `title={…}` and the first attempt silently
     * matched nothing, which this file reports as BLIND rather than green. */
    const at = t.indexOf('data-testid="spoilboard-thickness"');
    assert.ok(at > 0, 'the thickness field is gone — this check is blind, not green');
    const open = t.lastIndexOf('<input', at);
    assert.ok(open > 0 && at - open < 500, 'the thickness field is not an <input> — blind, not green');
    const field = t.slice(open, at);
    assert.match(field, /type="text"/, 'the thickness field became a number input');
    assert.ok(!/type="number"/.test(field), 'the thickness field became a number input');
  },
  /* 🔴 THE FIT IS RE-ASKED, NOT REMEMBERED — TODO #104's first constraint. The
   * verdict is computed in the panel body from the board IN PLAY, so an edit
   * re-grades it on the next render. A board graded at selection and never
   * again is worse than one never graded: the operator watched it pass. */
  reachReAsked: (t: string) => {
    assert.match(
      t,
      /* TODO #109 added a display-unit argument. It is deliberately INSIDE this
       * needle rather than loosened out of it: `spoilboardReachVerdict` builds a
       * SENTENCE, so it is a rendering site, and a call that stopped passing the
       * unit would print millimetres into an inch panel with nothing to notice. */
      /const reach =\s*\n?\s*Number\.isFinite\(sizeX\) && Number\.isFinite\(sizeY\)\s*\n?\s*\? spoilboardReachVerdict\(sizeX, sizeY, mTravelX, mTravelY, unit\)/,
      'the declared board is no longer graded against the travel envelope'
    );
    assert.ok(
      t.includes('data-testid="spoilboard-reach"'),
      'the reach verdict is computed and not rendered — a check nobody can read'
    );
    // And the sizes it grades are the ONE reading, not a second ternary.
    assert.match(t, /const sizeX = typedMm\(spoilboardInPlay\.sizeX\) \?\? NaN;/);
  },
  /* The picker can save at all — the whole of #104's first half. */
  saveAsWired: (t: string) => {
    const picker = /<ObjectPicker\s+label="Spoilboard"[\s\S]*?\n {20}\/>/.exec(t)?.[0];
    assert.ok(picker, 'the spoilboard picker is not the one this check knows — blind, not green');
    assert.match(picker, /onSaveAs=\{/, 'the spoilboard picker lost its Save as wiring');
    assert.match(picker, /savedSpoilboards\.saveAs\(/, 'Save as no longer writes to the collection');
  },
};

test('a blank thickness is omitted from the config, never sent as a zero', () => {
  CHECKS.blankThicknessOmitted(app());
});

test('the thickness field is text, so blank survives as blank', () => {
  CHECKS.thicknessIsText(app());
});

test('the declared board is re-graded against travel on every render', () => {
  CHECKS.reachReAsked(app());
});

test('the spoilboard picker can save, and writes to the collection that had no producer', () => {
  CHECKS.saveAsWired(app());
  // 🔴 THE COLLECTION EXISTED THE WHOLE TIME. A `spoilboards` store with no
  // producer is indistinguishable on disk from a shop that never saved a board,
  // which is why this went unnoticed rather than unreported.
  assert.match(app(), /useSaved<SavedSpoilboard>\('spoilboards'\)/, 'the collection lost its producer');
});

test('a saved board is the MEASURED form, and one function decides which ids those are', () => {
  const t = app();
  /* 🔴 ONE DECISION, NOT FIVE COMPARISONS. Before this, `spoilboardId ===
   * SPOILBOARD_CUSTOM` was spelled at five sites — the config branch, the size
   * fields, the `unparseable` list, the inventory refusal and the
   * catalogue-waiting note — and a second measured form had to be added to all
   * five or the app would send a saved board as a catalogue id.
   *
   * The function itself was extracted to `panels/spoilboardHelpers.ts` by
   * `6c9031e87b`; the five ASKING sites are still in `App.tsx`, so the count
   * below reads the callers here and the definition there. */
  const helpers = readFileSync(join(here, '..', 'src', 'panels', 'spoilboardHelpers.ts'), 'utf8');
  assert.match(helpers, /function isMeasuredBoardId\(id: string\): boolean \{/);
  const sites = (t.match(/isMeasuredBoardId\(/g) ?? []).length;
  assert.ok(sites >= 5, `only ${sites} sites ask the measured question — one was left comparing ids`);
  // The raw comparison survives ONLY inside the function that owns it.
  const raw = (t.match(/spoilboardId === SPOILBOARD_CUSTOM/g) ?? []).length;
  assert.equal(raw, 0, 'a branch still compares the sentinel directly instead of asking');
  const rawHelpers = (helpers.match(/=== SPOILBOARD_CUSTOM/g) ?? []).length;
  assert.equal(
    rawHelpers,
    1,
    'the sentinel comparison is not exactly the one inside isMeasuredBoardId — the decision has a second owner',
  );
});

// ---------------------------------------------------------------------------
// LEG 3 — TODO #107. The About list, checked against the code it describes.
// ---------------------------------------------------------------------------

test('the never-cut statement is NOT inside a collapsible section', () => {
  const t = app();
  /* 🔴 A SHUT SECTION RENDERS NOTHING AND THE COLLAPSE IS STICKY. A never-cut
   * statement that lived only inside `panel-about` could be switched off
   * permanently by a click nobody remembers making — the same hole TODO #106
   * records the spoilboard badge existing to close. */
  const banner = t.indexOf('data-testid="cnc-unproven"');
  /* The first panel in the CNC sidebar. Anchored on a TESTID rather than on
   * `<Section`, because `Section`'s own definition and its doc comments appear
   * far earlier in this file — an anchor that matched those would put the
   * banner "after the first section" whatever the JSX actually does, which is a
   * control that can only ever be red. */
  const firstPanel = t.indexOf('testid="panel-machine"');
  const tabOpen = t.indexOf('<TabPanel id="cnc"');
  assert.ok(banner > 0, 'the CNC tab lost its never-cut banner');
  assert.ok(tabOpen > 0 && banner > tabOpen, 'the never-cut banner left the CNC tab');
  assert.ok(
    banner < firstPanel,
    'the never-cut banner moved inside the sidebar, where a collapsed section can hide it'
  );
  /* 🔴 ONE CONSTANT, TWO SURFACES — AND THE ASSERTION IS ON THE SENTENCE, NOT
   * ON THE IDENTIFIER. Counting `CNC_NEVER_CUT` counts comments too and moves
   * whenever anyone mentions it in prose; what must not happen is a second COPY
   * of the words, which is how TODO #106's duplicated notes were produced. The
   * text may appear exactly once in this file: in the constant. */
  assert.equal(
    (t.match(/Nothing this app has emitted has ever cut anything\./g) ?? []).length,
    1,
    'the never-cut sentence is written twice — the two surfaces can now drift apart'
  );
  assert.equal(
    (t.match(/\{CNC_NEVER_CUT\}/g) ?? []).length,
    2,
    'the never-cut constant is rendered somewhere other than the banner and the About panel'
  );
});

test('the About panel exists and is reachable', () => {
  const t = app();
  /* ⚠ IT MOVED ON 2026-08-11 AND THIS ASSERTION MOVED WITH IT — TODO #107/#108.
   * About was a collapsible `Section` in the sidebar, and its own note said it
   * lived there only until a menu bar arrived: *"when #108 lands, Help → About
   * should render CNC_ABOUT_LINES rather than a second list"*. The bar landed, so
   * About is now the dialog `Help → About` opens. The TESTID is deliberately
   * unchanged — a move that renames every hook makes every assertion about it go
   * blind rather than red — and what is asserted is unchanged too: it exists, it
   * is reachable, and it renders the one constant rather than a second list. */
  assert.ok(t.includes('data-testid="panel-about"'), 'the CNC tab has no About surface');
  assert.match(t, /CNC_ABOUT_LINES\.map\(/, 'the About surface stopped rendering its own list');
  assert.match(
    t,
    /case 'help\.about':\s*\n\s*setAboutOpen\(true\)/,
    'Help → About is not wired to anything — the menu item is a dead control',
  );
  /* 🔴 AND IT IS THE ONLY About. The sidebar `Section` is gone in the same
   * change: two doors to one page of text is the duplication this tab spent the
   * day removing, and the panel existed only as the stand-in for this menu. */
  assert.equal(
    (t.match(/testid="panel-about"/g) ?? []).length,
    1,
    'there are two About surfaces — the sidebar panel was supposed to leave with the menu',
  );
});

/**
 * The About list, paired with the Rust each claim is about.
 *
 * 🔴 TAKEN AS ARGUMENTS SO A PLANT CAN MOVE EITHER SIDE. The failure this
 * guards is DRIFT, and drift has two directions: somebody softens a sentence,
 * or somebody changes the code and leaves the sentence. A control that could
 * only be planted from one side would prove half of it.
 */
function aboutMatchesCode(appSrc: string, rust: (name: string) => string) {
  const lines = /const CNC_ABOUT_LINES: readonly string\[\] = \[([\s\S]*?)\n\];/.exec(appSrc)?.[1];
  assert.ok(lines, 'the About list is not the one this check knows — blind, not green');
  assert.match(lines, /SUBTRACTIVE CNC ONLY/, 'the About list stopped saying this is CNC only');
  assert.match(
    rust('tech.rs'),
    /pub fn implemented\(self\) -> bool \{\s*matches!\(self, Self::Cnc\)/,
    'a second technology reports itself implemented — the About list says there is none'
  );
  assert.match(lines, /Cutter compensation is NEVER emitted/, 'the About list softened the cutter-comp claim');
  assert.match(
    rust('types.rs'),
    /supports_cutter_comp: false,/,
    'the machine default now claims cutter compensation — the About list says it is never emitted'
  );
  assert.match(lines, /AN STL IS SECTIONED AT ONE Z/, 'the About list stopped calling an STL import a section');
  assert.match(
    rust('mesh.rs'),
    /pub fn section\(mesh: &Mesh, z_mm: f64, tol: f64\) -> Imported \{/,
    'the mesh entry point changed shape — the About list describes a single-Z section'
  );
}

test('every About claim this test can reach still matches the code it describes', () => {
  const t = app();
  const lines = /const CNC_ABOUT_LINES: readonly string\[\] = \[([\s\S]*?)\n\];/.exec(t)?.[1];
  assert.ok(lines, 'the About list is not the one this check knows — blind, not green');
  aboutMatchesCode(t, coreFile);

  /* 🔴 EACH ASSERTION IS A PAIR: the sentence, and the Rust it is about. A
   * claim list that only asserts its own text is a list that agrees with
   * itself — which is exactly the state the 2026-08-11 drift was in. */

  // CNC only.
  assert.match(lines, /SUBTRACTIVE CNC ONLY/);
  assert.match(
    coreFile('tech.rs'),
    /pub fn implemented\(self\) -> bool \{\s*matches!\(self, Self::Cnc\)/,
    'a second technology reports itself implemented — the About list says there is none'
  );

  // No cutter compensation.
  assert.match(lines, /Cutter compensation is NEVER emitted/);
  assert.match(
    coreFile('types.rs'),
    /supports_cutter_comp: false,/,
    'the machine default now claims cutter compensation — the About list says it is never emitted'
  );

  // An STL is one section.
  assert.match(lines, /AN STL IS SECTIONED AT ONE Z/);
  assert.match(
    coreFile('mesh.rs'),
    /pub fn section\(mesh: &Mesh, z_mm: f64, tol: f64\) -> Imported \{/,
    'the mesh entry point changed shape — the About list describes a single-Z section'
  );

  // The picture is not the program.
  assert.match(lines, /THE PICTURE IS NOT THE PROGRAM/);

  /* 🔴 AND THE §13 LINE UNDER-CLAIMS, ON PURPOSE. This build has no network and
   * cannot check whether the footer link resolves; the lane's own record says it
   * does not and that the one repository holding this source is private. A
   * sentence reading "the offer is the link below" would be this panel vouching
   * for a URL nothing here checked — a link that reads as compliant and
   * delivers nothing is worse than one that visibly does not. */
  assert.match(lines, /NOT DISCHARGED/, 'the licence line now vouches for an offer nothing here checked');
});

// ---------------------------------------------------------------------------
// LEG 4 — THE NEGATIVE CONTROLS.
//
// 🔴 EACH PLANT RUNS THE LIVE CHECK OVER THE PLANTED COPY and asserts it
// THROWS. A plant that only proves the string replacement landed proves the
// plant, not the gate. Nothing is written to the tree.
// ---------------------------------------------------------------------------

function plant(name: keyof typeof CHECKS, mutate: (t: string) => string) {
  const clean = app();
  CHECKS[name](clean); // precondition: green before the plant
  const planted = mutate(clean);
  assert.notEqual(planted, clean, 'the plant did not apply — the control below would be vacuous');
  assert.throws(() => CHECKS[name](planted), `${name} stayed GREEN with the defect planted`);
}

test('PLANT: an undeclared thickness sent as a number goes RED', () => {
  // The exact edit somebody makes to "tidy up" the spread: it compiles, it
  // reads better, and it turns "nobody measured this board" into a 0mm board
  // that answers the through-the-board question favourably.
  plant('blankThicknessOmitted', (t) =>
    t.replace(
      /\.\.\.\(typedMm\(spoilboardThickness\) === undefined\s*\n?\s*\?\s*\{\}\s*\n?\s*:\s*\{ thickness_mm: typedMm\(spoilboardThickness\) \}\),/,
      'thickness_mm: Number(spoilboardThickness),'
    )
  );
});

test('PLANT: the thickness field turned into a number input goes RED', () => {
  plant('thicknessIsText', (t) =>
    t.replace(
      /(<input\n\s*)type="text"(\n\s*inputMode="decimal"\n\s*placeholder="not declared — depth check)/,
      '$1type="number"$2'
    )
  );
});

test('PLANT: an edited board that no longer fits, accepted silently, goes RED', () => {
  // 🔴 THE FOUNDER-FACING DEFECT, planted two ways in one edit: the verdict is
  // not computed, so nothing re-grades the board after a size change, and the
  // line that would have said so is not on the panel.
  plant('reachReAsked', (t) =>
    t
      .replace(/const reach =\n\s*Number\.isFinite\(sizeX\)/, 'const reach: null =\n                null && Number.isFinite(sizeX)')
      .replace('data-testid="spoilboard-reach"', 'data-testid="spoilboard-reach-removed"')
  );
});

test('PLANT: Save as unwired again goes RED', () => {
  // The whole handler removed — the state #104 found the picker in.
  plant('saveAsWired', (t) =>
    t.replace(/\n\s*onSaveAs=\{\(it, _draft, newName\) => \{[\s\S]*?\n {20}\}\}/, '')
  );
});

test('a Save that cannot tell which board it means REFUSES, and says so', () => {
  const t = app();
  /* 🔴 #102 IS A FORK WITH THE FOUNDER AND THIS CALL SITE HAS ITS SHAPE.
   * `previewItem` follows the ARROWED row, not the selected one, so an operator
   * looking at one board's properties while another is declared has two
   * plausible readings of `Save as` and this app is not allowed to pick one.
   * Both handlers ask the same function, and the ambiguous case writes NOTHING
   * and prints why — never a silent no-op, which is indistinguishable from a
   * broken button. */
  assert.match(t, /const saveTargetRefusal = \(it: ObjectItem \| null\): string \| null => \{/);
  assert.match(t, /if \(!it \|\| it\.id === spoilboardId\) return null;/,
    'the refusal stopped letting the unambiguous cases through');
  // BOTH doors ask it. A guard on one of two save paths is not a guard.
  assert.equal(
    (t.match(/const why = saveTargetRefusal\(it\);/g) ?? []).length,
    2,
    'only one of Save / Save as asks which board it means'
  );
  assert.ok(t.includes('data-testid="spoilboard-save-refused"'), 'the refusal is computed and never shown');
});

test('PLANT: an About claim contradicted by the code goes RED, from EITHER side', () => {
  // 🔴 SIDE ONE — THE SENTENCE MOVES. The tidy-looking edit: a claim reworded
  // into something weaker that reads fine and is no longer what the code does.
  const softened = app().replace(
    'Cutter compensation is NEVER emitted',
    'Cutter compensation is applied where the controller supports it'
  );
  assert.notEqual(softened, app(), 'the plant did not apply — the control below would be vacuous');
  assert.throws(
    () => aboutMatchesCode(softened, coreFile),
    'a softened capability claim stayed GREEN'
  );

  // 🔴 SIDE TWO — THE CODE MOVES AND THE SENTENCE DOES NOT. This is the failure
  // that actually happened on 2026-08-11: a list that was true when written and
  // was still being read as current. The plant is on the RUST, over a copy.
  const planted = (name: string) =>
    name === 'types.rs'
      ? coreFile(name).replace(/supports_cutter_comp: false,/, 'supports_cutter_comp: true,')
      : coreFile(name);
  assert.notEqual(planted('types.rs'), coreFile('types.rs'), 'the plant did not apply');
  assert.throws(
    () => aboutMatchesCode(app(), planted),
    'the About list stayed GREEN after the code it describes changed under it'
  );
});
