// Millimetres ↔ inches — `web/src/units.ts`, its wiring in `App.tsx` and its
// two menu rows in `cncMenu.tsx`. TODO #109.
//
// Founder 2026-08-11: *"2bee.app able to change from inch to cm"*.
//
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 WHAT THIS FILE CANNOT SEE, SAID FIRST
// ═══════════════════════════════════════════════════════════════════════════
//
// **THERE IS NO BROWSER HERE AND `App.tsx` CANNOT BE IMPORTED IN NODE** — the
// loader stops at its sample asset imports (`Unknown file extension ".dxf"`),
// which `tests/config-wiring.test.ts` records and re-measured. So nothing below
// renders a panel, clicks a menu row, or observes a React re-render.
//
// That splits this file into three parts of very different weight, and the split
// is stated rather than blurred:
//
// ✅ PART A — THE ARITHMETIC, AS PURE FUNCTIONS. Real assertions about real
//    behaviour: the round trip in both directions, the `≈` marker, the step
//    ladder, the bounds, the validator. If the conversion is wrong, this is red.
//
// ✅ PART B — THE EMITTED PROGRAM, THROUGH THE BROWSER'S OWN WASM. The
//    byte-identity claim is checked against the artefact the page loads, not
//    against a source file. See the header on Part B for exactly what the
//    reduction is and what it does NOT prove.
//
// ⚠ PART C — THE WIRING, READ AS SOURCE TEXT. **A text guard proves
//    "unchanged", never "true".** It is here because the alternative is nothing:
//    a React state variable reaching a config object is not observable without
//    React. Every assertion in Part C asserts its needle was FOUND before it
//    asserts anything about it — a `doesNotMatch` over a file whose shape has
//    moved is a test that passes by looking at nothing.
//
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 WHAT A HUMAN STILL HAS TO CONFIRM IN A BROWSER
// ═══════════════════════════════════════════════════════════════════════════
//
//   · that `View → Inches` visibly changes the panel numbers and the `<em>` slot
//     beside every input;
//   · that the strip appears, and that it is readable rather than a wall;
//   · **how a browser renders a `stepMismatch`, and where its spinner lands.**
//     The spec validates a value as `min + n·step`, so an inch field holding
//     `0.4724` with a `0.01` step is a mismatch and its spinner jumps to `0.48`.
//     That is judged right — winding in inches should land on round imperial
//     numbers, and it is an operator action either way — but the ladder in
//     `INCH_STEPS` is asserted here only as arithmetic, and `:invalid` styling
//     is a fact about pixels;
//   · that the setting survives a real reload with real `localStorage`. The
//     validator and the read/write pair are asserted below; the browser's own
//     storage is not.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  DECIMALS,
  DEFAULT_UNIT,
  displayBound,
  displayStep,
  formatLength,
  formatLengthPair,
  formatLengthTriple,
  fromDisplay,
  INCH_DISPLAY_NOTE,
  INCH_STEPS,
  isExact,
  MM_PER_INCH,
  readUnit,
  toDisplay,
  UNIT_LABEL,
  UNIT_SYMBOL,
  UNITS_ABSENT,
  UNITS_NOT_CONVERTED,
  type Unit,
} from '../src/units.ts';
import { cncMenus, type CncMenuContext } from '../src/cncMenu.tsx';

const HERE = dirname(fileURLToPath(import.meta.url));
const source = (...p: string[]) => readFileSync(join(HERE, '..', 'src', ...p), 'utf8');

/** Comments removed, so a needle cannot match the prose that discusses it. */
const code = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[^\n]*?\/\/[^\n]*$/gm, ' ');

const app = source('App.tsx');
const appCode = code(app);
const unitsSrc = source('units.ts');
const unitsCode = code(unitsSrc);

const UNITS: Unit[] = ['mm', 'in'];

/* ════════════════════════════════════════════════════════════════════════════
   PART A — THE ARITHMETIC
   ════════════════════════════════════════════════════════════════════════════ */

/**
 * 🔴 THE ONE THAT MATTERS, IN THE DIRECTION THAT IS SAFE. A value the operator
 * TYPED, converted to millimetres and shown again, comes back exactly what they
 * typed. This is what makes `0.5"` still read `0.5"` after a hundred switches.
 *
 * ⚠ IT IS NOT TRIVIALLY TRUE IN FLOATING POINT, which is why the sample carries
 * the witness: `24 × 25.4` is `609.5999999999999`, and `609.5999999999999 /
 * 25.4` is `23.999999999999996` — NOT `24`. The rounding in `toDisplay` is what
 * closes it, and a "simplification" that removed the rounding would go red here.
 */
test('inch → mm → inch returns exactly what was typed, including the case that is not exact in binary', () => {
  const typed = [0, 0.5, 0.25, 0.125, 0.0625, 1, 2.5, 3.5, 12, 24, 48, 0.4724, 0.0039, -0.5];
  for (const v of typed) {
    const mm = fromDisplay(v, 'in');
    assert.equal(toDisplay(mm, 'in'), v, `typed ${v} in came back as ${toDisplay(mm, 'in')} in`);
  }
  // The witness, named so the reason survives a rewrite of the loop above.
  assert.notEqual(24 * MM_PER_INCH, 609.6, 'the float witness has moved — re-derive this test');
  assert.notEqual(
    (24 * MM_PER_INCH) / MM_PER_INCH,
    24,
    'the bare round trip is now exact — the rounding may no longer be what closes it',
  );
  assert.equal(toDisplay(24 * MM_PER_INCH, 'in'), 24, 'the rounding no longer closes the trip');
});

/** The same, for the unit that is stored: mm → display → mm is the identity. */
test('a millimetre value the operator typed is untouched by the millimetre display', () => {
  for (const v of [0, 0.1, 1, 6, 12.7, 18, 610, 1219.2, 3000, -12.5]) {
    assert.equal(toDisplay(v, 'mm'), v);
    assert.equal(fromDisplay(toDisplay(v, 'mm'), 'mm'), v);
  }
});

