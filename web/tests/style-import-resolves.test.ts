// AN `@import` THAT 404s IS SILENT IN CSS — so something has to look.
//
// ═══════════════════════════════════════════════════════════════════════════
// THE DEFECT THIS FILE EXISTS FOR
// ═══════════════════════════════════════════════════════════════════════════
//
// `web/src/styles.css:8` is `@import '../../../../brand/tokens.css'` — four
// levels UP, out of `web/`, out of `software/2bee.app/`, into the monorepo's
// `brand/` tree, which a different session owns. That is deliberate and is the
// right call: brand owns the palette and `brand/tokens.css` forbids a per-app
// copy, because a copy is how two surfaces end up "both amber" in two different
// ambers.
//
// 🔴 The cost of the choice is that the app's ENTIRE palette hangs off a
// relative path into somebody else's directory, and **CSS fails silently**. A
// browser that cannot fetch an `@import` logs nothing an operator sees, defines
// none of the custom properties, and every `var(--brand-…)` falls back to its
// default or to nothing. The app renders — wrong colours, unreadable text,
// status colours gone — and no test that checks behaviour would notice, because
// nothing about behaviour changed.
//
// Two ways that happens without anyone touching this lane: brand moves or
// renames the file, or brand renames a token. Both are ordinary work in their
// tree.
//
// ⚠ WHAT THIS DOES NOT DO. It does not render anything, and it cannot tell you
// the colours are RIGHT — a token defined as the wrong value passes here. It
// checks that every import RESOLVES and that every custom property this file
// READS is DEFINED somewhere in the chain it imports. Two I1 browser tests
// check that the properties actually reach a live page; this one runs without a
// browser, so it goes red on `npm run test:node` and in gate CADT the moment
// the path or a name breaks.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STYLES = join(WEB, 'src', 'styles.css');

/**
 * A sheet with its comments removed.
 *
 * 🔴 NOT COSMETIC. The first run of this file reported `--sp-2` as undefined,
 * the line was rewritten to a literal — and it reported `--sp-2` again, out of
 * the COMMENT explaining why the token had been removed. A scanner that reads
 * the prose discussing what it scans for cannot be discharged: fixing the
 * defect leaves the finding standing, and the only ways out are to stop
 * explaining the fix or to stop believing the check.
 */
function decomment(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, ' ');
}

/** `@import '…'` / `@import "…"` targets, in source order. */
function importsOf(css: string): string[] {
  return [...decomment(css).matchAll(/@import\s+(?:url\()?['"]([^'"]+)['"]\)?/g)].map((m) => m[1]);
}

/** Custom properties DEFINED in a sheet: `--name:` at any nesting. */
function definedIn(css: string): Set<string> {
  return new Set([...decomment(css).matchAll(/(^|[;{\s])(--[a-zA-Z0-9-]+)\s*:/g)].map((m) => m[2]));
}

/** Custom properties READ by a sheet: `var(--name…)`. */
function readBy(css: string): Set<string> {
  return new Set([...decomment(css).matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/g)].map((m) => m[1]));
}

test('every @import in styles.css resolves on disk', () => {
  const css = readFileSync(STYLES, 'utf8');
  const targets = importsOf(css);
  assert.ok(
    targets.length > 0,
    'styles.css imports nothing. If the brand token import was removed, this app has a palette ' +
      'of its own again — which brand/tokens.css exists to prevent — and this test must be ' +
      'rewritten deliberately, not left passing over an empty list.',
  );
  for (const t of targets) {
    if (/^(https?:)?\/\//.test(t)) {
      assert.fail(
        `styles.css imports a REMOTE stylesheet (${t}). A network fetch in the critical render ` +
          'path fails silently and differently on every machine.',
      );
    }
    const abs = resolve(dirname(STYLES), t);
    assert.ok(
      existsSync(abs),
      `styles.css imports ${t}, which resolves to ${abs} and DOES NOT EXIST. In a browser this ` +
        'fails silently: no custom properties are defined, every colour falls back, and the app ' +
        'renders wrong with nothing in the console an operator reads.',
    );
  }
});

/** Every `.ts`/`.tsx` under `src/`, so a property SET FROM CODE is not reported. */
function srcFiles(dir = join(WEB, 'src'), out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) srcFiles(p, out);
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

test('every custom property styles.css reads is defined — in the import chain or from code', () => {
  const css = readFileSync(STYLES, 'utf8');
  const defined = definedIn(css);
  for (const t of importsOf(css)) {
    const abs = resolve(dirname(STYLES), t);
    if (!existsSync(abs)) continue; // named by the test above; not re-reported here
    for (const d of definedIn(readFileSync(abs, 'utf8'))) defined.add(d);
  }

  // A property set on an element from TypeScript is DEFINED — just not in a
  // sheet. `--report-w` is the live example: `App.tsx` writes it from the
  // remembered panel width and the CSS carries a fallback for first paint.
  // ⚠ This is the loosest limb here and it is loose ON PURPOSE: it accepts the
  // NAME appearing anywhere under `src/`, not that it is assigned on the right
  // element. What it still catches is the case this test was written for — a
  // `var(--x)` that NOTHING anywhere defines, whose fallback is therefore its
  // permanent value while the `var()` reads like a token that follows brand.
  const inCode = new Set<string>();
  const NAME = /(--[a-zA-Z0-9-]+)/g;
  for (const f of srcFiles()) {
    for (const m of readFileSync(f, 'utf8').matchAll(NAME)) inCode.add(m[1]);
  }

  const missing = [...readBy(css)].filter((v) => !defined.has(v) && !inCode.has(v)).sort();
  assert.deepEqual(
    missing,
    [],
    `styles.css reads ${missing.length} custom propert(ies) that NOTHING defines — not this ` +
      `sheet, not its import chain, and no TypeScript under src/: ${missing.join(', ')}. ` +
      'Two ways this happens and both are silent: brand renamed a token, or the name never ' +
      'existed. Either way the fallback is the permanent value while the `var()` reads like a ' +
      'token that follows brand. Found this way on 2026-08-28: `--sp-2`, against a brand sheet ' +
      'that has no spacing scale at all.',
  );
});
