// The 2bee.cad preview's overlays: the STALE marker, the trust verdict, and
// the two interaction defects the 2026-08-11 audit found.
//
// WHAT THIS FILE EXERCISES
//   · that the STALE marker RENDERS when the component is told the mesh is of a
//     previous source, and does not when it is not. The comment said it fires;
//     nothing asserted it.
//   · that the trust verdict on the picture is the one `meshScene` computed,
//     including the case where parse diagnostics — not geometry — are what
//     stopped it being `trusted`.
//   · that the STALE banner takes no pointer events. It spans the full width of
//     a surface whose only interaction is dragging.
//
// 🔴 NOT EXERCISED, stated rather than implied. `CadPreview` builds its scene,
// camera and pointer handlers inside `useEffect`, and `renderToStaticMarkup`
// runs no effects — so NOTHING here touches three.js, the camera, the orbit
// handlers or the canvas. This file tests the overlays, which are ordinary
// React markup. It cannot show that anything is drawn, that the geometry is
// right, or that a drag rotates. No claim is made that any of this was seen to
// render.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { CAD_DEFAULT_PROJECTION } from '../src/projection.ts';

const { parseScad } = await import('../src/cad/scad.ts');
const { meshScene } = await import('../src/cad/mesh.ts');
const { CadPreview } = await import('../src/cad/preview.tsx');

/* 🔴 THREE REQUIRED PROPS WERE NOT BEING PASSED, and while `tests/` sat outside
 * `tsconfig.json`'s `include` nothing said so: every render below handed
 * `CadPreview` a props object with `showAxes`, `showScaleMarkers` and
 * `resize` all `undefined`, a shape no caller in the app produces.
 *
 * The values here are `CadTab`'s own defaults (`CadLayout.axes` and
 * `.scaleMarkers` default TRUE — OpenSCAD's — and `resize` defaults to
 * `CAD_DEFAULT_PROJECTION`), so the fixture is now the caller rather than a
 * convenient one.
 *
 * ⚠ NO ASSERTION IN THIS FILE CHANGES, and the reason is worth stating rather
 * than hoping: all three are read only inside `CadPreview`'s effects, and
 * `renderToStaticMarkup` runs no effects — the header above already says so.
 * Passing them is therefore inert HERE. It is not inert for the next person who
 * adds an overlay that reads one of them. */
const VIEW = {
  showAxes: true,
  showScaleMarkers: true,
  projection: CAD_DEFAULT_PROJECTION,
} as const;

const HERE = dirname(fileURLToPath(import.meta.url));

const meshOf = (src: string) => meshScene(parseScad(src).scene);
const render = (src: string, stale: boolean) =>
  renderToStaticMarkup(h(CadPreview, { ...VIEW, result: meshOf(src), stale }));

const CLEAN = 'cube([10, 10, 10]);\n';

// ---------------------------------------------------------------------------
// The STALE marker
// ---------------------------------------------------------------------------

test('told the mesh is of a previous source, the preview says so on the picture', () => {
  const html = render(CLEAN, true);
  assert.match(html, /data-stale="yes"/);
  assert.match(html, /cad-preview-stale/);
  assert.match(html, /STALE — the source has changed/);
});

test('told it is current, the preview claims nothing about being behind', () => {
  const html = render(CLEAN, false);
  assert.match(html, /data-stale="no"/);
  assert.ok(!html.includes('cad-preview-stale'));
  assert.ok(!html.includes('STALE —'));
});

/**
 * 🔴 A DEAD BAND ACROSS A VIEWPORT IS INDISTINGUISHABLE FROM A BROKEN VIEWPORT.
 * The banner spans the full width across the top and holds nothing clickable;
 * left interactive it swallowed every `pointerdown` that began in that strip,
 * on a surface whose only interaction is dragging.
 */
test('the STALE banner takes no pointer events', () => {
  const html = render(CLEAN, true);
  const at = html.indexOf('data-testid="cad-preview-stale"');
  const tag = html.slice(html.lastIndexOf('<', at), html.indexOf('>', at) + 1);
  assert.match(tag, /pointer-events:none/);
});

// ---------------------------------------------------------------------------
// The trust verdict
// ---------------------------------------------------------------------------

/**
 * 🔴 THE GREEN IS GONE AND THIS IS THE ASSERTION THAT IT IS (founder,
 * 2026-08-11: *"remove MESH AUDITED"*). It is the INVERSE of the test that used
 * to live here, not a weakened version of it: that one matched
 * `MESH AUDITED — watertight` and the mesher's `trustDetail` on a clean model,
 * and this one requires that neither is on screen. A banner that fires on every
 * successful parse carries no information and trains the eye past the slot.
 *
 * ⚠ AND THE PERMANENT COUNTS STRIP WENT WITH IT (founder: *"no need to have
 * this msg: 5 solids · 0 2D · 804 triangles · 1 boolean computed · 10.5 ms"*).
 */
