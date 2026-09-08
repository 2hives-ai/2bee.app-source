// The 2bee.cad import host — `web/src/cad/library.ts`.
//
// WHAT THIS FILE EXERCISES
//
//   · 🔴 THAT A SPEC RESOLVES AGAINST THE IMPORTING FILE'S DIRECTORY. This is
//     the whole reason the library is a PATH map rather than a name lookup: the
//     tree this has to read writes `use <../lib/langstroth_box.scad>` and
//     `use <../2bee_vent_node/vent_node_inwall_3d.scad>`, and a store keyed on a
//     model's name cannot express "up one directory" — nor tell two files with
//     the same basename in different folders apart, which that tree has.
//   · 🔴 THAT A NEAR-MISS IS SUGGESTED AND NEVER SUBSTITUTED. This is the one
//     failure here that is silent: the wrong file parses perfectly, audits
//     closed, and draws a plausible wrong part with no error anywhere.
//   · 🔴 THAT AN UNRESOLVED IMPORT IS NEVER AN EMPTY FILE, end to end through
//     `parseScad`. An empty file turns every module the library defines into an
//     "unknown module" and blames the operator's typing for our failure.
//   · That a path climbing OUT of the picked folder is refused as its own case,
//     because "you asked for a file outside what you gave me" and "that file is
//     not there" send an operator to two different places.
//   · That two paths normalising to one key drop BOTH, so what the library holds
//     never depends on the order the browser listed the folder in.
//
// THE PLANTS, each watched red before this file was kept:
//   1. `resolveSpec` ignores `from` and resolves against the root. The
//      directory-relative tests go red — which is the whole feature.
//   2. `makeLibraryHost.read` falls back to a candidate when the exact path
//      misses. "a near-miss is offered, never resolved" goes red.
//   3. `normalisePath` clamps `..` at the root instead of returning null. The
//      escape test goes red and the miss is misreported as no-such-file.
//
// ⚠ MEASURED AGAINST THE REAL TREE, ONCE, AND NOT COMMITTED AS A TEST. Built
// over the 517 `.scad` files in `hardware/cad/`, every one of the **133**
// `use`/`include` statements in `2bee_hive/` and `2bee_solar_box/` — the two
// directories the founder named — resolved, with 0 misses. That is a fact about
// another lane's files on one day; asserting it here would make this suite go
// red when `cad` renames something of theirs, so it is recorded rather than
// enforced.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  candidatesFor,
  dirOf,
  libraryPaths,
  makeLibraryHost,
  normalisePath,
  relPathOf,
  resolveSpec,
} = await import('../src/cad/library.ts');
const { parseScad } = await import('../src/cad/scad.ts');

const lib = (files: Record<string, string>) => ({
  files: new Map(Object.entries(files)),
  rootName: 'cad',
  pickedAt: 1,
  skipped: [] as { path: string; why: string }[],
});

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

test('normalising resolves . and .. and accepts either separator', () => {
  assert.equal(normalisePath('a/b/../c.scad'), 'a/c.scad');
  assert.equal(normalisePath('./a//b/./c.scad'), 'a/b/c.scad');
  assert.equal(normalisePath('a\\b\\c.scad'), 'a/b/c.scad');
});

/** 🔴 PLANT TARGET 3. Clamp `..` at the root and this goes red. */
test('a path that climbs out of the picked folder is null, not clamped to the root', () => {
  assert.equal(normalisePath('../outside.scad'), null);
  assert.equal(normalisePath('a/../../outside.scad'), null);
});

test('case is left alone, because the trees this reads are case-sensitive', () => {
  assert.equal(normalisePath('Lib/Box.scad'), 'Lib/Box.scad');
});

test('the directory of a path, and the root as empty', () => {
  assert.equal(dirOf('a/b/c.scad'), 'a/b');
  assert.equal(dirOf('c.scad'), '');
});

/**
 * 🔴 PLANT TARGET 1. Make `resolveSpec` ignore `from` and every case below goes
 * red. These four shapes are taken from the real tree, not invented.
 */
