// UNBOUNDED RECURSION ON THIRD-PARTY GEOMETRY — TODO #163.
//
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 WHAT FAILURE THIS GUARDS, PHYSICALLY AND IN THE PRODUCT
// ═══════════════════════════════════════════════════════════════════════════
//
// `CadTab` runs `parseScad` and `meshScene` SYNCHRONOUSLY, on the main thread,
// inside a render. A `RangeError: Maximum call stack size exceeded` escapes
// every `catch` in those files, React unmounts the subtree, and the visitor gets
// a BLANK TAB that says nothing. Found by the external-design verifier on its
// first real run, on `Adam-CAD/CADAM` `benchmarks/13-v8-engine.scad`.
//
// ⚠ THE SHAPE OF THE BUG IS WHY THIS FILE EXISTS RATHER THAN ONE ASSERTION.
// THREE separate recursions walk the same input, and guarding the first two was
// measured to move the crash from depth 616 to depth ~5000 without removing it:
//
//   1. `Parser.parseStatement` ⇄ `Parser.parseChildStatement`   (builds the AST)
//   2. `Evaluator.exec` ⇄ `Evaluator.execCall`                  (evaluates it)
//   3. `Mesher.evalNode`                                        (meshes it)
//
// ⇒ A GUARD ON ONE OF SEVERAL RECURSIONS OVER THE SAME INPUT CONVERTS A
// REPRODUCIBLE CRASH INTO A RARER ONE. So every test below asserts NO THROW at a
// depth far past all three ceilings, not merely that some limit exists.
//
// The numbers are measured, not chosen:
//   · deepest design in `hardware/cad`: 21   (389 of 389 files; median 3, p99 13)
//   · `parseScad` raw ceiling:         616   (bisected, pre-fix)
//   · `meshScene` raw ceiling:         665   (bisected, pre-fix)
//   · both guards:                     256   (~12× the corpus, <½ the ceiling)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseScad } from '../src/cad/scad.ts';
import { meshScene } from '../src/cad/mesh.ts';

const nested = (d: number) => 'translate([0,0,1]) '.repeat(d) + 'cube(1);';

test('a nesting depth past every measured ceiling is REFUSED, not thrown', () => {
  // 20000 is ~32× the raw `parseScad` ceiling and ~30× the `meshScene` one. If
  // any of the three recursions is unguarded this throws rather than fails.
  const r = parseScad(nested(20_000));
  assert.ok(
    r.errors.some((e) => /nest deeper than 200/.test(e.message)),
    `no depth refusal was reported; errors were ${JSON.stringify(r.errors.slice(0, 2))}`,
  );
});

test('the mesher refuses deep scenes on its own, without the parser in front of it', () => {
  /* 🔴 THE PARSER GUARD WOULD HIDE THIS ONE. It fires first, so a scene that
   * reached the mesher deep could only arrive from a hand-built tree — which is
   * exactly what `meshScene` accepts from callers other than `CadTab`. Testing
   * the mesher only through the parser would leave it covered by something that
   * is not its own guard. */
  const base = parseScad('translate([0,0,1]) cube(1);').scene;
  let n: typeof base = base;
  for (let i = 0; i < 2_000; i++) {
    n = { kind: 'group', label: 'deep', children: [n], line: 1 };
  }
  const mesh = meshScene(n);
  assert.equal(mesh.parts.length, 0, 'a refused scene must draw nothing');
  const refused = mesh.issues.filter((i) => i.severity === 'refused');
  assert.ok(refused.length > 0, 'the mesher drew nothing and said nothing about why');
  assert.match(refused[0].detail, /nests deeper than 256 levels/);
});

test('the refusal NAMES the limit, because an unnamed refusal is indistinguishable from a bug', () => {
  const r = parseScad(nested(300));
  const msg = r.errors.map((e) => e.message).join(' ');
  assert.match(msg, /200/, "the limit that was hit is not in the message");
  assert.match(msg, /nest/, 'the message does not say what kind of limit it was');
});

test('REAL DESIGNS ARE UNAFFECTED — the positive control', () => {
  /* 🔴 WITHOUT THIS, A GUARD SET TO 1 WOULD PASS EVERY TEST ABOVE. The deepest
   * thing this company has ever drawn is 21 levels; anything that refuses at or
   * below the corpus maximum has broken the product to fix a crash. */
  for (const depth of [1, 21, 60, 199]) {
    const r = parseScad(nested(depth));
    assert.ok(
      !r.errors.some((e) => /nest deeper/.test(e.message)),
      `depth ${depth} was refused, and the deepest real design is 21`,
    );
    const mesh = meshScene(r.scene);
    assert.ok(mesh.parts.length > 0, `depth ${depth} produced no geometry`);
  }
});

test('the boundary is exact on both sides', () => {
  // ⚠ An off-by-one here is invisible in production and would make every number
  // in the comments above wrong by one, including the margin argument.
  assert.ok(!parseScad(nested(199)).errors.some((e) => /nest deeper/.test(e.message)), "199 must be accepted");
  assert.ok(parseScad(nested(201)).errors.some((e) => /nest deeper/.test(e.message)), "201 must be refused");
});

test('depth is RELEASED on the way out — a wide tree is not a deep one', () => {
  /* 🔴 THE DEFECT THIS CATCHES IS A MISSING `finally`. If the counter is
   * incremented on entry and decremented only on the normal return, 300 SIBLING
   * statements accumulate to 300 and the file is refused for being wide. Every
   * other test in this file passes with that bug present. */
  const wide = 'translate([0,0,1]) cube(1);\n'.repeat(300);
  const r = parseScad(wide);
  assert.ok(
    !r.errors.some((e) => /nest deeper/.test(e.message)),
    '300 siblings were counted as 300 levels — the depth counter is not being released',
  );
  assert.ok(meshScene(r.scene).parts.length > 0, 'a wide flat model produced nothing');
});

test('THE RELATION between the two limits, which is the thing that actually breaks', () => {
  /* 🔴 ASSERT THE RELATION, NOT THE LEVELS. The parser's bound must be STRICTLY
   * BELOW the mesher's, because the mesher walks the parser's tree plus the root
   * group the parser adds. With both at 256 — the first version of this fix —
   * source at 255 parsed clean and then meshed to nothing, and each limit looked
   * correct in isolation.
   *
   * ⚠ A TEST PINNED TO 200 AND 256 GOES GREEN THE DAY SOMEONE RAISES ONE OF THEM
   * AND NOT THE OTHER, which is precisely when this must go red. So it probes the
   * behaviour: whatever the parser accepts, the mesher must draw. */
  let deepestAccepted = 0;
  for (let d = 1; d <= 400; d++) {
    if (parseScad(nested(d)).errors.some((e) => /nest deeper/.test(e.message))) break;
    deepestAccepted = d;
  }
  assert.ok(deepestAccepted > 21, `the parser refuses at ${deepestAccepted}, below the deepest real design (21)`);

  const r = parseScad(nested(deepestAccepted));
  const mesh = meshScene(r.scene);
  assert.ok(
    mesh.parts.length > 0,
    `the parser accepted ${deepestAccepted} levels and the mesher then drew NOTHING — ` +
      'the two depth limits disagree, and the file is refused after being accepted',
  );
});