test('a clean audit says NOTHING on the picture — no verdict, no counts', () => {
  const mesh = meshOf(CLEAN);
  assert.equal(mesh.trust, 'trusted');
  const html = renderToStaticMarkup(h(CadPreview, { ...VIEW, result: mesh, stale: false }));
  assert.match(html, /data-trust="trusted"/, 'the verdict is still ON the element, for anything reading it');
  assert.ok(!html.includes('MESH AUDITED'), 'the green banner is back');
  assert.ok(!html.includes('cad-preview-alarm'), 'a clean audit must not raise the alarm element');
  assert.ok(!html.includes(mesh.trustDetail), 'a clean audit must not print its own reassurance');
  assert.ok(!/\btriangles\b/.test(html), 'the permanent counts readout is back');
  assert.ok(!/\bms\b/.test(html), 'the permanent timing readout is back');
});

/**
 * 🔴 THE OTHER HALF, AND THE ONE THAT MATTERS. Silence when clean is only safe
 * if the not-clean cases are unmistakable — the audit's answer is load-bearing
 * in three places (`preview.tsx` refuses to draw what it cannot stand behind,
 * `record.ts` refuses to save it, `Export as STL` refuses on the same terms).
 * Plant: make `quiet` unconditional and every case below goes red.
 */
test('every verdict that is NOT clean is stated loudly, by name', () => {
  const cases: [string, string, RegExp][] = [
    ['cube([10,10,10]);\nhulls() cube(5);\n', 'suspect', /PARTLY TRUSTED/],
    ['// just a comment\n', 'nothing', /NOTHING DRAWN/],
  ];
  for (const [src, trust, says] of cases) {
    const mesh = meshOf(src);
    assert.equal(mesh.trust, trust, `fixture drifted: ${src}`);
    const html = renderToStaticMarkup(h(CadPreview, { ...VIEW, result: mesh, stale: false }));
    assert.match(html, /cad-preview-alarm/, `${trust} raised no alarm`);
    assert.match(html, says);
    assert.ok(html.includes(mesh.trustDetail), `${trust} dropped the mesher's own sentence`);
  }
});

/**
 * 🔴 THE PATH THE AUDIT ASKED ABOUT: `meshScene` takes the PARSE diagnostics
 * into account, so a model whose geometry is fine but whose SOURCE had a
 * construct refused must not come back `trusted`. The picture would otherwise
 * be a clean-looking solid that is missing a feature.
 */
test('a refused construct stops the picture being trusted, even with sound geometry', () => {
  const src = 'cube([10,10,10]);\nhulls() cube(5);\n';
  const mesh = meshOf(src);
  assert.notEqual(mesh.trust, 'trusted', 'a refusal is geometry the source has and the picture does not');
  const html = renderToStaticMarkup(h(CadPreview, { ...VIEW, result: mesh, stale: false }));
  assert.equal(mesh.trust, 'suspect');
  assert.match(html, /data-trust="suspect"/);
  /* ⚠ `suspect` IS THE STATE MOST LIKELY TO BE MIS-READ AS FINE now that the
   * green is gone: sound geometry, MISSING a feature the source asked for. So
   * the word is asserted here and the sentence names what is missing. */
  assert.match(html, /PARTLY TRUSTED — this picture is missing something your source asked for/);
  /* The picture keeps the STATEMENT that it is a subset — here it arrives in
   * the mesher's own `trustDetail`, because a construct refused by the PARSER
   * is not a `MeshIssue` and so does not reach the "see the console" line. Both
   * paths end up in the console; only this one is also on the image. */
  assert.match(html, /construct\(s\) were REFUSED/);
});

test('nothing understood is reported as nothing drawn, not as a clean empty model', () => {
  const mesh = meshOf('// just a comment\n');
  assert.equal(mesh.trust, 'nothing');
  const html = renderToStaticMarkup(h(CadPreview, { ...VIEW, result: mesh, stale: false }));
  assert.match(html, /NOTHING DRAWN/);
});

/* ---------------------------------------------------------------------------
   The verdict BOX is gone, and what it was the only statement of is not
   --------------------------------------------------------------------------- */

