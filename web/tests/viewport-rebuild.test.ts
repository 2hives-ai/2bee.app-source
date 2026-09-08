// The 3D scene must rebuild when the DATA changes, and not when React merely
// re-renders.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE DEFECT THIS FILE GUARDS
// ─────────────────────────────────────────────────────────────────────────────
//
// `Viewport`'s scene effect DISPOSES every geometry and material it built and
// builds all of them again. Until 2026-08-11 it did that on every render of
// `App` — a slider drag, a keystroke in an unrelated field, a hover that set
// state — because `App` builds its `LayerScene` as a fresh object literal each
// render and React compares dependencies with `Object.is`. Five props arrived
// as NEW IDENTITIES CARRYING IDENTICAL VALUES (`travel`, `stockOrigin`,
// `touchPlate`, and `stock`/`moves` whenever there is no report yet), and two
// more arrived as fresh inline arrows (`onStockMove`, `onClampMove`). Seven
// entries were enough to make the whole dependency array a no-op.
//
// ⚠ THE SECOND DIRECTION IS THE ONE THAT MATTERS MORE. A key that never
// changes makes the first half of this file pass beautifully and breaks the
// app — the picture would freeze one plan behind the checks, which is the
// look-right / checked-wrong shape this lane's gates exist for. So every
// keyed dependency below is exercised in BOTH directions: unchanged data must
// not rebuild, and a changed value must.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT RUNS HERE, AND WHAT CANNOT
// ─────────────────────────────────────────────────────────────────────────────
//
// ✅ THE REAL DEPENDENCY ARRAY. `sceneDeps` is the array the component passes
//    to `useEffect` — not a copy written for this file — and the source-text
//    guard at the bottom is what keeps that true.
//
// 🔴 NOT EXERCISED, stated rather than implied:
//   · REACT. There is no DOM and no WebGL in this harness, so nothing mounts
//     and no effect runs. `rebuilds()` below re-implements React's dependency
//     comparison (`Object.is`, element-wise, first run always fires) — which is
//     small, documented and stable, but it is a MODEL of React and not React.
//     What it measures is exactly "how many times would this effect fire", and
//     nothing about what the effect then draws.
//   · THAT THE PICTURE IS RIGHT. Nobody has watched a frame. A scene that
//     rebuilds at the correct moments can still be drawn wrongly, and no
//     assertion here would notice.
//   · GPU MEMORY. The rebuild count is the proxy for the dispose/rebuild churn;
//     the actual allocation is not observable without a context.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  LAYERS,
  movesKey,
  numsKey,
  sceneDeps,
  touchPlateKey,
  SCENE_DEP_NAMES,
  type Layer,
  type ViewportProps,
} from '../src/Viewport.tsx';
import type { RenderMove } from '../src/cam.ts';
import { CNC_DEFAULT_PROJECTION } from '../src/projection.ts';

const here = dirname(fileURLToPath(import.meta.url));
const viewportSrc = readFileSync(join(here, '..', 'src', 'Viewport.tsx'), 'utf8');

// ---------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------

/**
 * React's own dependency rule, and nothing else: the first run always fires,
 * and afterwards the effect fires iff any entry differs by `Object.is`.
 *
 * Returns the number of times the scene effect WOULD run over a sequence of
 * renders — and, for a failure message worth reading, which dependency moved.
 */
function rebuilds(frames: ViewportProps[]): { count: number; moved: string[][] } {
  let prev: readonly unknown[] | null = null;
  let count = 0;
  const moved: string[][] = [];
  for (const f of frames) {
    const next = sceneDeps(f);
    if (prev === null) {
      count++;
      moved.push(['(first render)']);
    } else {
      assert.equal(
        next.length,
        prev.length,
        'the dependency array changed LENGTH between renders. React warns and falls back to ' +
          'rebuilding every time — the churn this file measures would be back, silently.',
      );
      const diff = next
        .map((v, i) => (Object.is(v, prev![i]) ? null : SCENE_DEP_NAMES[i]))
        /* `SCENE_DEP_NAMES` is `as const`, so the mapped element type is the
         * union of those literals — not `string`. A `n is string` predicate is
         * therefore not assignable to its own parameter, which is a compiler
         * error that `tests/` being outside `include` had been swallowing.
         * `NonNullable` says the same thing about the runtime check without
         * widening the union. The filter itself is unchanged. */
        .filter((n): n is NonNullable<typeof n> => n !== null);
      if (diff.length > 0) {
        count++;
        moved.push(diff);
      }
    }
    prev = next;
  }
  return { count, moved };
}

