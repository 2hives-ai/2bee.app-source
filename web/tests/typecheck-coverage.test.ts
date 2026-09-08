// WHAT `tsc --noEmit` ACTUALLY LOOKS AT — asserted, because for an unknown
// period it looked at a third of the tree and said nothing.
//
// ═══════════════════════════════════════════════════════════════════════════
// THE DEFECT THIS FILE EXISTS FOR
// ═══════════════════════════════════════════════════════════════════════════
//
// `web/tsconfig.json` carried `"include": ["src"]`. Everything under `tests/`
// and `e2e/`, plus `vite.config.ts` and `playwright.config.ts`, was outside the
// compiler's program: 55 of the 95 TypeScript files that existed when this was
// found — MORE THAN HALF THE TREE. `tsc --noEmit` exited 0 without reading them,
// and `npm run build` (`tsc -b`, same config) did the same.
//
// Measured, not reasoned: restoring `"include": ["src"]` and re-running this
// file reports the list, and a type error planted in `tests/run-protocol.test.ts`
// exits 0 under the old config and 2 under the new one.
//
// 🔴 THE CLAIM WAS NEVER FALSE, WHICH IS WHY IT SURVIVED. "tsc --noEmit is
// clean" was true. It meant "src is clean", and roughly fifteen agents reported
// it in a single day alongside test files they had just written and believed
// they had just checked. The narrowing was found by accident: a runtime run
// caught a type error the compiler had waved through. Nothing else could have —
// a silent green looks exactly like a real one, and there is no diff to notice
// when a config was born narrow.
//
// ⚠ FIXING THE CONFIG IS NOT FIXING THE DEFECT. An `include` can be narrowed
// again by anyone, for a good local reason, and the next reader inherits the
// same true-but-smaller green with no signal that anything changed. So the
// control is not the config and it is not the comment at the top of the config:
// it is this test, which asks the COMPILER which files are in its program and
// compares that to the files on disk.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHAT IT ASSERTS, AND WHAT IT DOES NOT
// ═══════════════════════════════════════════════════════════════════════════
//
//   · that every `.ts`/`.tsx` file in `web/` (bar `node_modules`, `dist` and
//     build scratch) is in `tsconfig.json`'s program — the config both
//     `tsc --noEmit` and `npm run typecheck` read;
//   · that the comparison can FAIL — a negative control feeds it a program with
//     one file removed and requires that file to be named;
//   · that `tsconfig.browser.json` covers `src` and ONLY `src`, so its green
//     cannot be quoted as a whole-project green;
//   · that every `tsc` invocation in `package.json` names a config from a
//     two-entry allowlist, and that `build` routes through `typecheck`.
//
// 🔴 NOT ASSERTED, stated rather than implied:
//   · that the project TYPECHECKS. This file asks which files tsc reads, not
//     whether they are clean — deliberately, so a real type error in `src`
//     produces one red (the typecheck) and not two. `npm run typecheck` is the
//     check for clean; this is the check that it is looking at the right files.
//   · `.mjs`/`.js` files. `allowJs` puts them in the program but `checkJs` is
//     off, so they are read and not checked; counting them here would assert a
//     coverage that does not exist. `tests/*.mjs` (the loader, the fixtures) are
//     the files this exempts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TSC = join(WEB, 'node_modules', 'typescript', 'bin', 'tsc');

/** Directories that hold no source we compile: dependencies and build output. */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'test-results', 'playwright-report', '.git']);

/**
 * Every `.ts`/`.tsx` file in the tree, as a repo-relative POSIX path.
 *
 * ⚠ THE WIDEST NEEDLE ON PURPOSE. It walks the whole of `web/` rather than the
 * three directories the config happens to name today, so a new directory that
 * nobody adds to `include` goes red on its first file — which is the same
 * defect as the original narrowing, arriving from the other direction.
 */
function filesOnDisk(dir = WEB, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      filesOnDisk(join(dir, entry.name), out);
    } else if (entry.isFile() && /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      out.push(relative(WEB, join(dir, entry.name)).split(sep).join('/'));
    }
  }
  return out.sort();
}

/**
 * The files TypeScript actually puts in the program for a config.
 *
 * `--listFilesOnly` builds the program and prints its file list WITHOUT
 * typechecking, so this stays independent of whether the project is currently
 * clean — a genuine type error must produce one red, not two. `execFileSync`
 * throws on a non-zero exit, so a tsc that cannot run is a failure here and not
 * an empty list that reads as "nothing to cover".
 */