/**
 * 🔴 INVERTED, NOT DELETED (founder, 2026-08-11: *"remove cad-preview-verdict"*).
 *
 * This test used to require `cad-preview-seeconsole` — *"N refused — drawn as
 * nothing … listed with its line in the console below"*. That line WAS a
 * duplicate and is the only part of the box that was: the console pane lists
 * every one of those diagnostics with its line, and the dock tab's badge carries
 * the count whatever pane is showing (`112d2e34b9`, which ruled the badge must
 * stay visible for exactly this reason).
 *
 * ⚠ SO THE ASSERTION MOVES ONTO THE THING THAT MUST SURVIVE: the statement that
 * the picture is a SUBSET of the model. It arrives in the mesher's own
 * `trustDetail`, which is the only path a PARSER refusal has onto the image at
 * all — a construct the parser refused is not a `MeshIssue` and never becomes a
 * console row about the mesh. Asserting only that the box is gone would let the
 * next edit take the subset statement with it and stay green.
 */
test('the see-the-console line is gone, and the subset statement is not', () => {
  const mesh = meshOf('difference() { cube(10); square(4); }\n');
  const html = renderToStaticMarkup(h(CadPreview, { ...VIEW, result: mesh, stale: false }));
  assert.ok(!html.includes('cad-preview-verdict'), 'the verdict box is back on the picture');
  assert.ok(!html.includes('cad-preview-seeconsole'), 'the picture repeats the console again');
  assert.ok(!html.includes('listed with its line in the console below'));
  /* The refusal still reaches the image, in the mesher's words. */
  assert.match(html, /cad-preview-alarm/, 'a refused construct raised nothing on the picture');
  assert.ok(html.includes(mesh.trustDetail), 'the mesher’s own sentence left the picture');

  /* ⚠ A SECOND FIXTURE, BECAUSE THE FIRST ONE CANNOT CARRY THE SENTENCE. A
   * boolean with a 2D operand is refused WHOLE, so nothing is drawn at all and
   * the verdict is `nothing` — a different message. The subset sentence belongs
   * to the case that matters more and is easier to miss: sound geometry that is
   * missing a feature the source asked for. Found by the assertion going red on
   * the wrong fixture, which is why both are here. */
  const partial = meshOf('cube([10,10,10]);\nhulls() cube(5);\n');
  assert.equal(partial.trust, 'suspect', 'fixture drifted');
  const partialHtml = renderToStaticMarkup(h(CadPreview, { ...VIEW, result: partial, stale: false }));
  assert.match(partialHtml, /subset of the model/, 'the picture no longer says it is a subset');
});

/**
 * 🔴 THE MESH AUDIT'S ANSWER HAS EXACTLY ONE HOME ON SCREEN, AND THIS IS IT.
 *
 * `consoleLines()` is built from `parse.errors`, `parse.unsupported`,
 * `parse.warnings` and `mesh.issues`. A part's `audit` is none of those, so an
 * open or non-manifold solid produces NO console row — and `MESH AUDITED` was
 * removed from this picture the same morning. Deleting the verdict box without
 * moving this list would have left the tab with no statement anywhere, outside a
 * menu, that a solid cannot be trusted.
 *
 * The unsound part is produced by the kernel's own negative control rather than
 * hand-built, so a wrong expectation cannot agree with a wrong implementation.
 */
test('an unsound solid is named on the picture, by line and by verdict', () => {
  const planted = meshScene(parseScad('color("red") cube(20);').scene, 'drop-face');
  const bad = planted.parts.find((p) => p.dim === 3 && p.audit?.verdict !== 'closed');
  assert.ok(bad, 'the plant produced no unsound part, so this test asserted nothing');
  const html = renderToStaticMarkup(h(CadPreview, { ...VIEW, result: planted, stale: false }));

  assert.match(html, /cad-preview-unsound/, 'the per-part audit list is gone from the picture');
  assert.match(html, new RegExp(`line ${bad!.line}`), 'the unsound part is not named by line');
  assert.ok(html.includes(bad!.audit!.verdict), 'the audit verdict word is not on the picture');
  assert.ok(html.includes(bad!.audit!.detail), 'the audit’s own reason is not on the picture');

  /* 🔴 AND THE OVERRIDE, which `fbfe2738f1` put on this overlay and nowhere
   * else: an unsound part is repainted in the error colour, so the picture
   * deliberately disagrees with a `color()` the operator wrote. Silently, unless
   * this sentence rides with it. */
  assert.match(html, /cad-preview-colour-overridden/, 'the colour override is no longer stated anywhere');
  assert.match(html, /carry a color\(\) this picture is NOT using/);
});

/**
 * ⚠ THE OTHER HALF OF THE SAME CUT. The box is gone from a clean model
 * ENTIRELY — border, padding and all — which is what the founder was looking at,
 * because the `Fit` row in it rendered unconditionally on every model. What must
 * NOT go with it is the control: `Fit` is the only caller of `refit` and the only
 * way back to a framed view now that the camera is not reset per mesh.
 */
