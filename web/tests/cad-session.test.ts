// What a browser refresh puts back — and what it must refuse to put back.
//
// Founder 2026-08-11: *"when I refresh the browser the 2bee.cad should come back
// what has been changed (zoom, FOV, edited code)"*.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT RUNS HERE, AND WHAT CANNOT
// ─────────────────────────────────────────────────────────────────────────────
//
// ✅ EXERCISED, by the real modules: `session.ts`'s validator and writer, and
//    `preview.tsx`'s camera validator. Both are pure functions over one value,
//    which is why they were pulled out of the component in the first place.
//    `writeSession` is driven against a stand-in `localStorage` that THROWS, so
//    the quota path — the one that decides whether a stale session can come back
//    pretending to be your work — is executed rather than reasoned about.
//
// 🔴 NOT EXERCISED, stated rather than implied:
//   · A real refresh. There is no browser here, so nothing below shows that the
//     editor is seeded, that the camera is applied to a real `WebGLRenderer`, or
//     that the automatic `Fit` really is suppressed. Those are SOURCE-SHAPE
//     assertions at the bottom of this file and they are labelled as the weaker
//     thing they are.
//   · `localStorage` quota behaviour in Chrome. The stand-in throws on demand;
//     it does not model a 5 MB budget shared with the other keys.
//   · Anything the operator SEES. The restore marker and the not-being-kept
//     marker are asserted as markup in `CadTab.tsx`'s source, not as pixels.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const source = (...p: string[]) => readFileSync(join(HERE, '..', 'src', ...p), 'utf8');

const { readSession, writeSession, SESSION_KEY, SESSION_SHAPE } = await import('../src/cad/session.ts');
const { readCamera, ZOOM_CLAMP } = await import('../src/cad/preview.tsx');

const CAMERA = { theta: 0.5, phi: 1.1, radius: 240, target: [10, -20, 0] as [number, number, number] };
const SESSION = {
  v: SESSION_SHAPE,
  src: 'cube(10);\n',
  baseline: 'cube(9);\n',
  savedName: 'bracket',
  undoStep: { source: 'sphere(4);\n', what: 'the model proposal' },
  camera: CAMERA,
};

/* ════════════════════════════════════════════════════════════════════════════
   1. The camera — one zoom scalar, validated
   ════════════════════════════════════════════════════════════════════════════ */

test('a camera survives the round trip exactly', () => {
  assert.deepEqual(readCamera(JSON.parse(JSON.stringify(CAMERA))), CAMERA);
});

/**
 * 🔴 THE ZOOM IS THE ORBIT DISTANCE AND NOTHING ELSE. `540bab9d66` established
 * at OpenSCAD's own source that there is ONE scalar and the orthographic
 * half-height is derived from it. A stored frustum extent would be a second zoom
 * quantity, and the two would disagree the moment a restore happened in the
 * other projection.
 */
test('the stored camera carries no projection-specific number', () => {
  const c = readCamera(CAMERA)!;
  assert.deepEqual(Object.keys(c).sort(), ['phi', 'radius', 'target', 'theta']);
  /* ⚠ COMMENTS STRIPPED, and the first cut of this did not: the module QUOTES
   * the founder's word *"FOV"* while explaining that there is no such stored
   * number, so the assertion fired on its own explanation. A needle that matches
   * the prose about the subject is a false red, and a false red is what gets an
   * assertion deleted rather than narrowed. */
  const code = source('cad', 'session.ts')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/orthoHalfHeight|frustum|fov/i.test(code), 'the session stores a projection-specific zoom');
});

/**
 * ⚠ A SECOND COPY OF TWO NUMBERS, GUARDED. The wheel handler keeps its literals
 * (`cad-camera-parity.test.ts` reads them to prove the CAD clamp has not
 * collapsed onto the machine-sized CNC one), and the validator has to clamp the
 * same range or a forged blob puts the operator somewhere no gesture can reach.
 * So the two are compared rather than trusted.
 */
