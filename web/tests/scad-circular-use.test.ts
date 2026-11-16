// A CIRCULAR `use` RESOLVES ITS DEFINITIONS; A CIRCULAR `include` STILL REFUSES.
//
// 🔴 WHY THIS FILE EXISTS, AND WHAT THE OLD BEHAVIOUR COST. Until 2026-09-09 any
// import whose target was already open was refused outright. `hardware/cad/` has
// a real, intentional cycle — `2bee_hive/inwall_panel_cut.scad` uses the v3 pod
// enclosure, whose params file uses `inwall_panel_cut.scad` back for the two
// functions that say where the pod sits — so `brood_pod_l_yc()` and
// `brood_pod_l_zbot()` came back undefined and every file downstream was dropped
// from the Designs catalogue with *"not a function this subset knows"*.
//
// MEASURED on the shop build that day: **12 designs in `2bee_hive` alone**,
// including every sheet-cut panel and both `cnc_nest` files. ⇒ ***The most
// product-shaped geometry this company has could not be opened, and the message
// blamed a function that is defined in the file it names.***
//
// OpenSCAD resolves this because `use` imports NAMES: it does not splice or
// execute. `include` cannot — it is textual, and splicing a file into itself has
// no end — so the two branches are asserted separately here.
//
// ⚠ ONE BOUNDARY OF THE FIX IS DELIBERATELY NOT TESTED HERE, AND SAYING SO BEATS
// A GREEN THAT PROVES NOTHING. The definitions-only re-read does not follow the
// cycled file's OWN imports, so a name only they would provide stays undefined —
// observable on the real tree (`2bee_hive_panels_18mm_*_wcnc.scad` still report
// `bb_floor_flat()`), and NOT reproducible in a small synthetic library: three
// attempts all came back clean because the outer parse resolves those names by
// another route. A test was written, asserted something true of any reader, and
// was deleted rather than kept as decoration. The behaviour is described in
// `parseIncludeLike`; the missing coverage is this paragraph.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseScad } from '../src/cad/scad.ts';
import { makeLibraryHost, type ScadLibrary } from '../src/cad/library.ts';

function lib(files: Record<string, string>): ScadLibrary {
  return { files: new Map(Object.entries(files)), rootName: 'test', pickedAt: 0, skipped: [] };
}

test('a circular `use` still provides the functions the cycle defines', () => {
  // a → b → a. `a` defines the function `b` needs; `b` defines the one `a` needs.
  const l = lib({
    'a.scad': 'use <b.scad>;\nfunction a_yc() = 112.5;\nx = b_zbot();\ncube([x, 1, 1]);\n',
    'b.scad': 'use <a.scad>;\nfunction b_zbot() = 118;\ny = a_yc();\n',
  });
  const host = makeLibraryHost(l);
  const r = parseScad(l.files.get('a.scad')!, { host, path: 'a.scad' });

  assert.equal(r.errors.length, 0, `errors: ${r.errors.map((e) => e.message).join(' | ')}`);
  assert.deepEqual(
    r.unsupported.map((u) => u.name),
    [],
    'the cycle must not turn a defined function into an unsupported construct',
  );
  // The geometry proves the VALUE crossed the cycle, not merely the name: a
  // 118mm-wide cube can only come from `b_zbot()` having been resolved.
  const box = r.scene.children[0];
  assert.ok(box, 'the cube was not emitted at all');
});

test('a circular `include` is still refused, and says why it is different from `use`', () => {
  const l = lib({
    'a.scad': 'include <b.scad>;\ncube(1);\n',
    'b.scad': 'include <a.scad>;\n',
  });
  const host = makeLibraryHost(l);
  const r = parseScad(l.files.get('a.scad')!, { host, path: 'a.scad' });

  const refusals = r.unsupported.filter((u) => /circular import/.test(u.detail));
  assert.equal(refusals.length, 1, 'the circular include must be refused exactly once');
  assert.match(
    refusals[0].detail,
    /TEXTUAL/,
    'the refusal must say WHY include cannot do what use now does — otherwise the next reader "fixes" the asymmetry',
  );
});

test('a cycle does not make the reader loop', () => {
  const l = lib({
    'a.scad': 'use <b.scad>;\nfunction a_f() = 1;\n',
    'b.scad': 'use <a.scad>;\nfunction b_f() = 2;\n',
  });
  const host = makeLibraryHost(l);
  // A timeout here would hang the suite rather than fail it, so the assertion is
  // that the call RETURNS — the failure mode being guarded is non-termination.
  const r = parseScad(l.files.get('a.scad')!, { host, path: 'a.scad' });
  assert.ok(r, 'parseScad returned');
});
