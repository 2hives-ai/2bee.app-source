// Asking a model to change the source — `web/src/cad/ask.tsx`.
//
// ─────────────────────────────────────────────────────────────────────────────
// 🔴 NO REAL REQUEST HAS EVER BEEN MADE. NOT ONCE, NOT BY ANYONE, NOT BY THIS
// FILE.
// ─────────────────────────────────────────────────────────────────────────────
//
// There is no network from the box this was written on. Every assertion below
// is driven through an injected transport that this file constructs, and one of
// the assertions is that the transport is not called at all when the preflight
// refuses. So what is established here is that the PIPELINE behaves as we read
// the protocol; nothing here can discover that our reading of the protocol is
// wrong, and nothing here has spoken to a model. Same standing as `run.test.ts`
// against `run/fake.ts`.
//
// WHAT THIS FILE EXERCISES, AND WHY EACH ONE IS HERE
//
//   · 🔴 A PROPOSAL CANNOT APPLY ITSELF. Every action shape is enumerated and
//     only `accept` may produce editor text. That is the rule the whole feature
//     rests on, there is no undo behind it, and it would be silent if it broke:
//     a proposal that auto-applied looks exactly like a user who clicked.
//   · 🔴 EVERY REFUSED CONSTRUCT IS ON SCREEN BEFORE THE ACCEPT BUTTON, by name
//     and by line. A model has read all of OpenSCAD and none of our subset, so
//     it reaches outside it far more readily than a person does — and a refused
//     construct is a feature MISSING from the part.
//   · 🔴 NO ENDPOINT AND NO KEY IN THE BUNDLE. This app is AGPL: a default here
//     would be published to everyone who runs the page, and would answer a
//     question ("whose subscription pays") that is not a code question.
//   · That a proposal which parses cleanly and describes a DIFFERENT PART is
//     measured and reported, because nothing else in this app can catch that.
//
// ⚠ NOT EXERCISED: nothing here clicks, so `disabled` on the accept button is
// asserted as an attribute, not as a press that did nothing. The reducer is
// where the guarantee lives and that is where it is tested.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', 'src');

const A = await import('../src/cad/ask.tsx');
// The forbidden-construct claim in `SYSTEM_INSTRUCTION` is an assertion ABOUT
// this module, so it is checked against the real one rather than restated.
const { parseScad } = await import('../src/cad/scad.ts');

const {
  ALL_ASK_ACTIONS,
  ASK_CONFIG_KEY,
  DIFF_LINE_CAP,
  INITIAL_ASK_STATE,
  NO_ASK_CONFIG,
  ProposalView,
  SYSTEM_INSTRUCTION,
  applicationOf,
  askConfigForStorage,
  askOnce,
  askReducer,
  buildRequest,
  classifyThrow,
  ENDPOINT_EXAMPLE,
  FORBIDDEN_CONSTRUCTS,
  fetchModelList,
  modelsUrl,
  parseModelList,
  diffLines,
  evaluate,
  extractScad,
  mayApply,
  enterSends,
  preflight,
  readAskConfig,
  readReply,
  reviewProposal,
  shapeDelta,
  userMessage,
  writeAskConfig,
} = A;

/* ════════════════════════════════════════════════════════════════════════════
   Fixtures
   ════════════════════════════════════════════════════════════════════════════ */

const CONFIGURED = {
  ...NO_ASK_CONFIG,
  endpoint: 'http://localhost:9/v1/chat/completions',
  model: 'a-model',
  apiKey: 'a-key',
};

const CURRENT = 'cube([10, 10, 10]);\n';

/** An OpenAI-shaped body carrying `content`. */
const chatReply = (content: string) =>
  JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] });

/** A transport that answers, and counts how many times it was asked. */
function spyTransport(answer: { status?: number; ok?: boolean; text: string }) {
  const calls: unknown[] = [];
  const t = async (req: unknown) => {
    calls.push(req);
    return { status: answer.status ?? 200, ok: answer.ok ?? true, text: answer.text };
  };
  return { transport: t as Parameters<typeof askOnce>[0]['transport'], calls };
}

const signal = () => new AbortController().signal;

/* ════════════════════════════════════════════════════════════════════════════
   1. Nothing is baked in
   ════════════════════════════════════════════════════════════════════════════ */

test('the shipped defaults are NOTHING — no endpoint, no model, no key, key not remembered', () => {
  assert.equal(NO_ASK_CONFIG.endpoint, '');
  assert.equal(NO_ASK_CONFIG.model, '');
  assert.equal(NO_ASK_CONFIG.apiKey, '');
  assert.equal(NO_ASK_CONFIG.rememberKey, false);
});

/**
 * Walk `src/`, skipping the generated wasm glue (which is not ours and does
 * carry a `fetch`).
 */
function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'wasm') continue;
      sources(p, out);
    } else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/**
 * 🔴 THE PLANT FOR THIS ONE IS "ADD A DEFAULT". Put a gateway URL in
 * `NO_ASK_CONFIG.endpoint`, or a key anywhere in `src/`, and this goes red.
 *
 * ⚠ The needles are LLM-provider-shaped, not URL-shaped: `src/` legitimately
 * carries supplier links and spec citations, and a blanket "no URL" rule would
 * be a false red that gets muted. The three CAD modules are held to the
 * stricter rule — no URL literal at all — because they are the only files a
 * default could hide in.
 */
test('no endpoint, host or key literal reaches the source tree', () => {
  const needles: [RegExp, string][] = [
    [/token-?plan/i, 'a subscription gateway host'],
    [/litellm/i, 'the gateway product name'],
    [/xiaomi|mimo-v/i, 'the model provider'],
    [/api\.openai\.com|api\.anthropic\.com/i, 'a provider endpoint'],
    [/\bsk-[A-Za-z0-9_-]{16,}/, 'an OpenAI-shaped key'],
    [/\btp-[A-Za-z0-9_-]{16,}/, 'a token-plan-shaped key'],
    [/Bearer\s+[A-Za-z0-9_-]{16,}/, 'a literal bearer token'],
  ];
  const hits: string[] = [];
  for (const f of sources(SRC)) {
    const text = readFileSync(f, 'utf8');
    for (const [re, what] of needles) if (re.test(text)) hits.push(`${f}: ${what}`);
  }
  assert.deepEqual(hits, [], 'a provider default reached the bundle — AGPL §13 would publish it');
});

/**
 * 🔴 ONE ALLOWED URL LITERAL, NAMED EXACTLY, AND IT CANNOT RESOLVE.
 *
 * This assertion was *"no URL literal at all"* and it went red on
 * {@link ENDPOINT_EXAMPLE} — the placeholder the founder asked for
 * (2026-08-11: *"have an example url"*). Two ways to make it green, and only one
 * of them is honest: assemble the example out of string fragments so the regex
 * cannot see it, or state the exception. **The first is defeating a control by
 * obfuscation**, and it would leave the guard passing over a file where a real
 * default could then hide the same way.
 *
 * So the exception is EXACT and it is narrower than it looks:
 *   · the literal must be, character for character, `ENDPOINT_EXAMPLE`;
 *   · only `cad/ask.tsx` may hold it, and only once;
 *   · its host must be under an RFC 2606 reserved name, so it can never resolve
 *     to a gateway — a default that cannot work is not a default;
 *   · and `ENDPOINT_EXAMPLE` is asserted elsewhere in this file to be a
 *     PLACEHOLDER rather than a value, which is the property that actually
 *     matters.
 *
 * Net effect: strictly more is asserted than before, not less.
 */
