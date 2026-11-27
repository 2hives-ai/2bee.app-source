// Which sign-in buttons the landing page shows (src/Landing.tsx).
//
// THE FAILURE THIS GUARDS (2026-11-27): once 2bee.app's DNS points at the
// jamesave passkey service, its CSP is `connect-src 'self'`, so the Cognito
// token exchange is blocked. A Cognito "Sign in" button left on that page takes
// the user through the Cognito login and then fails, at the moment the founder
// is enrolling. With the passkey server present the page must offer only the
// passkey. With it absent (CloudFront, or after a DNS rollback) it must offer
// Cognito exactly as before, or a rollback leaves nobody able to sign in.
//
// This RENDERS the component (esbuild compiles the TSX, react-dom/server
// renders it). It is not a source-text match.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'Landing.tsx');

async function loadLanding(): Promise<(p: Record<string, unknown>) => unknown> {
  const out = await build({
    entryPoints: [SRC], bundle: false, write: false, format: 'esm', jsx: 'automatic', loader: { '.tsx': 'tsx' },
  });
  const code = out.outputFiles[0].text.replace(/from "react\/jsx-runtime"/g,
    `from ${JSON.stringify(import.meta.resolve('react/jsx-runtime'))}`);
  const mod = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
  return mod.default;
}

const ids = (html: string) => [...html.matchAll(/data-testid="(landing-[a-z-]+)"/g)].map((m) => m[1]).filter((i) => i !== 'landing').sort();

test('passkey server present: only passkey buttons, no Cognito sign-in', async () => {
  const Landing = await loadLanding();
  const html = renderToStaticMarkup(createElement(Landing as never, { onSignIn: () => {}, onPasskey: () => {} }));
  assert.deepEqual(ids(html), ['landing-passkey', 'landing-passkey-top']);
  assert.doesNotMatch(html, /data-testid="landing-signin/);
});

test('passkey server absent (CloudFront, rollback): Cognito sign-in as before, no passkey', async () => {
  const Landing = await loadLanding();
  const html = renderToStaticMarkup(createElement(Landing as never, { onSignIn: () => {} }));
  assert.deepEqual(ids(html), ['landing-signin', 'landing-signin-top']);
});