/**
 * 🔴 **THE ROUND TRIP IN THE FORBIDDEN DIRECTION IS LOSSY, AND THAT IS ASSERTED
 * RATHER THAN COMMENTED.** `12 mm` shown in inches is `0.4724`, and `0.4724 in`
 * is `11.99896 mm`. If a converted display were ever written back into state,
 * that is the drift — on a dimension the operator entered, which is a wrong
 * part rather than a wrong picture.
 *
 * ⚠ This test exists to keep the REASON for the "never write back" rule
 * falsifiable. A comment saying the trip is lossy is a claim; this is a
 * measurement, and if a future precision change made it lossless the rule would
 * still be right and this test would tell somebody it needs re-arguing.
 */
test('mm → inch display → mm is LOSSY, which is why a converted value is never stored', () => {
  const shown = toDisplay(12, 'in');
  assert.equal(shown, 0.4724);
  const back = fromDisplay(shown, 'in');
  assert.notEqual(back, 12, 'the drift this module exists to prevent has vanished — re-read the rule');
  assert.ok(Math.abs(back - 12) > 1e-6, `expected a measurable drift, got ${Math.abs(back - 12)}`);

  /* 🔴 **AND IT DOES NOT COMPOUND — MEASURED, NOT ASSUMED, AND THE OPPOSITE OF
   * WHAT THIS TEST FIRST ASSERTED.** A second round trip is a fixed point:
   * `11.99896 mm` is already at an exact inch quantum, so it maps to itself. The
   * drift is therefore BOUNDED at half a display quantum however many times a
   * write-back happens.
   *
   * ⚠ THAT IS NOT REASSURING AND THE BOUND IS THE REASON. Half an inch quantum
   * is `0.00127 mm`, and the post writes coordinates to `0.001 mm` — so ONE
   * write-back is already enough to move a number in the emitted program.
   * "It converges" and "it is harmless" are different claims and only the first
   * is true. */
  let v = 12;
  for (let i = 0; i < 5; i++) v = fromDisplay(toDisplay(v, 'in'), 'in');
  assert.equal(v, back, 'the round trip is no longer idempotent — the bound has to be re-derived');
  assert.ok(
    Math.abs(back - 12) > 10 ** -3 / 2,
    `the single-step drift ${Math.abs(back - 12)} mm no longer exceeds half the 0.001mm the post ` +
      'writes coordinates to. If that is now true for every length, the reason for the ' +
      'no-write-back rule has changed and needs re-arguing rather than assuming',
  );
});

/** 🔴 A NUMBER IS NEVER RENDERED WITHOUT ITS UNIT. The whole defence. */
test('every formatted length carries a unit symbol', () => {
  const samples = [0, 1, 6, 12.7, 18, 610, 1219.2, -3, 0.0001, 1e6];
  for (const u of UNITS) {
    for (const v of samples) {
      const s = formatLength(v, u);
      assert.ok(
        s.endsWith(` ${UNIT_SYMBOL[u]}`),
        `formatLength(${v}, '${u}') = ${JSON.stringify(s)} — no unit on the number`,
      );
      assert.ok(/[0-9]/.test(s), `formatLength(${v}, '${u}') rendered no digits`);
    }
    // A pair and a triple put ONE symbol on the phrase, and it is still there.
    assert.ok(formatLengthPair(1200, 600, u).endsWith(` ${UNIT_SYMBOL[u]}`));
    assert.ok(formatLengthTriple(1200, 600, 18, u).endsWith(` ${UNIT_SYMBOL[u]}`));
  }
});

/**
 * ⚠ THE ONE CASE THAT RENDERS NO UNIT, AND IT RENDERS NO NUMBER EITHER. An
 * absent length is `—`. `NaN mm` reads like a measurement that went wrong;
 * absence is a state this app has to be able to show, because `thickness_mm` is
 * nullable and the `None` is load-bearing.
 */
test('an absent length renders as an absence, not as a number and not as a unit', () => {
  for (const u of UNITS) {
    for (const v of [NaN, Infinity, -Infinity]) {
      assert.equal(formatLength(v, u), '—');
    }
  }
});

/**
 * 🔴 `≈` MEANS "THE PLANNER HOLDS SOMETHING ELSE", AND IT IS ON THE NUMBER.
 * Both directions asserted: it appears where the display is rounded and it does
 * NOT appear where the display is the stored value — a marker that is always
 * present says nothing.
 */
test('the ≈ marker appears exactly when the display is not the stored value', () => {
  assert.equal(formatLength(610, 'mm'), '610 mm');
  assert.equal(formatLength(610, 'in'), '≈24.0157 in');
  assert.equal(formatLength(12.7, 'in'), '0.5 in', 'an exact conversion was marked approximate');
  assert.equal(formatLength(12.7, 'mm'), '12.7 mm');
  assert.equal(formatLength(11.99896, 'mm'), '≈11.999 mm', 'mm display is not exempt from rounding');
  assert.equal(isExact(12.7, 'in'), true);
  assert.equal(isExact(610, 'in'), false);
  assert.equal(isExact(12.7, 'mm'), true);
  assert.equal(isExact(NaN, 'mm'), false);
});

/**
 * ⚠ THE MARKER IS PER-NUMBER INSIDE A PAIR. One half can be exact while the
 * other is not, and a single marker on the pair would either overclaim one or
 * underclaim the other.
 */
test('a pair marks each half separately and puts one symbol on the phrase', () => {
  assert.equal(formatLengthPair(609.6, 610, 'in'), '24 × ≈24.0157 in');
  assert.equal(formatLengthPair(1200, 600, 'mm'), '1200 × 600 mm');
  assert.equal(formatLengthTriple(1200, 600, 18, 'in'), '≈47.2441 × ≈23.622 × ≈0.7087 in');
});

/** Trailing zeros are not a precision claim this app has measured. */
test('trailing zeros are trimmed', () => {
  assert.equal(formatLength(610, 'mm'), '610 mm');
  assert.equal(formatLength(12.5, 'mm'), '12.5 mm');
  assert.equal(formatLength(25.4, 'in'), '1 in');
});