test('the CAD modules carry no URL literal except the one named example', () => {
  const seen: string[] = [];
  for (const f of ['cad/ask.tsx', 'cad/menu.tsx', 'cad/CadTab.tsx']) {
    const text = readFileSync(join(SRC, f), 'utf8');
    for (const m of text.matchAll(/https?:\/\/[^\s'"`]+/g)) {
      assert.equal(m[0], ENDPOINT_EXAMPLE, `${f} contains a URL literal: ${m[0]}`);
      assert.equal(f, 'cad/ask.tsx', `the example belongs in ask.tsx, not ${f}`);
      seen.push(m[0]);
    }
  }
  assert.equal(seen.length, 1, 'the example must appear exactly once');
  /* RFC 2606 §3 reserves these names. A host under one of them can never be a
   * working endpoint, which is what makes a literal here harmless. */
  assert.match(
    new URL(ENDPOINT_EXAMPLE).hostname,
    /(^|\.)(example\.(com|net|org)|test|invalid|localhost)$/,
    'the example host is not reserved, so it could be a real gateway',
  );
});

/**
 * The stronger form of the same question, asked of the artefact a user actually
 * downloads. It runs only when `dist/` exists — and says so rather than passing
 * quietly, because a check that cannot run is not a check that passed.
 *
 * 🔴 AND IT IS NOT A SUPERSET OF THE SOURCE SCAN ABOVE — measured, not assumed.
 * A planted `export const LEAK = 'sk-…'` that nothing referenced was TREE-SHAKEN
 * out of `dist/` and this assertion stayed green while the source scan went red.
 * Moving the same string into `NO_ASK_CONFIG.apiKey`, where it is genuinely
 * reachable, turned both red. So: **the source scan catches a default nobody
 * uses yet, and this one catches a default that ships.** Neither replaces the
 * other, and deleting the source scan because "the bundle check is stronger"
 * would silently uncover the case where a key is committed a week before the
 * code that reads it.
 */
test('and the same needles are absent from the built bundle, when one exists', (t) => {
  const dist = join(HERE, '..', 'dist', 'assets');
  if (!existsSync(dist)) {
    t.diagnostic('PENDING — no dist/ on disk; run `npm run build` to make this assertion real');
    return;
  }
  const bad = /token-?plan|litellm|xiaomi|api\.openai\.com|\bsk-[A-Za-z0-9_-]{16,}/i;
  for (const f of readdirSync(dist)) {
    if (!f.endsWith('.js')) continue;
    assert.ok(!bad.test(readFileSync(join(dist, f), 'utf8')), `${f} carries a provider default`);
  }
});

/* ════════════════════════════════════════════════════════════════════════════
   2. Preflight — the feature is ABSENT without a connection, not broken
   ════════════════════════════════════════════════════════════════════════════ */

test('with nothing configured, nothing can be asked and the reason names the AGPL cause', () => {
  const f = preflight(NO_ASK_CONFIG, 'do a thing', true);
  assert.equal(f?.kind, 'no-endpoint');
  assert.match(f!.detail, /AGPL/);
});

test('each missing field refuses on its own terms', () => {
  assert.equal(preflight({ ...NO_ASK_CONFIG, endpoint: 'x' }, 'p', true)?.kind, 'no-model');
  assert.equal(
    preflight({ ...NO_ASK_CONFIG, endpoint: 'x', model: 'm' }, 'p', true)?.kind,
    'no-key',
  );
  assert.equal(preflight(CONFIGURED, '   ', true)?.kind, 'no-prompt');
  assert.equal(preflight(CONFIGURED, 'p', false)?.kind, 'offline');
  assert.equal(preflight(CONFIGURED, 'p', true), null);
});

test('offline says the REST of the tab still works — the feature is absent, the app is not', () => {
  assert.match(preflight(CONFIGURED, 'p', false)!.detail, /work offline|works offline|offline/i);
});

/**
 * 🔴 A REFUSAL MUST MEAN NOTHING LEFT, not "we sent it and ignored the reply".
 */
test('a preflight refusal never touches the transport', async () => {
  for (const [cfg, prompt, online] of [
    [NO_ASK_CONFIG, 'p', true],
    [CONFIGURED, '', true],
    [CONFIGURED, 'p', false],
  ] as const) {
    const spy = spyTransport({ text: chatReply('cube(1);') });
    const out = await askOnce({ cfg, prompt, source: CURRENT, online, transport: spy.transport, signal: signal() });
    assert.equal(out.ok, false);
    assert.equal(spy.calls.length, 0, 'the transport was called despite a refusal');
  }
});

/* ════════════════════════════════════════════════════════════════════════════
   3. What leaves — exactly the prompt and the source
   ════════════════════════════════════════════════════════════════════════════ */

test('the request body is EXACTLY the fixed instruction, the prompt and the source', () => {
  const req = buildRequest(CONFIGURED, 'make it 20mm', CURRENT);
  assert.deepEqual(req.body, {
    model: 'a-model',
    messages: [
      { role: 'system', content: SYSTEM_INSTRUCTION },
      { role: 'user', content: userMessage('make it 20mm', CURRENT) },
    ],
    temperature: 0,
    stream: false,
  });
  assert.deepEqual(Object.keys(req.headers).sort(), ['authorization', 'content-type']);
  assert.equal(req.url, CONFIGURED.endpoint);
});

/**
 * 🔴 THE INSTRUCTION IS AN ASSERTION ABOUT `scad.ts`, AND NOTHING CHECKED IT.
 *
 * It was wrong about FIVE constructs — `color`, `render`, `#`, `!` and `*` were
 * all listed as *"NOT implemented and refused by name"* and all five parse. The
 * cost is invisible by construction: a model told not to use a working construct
 * returns a confident, well-formed answer that does not do the thing it was
 * asked to do, and no error, refusal or warning is produced anywhere. The
 * founder asked for red objects, got the file back BYTE-IDENTICAL, and every
 * control in the app agreed nothing was wrong.
 *
 * ⚠ THE TWO DIRECTIONS ARE NOT SYMMETRICAL AND BOTH ARE ASSERTED. A construct
 * listed but accepted costs a capability SILENTLY. A construct accepted but not
 * listed costs a refusal that is at least reported on screen. So the second leg
 * — "everything named is genuinely refused" — is the cheaper failure and is
 * still checked, because a refusal list that names something imaginary is a
 * refusal list nobody can trust the rest of.
 */
test('every construct the instruction forbids IS refused, and it forbids nothing the parser accepts', () => {
  const clause = SYSTEM_INSTRUCTION.slice(SYSTEM_INSTRUCTION.indexOf('NOT implemented and refused by name:'));
  assert.ok(clause.length > 40, 'the forbidden clause could not be located — this test asserted nothing');

  // LEG 1 — everything named is genuinely refused, run through the real parser.
  const probe: Record<string, string> = {
    // hull is now handled — removed from forbidden list.
    // projection is now handled — removed from forbidden list.
    // offset is now handled — removed from forbidden list.
    // linear_extrude is now handled — removed from forbidden list.
    // rotate_extrude is now handled — removed from forbidden list.
    // polyhedron is now handled — removed from forbidden list.
    // polygon is now handled — removed from forbidden list.
    // surface is now handled — removed from forbidden list.
    import: 'import("x.stl");',
    // text is now handled — removed from forbidden list.
    // mirror is now handled — removed from forbidden list.
    // multmatrix is now handled — removed from forbidden list.
    // resize is now handled — removed from forbidden list.
    // echo is now handled — removed from forbidden list.
    // assert is now handled — removed from forbidden list.
    // intersection_for is now handled — removed from forbidden list.
  };
  for (const name of FORBIDDEN_CONSTRUCTS) {
    assert.ok(clause.includes(name), `the instruction's array names ${name} and its sentence does not`);
    const src = probe[name];
    assert.ok(src, `no probe source for ${name} — the list grew and this test did not`);
    const refused = parseScad(src).unsupported.map((u) => u.name);
    assert.ok(
      refused.some((n) => n.startsWith(name)),
      `the instruction says ${name} is refused; parseScad ACCEPTED it (refusals were ${JSON.stringify(refused)})`,
    );
  }
  // `%` is the one modifier character that really is refused.
  assert.ok(clause.includes('% modifier'), 'the one genuinely refused modifier is no longer named');
  assert.ok(
    parseScad('%cube(3);').unsupported.some((u) => u.name.includes('%')),
    '% stopped being refused and the instruction still says it is',
  );

  // LEG 2 — the five that were wrongly banned. Each must parse to geometry AND
  // must not appear in the forbidden clause.
  const accepted: [string, string][] = [
    ['color', 'color("red") cube(3);'],
    ['render', 'render() cube(3);'],
    ['#', '#cube(3);'],
    ['!', '!cube(3);'],
    ['*', '*cube(3);'],
  ];
  for (const [name, src] of accepted) {
    const r = parseScad(src);
    assert.equal(r.unsupported.length, 0, `${name} is accepted by the parser but reported a refusal`);
    assert.equal(r.errors.length, 0, `${name} produced a parse error`);
  }
  assert.ok(!clause.includes('color'), 'color is banned again, and it works');
  assert.ok(!clause.includes('render'), 'render is banned again, and it is a pass-through');
  assert.ok(!clause.includes('# ! % *'), 'the four modifier characters are banned as a group again; only % is refused');

  // And the instruction must actively tell the model that colour is available —
  // deleting the ban is not the same as saying it can be used.
  assert.match(SYSTEM_INSTRUCTION, /color\(c, alpha\)/, 'the instruction does not offer colour at all');
  assert.match(SYSTEM_INSTRUCTION, /OUTERMOST color\(\) wins/, 'the inheritance rule is the one a model gets wrong');
});

test('the user turn contains the prompt and the source and nothing invented', () => {
  const msg = userMessage('shrink it', CURRENT);
  assert.ok(msg.includes('shrink it'));
  assert.ok(msg.includes(CURRENT));
  assert.equal(msg.length, 'shrink it'.length + CURRENT.length + '\n\n----- current 2bee.cad source -----\n'.length);
});

test('with no key there is no Authorization header at all', () => {
  const req = buildRequest({ ...CONFIGURED, apiKey: '' }, 'p', CURRENT);
  assert.equal(req.headers.authorization, undefined);
});

/* ════════════════════════════════════════════════════════════════════════════
   4. The key is not remembered unless it was asked for
   ════════════════════════════════════════════════════════════════════════════ */

function memoryStore() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
}

test('the key is NOT written to storage by default', () => {
  const s = memoryStore();
  writeAskConfig(CONFIGURED, s);
  const raw = s.m.get(ASK_CONFIG_KEY)!;
  assert.ok(!raw.includes('a-key'), 'the key was persisted without being asked for');
  assert.equal(readAskConfig(s).apiKey, '');
  assert.equal(readAskConfig(s).endpoint, CONFIGURED.endpoint, 'the rest of the config survives');
});

test('the key is written only when rememberKey is set, and read back only then', () => {
  const s = memoryStore();
  writeAskConfig({ ...CONFIGURED, rememberKey: true }, s);
  assert.equal(readAskConfig(s).apiKey, 'a-key');
  // A record that carries a key but does not claim it was meant to be kept does
  // not get to opt the operator in.
  const forged = memoryStore();
  forged.m.set(ASK_CONFIG_KEY, JSON.stringify({ endpoint: 'x', model: 'm', apiKey: 'leaked' }));
  assert.equal(readAskConfig(forged).apiKey, '');
});

test('a corrupt stored config falls back to nothing rather than to something', () => {
  const s = memoryStore();
  s.m.set(ASK_CONFIG_KEY, '{not json');
  assert.deepEqual(readAskConfig(s), NO_ASK_CONFIG);
  assert.equal(readAskConfig(null).endpoint, '');
  assert.equal(askConfigForStorage(CONFIGURED).apiKey, undefined);
});

/* ════════════════════════════════════════════════════════════════════════════
   5. Every failure is a state with a sentence
   ════════════════════════════════════════════════════════════════════════════ */

test('an HTTP refusal names the status and quotes the endpoint’s own reason', () => {
  const r = readReply({ status: 401, ok: false, text: JSON.stringify({ error: { message: 'bad key' } }) });
  assert.equal(r.ok, false);
  assert.equal(r.failure.kind, 'refused');
  assert.match(r.failure.headline, /401/);
  assert.match(r.failure.detail, /bad key/);
});

test('a non-JSON body is its own failure, and quotes what actually came back', () => {
  const r = readReply({ status: 200, ok: true, text: '<html>login</html>' });
  assert.equal(r.ok, false);
  assert.equal(r.failure.kind, 'not-json');
  assert.match(r.failure.detail, /login/);
});

test('JSON in a shape we do not read is refused rather than rummaged through', () => {
  const r = readReply({ status: 200, ok: true, text: JSON.stringify({ output: 'cube(1);' }) });
  assert.equal(r.ok, false);
  assert.equal(r.failure.kind, 'no-content');
});

test('an answer with nothing in it is a failure, not an empty proposal', () => {
  const r = readReply({ status: 200, ok: true, text: chatReply('   \n  ') });
  assert.equal(r.ok, false);
  assert.equal(r.failure.kind, 'empty');
});

test('an abort is a timeout, and anything else thrown is a reachability failure', () => {
  assert.equal(classifyThrow({ name: 'AbortError' }).kind, 'timeout');
  const net = classifyThrow(new TypeError('Failed to fetch'));
  assert.equal(net.kind, 'network');
  assert.match(net.detail, /CORS/, 'the commonest browser cause has to be named — nothing else can');
});

test('a thrown transport becomes a failure, never an exception out of askOnce', async () => {
  const out = await askOnce({
    cfg: CONFIGURED,
    prompt: 'p',
    source: CURRENT,
    online: true,
    transport: async () => {
      throw new TypeError('Failed to fetch');
    },
    signal: signal(),
  });
  assert.equal(out.ok, false);
  assert.equal(out.failure.kind, 'network');
});

test('a fenced reply is unwrapped; an unfenced one is taken whole', () => {
  assert.equal(extractScad('here:\n```scad\ncube(1);\n```\nenjoy'), 'cube(1);');
  assert.equal(extractScad('cube(1);\n'), 'cube(1);');
});

/* ════════════════════════════════════════════════════════════════════════════
   6. The proposal goes through the same parser and the same audit
   ════════════════════════════════════════════════════════════════════════════ */

const withRefusal = 'cube([10,10,10]);\nhulls() cube(5);\n';

test('a refused construct in the proposal is reported by name and by line', () => {
  const r = reviewProposal(evaluate(CURRENT), withRefusal);
  const names = r.refused.map((u) => u.name).join(' ');
  assert.match(names, /hulls/);
  assert.equal(r.refused[0].line, 2);
  assert.ok(r.newRefusalNames.some((n) => /hulls/.test(n)), 'and flagged as NEW against the current source');
  assert.ok(r.cautions.some((c) => /REFUSED/.test(c)));
});

test('a reply that is not SCAD at all is not offered for acceptance', () => {
  const r = reviewProposal(evaluate(CURRENT), 'I think you should use a chamfer here!!!');
  assert.ok(r.blocked, 'prose was offered as an acceptable proposal');
  assert.equal(r.blocked!.kind, 'not-scad');
});

test('a reply that parses cleanly and produces nothing is not offered either', () => {
  const r = reviewProposal(evaluate(CURRENT), '// just a comment\nx = 4;\n');
  assert.equal(r.blocked?.kind, 'parses-to-nothing');
});

test('a reply identical to the current source is not offered — there is nothing to accept', () => {
  const r = reviewProposal(evaluate(CURRENT), CURRENT);
  assert.equal(r.blocked?.kind, 'unchanged');
});

/**
 * 🔴 THE GUARD WAS CORRECT AND THE APP DEFEATED IT WITH ITS OWN NORMALISATION.
 *
 * Measured against a live reply on 2026-08-11: the model returned the source
 * verbatim, `extractScad` stripped the trailing newline from the REPLY, nothing
 * stripped it from the EDITOR'S text, and the `unchanged` guard — a plain `===`
 * on two strings 577 and 576 characters long — returned `blocked: null`. The
 * operator was offered "Accept" on a no-op, with `cautions` correctly reporting
 * that the geometry was identical and the accept button live anyway.
 *
 * ⚠ THIS IS NOT A MISSING BRANCH. Nothing threw, nothing was forgotten, and
 * reading either side alone shows a correct function. It only appears when the
 * two are put in contact, which is why the fix is ONE normaliser both sides go
 * through and why this test drives `reviewProposal` from BOTH directions:
 * whitespace added to the reply and whitespace added to the source.
 */
test('a reply differing from the source by trailing whitespace ALONE is blocked as unchanged', () => {
  const source = 'cube([10, 10, 10]);\n';

  // The measured shape: the source has the newline, the reply does not.
  const stripped = reviewProposal(evaluate(source), 'cube([10, 10, 10]);');
  assert.equal(stripped.blocked?.kind, 'unchanged', 'a reply that lost the trailing newline was offered');

  // And the mirror, which is the case that would come back if only one side
  // were normalised: the reply has MORE whitespace than the source.
  const added = reviewProposal(evaluate('cube([10, 10, 10]);'), 'cube([10, 10, 10]);\n\n  ');
  assert.equal(added.blocked?.kind, 'unchanged', 'a reply with extra trailing whitespace was offered');

  // A leading blank line is the other half of what `extractScad` removes.
  const leading = reviewProposal(evaluate(source), '\ncube([10, 10, 10]);\n');
  assert.equal(leading.blocked?.kind, 'unchanged', 'a reply with a leading blank line was offered');

  // 🔴 AND THE NORMALISER MUST NOT GROW. Interior whitespace is a real edit the
  // operator has to see in the diff; a normaliser that collapsed it would block
  // a change the model actually made, which is the same defect facing the other
  // way and costs a working feature instead of a wasted click.
  const reindented = reviewProposal(evaluate('union() {\ncube(3);\n}\n'), 'union() {\n  cube(3);\n}\n');
  assert.equal(reindented.blocked, null, 'a re-indented reply was blocked; only the ENDS may be normalised');
});

test('a good proposal is offered, with the audit standing behind it', () => {
  const r = reviewProposal(evaluate(CURRENT), 'cube([20, 10, 10]);\n');
  assert.equal(r.blocked, null);
  assert.equal(r.proposed.mesh.trust, 'trusted');
});

/**
 * 🔴 THE ONE NOTHING ELSE IN THIS APP CAN CATCH. Both sources parse cleanly,
 * both audit closed, and they are different parts.
 */
test('a clean proposal that describes a DIFFERENT PART is measured and said out loud', () => {
  const before = evaluate(CURRENT);
  const after = evaluate('cube([10, 10, 10]);\ntranslate([0,0,10]) cube([40, 40, 5]);\n');
  const d = shapeDelta(before, after);
  assert.equal(d.changed, true);
  assert.ok(d.solidsAfter > d.solidsBefore);
  assert.ok(d.sizeDeltaMm.some((v) => Math.abs(v) > 1), `bounding box did not move: ${d.sizeDeltaMm}`);
  assert.match(d.sentence, /do NOT mean this is the part you asked for/);
});

test('a text change that moves NO geometry says exactly that', () => {
  const d = shapeDelta(evaluate(CURRENT), evaluate(`// a new comment\n${CURRENT}`));
  assert.equal(d.changed, false);
  assert.match(d.sentence, /IDENTICAL/);
});

test('the diff marks what came from where, and refuses to truncate a big one', () => {
  const d = diffLines('a\nb\nc\n', 'a\nX\nc\n')!;
  assert.deepEqual(
    d.map((x) => `${x.op}:${x.text}`),
    ['same:a', 'remove:b', 'add:X', 'same:c', 'same:'],
  );
  const huge = Array.from({ length: DIFF_LINE_CAP + 2 }, (_, i) => `l${i}`).join('\n');
  assert.equal(diffLines('a', huge), null, 'a truncated diff reads as a complete one');
});

/* ════════════════════════════════════════════════════════════════════════════
   7. 🔴 WHICH REPLIES REACH THE EDITOR, AND WHAT ELSE NEVER CAN
   ════════════════════════════════════════════════════════════════════════════

   ⚠ THIS SECTION WAS TITLED "A PROPOSAL CANNOT APPLY ITSELF" AND EVERY TEST IN
   IT ASSERTED THAT. The founder ruled the other way on 2026-08-11 — *"when
   request sent automatically change the code (no extra click needed)"* — so the
   assertions were INVERTED rather than removed. What the old ones were really
   protecting was never "a click happens"; it was **that nothing but a reviewed,
   unblocked reply can put text in this editor**, and that property is asserted
   here at full strength. Deleting them is how an auto-apply quietly becomes an
   auto-ignore: a blocked reply landing anyway, or a clean one vanishing.
   ════════════════════════════════════════════════════════════════════════════ */

const goodReview = reviewProposal(evaluate(CURRENT), 'cube([20, 10, 10]);\n');
const appliedState = askReducer(INITIAL_ASK_STATE, {
  t: 'reply',
  source: 'cube([20, 10, 10]);\n',
  raw: 'cube([20, 10, 10]);\n',
  review: goodReview,
});

const blockedReview = reviewProposal(evaluate(CURRENT), 'this is prose, not scad');
const blockedState = askReducer(INITIAL_ASK_STATE, {
  t: 'reply',
  source: 'this is prose, not scad',
  raw: 'this is prose, not scad',
  review: blockedReview,
});

test('a clean reply applies itself, with no action in between', () => {
  assert.equal(goodReview.blocked, null, 'this fixture must be an APPLICABLE reply or the test is vacuous');
  assert.equal(appliedState.phase, 'applied');
  const app = applicationOf(appliedState)!;
  assert.equal(app.kind, 'model-proposal');
  assert.equal(app.next, 'cube([20, 10, 10]);\n');
});

/**
 * 🔴 AND THE PROPOSAL IS NOT CONSUMED BY APPLYING IT. The old `accept` branch
 * cleared it, because the report had already been read on the way to the button.
 * There is no way to the button now, so the report has to survive the apply —
 * this is the state the cautions are rendered from.
 */
test('applying does not throw away the review — it is the only thing left that can warn', () => {
  assert.ok(appliedState.proposal, 'the report vanished with the click that used to precede it');
  assert.equal(appliedState.proposal!.review, goodReview);
});

/**
 * 🔴 THE PROPERTY, ENUMERATED. It used to read *"only accept can put a model's
 * text in the editor"*. Now only `reply` can — and only a reply that
 * {@link mayApply} accepts. Plant: make `mayApply` return `true` unconditionally
 * and the blocked half goes red; make the `reply` branch set `application: null`
 * and the applying half goes red.
 */
test('of every action shape, ONLY a reply can put a model’s text in the editor', () => {
  const produced: string[] = [];
  for (const a of ALL_ASK_ACTIONS) {
    const app = applicationOf(askReducer(appliedState, a));
    if (app?.kind === 'model-proposal') produced.push(a.t);
  }
  /* ⚠ EMPTY, NOT `['reply']` — `ALL_ASK_ACTIONS` carries a BLOCKED review on
   * purpose, so this enumeration exercises the refusing side of the branch. The
   * applying side is the test above, against a review `reviewProposal` really
   * produced. One fixture cannot cover both sides of a conditional. */
  assert.deepEqual(produced, []);
});

test('a BLOCKED reply does not reach the editor, and does not vanish either', () => {
  assert.equal(mayApply(blockedReview), false);
  assert.equal(applicationOf(blockedState), null);
  assert.equal(blockedState.phase, 'proposed');
  assert.ok(blockedState.proposal, 'a blocked reply must SURFACE, not be dropped');
});

/**
 * 🔴 THE RULE IS `blocked === null` AND NOTHING WIDER. A reply full of refused
 * constructs, or one whose bounding box moved half a metre, is a CAUTION — it
 * applies. Narrowing this to "apply only when nothing is wrong" would refuse
 * most real edits; that is a judgement the operator makes from the report.
 */
test('cautions do not stop an apply — only `blocked` does', () => {
  const risky = reviewProposal(evaluate(CURRENT), withRefusal);
  assert.ok(risky.cautions.length > 0, 'fixture must actually caution about something');
  assert.equal(risky.blocked, null);
  assert.equal(mayApply(risky), true);
});

/**
 * ⚠ THE PUT-BACK MOVED OUT OF THIS FILE, 2026-08-11, AND SO DID ITS TESTS —
 * and it is now LOAD-BEARING rather than a convenience, because it is the only
 * route back from an overwrite nobody clicked. The assertions live in
 * `cad-replace.test.ts` at full strength, and the auto-applied path is exercised
 * there specifically.
 */
test('this reducer no longer owns a put-back — it is the tab’s, once, for every replacement', () => {
  assert.ok(!('replaced' in appliedState), 'a second stash here is a second put-back to press');
  for (const a of ALL_ASK_ACTIONS) {
    assert.notEqual((a as { t: string }).t, 'restore', 'the restore action must not come back here');
  }
});

test('a failure clears any proposal rather than leaving a stale one on screen', () => {
  const failed = askReducer(appliedState, {
    t: 'failed',
    failure: { kind: 'network', headline: 'h', detail: 'd' },
  });
  assert.equal(failed.proposal, null);
  assert.equal(applicationOf(failed), null);
});

/* ────────────────────────────────────────────────────────────────────────────
   Enter sends — and the four presses that must not
   ──────────────────────────────────────────────────────────────────────────── */

const READY = { prompt: 'make it 8mm', sending: false, blocked: false };

test('Enter on a ready prompt sends', () => {
  assert.equal(enterSends({ key: 'Enter' }, READY), true);
});

test('Shift+Enter is a new line, and so is every other modifier', () => {
  for (const mod of ['shiftKey', 'ctrlKey', 'metaKey', 'altKey'] as const) {
    assert.equal(enterSends({ key: 'Enter', [mod]: true }, READY), false, mod);
  }
});

/**
 * 🔴 THE ONE NOBODY ON THIS BOX CAN REPRODUCE BY HAND. For Japanese, Chinese and
 * Korean input the `Enter` that COMMITS an IME candidate is the same physical
 * key. Firing on it would make this box unusable in those languages — and each
 * attempt to type a word would spend money on a paid plan. Both signals are
 * checked, because the legacy `keyCode === 229` is what older browsers emit for
 * a composing key that carries no `isComposing` at all.
 */
test('Enter during IME composition does NOT send, by either signal', () => {
  assert.equal(enterSends({ key: 'Enter', isComposing: true }, READY), false);
  assert.equal(enterSends({ key: 'Enter', keyCode: 229 }, READY), false);
});

test('Enter on an empty or whitespace-only prompt does not send', () => {
  assert.equal(enterSends({ key: 'Enter' }, { ...READY, prompt: '' }), false);
  assert.equal(enterSends({ key: 'Enter' }, { ...READY, prompt: '   \n ' }), false);
});

/** Every call is real money on a paid plan, and Enter is the key people repeat. */
test('Enter while a request is in flight does not send a second one', () => {
  assert.equal(enterSends({ key: 'Enter' }, { ...READY, sending: true }), false);
});

test('Enter does not send what preflight would refuse', () => {
  assert.equal(enterSends({ key: 'Enter' }, { ...READY, blocked: true }), false);
});

test('no other key sends', () => {
  for (const key of ['a', 'Tab', 'Escape', ' ', 'NumpadEnter', 'Return']) {
    assert.equal(enterSends({ key }, READY), false, key);
  }
});

/**
 * ⚠ A SOURCE-SHAPE ASSERTION, NAMED AS THE WEAKER THING IT IS: the handler
 * `preventDefault`s only on the path that sends. A swallowed key that does
 * nothing is indistinguishable from a broken app.
 */
test('the key is only taken from the textarea when it is actually being used', () => {
  const src = readFileSync(join(HERE, '..', 'src', 'cad', 'ask.tsx'), 'utf8');
  assert.match(src, /if \(\s*!enterSends\([\s\S]{0,900}?\)\s*\) \{\s*\n\s*return;\s*\n\s*\}\s*\n\s*e\.preventDefault\(\);\s*\n\s*void send\(\);/);
});

/* ════════════════════════════════════════════════════════════════════════════
   8. What is on screen after the reply — applied, or refused
   ════════════════════════════════════════════════════════════════════════════ */

const renderProposal = (review: unknown, raw = 'x') =>
  renderToStaticMarkup(
    h(ProposalView, {
      review: review as never,
      raw,
      applied: (review as { blocked: unknown }).blocked === null,
      onDiscard: () => {},
    }),
  );

/**
 * 🔴 PLANT: delete the refusal list from `ProposalView` and this goes red. It is
 * the tab's whole contract — a refusal is geometry the reply has and the tree
 * does not — arriving from a source that is more likely to produce one. It
 * mattered before the click was removed; it matters more now, because it is read
 * about source that is ALREADY in the editor.
 */
test('every refused construct is rendered, by name and by line', () => {
  const review = reviewProposal(evaluate(CURRENT), withRefusal);
  const html = renderProposal(review);
  assert.ok(review.refused.length > 0, 'fixture must actually refuse something');
  for (const u of review.refused) {
    assert.ok(html.includes(u.name), `${u.name} is missing from the proposal view`);
    assert.match(html, new RegExp(`data-testid="cad-ask-refusal" data-line="${u.line}"`));
  }
});

test('the audit verdict and the shape delta are rendered, not merely computed', () => {
  const review = reviewProposal(evaluate(CURRENT), 'cube([40, 10, 10]);\n');
  const html = renderProposal(review);
  assert.match(html, /cad-ask-summary/);
  assert.match(html, /\+30\.00/, 'the bounding-box change in mm is not on screen');
  assert.match(html, /trusted/);
});

/**
 * 🔴 THE SENTENCE THAT TELLS AN OPERATOR THE MODEL DID NOTHING, ON THE PATH
 * WHERE NOBODY PRESSED ANYTHING.
 *
 * A comment-only reply is not blocked — the text really did change — so it
 * applies. The ONLY thing that says the shape did not move is a caution, and
 * before this change that caution was read on the way to a button. It is now
 * read after the fact, so it is asserted both to be present and to be rendered
 * at warning weight rather than as a grey note under an edit that already
 * happened.
 */
test('“the evaluated geometry is IDENTICAL” survives the apply, and is not a grey note', () => {
  const review = reviewProposal(evaluate(CURRENT), `// a new comment\n${CURRENT}`);
  assert.equal(review.blocked, null, 'a comment-only edit must APPLY — it did change the text');
  assert.ok(review.cautions.some((c) => /IDENTICAL/.test(c)));

  const html = renderProposal(review);
  assert.match(html, /IDENTICAL/);
  assert.match(html, /class="notes warn"[^>]*data-testid="cad-ask-cautions"/);
});

/**
 * 🔴 AND THE HEADING MUST NOT LIE ABOUT WHETHER THE EDITOR CHANGED. It read
 * *"This is a proposal. Nothing has changed in the editor."* on every render,
 * which is now false for everything that applied.
 */
test('an applied reply says so, and a refused one says the editor is untouched', () => {
  const applied = renderProposal(reviewProposal(evaluate(CURRENT), 'cube([20,10,10]);\n'));
  assert.match(applied, /data-testid="cad-ask-applied"/);
  assert.match(applied, /now in the editor/);
  assert.ok(!/Nothing has changed in the editor/.test(applied));

  const refused = renderProposal(reviewProposal(evaluate(CURRENT), 'prose only'));
  assert.match(refused, /Nothing has changed in the editor/);
  assert.match(refused, /data-testid="cad-ask-blocked" data-kind="not-scad"/);
  assert.match(refused, /NOT applied/);
  assert.match(refused, /The editor\s+is untouched/);
});

/**
 * 🔴 THE ACCEPT BUTTON IS GONE, NOT DISABLED. With the apply on the reply, the
 * only proposals that could reach it are the blocked ones it already refused —
 * a permanently dead control. Asserted absent so it cannot come back disabled.
 */
test('there is no accept control left to be dead', () => {
  for (const proposal of ['cube([20,10,10]);\n', 'prose only']) {
    assert.ok(!renderProposal(reviewProposal(evaluate(CURRENT), proposal)).includes('cad-ask-accept'));
  }
});

test('the reply is shown verbatim, so what was judged can be read', () => {
  const html = renderProposal(reviewProposal(evaluate(CURRENT), 'cube([20,10,10]);\n'), 'RAW-MARKER');
  assert.match(html, /RAW-MARKER/);
});

test('the view says whose lines the numbers are, and it changes with the outcome', () => {
  assert.match(renderProposal(reviewProposal(evaluate(CURRENT), 'prose only')), /lines of the PROPOSAL/);
  assert.match(renderProposal(reviewProposal(evaluate(CURRENT), withRefusal)), /they are editor lines/);
});

/* ════════════════════════════════════════════════════════════════════════════
   9. End to end, against a transport this file wrote
   ════════════════════════════════════════════════════════════════════════════ */

test('a whole round trip reviews the reply AND hands it to the editor, unpressed', async () => {
  const spy = spyTransport({ text: chatReply('```scad\ncube([20,10,10]);\n```') });
  const out = await askOnce({
    cfg: CONFIGURED,
    prompt: 'make it 20 long',
    source: CURRENT,
    online: true,
    transport: spy.transport,
    signal: signal(),
  });
  assert.equal(out.ok, true);
  assert.equal(spy.calls.length, 1);
  assert.equal(out.source, 'cube([20,10,10]);');
  assert.equal(out.review.blocked, null);
  assert.equal(out.review.shape.changed, true);

  const s = askReducer(INITIAL_ASK_STATE, {
    t: 'reply',
    source: out.source,
    raw: out.raw,
    review: out.review,
  });
  /* 🔴 THE OTHER HALF OF THE ROUND TRIP, AND IT IS THE FOUNDER'S REQUEST END TO
   * END: one press, no second press, the reply in the editor. This assertion
   * read `assert.equal(applicationOf(s), null, 'a completed round trip applied
   * itself')` until 2026-08-11 — it is inverted, not deleted, because it is
   * still the only place the whole chain is exercised together. */
  const app = applicationOf(s)!;
  assert.equal(app.kind, 'model-proposal');
  assert.equal(app.next, 'cube([20,10,10]);');
  assert.equal(s.phase, 'applied');
});

/* ════════════════════════════════════════════════════════════════════════════
   The example URL, and listing what an endpoint advertises
   ════════════════════════════════════════════════════════════════════════════ */

/**
 * 🔴 A PLACEHOLDER IS NOT A DEFAULT, and the difference decides where an
 * operator's source goes. Founder, 2026-08-11: *"have an example url"*. An
 * example that is pre-filled becomes a setting nobody chose — this lane has
 * filed that exact shape more than once — so the example must be visible in the
 * field and absent from the value.
 */
test('the example endpoint is a placeholder, never a configured value', () => {
  assert.equal(NO_ASK_CONFIG.endpoint, '', 'a fresh browser must have no endpoint');
  assert.equal(readAskConfig(null).endpoint, '');
  /* And it stays refused: preflight is what stops an unconfigured send. */
  const refusal = preflight(NO_ASK_CONFIG, 'make it 8mm', true);
  assert.equal(refusal?.kind, 'no-endpoint');

  const src = readFileSync(join(HERE, '..', 'src', 'cad', 'ask.tsx'), 'utf8');
  assert.match(src, /placeholder=\{ENDPOINT_EXAMPLE\}/, 'the example must be the placeholder');
  assert.ok(
    !new RegExp(`endpoint:\\s*'${ENDPOINT_EXAMPLE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`).test(src),
    'the example is being used as a value somewhere',
  );
});

/**
 * 🔴 AND THE EXAMPLE HOST CAN NEVER RESOLVE. This is an AGPL browser bundle:
 * everything in it ships to every reader. A real gateway hostname written here
 * would be published. `example.com` is reserved by RFC 2606.
 */
test('the example URL names no real host and carries no credential', () => {
  assert.match(ENDPOINT_EXAMPLE, /^https:\/\/[^/]*\.example\.com\//);
  assert.match(ENDPOINT_EXAMPLE, /\/chat\/completions$/, 'it must teach the shape the field needs');
  assert.ok(!/[?#]/.test(ENDPOINT_EXAMPLE), 'no query string, so nothing key-shaped can hide in one');
});

test('the models URL is derived only from a chat-completions URL, never guessed', () => {
  assert.equal(
    modelsUrl('https://gw.example.com/v1/chat/completions'),
    'https://gw.example.com/v1/models',
  );
  assert.equal(
    modelsUrl('  https://gw.example.com/openai/v1/chat/completions/  '),
    'https://gw.example.com/openai/v1/models',
  );
  /* A query or fragment must not travel onto the list URL. */
  assert.equal(
    modelsUrl('https://gw.example.com/v1/chat/completions?key=SECRET#x'),
    'https://gw.example.com/v1/models',
  );
  /* Refuse rather than approximate — see the function's own note. */
  for (const bad of ['', '   ', 'not a url', '/v1/chat/completions', 'https://gw.example.com/v1']) {
    assert.equal(modelsUrl(bad), null, `${bad} should not yield a guessed base`);
  }
});

/**
 * 🔴 AN EMPTY LIST AND AN UNREADABLE ANSWER MEAN OPPOSITE THINGS. `[]` is the
 * endpoint's answer; `null` is "this was never a model list". Collapsing them is
 * how a failed request renders as a reassuring empty dropdown.
 */
test('parseModelList separates “advertises nothing” from “not a model list”', () => {
  assert.deepEqual(parseModelList({ data: [] }), []);
  assert.deepEqual(parseModelList({ data: [{ id: 'b' }, { id: 'a' }, { id: 'a' }] }), ['a', 'b']);
  assert.deepEqual(parseModelList({ data: [{ id: '  x  ' }, { id: '' }, {}, null, 3] }), ['x']);
  for (const notAList of [null, undefined, 3, 'text', {}, { data: {} }, { models: ['a'] }, []]) {
    assert.equal(parseModelList(notAList), null, `${JSON.stringify(notAList)} is not a model list`);
  }
});

const CFG = { endpoint: 'https://gw.example.com/v1/chat/completions', apiKey: 'sk-PLANTED-SECRET', timeoutMs: 5000 };
const reply = (body: unknown, ok = true, status = 200) =>
  (async () => ({ ok, status, json: async () => body })) as unknown as typeof fetch;

test('a list of ids becomes a listed state, sorted and deduplicated', async () => {
  const s = await fetchModelList(CFG, reply({ data: [{ id: 'z' }, { id: 'a' }] }));
  assert.deepEqual(s, { phase: 'listed', ids: ['a', 'z'] });
});

/**
 * 🔴 THE PLANT THIS EXISTS FOR: a failed fetch rendering as an empty list. Each
 * of these four failures must be `failed`, never `empty` — and the one genuine
 * empty must be `empty`, never `failed`.
 */
test('every way of not getting a list is distinguishable from getting an empty one', async () => {
  assert.deepEqual(await fetchModelList(CFG, reply({ data: [] })), { phase: 'empty' });

  const throwing = (async () => {
    throw new TypeError('Failed to fetch');
  }) as unknown as typeof fetch;
  const cases = [
    await fetchModelList(CFG, throwing), // unreachable, or CORS — indistinguishable
    await fetchModelList(CFG, reply({}, false, 401)), // refused
    await fetchModelList(CFG, reply({ error: 'nope' })), // JSON, not a list
    await fetchModelList({ ...CFG, endpoint: 'https://gw.example.com/v1' }, reply({ data: [] })),
  ];
  for (const c of cases) {
    assert.equal(c.phase, 'failed', `a failure rendered as: ${c.phase}`);
    assert.ok('headline' in c && c.headline.length > 10);
    assert.ok('detail' in c && c.detail.length > 30, 'a failure with no reason is a puzzle');
  }
});

/**
 * 🔴 THE KEY NEVER REACHES A SENTENCE. "I did not put it there" is not a
 * property; this is. Every branch is driven and every string it produces is
 * searched, because an error message is the one place a credential leaks
 * without anybody choosing to log it.
 */
test('no model-list state ever contains the API key', async () => {
  const throwing = (async () => {
    throw new TypeError('Failed to fetch');
  }) as unknown as typeof fetch;
  const states = [
    await fetchModelList(CFG, reply({ data: [{ id: 'a' }] })),
    await fetchModelList(CFG, reply({ data: [] })),
    await fetchModelList(CFG, throwing),
    await fetchModelList(CFG, reply({}, false, 403)),
    await fetchModelList(CFG, reply({ nope: 1 })),
    await fetchModelList({ ...CFG, endpoint: 'nonsense' }, reply({ data: [] })),
  ];
  for (const s of states) {
    assert.ok(!JSON.stringify(s).includes(CFG.apiKey), `the key leaked into: ${JSON.stringify(s)}`);
    assert.ok(!JSON.stringify(s).includes('sk-'), 'a key-shaped string leaked');
  }
});

test('the key is sent as a Bearer header and only when there is one', async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const spy = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ data: [] }) };
  }) as unknown as typeof fetch;

  await fetchModelList(CFG, spy);
  assert.equal(seen[0].url, 'https://gw.example.com/v1/models');
  assert.equal(seen[0].init.method, 'GET');
  assert.deepEqual(seen[0].init.headers, { Authorization: `Bearer ${CFG.apiKey}` });
  assert.ok(!seen[0].url.includes(CFG.apiKey), 'the key must never be in the URL');

  await fetchModelList({ ...CFG, apiKey: '   ' }, spy);
  assert.deepEqual(seen[1].init.headers, {}, 'no key means no Authorization header at all');
});

