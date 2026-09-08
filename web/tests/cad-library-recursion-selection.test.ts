// The recursive folder mount and the file selection over it —
// `web/src/cad/library.ts` + the first section of `web/src/cad/open.tsx`.
//
// Founder, 2026-08-11: *"Mount a folder of .scad files … Should look recursive
// in all subdirs; before importing all files, able to select in a list which
// files need to be imported."*
//
// ═══════════════════════════════════════════════════════════════════════════
// WHAT "IMPORT" MEANS HERE, BECAUSE THE TWO READINGS BEHAVE DIFFERENTLY
// ═══════════════════════════════════════════════════════════════════════════
//
// It is NOT "copy the chosen files into the browser's saved-drawings store".
// The store is keyed on a FLAT NAME, so it cannot express
// `use <../lib/langstroth_box.scad>`, and copying would have broken every
// path-based import in the founder's own assemblies. It means "is reachable
// from `host.read`": the folder stays mounted in `CadTab.tsx` and is resolved
// against on demand. `selectLibrary` therefore returns a SUBSET of a library
// that was read — it can only narrow — and this file asserts that property
// rather than trusting the sentence.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHAT THIS FILE EXERCISES
// ═══════════════════════════════════════════════════════════════════════════
//
//   · 🔴 THAT THE MOUNT IS RECURSIVE AND DOES NOT FLATTEN. `webkitdirectory`
//     walks the subtree in the browser; the paths it returns are the map's
//     keys, so `a/box.scad` and `b/box.scad` are two files. A flattening
//     regression is invisible in a folder with no repeated basenames, and
//     `hardware/cad/` has twenty of them.
//   · 🔴 THAT A DESELECTED DEPENDENCY IS NAMED BEFORE IT IS MOUNTED. This is
//     the one failure this feature CREATES, and it is silent: §7 measures the
//     real assembly losing 158 of its 237 primitives with ZERO errors and a
//     model still on screen.
//   · 🔴 THAT THE GRAPH IS THE PARSER'S. A regex over the same tree finds 929
//     edges where the parser finds 714 and disagrees on 119 of 517 files — a
//     graph built from one would demand files that are only mentioned in
//     comments.
//   · 🔴 THAT SELECTING EVERYTHING IS A NO-OP. The regression control for the
//     founder's own workflow: pick, press Mount, nothing else — 32 files, 0
//     misses, exactly as before this change.
//   · That every bound SAYS WHAT IT DROPPED, and that a file which cannot be
//     read is a named skip rather than a dead mount.
//
// ═══════════════════════════════════════════════════════════════════════════
// THE PLANTS — each was made, watched RED, and the file restored byte-identical
// ═══════════════════════════════════════════════════════════════════════════
//
//   1. `relPathOf` returns `f.name` instead of the relative path — the
//      flattening regression. RED ×4, including "two files with the same
//      basename in different subdirectories are two files".
//   2. `selectionNeeds` walks only edges out of the ORIGINALLY-chosen files.
//      RED ×2 on the real tree. ⚠ It did NOT redden the small chain case, which
//      is why 2b exists.
//   2b. `selectionNeeds` never queues, so it walks strictly one level. RED ×3,
//      including the chain case §3 and the joinery case §7.
//   3. `selectLibrary` ignores `needs` and writes the plain reason for every
//      dropped file. RED ×2: "the mounted library remembers WHICH drop broke an
//      import", and the panel's shortfall block disappears.
//   4. `importEdges` swapped for a `(use|include)\s*<...>` regex. RED: "an
//      import inside a comment is not an edge".
//   5. The `Truncated` tail line removed. RED: "a list longer than it prints
//      says how many it did not print".
//   6. The `MAX_LIBRARY_BYTES` skip restored to its old wording. RED: "the byte
//      bound says how many files it did not read".
//   7. `await f.text()` back outside its `try`, so one unreadable file throws
//      the whole mount away. RED: §6.
//   8. `selectLibrary` keeps every file regardless of the tick. RED ×3 — the
//      selection is decoration.
//   9. `selectLibrary` drops `lib/` even when everything is ticked — the "32
//      becomes fewer" regression. RED: §7's full-selection case.
//
// ⚠ PLANT 1 IS ALSO WHY §7 GOES THROUGH `libraryFromFiles` AND NOT THROUGH A
// HAND-BUILT MAP. Run against the first draft it reddened the four fake-
// filesystem cases and left the founder's own 32-file assembly GREEN — a map
// assembled by the test cannot flatten, so the case that matters most was
// sitting outside the code the plant broke. `realPick()` now feeds the real tree
// in as a browser would, and plant 1 reddens §7 too.
//
// ⚠ PLANT 9 WAS RUN TWICE AND THE FIRST RUN PROVED NOTHING. It matched
// `path.includes('/lib/')`, and the real-tree keys are `lib/langstroth_box.scad`
// with no leading segment — so the plant deleted nothing and the suite went
// green. A plant that does not fire says nothing about the control; it says the
// plant missed. The second form (`startsWith('lib/')`) went red on the file it
// was aimed at. Recorded because reading a green after a plant as "the plant was
// covered" is how a negative control becomes decoration.
//
// ⚠ WHAT IS NOT EXERCISED, AND CANNOT BE FROM HERE. There is no browser: a
// directory picker cannot be opened, `webkitdirectory` cannot be exercised, and
// `File.webkitRelativePath` is SIMULATED by the fake below. So what is asserted
// here is that **given the list of files a browser would hand back**, the mount,
// the graph and the selection behave. That the browser hands back a recursive
// list at all is a property of `webkitdirectory` itself, and the only evidence
// for it in this repo is the real-tree measurement recorded in `library.ts`'s
// header — a fact about a spec, not a control. Likewise: the STAGED half of the
// panel (the checkbox list, the Mount button, the live warning) renders only
// after a real pick, so `renderToStaticMarkup` never reaches it. §8 asserts the
// half that survives the dialog — the warning carried on the mounted library —
// and the staged half needs a human with a browser.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, lstatSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const {
  depthHistogram,
  importEdges,
  libraryFromFiles,
  makeLibraryHost,
  selectLibrary,
  selectionNeeds,
  wasDeselected,
  MAX_LIBRARY_BYTES,
} = await import('../src/cad/library.ts');
const { parseScad } = await import('../src/cad/scad.ts');
const { CadOpen } = await import('../src/cad/open.tsx');

