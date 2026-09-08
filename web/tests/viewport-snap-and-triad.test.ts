// The two founder reports the viewport's overlay column carries — TODO #110 and
// #111 — and the four ways a later tidy-up quietly undoes them.
//
// ══════════════════════════════════════════════════════════════════════════
//  🔴 WHAT THIS DELIBERATELY CANNOT SEE — read this before trusting a green
// ══════════════════════════════════════════════════════════════════════════
//
//  1. **IT IS A SOURCE-TEXT CHECK AND THERE IS NO WebGL HERE.** It reads
//     `Viewport.tsx` as bytes. It can say the refusal is in JSX rather than in a
//     `title=`, and it cannot say the operator can read it — that is layout, it
//     needs a browser, and `web/e2e/` is where it would live. Nothing in this
//     file is evidence that anything was DRAWN.
//
//  2. **"AT THE TOP" IS SOURCE ORDER, NOT SCREEN ORDER.** The overlay column is
//     a `flexDirection: 'column'` with no `order` property anywhere in it, so
//     source order IS paint order today. A future `order:` or an absolutely
//     positioned child would break that link and this check would not notice.
//
//  3. **IT CANNOT SEE A SENTENCE THAT GOES STALE.** It asserts the `edges`
//     refusal is present in both places; whether the words still describe
//     `snapAxis` is `snapAxis`'s own tests' job.
//
// ══════════════════════════════════════════════════════════════════════════

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
/* The two pure functions the 2026-08-11 datum fix added. Imported rather than
 * grepped for, because an arithmetic claim checked by a regex is a claim about
 * the spelling. Nothing else in this file needs a module. */
import { axesRootNote, axesRootZMm, boardSlab } from '../src/Viewport.tsx';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '..', 'src', 'Viewport.tsx');
const src = () => readFileSync(SRC, 'utf8');

/**
 * Where a testid is DECLARED, as a character offset.
 *
 * ⚠ Comments in this file quote testids in the bare `[data-testid=gap-status]`
 * form, so the quote in the pattern is load-bearing: without it a note about a
 * control would order ahead of the control.
 */
function at(text: string, id: string): number {
  const i = text.indexOf(`data-testid="${id}"`);
  assert.ok(i > 0, `${id} is gone from the viewport — this check is blind, not green`);
  return i;
}

// ---------------------------------------------------------------------------
// #110 — the row moved, and its reasoning came with it
// ---------------------------------------------------------------------------

test('the snap row is the first thing in the overlay column, above the axes caption', () => {
  const text = src();
  const snap = at(text, 'snap-controls');
  assert.ok(
    snap < at(text, 'axes-frame'),
    'the founder asked for the snap row at the top and it is now below the axes caption'
  );
  // Everything else in the column is reporting; the snap row is the only
  // control. If a second control lands above it, that is a decision somebody
  // should make on purpose rather than by insertion point.
  for (const id of ['loaded-unavailable', 'walls-unavailable', 'result-unavailable', 'gap-status']) {
    assert.ok(snap < at(text, id), `the snap row fell below ${id}`);
  }
});

