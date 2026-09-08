import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

import { coords, coordsByPart, spanOf } from './gcode.ts';

/*
 * =============================================================================
 * THE READER THE MULTI-DRAWING TESTS MEASURE THROUGH
 * =============================================================================
 *
 * 🔴 WHY THIS FILE EXISTS. `coordsByPart` is the only thing in this suite that
 * says WHICH PART a coordinate belongs to, and until 2026-08-11 it read the
 * part name with `(\S+)` — it stopped at the first space. Real drawing ids are
 * names a person chose ("Hive super end"), so the reader answered `Hive`, and:
 *
 *   · a lookup for the real name MISSED, which surfaces as "the program never
 *     named this part" — a PRODUCT failure, for a reason that is not the
 *     reason; and
 *   · two drawings whose ids share a first word COLLAPSED INTO ONE KEY, so one
 *     drawing's coordinates were silently appended to the other's. Measured on
 *     the program below, on the old reader: ONE part, `Hive`, 268 points — both
 *     drawings, indistinguishable, with nothing to say so.
 *
 * The second is the one that matters. A miss is loud in the end; a merge lets
 * "moving one drawing moved the other" pass or fail for reasons unrelated to
 * the app.
 *
 * ⚠ AND THE PROGRAMS ARE EMITTED BY THE PRODUCER, NOT TYPED HERE. A fixture I
 * write by hand is my belief about the banner format, and this defect WAS a
 * wrong belief about the banner format — a hand-written fixture would have
 * agreed with the bug. `2bee-slice nest` writes these lines with the same
 * `core/src/toolpath.rs::banner` the browser uses, so if that format ever
 * changes, these tests change with it instead of vouching for a format nobody
 * emits any more.
 *
 * ⚠ NO BROWSER — and the REASON given here was wrong, corrected 2026-08-12.
 * This said *"this box has no WebGL and no working software fallback, so the
 * viewport-dependent tests in this suite cannot run here at all"*. **The box has
 * an RTX 4090.** `playwright.config.ts` was asking for `--use-gl=swiftshader`,
 * which produces no context on this machine; on `--use-gl=angle
 * --use-angle=gl-egl` the viewport tests run and pass. The GPU premise is dead.
 *
 * ✅ THE DESIGN CHOICE SURVIVES ITS DEAD JUSTIFICATION, WHICH IS WHY THIS FILE
 * IS UNCHANGED. It has no page, no canvas and no WASM: it is the reader, the
 * CLI, and nothing else. The instrument every multi-drawing assertion depends
 * on should not itself need a browser to be measurable — that was always the
 * better half of the argument, and it is the half that did not depend on what
 * this box could render.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, '../../target/release/2bee-slice');
const PLATE = resolve(HERE, '../../gates/fixtures/plate.dxf');

/** A machine and a cutter big enough that the sheet below is runnable — with no
 *  cutter there is no program at all, only a refusal (measured: *"no cutting
 *  tool was selected — this program has nothing to cut with"*). */
const CONFIG = {
  machine: { travel_x_mm: 2000, travel_y_mm: 2000, travel_z_mm: 100, supports_arcs: true },
  stock: { size_x_mm: 1200, size_y_mm: 900, thickness_mm: 15, z_zero_at_top: true },
  clamps: [],
  confirmed_clear: false,
  tool_id: 'End Mill - Down-cut 6mm 2F',
  op: {
    depth_per_pass_mm: 3,
    rpm: 16000,
    entry: 'Plunge',
    finish_allowance_mm: 0,
    tabs_enabled: true,
    tab_height_mm: 3,
    tab_width_mm: 8,
    tab_min_spacing_mm: 150,
  },
};

