// The home page (founder 2026-10-16), held to the lane's claim rules.
//
// 🔴 WHAT THIS CANNOT SEE: there is no browser here. The click on the header name,
// the CTA and Back are watched in `e2e/home.spec.ts`; this file checks the markup
// and the words.
//
// ⚠ `createElement` rather than JSX: `npm run test:node` globs `tests/*.test.ts`,
// and a `.tsx` here would not be collected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Home from '../src/home/Home.tsx';
import { parseTab } from '../src/Tabs.tsx';

const here = dirname(fileURLToPath(import.meta.url));
const noop = () => {};
const html = renderToStaticMarkup(h(Home, { onPickDesign: noop, onExpert: noop, onBack: noop }));
const text = html.replace(/<[^>]*>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, ' ');

test('home is a view id that a stored value or a link can reach', () => {
  assert.equal(parseTab('home'), 'home');
});

test('the home page carries both calls to action and the preview line', () => {
  assert.match(html, /data-testid="home-pick"[^>]*>Pick a design</);
  assert.match(html, /data-testid="home-expert"[^>]*>Open the expert tools</);
  assert.match(text, /Nothing made with it has been cut, printed or placed yet\./);
});

test('the header name opens home, and home renders only on its own view', () => {
  const app = readFileSync(join(here, '..', 'src', 'App.tsx'), 'utf8');
  assert.match(app, /data-testid="brand-home"[^\n]*setTab\('home'\)/);
  assert.match(app, /tab === 'home' \? <Home onPickDesign=\{\(\) => setTab\('make'\)\}/);
});

test('no claim the records cannot carry, and no source URL of its own', () => {
  const banned = [
    /proven/i, /production[- ]ready/i, /trusted by/i, /non-invasive/i, /customers?\b/i,
    /\$\s?\d|A\$|\bprice|\bpricing/i, /saves? \d/i, /\d+\s?(x|×) faster/i,
    /revolution/i, /seamless/i, /unleash/i, /empower/i, /cutting-edge/i, /effortless/i,
    /\bbed\b/i, /\bsheet\b/i, /PTY LTD/i,
  ];
  for (const re of banned) assert.doesNotMatch(text, re, `home copy matches ${re}`);
  // The AGPL offer is the footer's link; a second URL here would be a second thing to go stale.
  assert.doesNotMatch(html, /href=/);
  assert.doesNotMatch(text, /github|https?:/i);
});
