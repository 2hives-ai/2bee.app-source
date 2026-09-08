// The favicon is a COPY of `brand/logo/2bee-farm-mark-full-color.svg`, and a copy
// in a second place is the defect this lane keeps finding. It is not prevented
// here — it is made DETECTABLE.
//
// 🔴 WHAT THIS TEST IS FOR. `brand` owns the mark. If they change it, our copy
// becomes a stale second version of a company asset, and nothing else in the tree
// would ever say so: a favicon that is one revision behind looks exactly like a
// favicon that is current. This test is the only reader that can tell.
//
// ⚠ WHAT IT COMPARES, AND WHY NOT THE BYTES. Our copy carries a provenance
// header the brand file does not, so a byte comparison would fail on the one
// difference that is deliberate. It compares the DRAWING ELEMENTS — every tag
// from `<svg` onward with comments and whitespace-only lines removed. That is the
// part that must not diverge; the header is the part that must.
//
// 🔴 IF THIS GOES RED, RE-COPY THE BRAND FILE. Do not edit the favicon to match
// the assertion, and do not edit the assertion. The brand file is the original
// and this one is downstream of it; making the copy agree by hand is how the two
// stop being the same drawing while continuing to look like it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(import.meta.dirname, '..', '..', '..', '..');
const BRAND = join(REPO, 'brand', 'logo', '2bee-farm-mark-full-color.svg');
const OURS = join(import.meta.dirname, '..', 'public', 'favicon.svg');

/** Drawing elements only: from `<svg` on, comments and blank lines dropped. */
function drawing(src: string): string {
  const from = src.indexOf('<svg');
  assert.ok(from >= 0, 'no <svg> element found — this is not an SVG');
  return src
    .slice(from)
    .replace(/<!--[\s\S]*?-->/g, '')
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== '')
    .join('\n');
}

test('the favicon exists and is wired into the page', () => {
  assert.ok(existsSync(OURS), 'web/public/favicon.svg is missing');
  const html = readFileSync(join(import.meta.dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /rel="icon"/, 'index.html declares no icon');
  assert.match(html, /favicon\.svg/, 'index.html does not point at favicon.svg');
});

test('the favicon still matches the brand mark it was copied from', (t) => {
  if (!existsSync(BRAND)) {
    // 🔴 NOT A PASS. `brand/` is another lane's directory and may legitimately be
    // absent from a partial checkout. Saying so is the honest answer; returning
    // green here would make "the brand file is gone" indistinguishable from "the
    // copy is current", which is the whole thing this test exists to separate.
    t.skip(`brand source not present at ${BRAND} — comparison NOT performed`);
    return;
  }
  const theirs = drawing(readFileSync(BRAND, 'utf8'));
  const ours = drawing(readFileSync(OURS, 'utf8'));
  assert.equal(
    ours,
    theirs,
    'the favicon has diverged from brand/logo/2bee-farm-mark-full-color.svg. ' +
      'Re-copy the brand file — do not edit either side to agree.'
  );
});

test('our copy carries its provenance, so the next reader knows it is downstream', () => {
  const src = readFileSync(OURS, 'utf8');
  const header = src.slice(0, src.indexOf('<svg'));
  assert.match(header, /A COPY, NOT AN ORIGINAL/, 'the provenance header is gone');
  assert.match(header, /2bee-farm-mark-full-color\.svg/, 'the header does not name its source');
  // The negative control for the test above: if the header were ever removed, the
  // drawing comparison would still pass and this file would look like an original.
});

/* ===========================================================================
 * THE HEADER MARK — the same detectability, for the two copies the APP SURFACE
 * uses
 * ===========================================================================
 *
 * Founder 2026-08-11: *"add the logo to this row"* (the 2bee.cad / 2bee.cnc /
 * Run tab row). The mark rendered there is `.mark` in `styles.css`, driven by
 * `--brand-mark`, and it resolves to one of TWO copies under `web/src/assets/`.
 *
 * 🔴 THEY ARE A DIFFERENT SURFACE FROM THE FAVICON AND A DIFFERENT BRAND RULE.
 * The favicon is the full-colour mark; brand's style guide §2.2 BANS the
 * full-colour gradient on light backgrounds — *"the amber gradient disappears
 * against white and pale surfaces"* — so an app surface takes the mono-black
 * mark on light and the reversed-white mark on dark. Do not "fix" the favicon to
 * match this rule and do not fix these to match the favicon: three copies, two
 * rules, and the rule follows the surface.
 *
 * ⚠ WHY THIS MATTERS MORE NOW THAN IT DID YESTERDAY. The theme toggle moved into
 * the same row as the mark, so the two variants are ONE CLICK APART. A wrong or
 * stale variant used to need a preference change to notice; now it is a button.
 */

const HEADER_MARKS: Array<{ ours: string; brand: string; cssVarFor: 'light' | 'dark' }> = [
  {
    ours: '2bee-farm-mark-mono-black.svg',
    brand: '2bee-farm-mark-mono-black.svg',
    cssVarFor: 'light',
  },
  {
    ours: '2bee-farm-mark-reversed-white.svg',
    brand: '2bee-farm-mark-reversed-white.svg',
    cssVarFor: 'dark',
  },
];

for (const m of HEADER_MARKS) {
  test(`the header mark ${m.ours} still matches the brand file it was copied from`, (t) => {
    const theirs = join(REPO, 'brand', 'brand-kit', 'logos', m.brand);
    const ours = join(import.meta.dirname, '..', 'src', 'assets', m.ours);
    assert.ok(existsSync(ours), `web/src/assets/${m.ours} is missing — the tab row has no mark`);
    if (!existsSync(theirs)) {
      /* Same reasoning as the favicon's skip: absent-source and current-copy must
       * not render as the same green. */
      t.skip(`brand source not present at ${theirs} — comparison NOT performed`);
      return;
    }
    assert.equal(
      drawing(readFileSync(ours, 'utf8')),
      drawing(readFileSync(theirs, 'utf8')),
      `${m.ours} has diverged from brand/brand-kit/logos/${m.brand}. ` +
        'Re-copy the brand file — do not edit either side to agree.'
    );
  });

  test(`${m.ours} says it is a copy and names its source`, () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'src', 'assets', m.ours), 'utf8');
    const header = src.slice(0, src.indexOf('<svg'));
    assert.match(header, /THIS IS A COPY/, 'the provenance header is gone');
    assert.match(header, new RegExp(m.brand.replace(/\./g, '\\.')), 'the header does not name its source');
    /* The negative control for the comparison above: strip the header and the
     * drawing check still passes while the file reads as an original. */
  });
}

