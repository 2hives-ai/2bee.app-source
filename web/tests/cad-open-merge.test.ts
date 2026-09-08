// One `Open…`, two sources — `web/src/cad/open.tsx` after the 2026-08-11 merge.
//
// Founder: *"merge the Open … and Open library folder … — have just 1 open!"*.
//
// WHAT THIS FILE EXERCISES
//
//   · 🔴 THAT THE FOLDER MOUNT SURVIVED THE MERGE, AND THAT IT MATTERS. The
//     cheap way to satisfy "just 1 open" is to delete the second item and its
//     panel. `open.tsx` reads the browser store and has NO file input, so that
//     would have left no route from disk into this tab at all — and the founder's
//     own assemblies import by path. The end-to-end case below is the evidence:
//     with the folder mounted and the file's own path known, the brood assembly
//     reads 32 files and produces a scene; with the path lost it reads NONE and
//     produces NOTHING, silently.
//   · 🔴 THAT BOTH HALVES ARE IN ONE PANEL AND STILL SAY WHICH ONE DESTROYS. The
//     two menu items differed in what they destroy — opening replaces the
//     operator's source, mounting replaces nothing — and a merged panel whose two
//     halves look alike is the same trap one level down.
//   · 🔴 THAT `selfPath` IS STILL WIRED. It is the one piece of state the folder
//     route carries that the saved-model route does not, and losing it in a
//     refactor is invisible: the panel still works, the folder still mounts, and
//     every `../` import silently stops resolving.
//
// ⚠ THIS SUITE READS ANOTHER LANE'S FILES. `hardware/cad/` belongs to `cad`, and
// a rename there can turn this red. That is a real signal — it means the
// founder's assembly no longer parses in this tab — but it is not this lane's
// defect, and whoever sees it should read the miss list before changing anything
// here. The previous agent recorded the same measurement and deliberately did
// NOT commit it, for exactly this reason; it is committed now because the merge
// is precisely the change that could break the wiring silently, and a measurement
// taken once is not a control.
//
// ⚠ NOT EXERCISED: no effect runs. `renderToStaticMarkup` runs no effects, so
// the saved-drawings list is empty in every render here and nothing is clicked.
// What is asserted about the panel is what it renders before any I/O — which is
// exactly where the two sections and their warnings live.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const HERE = dirname(fileURLToPath(import.meta.url));
const source = (...parts: string[]) => readFileSync(join(HERE, '..', 'src', ...parts), 'utf8');

const { makeLibraryHost } = await import('../src/cad/library.ts');
const { parseScad } = await import('../src/cad/scad.ts');
const { CadOpen, MOUNT_A_FOLDER } = await import('../src/cad/open.tsx');

/* ════════════════════════════════════════════════════════════════════════════
   1. The real graph, end to end
   ════════════════════════════════════════════════════════════════════════════ */

/** `web/tests` → `web` → `2bee.app` → `software` → repo root. */
const CAD_ROOT = join(HERE, '..', '..', '..', '..', 'hardware', 'cad');

function realLibrary() {
  const files = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (entry.toLowerCase().endsWith('.scad')) files.set(relative(CAD_ROOT, p), readFileSync(p, 'utf8'));
    }
  };
  walk(CAD_ROOT);
  return { files, rootName: 'cad', pickedAt: 1, skipped: [] as { path: string; why: string }[] };
}

/** One parse through exactly the host the tab builds, with exactly its inputs. */
function openAssembly(path: string, selfPath: string) {
  const lib = realLibrary();
  const src = lib.files.get(path);
  assert.ok(src, `${path} is not in hardware/cad — see this file's cross-lane note`);
  const host = makeLibraryHost(lib);
  const result = parseScad(src, { host, path: selfPath });
  return { host, result, files: lib.files.size };
}

/**
 * ⚠ THE ASSERTIONS ARE DELIBERATELY LOOSE ON THE COUNTS AND EXACT ON THE
 * MISSES. `cad` may add or remove a part; they may not leave the founder's own
 * assembly unable to resolve its own imports. Measured 2026-08-11: 517 `.scad`
 * files in the tree, 32 read transitively by the brood assembly, 0 misses.
 */
test('the real brood assembly resolves its whole import graph, from a mounted folder', () => {
  const { host, result, files } = openAssembly(
    '2bee_hive/2bee_hive_brood_assembly.scad',
    '2bee_hive/2bee_hive_brood_assembly.scad',
  );
  assert.ok(files > 100, `only ${files} .scad files found — is the folder right?`);
  assert.deepEqual(
    host.misses.map((m) => `${m.spec} (${m.why})`),
    [],
  );
  assert.ok(host.reads.length >= 20, `only ${host.reads.length} files read`);
  assert.ok(result.scene.children.length > 0, 'the assembly produced no scene node');
  // Transitive: the assembly's own imports import further files.
  assert.ok(
    host.reads.some((p) => !p.startsWith('2bee_hive/')),
    'nothing outside the assembly’s own directory was read — the graph is not deep',
  );
});