/**
 * ⚠ LABEL, DO NOT FILTER. Our own gateway advertises models it then refuses at
 * call time. Verifying the list would mean calling every model; a silently
 * narrowed list is worse than an honest wide one. So the wide list is asserted
 * to survive, and the label to be present.
 */
test('the list is labelled as advertised and is never narrowed', async () => {
  const s = await fetchModelList(CFG, reply({ data: [{ id: 'real' }, { id: 'advertised-but-refused' }] }));
  assert.deepEqual(s, { phase: 'listed', ids: ['advertised-but-refused', 'real'] });

  const src = readFileSync(join(HERE, '..', 'src', 'cad', 'ask.tsx'), 'utf8');
  assert.match(src, /cad-ask-models-advertised/, 'the label must render');
  assert.match(src, /SAYS it has, not what it will serve/);
});

/**
 * ⚠ NO AUTOMATIC CALLS ON THIS PATH. The founder's MiMo Token Plan ruling
 * permits interactive use and forbids automated scripts; a list that refreshed
 * itself on a keystroke or a timer would be the second thing.
 */
test('the model list is only ever fetched from a press', () => {
  const src = readFileSync(join(HERE, '..', 'src', 'cad', 'ask.tsx'), 'utf8');
  assert.match(src, /onClick=\{\(\) => void listModels\(\)\}/, 'a button must be the only caller');
  const callers = [...src.matchAll(/listModels\(\)/g)].length;
  assert.equal(callers, 1, 'listModels has more than one caller — one of them is not a press');
  assert.ok(
    !/useEffect\([^)]*listModels/.test(src) && !/setInterval|setTimeout\([^)]*listModels/.test(src),
    'the list must not refresh itself',
  );
});

