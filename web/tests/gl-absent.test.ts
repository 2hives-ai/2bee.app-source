// A machine with no working WebGL must get a PROGRAM, not a blank page.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE DEFECT THIS FILE GUARDS
// ─────────────────────────────────────────────────────────────────────────────
//
// Both `WebGLRenderer` construction sites in this app — `web/src/Viewport.tsx`
// and `web/src/cad/preview.tsx` — used to run unguarded inside a React effect.
// An exception thrown from an effect is not caught by React: it propagates out
// of the commit and UNMOUNTS THE WHOLE TREE, so `document.body` renders ZERO
// CHARACTERS. No panels, no settings, no refusals, no G-code, no download, and
// no sentence saying why.
//
// 🔴 THE CONSEQUENCE IS THE POINT. On a locked-down shop PC, a remote-desktop
// session, a VM, or a browser with hardware acceleration off, everything that
// matters still worked — the job planned, the checks ran, the program posted.
// The operator was denied a program they could have downloaded because a
// PICTURE failed.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT RUNS HERE, AND WHAT CANNOT
// ─────────────────────────────────────────────────────────────────────────────
//
// ✅ THE FAILURE IS REAL, NOT SIMULATED. There is no WebGL and no DOM in this
//    harness, so `tryRenderer` is called for real and genuinely fails. Nothing
//    below stubs a throw, monkey-patches three.js or asserts against a fake.
//
// ✅ The absence panel's markup, rendered through React the way the app renders
//    it, including the sentence quoted from the layer-toggle tooltips.
//
// 🔴 NOT EXERCISED, stated rather than implied:
//   · That either component MOUNTS into the degraded state. `renderToStatic-
//     Markup` runs no effects, and there is no DOM here to mount into — so the
//     `if (!attempt.ok) { setGl(...); return; }` branch is asserted at the
//     SOURCE TEXT (below), not by being executed. The same limitation, for the
//     same reason, as `tests/cad-camera-parity.test.ts`. A behavioural mount
//     test needs a browser and belongs in `web/e2e/`, which is not this file's
//     to write.
//   · That anything LOOKS right. Nobody has seen this panel render. A guard
//     that produces the correct markup may still be laid out wrongly, sit under
//     an overlay, or clip.
//   · Context LOSS after a successful construction (`webglcontextlost`, a GPU
//     reset, a driver crash). That arrives as an event, not as an exception
//     from the constructor, and nothing in the app watches for it yet.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(join(here, '..', 'src', p), 'utf8');

const { tryRenderer, GlUnavailable } = await import('../src/Viewport.tsx');

// ---------------------------------------------------------------------------
// The real failure
// ---------------------------------------------------------------------------

test('a renderer that cannot be built RETURNS a reason instead of throwing', () => {
  // For real. This box has no DOM and no WebGL, which is the whole reason this
  // assertion means anything: `new THREE.WebGLRenderer(...)` genuinely fails
  // here, exactly as it does in the Chromium on this machine where bare
  // `canvas.getContext('webgl')` returns null.
  const got = tryRenderer({ antialias: true, preserveDrawingBuffer: true });

  assert.equal(
    got.ok,
    false,
    'this harness has no DOM and no WebGL — a renderer that CONSTRUCTED here means ' +
      'the call was stubbed or short-circuited, and every assertion below is vacuous',
  );
  assert.equal(typeof (got as { detail: string }).detail, 'string');
  assert.ok(
    (got as { detail: string }).detail.length > 0,
    'an empty reason is the same as no reason: the panel would say the renderer failed ' +
      'with “”, which tells an operator nothing they can act on or report',
  );
});

test('the reason is the BROWSER’S OWN WORDS, one line, and bounded', () => {
  const got = tryRenderer({});
  assert.equal(got.ok, false);
  const detail = (got as { detail: string }).detail;
  // Whatever this environment happens to say. The point is that it is quoted
  // rather than replaced by a diagnosis this code did not make — three.js says
  // `Error creating WebGL context.` when it is handed a null context, a
  // hardened browser can throw from `createElementNS`, and this harness throws
  // `document is not defined`. All three are true statements about what
  // happened; none of them is "your GPU is disabled".
  assert.ok(!/\n/.test(detail), 'a multi-line message breaks the panel it is printed in');
  assert.ok(detail.length <= 241, 'a driver can return a paragraph; it is bounded on purpose');
});