/*
 * 🔴 THE DIRECTORY IS HELD, NOT DISCARDED, SO IT CAN BE REMOVED.
 *
 * This read `join(mkdtempSync(…), 'config.json')` — the temp dir was created,
 * its path consumed inline by `join`, and nothing kept a reference to it. Only
 * `cfgPath` survived, so there was no name to delete afterwards even if
 * somebody had wanted to. Measured 2026-08-12: **15 `slicer-reader-*`
 * directories in `/tmp`**, one per run of this file.
 *
 * ⚠ `afterAll`, matching the `beforeAll` that makes it — the dir is shared by
 * every test in this file, so an `afterEach` would delete the config out from
 * under the tests that have not run yet. Playwright runs `afterAll` whether the
 * tests passed, failed or threw, which is the property that matters: a cleanup
 * on the last line of the last test is skipped by exactly the failing runs.
 */
let cfgDir = '';
let cfgPath = '';
test.beforeAll(() => {
  cfgDir = mkdtempSync(join(tmpdir(), 'slicer-reader-'));
  cfgPath = join(cfgDir, 'config.json');
  writeFileSync(cfgPath, JSON.stringify(CONFIG));
});
test.afterAll(() => {
  // `force` so a run that never reached `beforeAll` cannot fail on the way out.
  if (cfgDir) rmSync(cfgDir, { recursive: true, force: true });
});

/**
 * One emitted program from N placed copies of `plate.dxf`, each under the id
 * given. `nest` REFUSES a sheet whose parts share material, so the offsets are
 * what make a program exist — they are separation, not decoration.
 *
 * ⚠ stdout only. The notes (`no $INSUNITS`, `1 part(s) imported`) and the
 * `nest:` summary go to stderr; mixing them in would be feeding the reader
 * text the post never wrote.
 */
const STEP_X = 450;
const STEP_Y = 400;