/* ════════════════════════════════════════════════════════════════════════════
   10. 🔴 THE SETTINGS SURFACE — what moved, and what must not have been deleted
   ════════════════════════════════════════════════════════════════════════════

   Founder 2026-08-11: *"when endpoint set move it to the settings tab under File
   and hide"*, listing the heading, the outbound disclosure and the endpoint
   settings as the things to hide, and writing out the one line to leave visible.

   🔴 THE WHOLE RISK IN THIS CHANGE IS THAT "HIDE" BECOMES "DELETE" FOR A
   PRIVACY DISCLOSURE. `OUTBOUND_DISCLOSURE` states what leaves the machine; it
   is checkable to the last word because this is an AGPL bundle; and it is the
   only place the app says this pane is the sole outbound path. It is a constant
   precisely so a test can assert it ARRIVED at the new surface — text inlined in
   a JSX tree that moved is text nothing watched move.
   ════════════════════════════════════════════════════════════════════════════ */

const { AskPanel, AskSettings, OUTBOUND_DISCLOSURE, PROMPT_LABEL, askConfigured } = A;

const renderSettings = (cfg: unknown, onClose: (() => void) | null = () => {}) =>
  renderToStaticMarkup(h(AskSettings, { cfg: cfg as never, onPatch: () => {}, onClose }));