test('the three snap chips keep their testids and their pressed state', () => {
  const text = src();
  for (const id of ['snap-grid-off', 'snap-edges']) {
    assert.ok(text.includes(`data-testid="${id}"`), `${id} lost its testid`);
  }
  assert.ok(
    /data-testid=\{`snap-grid-\$\{s\}`\}/.test(text),
    'the 1/5/10mm chips lost their generated testids'
  );
  // 🔴 `aria-pressed` is the ONLY thing that says which step is live to anyone
  // not reading the opacity — and opacity is not a state, it is a style. Three
  // controls, three assertions, because a move that drops one is exactly the
  // kind of edit that keeps the other two.
  assert.equal(
    (text.match(/aria-pressed=\{/g) ?? []).length,
    3,
    'a snap chip lost aria-pressed in a move, or gained a fourth nobody counted'
  );
});

test('every tooltip that explained a snap chip is still a tooltip — none was deleted in the move', () => {
  const text = src();
  // The three sentences the founder could only reach by hovering. They stay in
  // `title=`; the point of #110 was never to delete them.
  assert.match(text, /title="No grid step\. The drag still rounds to 0\.1mm/, 'the `off` reasoning is gone');
  assert.match(
    text,
    /title=\{`Round the datum to \$\{s\}mm\. The field shows the snapped number/,
    'the 1/5/10mm reasoning is gone'
  );
  assert.match(text, /Snap to the machine origin, the travel limits/, 'the `edges` tooltip is gone');
});

test('the `edges` refusal is readable WITHOUT hovering, and still on hover too', () => {
  const text = src();
  // On the screen: its own element, so it cannot be mistaken for part of a
  // neighbouring caption.
  assert.ok(
    text.includes('data-testid="snap-edges-limit"'),
    'the no-contact refusal is back to being hover-only — the exact defect #110 was raised for'
  );
  // 🔴 AND IT IS RENDERED FROM THE CONTROL'S OWN STATE. A line that is always
  // there is a line nobody reads; a line gated on the wrong thing is worse.
  assert.match(
    text,
    /\{edgeSnap && \(\s*<span data-testid="snap-edges-limit"/,
    'the refusal line is no longer tied to the edge snap being ON'
  );
  // The word that carries it. `flush` is the gesture; `contact target` is what
  // `snapAxis` refuses to offer. Both, because a paraphrase of one is not the
  // other.
  const line = /data-testid="snap-edges-limit"[\s\S]{0,400}?<\/span>/.exec(text)?.[0] ?? '';
  assert.match(line, /contact target/, 'the refusal no longer names what is missing');
  assert.match(line, /flush/, 'the refusal no longer names the gesture it refuses');
  // And the tooltip keeps its own copy — the hover is not the problem, being
  // ONLY in the hover was.
  assert.match(text, /There is no CONTACT target/, 'the tooltip lost the refusal');
});

test('the row states its own stakes inline, not in a tooltip', () => {
  const text = src();
  // The header comment's sentence, on the screen. Seven words is the budget
  // this column has for it; three tooltips pasted into the viewport is the
  // clutter the same sweep was removing.
  assert.match(
    text,
    />snap — changes the datum, which changes the program</,
    'the row is labelled `snap` again with no statement of what it changes'
  );
});

// ---------------------------------------------------------------------------
// #111 — the triad's lift
// ---------------------------------------------------------------------------

test('the machine triad is rooted at the DECLARED datum — the lift is gone and stays gone', () => {
  const text = src();
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  // 🔴 The symbol itself. The CAD tab's parity test bans it THERE; this bans it
  // HERE, which is where it was. A ban that only covers the tab that never had
  // the defect is a ban on the wrong file.
  assert.ok(!/\baZ\b/.test(code), 'the `aZ` lift is back in the CNC triad');
  assert.ok(
    !/new THREE\.Vector3\(0, 0, 0\.4\)/.test(code),
    'the triad is rooted somewhere other than the machine origin'
  );
  /* 🔴 THIS ASSERTION USED TO REQUIRE A LITERAL `0` IN Z, and it was right to
   * until 2026-08-11: with the datum unavailable, plan zero was the only
   * defensible root and an invented one was the worse answer. The datum is
   * passed now, so a literal zero here is the DEFECT — the triad drawn at the
   * picture's zero under a declared bottom datum, which is one workpiece
   * thickness wrong on exactly the jobs the founder's ruling exists for. X and
   * Y stay literal: no datum declaration moves the machine's XY origin. */
  assert.match(
    code,
    /const mo = new THREE\.Vector3\(0, 0, axesRootZMm\(props\.zDatum, sz\)\);/,
    'the triad root is not the declared Z datum'
  );
  // All three arrows off ONE root. Three roots is three origins.
  assert.equal(
    (code.match(/\n\s*arrow\(mo, /g) ?? []).length,
    3,
    'an axis arrow is drawn from something other than the shared root'
  );
});

test('the datum decides the root, and the two formulae are the core’s', () => {
  // 🔴 THE FUNCTION, NOT THE SOURCE TEXT. Everything else in this file is a
  // byte check over `Viewport.tsx`; this is the one arithmetic claim in the
  // change, so it is EXERCISED. `axesRootZMm` is exported for exactly this.
  assert.equal(axesRootZMm('workpiece-top', 18), 0, 'the top datum stopped being the scene zero');
  assert.equal(
    axesRootZMm('spoilboard-top', 18),
    -18,
    'the bottom datum is not at Spoilboard::top_face_z_mm(18) = -18'
  );
  // The two formulae are `core/src/types.rs`'s and `boardSlab` applies the same
  // pair. A root that disagreed with the board's own top face would draw the
  // declared zero somewhere the board is not.
  assert.equal(
    axesRootZMm('spoilboard-top', 12),
    boardSlab({ x_mm: 0, y_mm: 0, size_x_mm: 100, size_y_mm: 100, thickness_mm: 18 }, 12).topZMm,
    'the triad root and the board’s top face have drifted apart'
  );
  // 🔴 A NON-FINITE THICKNESS FALLS BACK, AND IT MUST NOT BE `NaN`. Three.js
  // puts a `NaN` position at nowhere and the app silently loses its only axis
  // indicator — read as "there are no axes", never as "the thickness is not a
  // number". The caption is what says so; this is what keeps the arrows drawn.
  for (const bad of [NaN, Infinity, -Infinity]) {
    assert.equal(axesRootZMm('spoilboard-top', bad), 0, `a ${bad} thickness reached the root`);
  }
  // The top datum never reads the thickness at all, so it cannot be poisoned by
  // one.
  assert.equal(axesRootZMm('workpiece-top', NaN), 0);
});

test('the z-fight the lift dodged is handled in DEPTH ONLY, on the face, not by moving the instrument', () => {
  const text = src();
  // The workpiece carries the bias, because WebGL's polygon offset is
  // fill-only and cannot move a `THREE.Line`. Positive = away from the camera,
  // so anything drawn AT the datum wins.
  const stock = /const stockMat = track\(\s*new THREE\.MeshStandardMaterial\(\{[\s\S]*?\}\)\s*\);/.exec(text)?.[0];
  assert.ok(stock, 'the workpiece material is not the one this check knows — blind, not green');
  assert.match(stock, /polygonOffset: true,/, 'the workpiece lost its depth bias, so the flat arrows z-fight again');
  assert.match(stock, /polygonOffsetFactor: 1,/, 'the bias direction changed — negative pulls the face IN FRONT of the arrows');
  assert.match(stock, /polygonOffsetUnits: 1,/, 'the bias units changed');
  // No vertex moved: the workpiece is still exactly as thick as declared.
  assert.match(text, /new THREE\.BoxGeometry\(sx, sy, sz\)/, 'the workpiece geometry is no longer the declared block');
});

test('the caption moved WITH the arrows — it names the declared datum and no longer disclaims it', () => {
  const top = axesRootNote('workpiece-top', 18);
  const bottom = axesRootNote('spoilboard-top', 18);

  // 🔴 THE STALE-EXPLANATION CHECK, and it is the whole reason this test was
  // rewritten rather than deleted. Until the datum was passed, this sentence
  // ended *"this picture's zero, not the job's declared Z zero"* — an honest
  // disclaimer of a fact the component did not have. The arrows are now drawn AT
  // the declared Z zero, so that clause has become a false explanation of a
  // fixed problem, which is a defect in its own right and a worse one than the
  // ambiguity it used to describe. Neither datum may carry it.
  for (const [name, note] of [['top', top], ['bottom', bottom]] as const) {
    assert.ok(
      !/not the job’s declared Z zero/.test(note),
      `the ${name}-datum caption still disclaims a datum the triad is now drawn at`
    );
    assert.match(note, / The arrows meet at the machine origin, in the workpiece’s /,
      `the ${name}-datum caption no longer says where the arrows meet`);
    // 🔴 PLANE, not FACE. The workpiece only covers the machine origin while
    // `stockOrigin` is near [0,0]; move it inboard and the arrows meet in
    // mid-air at that height. A caption saying "on the top face" would then be
    // describing a picture that is not on the screen.
    assert.ok(
      !/on the workpiece.{0,4}s? top.face\b/.test(note),
      `the ${name}-datum caption claims the arrows land ON the workpiece`
    );
    // It says DECLARED. Where the operator says Z0 is and where they touched
    // off are two facts, and only the first reaches this app.
    assert.match(note, /declares Z 0/, `the ${name}-datum caption asserts a datum instead of relaying a declaration`);
  }

  // The two datums say DIFFERENT surfaces, and each says the one the core does.
  assert.match(top, /the workpiece top\./, 'the top datum stopped naming the workpiece top');
  assert.match(bottom, /the spoilboard top\./, 'the bottom datum stopped naming the spoilboard top');
  assert.ok(!/spoilboard/.test(top), 'the top-datum caption names the board, which is not its datum');
  // The distance is stated, because "one workpiece thickness lower" is the
  // whole content of the difference and the picture cannot carry a number.
  assert.match(bottom, /18 mm below its top face/, 'the bottom datum stopped saying how far down it is');
  // 🔴 AND IT NAMES THE SURFACE THE MACHINE MUST BE ZEROED AGAINST.
  // `ZDatum::SpoilboardTop`'s own doc: a datum arithmetically at the bottom and
  // physically referenced to the workpiece TOP is worse than doing nothing.
  assert.match(bottom, /Zero the machine against the BOARD/, 'the bottom datum stopped stating its precondition');

  // A thickness that is not a number cannot say how far down the datum is, and
  // it says THAT rather than printing `NaN mm` or falling silent.
  const bad = axesRootNote('spoilboard-top', NaN);
  assert.ok(!/NaN/.test(bad), 'a NaN thickness reached the operator’s caption');
  assert.match(bad, /is NOT the declared Z zero/, 'the fallback root is drawn without saying it is a fallback');

  // It reaches all three frame states, not just the square one.
  const text = src();
  assert.equal(
    (text.match(/\+ rootNote|^\s+rootNote,$/gm) ?? []).length,
    3,
    'a frame state lost the root note, so the caption depends on how the workpiece is laid'
  );
  // And the caption is computed from the SAME two arguments as the root, so the
  // sentence and the geometry cannot answer different questions.
  assert.match(
    text,
    /axesRootNote\(props\.zDatum, props\.stock\[2\]\)/,
    'the caption no longer reads the same datum and thickness the triad is rooted from'
  );
});

// ---------------------------------------------------------------------------
// LEG 4 — THE NEGATIVE CONTROLS.
//
// 🔴 EACH PLANT RUNS THE LIVE CHECK OVER THE PLANTED COPY and asserts it
// THROWS. A plant that only proves the string replacement landed proves the
// plant, not the gate — this lane has shipped that mistake before. Nothing is
// written to the tree.
// ---------------------------------------------------------------------------

/** The four checks above, as predicates over arbitrary source. */
const CHECKS = {
  edgesVisible: (t: string) => {
    assert.ok(t.includes('data-testid="snap-edges-limit"'));
    assert.match(t, /\{edgeSnap && \(\s*<span data-testid="snap-edges-limit"/);
  },
  rowAtTop: (t: string) => {
    assert.ok(at(t, 'snap-controls') < at(t, 'axes-frame'));
  },
  noLift: (t: string) => {
    const code = t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/\baZ\b/.test(code));
    assert.match(code, /const mo = new THREE\.Vector3\(0, 0, axesRootZMm\(props\.zDatum, sz\)\);/);
  },
  /* 🔴 THE TRIAD AT PLAN ZERO UNDER A DECLARED BOTTOM DATUM — the defect this
   * whole change removes, and the one the founder's ruling makes physical. It
   * is asserted over the SOURCE and not over `axesRootZMm`, because the failure
   * that actually happened was not wrong arithmetic: it was correct arithmetic
   * nobody called. A check that only exercised the function would have stayed
   * green for the entire period the prop was unwired. */
  rootIsTheDatum: (t: string) => {
    const code = t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.match(code, /const mo = new THREE\.Vector3\(0, 0, axesRootZMm\(/);
    assert.match(code, /\bzDatum: ZDatumName;/, 'the datum stopped being a required prop');
  },
  /* 🔴 THE SENTENCE THAT MUST NOT SURVIVE THE FIX. `String.replace` is the plant
   * and the note is a function now, so the anchor is the WORD the old caption
   * disclaimed with. Kept as its own check rather than folded into
   * `rootIsTheDatum`: the two failures are independent — arrows that move with
   * a caption that does not, and a caption that moves with arrows that do
   * not — and one control covering both would report either as the other. */
  captionNotStale: (t: string) => {
    assert.ok(
      !/not the job’s declared Z zero/.test(t),
      'the caption still disclaims a datum the triad is now drawn at'
    );
    assert.match(t, /declares Z 0/, 'the caption stopped naming the declared datum at all');
  },
  tooltipsKept: (t: string) => {
    assert.match(t, /title="No grid step\. The drag still rounds to 0\.1mm/);
  },
};

/** Apply a plant, prove it applied, and prove the named check goes red on it. */
function plant(name: keyof typeof CHECKS, mutate: (t: string) => string) {
  const clean = src();
  CHECKS[name](clean); // precondition: green before the plant
  const planted = mutate(clean);
  assert.notEqual(planted, clean, 'the plant did not apply — the control below would be vacuous');
  assert.throws(() => CHECKS[name](planted), `${name} stayed GREEN with the defect planted`);
}

test('PLANT: the edges refusal back to hover-only goes RED', () => {
  plant('edgesVisible', (t) =>
    t.replace(
      /\{edgeSnap && \(\s*<span data-testid="snap-edges-limit"/,
      '{false && (\n        <span data-testid="snap-edges-limit-removed"'
    )
  );
});

test('PLANT: the snap row put back under the axes caption goes RED', () => {
  // The row is moved by swapping the two testids, which is the smallest edit
  // that produces exactly the DOM order the founder asked to be rid of.
  plant('rowAtTop', (t) =>
    t
      .replace('data-testid="snap-controls"', 'data-testid="__tmp__"')
      .replace('data-testid="axes-frame"', 'data-testid="snap-controls"')
      .replace('data-testid="__tmp__"', 'data-testid="axes-frame"')
  );
});

test('PLANT: the lift put back goes RED', () => {
  plant('noLift', (t) =>
    t.replace(
      /const mo = new THREE\.Vector3\(0, 0, axesRootZMm\(props\.zDatum, sz\)\);/,
      'const aZ = 0.4;\n      const mo = new THREE.Vector3(0, 0, aZ);'
    )
  );
});

test('PLANT: the triad back at plan zero under a declared datum goes RED', () => {
  // The smallest edit that reproduces the state HEAD was in until 2026-08-11:
  // the datum available and the root ignoring it.
  plant('rootIsTheDatum', (t) =>
    t.replace(
      /const mo = new THREE\.Vector3\(0, 0, axesRootZMm\(props\.zDatum, sz\)\);/,
      'const mo = new THREE.Vector3(0, 0, 0);'
    )
  );
});

test('PLANT: the datum made an optional prop goes RED', () => {
  // 🔴 A DIFFERENT DEFECT WITH THE SAME SYMPTOM. `zDatum?: ZDatumName` compiles,
  // and `axesRootZMm(undefined, …)` returns 0 — so an optional prop is the
  // silent route back to the triad at plan zero, reached by a caller that
  // simply stops passing it rather than by an edit anyone would review.
  plant('rootIsTheDatum', (t) => t.replace('zDatum: ZDatumName;', 'zDatum?: ZDatumName;'));
});

test('PLANT: the caption left disclaiming a datum the arrows now sit at goes RED', () => {
  plant('captionNotStale', (t) =>
    t.replace(
      / and that is where this job declares Z 0: the workpiece top\./,
      ' this picture’s zero, not the job’s declared Z zero.'
    )
  );
});

test('PLANT: a tooltip deleted rather than moved goes RED', () => {
  plant('tooltipsKept', (t) => t.replace(/\n\s*title="No grid step\.[^"]*"/, ''));
});