/** The state `App` holds, in the shape this test varies it. */
interface AppState {
  report: {
    travel: [number, number, number];
    stock: [number, number, number];
    render: RenderMove[];
  } | null;
  travelX: number;
  travelY: number;
  stockX: number;
  stockY: number;
  thickness: number;
  originX: number;
  originY: number;
  probeEnabled: boolean;
  touchPlateMm: string;
  progress: number;
  clamps: never[];
}

const BASE: AppState = {
  report: null,
  travelX: 1250,
  travelY: 670,
  stockX: 600,
  stockY: 900,
  thickness: 18,
  originX: 0,
  originY: 0,
  probeEnabled: true,
  touchPlateMm: '1.6',
  progress: 1,
  clamps: [],
};

const LAYERS_ALL = Object.fromEntries(LAYERS.map((k) => [k, true])) as Record<Layer, boolean>;

/**
 * 🔴 ONE RENDER OF `App`, BUILT THE WAY `App` BUILDS IT.
 *
 * Every expression here is copied from `App.tsx`'s `LayerScene` literal and its
 * `<Viewport …>` call site as they stood on 2026-08-11 — the ternary that
 * rebuilds `travel` out of two report fields, the `?? []` and `?? [x,y,t]`
 * fallbacks, the `touchPlate` object literal, `[originX, originY]`, and the two
 * inline arrows. That is the point: the frames below are a MODEL OF THE CALLER,
 * so this file measures the churn the app actually produces rather than a
 * convenient one.
 *
 * ⚠ It is a model, so it can go stale — if `App` starts passing something in a
 * new shape this file will keep measuring the old one and stay green. That is
 * the residual, and it is why the fix is on the `Viewport` side: keying by
 * value works whatever shape the caller uses.
 */
function frame(s: AppState = BASE): ViewportProps {
  return {
    stock: s.report?.stock ?? [s.stockX, s.stockY, s.thickness],
    clamps: s.clamps,
    moves: s.report?.render ?? [],
    travel: s.report?.travel ? [s.report.travel[0], s.report.travel[1]] : [s.travelX, s.travelY],
    touchPlate: {
      enabled: s.probeEnabled && s.touchPlateMm.trim() !== '',
      x: 0,
      y: 0,
      thickness_mm: Number(s.touchPlateMm || 0),
    },
    stockOrigin: [s.originX, s.originY],
    onStockMove: (_x: number, _y: number) => {},
    onClampMove: (_i: number, _x: number, _y: number) => {},
    onPartMoveAt: (_id: string, _x: number, _y: number) => {},
    progress: s.progress,
    layers: LAYERS_ALL,
    dark: true,
    /* 🔴 THE STALENESS THE COMMENT ABOVE PREDICTED, CAUGHT BY THE COMPILER
     * RATHER THAN BY A READER. `projection` became a required `ViewportProps`
     * field and this model of the caller never grew it, so `frame()` had not
     * been a `ViewportProps` for as long as that prop has existed — invisible
     * while `tests/` sat outside `tsconfig.json`'s `include`.
     *
     * ⚠ The rebuild counts below are UNCHANGED, and that is a measurement, not
     * an assumption: `sceneDeps()` does not read `projection` (the projection
     * switch is handled outside the scene effect), so it is not in
     * `SCENE_DEP_NAMES` and cannot move a count. Had it been a dependency, this
     * file would have been measuring a caller with one fewer entry than the real
     * one — which is exactly the failure the header calls the residual. */
    projection: CNC_DEFAULT_PROJECTION,
    /* 🔴 UNLIKE `projection`, THIS ONE *IS* A SCENE DEPENDENCY, so leaving it
     * out of the model would have shortened the array this file measures by one
     * entry against the real caller. `App` passes
     * `zZeroTop ? 'workpiece-top' : 'spoilboard-top'`; a string literal is
     * value-stable across renders, so it adds no churn — which is the claim,
     * and it is measured by the counts below being unchanged rather than
     * asserted here. */
    zDatum: 'workpiece-top',
  };
}

const move = (x: number, y: number): RenderMove => ({ kind: 'cut', x, y, z: -1 });