test('a clean model carries no box at all, and still carries Fit', () => {
  const html = render(CLEAN, false);
  assert.ok(!html.includes('cad-preview-verdict'));
  assert.ok(!html.includes('cad-preview-alarm'), 'a clean audit put a block on the picture');
  assert.ok(!html.includes('cad-preview-unsound'));
  assert.ok(!html.includes('cad-preview-colour-overridden'));
  assert.match(html, /data-testid="cad-preview-fit"/, 'the only route back to a framed view went with the box');
});

test('the fit control is offered, because the camera is no longer reset for you', () => {
  const html = render(CLEAN, false);
  assert.match(html, /data-testid="cad-preview-fit"/);
});

// ---------------------------------------------------------------------------
// The viewport footer that was removed, and where its knowledge went
// ---------------------------------------------------------------------------

/**
 * 🔴 A REMOVAL IS ONLY SAFE ONCE THE KNOWLEDGE IN IT HAS A NEW HOME, AND THE
 * NEW HOME IS ASSERTED. Founder, 2026-08-11: *"remove: Drag to orbit · … ·
 * Nothing this lane has produced has ever been cut"*. Three sentences, and two
 * of them were load-bearing:
 *
 *   · the drag directions — moved to the viewport's own `title`;
 *   · **top-level shapes are NOT unioned** — a real semantic difference between
 *     the picture and the exported STL, moved to `KERNEL_LIMITS`, which
 *     `Help → About` prints;
 *   · the never-cut disclaimer — canon, so it is asserted to survive rather than
 *     assumed to.
 *
 * Asserting only that the footer is gone would let the next edit delete the
 * knowledge as well and stay green.
 */
test('the three-sentence footer is gone from the drawn viewport', () => {
  const html = render(CLEAN, false);
  /* ⚠ THE NEEDLE HAD TO BE MADE MORE PRECISE, NOT LESS: a first cut asserted the
   * string was absent from the markup and went red on the tooltip that is the
   * whole point of the move. So the visible text is what is asserted — the
   * markup with every `title` value taken out — and the tooltip is asserted
   * separately, below. A test that passed by dropping the tooltip would have
   * been the removal deleting the knowledge. */
  const visible = html.replace(/title="[^"]*"/g, '');
  assert.ok(!visible.includes('Drag to orbit'), 'the footer text is still under the picture');
  assert.ok(!visible.includes('as OpenSCAD'), 'the footer sentence is still under the picture');
  assert.ok(!html.includes('NOT unioned'));
  /* The camera control it shared a row with is NOT part of the removal — it is
   * the only thing that gives the whole model back after an orbit. */
  assert.match(html, /data-testid="cad-preview-fit"/);
});

test('the drag directions moved onto the viewport itself, not into nothing', () => {
  const html = render(CLEAN, false);
  assert.match(html, /title="[^"]*Drag to orbit[^"]*pan[^"]*zoom/);
});

test('“top-level shapes are NOT unioned” survives, in the report Help → About prints', () => {
  const tab = readFileSync(join(HERE, '..', 'src', 'cad', 'CadTab.tsx'), 'utf8');
  const limits = tab.slice(tab.indexOf('const KERNEL_LIMITS'), tab.indexOf('function Counts('));
  assert.match(limits, /NOT unioned/, 'the semantic difference was deleted rather than moved');
  assert.match(limits, /union\(\)/, 'and it must say what to do about it');
  /* KERNEL_LIMITS is only knowledge if something renders it. */
  assert.match(tab, /\.\.\.KERNEL_LIMITS,/);
});

/**
 * 🔴 CANON, NOT LANE PROSE. `CLAUDE.md` requires that nothing this lane emits be
 * described as having cut anything. Removing the sentence from one surface is
 * fine; removing it from the product is not — so this asserts it still reaches a
 * reader, and names where.
 *
 * ⚠ WHAT THIS DOES NOT CLAIM: that it is *prominent*. In the drawn case it is
 * now behind `Help → About`, and the CNC tab — which is the tab that actually
 * emits G-code — carries no such statement at all. Both are reported up rather
 * than asserted away here.
 */
test('the never-cut disclaimer still reaches a reader of the served UI', () => {
  const preview = readFileSync(join(HERE, '..', 'src', 'cad', 'preview.tsx'), 'utf8');
  const tab = readFileSync(join(HERE, '..', 'src', 'cad', 'CadTab.tsx'), 'utf8');
  assert.match(preview, /Nothing this lane has produced has ever been cut\./);
  assert.match(tab, /Nothing this lane has produced has ever cut anything\./);
});