/**
 * 🔴 A STEP IS NOT A LENGTH. `0.5 mm` converted arithmetically is
 * `0.0196850393700787 in` — a spinner that walks a dimension into fifteen
 * significant figures, in an `<input type=number>` whose validity rule is
 * `min + n·step`.
 */
test('an inch step snaps DOWN to a shop increment and is never an arithmetic conversion', () => {
  assert.equal(displayStep(1, 'mm'), 1, 'the mm step must be untouched');
  assert.equal(displayStep(0.5, 'mm'), 0.5);
  for (const mmStep of [0.025, 0.1, 0.5, 1, 10, 500, 1000]) {
    const s = displayStep(mmStep, 'in');
    assert.ok(INCH_STEPS.includes(s), `${mmStep}mm gave ${s} in, which is not on the ladder`);
    assert.ok(
      s <= Math.max(mmStep / MM_PER_INCH, INCH_STEPS[0]),
      `${mmStep}mm snapped UP to ${s} in — a coarser step refuses values a finer one reaches`,
    );
  }
  // A step below the finest rung still gives a usable one rather than 0.
  assert.equal(displayStep(0.0001, 'in'), INCH_STEPS[0]);
  assert.equal(displayStep(0, 'in'), INCH_STEPS[0]);
  assert.equal(displayStep(NaN, 'in'), INCH_STEPS[0]);
});

/**
 * ⚠ BOUNDS ROUND OUTWARD. A `min` rounded UP by one display quantum silently
 * forbids the smallest setting the app itself chose, and the operator meets a
 * field that refuses a number nothing told them was illegal.
 */
test('a min rounds down and a max rounds up, so no legal value is excluded', () => {
  const min = displayBound(0.2, 'in', 'min')!;
  assert.ok(min * MM_PER_INCH <= 0.2, `min ${min} in excludes the 0.2mm floor`);
  const max = displayBound(0.2, 'in', 'max')!;
  assert.ok(max * MM_PER_INCH >= 0.2, `max ${max} in excludes the 0.2mm ceiling`);
  assert.equal(displayBound(0.2, 'mm', 'min'), 0.2, 'the mm bound must be untouched');
  assert.equal(displayBound(undefined, 'in', 'min'), undefined);
  assert.equal(displayBound(NaN, 'in', 'max'), undefined);
});

/**
 * The validator, in the direction that matters: **anything that is not one of
 * the two words falls back.** A preference store going bad may not put the
 * panels into a unit nobody chose.
 */
test('a stored unit is validated, and every wrong shape falls back', () => {
  assert.equal(readUnit('mm'), 'mm');
  assert.equal(readUnit('in'), 'in');
  for (const bad of [null, undefined, '', 'cm', 'inch', 'IN', 'MM', true, 1, {}, []]) {
    assert.equal(readUnit(bad), DEFAULT_UNIT, `${JSON.stringify(bad)} was accepted`);
  }
  assert.equal(readUnit('cm', 'in'), 'in', 'the caller-supplied fallback was ignored');
  assert.equal(DEFAULT_UNIT, 'mm', 'the default is no longer the unit everything is stored in');
});

/** The inch is exact by definition; a drift here would be a silent rescale. */
test('the conversion factor is the exact international inch', () => {
  assert.equal(MM_PER_INCH, 25.4);
  assert.equal(DECIMALS.mm, 3);
  /* 🔴 THE INCH DISPLAY IS COARSER THAN THE MILLIMETRE ONE, AND THIS ASSERTS
   * THAT RATHER THAN WISHING OTHERWISE. `0.0001 in` is `0.00254 mm` against the
   * mm view's `0.001 mm`. It is kept at four because that is the imperial
   * toolroom resolution an operator expects to type — and because hiding the
   * gap at five decimals would hide the reason nothing is ever written back.
   *
   * ⚠ This assertion was written the other way round, to confirm a comment in
   * `units.ts` claiming the inch view never loses a digit. It went red. The
   * comment was wrong and the code was fine; both now say the same true thing. */
  const inchQuantumMm = 10 ** -DECIMALS.in * MM_PER_INCH;
  assert.ok(
    inchQuantumMm > 10 ** -DECIMALS.mm,
    'the inch display is no longer coarser than the millimetre one — re-read units.ts’ DECIMALS ' +
      'note, which explains the ≈ marker in terms of exactly this gap',
  );
  assert.ok(
    inchQuantumMm / 2 > 0.001,
    'half an inch quantum is no longer above the 0.001mm the post writes coordinates to — the ' +
      'no-write-back rule’s sharpest justification has moved',
  );
});

/* ════════════════════════════════════════════════════════════════════════════
   PART B — THE EMITTED PROGRAM, THROUGH THE BROWSER'S OWN WASM
   ════════════════════════════════════════════════════════════════════════════

   🔴 THIS IS THE ARTEFACT THE PAGE LOADS — `web/src/wasm/`, what Vite bundles —
   driven exactly as `App.tsx` drives it. Not the CLI, not a fresh cargo build.

   ⚠ **THE REDUCTION, STATED RATHER THAN IMPLIED.** `plan()` takes a config; the
   display unit is not in that config and cannot be, so a literal "plan it once
   in each unit setting" is not expressible here — there is no unit to pass. The
   defensible reduction, and the one a previous agent established for this
   boundary, is **config-in → config-out**: the program is a pure function of the
   config, the config carries no unit, and therefore the program cannot differ.
   Both halves are asserted — the second in Part C, where the config object is
   read as text.

   ⚠ AND WHAT IT DOES NOT PROVE: that the page hands `plan()` the same config in
   both settings. That is a React fact and there is no React here. Part C reads
   the config object and the dependency list instead, and says it is a text
   guard. */

const GLUE = join(HERE, '..', 'src', 'wasm', 'twobee_cam_wasm.js');
const BG = join(HERE, '..', 'src', 'wasm', 'twobee_cam_wasm_bg.wasm');
const wasm: any = await import(pathToFileURL(GLUE).href);
wasm.initSync({ module: readFileSync(BG) });