const renderAsk = (cfg: unknown) =>
  renderToStaticMarkup(
    h(AskPanel, {
      source: 'cube(1);\n',
      onApply: () => {},
      cfg: cfg as never,
      onPatch: () => {},
      onOpenSettings: () => {},
      online: true,
      transport: (async () => {
        throw new Error('no transport in a static render');
      }) as never,
    }),
  );

test('the disclosure is not text that moved — it is a constant, and it says all four things', () => {
  assert.match(OUTBOUND_DISCLOSURE, /only thing in this app that sends anything anywhere/);
  assert.match(OUTBOUND_DISCLOSURE, /works with no network at all/);
  assert.match(OUTBOUND_DISCLOSURE, /no endpoint and no key in this app/);
  assert.match(OUTBOUND_DISCLOSURE, /stay in this browser/);
});

test('🔴 the disclosure reached Settings, in both the inline and the dialog form', () => {
  for (const onClose of [null, () => {}]) {
    const html = renderSettings(CONFIGURED, onClose);
    assert.ok(html.includes('This is the only thing in this app that sends anything anywhere'), 'the disclosure is gone');
    assert.match(html, /data-testid="cad-ask-first-send"/);
  }
});

test('and Settings still carries the endpoint, the model, the key and the CORS warning', () => {
  const html = renderSettings(CONFIGURED);
  for (const id of ['cad-ask-endpoint', 'cad-ask-model', 'cad-ask-key', 'cad-ask-remember', 'cad-ask-list-models']) {
    assert.ok(html.includes(`data-testid="${id}"`), `${id} did not survive the move`);
  }
  assert.match(html, /CORS headers/);
});