test('the camera validator clamps the same zoom range the wheel does', () => {
  const wheel = /radius = Math\.min\((\d+), Math\.max\((\d+), radius \* \(/.exec(source('cad', 'preview.tsx'));
  assert.ok(wheel, 'the wheel clamp moved — this test has gone blind, not green');
  assert.equal(ZOOM_CLAMP.max, Number(wheel[1]), 'the validator and the wheel disagree about maximum zoom-out');
  assert.equal(ZOOM_CLAMP.min, Number(wheel[2]), 'the validator and the wheel disagree about maximum zoom-in');

  assert.equal(readCamera({ ...CAMERA, radius: 1e12 })!.radius, ZOOM_CLAMP.max);
  assert.equal(readCamera({ ...CAMERA, radius: 0.0001 })!.radius, ZOOM_CLAMP.min);
  // And the elevation clamp is the drag handler's band, for the same reason.
  assert.ok(readCamera({ ...CAMERA, phi: 99 })!.phi < Math.PI);
  assert.ok(readCamera({ ...CAMERA, phi: -99 })!.phi > 0);
});

test('half a camera is not half a view — anything unreadable is refused whole', () => {
  for (const bad of [
    null,
    undefined,
    'perspective',
    [],
    { ...CAMERA, theta: Number.NaN },
    { ...CAMERA, radius: 'far' },
    { ...CAMERA, target: [1, 2] },
    { ...CAMERA, target: [1, 2, 'up'] },
    { theta: 0, phi: 1 },
  ]) {
    assert.equal(readCamera(bad), null, `accepted: ${JSON.stringify(bad)}`);
  }
});

/* ════════════════════════════════════════════════════════════════════════════
   2. The session — the document is all-or-nothing, the rest degrades
   ════════════════════════════════════════════════════════════════════════════ */

test('a session survives the round trip, put-back entry included', () => {
  const back = readSession(JSON.stringify(SESSION))!;
  assert.ok(back, 'a session written by this build did not read back');
  assert.equal(back.src, SESSION.src);
  assert.equal(back.baseline, SESSION.baseline);
  assert.equal(back.savedName, 'bracket');
  assert.deepEqual(back.undoStep, SESSION.undoStep);
  assert.deepEqual(back.camera, CAMERA);
});

/**
 * 🔴 THE ENTRY THAT MATTERS MOST, AND IT IS NOT THE OBVIOUS ONE. A model's reply
 * replaces the editor with NO press anywhere in the chain (founder: *"when
 * request sent automatically change the code (no extra click needed)"*), and
 * `replace.ts` is the only route back from that. A session that restored the
 * buffer but not the put-back would make an auto-applied rewrite PERMANENT at
 * the next refresh — the original gone, the tab looking as though it had always
 * said this.
 *
 * 🔴 PLANT: drop `undoStep` from what `CadTab` stores, or from what it seeds
 * `past` with, and this goes red.
 */
test('the put-back step is what the restore is FOR, and it comes back as history', () => {
  const back = readSession(JSON.stringify(SESSION))!;
  assert.ok(back.undoStep, 'the one recovery from an unpressed rewrite was dropped');
  assert.equal(back.undoStep!.source, 'sphere(4);\n', 'the displaced source is not what comes back');

  const tab = source('cad', 'CadTab.tsx');
  /* And it is seeded INTO the real history rather than into a second stash of
   * its own — `replace.ts` is the only document history this tab has. */
  assert.match(tab, /past: opened\.undoStep \? \[opened\.undoStep\] : \[\],/, 'the stored step reaches no stack');
  assert.match(tab, /undoStep: e\.past\.length > 0 \? e\.past\[e\.past\.length - 1\] : null,/, 'nothing is stored');
});

/**
 * 🔴 `dirty` IS `src !== baseline`, SO THE PAIR IS THE DOCUMENT. A `src` that
 * survived while `baseline` did not would make a restored dirty buffer look
 * SAVED: no unsaved-changes marker, no leave guard, and the operator one
 * `File → New` from losing work the tab had just told them was safe.
 */
test('a session with only half the document is refused entirely', () => {
  assert.equal(readSession(JSON.stringify({ ...SESSION, baseline: undefined })), null);
  assert.equal(readSession(JSON.stringify({ ...SESSION, src: 42 })), null);
  assert.equal(readSession('{'), null, 'a truncated blob is not a session');
  assert.equal(readSession(''), null);
  assert.equal(readSession(null), null);
  assert.equal(readSession(JSON.stringify([SESSION])), null, 'an array is not a session');
});

/**
 * ⚠ AND THE ACCESSORIES DEGRADE INSTEAD, which is the safer direction for each:
 * no camera ⇒ frame as usual; no name ⇒ Save asks rather than silently replacing
 * a record it cannot identify; no undo step ⇒ one fewer recovery. Discarding the
 * whole session over any of them would throw the SOURCE away to protect an
 * accessory — and the next debounced write would then overwrite the still-good
 * text in storage with the example file.
 */
test('a corrupt camera, name or undo step costs that thing and never the source', () => {
  for (const bad of [
    { camera: { theta: 'sideways' } },
    { savedName: 17 },
    { undoStep: { source: 5 } },
    { undoStep: 'yes' },
  ]) {
    const back = readSession(JSON.stringify({ ...SESSION, ...bad }));
    assert.ok(back, `the whole session was discarded over ${JSON.stringify(bad)}`);
    assert.equal(back!.src, SESSION.src, 'the source did not survive');
    assert.equal(back!.baseline, SESSION.baseline, 'the baseline did not survive');
  }
  assert.equal(readSession(JSON.stringify({ ...SESSION, camera: { theta: 'sideways' } }))!.camera, null);
  assert.equal(readSession(JSON.stringify({ ...SESSION, savedName: 17 }))!.savedName, null);
  assert.equal(readSession(JSON.stringify({ ...SESSION, undoStep: 'yes' }))!.undoStep, null);
});

/**
 * ⚠ THE SHAPE NUMBER IS NOT `store.ts`'s `SESSION_VERSION` AND DOES NOT MOVE IT.
 * That one guards the MACHINING blob — the plan, the tools, the workholding —
 * and nothing about it changes here. This is a new key with its own reader. What
 * it buys is the one failure a validator cannot catch: a field whose MEANING
 * changes under an unchanged name, which reads as valid and is misinterpreted.
 */
test('a blob from a shape this build does not know is not guessed at', () => {
  assert.equal(readSession(JSON.stringify({ ...SESSION, v: SESSION_SHAPE + 1 })), null);
  assert.equal(readSession(JSON.stringify({ ...SESSION, v: undefined })), null);
  const store = source('store.ts');
  assert.match(store, /export const SESSION_VERSION = 3;/, 'store.ts’s version moved — re-argue this note');
});

/* ════════════════════════════════════════════════════════════════════════════
   3. A write that cannot happen must not leave the last one lying around
   ════════════════════════════════════════════════════════════════════════════ */

/**
 * 🔴 THE FAILURE THIS EXISTS FOR: `setItem` throws on quota, and a throw leaves
 * whatever was already stored UNTOUCHED. Without the delete, an operator whose
 * source has grown past the budget keeps an hour-old session and gets it back on
 * the next refresh — text that looks like their work, is not, and says nothing
 * about the difference. **No restore is recoverable; a stale restore is not.**
 *
 * 🔴 PLANT: remove the `removeItem` from `writeSession`'s catch and the second
 * assertion goes red; make it return `true` on failure and the third does.
 */
test('a refused write DELETES the stale session and reports that it failed', () => {
  const calls: string[] = [];
  const fake = {
    getItem: () => null,
    setItem: () => {
      calls.push('set');
      throw new Error('QuotaExceededError');
    },
    removeItem: () => {
      calls.push('remove');
    },
  };
  const real = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { value: fake, configurable: true });
  try {
    const ok = writeSession(SESSION);
    assert.deepEqual(calls, ['set', 'remove'], 'the stale session was left in the store');
    assert.equal(ok, false, 'a refused write reported success, so nothing can say so on screen');
  } finally {
    if (real) Object.defineProperty(globalThis, 'localStorage', real);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});

test('a write that works reports that it worked, under the one key', () => {
  const held: Record<string, string> = {};
  const fake = {
    getItem: (k: string) => held[k] ?? null,
    setItem: (k: string, v: string) => {
      held[k] = v;
    },
    removeItem: (k: string) => {
      delete held[k];
    },
  };
  const real = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { value: fake, configurable: true });
  try {
    assert.equal(writeSession(SESSION), true);
    assert.deepEqual(Object.keys(held), [SESSION_KEY]);
    assert.deepEqual(readSession(held[SESSION_KEY]), readSession(JSON.stringify(SESSION)));
  } finally {
    if (real) Object.defineProperty(globalThis, 'localStorage', real);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});

/* ════════════════════════════════════════════════════════════════════════════
   4. The wiring — SOURCE-SHAPE, and named as the weaker thing it is
   ════════════════════════════════════════════════════════════════════════════ */

/**
 * 🔴 THE DEFECT THAT WOULD MAKE THE WHOLE FEATURE INVISIBLE. The `[result]`
 * effect frames the first non-empty scene, which arrives ~250 ms after the setup
 * effect runs. A restored camera that did not set `framedOnce` would be
 * overwritten by an automatic `Fit` before anybody saw it — the code would read
 * as correct, and the founder would report the same thing again.
 *
 * ⚠ SOURCE-SHAPE: the camera lives in a closure over a `WebGLRenderer` and there
 * is no WebGL here. This catches the edit that breaks it; it does not show that
 * a restore was seen on screen.
 *
 * 🔴 PLANT: delete the `framedOnce` line from the seed and this goes red.
 */
test('a restored camera suppresses the automatic Fit', () => {
  const cad = source('cad', 'preview.tsx');
  const seed = /const seed = readCamera\(initialCamera\);\s*\n\s*if \(seed\) \{([\s\S]*?)\n    \}/.exec(cad);
  assert.ok(seed, 'the camera seed moved — this test has gone blind, not green');
  assert.match(seed![1], /kit\.current\.framedOnce = true;/, 'the first mesh will re-frame over the restore');
  for (const field of ['theta', 'phi', 'radius', 'target']) {
    assert.ok(seed![1].includes(field), `the restore drops ${field}`);
  }
  /* And it does NOT go through the framing path, which would re-derive a radius
   * from the model and throw the stored zoom away. */
  assert.ok(!/frameScene/.test(seed![1]), 'the restore reframes instead of restoring');
});

/**
 * ⚠ THE PROP IS READ ONCE AND THE CALLBACK IS NOT. A camera pushed in on every
 * render would fight the operator's own orbit; a callback captured in a `[]`
 * effect would be whichever one the first render passed, forever.
 */
test('the camera prop is a seed and the callback goes through a ref', () => {
  const cad = source('cad', 'preview.tsx');
  assert.match(cad, /const cameraOut = useRef\(onCameraChange\);/, 'the callback is captured in the setup closure');
  assert.match(cad, /cameraOut\.current\?\.\(/, 'the ref is not what the render loop calls');

  const tab = source('cad', 'CadTab.tsx');
  assert.match(tab, /initialCamera=\{opened\?\.camera \?\? null\}/, 'the preview is not seeded from the session');
  assert.match(tab, /onCameraChange=\{onCameraChange\}/, 'nothing collects the camera back');
  /* The camera must not re-render this tab: it arrives after every gesture, and
   * this component parses a source on the render path. */
  assert.match(tab, /const cameraRef = useRef<CadCamera \| null>/, 'the camera is React state again');
});

/**
 * 🔴 A RESTORED DIRTY BUFFER MUST BE DISTINGUISHABLE FROM A SAVED MODEL OF THE
 * SAME NAME — that is how somebody overwrites their own work. `File → Save` on a
 * named model saves SILENTLY and by design, so the moment to know which text you
 * are looking at is before that press.
 */
test('the tab says the text was restored, and says which record it is not', () => {
  const tab = source('cad', 'CadTab.tsx');
  assert.match(tab, /data-testid="cad-restored"/, 'a restored buffer looks like a saved one');
  assert.match(tab, /not the stored/, 'the marker does not name what this text is NOT');
  /* Cleared by anything that installs known text, and by a save — but not by
   * typing, because text edited on top of a restored buffer is still descended
   * from it. */
  assert.match(tab, /setRestored\(false\);/);
  assert.ok(!/setSrc[\s\S]{0,120}setRestored\(false\)/.test(tab), 'typing clears the marker');
  /* And the other direction: a store that refused the write must say so, or its
   * silence is read as "it is being kept". */
  assert.match(tab, /data-testid="cad-session-not-kept"/, 'a failed write is silent');
});

/**
 * ⚠ THE LEAVE GUARD STAYS, AND ITS MEANING CHANGED. *"The buffer usually comes
 * back"* and *"your work is safe"* are different claims, and only the first is
 * ours to make: storage can be disabled, a quota can refuse, site data gets
 * cleared, and another machine has nothing. Removing the guard because a restore
 * exists would be the second claim.
 */
test('restoring the buffer did not remove the unsaved-changes guard', () => {
  const tab = source('cad', 'CadTab.tsx');
  assert.match(tab, /window\.addEventListener\('beforeunload', onLeave\);/, 'the leave guard was removed');
  assert.match(tab, /WHAT THIS GUARD NOW MEANS/, 'the guard survived with a stale reason attached to it');
});