// ---------------------------------------------------------------------------
// What the operator is told
// ---------------------------------------------------------------------------

const panel = (over: Record<string, string> = {}) =>
  renderToStaticMarkup(
    h(GlUnavailable, {
      testid: 'viewport-gl-unavailable',
      detail: 'Error creating WebGL context.',
      unaffected: 'The program, the checks and the simulation',
      stillWorks: 'Everything else on this page still works.',
      ...over,
    } as never),
  );

test('the absence names what failed and quotes what the renderer said', () => {
  const html = panel();
  assert.match(html, /data-testid="viewport-gl-unavailable"/);
  assert.match(html, /NO 3D VIEW/);
  assert.match(html, /could not create a WebGL context/);
  assert.match(html, /Error creating WebGL context\./);
});

/**
 * 🔴 ONE FACT, ONE PHRASING. *"… are unaffected by what is on screen"* is
 * already the sentence the layer-toggle tooltips use for exactly this fact
 * (the `eye` control's `title` — in `panels/SectionPanel.tsx` since `e076313391`
 * extracted `Section` there; the sentence moved with the control). An operator
 * who has read one of them must not have to work out whether the other means
 * something different.
 */
test('it says what the missing picture does NOT affect, in the app’s existing words', () => {
  const html = panel();
  assert.match(
    html,
    /The program, the checks and the simulation are unaffected by what is on screen\./,
  );

  // And the clause is the app's, not this file's invention: the same sentence
  // is in the layer-toggle tooltip today. If that copy is reworded, this goes
  // red and the two are reconciled deliberately rather than drifting apart
  // quietly.
  const sectionPanel = readFileSync(join(here, '..', 'src', 'panels', 'SectionPanel.tsx'), 'utf8');
  assert.ok(
    sectionPanel.includes('are unaffected by what is on screen'),
    'the clause this panel quotes has left the app — one of the two is now saying ' +
      'something the other does not, about the same fact',
  );
});

test('the CAD tab names ITS OWN subjects, not the CNC tab’s', () => {
  // The CAD tab holds no program and runs no simulation. Reusing the CNC list
  // there would name things that tab does not have — the clause is shared, what
  // it is said ABOUT is not.
  const html = panel({ unaffected: 'The parse, the mesh audit and the diagnostics' });
  assert.match(
    html,
    /The parse, the mesh audit and the diagnostics are unaffected by what is on screen\./,
  );
  assert.ok(!html.includes('The program, the checks and the simulation'));
});

/**
 * ⚠ A 2D FALLBACK IS THE TEMPTING WRONG ANSWER. A canvas drawing that looks
 * like the viewport but is not the scene the checks were run against is worse
 * than an honest absence — a picture that lies about a shape is worse than no
 * picture. The panel says so, so that the next person to "improve" this reads
 * the reason before deleting it.
 */
test('the absence states that nothing was drawn in the picture’s place', () => {
  assert.match(panel(), /Nothing has been drawn in place of the picture, on purpose/);
});

// ---------------------------------------------------------------------------
// 🔴 THE PLANT — remove the guard and this file goes red
// ---------------------------------------------------------------------------
//
// These are SOURCE-TEXT assertions, and the reason is the one in the header:
// the branch lives inside an effect that cannot run here. They are written to
// go red on the exact edit that reintroduces the defect — moving a
// `new THREE.WebGLRenderer(` back into an effect, or dropping the early return
// so the failure falls through into the scene wiring.

const viewport = read('Viewport.tsx');
const preview = read('cad/preview.tsx');

/**
 * 🔴 COMMENTS OUT, BEFORE COUNTING CODE. A scanner matches the text that
 * DISCUSSES what it scans for: the first cut of the count below read 2 in
 * `Viewport.tsx` — one construction and one doc comment naming it — which is a
 * false red produced entirely by the prose that explains the rule. The
 * alternative (rewording the comment so it cannot quote its own subject) makes
 * the guard depend on nobody ever writing the literal down, which is not a
 * property anything can hold.
 *
 * ⚠ It is a crude stripper, not a parser: a `//` inside a string literal takes
 * the rest of that line with it. That is acceptable HERE and nowhere else —
 * every needle below is a code shape, so losing the tail of a string can only
 * ever make this test blind, never make it lie. The `assert.ok(... test(src))`
 * "gone blind, not green" guards are what catch that.
 */
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