type Lib = Awaited<ReturnType<typeof libraryFromFiles>>;

/* ════════════════════════════════════════════════════════════════════════════
   A fake of exactly the four things `libraryFromFiles` touches
   ════════════════════════════════════════════════════════════════════════════ */

/**
 * ⚠ `webkitRelativePath` IS SIMULATED, and that is the boundary of this suite.
 * A real browser sets it to `<picked folder>/<path inside it>` for every file in
 * the subtree; nothing here can make it do that, so the fake supplies the shape
 * and the assertions are about what the code does with it.
 */
class FakeFile {
  constructor(
    readonly webkitRelativePath: string,
    private readonly body: string,
    private readonly fail?: string,
  ) {}
  get name() {
    return this.webkitRelativePath.split('/').pop() ?? '';
  }
  get size() {
    return this.body.length;
  }
  async text() {
    if (this.fail) throw new Error(this.fail);
    return this.body;
  }
}

const files = (spec: Record<string, string>): File[] =>
  Object.entries(spec).map(([p, s]) => new FakeFile(p, s)) as unknown as File[];

/** A library made by hand, for the graph tests that do not need the reader. */
const libOf = (spec: Record<string, string>): Lib => ({
  files: new Map(Object.entries(spec)),
  rootName: 'root',
  pickedAt: 1,
  skipped: [],
});

/* ════════════════════════════════════════════════════════════════════════════
   1. Recursive, and NOT flattened
   ════════════════════════════════════════════════════════════════════════════ */

