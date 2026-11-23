// THE TWO PLACES `AuthGate` CAN OPEN, AND WHAT MAY REACH THEM.
//
// ═══════════════════════════════════════════════════════════════════════════
// THE FAILURE THIS GUARDS
// ═══════════════════════════════════════════════════════════════════════════
//
// TODO #29's rule is *"only admins can log in"*. The failure mode of a
// MISCONFIGURATION was the opposite: `AuthGate` asked `authIsConfigured()`,
// which is false for **no Cognito vars at all** (local dev, CI, the e2e suite)
// AND for **two of the three set** — so one typo'd variable name in a deploy
// served the whole app to anyone, silently, looking exactly like intended dev
// behaviour. The fix split the question three ways (`absent` / `partial` /
// `configured`) in `auth.ts`, and `tests/auth.test.ts` covers that function
// thoroughly.
//
// 🔴 WHAT NOTHING COVERED IS THE COMPONENT. `auth.ts` can answer `partial`
// perfectly while `AuthGate.tsx` renders the app anyway — the decision and its
// USE are different code, and only the second one serves anybody. The gate has
// **two** open-paths (`state === 'authed'`, and a second `absent` net further
// down that used to disagree with the first), so "the pure function is right"
// is not the same claim as "the gate is shut".
//
// ⚠ THIS IS A SOURCE-TEXT GUARD AND SAYS SO — the house limitation, stated the
// way `config-wiring.test.ts` states it. `AuthGate.tsx` cannot be rendered in
// node (no DOM, and `App.tsx` is unimportable here at all), so nothing below
// observes a React render. **A text guard proves "unchanged", never
// "correct".** It is here because the alternative is nothing at all, and
// because the defect it guards has shipped in this file before.
//
// It goes red on the edits that would reopen the hole: an open-path whose guard
// is not one of the two allowed ones, `partial` no longer routing to
// `misconfigured`, or `authIsConfigured()` coming back as the config question.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = readFileSync(
  join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'src', 'AuthGate.tsx'),
  'utf8',
);

/** The source with comments removed — a guard must not read its own prose. */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

test('every path that renders {children} is guarded by authed OR an ABSENT config', () => {
  // Both open-paths, found rather than enumerated: any `return <>{children}</>`
  // anywhere in the component counts, so a third one added later is caught.
  const opens = [...CODE.matchAll(/return\s*<>\{\s*children\s*\}<\/>/g)].map((m) => m.index ?? 0);
  assert.ok(
    opens.length >= 1,
    'AuthGate renders {children} on no path at all — the gate can never open, which is a ' +
      'different defect but still one, and this test must not pass over it.',
  );

  const ALLOWED = [/state\s*===\s*'authed'/, /authConfigState\(\)\s*===\s*'absent'/];
  for (const at of opens) {
    // The guard is the nearest `if (...)` before the return.
    const before = CODE.slice(0, at);
    const guard = before.slice(before.lastIndexOf('if ('));
    assert.ok(
      ALLOWED.some((re) => re.test(guard)),
      'an open-path in AuthGate.tsx renders {children} under a condition that is neither ' +
        `\`state === 'authed'\` nor \`authConfigState() === 'absent'\`. The guard read: ` +
        `${JSON.stringify(guard.slice(0, 160))}. A partial Cognito config must NEVER reach a ` +
        'path that serves the app.',
    );
  }
});

test('the second open-path asks authConfigState, never authIsConfigured', () => {
  // 🔴 The exact regression: `authIsConfigured()` is false for `partial` too,
  // so the net below the effect would have served the app after the effect had
  // already refused. A second copy of a safety decision is a second place to be
  // wrong, and this one disagreed with the first.
  assert.ok(
    !/authIsConfigured\s*\(\s*\)/.test(CODE),
    'AuthGate.tsx calls authIsConfigured(), which answers false for a PARTIAL config as well as ' +
      'an absent one. That is the exact shape of the hole: one typo\'d env var name in a deploy ' +
      'serves the whole app unauthenticated. Ask authConfigState() and branch on all three.',
  );
  assert.ok(
    /authConfigState\s*\(\s*\)/.test(CODE),
    'AuthGate.tsx no longer asks authConfigState() at all — the three-way config question is gone.',
  );
});