// ---------------------------------------------------------------------------
// Direction 1 — a render is not a change
// ---------------------------------------------------------------------------

test('twenty renders with UNCHANGED data rebuild the scene exactly ONCE', () => {
  const frames = Array.from({ length: 20 }, () => frame());
  const { count, moved } = rebuilds(frames);
  assert.equal(
    count,
    1,
    `the scene rebuilt ${count} times across 20 renders of identical data. The dependencies ` +
      `that moved were: ${JSON.stringify(moved)} — each rebuild disposes and re-creates every ` +
      `geometry and material in the picture, so this is a full teardown per keystroke.`,
  );
});

test('the fresh literals the caller builds are IDENTITY-fresh — the harness is not cheating', () => {
  // If these were accidentally the same objects, the test above would pass for
  // a reason that has nothing to do with the fix. Assert the churn is real
  // before asserting that it no longer costs anything.
  const a = frame();
  const b = frame();
  assert.ok(!Object.is(a.travel, b.travel), 'travel is not a fresh array — the model is wrong');
  assert.ok(!Object.is(a.stock, b.stock), 'stock is not a fresh array — the model is wrong');
  assert.ok(!Object.is(a.moves, b.moves), 'moves is not a fresh array — the model is wrong');
  assert.ok(!Object.is(a.touchPlate, b.touchPlate), 'touchPlate is not a fresh object');
  assert.ok(!Object.is(a.stockOrigin, b.stockOrigin), 'stockOrigin is not a fresh array');
  assert.ok(!Object.is(a.onStockMove, b.onStockMove), 'onStockMove is not a fresh arrow');
  assert.ok(!Object.is(a.onClampMove, b.onClampMove), 'onClampMove is not a fresh arrow');
});

test('a report that lands, then twenty more renders, is ONE more rebuild and no others', () => {
  const planned: AppState = {
    ...BASE,
    report: {
      travel: [1250, 670, 120],
      stock: [600, 900, 18],
      render: [move(0, 0), move(10, 0), move(10, 10)],
    },
  };
  const frames = [frame(), ...Array.from({ length: 20 }, () => frame(planned))];
  const { count, moved } = rebuilds(frames);
  assert.equal(count, 2, `expected first-render + the new plan; got ${JSON.stringify(moved)}`);
});

// ---------------------------------------------------------------------------
// 🔴 Direction 2 — a changed value MUST rebuild
// ---------------------------------------------------------------------------
//
// This is the negative control for the whole change. A key that is constant —
// the exact mistake this refactor could introduce — makes every test above pass
// and every test below fail.

const CHANGES: [string, Partial<AppState>][] = [
  ['travel X (typed, no report)', { travelX: 1251 }],
  ['travel Y (typed, no report)', { travelY: 671 }],
  ['workpiece X', { stockX: 601 }],
  ['workpiece Y', { stockY: 901 }],
  ['workpiece thickness', { thickness: 18.1 }],
  ['datum X', { originX: 12 }],
  ['datum Y', { originY: 12 }],
  ['touch plate switched off', { probeEnabled: false }],
  ['touch plate thickness', { touchPlateMm: '3.0' }],
  ['playback progress', { progress: 0.5 }],
];

for (const [what, patch] of CHANGES) {
  test(`🔴 a change to ${what} REBUILDS the scene`, () => {
    const before = frame();
    const after = frame({ ...BASE, ...patch });
    const { count, moved } = rebuilds([before, after]);
    assert.equal(
      count,
      2,
      `${what} changed and the scene did NOT rebuild. The picture is now one edit behind the ` +
        `numbers the checks were run against — which is worse than the churn this keying ` +
        `removed. Dependencies seen moving: ${JSON.stringify(moved)}`,
    );
  });
}

test('🔴 a change to the travel the REPORT echoed rebuilds, even though the array is rebuilt each render', () => {
  const a: AppState = {
    ...BASE,
    report: { travel: [1250, 670, 120], stock: [600, 900, 18], render: [] },
  };
  const b: AppState = {
    ...BASE,
    report: { travel: [1250, 671, 120], stock: [600, 900, 18], render: [] },
  };
  assert.equal(rebuilds([frame(a), frame(a), frame(b)]).count, 2);
});