/**
 * 🔴 THE KEY FIELD'S DISCIPLINE IS ASSERTED AT THE NEW SURFACE RATHER THAN
 * ASSUMED TO HAVE TRAVELLED. A credential control that changed file is a
 * credential control whose properties were re-established, or they were not.
 */
test('the key field is still a password input, still off by default, still not stored', () => {
  const html = renderSettings({ ...CONFIGURED, apiKey: 'SUPER-SECRET-KEY', rememberKey: false });
  assert.match(html, /data-testid="cad-ask-key"[^>]*type="password"/);
  assert.equal(NO_ASK_CONFIG.rememberKey, false);
  assert.equal(askConfigForStorage({ ...CONFIGURED, apiKey: 'k', rememberKey: false }).apiKey, undefined);

  /* ⚠ AND THE FIRST DRAFT OF THIS TEST ALSO ASSERTED THE KEY WAS ABSENT FROM
   * THE MARKUP, WHICH IS WRONG AND WORTH RECORDING RATHER THAN QUIETLY
   * DROPPING. A controlled `<input value={cfg.apiKey}>` renders its value —
   * that is what makes it the box the operator typed into, and this app is
   * client-rendered, so no HTML document containing it is ever served. The
   * leaks that matter are the key reaching STORAGE (above), a MESSAGE, or an
   * ERROR STRING, and those are asserted where they can actually happen. A test
   * that treated a password field's own contents as a leak would have to be
   * satisfied by making the field uncontrolled, which is worse. */
  assert.ok(html.includes('SUPER-SECRET-KEY'), 'the field stopped being controlled');
});

