// `src/wasm/` — which generated files are tracked, and the fact that decides it.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHY A TEST AND NOT JUST A `.gitignore` COMMENT
// ═══════════════════════════════════════════════════════════════════════════
//
// Two `.d.ts` files sat UNTRACKED in `src/wasm/` beside a TRACKED `.js` and a
// TRACKED `.wasm` — one directory, two rules, and nothing said which was
// intended. The ruling (2026-08-12) is: **the `.d.ts` are ignored**, and it
// rests on ONE fact about the build — `npm run wasm` passes `--no-typescript`,
// so those files are not part of what this project generates, and a tracked copy
// would survive every canonical rebuild of the module beside it while asserting
// a contract that module no longer has.
//
// 🔴 THAT FACT CAN BE DELETED BY A ONE-WORD EDIT TO `package.json`, and if it
// is, the `.gitignore` block goes on giving a reason that has stopped being
// true. A stale reason reads exactly like a live one. So the reason has a
// trigger, and this is it.
//
// ⚠ WHAT THIS DOES NOT CHECK, said rather than left to be assumed:
//   · That git is actually ignoring them. This reads the rule text, not the
//     index — asserting the effect would mean shelling out to `git
//     check-ignore` from a unit suite that otherwise touches no repository.
//   · That the tracked `.js` and `.wasm` are current. Nothing here rebuilds
//     wasm; `gates/slicer_gate_check.mjs` K3 is the browser-vs-CLI parity check
//     and it is the one that would catch a stale module.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const WEB = join(HERE, '..');
const APP = join(WEB, '..');

test('the wasm build still emits NO type declarations — the fact the ignore rule rests on', () => {
  const pkg = JSON.parse(readFileSync(join(WEB, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  const wasm = pkg.scripts.wasm;
  assert.ok(wasm, '`npm run wasm` is gone — the documented rebuild is now something else');
  assert.match(
    wasm,
    /--no-typescript/,
    'the wasm build now emits .d.ts files. The `.gitignore` block for ' +
      '`web/src/wasm/*.d.ts` argues from this flag — re-decide tracking, do not ' +
      'just re-run the build'
  );
});

test('and the ignore rule is still there, with the `.js`/`.wasm` pair left tracked', () => {
  const ignore = readFileSync(join(APP, '.gitignore'), 'utf8');
  assert.match(
    ignore,
    /^web\/src\/wasm\/\*\.d\.ts$/m,
    'the declarations are no longer ignored — one directory is back to two rules'
  );
  /* The other half of the asymmetry: nothing may quietly start ignoring the
   * RUNTIME artefact. A contributor with no Rust toolchain has to be able to run
   * the app, and that needs these two in the tree. */
  assert.doesNotMatch(ignore, /^web\/src\/wasm\/\*\.js$/m);
  assert.doesNotMatch(ignore, /^web\/src\/wasm\/.*\.wasm$/m);
});