test('a spec resolves against the DIRECTORY OF THE FILE THAT WROTE IT', () => {
  const from = '2bee_hive/2bee_hive_brood_assembly.scad';
  assert.equal(resolveSpec('2bee_hive_joinery.scad', from), '2bee_hive/2bee_hive_joinery.scad');
  assert.equal(resolveSpec('../2bee_connectors.scad', from), '2bee_connectors.scad');
  assert.equal(resolveSpec('../lib/langstroth_box.scad', from), 'lib/langstroth_box.scad');
  assert.equal(
    resolveSpec('../2bee_vent_node/vent_node_inwall_3d.scad', from),
    '2bee_vent_node/vent_node_inwall_3d.scad',
  );
});

/**
 * 🔴 THE CASE A NAME LOOKUP CANNOT EXPRESS. Two files with the same basename in
 * different folders are two different files, and the tree this reads has them.
 */
test('the same basename in two folders resolves to two different files', () => {
  /* ⚠ Both of these are real paths in `hardware/cad/`, and `../` from
   * `archive/2bee_weight/` lands in `archive/` — not at the root. The first
   * draft of this test asserted the root and went red, which is the arithmetic
   * being checked working. */
  const from = 'archive/2bee_weight/x.scad';
  const a = resolveSpec('2bee_weight.scad', from);
  const b = resolveSpec('../../2bee_weight_v1/2bee_weight.scad', from);
  assert.equal(a, 'archive/2bee_weight/2bee_weight.scad');
  assert.equal(b, '2bee_weight_v1/2bee_weight.scad');
  assert.notEqual(a, b, 'one basename, two files, and only a path can tell them apart');
});

test('a root-relative spec is relative to the folder that was picked', () => {
  assert.equal(resolveSpec('/lib/x.scad', 'deep/deeper/y.scad'), 'lib/x.scad');
});

// ---------------------------------------------------------------------------
// The host
// ---------------------------------------------------------------------------

test('a hit returns the resolved path and the source, and is recorded', () => {
  const host = makeLibraryHost(lib({ 'lib/box.scad': 'cube(1);', 'a/b.scad': '' }));
  const got = host.read('../lib/box.scad', 'a/b.scad');
  assert.deepEqual(got, { path: 'lib/box.scad', source: 'cube(1);' });
  assert.deepEqual(host.reads, ['lib/box.scad']);
  assert.equal(host.misses.length, 0);
});

test('with no folder mounted the miss says so, rather than blaming the path', () => {
  const host = makeLibraryHost(lib({}));
  assert.equal(host.read('anything.scad', ''), null);
  assert.equal(host.misses[0].why, 'no-library');
});

/** 🔴 PLANT TARGET 3, second half: the escape must be its own reported case. */
test('climbing out of the folder is reported as that, not as a missing file', () => {
  const host = makeLibraryHost(lib({ 'a/b.scad': '' }));
  assert.equal(host.read('../../etc/passwd', 'a/b.scad'), null);
  assert.equal(host.misses[0].why, 'escapes-the-folder');
  assert.equal(host.misses[0].resolved, null);
});

/**
 * 🔴 PLANT TARGET 2, AND THE MOST DANGEROUS DEFECT IN THIS FILE. A host that
 * "helpfully" fell back to a same-named file in another folder would draw the
 * operator's model from the wrong source — parsing cleanly, auditing closed,
 * reporting nothing. So the read MISSES, and the candidate is offered as text.
 */
test('a near-miss is OFFERED and never resolved', () => {
  const host = makeLibraryHost(lib({ 'lib/box.scad': 'cube(1);' }));
  const got = host.read('box.scad', 'a/b.scad');
  assert.equal(got, null, 'the wrong file was substituted for the one that was asked for');
  const m = host.misses[0];
  assert.equal(m.why, 'no-such-file');
  assert.equal(m.resolved, 'a/box.scad');
  assert.deepEqual(m.candidates, ['lib/box.scad'], 'the operator was told nothing about where it is');
});

test('candidates put an exact basename match ahead of a partial one', () => {
  const found = candidatesFor('a/box.scad', ['x/box.scad', 'y/boxes_extra.scad', 'z/unrelated.scad']);
  assert.equal(found[0], 'x/box.scad');
  assert.ok(!found.includes('z/unrelated.scad'));
});