test('🔴 a new TOOLPATH rebuilds — same length, different points, and a different length', () => {
  const withMoves = (render: RenderMove[]): AppState => ({
    ...BASE,
    report: { travel: [1250, 670, 120], stock: [600, 900, 18], render },
  });
  const one = withMoves([move(0, 0), move(10, 0)]);
  const sameLength = withMoves([move(0, 0), move(10, 5)]);
  const longer = withMoves([move(0, 0), move(10, 0), move(10, 10)]);

  assert.equal(
    rebuilds([frame(one), frame(sameLength)]).count,
    2,
    'a program of the same length with different points did not rebuild — a length-only key ' +
      'would do exactly this, and it is why the toolpath keeps its identity dependency',
  );
  assert.equal(rebuilds([frame(one), frame(longer)]).count, 2);
});

test('🔴 the toolpath appearing and disappearing both rebuild', () => {
  const empty = frame();
  const some = frame({
    ...BASE,
    report: { travel: [1250, 670, 120], stock: [600, 900, 18], render: [move(1, 1)] },
  });
  assert.equal(rebuilds([empty, some]).count, 2, 'the first program did not reach the picture');
  assert.equal(rebuilds([some, empty]).count, 2, 'the program went away and the picture kept it');
});

test('two DIFFERENT empty toolpaths are the same toolpath', () => {
  // The only identity churn `App` produces on `moves` is the `?? []` fallback
  // taken while there is no report. Every empty array has exactly one possible
  // value, so collapsing them is exact rather than a summary.
  assert.ok(Object.is(movesKey([]), movesKey([])), 'two empty move lists key differently');
  assert.ok(!Object.is(movesKey([]), movesKey([move(0, 0)])), 'empty and non-empty share a key');
  const some = [move(0, 0)];
  assert.ok(Object.is(movesKey(some), some), 'a non-empty toolpath must keep its own identity');
});

// ---------------------------------------------------------------------------
// The keys themselves
// ---------------------------------------------------------------------------

test('the tuple key is injective over the tuples it is given', () => {
  assert.notEqual(numsKey([1, 23]), numsKey([12, 3]));
  assert.notEqual(numsKey([0, 0]), numsKey([0, 1]));
  assert.notEqual(numsKey([600, 900, 18]), numsKey([600, 900, 18.1]));
  assert.notEqual(numsKey([1250, 670]), numsKey([1250, 670, 120]));
  assert.equal(numsKey([600, 900]), numsKey([600, 900]));
  // Absent is its own key and cannot be produced by any tuple of numbers.
  assert.notEqual(numsKey(undefined), numsKey([0, 0]));
  assert.notEqual(numsKey(null), numsKey([]));
});

test('the two stated equivalences are the only ones, and both are deliberate', () => {
  // -0 and 0 are the same coordinate; `Object.is` would call them different and
  // rebuild the whole scene for a sign nobody can see.
  assert.equal(numsKey([-0, 5]), numsKey([0, 5]));
  // NaN keys as NaN — which is what `Object.is` does too.
  assert.equal(numsKey([NaN, 1]), numsKey([NaN, 1]));
  // Everything else that could plausibly collide, does not.
  assert.notEqual(numsKey([Infinity]), numsKey([-Infinity]));
  assert.notEqual(numsKey([1e21]), numsKey([1e20]));
});

test('the touch-plate key reads all FOUR fields', () => {
  const tp = { enabled: true, x: 10, y: 20, thickness_mm: 1.6 };
  assert.notEqual(touchPlateKey(tp), touchPlateKey({ ...tp, enabled: false }));
  assert.notEqual(touchPlateKey(tp), touchPlateKey({ ...tp, x: 11 }));
  assert.notEqual(touchPlateKey(tp), touchPlateKey({ ...tp, y: 21 }));
  assert.notEqual(touchPlateKey(tp), touchPlateKey({ ...tp, thickness_mm: 3 }));
  assert.equal(touchPlateKey(tp), touchPlateKey({ ...tp }));
  // A declared plate and no plate at all are different facts.
  assert.notEqual(touchPlateKey(tp), touchPlateKey(null));
  assert.notEqual(touchPlateKey(null), touchPlateKey({ ...tp, enabled: false }));
});

/**
 * ✅ A VALUE KEY CATCHES AN IN-PLACE MUTATION AND THE IDENTITY KEY IT REPLACED
 * DID NOT. Recorded as a test because the opposite is the intuitive worry: a
 * key is usually a summary, and a summary loses information. These keys read
 * every field the scene reads, so on these props the value key is strictly the
 * more sensitive of the two.
 */