test("brand's light/dark rule is what the stylesheet actually wires", () => {
  /* 🔴 ASSERTED AT THE STYLESHEET, NOT IN A COMMENT. The rule brand gave is a
   * mapping — mono-black on light, reversed-white on dark — and a mapping stated
   * only in prose is a rule nothing can check. The full-colour mark must not
   * appear in this file at all: that is the banned case (§2.2), and it is the one
   * an editor would reach for because it is the prettiest of the three. */
  const css = readFileSync(join(import.meta.dirname, '..', 'src', 'styles.css'), 'utf8');
  const light = css.match(/\[data-theme='light'\][^}]*--brand-mark:\s*url\('([^']+)'\)/);
  const dark = css.match(/\[data-theme='dark'\][^}]*--brand-mark:\s*url\('([^']+)'\)/);
  assert.ok(light, 'no light-theme --brand-mark rule');
  assert.ok(dark, 'no dark-theme --brand-mark rule');
  assert.match(light![1], /mono-black\.svg$/, 'the light theme is not using the mono-black mark');
  assert.match(dark![1], /reversed-white\.svg$/, 'the dark theme is not using the reversed-white mark');
  assert.ok(
    !/--brand-mark:\s*url\('[^']*full-color/.test(css),
    'the full-colour gradient mark is wired to an app surface — banned on light backgrounds (style guide §2.2)'
  );
});

test('the mark is in the tab row, and the dead product name is not in the header', () => {
  /* Structural only: this asserts the MARKUP, and nobody has looked at the page.
   * That the row LOOKS right — the mark aligned, the toggle at the far edge — is
   * a human's call and is not claimed here. */
  const app = readFileSync(join(import.meta.dirname, '..', 'src', 'App.tsx'), 'utf8');
  const row = app.slice(app.indexOf('<div className="tabrow">'), app.indexOf('<TabPanel id="cnc"'));
  assert.ok(row.includes('className="mark"'), 'the tab row carries no mark');
  assert.ok(row.includes('data-testid="theme-toggle"'), 'the theme toggle is not in the tab row');
  assert.ok(row.includes('<TabBar'), 'the tab row does not hold the tab bar');

  /* 🔴 THE PRODUCT NAME. `2bee.slicer` was renamed on 2026-08-09 and this header
   * kept shipping it. Comments may still discuss the old name — that is how the
   * correction stays legible — so this looks at RENDERED TEXT: the header's own
   * <strong>. */
  const header = app.slice(app.indexOf('<header className="topbar">'), app.indexOf('<div className="topright">'));
  assert.ok(header.includes('<strong>2bee.app</strong>'), 'the header does not name the product 2bee.app');
  assert.ok(!/<strong>2bee\.slicer<\/strong>/.test(app), 'the dead product name is still rendered');
  assert.ok(!/CNC CAM · grblHAL/.test(app.replace(/\/\*[\s\S]*?\*\//g, '')), 'the stale strapline is still rendered');
});
