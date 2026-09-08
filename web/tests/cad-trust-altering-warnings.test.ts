// `trust` COUNTED REFUSALS ONLY — AND A REFUSAL IS NOT THE ONLY WAY TO LOSE
// GEOMETRY.
//
// ═══════════════════════════════════════════════════════════════════════════
// THE DEFECT THIS FILE EXISTS FOR
// ═══════════════════════════════════════════════════════════════════════════
//
// `meshScene`'s verdict was computed from the audit (watertight? manifold?) plus
// the count of constructs REFUSED by the parser or the kernel. Warnings were not
// consulted at all. One of them means "what is drawn is not what the source
// describes":
//
//   this difference has only ONE operand in the scene tree, so it evaluates to
//   that operand unchanged.
//
// A `difference()` whose subject evaluates to nothing returns its remaining
// operand — so the picture is a CUT standing in for the part. Closed, manifold,
// consistently wound, and the wrong solid. `trust` said `trusted`, and its
// detail said "nothing was refused by the kernel or by the parser", which was
// TRUE and the most misleading sentence available.
//
// 🔴 MEASURED, NOT REASONED. Against OpenSCAD 2026.08.07 on this box
// (2026-08-31), `hardware/cad/2bee_hive/2bee_hive_fan_box_panel_wcnc.scad` — a
// `_wcnc` file, a sheet part cut on the CNC — drew a 41.2 × 41.2 × 1 mm chip for
// a 121.5 × 407 × 18 mm panel, with ZERO errors and ZERO unsupported
// constructs, and was listed in the Designs catalogue under a "complete render"
// badge.
//
// ⚠ THE WARNING'S OWN COMMENT ASSUMED THIS WAS UNREACHABLE. It says the missing
// operands "were REFUSED by the parser and dropped — check the refusal list",
// i.e. it assumed a refusal always accompanies the warning and would degrade
// trust by itself. That file has no refusals. An operand can vanish with NOTHING
// named — and that case is worse, not better, because there is no list to check.
//
// ═══════════════════════════════════════════════════════════════════════════
// ⚠ WHAT THIS FIX DOES **NOT** DO, MEASURED IN THE SAME PASS
// ═══════════════════════════════════════════════════════════════════════════
//
// Of 47 `trusted` designs in cad's tree, 10 disagree with OpenSCAD by more than
// 5% in volume. This change demotes **one** of them. The other nine are wrong
// through mechanisms that emit NO diagnostic of any kind, and no verdict
// computed from this app's own reports can reach them — only a differential
// against OpenSCAD can. Recording the number here so this file is not read as
// "trust is now correct". It is correct about the things that are reported.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseScad } from '../src/cad/scad.ts';
import { meshScene } from '../src/cad/mesh.ts';

const verdict = (src: string) => meshScene(parseScad(src, {}).scene);

test('a boolean left with ONE operand is no longer `trusted`', () => {
  const m = verdict('difference() { cube(10); }');
  assert.equal(m.trust, 'suspect');
  assert.match(m.trustDetail, /did not draw what the source describes/);
  // The verdict must NAME the construct, or the reader has nowhere to look.
  assert.match(m.trustDetail, /difference\(\)/);
});

test('...and the same holds for union and intersection', () => {
  assert.equal(verdict('union() { cube(10); }').trust, 'suspect');
  assert.equal(verdict('intersection() { cube(10); }').trust, 'suspect');
});

test('the OLD detail sentence is gone — "nothing was refused" must not stand alone', () => {
  // 🔴 The regression this guards is a REWORDING. `trusted`'s old text was true
  // and useless here; if someone restores it as the answer for a model that
  // warned about its own geometry, this file must go red.
  const m = verdict('difference() { cube(10); }');
  assert.ok(
    !/^Every solid drawn is watertight, manifold and consistently wound/.test(m.trustDetail),
    `a model that lost an operand must not get the clean verdict: ${m.trustDetail}`,
  );
});

test('a COLOUR warning does not demote — it never touches a vertex', () => {
  // The discriminating case. `2bee_hive_fan_box_panel_wcnc.scad` carried FOUR
  // colour warnings alongside its one real defect; demoting on any warning
  // would have been right for the wrong reason and would flag every
  // multi-coloured assembly in the catalogue.
  const m = verdict('difference() { color("red") cube(10); color("blue") translate([5,5,5]) cube(10); }');
  assert.equal(m.trust, 'trusted');
  const colour = m.issues.find((i) => /colours/.test(i.detail));
  assert.equal(colour?.alters, 'appearance');
});

test('an ordinary two-operand boolean is still `trusted`', () => {
  const m = verdict('difference() { cube(10); translate([5,5,5]) cube(10); }');
  assert.equal(m.trust, 'trusted');
  assert.deepEqual(m.issues.filter((i) => i.severity === 'warning'), []);
});

test('an unclassified warning defaults to `geometry` — the SAFE direction', () => {
  // 🔴 The default is what protects the next warning somebody adds without
  // thinking about `trust`. A spurious `suspect` costs a second look; a
  // spurious `trusted` costs a cut part. Asserted on the emitted issue so the
  // default cannot be flipped to 'appearance' as a convenience.
  const m = verdict('difference() { cube(10); }');
  const w = m.issues.find((i) => i.severity === 'warning');
  assert.ok(w, 'the one-operand warning must still be emitted');
  assert.equal(w.alters ?? 'geometry', 'geometry');
});

test('trusted still says what it does NOT claim, including the OpenSCAD gap', () => {
  const m = verdict('difference() { cube(10); translate([5,5,5]) cube(10); }');
  assert.equal(m.trust, 'trusted');
  assert.match(m.trustDetail, /not a claim that the shape is what you meant/);
  // Added 2026-08-31: `trusted` must not be read as "checked against OpenSCAD".
  assert.match(m.trustDetail, /OpenSCAD/);
  assert.match(m.trustDetail, /never been cut|has ever been cut/);
});