test('subdirectories arrive with their paths, at whatever depth they sit', async () => {
  const lib = await libraryFromFiles(
    files({
      'cad/top.scad': 'cube(1);',
      'cad/2bee_hive/box.scad': 'cube(2);',
      'cad/lib/openbuilds/ob_plates.scad': 'cube(3);',
      'cad/a/b/c/d/deep.scad': 'cube(4);',
    }),
  );
  assert.equal(lib.files.size, 4);
  assert.deepEqual(
    [...lib.files.keys()].sort(),
    ['cad/2bee_hive/box.scad', 'cad/a/b/c/d/deep.scad', 'cad/lib/openbuilds/ob_plates.scad', 'cad/top.scad'],
  );
  /* `depth` counts the `/`s, so the picked folder's own name is one level —
   * `cad/top.scad` is 1 and `cad/a/b/c/d/deep.scad` is 5. See the function. */
  assert.deepEqual(depthHistogram(lib), [
    { depth: 1, files: 1 },
    { depth: 2, files: 1 },
    { depth: 3, files: 1 },
    { depth: 5, files: 1 },
  ]);
});

/**
 * 🔴 PLANT TARGET 1, and the reason the map is keyed on a path at all.
 * `hardware/cad/` holds twenty repeated basenames — `params.scad`, `lid.scad`,
 * `assembly.scad` — so a flattening regression there does not error, it merges.
 */
test('two files with the same basename in different subdirectories are two files', async () => {
  const lib = await libraryFromFiles(
    files({ 'cad/2bee_hive/params.scad': 'w = 1;', 'cad/2bee_feeder/params.scad': 'w = 2;' }),
  );
  assert.equal(lib.files.size, 2);
  assert.equal(lib.files.get('cad/2bee_hive/params.scad'), 'w = 1;');
  assert.equal(lib.files.get('cad/2bee_feeder/params.scad'), 'w = 2;');
  assert.deepEqual(lib.skipped, [], 'neither was reported as a collision — they do not collide');
});

test('a non-.scad file anywhere in the subtree is skipped WITH its path, not dropped', async () => {
  const lib = await libraryFromFiles(
    files({ 'cad/a/part.scad': 'cube(1);', 'cad/a/part.stl': 'solid', 'cad/README.md': '#' }),
  );
  assert.equal(lib.files.size, 1);
  assert.deepEqual(
    lib.skipped.map((s) => s.path).sort(),
    ['cad/README.md', 'cad/a/part.stl'],
  );
});

/* ════════════════════════════════════════════════════════════════════════════
   2. The graph is the PARSER's, not a regex's
   ════════════════════════════════════════════════════════════════════════════ */

/**
 * 🔴 PLANT TARGET 4. Measured on the real tree, 2026-08-11: the parser finds
 * **714** edges across 517 files, a careful regex finds **929**, and they
 * disagree on **119 files**. Every one of those 215 extra edges is a file the
 * operator would have been told they must keep — including
 * `use <2bee_cables.scad>` written inside a comment that DOCUMENTS how to use
 * the file it sits in.
 */
test('an import inside a comment is not an edge', () => {
  const edges = importEdges(
    libOf({
      'a.scad': [
        '// use <line_comment.scad>',
        '/* use <block_comment.scad> */',
        'use <real.scad>;',
        'cube(1);',
      ].join('\n'),
      'real.scad': 'module m() cube(1);',
    }),
  );
  assert.deepEqual(
    (edges.get('a.scad') ?? []).map((e) => e.spec),
    ['real.scad'],
  );
});

test('an edge records where it resolves TO, relative to the importing file', () => {
  const edges = importEdges(
    libOf({
      'hive/assembly.scad': 'use <../lib/box.scad>;\ninclude <joinery.scad>;\ncube(1);',
      'lib/box.scad': 'module b() cube(1);',
      'hive/joinery.scad': 'j = 1;',
    }),
  );
  assert.deepEqual(
    (edges.get('hive/assembly.scad') ?? []).map((e) => e.resolved),
    ['lib/box.scad', 'hive/joinery.scad'],
  );
});

test('a spec that climbs out of the picked folder resolves to null rather than to a guess', () => {
  const edges = importEdges(libOf({ 'a.scad': 'use <../../etc/passwd>;\ncube(1);' }));
  assert.deepEqual(
    (edges.get('a.scad') ?? []).map((e) => e.resolved),
    [null],
  );
});

/* ════════════════════════════════════════════════════════════════════════════
   3. What a selection is short of — transitively
   ════════════════════════════════════════════════════════════════════════════ */