function programFiles(config: string): string[] {
  const stdout = execFileSync(process.execPath, [TSC, '-p', config, '--listFilesOnly'], {
    cwd: WEB,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  const files = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => resolve(WEB, l))
    .filter((p) => p.startsWith(WEB + sep) && !p.includes(`${sep}node_modules${sep}`))
    .map((p) => relative(WEB, p).split(sep).join('/'))
    .sort();
  assert.ok(
    files.length > 0,
    `${config}: tsc listed no project files at all — the comparison below would be meaningless`
  );
  return files;
}

/** Disk files the program does not contain. The whole comparison, in one place
 *  so the negative control below can exercise the same code the assertion uses. */
function uncovered(disk: readonly string[], program: readonly string[]): string[] {
  const seen = new Set(program);
  return disk.filter((f) => !seen.has(f));
}

// ---------------------------------------------------------------------------
// The assertion
// ---------------------------------------------------------------------------

test('every TypeScript file in web/ is in `tsconfig.json`’s program', () => {
  const disk = filesOnDisk();
  const program = programFiles('tsconfig.json');

  /* Look for the thing only a real run produces: this very file. If the walk or
   * the tsc call silently returned something unrelated, this fails before the
   * comparison can report a reassuring empty list. */
  assert.ok(
    disk.includes('tests/typecheck-coverage.test.ts'),
    'the disk walk did not find this file — it is not measuring this tree'
  );

  const missing = uncovered(disk, program);
  assert.deepEqual(
    missing,
    [],
    `${missing.length} of ${disk.length} TypeScript files are NOT typechecked. ` +
      `\`tsc --noEmit\` will exit 0 without reading them, and so will \`npm run build\`. ` +
      `Widen \`include\` in web/tsconfig.json to cover: ${JSON.stringify(missing)}`
  );
});

test('\u{1F534} NEGATIVE CONTROL — a file left out of the program is NAMED', () => {
  const disk = filesOnDisk();
  const program = programFiles('tsconfig.json');

  /* The exact shape of the original defect, simulated without editing the
   * config: a program that covers everything except one test file. If this
   * comes back empty the assertion above is vacuous and its green means
   * nothing — which is precisely the state this whole file exists to end. */
  const dropped = 'tests/run.test.ts';
  assert.ok(disk.includes(dropped), `the control needs ${dropped} to exist`);
  const narrowed = program.filter((f) => f !== dropped);
  assert.deepEqual(uncovered(disk, narrowed), [dropped]);
});

// ---------------------------------------------------------------------------
// The second leg, and the limits of its green
// ---------------------------------------------------------------------------

test('`tsconfig.browser.json` covers src and ONLY src', () => {
  const program = programFiles('tsconfig.browser.json');
  const disk = filesOnDisk();

  const srcOnDisk = disk.filter((f) => f.startsWith('src/'));
  assert.deepEqual(
    uncovered(srcOnDisk, program),
    [],
    'the browser-purity leg does not see all of src, so `process` could reach the app unremarked'
  );

  /* And the other direction, so nobody quotes this leg as a project-wide green:
   * it must NOT contain the tests, whose whole point is that they use Node. */
  const strays = program.filter((f) => f.startsWith('tests/') || f.startsWith('e2e/'));
  assert.deepEqual(strays, [], 'the browser leg has grown past src; its `types: []` would now be wrong');
});

// ---------------------------------------------------------------------------
// What the scripts actually run
// ---------------------------------------------------------------------------

test('every `tsc` in package.json names a config on the allowlist, and build routes through typecheck', () => {
  const pkg = JSON.parse(readFileSync(join(WEB, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  const ALLOWED = new Set(['tsconfig.json', 'tsconfig.browser.json']);

  /* ⚠ A TEXT GUARD, AND LABELLED AS ONE. It proves the scripts still name the
   * configs the tests above measured; it cannot prove the scripts were run. Its
   * value is that adding a third, narrower config — or swapping `typecheck` out
   * of `build` — cannot happen silently, which is how `tsc -b` came to be quoted
   * as evidence that the tests were checked. */
  const invocations = Object.entries(pkg.scripts).flatMap(([name, body]) =>
    body
      .split('&&')
      .map((part) => part.trim())
      .filter((part) => /^tsc(\s|$)/.test(part))
      .map((part) => ({ name, part }))
  );

  assert.ok(invocations.length > 0, 'no `tsc` invocation in package.json at all');

  for (const { name, part } of invocations) {
    const project = /(?:^|\s)-p\s+(\S+)/.exec(part)?.[1];
    assert.ok(
      project !== undefined,
      `scripts.${name} runs \`${part}\` with no -p: which config it reads depends on the ` +
        `working directory, and a bare \`tsc\` was how the narrow config went unnoticed`
    );
    assert.ok(
      ALLOWED.has(project),
      `scripts.${name} typechecks against ${project}, which no test above measures — ` +
        `add it to the coverage assertions or use one of ${JSON.stringify([...ALLOWED])}`
    );
  }

  const typecheck = pkg.scripts.typecheck ?? '';
  for (const cfg of ALLOWED) {
    assert.ok(
      typecheck.includes(`-p ${cfg}`),
      `\`npm run typecheck\` does not run ${cfg}, so one leg of the check ships unrun`
    );
  }
  assert.match(
    pkg.scripts.build ?? '',
    /npm run typecheck/,
    'build no longer typechecks through the same path, so "the build passed" would mean something else again'
  );
});