test('and so does the solar box assembly, whose imports climb out of their own directory', () => {
  const { host, result } = openAssembly(
    '2bee_solar_box/solar_box_assembly.scad',
    '2bee_solar_box/solar_box_assembly.scad',
  );
  assert.deepEqual(
    host.misses.map((m) => `${m.spec} (${m.why})`),
    [],
  );
  assert.ok(host.reads.length > 0);
  assert.equal(result.errors.length, 0);
});

/**
 * 🔴 THE CONTROL, AND IT IS THE WHOLE ARGUMENT FOR KEEPING THE MOUNT.
 *
 * Same folder, same file, `selfPath` lost — which is what a refactor that
 * forgets to thread the path through the merged panel produces. The result is
 * not an error dialog: the brood assembly reads ZERO files and produces ZERO
 * scene nodes, and the solar box produces a scene with parts missing. An
 * operator sees an empty viewport or a plausible partial model, and the only
 * statement of what happened is a refusal list they have to go and read.
 *
 * ⚠ The `escapes-the-folder` miss in the solar box case is the same defect
 * wearing a different label: with no directory to be relative TO, `../` climbs
 * out of the root.
 */
test('losing the file’s own path does not error — it silently produces less, or nothing', () => {
  const brood = openAssembly('2bee_hive/2bee_hive_brood_assembly.scad', '');
  assert.equal(brood.host.reads.length, 0);
  assert.ok(brood.host.misses.length > 0);
  assert.equal(brood.result.scene.children.length, 0, 'this is the silent case: nothing drawn');

  const solar = openAssembly('2bee_solar_box/solar_box_assembly.scad', '');
  assert.ok(solar.host.misses.some((m) => m.why === 'escapes-the-folder'));
  assert.ok(solar.host.reads.length === 0);
});

/**
 * 🔴 SO THE TAB MUST STILL SET IT, AND THIS IS WHERE THE MERGE COULD HAVE LOST
 * IT. A source-shape assertion, named as the weaker thing it is: the merged
 * panel's file callback is wired to `setSelfPath` in `CadTab.tsx`, and no other
 * caller sets it.
 */
test('the merged panel’s file route still carries the path into the parse', () => {
  const tab = source('cad', 'CadTab.tsx');
  assert.match(tab, /onOpenFile=\{\(path, source\) => \{[\s\S]{0,400}?setSelfPath\(path\)/);
  assert.match(tab, /parseScad\(src, \{ host, path: selfPath \}\)/);
});

/* ════════════════════════════════════════════════════════════════════════════
   2. One panel, two sections, and only one of them destroys
   ════════════════════════════════════════════════════════════════════════════ */

const EMPTY_LIB = { files: new Map<string, string>(), rootName: '', pickedAt: 0, skipped: [] };

const renderPanel = (library: unknown = EMPTY_LIB) =>
  renderToStaticMarkup(
    h(CadOpen, {
      onOpen: () => {},
      onClose: () => {},
      library,
      onLibrary: () => {},
      onOpenFile: () => {},
    } as never),
  );

test('the one panel carries BOTH sources — the folder input and the saved list', () => {
  const html = renderPanel();
  assert.ok(html.includes('data-testid="cad-library"'), 'the folder mount is gone');
  assert.ok(html.includes('data-testid="cad-library-input"'), 'there is no way to pick a folder');
  assert.ok(html.includes('data-testid="cad-open-picker"'), 'the saved-model list is gone');
});

/**
 * 🔴 THE DISTINCTION THE TWO MENU ITEMS USED TO CARRY. It cannot be a label any
 * more, so it has to be text at each control — and this is the assertion that
 * would go red if a later tidy-up flattened the two sections into one list.
 */
test('the folder half says it replaces nothing and the saved half says it replaces the editor', () => {
  const html = renderPanel();
  assert.match(html, /Mounting replaces nothing in the editor/);
  assert.match(html, /Opening one REPLACES\s+what is in the editor/);
});

/** The enabling step is above the destructive one — reading order is a control. */
test('the folder section comes first', () => {
  const html = renderPanel();
  assert.ok(html.indexOf('cad-library-input') < html.indexOf('cad-open-picker'));
});

/**
 * ⚠ THE SILENT FAILURE IS NAMED WHERE SOMEBODY WOULD BE ABOUT TO CAUSE IT. An
 * assembly opened with no folder mounted draws minus every subtree it imports
 * and still looks like a model — see the end-to-end control above. That sentence
 * belongs on the mount, not in a commit message.
 */
test('the panel states what happens to an assembly opened with no folder mounted', () => {
  assert.match(renderPanel(), /MINUS every part it imports/);
});

/** And the refusal an operator actually meets points back at this panel. */
test('the unresolved-import sentence points at the control that fixes it', () => {
  assert.match(MOUNT_A_FOLDER, /Open/);
  assert.match(MOUNT_A_FOLDER, /Mount a folder/);
  assert.ok(renderPanel().includes('Mount a folder of .scad files'));
});