const CHAIN = {
  'a.scad': 'use <b.scad>;\ncube(1);',
  'b.scad': 'use <sub/c.scad>;\nmodule mb() cube(2);',
  'sub/c.scad': 'module mc() cube(3);',
  'unrelated.scad': 'cube(9);',
};

test('selecting a file selects nothing else — the closure is REPORTED, never applied silently', () => {
  const lib = libOf(CHAIN);
  const needs = selectionNeeds(lib, importEdges(lib), ['a.scad']);
  assert.deepEqual([...needs.needed].sort(), ['a.scad', 'b.scad', 'sub/c.scad']);
  assert.deepEqual(
    needs.missing.map((m) => m.path),
    ['b.scad', 'sub/c.scad'],
  );
});

/**
 * 🔴 PLANT TARGET 2. `a` imports `b` imports `c`. Untick only `c` and a
 * one-level check sees a complete selection — while the tree loses everything
 * `c` defines.
 */
test('a dependency two hops away is still named, and by the file that actually imports it', () => {
  const lib = libOf(CHAIN);
  const needs = selectionNeeds(lib, importEdges(lib), ['a.scad', 'b.scad']);
  assert.deepEqual(
    needs.missing.map((m) => `${m.path} <= ${m.neededBy.join(',')}`),
    ['sub/c.scad <= b.scad'],
  );
});

test('a complete selection reports nothing missing', () => {
  const lib = libOf(CHAIN);
  const needs = selectionNeeds(lib, importEdges(lib), ['a.scad', 'b.scad', 'sub/c.scad']);
  assert.deepEqual(needs.missing, []);
  assert.deepEqual(needs.unresolvable, []);
});

test('a cycle terminates instead of walking forever', () => {
  const lib = libOf({ 'a.scad': 'include <b.scad>;\ncube(1);', 'b.scad': 'include <a.scad>;\ncube(2);' });
  const needs = selectionNeeds(lib, importEdges(lib), ['a.scad']);
  assert.deepEqual([...needs.needed].sort(), ['a.scad', 'b.scad']);
});

/**
 * ⚠ THE TWO KINDS OF FAILURE ARE KEPT APART. One is caused by the selection and
 * fixed by ticking; the other fails with the whole folder mounted and ticking
 * cannot touch it. Putting them in one list would make the fixable one look
 * hopeless — and `hardware/cad/` carries 135 of the second kind today.
 */
test('an import that no selection could satisfy is reported separately from a deselection', () => {
  const lib = libOf({ 'a.scad': 'use <b.scad>;\nuse <nowhere.scad>;\ncube(1);', 'b.scad': 'x = 1;' });
  const needs = selectionNeeds(lib, importEdges(lib), ['a.scad']);
  assert.deepEqual(
    needs.missing.map((m) => m.path),
    ['b.scad'],
    'a file that IS in the folder belongs in missing',
  );
  assert.deepEqual(
    needs.unresolvable.map((e) => e.spec),
    ['nowhere.scad'],
    'a file that is NOT in the folder belongs in unresolvable',
  );
});

/* ════════════════════════════════════════════════════════════════════════════
   4. Narrowing — and the record it leaves behind
   ════════════════════════════════════════════════════════════════════════════ */

test('selecting narrows and never invents: the result is always a subset of what was read', () => {
  const lib = libOf(CHAIN);
  const out = selectLibrary(lib, new Set(['a.scad', 'not-in-the-folder.scad']));
  assert.deepEqual([...out.files.keys()], ['a.scad']);
  for (const [k, v] of out.files) assert.equal(v, lib.files.get(k));
});

test('selecting EVERYTHING changes nothing at all — the regression control', () => {
  const lib = libOf(CHAIN);
  const out = selectLibrary(lib, new Set(lib.files.keys()));
  assert.deepEqual([...out.files.entries()].sort(), [...lib.files.entries()].sort());
  assert.deepEqual(out.skipped, lib.skipped);
});