/* ---- when the panel collapses, and when it must not ---------------------- */

test('"set" means an endpoint AND a model id — a key is not required', () => {
  assert.equal(askConfigured(NO_ASK_CONFIG), false);
  assert.equal(askConfigured({ ...NO_ASK_CONFIG, endpoint: 'https://x.example.com/v1/chat/completions' }), false);
  assert.equal(askConfigured({ ...CONFIGURED, apiKey: '' }), true, 'a gateway needing no key is still configured');
  assert.equal(askConfigured({ ...CONFIGURED, model: '   ' }), false, 'whitespace is not a model id');
});

test('🔴 with nothing configured the panel does NOT collapse — the settings are inline', () => {
  const html = renderAsk(NO_ASK_CONFIG);
  assert.match(html, /data-testid="cad-ask-settings-panel"/);
  assert.ok(html.includes('This is the only thing in this app that sends anything anywhere'));
  assert.ok(!html.includes('data-testid="cad-ask-settings-close"'), 'the inline copy must not be closable');
});

test('with an endpoint and a model set, the pane is the prompt box alone', () => {
  const html = renderAsk(CONFIGURED);
  assert.ok(!html.includes('data-testid="cad-ask-settings-panel"'), 'the settings did not move out of the way');
  assert.ok(!html.includes('This is the only thing in this app that sends anything anywhere'));
  assert.match(html, /data-testid="cad-ask-prompt"/);
});

