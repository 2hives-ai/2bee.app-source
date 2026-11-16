// What a `use`d library can SEE, and which definition a name resolves to.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE DEFECT, AS IT REACHED A CUT FILE
// ─────────────────────────────────────────────────────────────────────────────
//
// `hardware/cad/2bee_hive/2bee_hive_panels_4mm_wcnc.scad` sets `W = 18` and
// `use`s `side_hive_divider.scad`, whose `nuc_divider(w = is_undef(W) ? 19 : W)`
// reads W in a DEFAULT ARGUMENT. The scad_oracle (cut-only) tree line 2:
//
//     openscad  cube(size=[19,4,28])
//     ours      cube(size=[18,4,28])
//
// OpenSCAD evaluates a default argument in the module's DEFINING scope, and a
// `use`d file's defining scope is that file plus the builtins — the caller's
// `W` is invisible there. Ours ran the main file in the builtins' own env, the
// env every `use`d file is parented to, so the caller's top-level names leaked
// into every library. A 1 mm wrong divider, with nothing said.
//
// Closing that leak exposed two more scoping rules that had been cancelling it
// out — `use` was TRANSITIVE here and is not in OpenSCAD, and a `use` written
// below a definition OVERWROTE it — and with the leak closed alone, three hive
// panels lost their serial/QR recesses. All three rules are pinned below.
//
// Every expectation was measured on openscad 2026.08.07, 2026-10-14, with the
// same files written to disk; the outputs are quoted beside each test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseScad } from '../src/cad/scad.ts';
import { makeLibraryHost, type ScadLibrary } from '../src/cad/library.ts';
import type { SceneNode } from '../src/cad/scad.ts';

function run(files: Record<string, string>, main: string) {
  const l: ScadLibrary = { files: new Map(Object.entries(files)), rootName: 'test', pickedAt: 0, skipped: [] };
  return parseScad(l.files.get(main)!, { host: makeLibraryHost(l), path: main });
}

function echoes(files: Record<string, string>, main: string): string[] {
  return run(files, main).console.map((e) => e.message);
}

/** Every cube size in the evaluated tree, in order. */
function cubes(n: SceneNode, out: number[][] = []): number[][] {
  if (n.kind === 'primitive' && n.params.kind === 'cube') out.push([...n.params.size]);
  for (const c of (n as { children?: SceneNode[] }).children ?? []) cubes(c, out);
  return out;
}

const LIB = {
  'lib.scad':
    'module m(w = is_undef(W) ? 19 : W) { echo(default_w = w, body_W = is_undef(W) ? "undef" : W); }\n' +
    'function f(w = is_undef(W) ? 19 : W) = w;\n' +
    'module inner() echo(inner_W = is_undef(W) ? "undef" : W);\n',
};

test("a `use`d module's DEFAULT ARGUMENT does not see the caller's top-level variable", () => {
  // openscad: ECHO: default_w = 19, body_W = "undef" · ECHO: f = 19 · ECHO: inner_W = "undef"
  const e = echoes({ ...LIB, 'main.scad': 'W = 18;\nuse <lib.scad>;\nm();\necho(f = f());\ninner();\n' }, 'main.scad');
  assert.ok(e.includes('default_w = 19, body_W = "undef"'), `got ${JSON.stringify(e)} — 18 means the caller's W leaked`);
  assert.ok(e.includes('f = 19'), JSON.stringify(e));
  assert.ok(e.includes('inner_W = "undef"'), JSON.stringify(e));
});

test('`include` IS textual, so there the caller\'s W is visible — 18 in both tools', () => {
  // openscad: ECHO: default_w = 18, body_W = 18 · ECHO: f = 18
  const e = echoes({ ...LIB, 'main.scad': 'W = 18;\ninclude <lib.scad>;\nm();\necho(f = f());\n' }, 'main.scad');
  assert.ok(e.includes('default_w = 18, body_W = 18'), JSON.stringify(e));
  assert.ok(e.includes('f = 18'), JSON.stringify(e));
});

