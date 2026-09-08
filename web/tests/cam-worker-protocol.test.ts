// EVERY NAME `cam.ts` FORWARDS MUST BE A REAL EXPORT OF THE CAM CORE.
//
// ═══════════════════════════════════════════════════════════════════════════
// THE SEAM THIS FILE EXISTS FOR
// ═══════════════════════════════════════════════════════════════════════════
//
// The CAM core moved off the main thread on 2026-08-29 (TODO #144): `cam.ts`
// now posts `{ fn, args }` to `cam.worker.ts`, which looks the name up on the
// wasm module and calls it. That trade is worth making — the canvas no longer
// freezes while a drawing is planned — and it costs one thing that the previous
// design did not have:
//
// 🔴 THE CALL IS BY STRING NOW. `m.plan_import_bytes(...)` was a property access
// the compiler checked; `call('plan_import_bytes', [...])` is a name in quotes
// that nothing checks. Rename an export in the Rust `#[wasm_bindgen]` surface,
// or typo one here, and the failure is a `TypeError` raised INSIDE A WORKER —
// which reaches the page as a rejected promise with no subject, in a build that
// compiles, typechecks and starts.
//
// The worker itself refuses by name rather than letting that happen ("the CAM
// core has no export named X"), but that is a runtime message on a path someone
// has to walk. This is the check that runs first.
//
// ⚠ WHAT IT DOES NOT DO, stated rather than implied. It compares NAMES, not
// signatures: it cannot tell you the argument order is right, or that a `plan`
// taking five arguments is being called with five. Gate `I1` drives the real
// browser and is what proves the calls actually work; this makes the cheap half
// of that failure impossible without a browser.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CAM = readFileSync(join(WEB, 'src', 'cam.ts'), 'utf8');
const GLUE = readFileSync(join(WEB, 'src', 'wasm', 'twobee_cam_wasm.js'), 'utf8');

/** The names `cam.ts` forwards, from its own source. */
function forwarded(): string[] {
  return [...CAM.matchAll(/\bcallJson<[^>]*>\(\s*'([a-z_]+)'|\bcallJson\(\s*'([a-z_]+)'|\bcall\(\s*'([a-z_]+)'/g)]
    .map((m) => m[1] ?? m[2] ?? m[3])
    .filter((n): n is string => Boolean(n));
}

/** The names the generated glue actually exports. */
function exported(): Set<string> {
  return new Set([...GLUE.matchAll(/^export function ([a-z_]+)\(/gm)].map((m) => m[1]));
}

test('every export cam.ts forwards to the worker exists in the wasm glue', () => {
  const used = [...new Set(forwarded())].sort();
  assert.ok(
    used.length > 0,
    'cam.ts forwards no core export at all. Either the worker protocol was removed — in which ' +
      'case TODO #144 has been undone and the canvas blocks again — or this scanner stopped ' +
      'matching. Both must fail here rather than pass over an empty set.',
  );

  const have = exported();
  const missing = used.filter((n) => !have.has(n));
  assert.deepEqual(
    missing,
    [],
    `cam.ts forwards ${missing.length} name(s) the CAM core does not export: ${missing.join(', ')}. ` +
      'The call is a STRING now, so nothing else catches this: the failure would be a TypeError ' +
      'raised inside a worker, reaching the page as a rejected promise with no subject, in a ' +
      'build that compiles and starts.',
  );
});

test('cam.ts calls the core ONLY through the worker', () => {
  // 🔴 The property this actually protects. A single direct `m.foo(...)` left
  // behind — or added back later for "just this one quick call" — puts the core
  // on the main thread again for that call, and the canvas freeze it causes is
  // intermittent and load-dependent, which is the hardest kind to attribute.
  const body = CAM.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
  const direct = [...body.matchAll(/\bm\.[a-z_]+\(/g)].map((m) => m[0]);
  assert.deepEqual(
    direct,
    [],
    `cam.ts calls the wasm module directly (${direct.join(', ')}). Every core call must go ` +
      'through the worker, or planning blocks the canvas for that call — the exact defect ' +
      'TODO #144 fixed, returning one function at a time.',
  );
});