test('a caller that MUTATES a tuple in place is caught by the key and would be invisible to identity', () => {
  const travel: [number, number] = [1250, 670];
  const before = numsKey(travel);
  travel[1] = 671;
  assert.notEqual(numsKey(travel), before);
  assert.ok(Object.is(travel, travel), 'identity is unchanged by a mutation — that is the point');
});

// ---------------------------------------------------------------------------
// 🔴 The guards — this test is about the component, not about a copy of it
// ---------------------------------------------------------------------------

test('🔴 the component passes sceneDeps(props) to the scene effect', () => {
  assert.match(
    viewportSrc,
    /\}, sceneDeps\(props\)\);/,
    'the scene effect no longer uses sceneDeps() — every rebuild count in this file is now ' +
      'measuring a function nothing calls, and would stay green through a return of the churn',
  );
});

test('🔴 the drag callbacks are OUT of the dependency list and published on every render', () => {
  const deps = sceneDeps(frame());
  assert.equal(deps.length, SCENE_DEP_NAMES.length, 'the names and the array have drifted apart');
  for (const name of ['onClampMove', 'onStockMove', 'onPartMoveAt']) {
    assert.ok(
      !(SCENE_DEP_NAMES as readonly string[]).includes(name),
      `${name} is back in the scene dependency list. It is an inline arrow at the call site, so ` +
        `it changes identity every render and rebuilds the entire scene for a new function object.`,
    );
  }
  // And they must therefore be published from the component body, or the
  // pointer handlers keep a handler from whichever render last rebuilt.
  for (const [field, prop] of [
    ['partDrag', 'onPartMoveAt'],
    ['stockDrag', 'onStockMove'],
    ['clampDrag', 'onClampMove'],
  ] as const) {
    /* ⚠ THE CAST IS GONE AND THE PUBLISH IS THE SAME LINE. `ca3e7f422c` typed
     * the state ref and deleted the `(state.current as any)` casts, so the
     * needle reads `state.current.${field}` with the cast OPTIONAL — what is
     * asserted is the assignment from the prop, not the syntax it once needed. */
    const assignment = new RegExp(
      `state\\.current\\.${field} = props\\.${prop} \\?\\? null;`,
    );
    assert.match(
      viewportSrc,
      assignment,
      `${field} is no longer published from props.${prop}. A drag would reach a handler from an ` +
        `older render — the defect removing it from the dependency list would otherwise create.`,
    );
  }
});

/**
 * 🔴 `loadedMesh` BUILDS GEOMETRY AND WAS IN NO DEPENDENCY LIST. It worked only
 * because every render rebuilt everything, so the omission behaved like a
 * declaration. Now that the scene stops rebuilding on identity churn, an
 * unlisted prop is a solid frozen at the last plan while the panel describes
 * the new one.
 */
test('🔴 every prop the scene effect READS is in the dependency list', () => {
  const start = viewportSrc.indexOf('// --- scene contents');
  const end = viewportSrc.indexOf('}, sceneDeps(props));');
  assert.ok(start > 0 && end > start, 'the scene effect could not be located — gone blind');
  const body = viewportSrc.slice(start, end);

  const read = new Set(
    [...body.matchAll(/props\.([A-Za-z0-9_]+)/g)].map((m) => m[1]),
  );
  // Two are read and deliberately NOT dependencies, each for a stated reason.
  const exempt = new Set([
    // Pointer wiring, published every render from the component body.
    'onClampMove',
    'onStockMove',
    'onPartMoveAt',
    // A DISPLAY toggle. Every move class is always built; `applyVis` hides
    // them. A toggle that rebuilt the scene would make "what is on screen" and
    // "what the program contains" one code path again.
    'showRapids',
  ]);
  const declared = new Set<string>(SCENE_DEP_NAMES as readonly string[]);
  const missing = [...read].filter((p) => !declared.has(p) && !exempt.has(p)).sort();
  assert.deepEqual(
    missing,
    [],
    `these props are read while building the scene and are not dependencies of it: ` +
      `${missing.join(', ')}. With the churn removed, each one is a picture frozen at the last ` +
      `rebuild while the report moved on.`,
  );

  // Gone blind, not green: the scan must actually be seeing props.
  assert.ok(read.size > 15, `only ${read.size} props found in the effect body — the scan broke`);
});