test('every dropped file lands in the skipped list, so the library never quietly holds half a folder', () => {
  const lib = libOf(CHAIN);
  const out = selectLibrary(lib, new Set(['a.scad']));
  assert.equal(out.files.size + out.skipped.length, lib.files.size);
  for (const s of out.skipped) assert.match(s.why, /you did not select it/);
});

/**
 * 🔴 PLANT TARGET 3. The panel that made the selection can warn while it is on
 * screen; the moment it closes, the only surviving record that the mount is
 * incomplete is the library itself.
 */
test('the mounted library remembers WHICH drop broke an import, and who needed it', () => {
  const lib = libOf(CHAIN);
  const keep = new Set(['a.scad', 'b.scad']);
  const out = selectLibrary(lib, keep, selectionNeeds(lib, importEdges(lib), keep));
  const broke = out.skipped.filter((s) => s.neededBy && s.neededBy.length > 0);
  assert.deepEqual(
    broke.map((s) => `${s.path} <= ${(s.neededBy ?? []).join(',')}`),
    ['sub/c.scad <= b.scad'],
  );
  assert.match(broke[0]?.why ?? '', /refused BY NAME/);
  const merely = out.skipped.filter((s) => !s.neededBy);
  assert.deepEqual(
    merely.map((s) => s.path),
    ['unrelated.scad'],
    'a file nothing imports is dropped quietly-but-listed, not flagged as a break',
  );
});

/**
 * ⚠ THE PANEL COUNTS DESELECTIONS OUT OF A LIST THAT ALSO HOLDS STLs, PATH
 * COLLISIONS AND UNREADABLE FILES, so it needs a predicate rather than a guess.
 * `wasDeselected` is exported for exactly that, and this asserts it recognises
 * BOTH reasons `selectLibrary` writes — the plain drop and the one that broke an
 * import. A predicate that knows only the plain form makes the panel's "and N
 * more you did not select" quietly undercount the dangerous ones.
 */
test('both deselection reasons are recognised by the exported predicate', () => {
  const lib = libOf(CHAIN);
  const keep = new Set(['a.scad', 'b.scad']);
  const out = selectLibrary(lib, keep, selectionNeeds(lib, importEdges(lib), keep));
  assert.equal(out.skipped.length, 2);
  assert.ok(out.skipped.every(wasDeselected), 'a deselection is not recognised as one');
  assert.ok(!wasDeselected({ why: 'not a .scad file' }));
  assert.ok(!wasDeselected({ why: 'it could not be read: NotFoundError' }));
});

/* ════════════════════════════════════════════════════════════════════════════
   5. Every bound says what it dropped
   ════════════════════════════════════════════════════════════════════════════ */

/**
 * 🔴 PLANT TARGET 6. The old entry read "this file and any after it were not
 * read" — true and unusable. A list that ends without a number reads as a list
 * that ended, and the operator cannot tell one dropped file from four hundred.
 */
test('the byte bound says how many files it did not read, and that the library is a PREFIX', async () => {
  const big = 'x'.repeat(Math.ceil(MAX_LIBRARY_BYTES / 3) + 1);
  const lib = await libraryFromFiles(
    files({ 'c/1.scad': big, 'c/2.scad': big, 'c/3.scad': big, 'c/4.scad': big, 'c/5.scad': big }),
  );
  const cut = lib.skipped.find((s) => /passed \d+ bytes/.test(s.why));
  assert.ok(cut, `no byte-bound entry in ${JSON.stringify(lib.skipped)}`);
  assert.match(cut.why, /file\(s\) were NOT read/);
  assert.match(cut.why, /PREFIX of the folder, not the folder/);
  const claimed = Number(/(\d+) file\(s\) were NOT read/.exec(cut.why)?.[1]);
  assert.equal(lib.files.size + claimed, 5, 'the numbers on screen do not add up to the folder');
});

test('too many files refuses the whole mount and says the count, rather than mounting a slice', async () => {
  const many: Record<string, string> = {};
  for (let i = 0; i < 2001; i++) many[`c/d${i % 7}/f${i}.scad`] = 'cube(1);';
  const lib = await libraryFromFiles(files(many));
  assert.equal(lib.files.size, 0);
  assert.equal(lib.skipped.length, 1);
  assert.match(lib.skipped[0]?.why ?? '', /2001 \.scad files is more than the 2000/);
  assert.match(lib.skipped[0]?.why ?? '', /Nothing was loaded/);
});