test('a partial config routes to misconfigured, and misconfigured renders no way in', () => {
  assert.ok(
    /cfg\s*===\s*'partial'[\s\S]{0,120}setState\('misconfigured'\)/.test(CODE),
    "the mount effect no longer maps a 'partial' config to the 'misconfigured' state — a " +
      'half-configured deploy must refuse, not fall through to the login flow.',
  );
  assert.ok(
    /cfg\s*===\s*'absent'[\s\S]{0,120}setState\('authed'\)/.test(CODE),
    "the mount effect no longer maps an 'absent' config to 'authed' — that is the deliberate " +
      'local-development mode, and losing it silently breaks CI rather than security.',
  );

  // The misconfigured screen must offer NO sign-in button: there is nothing the
  // viewer can do, the deployment is wrong rather than their session, and a
  // button would send them to a half-specified Cognito domain and back here.
  const block = /\{state === 'misconfigured' && \(([\s\S]*?)\n\s*\)\}/.exec(CODE);
  assert.ok(block, "no `{state === 'misconfigured' && (…)}` render branch in AuthGate.tsx");
  assert.ok(
    !/<button/.test(block![1]),
    'the misconfigured screen renders a button. There is nothing the viewer can do about a ' +
      'broken deployment, and a sign-in button there reads as "auth is broken" rather than ' +
      '"this build was deployed wrong".',
  );
  assert.ok(
    /authVarsMissing\(\)/.test(block![1]),
    'the misconfigured screen no longer NAMES the missing variables. "Sign-in is misconfigured" ' +
      'and "VITE_COGNITO_REDIRECT_URI is unset" are different facts and only the second is actionable.',
  );
});

// ── The landing page (founder 2026-11-17, "turn login on! create a landing page") ──
//
// A logged-out visitor now meets `Landing.tsx` instead of the bare sign-in card.
// The failures guarded: (1) the landing page becoming a THIRD way into the app
// (it rendering the app or anything that imports it); (2) its sign-in button
// going somewhere other than the gate's own Cognito `login()`; (3) the status
// paragraph being softened into a hardware claim nobody has earned.
const LANDING = readFileSync(
  join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'src', 'Landing.tsx'),
  'utf8',
);
const LANDING_CODE = LANDING.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

test('unauth renders the landing page, wired to the gate\'s own login()', () => {
  assert.ok(
    /if\s*\(\s*state\s*===\s*'unauth'\s*\)\s*\{\s*return\s*\(?\s*<Landing\s+onSignIn=\{handleLogin\}/.test(CODE),
    "AuthGate no longer renders <Landing onSignIn={handleLogin} /> for state === 'unauth'. A " +
      'logged-out visitor would get the bare card (or nothing) instead of the landing page.',
  );
  assert.ok(
    /const handleLogin = useCallback\(\(\) => \{ login\(\); \}/.test(CODE),
    'handleLogin no longer calls login() — the landing page\'s sign-in would not reach Cognito.',
  );
});

test('the landing page cannot open the app', () => {
  assert.ok(!/children/.test(LANDING_CODE), 'Landing.tsx mentions children — it must never render the app.');
  assert.ok(
    !/from\s+'\.\/App'|from\s+'\.\/auth'/.test(LANDING_CODE),
    'Landing.tsx imports App or auth. It is a static page; who gets in is AuthGate\'s decision alone.',
  );
  const buttons = [...LANDING_CODE.matchAll(/<button[^>]*>/g)].map((m) => m[0]);
  assert.ok(buttons.length >= 1, 'the landing page has no sign-in button at all.');
  // 2026-11-23 (passkey sign-in, docs/design-local-auth.md v2): a button may call onPasskey too.
  // Both are AuthGate's own handlers; the landing page still decides nothing.
  for (const b of buttons) {
    assert.ok(/onClick=\{(onSignIn|onPasskey)\}/.test(b), `a landing-page button does something other than onSignIn/onPasskey: ${b}`);
  }
});

test('the passkey button appears only after the server itself answered (passkeyReady)', () => {
  /* Before backend ships /api/auth/*, the path falls through to the static site. The button must
   * not appear then: it would offer a sign-in that cannot work. passkeyReady is set only by
   * probeSession() seeing the contract's own JSON (tests/passkey-auth.test.ts covers that). */
  assert.ok(
    /onPasskey=\{passkeyReady \? [^}]*handlePasskey\(\) : undefined\}/.test(CODE),
    'AuthGate passes onPasskey to the landing page without gating it on passkeyReady.',
  );
  assert.ok(/\{onPasskey && \(/.test(LANDING_CODE), 'Landing renders the passkey button even when onPasskey is absent.');
  assert.ok(
    /setPasskeyReady\(true\)/.test(CODE) && !/useState\(true\)[^;]*passkey/i.test(CODE),
    'passkeyReady must start false and be set only after a probe.',
  );
});

test('the landing page still says nothing has been cut or printed', () => {
  assert.ok(
    /Nothing made with 2bee\.app has been cut on a router or\s+printed by its own slicer yet/.test(LANDING_CODE),
    'the landing page status no longer says nothing has been cut or printed. AGENTS.md § Scope: ' +
      'no hardware validation claim until the ladder is climbed, and this page is outward copy.',
  );
  assert.ok(
    /github\.com\/2hives-ai\/2bee\.app-source/.test(LANDING_CODE),
    'the AGPL §13 source link is gone from the landing page — the first page an anonymous visitor sees.',
  );
});
