// THE COLLET LIST IS IN TWO FILES, AND ONLY ONE OF THEM REACHES THE MACHINE.
//
// ═══════════════════════════════════════════════════════════════════════════
// THE DEFECT THIS FILE EXISTS FOR
// ═══════════════════════════════════════════════════════════════════════════
//
// `web/src/App.tsx` carries `const SPARE_COLLETS_MM = [3.175, 6.35, 8.0]` under
// a comment that says it "mirrors the core's reference machine". The core's
// value is `spare_collets_mm: vec![3.175, 6.35, 8.0]` in
// `core/src/fixtures.rs::machine()`. **The mirror was a comment and nothing
// else** — the two lists could diverge in either direction with nothing to say
// so, and the app beside them would keep looking correct.
//
// 🔴 WHAT DIVERGENCE COSTS, in the direction that matters. The list decides
// which tools the browser offers as SELECTABLE and which collet it tells the
// operator to fit. If the browser's list is WIDER than the core's, the app
// offers a cutter whose shank the declared machine cannot hold, and the "fit
// the 3.175mm collet" note names a collet the shop does not own — a shank in
// the wrong collet does not grip and is thrown. If it is NARROWER, a tool the
// machine can actually hold is refused and the operator is told to buy
// something they already have. The first is the one with a spindle in it.
//
// ⚠ THIS IS A TEXT-COUPLING CHECK AND SAYS SO. It reads the Rust source rather
// than asking the wasm, for the same reason `BRND` hashes brand's master rather
// than rendering it: the point is to go red when somebody edits ONE of the two
// files, and that has to work without a build. It cannot tell you the core is
// RIGHT — only that the browser has not quietly stopped agreeing with it.
//
// If the core stops declaring the list as a literal, this test fails loudly
// rather than silently passing over a regex that stopped matching. An absence
// here is a finding, not a pass.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = resolve(WEB, '..');

/** Every number in a `[a, b, c]` / `vec![a, b, c]` literal, in order. */
function numbers(literal: string): number[] {
  return [...literal.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
}

test('the browser and the core declare the SAME spare collets', () => {
  const app = readFileSync(join(WEB, 'src', 'App.tsx'), 'utf8');
  const core = readFileSync(join(ROOT, 'core', 'src', 'fixtures.rs'), 'utf8');

  const appM = /const SPARE_COLLETS_MM\s*=\s*(\[[^\]]*\])/.exec(app);
  assert.ok(
    appM,
    'no `const SPARE_COLLETS_MM = [...]` in web/src/App.tsx — the constant this test compares is ' +
      'gone or has been reshaped. That is a finding: it must not read as agreement.',
  );

  const coreM = /spare_collets_mm:\s*vec!(\[[^\]]*\])/.exec(core);
  assert.ok(
    coreM,
    'no `spare_collets_mm: vec![...]` literal in core/src/fixtures.rs — the core value this test ' +
      'compares is gone or is now computed. A regex that stopped matching must not pass.',
  );

  const inApp = numbers(appM![1]);
  const inCore = numbers(coreM![1]);
  assert.ok(inApp.length > 0, 'the browser list parsed as empty');
  assert.deepEqual(
    inApp,
    inCore,
    `the browser offers spare collets [${inApp.join(', ')}] and the core's reference machine ` +
      `declares [${inCore.join(', ')}]. A browser list WIDER than the core's offers a cutter the ` +
      'declared machine cannot hold and names a collet the shop does not own; NARROWER refuses a ' +
      'tool the machine can hold. Change both files or make one read the other.',
  );
});