function plan(job: string, config: unknown): any {
  return JSON.parse(wasm.plan(job, '', JSON.stringify(config), 0.6, undefined));
}

/**
 * 🔴 **THE STANDING RULE OF THIS LANE, APPLIED TO THIS FEATURE: ASSERT ON THE
 * EMITTED PROGRAM.** The config a millimetre display produces and the config an
 * inch display produces are the same object — that is the design — so the
 * program is byte-identical. This drives it rather than reasoning about it.
 *
 * The two configs below are built the way the app builds one: from millimetre
 * state. The "inch" one is what the app would send after an operator switched to
 * inches, looked at every field, and changed nothing — which is exactly the
 * scenario a write-back defect would corrupt.
 */
test('the emitted program is byte-identical with the display in millimetres and in inches', () => {
  const mmState = {
    stock: { origin_x_mm: 10, origin_y_mm: 10 },
    op: { entry: 'Plunge', depth_per_pass_mm: 2 },
  };
  /* The display switch performs NO write, so the config is the same object.
   * Reconstructed rather than reused, so an accidental shared reference cannot
   * make this pass by identity. */
  const inchState = {
    stock: { origin_x_mm: 10, origin_y_mm: 10 },
    op: { entry: 'Plunge', depth_per_pass_mm: 2 },
  };

  for (const job of ['plate', 'pocket', 'socket']) {
    const a = plan(job, mmState);
    const b = plan(job, inchState);
    assert.equal(a.ok, b.ok, `${job}: the two runs disagreed on whether it posts`);
    assert.equal(
      a.gcode,
      b.gcode,
      `${job}: the emitted program is NOT byte-identical between display settings`,
    );
    assert.deepEqual(a.refusals, b.refusals, `${job}: the refusals differ between display settings`);
    assert.deepEqual(a.notes, b.notes, `${job}: the plan's notes differ between display settings`);
  }
});

/**
 * 🔴 THE PLANT FOR THE TEST ABOVE, RUN INLINE — because a byte-equality
 * assertion between two things that are the same object by construction is the
 * easiest green in this file to be fooled by.
 *
 * A write-back defect is exactly "the stored millimetre value moved by a display
 * round trip". This applies that round trip to one field and asserts the program
 * CHANGES — so the equality above is a fact about the program and not about
 * `assert.equal` comparing a string to itself.
 */
test('PLANT: a value that has been through a display round trip DOES move the program', () => {
  /* 🔴 **12 mm, AND THE VALUE IS CHOSEN, NOT ARBITRARY.** Its inch display
   * rounds by `0.00104 mm` — near the worst case for a 4-decimal inch and, more
   * to the point, ABOVE the `0.001 mm` the post writes coordinates to.
   *
   * ⚠ MEASURED WHILE WRITING THIS: the first draft used `10 mm`, whose drift is
   * `0.00002 mm`, and the two programs came back BYTE-IDENTICAL. **A plant that
   * fires only for some values is a negative control that can silently stop being
   * one**, so the value is picked for its drift and the reason is here rather
   * than in a commit message. It also says something real about the feature: a
   * single write-back does not always reach the machine, which is precisely why
   * "it usually rounds out" is not a defence. */
  const DRIFTY_MM = 12;
  const clean = {
    stock: { origin_x_mm: DRIFTY_MM, origin_y_mm: DRIFTY_MM },
    op: { entry: 'Plunge' },
  };
  const drifted = {
    stock: {
      origin_x_mm: fromDisplay(toDisplay(DRIFTY_MM, 'in'), 'in'),
      origin_y_mm: fromDisplay(toDisplay(DRIFTY_MM, 'in'), 'in'),
    },
    op: { entry: 'Plunge' },
  };
  assert.notEqual(drifted.stock.origin_x_mm, DRIFTY_MM, 'the plant did not actually drift the value');
  assert.ok(
    Math.abs(drifted.stock.origin_x_mm - DRIFTY_MM) > 0.001,
    'the planted drift is now below the 0.001mm the post writes — this fixture can no longer ' +
      'distinguish a write-back from a clean run',
  );
  const a = plan('plate', clean);
  const b = plan('plate', drifted);
  assert.equal(a.ok, true, `the clean plan did not post: ${JSON.stringify(a.errors)}`);
  assert.notEqual(
    a.gcode,
    b.gcode,
    'a drifted datum produced an IDENTICAL program — this fixture cannot tell a write-back from ' +
      'a clean run, so the byte-identity test above proves nothing',
  );
});

/**
 * 🔴 `G20` MUST NEVER REACH THE POST. Feeds, arcs and probe distances all change
 * meaning under it and nothing downstream is written for it.
 *
 * Asserted at the emitted program — the only place it could arrive — and at the
 * whole of `web/src`, because the realistic vector is not the core (which has no
 * `G20`) but a UI that decorates the download.
 */
test('the emitted program is G21 and no host adds a G20', () => {
  const r = plan('plate', {});
  assert.equal(r.ok, true, `plate did not post: ${JSON.stringify(r.errors)}`);
  assert.ok(/\bG21\b/.test(r.gcode), 'the emitted program does not declare G21');
  assert.ok(!/\bG20\b/.test(r.gcode), 'the emitted program contains G20');
});

/* ════════════════════════════════════════════════════════════════════════════
   PART C — THE WIRING, AS SOURCE TEXT
   ════════════════════════════════════════════════════════════════════════════

   ⚠ EVERY TEST HERE PROVES "UNCHANGED", NEVER "TRUE". Each asserts its needle
   was found before it asserts anything about it. */

/**
 * 🔴 **THE SECOND HALF OF THE BYTE-IDENTITY CLAIM.** Part B proved the program
 * is a function of the config; this proves the config carries no unit. Together
 * they are the claim. Alone, neither is.
 *
 * The config object is located the way gate `HOST` locates it — the balanced
 * `{…}` handed to `plan` — so a rename of the variable does not blind this.
 */