/* ════════════════════════════════════════════════════════════════════════════
   6. A file that cannot be read
   ════════════════════════════════════════════════════════════════════════════ */

/**
 * 🔴 ONE UNREADABLE FILE USED TO LOSE THE WHOLE MOUNT. `text()` rejecting threw
 * out of `libraryFromFiles`, the panel said only "the folder could not be read",
 * and the other 516 files went with it. The operator then cannot tell an empty
 * folder from an unread one — the same confusion this codebase already refuses
 * to ship in the saved-drawings list.
 */
test('a file that cannot be read is named and skipped; the rest of the folder still mounts', async () => {
  const picked = [
    new FakeFile('c/ok1.scad', 'cube(1);'),
    new FakeFile('c/gone.scad', '', 'NotFoundError: the file was moved'),
    new FakeFile('c/sub/ok2.scad', 'cube(2);'),
  ] as unknown as File[];
  const lib = await libraryFromFiles(picked);
  assert.deepEqual([...lib.files.keys()].sort(), ['c/ok1.scad', 'c/sub/ok2.scad']);
  const bad = lib.skipped.find((s) => s.path === 'c/gone.scad');
  assert.ok(bad, 'the unreadable file vanished without a word');
  assert.match(bad.why, /could not be read/);
  assert.match(bad.why, /the file was moved/);
});

/* ════════════════════════════════════════════════════════════════════════════
   7. THE REAL TREE — the founder's own workflow, end to end
   ════════════════════════════════════════════════════════════════════════════

   ⚠ THIS READS ANOTHER LANE'S FILES. `hardware/cad/` belongs to `cad`, and a
   rename there can turn this red. That is a real signal — the founder's
   assembly no longer parses in this tab — but it is not this lane's defect, and
   whoever sees it should read the miss list before changing anything here. The
   counts are asserted loosely for that reason; what is asserted EXACTLY is
   `0 misses`, and the internal invariant that the selector's closure is the same
   set the parser actually reads.
   ════════════════════════════════════════════════════════════════════════════ */

const HERE = dirname(fileURLToPath(import.meta.url));
const CAD_ROOT = join(HERE, '..', '..', '..', '..', 'hardware', 'cad');
const BROOD = '2bee_hive/2bee_hive_brood_assembly.scad';

function realTree(): Lib {
  const map = new Map<string, string>();
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (lstatSync(p).isSymbolicLink()) continue;
      if (e.isDirectory()) walk(p);
      else if (e.name.toLowerCase().endsWith('.scad')) map.set(relative(CAD_ROOT, p), readFileSync(p, 'utf8'));
    }
  };
  walk(CAD_ROOT);
  return { files: map, rootName: 'cad', pickedAt: 1, skipped: [] };
}

/**
 * The same tree, but handed in the shape a browser hands it — **every** file,
 * `.scad` or not, each carrying the `webkitRelativePath` a directory input would
 * set, and read through `libraryFromFiles`.
 *
 * 🔴 IT EXISTS BECAUSE `realTree()` SKIPS THE READER, and a plant proved that
 * matters: keying on `f.name` instead of the relative path reddened the small
 * fake-filesystem cases and left the founder's own 32-file assembly GREEN,
 * because a hand-built map cannot flatten. The case that matters most has to go
 * through the code that could break it.
 */
function realPick(): File[] {
  const out: File[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (lstatSync(p).isSymbolicLink()) continue;
      if (e.isDirectory()) walk(p);
      else {
        const body = e.name.toLowerCase().endsWith('.scad') ? readFileSync(p, 'utf8') : '';
        out.push(new FakeFile(`cad/${relative(CAD_ROOT, p)}`, body) as unknown as File);
      }
    }
  };
  walk(CAD_ROOT);
  return out;
}

const openIn = (lib: Lib, path: string) => {
  const src = lib.files.get(path);
  assert.ok(src, `${path} is not mounted`);
  const host = makeLibraryHost(lib);
  return { host, result: parseScad(src, { host, path }) };
};