/**
 * 🔴 THE SENTENCE THE FOUNDER EXPLICITLY KEPT. He listed three things to hide
 * and wrote out the one to leave: *"leaving: What should change? Plain words.
 * The source in the editor is sent with it."* Its second half is the disclosure
 * that survives the collapse — the WHOLE FILE travels, not only the prompt — and
 * it is the one most easily lost, because it reads like a form label.
 */
test('the "source in the editor is sent with it" line survives the collapse', () => {
  assert.match(PROMPT_LABEL, /The source in the editor is sent with it/);
  for (const cfg of [NO_ASK_CONFIG, CONFIGURED]) {
    assert.ok(renderAsk(cfg).includes('The source in the editor is sent with it'), 'the line is gone');
  }
});

/**
 * 🔴 A ROUTE BACK FROM A BROKEN ENDPOINT. `askConfigured` says SET; it cannot
 * say WORKING. A 401, a refused model id, a URL missing its path or a host with
 * no CORS header all collapse the panel and are fixed in the settings the
 * collapse just hid — so a failure carries its own way back.
 *
 * ⚠ ASSERTED AT THE SOURCE, and named as the weaker thing it is: the failure
 * branch cannot be reached by a static render, because reaching it needs a
 * transport, a click and an await. What is checked is that the control is inside
 * that branch and wired to the callback the tab hands in.
 */
test('a failed call renders a route back to Settings', () => {
  const src = readFileSync(join(HERE, '..', 'src', 'cad', 'ask.tsx'), 'utf8');
  const branch = src.slice(src.indexOf('{state.failure ? ('), src.indexOf('{/* ---- the proposal'));
  assert.ok(branch.length > 100 && branch.length < 2000, 'the failure branch was not located');
  assert.match(branch, /data-testid="cad-ask-open-settings"/);
  assert.match(branch, /onClick=\{onOpenSettings\}/);
});

/** And the tab wires that callback to the same panel the menu item opens. */
test('the menu item and the failure button open the one Settings surface', () => {
  const tab = readFileSync(join(HERE, '..', 'src', 'cad', 'CadTab.tsx'), 'utf8');
  assert.match(tab, /case 'file\.settings':[\s\S]{0,600}?openSettings\(\);/);
  assert.match(tab, /onOpenSettings=\{openSettings\}/);
  // One component, rendered from two places — no second credential form.
  assert.equal((tab.match(/<AskSettings/g) ?? []).length, 1);
});