test('🔴 PLANT — there is exactly ONE renderer construction site, and it is the guarded one', () => {
  const sites = (s: string) =>
    (stripComments(s).match(/new THREE\.WebGLRenderer\(/g) ?? []).length;

  assert.equal(
    sites(viewport),
    1,
    'Viewport.tsx builds a renderer somewhere other than tryRenderer(). A second construction ' +
      'site is a second way for an exception to escape an effect and blank the entire ' +
      'application — panels, refusals, G-code and download included.',
  );
  assert.equal(
    sites(preview),
    0,
    'cad/preview.tsx builds its own renderer again. Unguarded, that exception unmounts the ' +
      'whole app: the editor, the console, the audit and the source the user had typed.',
  );

  // And the one that exists is inside the function that catches. Asserted by
  // the shape of the source rather than by position arithmetic: the constructor
  // must be the argument of a `return { ok: true, renderer: ... }` inside a
  // `try`.
  assert.match(
    viewport,
    /try\s*\{\s*return\s*\{\s*ok:\s*true,\s*renderer:\s*new THREE\.WebGLRenderer\(params\)\s*\}/,
    'the one construction site is no longer inside tryRenderer’s try — it can throw again',
  );
});

test('🔴 PLANT — both viewports BAIL when the renderer cannot be built', () => {
  for (const [name, src] of [
    ['Viewport.tsx', viewport],
    ['cad/preview.tsx', preview],
  ] as const) {
    assert.ok(
      /const attempt = tryRenderer\(/.test(src),
      `${name} no longer calls tryRenderer() — this test has gone blind, not green`,
    );
    // The early return is the whole fix. Without it the effect carries on with
    // no renderer and throws a line later, which is the same blank page by a
    // different route.
    assert.match(
      src,
      /if \(!attempt\.ok\) \{\s*setGl\(\{ ok: false, detail: attempt\.detail \}\);\s*return;\s*\}/,
      `${name} does not record the failure and stop. Without the early return the effect ` +
        `continues without a renderer and throws anyway — the tree is blanked again, and the ` +
        `operator loses a program that had already planned, checked and posted.`,
    );
  }
});

test('🔴 PLANT — the degraded state is REPORTED, and the probes stay absent rather than zeroed', () => {
  // `data-gl` is the one thing published when there is no renderer. Without it,
  // "no scene was measured" and "the scene measured nothing" are the same empty
  // markup — the mistake `data-spoilboard` already avoids by publishing
  // `notreported` instead of a 0.
  assert.match(viewport, /data-gl="unavailable"/);
  assert.match(viewport, /data-gl=\{gl \? 'ok' : undefined\}/);
  assert.match(preview, /data-gl=\{gl \? \(gl\.ok \? 'ok' : 'unavailable'\) : undefined\}/);

  // 🔴 NO DEAD CONTROLS IN THE DEGRADED STATE. `Fit` calls `kit.current.refit`,
  // which is only ever assigned by the setup effect — with no renderer it
  // renders, looks live, and does nothing when pressed. A dead control teaches
  // that the tab is broken rather than that the picture is absent.
  assert.match(
    preview,
    /\{gl && !gl\.ok \? \([\s\S]{0,400}?\) : \([\s\S]{0,900}?data-testid="cad-preview-fit"/,
    'the CAD preview’s camera controls are no longer gated on there being a camera — ' +
      '`Fit` is back in the degraded state, where it cannot do anything',
  );

  // And nothing invents a probe value in the degraded state. Every probe is
  // written to `renderer.domElement`, which does not exist — so this asserts
  // the absence of the thing that would break it: a probe published from the
  // component's render path, where there is no canvas to measure.
  for (const attr of [
    'data-part-bboxes',
    'data-part-probes',
    'data-tool-probe',
    'data-path-probe',
    'data-walls',
    'data-spoilboard',
  ]) {
    const inJsx = new RegExp(`${attr}=`);
    assert.ok(
      !inJsx.test(viewport),
      `${attr} is now set as a JSX attribute. It is a measurement OF A DRAWN SCENE; ` +
        `published from a render with no renderer it would be a number about nothing, and ` +
        `a reader would take it for an answer.`,
    );
  }
});