test('the real brood assembly still reads its whole graph when EVERYTHING is selected', async () => {
  /* THE WHOLE PIPELINE: the browser's file list → `libraryFromFiles` → mount
   * everything → parse the founder's assembly. */
  const tree = await libraryFromFiles(realPick());
  assert.ok(tree.files.size > 100, `only ${tree.files.size} .scad files — is the folder right?`);
  assert.ok(
    tree.skipped.length > 0 && tree.skipped.every((s) => s.why === 'not a .scad file'),
    'the non-.scad files were not accounted for',
  );
  const mounted = selectLibrary(tree, new Set(tree.files.keys()));
  const { host, result } = openIn(mounted, `cad/${BROOD}`);
  assert.deepEqual(
    host.misses.map((m) => `${m.spec} (${m.why})`),
    [],
  );
  assert.ok(host.reads.length >= 20, `only ${host.reads.length} files read`);
  assert.ok(result.scene.children.length > 0, 'the assembly produced no scene node');
  assert.ok(
    host.reads.some((p) => !p.startsWith('cad/2bee_hive/')),
    'nothing outside the assembly’s own directory was read — the recursion is not doing anything',
  );
  /* And it read from more than one subdirectory, which is what "recursive"
   * bought: on 2026-08-11 the 32 reads spanned six of them. */
  assert.ok(
    new Set(host.reads.map((p) => p.slice(0, p.lastIndexOf('/')))).size >= 4,
    'the graph does not leave its own folder',
  );
});

/**
 * 🔴 THE INVARIANT THAT MAKES THE WARNING TRUSTWORTHY: the set the selector says
 * a file needs is EXACTLY the set the parser goes on to read. It holds because
 * the graph is built by the parser with resolution suppressed — same engine,
 * same comment handling, same error recovery — and it is asserted rather than
 * argued, on the largest real graph available.
 */
test('the selector’s closure is exactly the set the parser reads', () => {
  const tree = realTree();
  const needs = selectionNeeds(tree, importEdges(tree), [BROOD]);
  const { host } = openIn(tree, BROOD);
  const closure = new Set([...needs.needed].filter((p) => p !== BROOD));
  assert.deepEqual([...closure].sort(), [...host.reads].sort());
  assert.ok(closure.size >= 20, `the closure is only ${closure.size} — the graph is not deep`);
});

/**
 * 🔴 THE HAZARD, MEASURED ON THE FOUNDER'S OWN FILE, AND THIS IS WHY THE PANEL
 * WARNS BEFORE IT MOUNTS RATHER THAN AFTER.
 *
 * Untick ONE file the assembly needs — `2bee_hive_joinery.scad` — and the parse
 * is CLEAN: zero errors, a scene node on screen, a model that looks like a
 * model. **158 of its 237 primitives are gone.** The only trace is one entry in
 * a miss list nobody has a reason to open, because nothing looks wrong.
 *
 * ⚠ AND IT IS WORSE THAN "SOMETIMES". Sweeping all 32 dependencies one at a
 * time: 11 change the geometry or the error count, and **21 change nothing
 * measurable at all**. An operator cannot tell from the picture which kind they
 * just did — which is precisely why the selector must name it up front instead
 * of leaving it to be noticed.
 */