function nest(...ids: string[]): string {
  const args = ['nest'];
  ids.forEach((id, i) => {
    args.push('--drawing', PLATE, '--id', id, '--offset', `${i * STEP_X},${i * STEP_Y}`);
  });
  args.push('--config', cfgPath);
  return execFileSync(CLI, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

test.describe('the per-part reader the emitted-program assertions measure through', () => {
  test('a part name containing a space is read WHOLE, not truncated at the first space', () => {
    const byPart = coordsByPart(nest('Hive super end'));
    const names = [...byPart.keys()];

    expect(
      names,
      'the reader did not name the part the program actually names — this is the ' +
        '`(\\S+)` truncation, and it reads at the call site as the app never emitting the part'
    ).toContain('Hive super end/part1');
    // The negative half, and it is the half that fails on the old reader.
    expect(names, 'the part name was cut at the first space').not.toContain('Hive');
    expect(byPart.get('Hive super end/part1')!.length).toBeGreaterThan(0);
  });

  test('two drawings whose ids share a first word are TWO parts, never one merged key', () => {
    /*
     * 🔴 THE MIS-ATTRIBUTION, not just the miss. Both ids begin `Hive super
     * end`, so the old reader answered a single key holding BOTH drawings'
     * coordinates — and every multi-drawing assertion ("only the one that was
     * moved moves") is then comparing a list against itself. The two parts are
     * placed 400mm apart, so a merged key is also detectable in the numbers:
     * one part cannot span both.
     */
    const byPart = coordsByPart(nest('Hive super end', 'Hive super end #2'));
    const names = [...byPart.keys()].sort();

    expect(names).toEqual(['Hive super end #2/part1', 'Hive super end/part1']);
    expect(names, 'both drawings collapsed into one key').not.toContain('Hive');

    const first = byPart.get('Hive super end/part1')!;
    const second = byPart.get('Hive super end #2/part1')!;
    expect(first.length, 'a part was named and carries no moves').toBeGreaterThan(0);
    expect(second.length, 'the two lists are not the same drawing twice').toBe(first.length);

    /* Measured, both halves. The two copies are `STEP_X` apart in X and
     * `STEP_Y` in Y, so (a) their X ranges cannot overlap — a merged key would
     * hold both and this fails — and (b) the SAME drawing placed twice emits
     * the same moves in the same order, so every point must differ by exactly
     * the offset. The second is what separates "two lists" from "two lists of
     * the right things". */
    const xs = (p: [number, number][]) => p.map(([x]) => x);
    expect(
      Math.max(...xs(first)) < Math.min(...xs(second)),
      "one part's coordinates were attributed to the other"
    ).toBe(true);
    const offBy = first.filter(
      ([x, y], i) =>
        Math.abs(second[i][0] - x - STEP_X) > 1e-6 || Math.abs(second[i][1] - y - STEP_Y) > 1e-6
    );
    expect(offBy.length, 'the two parts are not the same drawing at two offsets').toBe(0);
  });

  test('the tool bracket is found from the RIGHT, so a part named with brackets survives', () => {
    /*
     * `bracket [v2]` is a real name and a program this CLI emits today:
     * `( drill: bracket [v2]/part1-hole1 [End Mill - Down-cut 6mm 2F] )`.
     * Anchoring on the FIRST `[` names that part `bracket` — the same defect
     * one character along — and a greedy match to the end of the line swallows
     * the tool into the name instead. Both look identical from a caller's side.
     */
    const names = [...coordsByPart(nest('bracket [v2]')).keys()];
    expect(names).toContain('bracket [v2]/part1');
    expect(names, 'the name was cut at the first bracket').not.toContain('bracket');
    expect(
      names.some((n) => n.includes('End Mill')),
      'the tool was swallowed into the part name'
    ).toBe(false);
  });

  test('a hole is folded into the part it is in, and no other comment becomes a part', () => {
    /*
     * The `-holeN` suffix is the post naming a hole after its part, and a test
     * asking "did THIS drawing move" wants the drawing. The second half is the
     * negative control on the banner match itself: this program also carries
     * `( job: imported )`, `( tool: … )`, `( post: … )` and `( Z zero from
     * touch plate … )`, and a reader that treated any comment as a banner
     * would invent parts out of all of them — which is the failure
     * `core/src/toolpath.rs::parse_banner` returns `None` to avoid.
     */
    const g = nest('Hive super end');
    expect(g, 'the program has no hole banners, so this test proves nothing').toContain(
      '( drill: Hive super end/part1-hole1 ['
    );

    const names = [...coordsByPart(g).keys()];
    expect(names).toEqual(['Hive super end/part1']);
    expect(names.some((n) => n.includes('-hole'))).toBe(false);
  });
});

/*
 * =============================================================================
 * THE SCANNER UNDERNEATH IT
 * =============================================================================
 *
 * 🔴 `coordsByPart` was the reader that got tested; the loop it is BUILT ON was
 * copied out by hand into two more places in `slicer.spec.ts` and tested
 * nowhere. `39ca45c288` had already paid for that exact shape one layer up — a
 * helper inside a spec file cannot be tested, so it broke and stayed broken.
 * These are the tests the scanner could not have while it was three copies.
 *
 * ⚠ Same rule as above: the programs come from the PRODUCER. A hand-typed
 * fixture is my belief about what the post emits, and every defect in this
 * family has been a wrong belief about what the post emits.
 */
test.describe('the XY scanner every emitted-program assertion is built on', () => {
  test('a modal axis is carried, and a feed rate is not a position', () => {
    /*
     * 🔴 BOTH HALVES, AND THEY PULL OPPOSITE WAYS. The post omits an axis whose
     * value has not changed, so a scanner that requires both words on one line
     * silently thins the sample; and it writes `F`, `S` and `Z` words on the
     * same lines, so a scanner that takes any number after any letter reads a
     * feed rate as an X. Measured against a real program rather than argued:
     * this one HAS lines with one axis and HAS F/Z words, and the test says so
     * before it asserts anything, because a fixture without them proves neither.
     */
    const g = nest('Hive super end');
    const body = g.split('\n').map((l) => l.trim());
    const oneAxis = body.filter((l) => /(^|\s)X-?[\d.]+(\s|$)/.test(l) && !/\sY-?[\d.]+(\s|$)/.test(l));
    expect(oneAxis.length, 'no single-axis lines, so modality is not exercised').toBeGreaterThan(0);
    expect(
      body.some((l) => /\sF\d/.test(l)),
      'no feed words, so the "F800 is not a position" half proves nothing'
    ).toBe(true);

    const pts = coords(g);
    expect(pts.length, 'the scanner found no positions at all').toBeGreaterThan(50);

    /* Every point is inside the sheet the program was planned on (1200x900,
     * placed at 0,0). A feed rate read as an X coordinate lands at 800+ in a
     * program whose parts do not reach there — and `F` values are the numbers
     * most likely to be mistaken, which is why the bound is asserted rather
     * than the absence of a specific wrong value. */
    for (const [x, y] of pts) {
      expect(Number.isFinite(x) && Number.isFinite(y), `unreadable point ${x},${y}`).toBe(true);
      expect(x, `a point outside the sheet in X: ${x}`).toBeGreaterThanOrEqual(-20);
      expect(x, `a point outside the sheet in X: ${x} — a feed rate read as a coordinate`).toBeLessThan(1220);
      expect(y, `a point outside the sheet in Y: ${y}`).toBeGreaterThanOrEqual(-20);
      expect(y, `a point outside the sheet in Y: ${y}`).toBeLessThan(920);
    }

    // The scanner and the per-part reader see the SAME program. `coords` also
    // counts anything emitted before the first banner, so it may hold more —
    // never fewer, and never a different set of points for the named parts.
    const byPart = coordsByPart(g);
    const attributed = [...byPart.values()].reduce((n, v) => n + v.length, 0);
    expect(attributed, 'the per-part reader lost points the scanner found').toBeLessThanOrEqual(
      pts.length
    );
    expect(attributed, 'the per-part reader attributed nothing').toBeGreaterThan(0);
  });

  test('the span is the program’s own extent, and it moves with the program', () => {
    /*
     * `spanOf` is what the rotation test asserts a quarter turn on: `w` and `h`
     * must SWAP. Here it is checked against the one transform whose effect on a
     * span is known without turning anything — a pure translation, which moves
     * every point and changes no extent. A scanner that dropped modal axes
     * would change `n` between these two programs and this fails.
     */
    const flat = spanOf(nest('Hive super end'));
    expect(flat.n, 'no program to measure').toBeGreaterThan(50);
    expect(flat.w, 'a zero-width program').toBeGreaterThan(1);
    expect(flat.h, 'a zero-height program').toBeGreaterThan(1);

    // Two copies at STEP_X/STEP_Y apart: the same part twice, so the span grows
    // by exactly the offset in each axis and the point count exactly doubles.
    const two = spanOf(nest('Hive super end', 'Hive super end #2'));
    expect(two.n, 'two copies did not emit twice the moves').toBe(flat.n * 2);
    expect(two.w - flat.w, 'the X span did not grow by the X offset').toBeCloseTo(STEP_X, 3);
    expect(two.h - flat.h, 'the Y span did not grow by the Y offset').toBeCloseTo(STEP_Y, 3);
  });

  test('a program with no positioned moves reports n=0 and does NOT report a size', () => {
    /*
     * 🔴 THE NEGATIVE CONTROL, AND IT FAILED ON ITS FIRST RUN — which is the
     * only reason `spanOf` writes its `NaN` instead of letting one fall out.
     * `Math.max() - Math.min()` on an empty list is `-Infinity - Infinity` =
     * **`-Infinity`**, not `NaN`, and `-Infinity` SATISFIES `toBeLessThan` and
     * `toBeCloseTo` — so an empty program would have passed a caller's
     * tolerance check as though it were an unusually good result. `NaN` fails
     * every comparison, which is the honest answer. Clamping to `0` would be
     * worse again: it renders "there is no program" as "a part with no size".
     */
    const empty = spanOf('( op: nothing [End Mill] )\nG21\nM5\nM30\n');
    expect(empty.n).toBe(0);
    expect(Number.isNaN(empty.w), 'an empty program reported a width').toBe(true);
    expect(Number.isNaN(empty.h), 'an empty program reported a height').toBe(true);
    expect(coords('')).toEqual([]);

    // And a banner with no moves is still a NAMED part with an empty list —
    // "never named" and "named and cut nothing" stay separable.
    const named = coordsByPart('( op: nothing [End Mill] )\nG21\nM30\n');
    expect([...named.keys()]).toEqual(['nothing']);
    expect(named.get('nothing')).toEqual([]);
  });
});