test('the 4mm-panel shape: the used divider is cut at its OWN default, 19, not the caller\'s 18', () => {
  // openscad: cube(size = [19, 4, 28], center = false);
  const files = {
    'div.scad': 'module divider(w = is_undef(W) ? 19 : W) cube([w, 4, 28]);\n',
    'main.scad': 'W = 18;\nuse <div.scad>;\ndivider();\n',
  };
  assert.deepEqual(cubes(run(files, 'main.scad').scene), [[19, 4, 28]]);
});

test('$-variables still reach a used module dynamically — top-level $fn = 7 applies', () => {
  // openscad: circle($fn = 7, $fa = 12, $fs = 2, r = 5);
  const r = run({ 'lib2.scad': 'module m3() circle(5);\n', 'main.scad': '$fn = 7;\nuse <lib2.scad>;\nm3();\n' }, 'main.scad');
  let fn: number | null | undefined;
  (function w(n: SceneNode) {
    if (n.kind === 'primitive' && n.params.kind === 'circle') fn = (n.params as { fn?: number | null }).fn;
    for (const c of (n as { children?: SceneNode[] }).children ?? []) w(c);
  })(r.scene);
  assert.equal(fn, 7);
});

test('`use` is NOT transitive — a name b imported from c is not visible in a', () => {
  // openscad: ECHO: "mc" · ECHO: fb = 3 · WARNING: Ignoring unknown module 'mc' …
  //           WARNING: Ignoring unknown function 'fc' … · ECHO: fa = undef
  const r = run(
    {
      'c.scad': 'module mc() echo("mc"); function fc() = 3;\n',
      'b.scad': 'use <c.scad>\nmodule mb() { mc(); echo(fb = fc()); }\n',
      'a.scad': 'use <b.scad>\nmb();\nmc();\necho(fa = fc());\n',
    },
    'a.scad',
  );
  const e = r.console.map((x) => x.message);
  assert.ok(e.includes('fb = 3'), 'b still sees its own import');
  assert.equal(e.filter((x) => x === '"mc"').length, 1, `mc() ran ${e.filter((x) => x === '"mc"').length}× — only mb() may call it`);
  assert.ok(r.unsupported.some((u) => u.name === 'mc()'), 'a calling mc() directly must be NAMED, not run');
  assert.ok(r.unsupported.some((u) => u.name === 'fc()'), 'a calling fc() directly must be NAMED, not run');
});

test("a scope's OWN definition beats a `use`d one, wherever the `use` sits; among uses the last wins", () => {
  const libs = {
    'l1.scad': 'module m() echo("from l1"); function f() = "l1";\n',
    'l2.scad': 'module m() echo("from l2"); function f() = "l2";\n',
  };
  // openscad: ECHO: "own" · ECHO: "l1"
  assert.deepEqual(echoes({ ...libs, 'o.scad': 'module m() echo("own");\nuse <l1.scad>\nm();\necho(f());\n' }, 'o.scad'), ['"own"', '"l1"']);
  // openscad: ECHO: "from l2" · ECHO: "l2"
  assert.deepEqual(echoes({ ...libs, 't.scad': 'use <l1.scad>\nuse <l2.scad>\nm();\necho(f());\n' }, 't.scad'), ['"from l2"', '"l2"']);
});

test('the hive-panel cycle: a defs-only re-read cannot replace the real module (the QR recess survives)', () => {
  // inner defines zone() (needs q's qr()), then — below it — uses pod, which
  // uses inner back (a cycle, so pod sees a defs-only inner WITHOUT its
  // imports) and defines a same-named zone(). openscad emits cube([1,1,1]).
  const files = {
    'q.scad': 'module qr() cube(1);\n',
    'inner.scad': 'use <q.scad>\nmodule zone() qr();\nfunction where() = 5;\nuse <pod.scad>\n',
    'pod.scad': 'use <inner.scad>\nmodule zone() translate([where(),0,0]) cube(2);\n',
    'main.scad': 'use <inner.scad>\nzone();\n',
  };
  const r = run(files, 'main.scad');
  assert.deepEqual(r.unsupported, []);
  assert.deepEqual(cubes(r.scene), [[1, 1, 1]], 'cube 2 means pod.scad\'s zone() replaced inner.scad\'s own');
});