test('the config the browser sends to plan() mentions no unit', () => {
  assert.ok(
    appCode.includes('await plan(job, plant, config, simCell, SURFACE_CELL_MM)'),
    'the plan() call site has moved — blind, not green',
  );
  const decl = appCode.indexOf('const config: JobConfig = useMemo(');
  assert.ok(decl > 0, 'the config memo has been renamed — blind, not green');
  // The balanced object literal the memo returns.
  const open = appCode.indexOf('({', decl) + 1;
  let depth = 0;
  let end = open;
  for (let i = open; i < appCode.length; i++) {
    const c = appCode[i];
    if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const cfg = appCode.slice(open, end + 1);
  assert.ok(cfg.length > 200, 'the extracted config object is implausibly short — blind, not green');
  assert.ok(
    !/\bunit\b/.test(cfg),
    'the DISPLAY UNIT has reached the config object. It is display only: a unit in the config is ' +
      'a unit in the plan, and the emitted program stops being byte-identical between settings',
  );
  assert.ok(!/\bG20\b/.test(cfg), 'G20 has reached the config object');
});

/** `G20` exists nowhere in the app's own source, comments excluded. */
test('no source file under web/src emits G20', () => {
  for (const f of ['App.tsx', 'units.ts', 'cncMenu.tsx', 'cam.ts', 'store.ts', 'runProgram.ts']) {
    assert.ok(!/\bG20\b/.test(code(source(f))), `${f} contains a G20`);
  }
});

/**
 * 🔴 **THE SETTING IS NOT IN THE SESSION BLOB AND `SESSION_VERSION` DID NOT
 * MOVE.** Both halves, because either alone is a different claim: a field added
 * to the blob without a bump is a meaning change nobody versioned, and a bump
 * without a field is a needless refusal of every stored setup.
 *
 * ⚠ A DISPLAY UNIT IN A JOB FILE WOULD BE ACTIVELY WRONG, not untidy — a shop
 * opening somebody else's job would have its own display flipped by a file, and
 * a reader of that file could reasonably conclude the numbers inside it are in
 * the unit it names. They are millimetres, always.
 */
test('the display unit is outside the session blob, and SESSION_VERSION is unchanged', () => {
  const store = code(source('store.ts'));
  const iface = /export interface SessionValues \{([\s\S]*?)\n\}/.exec(store);
  assert.ok(iface, 'SessionValues has moved — blind, not green');
  assert.ok(
    !/\bunit\b/i.test(iface![1]),
    'the display unit has been added to SessionValues — it would travel in a job file',
  );
  const keys = /export const SESSION_KEYS[\s\S]*?\];/.exec(store);
  assert.ok(keys, 'SESSION_KEYS has moved — blind, not green');
  assert.ok(!/\bunit\b/i.test(keys![0]), 'the display unit has been added to SESSION_KEYS');
  const ver = /export const SESSION_VERSION = (\d+);/.exec(store);
  assert.ok(ver, 'SESSION_VERSION has moved — blind, not green');
  assert.equal(
    ver![1],
    '3',
    'SESSION_VERSION moved. If that was for the units change it is wrong: nothing was added to ' +
      'the blob and no key changed meaning, so every stored setup would be refused for nothing. ' +
      'If it was for something else, update this test with the reason',
  );
});

/**
 * 🔴 **THE SETTING SURVIVES A RELOAD, AND IT IS SEEDED LAZILY.** A
 * `useState(DEFAULT_UNIT)` plus an effect that reads storage paints one frame of
 * millimetres to somebody who chose inches — a dimension that changes value a
 * moment after the panel appears.
 */
test('the display unit is persisted under its own key and seeded before the first paint', () => {
  /* The read/write pair was extracted to `panels/viewPersistence.ts`
   * (`06c89b1ac7`) and the state itself to the Zustand store
   * (`store/cncStore.ts`), whose INITIALISER runs at module load — before any
   * paint, which is the property this test exists for. Asserted at both new
   * addresses rather than deleted with the old ones. */
  const persistCode = code(source('panels', 'viewPersistence.ts'));
  assert.match(persistCode, /const CNC_UNITS_KEY = '2bee\.app\.cnc\.units'/);
  assert.match(persistCode, /localStorage\.setItem\(CNC_UNITS_KEY, u\)/);
  assert.match(persistCode, /readUnit\(localStorage\.getItem\(CNC_UNITS_KEY\), DEFAULT_UNIT\)/);
  assert.match(
    code(source('store', 'cncStore.ts')),
    /unit: storedCncUnit\(\),/,
    'the unit state is no longer seeded from storage at store creation — the first frame ' +
      'would be drawn in a unit nobody chose',
  );
  // A failed read or write must not make the control stop working.
  const readFn = /function storedCncUnit\(\)[\s\S]*?\n\}/.exec(persistCode);
  assert.ok(readFn, 'storedCncUnit has moved — blind, not green');
  assert.match(readFn![0], /catch/, 'storedCncUnit does not survive storage being disabled');
});

/**
 * 🔴 **NO CONVERTED VALUE IS WRITTEN BACK.** The only call to `fromDisplay` in
 * the app is the `onChange` of the numeric field — the operator typed. Anywhere
 * else it would be a stored value moving without anybody entering anything.
 */