test('unticking one needed file is warned FIRST, and then silently removes most of the model', () => {
  const tree = realTree();
  const edges = importEdges(tree);
  const full = selectionNeeds(tree, edges, [BROOD]);
  const drop = '2bee_hive/2bee_hive_joinery.scad';
  assert.ok(full.needed.has(drop), `${drop} is no longer part of the assembly — pick another`);

  const keep = new Set([...full.needed].filter((p) => p !== drop));
  const needs = selectionNeeds(tree, edges, keep);

  // 1. NAMED, before anything is mounted.
  assert.deepEqual(
    needs.missing.map((m) => m.path),
    [drop],
  );
  assert.ok((needs.missing[0]?.neededBy ?? []).length > 0, 'named without saying who needs it');

  // 2. CARRIED, on the library the mount produces.
  const narrowed = selectLibrary(tree, keep, needs);
  assert.deepEqual(
    narrowed.skipped.filter((s) => s.neededBy?.length).map((s) => s.path),
    [drop],
  );

  // 3. And this is what it costs — clean, quiet, and mostly gone.
  const before = openIn(tree, BROOD);
  const after = openIn(narrowed, BROOD);
  assert.equal(after.result.errors.length, 0, 'if this errored, the loss would not be silent');
  assert.ok(after.result.scene.children.length > 0, 'if nothing drew, the loss would not be silent');
  assert.ok(
    after.result.counts.primitives < before.result.counts.primitives / 2,
    `expected most of the model to vanish, got ${after.result.counts.primitives} of ` +
      `${before.result.counts.primitives}`,
  );
  /* ⚠ TWO misses, not one, and the difference matters to the point being made:
   * `2bee_hive_joinery.scad` is imported by the assembly AND by the brood panel
   * it imports, so one untick produces one refusal per importer. Asserted as
   * "every miss names the file I unticked and nothing else" rather than as a
   * count, because the count is a fact about `cad`'s graph on one day and the
   * property is a fact about this code. */
  assert.ok(after.host.misses.length > 0, 'the loss left no trace at all');
  assert.deepEqual(
    [...new Set(after.host.misses.map((m) => m.spec.split('/').pop()))],
    ['2bee_hive_joinery.scad'],
    'something OTHER than the file I unticked stopped resolving',
  );
});

/* ════════════════════════════════════════════════════════════════════════════
   8. The panel — the half that outlives the dialog
   ════════════════════════════════════════════════════════════════════════════ */

const render = (library: unknown) =>
  renderToStaticMarkup(
    h(CadOpen, {
      onOpen: () => {},
      onClose: () => {},
      library,
      onLibrary: () => {},
      onOpenFile: () => {},
    } as never),
  );

test('a mounted library that is short of an import says so, and names the file and who needs it', () => {
  const html = render({
    files: new Map([['hive/assembly.scad', 'use <../lib/box.scad>;']]),
    rootName: 'cad',
    pickedAt: 1,
    skipped: [
      {
        path: 'lib/box.scad',
        why: 'you did not select it, and 1 file(s) you DID select import it — every one of those imports is refused BY NAME and the parts they define are NOT drawn.',
        neededBy: ['hive/assembly.scad'],
      },
    ],
  });
  assert.ok(html.includes('data-testid="cad-library-shortfall"'), 'the mount is short and the panel is silent');
  assert.match(html, /lib\/box\.scad/);
  assert.match(html, /hive\/assembly\.scad/);
  assert.match(html, /are NOT mounted/);
});

test('a complete mount carries no shortfall block — the warning is not decoration', () => {
  const html = render({
    files: new Map([['hive/assembly.scad', 'cube(1);']]),
    rootName: 'cad',
    pickedAt: 1,
    skipped: [{ path: 'notes.md', why: 'not a .scad file' }],
  });
  assert.ok(!html.includes('data-testid="cad-library-shortfall"'));
});

/**
 * 🔴 PLANT TARGET 5. The skipped list rendered `slice(0, 40)` and stopped. A
 * reader who scrolled to the end of 40 entries had nothing telling them 698 more
 * existed — one honest summary count and one list quietly disagreeing with it,
 * which is the exact shape of a silent truncation.
 */
test('a list longer than it prints says how many it did not print', () => {
  const skipped = Array.from({ length: 100 }, (_, i) => ({ path: `c/f${i}.stl`, why: 'not a .scad file' }));
  const html = render({ files: new Map(), rootName: 'cad', pickedAt: 1, skipped });
  assert.match(html, /100 file\(s\) in that folder were NOT loaded/);
  assert.match(html, /and <strong>60<\/strong> more not shown/);
});

test('the folder section still claims recursion in the words an operator reads', () => {
  const html = render({ files: new Map(), rootName: '', pickedAt: 0, skipped: [] });
  assert.match(html, /Every subdirectory under it is\s+read too/);
  assert.match(html, /stay two different files/);
  // And the two properties the merge established are still on screen.
  assert.match(html, /Mounting replaces nothing in the editor/);
  assert.match(html, /MINUS every part it imports/);
});