test('the same file read twice is listed once', () => {
  const host = makeLibraryHost(lib({ 'x.scad': '' }));
  host.read('x.scad', '');
  host.read('x.scad', '');
  assert.deepEqual(host.reads, ['x.scad']);
});

// ---------------------------------------------------------------------------
// Through the parser — the properties that only exist end to end
// ---------------------------------------------------------------------------

const SRC = 'use <../lib/box.scad>\nbox();\n';

/**
 * 🔴 AN UNRESOLVED IMPORT IS NEVER AN EMPTY FILE. The property is the parser's
 * and this asserts it holds THROUGH THIS HOST, because the host is what decides
 * whether `null` or a source comes back — the one place it could be broken from
 * outside `scad.ts`.
 */
test('an import this host cannot resolve is REFUSED BY NAME, never treated as empty', () => {
  const host = makeLibraryHost(lib({ 'other/box.scad': 'module box() cube(1);' }));
  const out = parseScad(SRC, { host, path: 'a/b.scad' });
  const refusal = out.unsupported.find((u) => u.name.includes('use <../lib/box.scad>'));
  assert.ok(refusal, `the refusal must name the path that was asked for: ${JSON.stringify(out.unsupported)}`);
  assert.equal(out.scene.children.length, 0, 'nothing may be drawn from an import that was not read');
});

test('and with the folder mounted, the same source resolves and draws', () => {
  const host = makeLibraryHost(lib({ 'lib/box.scad': 'module box() cube(10);' }));
  const out = parseScad(SRC, { host, path: 'a/b.scad' });
  assert.equal(out.unsupported.length, 0, `nothing should be refused: ${JSON.stringify(out.unsupported)}`);
  assert.equal(out.errors.length, 0);
  assert.ok(out.scene.children.length > 0, 'the used module drew nothing');
  assert.deepEqual(host.reads, ['lib/box.scad']);
});

/**
 * ⚠ THE SAME SOURCE, TWO FOLDERS, TWO DIFFERENT PARTS. This is the case that
 * makes path resolution safety-bearing rather than tidy: the wrong `box.scad`
 * is not an error, it is a different cube.
 */
test('which folder is mounted decides which part is drawn, and both are silent about it', () => {
  const ten = parseScad(SRC, {
    host: makeLibraryHost(lib({ 'lib/box.scad': 'module box() cube(10);' })),
    path: 'a/b.scad',
  });
  const twenty = parseScad(SRC, {
    host: makeLibraryHost(lib({ 'lib/box.scad': 'module box() cube(20);' })),
    path: 'a/b.scad',
  });
  assert.equal(ten.errors.length, 0);
  assert.equal(twenty.errors.length, 0);
  assert.notDeepEqual(
    JSON.stringify(ten.scene),
    JSON.stringify(twenty.scene),
    'if these matched, this test could not see the defect it exists for',
  );
});

test('a cycle is refused rather than recursed, and the refusal names the chain', () => {
  const host = makeLibraryHost(
    lib({ 'a.scad': 'include <b.scad>\n', 'b.scad': 'include <a.scad>\n' }),
  );
  const out = parseScad('include <a.scad>\n', { host, path: 'root.scad' });
  assert.ok(
    out.unsupported.some((u) => /circular/i.test(u.detail)),
    `a cycle must be named: ${JSON.stringify(out.unsupported)}`,
  );
});

// ---------------------------------------------------------------------------
// Building the library from what a directory input hands back
// ---------------------------------------------------------------------------

test('a File with no webkitRelativePath degrades to its name, never to an empty key', () => {
  assert.equal(relPathOf({ name: 'x.scad' } as File), 'x.scad');
  assert.equal(
    relPathOf({ name: 'x.scad', webkitRelativePath: 'cad/lib/x.scad' } as unknown as File),
    'cad/lib/x.scad',
  );
});

test('paths come back sorted, so a picker is not in browser-enumeration order', () => {
  assert.deepEqual(libraryPaths(lib({ 'b.scad': '', 'a.scad': '', 'a/c.scad': '' })), [
    'a.scad',
    'a/c.scad',
    'b.scad',
  ]);
});