test('fromDisplay is only ever called from an input’s onChange — the operator typing', () => {
  /* `Num` — which holds one of the four calls — was extracted to
   * `panels/NumericInput.tsx`; the scan covers both files, because a
   * `fromDisplay` in the extracted half is exactly as load-bearing as one in
   * `App.tsx`. */
  const numCode = code(source('panels', 'NumericInput.tsx'));
  const idxs: { src: string; at: number }[] = [];
  const re = /fromDisplay\(/g;
  let m: RegExpExecArray | null;
  for (const src of [appCode, numCode]) {
    re.lastIndex = 0;
    while ((m = re.exec(src)) !== null) idxs.push({ src, at: m.index });
  }
  assert.ok(idxs.length >= 4, `only ${idxs.length} fromDisplay calls — blind, not green`);
  for (const { src, at } of idxs) {
    const before = src.slice(Math.max(0, at - 260), at);
    assert.ok(
      /onChange=\{/.test(before),
      'fromDisplay is called somewhere that is not an input onChange. It converts a display value ' +
        'into a stored millimetre and may only run when a human typed; anywhere else is a ' +
        `converted value being written back where nobody entered anything:\n…${before.slice(-160)}`,
    );
  }
  /* 🔴 AND THE UNIT-SWITCHING COMMANDS WRITE A PREFERENCE AND NOTHING ELSE. */
  const handler = /const runMenuCommand = \(id: string\) => \{([\s\S]*?)\n  \};/.exec(appCode);
  assert.ok(handler, 'the command handler was renamed — blind, not green');
  const unitCases = /case 'view\.units\.mm':([\s\S]*?)case 'help\.about':/.exec(handler![1]);
  assert.ok(unitCases, 'the unit menu cases have moved — blind, not green');
  assert.ok(
    !/set(?!Unit)[A-Z]/.test(unitCases![1]),
    `switching the unit calls a setter other than chooseUnit: ${unitCases![1].trim()}`,
  );
  /* And `chooseUnit` itself writes the preference and nothing else — the switch
   * must perform NO write to a dimension, which is the whole safety property. */
  const choose = /const chooseUnit = \(u: Unit\) => \{([\s\S]*?)\n  \};/.exec(appCode);
  assert.ok(choose, 'chooseUnit has moved — blind, not green');
  assert.ok(
    !/fromDisplay|toDisplay|set(?!Unit)[A-Z]/.test(choose![1]),
    `chooseUnit converts or writes a dimension: ${choose![1].trim()}`,
  );
});

/**
 * 🔴 **A LENGTH FIELD CANNOT FORGET THE UNIT.** `Num`'s props are a union — a
 * call site declares `unit` or `suffix`, never neither. This asserts the union
 * is still a union, because a `unit?: Unit` with an `'mm'` fallback would
 * compile everywhere and render millimetres beside inches.
 */
test('the numeric field requires a unit or an explicit non-length suffix', () => {
  /* `Num` and its props were extracted to `panels/NumericInput.tsx`; the union
   * is read there. The call sites now span two files — the operation panel went
   * to `panels/OperationPanel.tsx` — and a `<Num>` in either is the same field
   * with the same rule, so both are scanned. */
  const numCode = code(source('panels', 'NumericInput.tsx'));
  const props = /type NumProps = \{[\s\S]*?\n\);/.exec(numCode);
  assert.ok(props, 'NumProps has moved — blind, not green');
  assert.match(
    props![0],
    /\| \{ unit: Unit; suffix\?: never \}/,
    'the unit arm of NumProps is no longer required',
  );
  assert.match(
    props![0],
    /\| \{ suffix: string; unit\?: never \}/,
    'the non-length arm of NumProps is no longer exclusive',
  );
  /* Every call site says which, counted PER ELEMENT rather than by counting
   * `unit={unit}` across the file — that shortcut broke the moment three raw
   * `<input>`s took the same prop, and a count that matches for the wrong reason
   * is the failure this suite keeps finding in other people's tests. */
  const sites: string[] = [];
  const re = /<Num\b/g;
  let m: RegExpExecArray | null;
  for (const src of [appCode, code(source('panels', 'OperationPanel.tsx'))]) {
    re.lastIndex = 0;
    while ((m = re.exec(src)) !== null) {
      const close = src.indexOf('/>', m.index);
      assert.ok(close > 0, 'a <Num> element is not self-closing — blind, not green');
      sites.push(src.slice(m.index, close));
    }
  }
  assert.ok(sites.length >= 20, `only ${sites.length} numeric fields found — blind, not green`);
  const lengths = sites.filter((e) => /unit=\{unit\}/.test(e));
  const others = sites.filter((e) => /suffix="/.test(e));
  assert.equal(
    lengths.length + others.length,
    sites.length,
    `${sites.length} numeric fields but ${lengths.length} carry a unit and ${others.length} carry ` +
      'an explicit suffix — one of them declares neither',
  );
  assert.equal(
    sites.filter((e) => /unit=\{unit\}/.test(e) && /suffix="/.test(e)).length,
    0,
    'a numeric field declares BOTH a unit and a suffix — the union is no longer exclusive',
  );
  assert.ok(others.length >= 2, `only ${others.length} non-length fields — blind, not green`);
});

/**
 * 🔴 **THE SEVEN FIELDS THAT STAY IN MILLIMETRES SAY SO ON THEMSELVES.** They
 * are the ones whose state is a string with a load-bearing `''` (NOT DECLARED ≠
 * 0), so they hold typed text and a per-keystroke conversion would eat the
 * decimal point. The gap is smaller than the alternative and it is VISIBLE.
 */
test('every millimetre-only entry field announces itself while the display is inches', () => {
  /* Six of the seven slots are in `App.tsx`; the seventh went to
   * `panels/OperationPanel.tsx` with the operation panel, and `MmOnlySlot`
   * itself to `panels/NumericInput.tsx`. The count and the bare-`mm` sweep
   * cover all three files — a slot in the extracted half announces (or fails
   * to) exactly as much as one that stayed. */
  const opCode = code(source('panels', 'OperationPanel.tsx'));
  const numCode = code(source('panels', 'NumericInput.tsx'));
  const uses =
    (appCode.match(/<MmOnlySlot unit=\{unit\} \/>/g) ?? []).length +
    (opCode.match(/<MmOnlySlot unit=\{unit\} \/>/g) ?? []).length;
  assert.equal(
    uses,
    7,
    `${uses} millimetre-only slots — the count in UNITS_NOT_CONVERTED says seven. Either a ` +
      'field was converted (update the sentence) or one was added (say why it cannot convert)',
  );
  const bareMm = (s: string) =>
    /<em>mm<\/em>/.test(s.replace(/function MmOnlySlot[\s\S]*?\n\}/, ''));
  assert.ok(
    !bareMm(appCode) && !bareMm(opCode) && !bareMm(numCode),
    'a bare `mm` unit slot survives outside MmOnlySlot — a field that is millimetres while the ' +
      'panel beside it is inches, and does not say so',
  );
  const body = /function MmOnlySlot\(\{ unit \}: \{ unit: Unit \}\) \{([\s\S]*?)\n\}/.exec(numCode);
  assert.ok(body, 'MmOnlySlot has moved — blind, not green');
  assert.match(body![1], /mm ONLY/, 'the slot no longer distinguishes itself from a converted one');
  /* 🔴 THE ONE THIS FILE ACTUALLY CAUGHT. Wiring the slot with a global
   * find-and-replace put `<MmOnlySlot/>` inside `MmOnlySlot`'s own `mm` branch —
   * infinite recursion on first render — and BOTH `tsc` AND all 1095 tests were
   * green over it, because nothing on this box renders a component. A guard for
   * exactly that, since the harness cannot see the class of defect at all. */
  assert.ok(
    !/MmOnlySlot/.test(body![1]),
    'MmOnlySlot renders itself — infinite recursion. Nothing else here can see this: there is no ' +
      'browser, so a component that never returns typechecks and passes every test in this suite',
  );
});

/**
 * ⚠ **THE PANELS ARE FULLY CONVERTED, NOT PARTLY.** The declared boundary is
 * "the panel column follows the setting; the 3D view, the core's own text and
 * the program do not". This sweeps `App.tsx` for a hard-coded `mm` next to an
 * interpolated value — the shape of a readout that was missed — and allows only
 * the sites that are declared exceptions.
 *
 * 🔴 IT IS A TEXT SWEEP AND IT CANNOT SEE A PARAPHRASE. A readout that spells
 * the unit "millimetres" is invisible to it. It is here because the defect it
 * catches — a `${x} mm` left behind by a conversion pass — is the one that
 * actually happens, and because the alternative is nothing.
 */
test('no unconverted `${…} mm` readout is left in the panel column outside the declared exceptions', () => {
  /* Comments and JSX text stripped the way gate HOST strips them: keep strings,
   * drop commentary, so a comment DISCUSSING `${x} mm` is not a finding.
   *
   * ⚠ THE SWEEP NOW COVERS THREE FILES. `panels/NumericInput.tsx` holds the
   * `Num` tooltip ("This app is storing ${value} mm") and `panels/
   * OperationPanel.tsx` holds the two 0.1mm worked examples — the extraction
   * moved the readouts, and the first pass of this fix left the exemptions
   * pointing at a file the sites had left, which is the vacuous-green shape
   * the negative control below exists to catch. */
  /* ⚠ `panels/SummaryPanel.tsx` ADDED 2026-08-28, and its absence is the finding
   * rather than a footnote to it. That panel renders three rows through
   * `formatLength(…, unit)` and one — the feed — with `mm/min` hardcoded, and
   * this sweep could not see the file at all, so the inconsistency was neither
   * caught nor declared. It would have fired: the string matches this test's own
   * needle. The decision is now IN `UNITS_NOT_CONVERTED` (both readouts are read
   * back out of the emitted G21 program and are printed as the program prints
   * them, so the operator can search the file for what is on screen), and the
   * exemption below is what makes that decision visible here.
   *
   * 🔴 A HAND-LISTED CORPUS IS THE DEFECT THIS LANE FIXED IN `terminology.test.ts`
   * THE DAY BEFORE, by discovering the file set instead. It is NOT fixed here:
   * this sweep's exemptions are anchored to specific strings in specific files
   * and discovering the corpus would fire on every panel at once. Named, not
   * closed — the next panel to grow a readout joins this list by hand, and
   * nothing will say so. */
  const swept: [string, string][] = [
    ['App.tsx', appCode],
    ['panels/NumericInput.tsx', code(source('panels', 'NumericInput.tsx'))],
    ['panels/OperationPanel.tsx', code(source('panels', 'OperationPanel.tsx'))],
    ['panels/SummaryPanel.tsx', code(source('panels', 'SummaryPanel.tsx'))],
  ];
  const whole = swept.map(([, s]) => s).join('\n');
  const ALLOWED = [
    // The input's own tooltip, which states the canonical millimetre on purpose.
    /This app is storing \$\{value\} mm/,
    /* The Summary panel's FEED row. Declared in `UNITS_NOT_CONVERTED`: it is read
       back out of the EMITTED program, which is G21 millimetres by construction,
       and printed as the program prints it so the operator can search the G-code
       for the string on screen — the same rule the RPM row beside it already
       stated for itself, and the same one the download exemption rests on. */
    /\$\{shown\[0\]\} mm\/min/,
    /\$\{shown\.join\(', '\)\} mm\/min/,
    /* ⚠ THE `End Mill - Down-cut 6mm 2F` EXEMPTION WAS DELETED, NOT DRIFTED
     * PAST. Its only occurrence in the swept corpus was a COMMENT in App.tsx
     * (stripped by `code()`); the live string is a store default in
     * `store/cncStore.ts`, which is not panel-column text and is not swept.
     * The negative control below fired on it, as designed. If a part NAME
     * lands in the swept files again, re-add the exemption with its site. */
    // A nominal trade designation — see UNITS_NOT_CONVERTED.
    /s\.thickness_mm\.join/,
    // Fixed prose: worked examples and a feed-rate unit, all carrying their own mm.
    /a 20mm error here is 20mm of bare rail/,
    /Places a generic 40 x 40 x 35mm clamp/,
    /3600 mm\/min/,
    /starting 0\.1mm is a/,
    /its own 0\.1mm\./,
  ];
  const found: string[] = [];
  for (const [name, fileCode] of swept) {
    fileCode.split('\n').forEach((l, i) => {
      if (!/\}\s?mm\b|[0-9]\s?mm\b/.test(l)) return;
      if (ALLOWED.some((re) => re.test(l))) return;
      found.push(`${name}:${i + 1}: ${l.trim().slice(0, 120)}`);
    });
  }
  assert.deepEqual(
    found,
    [],
    `a millimetre readout survived the conversion pass in the panel column:\n${found.join('\n')}`,
  );
  /* 🔴 THE NEGATIVE CONTROL. An exemption list that has drifted past the code it
   * exempts makes this test vacuous, so every entry must still match something
   * in the swept corpus. (`kill-resolved-flags`: a stale exemption reads
   * exactly like a live one.) */
  for (const re of ALLOWED) {
    assert.ok(re.test(whole), `the exemption ${re} matches nothing — it has outlived its site`);
  }
});

/* ════════════════════════════════════════════════════════════════════════════
   PART C2 — THE MENU AND WHAT IT SAYS
   ════════════════════════════════════════════════════════════════════════════ */

const CTX = (unit: Unit): CncMenuContext => ({
  projection: 'orthographic',
  unit,
  saveBlocked: null,
  hasStoredSetup: true,
});

/**
 * 🔴 ONE SURFACE. The View menu holds the unit control and nothing else does —
 * a chip on the sidebar or a toggle beside a field would be two controls over
 * one setting, which is the rule that moved the projection block out of the
 * sidebar in the first place.
 */
test('the unit control is in the View menu and on no other surface', () => {
  const view = cncMenus(CTX('mm')).find((m) => m.id === 'view');
  assert.ok(view, 'the View menu is gone');
  const ids = view!.items.map((i) => i.id);
  assert.ok(ids.includes('view.units.mm') && ids.includes('view.units.in'));
  assert.ok(
    !/data-testid="units-(picker|chip|toggle|select)/.test(appCode),
    'a second units control has appeared outside the View menu',
  );
  assert.equal(
    (appCode.match(/chooseUnit\(/g) ?? []).length,
    2,
    'chooseUnit appears somewhere other than its definition and the two menu cases — a second ' +
      'caller is a second control over one setting',
  );
  assert.match(appCode, /const chooseUnit = \(u: Unit\) => \{/, 'chooseUnit has moved — blind');
});

/** An exclusive pair, in both states — not a checkbox with an un-named half. */
test('the unit pair is exclusive and exactly one is checked in each state', () => {
  for (const u of UNITS) {
    const view = cncMenus(CTX(u)).find((m) => m.id === 'view')!;
    const units = view.items.filter((i) => i.id.startsWith('view.units.'));
    assert.equal(units.length, 2);
    assert.equal(
      units.filter((i) => i.checked).length,
      1,
      `with unit='${u}', ${units.filter((i) => i.checked).length} rows are checked`,
    );
    assert.equal(units.find((i) => i.checked)!.id, `view.units.${u}`);
  }
});

/**
 * 🔴 THE FOUNDER ASKED FOR CENTIMETRES AND DID NOT GET THEM. That is a decision,
 * so it is SAID in the product rather than left as a silence — and it is said
 * where somebody would go looking for the row.
 */
test('the unit the request named is refused out loud, in the menu the operator opens', () => {
  const view = cncMenus(CTX('mm')).find((m) => m.id === 'view')!;
  assert.ok(view.footnote, 'the View menu has no footnote');
  assert.match(view.footnote!, /[Cc]entimetres/, 'the menu never mentions the unit that was asked for');
  for (const line of UNITS_ABSENT) {
    assert.ok(view.footnote!.includes(line), 'an UNITS_ABSENT line is declared and never rendered');
  }
  for (const line of UNITS_NOT_CONVERTED) {
    assert.ok(
      view.footnote!.includes(line),
      'a UNITS_NOT_CONVERTED line is declared and never rendered — a constant naming what a ' +
        'control does not do, which nothing displays, is a comment with a type',
    );
  }
});

/**
 * 🔴 THE STRIP IS SHOWN WHILE THE NON-CANONICAL UNIT IS SELECTED, AND NOT
 * OTHERWISE. In millimetres there is nothing to warn about, and a permanent
 * strip trains an operator to stop reading strips on the tab where the never-cut
 * banner lives.
 */
test('the inch strip is conditional on the unit and states the three things it has to', () => {
  assert.match(appCode, /\{unit !== 'mm' \? \(/, 'the strip is no longer conditional on the unit');
  assert.match(appCode, /data-testid="units-note"/);
  assert.match(appCode, /\{INCH_DISPLAY_NOTE\}/, 'the strip no longer renders the one constant');
  assert.match(INCH_DISPLAY_NOTE, /DISPLAY ONLY/i);
  assert.match(INCH_DISPLAY_NOTE, /byte-for-byte identical/);
  assert.match(INCH_DISPLAY_NOTE, /G21/);
  assert.match(INCH_DISPLAY_NOTE, /≈/, 'the strip never explains the marker it puts on numbers');
  assert.match(INCH_DISPLAY_NOTE, /3D VIEW/, 'the strip does not name what stays in millimetres');
});

/** The labels an operator reads are the two units, spelled out. */
test('the menu rows name the units in words', () => {
  assert.equal(UNIT_LABEL.mm, 'Millimetres');
  assert.equal(UNIT_LABEL.in, 'Inches');
  const view = cncMenus(CTX('mm')).find((m) => m.id === 'view')!;
  const rows = view.items.filter((i) => i.id.startsWith('view.units.'));
  assert.deepEqual(rows.map((r) => r.label), ['Millimetres', 'Inches']);
  for (const r of rows) assert.ok(r.note && r.note.length > 60, `${r.id} has no reason on it`);
  assert.match(rows[1].note!, /DISPLAY ONLY/, 'the inch row does not say it is display only');
});

/**
 * ⚠ THE MODULE IS DISPLAY-ONLY BY CONSTRUCTION, AND THIS ASSERTS THE SHAPE THAT
 * MAKES IT SO: `units.ts` imports nothing. A module that reached the store, the
 * wasm or the config would be one edit away from being a program input.
 */
test('units.ts imports nothing and exports no way to reach a program', () => {
  assert.ok(!/^\s*import /m.test(unitsCode), 'units.ts has grown an import — it must stay a leaf');
  assert.ok(!/localStorage/.test(unitsCode), 'units.ts touches storage — persistence is App.tsx’s');
  assert.ok(!/\bplan\(|JobConfig|SessionValues/.test(unitsCode), 'units.ts reaches the planner');
});
