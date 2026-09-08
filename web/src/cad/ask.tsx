// 2bee.cad — asking a model to change the source.
//
// Founder 2026-08-11: *"in the 2bee.cad add a freetext what will call an llm api
// call to change the scad"*.
//
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 THIS IS THE FIRST THING THIS APP EVER SENDS ANYWHERE
// ═══════════════════════════════════════════════════════════════════════════
//
// Before this file, every `fetch` in `web/src/` was same-origin: one sample
// asset and the wasm bundle. The app runs in a shop with no internet and that
// is a property worth keeping, so this feature is built to be ABSENT without a
// connection rather than to make the app depend on one:
//
//   · There is NO endpoint, NO model name and NO key in this bundle. The
//     defaults are empty strings — see {@link NO_ASK_CONFIG} — and with an
//     empty endpoint {@link preflight} refuses before the transport is even
//     constructed. A shop with no internet sees a panel that says it is not
//     configured; nothing times out, nothing retries, nothing blocks.
//   · The endpoint, the model name and the key are the OPERATOR'S, typed by
//     them and held on their machine. This app is AGPL: whatever were baked in
//     here would be published to everyone who runs it, and a shared key in a
//     readable bundle is a published key.
//   · The key is NOT persisted unless the operator explicitly asks for it to
//     be. `localStorage` is readable by anything running on this origin, so
//     "remember it" is a choice with a cost and the checkbox says what the cost
//     is.
//
// ⚠ WHOSE SUBSCRIPTION PAYS IS NOT DECIDED HERE, and deliberately cannot be
// decided here: there is no default endpoint for a decision to hide in. If this
// lane wants to point it at a company gateway that is a value typed into a
// field (or a documented instruction), not a constant in a file that ships to
// everyone.
//
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 A MODEL EDIT IS A PROPOSAL, NEVER AN APPLICATION
// ═══════════════════════════════════════════════════════════════════════════
//
// `CadTab.tsx` and `open.tsx` say in three places that there is no undo and no
// server copy. A model that overwrites the editor is therefore data loss, and
// "we only overwrite after the user clicks" is a convention. This file makes it
// a construction:
//
//   · The panel is given the source as a STRING and a callback. It holds no
//     setter for the editor and cannot reach one.
//   · Every state transition goes through {@link askReducer}, which is pure and
//     exported. {@link applicationOf} is the ONLY function that can produce text
//     for the editor, and it returns `kind: 'model-proposal'` from exactly one
//     action — `accept`. A reply arriving, a review completing, a failure, a
//     timeout: none of them can produce one. That is a property a test can
//     enumerate rather than a rule a reviewer has to spot.
//   · Accepting REPLACES the editor, and the text it replaced can be put back.
//     ⚠ 2026-08-11: THAT MECHANISM IS NO LONGER THIS FILE'S. It was built here
//     first — a `replaced` field, a `restore` action and a button on this pane —
//     and it turned out to be the right answer for every replacement in the tab,
//     not just this one. It now lives in `replace.ts`, driven by `CadTab.tsx`,
//     which stashes the editor's text on `New`, `Example`, `Open` AND an
//     accepted proposal and offers ONE put-back control. Two put-back buttons
//     over two different stashes is how an operator presses the one that puts
//     back the wrong thing, so this pane no longer has one.
//     ⚠ It was never an undo for typing and still is not.
//
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 THE PROPOSAL GOES THROUGH THE SAME PARSER AND THE SAME AUDIT
// ═══════════════════════════════════════════════════════════════════════════
//
// There is no special path for model output. {@link reviewProposal} calls the
// same `parseScad` and the same `meshScene` the editor calls, and the review
// shown before acceptance carries:
//
//   · EVERY refused construct, by name and by line. That is the tab's whole
//     contract — a refusal is geometry the source has and the tree does not —
//     and a model is more likely than a human to reach for `minkowski()`,
//     `text()` or a list comprehension, because it has read all of OpenSCAD and
//     none of our subset.
//   · Whether the mesh audit stands behind it. This app already refuses to draw
//     what the audit cannot vouch for; a proposal is held to the same bar.
//   · 🔴 WHETHER IT PARSES TO SOMETHING THE CURRENT SOURCE DID NOT. A model
//     will happily return SCAD that parses cleanly, audits closed, and
//     describes a DIFFERENT PART — confidently. Nothing about a clean parse
//     catches that. So the review compares solids, triangles and the bounding
//     box against the source being replaced, and says the delta in millimetres.
//     *A picture that lies about a shape is worse than no picture*, arriving in
//     a new way.
//
// Failures are states with sentences, not spinners: not configured, no key,
// offline, refused with a status, a timeout, a reply that is not JSON, a reply
// in a shape we do not read, a reply that is not SCAD, a reply that parses to
// nothing. Each names what happened and none of them touch the editor.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parseScad, type ScadError, type ScadResult, type Unsupported } from './scad';
import { meshScene, type MeshResult } from './mesh';

/* ════════════════════════════════════════════════════════════════════════════
 * 1. Configuration — the operator's, held locally, defaulting to nothing
 * ══════════════════════════════════════════════════════════════════════════ */

export interface AskConfig {
  /** Full URL of an OpenAI-protocol chat-completions endpoint. Empty = unset. */
  endpoint: string;
  /** The model id to ask for. Empty = unset; there is no fallback. */
  model: string;
  /** Sent as `Authorization: Bearer …`. Empty = unset. */
  apiKey: string;
  /** Persist {@link apiKey} in this browser. Default FALSE. */
  rememberKey: boolean;
  /** Give up after this many milliseconds. */
  timeoutMs: number;
}

/**
 * 🔴 THE DEFAULT IS NOTHING, AND THAT IS THE SAFETY PROPERTY.
 *
 * No endpoint, no model, no key, and the key is not remembered. A test asserts
 * these three fields are empty and that no URL-shaped literal or key-shaped
 * prefix appears anywhere in `web/src/` — because a default that reached the
 * bundle would be published by AGPL §13 to everyone who ever runs this page,
 * and would silently answer a question ("whose subscription pays") that is not
 * a code question.
 */
export const NO_ASK_CONFIG: AskConfig = {
  endpoint: '',
  model: '',
  apiKey: '',
  rememberKey: false,
  timeoutMs: 60000,
};

/** Follows the `2bee.app.*` single-JSON-key precedent in `CadTab.tsx`. */
export const ASK_CONFIG_KEY = '2bee.app.cad.ask';

/** A `localStorage`-shaped thing. Injected so the rules can be tested in node. */
export interface AskStore {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * Read the stored configuration, validating every field at the point of use so
 * one corrupt entry cannot discard the rest.
 *
 * ⚠ A stored key is only returned when the stored record ALSO says it was meant
 * to be remembered. A record written by an older build, or hand-edited, does
 * not get to opt the operator in silently.
 */
export function readAskConfig(store?: AskStore | null): AskConfig {
  try {
    const raw = store?.getItem(ASK_CONFIG_KEY);
    if (!raw) return NO_ASK_CONFIG;
    const v = JSON.parse(raw) as Record<string, unknown> | null;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return NO_ASK_CONFIG;
    const rememberKey = v.rememberKey === true;
    const timeoutMs =
      typeof v.timeoutMs === 'number' && Number.isFinite(v.timeoutMs) && v.timeoutMs > 0
        ? Math.min(600000, Math.max(1000, v.timeoutMs))
        : NO_ASK_CONFIG.timeoutMs;
    return {
      endpoint: str(v.endpoint),
      model: str(v.model),
      apiKey: rememberKey ? str(v.apiKey) : '',
      rememberKey,
      timeoutMs,
    };
  } catch {
    return NO_ASK_CONFIG;
  }
}

/** What is actually written. The key is omitted unless it was asked for. */
export function askConfigForStorage(cfg: AskConfig): Record<string, unknown> {
  return {
    endpoint: cfg.endpoint,
    model: cfg.model,
    rememberKey: cfg.rememberKey,
    timeoutMs: cfg.timeoutMs,
    ...(cfg.rememberKey && cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
  };
}

export function writeAskConfig(cfg: AskConfig, store?: AskStore | null): void {
  try {
    store?.setItem(ASK_CONFIG_KEY, JSON.stringify(askConfigForStorage(cfg)));
  } catch {
    /* A browser with storage disabled loses the preference and nothing else. */
  }
}

/* ════════════════════════════════════════════════════════════════════════════
 * 1b. Listing the models an endpoint ADVERTISES
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * The shape of a chat-completions URL, shown as a PLACEHOLDER and never as a
 * value (founder, 2026-08-11: *"have an example url"*).
 *
 * 🔴 A PLACEHOLDER, NOT A DEFAULT. An example that is pre-filled becomes a
 * setting nobody chose, and the first thing it would do is send the operator's
 * source to a host they never picked. `NO_ASK_CONFIG.endpoint` stays `''`, so
 * {@link preflight} still refuses on a fresh browser.
 *
 * 🔴 AND THE HOST IS RESERVED, ON PURPOSE. `example.com` is reserved by RFC 2606
 * and can never resolve to anything. This file ships in an AGPL bundle to
 * everybody who runs the app: a real gateway hostname written here would be
 * published, and a published internal hostname is an invitation whether or not
 * it carries a key.
 */
export const ENDPOINT_EXAMPLE = 'https://your-gateway.example.com/v1/chat/completions';

/**
 * The `/v1/models` URL implied by a chat-completions URL, or `null`.
 *
 * ⚠ IT REFUSES RATHER THAN GUESSES A BASE. Only a URL that actually ends in
 * `/chat/completions` — which is exactly what the field above asks for — yields
 * a list URL. Anything else returns `null` and the UI says it cannot derive one,
 * because a base invented from a URL of unknown shape would produce a confident
 * 404 that reads as "your gateway is broken".
 */
export function modelsUrl(endpoint: string): string | null {
  const raw = endpoint.trim();
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const suffix = '/chat/completions';
  const path = u.pathname.replace(/\/+$/, '');
  if (!path.endsWith(suffix)) return null;
  u.pathname = `${path.slice(0, -suffix.length)}/models`;
  u.search = '';
  u.hash = '';
  return u.toString();
}

/**
 * The ids in an OpenAI-protocol `/v1/models` body.
 *
 * 🔴 `[]` AND `null` ARE DIFFERENT ANSWERS AND THE CALLER MUST TREAT THEM SO.
 * `[]` is "a well-formed list containing nothing"; `null` is "this is not a
 * model list at all" — a login page, an HTML error, a proxy's JSON. Collapsing
 * them is how a failed request renders as a reassuring empty dropdown.
 */
export function parseModelList(body: unknown): string[] | null {
  if (!body || typeof body !== 'object') return null;
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return null;
  const ids: string[] = [];
  for (const e of data) {
    const id = e && typeof e === 'object' ? (e as { id?: unknown }).id : undefined;
    if (typeof id === 'string' && id.trim()) ids.push(id.trim());
  }
  return [...new Set(ids)].sort();
}

/**
 * What the model list currently is.
 *
 * 🔴 `empty` AND `failed` ARE SEPARATE STATES. An endpoint that advertises
 * nothing and an endpoint that could not be reached produce the same empty
 * `<select>` and mean opposite things — absence rendered as a reassuring state,
 * which is the failure mode this lane keeps finding in its own controls.
 */
export type ModelListState =
  | { phase: 'idle' }
  | { phase: 'asking' }
  | { phase: 'listed'; ids: string[] }
  | { phase: 'empty' }
  | { phase: 'failed'; headline: string; detail: string };

/**
 * Ask the endpoint what it advertises.
 *
 * 🔴 THE ANSWER IS "ADVERTISED", NOT "WILL BE SERVED", AND THE UI SAYS SO.
 * A recorded fleet finding: our own gateway's `/v1/models` lists models it then
 * refuses at call time, and the refusal points back at the same list as if it
 * were authoritative. **The list is therefore LABELLED, never FILTERED** — the
 * only way to filter it honestly would be to call every model, and a silently
 * narrowed list is worse than an honest wide one.
 *
 * 🔴 THE KEY NEVER REACHES A MESSAGE. Every sentence below is built from the
 * status and the derived URL, and the derived URL is the endpoint field with its
 * path swapped — it has never held the key. A test asserts this over every
 * branch, because "I did not put it there" is not a property.
 *
 * ⚠ THIS IS CALLED FROM A BUTTON AND FROM NOTHING ELSE. No polling, no retry,
 * no call on a keystroke: the founder's standing ruling on the MiMo Token Plan
 * permits interactive use and forbids automated scripts, and a list that
 * refreshed itself would be the second thing.
 */
export async function fetchModelList(
  cfg: Pick<AskConfig, 'endpoint' | 'apiKey' | 'timeoutMs'>,
  f: typeof fetch,
): Promise<ModelListState> {
  const url = modelsUrl(cfg.endpoint);
  if (!url) {
    return {
      phase: 'failed',
      headline: 'no model list can be asked for from this endpoint',
      detail:
        'The list lives at /v1/models beside the chat endpoint, so it can only be worked out from a ' +
        'URL ending in /chat/completions. Nothing was sent. Fix the endpoint above, or type the ' +
        'model id by hand — that always works.',
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  let res: Response;
  try {
    res = await f(url, {
      method: 'GET',
      headers: cfg.apiKey.trim() ? { Authorization: `Bearer ${cfg.apiKey.trim()}` } : {},
      signal: controller.signal,
    });
  } catch {
    return {
      phase: 'failed',
      headline: `nothing answered at ${url}`,
      detail:
        'Either the host is unreachable, or it does not send CORS headers that allow this page — a ' +
        'browser cannot tell those apart and neither can this. Nothing about your source was sent. ' +
        'Type the model id by hand instead.',
    };
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    return {
      phase: 'failed',
      headline: `the endpoint would not list its models (HTTP ${res.status})`,
      detail:
        'A 401 or 403 is usually the key; a 404 usually means this gateway does not offer /models ' +
        'at all. Neither stops you typing the model id by hand.',
    };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return {
      phase: 'failed',
      headline: 'the answer was not JSON',
      detail:
        'Something answered, and it was not a model list — a login page and a proxy error both look ' +
        'like this. Type the model id by hand.',
    };
  }

  const ids = parseModelList(body);
  if (ids === null) {
    return {
      phase: 'failed',
      headline: 'the answer was JSON, but not a model list',
      detail:
        'An OpenAI-protocol /v1/models reply has a data array of objects with an id. This did not. ' +
        'Nothing was guessed out of it. Type the model id by hand.',
    };
  }
  return ids.length === 0 ? { phase: 'empty' } : { phase: 'listed', ids };
}

/* ════════════════════════════════════════════════════════════════════════════
 * 2. The request — exactly the prompt and the source, and a test says so
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * The whole of what this app tells the model about itself.
 *
 * ⚠ It is a CONSTANT, not a template, and it carries no fact about the
 * operator, the machine, the saved drawings or the session. The transmission
 * summary shown in the UI is generated from the request that will actually be
 * sent, so this text is on screen before anything leaves.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 🔴 THIS LIST IS AN ASSERTION ABOUT ANOTHER FILE, AND IT WAS WRONG FIVE TIMES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Measured 2026-08-11 by running every name below through `parseScad` (the
 * probe is now `tests/cad-ask.test.ts`, so this cannot rot again in silence).
 * The forbidden list named FIVE constructs the parser accepts:
 *
 *   · `color`   — accepted then, and as of this change it genuinely WORKS.
 *   · `render`  — a pass-through. Always was.
 *   · `#`       — a pass-through carrying real geometry, as in OpenSCAD's export.
 *   · `!`       — implemented: the subtree becomes the whole model.
 *   · `*`       — implemented, and byte-exact with OpenSCAD.
 *
 * Only `%` of the four modifier characters is genuinely refused.
 *
 * 🔴 THE COST WAS NOT HYPOTHETICAL AND IT IS THE REASON THIS COMMENT IS LONG.
 * The founder asked a model to *"change the objects to red"*. It obeyed the ban
 * on `color`, returned the file COMPLETELY UNCHANGED, and every downstream
 * control agreed that nothing was wrong — because nothing was. A prompt that
 * misdescribes the tool does not produce a visible error; it produces a
 * confident, well-formed, USELESS answer, and the operator concludes the model
 * is stupid. **A ban costs a capability silently; a missing entry costs a
 * refusal that is at least reported.** So the list errs toward naming only what
 * was measured to refuse.
 *
 * ⚠ THE "Implemented" LINE IS A SUMMARY AND NOT AN INVENTORY. It names what a
 * model most needs to know it may reach for. `include`/`use`, `children()`, the
 * math functions, the `is_*` predicates and `.x`/`.y`/`.z` also work and are
 * left out to keep the instruction short; leaving something out costs a
 * construct that goes unused, which is the cheap direction.
 */
export const SYSTEM_INSTRUCTION = [
  'You edit OpenSCAD-style source for a tool called 2bee.cad, which implements a SUBSET of the',
  'OpenSCAD language. Reply with the COMPLETE new source file and nothing else — no prose, no',
  'explanation. A single fenced code block is acceptable.',
  'Units are millimetres and degrees.',
  'Implemented: cube, sphere, cylinder, square, circle; translate, rotate, scale; union,',
  'difference, intersection; for, if, let, variables, user modules and functions; $fn, $fa, $fs;',
  'color(c, alpha) with CSS colour names, "#rrggbb" hex and [r,g,b] / [r,g,b,a] vectors — colour is',
  'carried to the picture, and the OUTERMOST color() wins over a nested one, as in OpenSCAD;',
  'render(), and the * ! # modifier characters.',
  'NOT implemented and refused by name:',
  'import, list comprehensions, function literals, rotate(a, v) axis-angle, and',
  'the % modifier character. Do not use them.',
].join(' ');

/**
 * Every construct name the instruction above forbids, as data.
 *
 * 🔴 IT EXISTS SO THE CLAIM CAN BE CHECKED RATHER THAN READ. The list was wrong
 * for as long as it was prose, because prose is not something a test can put in
 * front of `parseScad`. `tests/cad-ask.test.ts` runs each entry through the
 * parser and fails if any of them is accepted — and separately fails if this
 * array and the sentence above stop agreeing, since two copies of a list is how
 * one of them starts lying.
 */
export const FORBIDDEN_CONSTRUCTS: readonly string[] = [
  // hull is now handled — see mesh.ts.
  // minkowski is now handled — see mesh.ts.
  // offset is now handled — see scad.ts evaluator.
  // projection is now handled — see mesh.ts.
  // linear_extrude is now handled — see scad.ts evaluator.
  // rotate_extrude is now handled — see mesh.ts.
  // polyhedron is now handled — see mesh.ts.
  // polygon is now handled — see scad.ts evaluator.
  // surface is now handled — see mesh.ts.
  'import',
  // text is now handled — see scad.ts evaluator.
  // mirror is now handled — see mesh.ts transform evaluator.
  // multmatrix is now handled — see mesh.ts.
  // resize is now handled — see the evaluator and mesh.ts.
  // echo is now handled — see the evaluator.
  // assert is now handled — see the evaluator.
  // intersection_for is now handled — see the evaluator.
];

/** The user turn: the operator's words, then the source they are about. */
export function userMessage(prompt: string, source: string): string {
  return `${prompt}\n\n----- current 2bee.cad source -----\n${source}`;
}

export interface AskRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  /** Structured, not stringified, so a test can assert its exact key set. */
  body: {
    model: string;
    messages: { role: 'system' | 'user'; content: string }[];
    temperature: number;
    stream: false;
  };
}

/**
 * 🔴 EVERY BYTE THAT LEAVES IS BUILT HERE AND NOWHERE ELSE.
 *
 * Two messages, both derived from arguments the operator supplied. No app
 * version, no session, no saved drawing, no counts, no timing, no identifier.
 * The transmission summary the panel renders is produced from the return value
 * of this function, so what is shown and what is sent cannot drift apart.
 */
export function buildRequest(cfg: AskConfig, prompt: string, source: string): AskRequest {
  return {
    url: cfg.endpoint,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
    },
    body: {
      model: cfg.model,
      messages: [
        { role: 'system', content: SYSTEM_INSTRUCTION },
        { role: 'user', content: userMessage(prompt, source) },
      ],
      temperature: 0,
      stream: false,
    },
  };
}

/**
 * What the operator is told is about to leave, in their words.
 *
 * The key is named as present and never printed: the point is to say that a
 * credential is being sent, not to put it on a shared screen.
 */
export function transmissionSummary(req: AskRequest, source: string, prompt: string): string[] {
  return [
    `POST to ${req.url || '(no endpoint configured)'}`,
    req.headers.authorization
      ? 'your API key, as an Authorization: Bearer header (not shown here)'
      : 'no Authorization header — nothing is being sent as a credential',
    `the model id you typed: ${req.body.model || '(none)'}`,
    `a fixed instruction describing the 2bee.cad subset (${SYSTEM_INSTRUCTION.length} characters, shown below)`,
    `your request, exactly as you typed it (${prompt.length} characters)`,
    `the source in the editor, in full (${source.length} characters, ${source.split('\n').length} lines)`,
    'and NOTHING else — no saved drawings, no machine or tooling settings, no identifier, no telemetry',
  ];
}

/* ════════════════════════════════════════════════════════════════════════════
 * 3. The transport seam
 * ══════════════════════════════════════════════════════════════════════════ */

export interface AskTransportResult {
  status: number;
  ok: boolean;
  /** The response body as text. Parsed by {@link readReply}, never here. */
  text: string;
}

export type AskTransport = (req: AskRequest, signal: AbortSignal) => Promise<AskTransportResult>;

/**
 * The real one. `fetch`, with the body serialised here so the structured body
 * above is the single description of what is sent.
 *
 * 🔴 NO BYTE BUILT BY THIS FILE HAS EVER LEFT A MACHINE. There is no network
 * from the box this was written on; everything below is exercised in node
 * against an injected transport. Same standing as `run/transport.ts`: the fake
 * can confirm the pipeline agrees with our reading of the protocol, and it
 * cannot discover that our reading is wrong.
 */
export const fetchTransport: AskTransport = async (req, signal) => {
  const res = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: JSON.stringify(req.body),
    signal,
  });
  return { status: res.status, ok: res.ok, text: await res.text() };
};

/* ════════════════════════════════════════════════════════════════════════════
 * 4. Failures — each one a state with a sentence
 * ══════════════════════════════════════════════════════════════════════════ */

export type AskFailureKind =
  | 'no-endpoint'
  | 'no-model'
  | 'no-key'
  | 'no-prompt'
  | 'offline'
  | 'network'
  | 'refused'
  | 'timeout'
  | 'not-json'
  | 'no-content'
  | 'empty'
  | 'not-scad'
  | 'parses-to-nothing'
  | 'unchanged';

export interface AskFailure {
  kind: AskFailureKind;
  headline: string;
  detail: string;
}

/**
 * Everything that can be known before anything is sent.
 *
 * ⚠ `online` is passed in rather than read from `navigator`, so both branches
 * can be exercised — and because `navigator.onLine === true` means "this
 * machine has a network interface", never "the endpoint is reachable". A false
 * is trustworthy; a true is not, which is why the reachability failures below
 * exist as well.
 */
export function preflight(cfg: AskConfig, prompt: string, online: boolean): AskFailure | null {
  if (!cfg.endpoint.trim()) {
    return {
      kind: 'no-endpoint',
      headline: 'no endpoint is configured, so nothing can be asked',
      detail:
        'This app ships with no endpoint, no model name and no key, on purpose: it is AGPL, so ' +
        'anything baked into the bundle would be published to everyone who runs it. Put an ' +
        'OpenAI-protocol chat-completions URL in the settings above. Until you do, this panel sends ' +
        'nothing and the rest of the tab works exactly as it does offline.',
    };
  }
  if (!cfg.model.trim()) {
    return {
      kind: 'no-model',
      headline: 'no model id is configured',
      detail:
        'The endpoint needs to be told which model to use and there is no default here — a guess ' +
        'would be a request that fails with somebody else’s error message.',
    };
  }
  if (!cfg.apiKey.trim()) {
    return {
      kind: 'no-key',
      headline: 'no API key is configured',
      detail:
        'The key is yours and is held on this machine. If your endpoint genuinely needs no key, ' +
        'this is still a refusal rather than a silent unauthenticated request: sending a request ' +
        'you did not know was unauthenticated is how a key ends up in a log somewhere else.',
    };
  }
  if (!prompt.trim()) {
    return {
      kind: 'no-prompt',
      headline: 'say what you want changed',
      detail: 'An empty request would send your whole source to a third party for no reason.',
    };
  }
  if (!online) {
    return {
      kind: 'offline',
      headline: 'this browser reports no network',
      detail:
        'Nothing was sent. This feature is absent without a connection and the rest of the tab is ' +
        'not: the editor, the parser, the mesh audit and the drawings list all work offline, and ' +
        'always will.',
    };
  }
  return null;
}

/** A thrown fetch is one of two very different things, and the difference matters. */
export function classifyThrow(err: unknown): AskFailure {
  const name = (err as { name?: string } | null)?.name ?? '';
  if (name === 'AbortError' || name === 'TimeoutError') {
    return {
      kind: 'timeout',
      headline: 'the request was given up on',
      /* ⚠ IT DOES NOT SAY "the editor is untouched" — the box that renders every
       * failure appends exactly that sentence to all of them, so saying it here
       * printed it twice in one paragraph. The invariant lives at the renderer,
       * where a failure kind added later inherits it; a copy in the detail is a
       * second statement that can only ever go out of step. */
      detail:
        'Either it hit the timeout or you stopped it. Nothing came back. If the endpoint is slow ' +
        'rather than dead, raise the timeout in the settings.',
    };
  }
  return {
    kind: 'network',
    headline: 'the request never reached an endpoint',
    detail:
      `The browser refused or failed the request before any status came back (${String(
        (err as { message?: string } | null)?.message ?? err,
      )}). The three ordinary causes are: there is no route to that host from here; the URL is ` +
      'wrong; or the endpoint does not send CORS headers, in which case the browser blocks the ' +
      'reply even though the server answered. A browser cannot tell you which — that is a limit of ' +
      'the platform, not of this app.',
  };
}

/**
 * Pull the source out of a reply.
 *
 * Models fence code even when told not to. A fence is taken when there is one;
 * otherwise the whole text is taken. Nothing is repaired and nothing is
 * guessed — whatever comes back is put through the parser, and the parser is
 * what decides whether it is usable.
 */
export function extractScad(text: string): string {
  const fence = /```[a-zA-Z]*\r?\n([\s\S]*?)```/.exec(text);
  const body = fence ? fence[1] : text;
  return normaliseForComparison(body);
}

/**
 * 🔴 THE ONE FUNCTION BOTH SIDES OF THE "IS IT UNCHANGED?" TEST GO THROUGH.
 *
 * It exists because they did not. `extractScad` stripped trailing whitespace
 * from the REPLY and nothing stripped it from the EDITOR'S TEXT, so a model that
 * returned the source verbatim produced two strings differing by ONE NEWLINE —
 * 577 characters against 576 — and `reviewProposal`'s `unchanged` guard, which
 * is a plain `===`, reported the proposal as acceptable. Measured against a live
 * reply on 2026-08-11.
 *
 * ⚠ THE GUARD WAS CORRECT AND WAS DEFEATED BY THE APP'S OWN NORMALISATION. That
 * is the shape worth remembering: nothing failed, no branch was missed, and a
 * one-sided cleanup made two equal things unequal. Any comparison between text
 * that came from a model and text that came from the editor goes through here,
 * and there is exactly one of these so the two sides cannot drift again.
 *
 * ⚠ IT IS DELIBERATELY NOT A "SEMANTIC" COMPARISON. It removes a leading blank
 * line and trailing whitespace and NOTHING else — not indentation, not interior
 * blank lines, not comments. A no-op that only LOOKS like one is a change the
 * operator must still see in the diff.
 */
export function normaliseForComparison(text: string): string {
  return text.replace(/^\s*\n/, '').replace(/\s+$/, '');
}

export type AskReply =
  | { ok: true; scad: string; raw: string }
  | { ok: false; failure: AskFailure };

/** Turn a transport result into source, or into a sentence. */
export function readReply(r: AskTransportResult): AskReply {
  if (!r.ok) {
    let why: string;
    try {
      const j = JSON.parse(r.text) as { error?: { message?: string } | string } | null;
      const e = j?.error;
      why = typeof e === 'string' ? e : (e?.message ?? '');
    } catch {
      why = r.text.slice(0, 400);
    }
    return {
      ok: false,
      failure: {
        kind: 'refused',
        headline: `the endpoint refused the request (HTTP ${r.status})`,
        detail:
          /* See `classifyThrow`: the failure box already appends "The editor is
           * untouched." to every detail, so this one no longer says it too. */
          (why ? `It said: ${why}. ` : 'It gave no reason. ') +
          'A 401 or 403 is usually the key; a 404 is usually the URL missing its ' +
          '/chat/completions path; a 400 is usually the model id.',
      },
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(r.text);
  } catch {
    return {
      ok: false,
      failure: {
        kind: 'not-json',
        headline: 'the reply was not JSON',
        detail:
          `HTTP ${r.status}, and the body does not parse as JSON. That is usually a proxy or a ` +
          `login page answering instead of the model. The first 200 characters were: ${JSON.stringify(
            r.text.slice(0, 200),
          )}`,
      },
    };
  }

  const content = (parsed as { choices?: { message?: { content?: unknown } }[] } | null)?.choices?.[0]
    ?.message?.content;
  if (typeof content !== 'string') {
    return {
      ok: false,
      failure: {
        kind: 'no-content',
        headline: 'the reply was JSON, but not in the shape this app reads',
        detail:
          'This panel reads exactly one shape — the OpenAI chat-completions shape, ' +
          '`choices[0].message.content` as a string — and refuses anything else rather than ' +
          'hunting through the object for something that looks like code. If your endpoint speaks ' +
          'a different protocol it needs a different reader, not a guess.',
      },
    };
  }

  const scad = extractScad(content);
  if (!scad.trim()) {
    return {
      ok: false,
      failure: {
        kind: 'empty',
        headline: 'the reply contained no source',
        /* Same as above — the failure box supplies "The editor is untouched." */
        detail: 'The endpoint answered and the answer had nothing in it once the prose was stripped.',
      },
    };
  }
  return { ok: true, scad, raw: content };
}

/* ════════════════════════════════════════════════════════════════════════════
 * 5. The review — the same parser, the same audit, and a comparison
 * ══════════════════════════════════════════════════════════════════════════ */

export interface Bounds {
  min: [number, number, number];
  max: [number, number, number];
}

/** Union of every part's bounds. `null` when nothing had any. */
export function meshBounds(mesh: MeshResult): Bounds | null {
  let out: Bounds | null = null;
  for (const p of mesh.parts) {
    if (!p.bounds) continue;
    if (!out) {
      out = { min: [...p.bounds.min], max: [...p.bounds.max] };
      continue;
    }
    for (let i = 0; i < 3; i++) {
      out.min[i] = Math.min(out.min[i], p.bounds.min[i]);
      out.max[i] = Math.max(out.max[i], p.bounds.max[i]);
    }
  }
  return out;
}

const dim = (b: Bounds | null, i: number): number => (b ? b.max[i] - b.min[i] : 0);

/** One evaluated source: the parse, the mesh, and nothing derived twice. */
export interface Evaluated {
  source: string;
  parse: ScadResult;
  mesh: MeshResult;
}

export function evaluate(source: string): Evaluated {
  const parse = parseScad(source);
  return { source, parse, mesh: meshScene(parse.scene) };
}

export type DiffOp = 'same' | 'add' | 'remove';
export interface DiffLine {
  op: DiffOp;
  text: string;
  /** 1-based line in the source it came from. */
  line: number;
}

/**
 * Line diff, no dependency (`TODO.md` #12 makes every lockfile addition a
 * licence review against AGPL-3.0-or-later, and a diff is an LCS table).
 *
 * ⚠ Capped. A quadratic table over two very long files is a hung tab, and a
 * hung tab in this app is a defect. Past the cap the caller is told there is no
 * diff rather than shown a truncated one that reads as complete.
 */
export const DIFF_LINE_CAP = 1500;

export function diffLines(a: string, b: string): DiffLine[] | null {
  const A = a.split('\n');
  const B = b.split('\n');
  if (A.length > DIFF_LINE_CAP || B.length > DIFF_LINE_CAP) return null;

  const n = A.length;
  const m = B.length;
  // lcs[i][j] = length of the longest common subsequence of A[i:] and B[j:]
  const lcs = new Int32Array((n + 1) * (m + 1));
  const at = (i: number, j: number) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[at(i, j)] =
        A[i] === B[j] ? lcs[at(i + 1, j + 1)] + 1 : Math.max(lcs[at(i + 1, j)], lcs[at(i, j + 1)]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      out.push({ op: 'same', text: A[i], line: j + 1 });
      i++;
      j++;
    } else if (lcs[at(i + 1, j)] >= lcs[at(i, j + 1)]) {
      out.push({ op: 'remove', text: A[i], line: i + 1 });
      i++;
    } else {
      out.push({ op: 'add', text: B[j], line: j + 1 });
      j++;
    }
  }
  while (i < n) out.push({ op: 'remove', text: A[i], line: ++i });
  while (j < m) out.push({ op: 'add', text: B[j], line: ++j });
  return out;
}

export interface ShapeDelta {
  solidsBefore: number;
  solidsAfter: number;
  trianglesBefore: number;
  trianglesAfter: number;
  before: Bounds | null;
  after: Bounds | null;
  /** True when anything measurable about the evaluated geometry moved. */
  changed: boolean;
  /** Per-axis size change in mm, `after - before`. */
  sizeDeltaMm: [number, number, number];
  /** Written for the person deciding whether to accept. */
  sentence: string;
}

const EPS_MM = 1e-6;

/**
 * 🔴 THE CHECK NOTHING ELSE MAKES.
 *
 * A clean parse and a `closed` audit say the proposal is a valid solid. They
 * say nothing about it being the solid you asked for, and a model returns a
 * confident, well-formed, *different part* as readily as a correct one. This
 * compares the evaluated geometry — not the text — against what is being
 * replaced, and reports the delta in millimetres.
 *
 * ⚠ It is an INSTRUMENT, not a verdict. A change is exactly what was asked for
 * most of the time; the point is that the operator sees the size of it before
 * accepting, rather than discovering it at a spindle.
 */
export function shapeDelta(before: Evaluated, after: Evaluated): ShapeDelta {
  const b = meshBounds(before.mesh);
  const a = meshBounds(after.mesh);
  const size: [number, number, number] = [
    dim(a, 0) - dim(b, 0),
    dim(a, 1) - dim(b, 1),
    dim(a, 2) - dim(b, 2),
  ];
  const solidsMoved = before.mesh.stats.solids !== after.mesh.stats.solids;
  const trisMoved = before.mesh.stats.triangles !== after.mesh.stats.triangles;
  const sizeMoved = size.some((d) => Math.abs(d) > EPS_MM);
  const originMoved =
    (b === null) !== (a === null) ||
    (!!b && !!a && b.min.some((v, i) => Math.abs(v - a.min[i]) > EPS_MM));
  const changed = solidsMoved || trisMoved || sizeMoved || originMoved;

  const fmt = (d: number) => `${d >= 0 ? '+' : ''}${d.toFixed(2)}`;
  const sentence = !changed
    ? 'The evaluated geometry is IDENTICAL — same solid count, same triangle count, same bounding ' +
      'box. The text changed and the shape did not. That is either a comment-only edit or a change ' +
      'that did nothing, and only you can tell which.'
    : `Solids ${before.mesh.stats.solids} → ${after.mesh.stats.solids}, triangles ` +
      `${before.mesh.stats.triangles} → ${after.mesh.stats.triangles}, bounding box ` +
      `${fmt(size[0])} × ${fmt(size[1])} × ${fmt(size[2])} mm. A clean parse and a closed audit do ` +
      'NOT mean this is the part you asked for — they mean it is a valid solid. Read the numbers.';

  return {
    solidsBefore: before.mesh.stats.solids,
    solidsAfter: after.mesh.stats.solids,
    trianglesBefore: before.mesh.stats.triangles,
    trianglesAfter: after.mesh.stats.triangles,
    before: b,
    after: a,
    changed,
    sizeDeltaMm: size,
    sentence,
  };
}

export interface ProposalReview {
  proposed: Evaluated;
  /** EVERY construct the parser refused in the proposal — not just the new ones. */
  refused: Unsupported[];
  /** Refusals the mesher added — a 2D operand in a boolean, and its kin. */
  meshRefused: { name: string; line: number; detail: string }[];
  errors: ScadError[];
  /** Names refused in the proposal that were NOT refused in the current source. */
  newRefusalNames: string[];
  shape: ShapeDelta;
  diff: DiffLine[] | null;
  /** Non-null ⇒ acceptance is refused outright, with this sentence. */
  blocked: AskFailure | null;
  /** Must be read before accepting. Never empty when anything is off. */
  cautions: string[];
}

/**
 * Everything the operator is shown before the accept button means anything.
 *
 * ⚠ `blocked` is deliberately narrow: it fires only where accepting could not
 * be what anyone wanted (nothing parsed, nothing changed). Refusals, errors and
 * a shape that moved are CAUTIONS — they are shown, they are not decided. A
 * proposal that drops a `minkowski()` may be exactly right; a proposal that
 * evaluates to nothing never is.
 */
export function reviewProposal(current: Evaluated, proposalSource: string): ProposalReview {
  const proposed = evaluate(proposalSource);
  const refused = proposed.parse.unsupported;
  const meshRefused = proposed.mesh.issues
    .filter((i) => i.severity === 'refused')
    .map((i) => ({ name: i.name, line: i.line, detail: i.detail }));
  const currentNames = new Set(current.parse.unsupported.map((u) => u.name));
  const newRefusalNames = [...new Set(refused.map((u) => u.name))].filter((n) => !currentNames.has(n));
  const shape = shapeDelta(current, proposed);

  let blocked: AskFailure | null = null;
  /* 🔴 BOTH SIDES THROUGH THE SAME FUNCTION. Comparing the raw strings compared
   * a value that had been through `extractScad` against one that had not, and
   * a trailing newline was enough to make an identical reply pass as a
   * proposal. See {@link normaliseForComparison}. */
  if (normaliseForComparison(proposalSource) === normaliseForComparison(current.source)) {
    blocked = {
      kind: 'unchanged',
      headline: 'the reply is your current source, to the last character that matters',
      detail:
        'The model returned exactly what it was given — the only difference, if any, is blank space at the ' +
        'very start or end. There is nothing to accept, and applying it would be a no-op with a ' +
        'confirmation in front of it.',
    };
  } else if (proposed.parse.scene.children.length === 0) {
    blocked =
      proposed.parse.errors.length > 0
        ? {
            kind: 'not-scad',
            headline: 'the reply is not 2bee.cad source',
            detail:
              `The parser produced no scene node at all and failed ${proposed.parse.errors.length} ` +
              `time(s), first at line ${proposed.parse.errors[0].line}: ` +
              `${proposed.parse.errors[0].message}. The text is shown below so you can see what came ` +
              'back; it is not offered for acceptance, because replacing a working model with this ' +
              'would be data loss with no undo.',
          }
        : {
            kind: 'parses-to-nothing',
            headline: 'the reply parses cleanly and produces nothing',
            detail:
              'No syntax error, and no scene node either — every construct in it was refused, or it ' +
              'is comments and variables with no geometry. An empty tree means nothing was ' +
              'understood, not that the model is empty.',
          };
  }

  const cautions: string[] = [];
  if (refused.length + meshRefused.length > 0) {
    cautions.push(
      `${refused.length + meshRefused.length} construct(s) in this proposal are REFUSED by name. ` +
        'They contribute NOTHING — the part would be missing those features. Every one is listed ' +
        'below with its line.',
    );
  }
  if (newRefusalNames.length > 0) {
    cautions.push(
      `${newRefusalNames.join(', ')} — refused here and NOT present in your current source. The ` +
        'model reached outside the subset this tab implements.',
    );
  }
  if (proposed.parse.errors.length > 0) {
    cautions.push(
      `${proposed.parse.errors.length} parse error(s). Each one discarded a span of the reply, so ` +
        'what you would be accepting is less than what came back.',
    );
  }
  if (proposed.mesh.trust !== 'trusted') {
    cautions.push(`The mesh audit does not stand behind this: ${proposed.mesh.trustDetail}`);
  }
  if (shape.changed) cautions.push(shape.sentence);
  else if (!blocked) cautions.push(shape.sentence);

  return {
    proposed,
    refused,
    meshRefused,
    errors: proposed.parse.errors,
    newRefusalNames,
    shape,
    diff: diffLines(current.source, proposalSource),
    blocked,
    cautions,
  };
}

/* ════════════════════════════════════════════════════════════════════════════
 * 5b. One round trip, as a function
 * ══════════════════════════════════════════════════════════════════════════ */

export type AskOutcome =
  | { ok: true; source: string; raw: string; review: ProposalReview }
  | { ok: false; failure: AskFailure };

/**
 * Preflight, send, read, review — the whole pipeline, with no React in it.
 *
 * 🔴 EXTRACTED FROM THE COMPONENT ON PURPOSE. A rule that lives only inside an
 * async event handler in a component that cannot be rendered in the harness is
 * a rule nothing asserts. Everything that decides whether a byte leaves is
 * here, and the transport is a parameter, so a test can prove that a preflight
 * refusal means the transport was **never called** rather than called and
 * ignored.
 */
export async function askOnce(args: {
  cfg: AskConfig;
  prompt: string;
  source: string;
  online: boolean;
  transport: AskTransport;
  signal: AbortSignal;
}): Promise<AskOutcome> {
  const fail = preflight(args.cfg, args.prompt, args.online);
  if (fail) return { ok: false, failure: fail };

  let res: AskTransportResult;
  try {
    res = await args.transport(
      buildRequest(args.cfg, args.prompt, args.source),
      args.signal,
    );
  } catch (e) {
    return { ok: false, failure: classifyThrow(e) };
  }

  const reply = readReply(res);
  if (!reply.ok) return { ok: false, failure: reply.failure };

  /* 🔴 THE SAME PARSER AND THE SAME AUDIT. `reviewProposal` calls `parseScad`
   * and `meshScene` — there is no second, lenient path for model output — and
   * it compares against the source that was SENT, so the delta is about the
   * thing the operator was looking at. */
  return {
    ok: true,
    source: reply.scad,
    raw: reply.raw,
    review: reviewProposal(evaluate(args.source), reply.scad),
  };
}

/* ════════════════════════════════════════════════════════════════════════════
 * 6. The state machine — and the one door text can come out of
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * ⚠ `'applied'` IS NEW ON 2026-08-11 AND IT IS NOT `'idle'`. Founder: *"when
 * request sent automatically change the code (no extra click needed)"*. The
 * proposal has landed in the editor, and the REVIEW OF IT IS STILL ON SCREEN —
 * the refusals, the diff, the raw reply, and above all the cautions. Reusing
 * `'idle'` would have discarded exactly the report that used to be read before
 * the click, which is how an auto-apply becomes an auto-ignore.
 */
export type AskPhase = 'idle' | 'sending' | 'failed' | 'proposed' | 'applied';

export interface AskState {
  phase: AskPhase;
  /** What the operator typed. Kept across a failure so it is not retyped. */
  prompt: string;
  failure: AskFailure | null;
  proposal: { source: string; raw: string; review: ProposalReview } | null;
  /** Set by `accept`, read by {@link applicationOf}, cleared by every other
   *  action. */
  application: Application | null;
}

export interface Application {
  /** The text to install in the editor. */
  next: string;
  /**
   * 🔴 `'model-proposal'` IS PRODUCED BY EXACTLY ONE ACTION AND A TEST
   * ENUMERATES THE REST. It is a one-member union on purpose: a second kind
   * added later has to be written into a branch that currently sets
   * `application: null`, which is what the property test watches.
   */
  kind: 'model-proposal';
}

/**
 * 🔴 `accept` IS GONE, NOT DISABLED. With the apply happening on the reply, the
 * only proposals that could ever reach an accept button are the BLOCKED ones —
 * which the button already refused. So it would have been a control that is
 * permanently dead, which is the one thing this tab keeps finding and removing.
 */
export type AskAction =
  | { t: 'prompt'; text: string }
  | { t: 'send' }
  | { t: 'failed'; failure: AskFailure }
  | { t: 'reply'; source: string; raw: string; review: ProposalReview }
  | { t: 'discard' };

export const INITIAL_ASK_STATE: AskState = {
  phase: 'idle',
  prompt: '',
  failure: null,
  proposal: null,
  application: null,
};

/**
 * 🔴 THE ONE RULE THAT DECIDES WHETHER A REPLY REACHES THE EDITOR.
 *
 * It was `mayAccept(state)` — a guard on a BUTTON — and it is now a guard on the
 * reply itself, because there is no longer a button between the two (founder,
 * 2026-08-11: *"no extra click needed"*).
 *
 * ⚠ `blocked === null` AND NOTHING ELSE, DELIBERATELY. `blocked` is already the
 * narrow set: nothing parsed, or nothing changed. Everything else — a refused
 * construct, a parse error that discarded a span, an audit that will not vouch
 * for the mesh, a bounding box that moved half a metre — is a CAUTION, shown and
 * not decided. Widening this to "apply only when nothing is wrong" would make
 * the feature refuse most real edits; narrowing it to "always apply" would put
 * text in the editor that the parser produced no scene from.
 *
 * 🔴 AND THE PREREQUISITE WAS CHECKED AT THE ARTEFACT BEFORE THIS WAS WIRED, not
 * taken from the commit that claims it. `fbfe2738f1` fixed the normalisation
 * asymmetry that let a byte-identical reply read as acceptable. Re-measured
 * 2026-08-11 through `extractScad` + `reviewProposal`: a verbatim reply, one
 * with a trailing newline, one with a leading blank line and one wrapped in a
 * fence ALL return `blocked.kind === 'unchanged'`. Without that fix this
 * function would auto-apply a no-op on every reply that echoed the source.
 */
export function mayApply(review: ProposalReview): boolean {
  return review.blocked === null;
}

/**
 * 🔴 THE ONLY WAY TEXT REACHES THE EDITOR.
 *
 * The panel calls this on the state the reducer just returned and passes the
 * result to `onApply`. Nothing else in this file, and nothing in `CadTab.tsx`,
 * can produce editor text from a proposal.
 */
export function applicationOf(s: AskState): Application | null {
  return s.application;
}

/**
 * Pure, exported, and the whole rule.
 *
 * ⚠ Every branch clears `application` unless it is the branch that creates one.
 * That is why an auto-apply cannot be introduced by accident: it would have to
 * be written into a branch that currently sets it to `null`, and the property
 * test enumerates every action to check that it is.
 */
export function askReducer(s: AskState, a: AskAction): AskState {
  switch (a.t) {
    case 'prompt':
      return { ...s, prompt: a.text, application: null };

    case 'send':
      return { ...s, phase: 'sending', failure: null, proposal: null, application: null };

    case 'failed':
      return { ...s, phase: 'failed', failure: a.failure, proposal: null, application: null };

    case 'reply': {
      /* 🔴 THIS BRANCH USED TO SET `application: null` UNCONDITIONALLY, and the
       * comment above it said so as a safety property: *"it sets no application,
       * whatever the review says about it"*. The founder asked for the opposite
       * (*"automatically change the code (no extra click needed)"*), so the
       * branch changed and the property test that watched it was INVERTED rather
       * than deleted — it now enumerates every action and checks that this is
       * the ONLY one that can produce an application, and that it does so only
       * on {@link mayApply}.
       *
       * ⚠ THE PROPOSAL IS KEPT EITHER WAY. An applied proposal still renders its
       * whole review — cautions, refusals, diff, raw reply — because the click
       * that was removed is also where an operator used to read them. Dropping
       * the report on apply is the failure mode this whole change has to avoid:
       * the loudest thing it can say is *"the evaluated geometry is IDENTICAL"*,
       * which is precisely the sentence that tells you the model did nothing. */
      const auto = mayApply(a.review);
      return {
        ...s,
        phase: auto ? 'applied' : 'proposed',
        failure: null,
        proposal: { source: a.source, raw: a.raw, review: a.review },
        /* 🔴 THE TEXT THIS REPLACES IS STASHED BY THE TAB, NOT HERE. `CadTab.tsx`
         * routes every application through `replace.ts`, which keeps the
         * editor's own text — the string this pane was given as `source` — so
         * the put-back is one mechanism for all four replacements rather than
         * this pane's private one. It is now the ONLY route back from an
         * automatic overwrite. */
        application: auto ? { next: a.source, kind: 'model-proposal' } : null,
      };
    }

    case 'discard':
      return { ...s, phase: 'idle', failure: null, proposal: null, application: null };
  }
}

/** Every action shape, for the property test that enumerates them. */
export const ALL_ASK_ACTIONS: AskAction[] = [
  { t: 'prompt', text: 'x' },
  { t: 'send' },
  { t: 'failed', failure: { kind: 'network', headline: 'h', detail: 'd' } },
  /* ⚠ A BLOCKED REVIEW, so the enumeration in the property test exercises the
   * branch's REFUSING side. The applying side needs a real review and is
   * asserted separately, against one `reviewProposal` actually produced. */
  {
    t: 'reply',
    source: 'cube(1);',
    raw: 'cube(1);',
    review: { blocked: { kind: 'unchanged', headline: 'h', detail: 'd' } } as unknown as ProposalReview,
  },
  { t: 'discard' },
];

/* ════════════════════════════════════════════════════════════════════════════
 * 7. The panel
 * ══════════════════════════════════════════════════════════════════════════ */

/* ════════════════════════════════════════════════════════════════════════════
 * 6a. What "the endpoint is set" means
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * 🔴 WHETHER THIS PANEL COLLAPSES TO THE PROMPT BOX ALONE.
 *
 * Founder 2026-08-11: *"when endpoint set move it to the settings tab under File
 * and hide"* — the preamble and the endpoint fields go to `File → Settings…`
 * once there is something to ask with, leaving the prompt box.
 *
 * ⚠ "SET" IS NOT "WORKING", AND THE DIFFERENCE DECIDES WHETHER AN OPERATOR CAN
 * GET OUT OF A HOLE. An endpoint that 401s, or one whose model id the gateway
 * refuses, is `set` by this function and broken in fact — and if the panel
 * collapsed on it with no way back, the only control that could fix it would be
 * the one that had just disappeared. So this answers ONLY the narrow question
 * *"is there enough here to construct a request?"*, and two other things carry
 * the rest: `File → Settings…` is always in the menu, and a FAILED call renders
 * its own route back to Settings beside the reason it failed.
 *
 * ⚠ AND A KEY IS DELIBERATELY NOT REQUIRED. A gateway on a private network, or
 * one behind a proxy that injects its own authorization, needs none — demanding
 * one here would refuse a configuration that works. `preflight` is the authority
 * on whether a particular request may leave; this is the authority on what the
 * panel looks like, and they are different questions.
 */
export function askConfigured(cfg: AskConfig): boolean {
  return cfg.endpoint.trim() !== '' && cfg.model.trim() !== '';
}

/* ════════════════════════════════════════════════════════════════════════════
 * 6b. Enter sends
 * ══════════════════════════════════════════════════════════════════════════ */

/** The shape of a key event this needs, so it can be tested without a DOM. */
export interface AskKey {
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  /** `KeyboardEvent.isComposing` — true while an IME candidate window is open. */
  isComposing?: boolean;
  /** The legacy IME signal, still emitted by some browsers. See below. */
  keyCode?: number;
}

export interface AskKeyContext {
  /** What is in the prompt box. */
  prompt: string;
  /** A request is in flight. */
  sending: boolean;
  /** Preflight would refuse this — no endpoint, no model, offline, and so on. */
  blocked: boolean;
}

/**
 * 🔴 SHOULD THIS KEY PRESS SEND? Pure, exported, and the whole rule.
 *
 * Founder 2026-08-11: *"when I press enter … automatically send"*. Four of the
 * five answers here are `false`, and each `false` is a different failure:
 *
 *   · **`Shift+Enter` is a newline**, because a prompt describing a change to a
 *     model is often more than one line and a box you cannot break a line in is
 *     a box people paste into instead.
 *   · **🔴 NOT DURING IME COMPOSITION.** For Japanese, Chinese and Korean input
 *     the `Enter` that COMMITS a candidate is the same physical key. Sending on
 *     it would make this box unusable in those languages — every attempt to
 *     type a word would fire a paid request with a half-finished prompt. Both
 *     signals are checked: `isComposing`, and the legacy `keyCode === 229` that
 *     older browsers emit for a composing key with no `isComposing` at all.
 *   · **Not on an empty box.** There is nothing to ask.
 *   · **🔴 NOT WHILE A REQUEST IS IN FLIGHT.** Every call is real money on a
 *     paid plan, and `Enter` is exactly the key someone presses twice when a
 *     reply is slow. The button is disabled for the same reason; a key that
 *     ignored it would be a second door onto a control that is deliberately shut.
 *
 * ⚠ AND A `false` HERE MEANS THE TEXTAREA KEEPS THE KEY — the caller does not
 * `preventDefault`. A key that is swallowed and does nothing is indistinguishable
 * from a broken app; a key that types a newline is at worst surprising, and the
 * reason it did not send is already on screen in the preflight line under the
 * button.
 */
export function enterSends(e: AskKey, ctx: AskKeyContext): boolean {
  if (e.key !== 'Enter') return false;
  if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return false;
  if (e.isComposing || e.keyCode === 229) return false;
  if (ctx.sending || ctx.blocked) return false;
  return ctx.prompt.trim() !== '';
}

/**
 * Whether the tab offers this at all.
 *
 * 🔴 THIS IS THE LANE'S SWITCH, NOT THIS FILE'S ARGUMENT. It is `true` so the
 * feature is reachable and can be looked at; flipping it to `false` removes the
 * dock tab entirely. ⚠ The safety property does NOT depend on it: with no
 * endpoint, no model and no key — which is what every fresh browser has — the
 * panel refuses before a transport is constructed, so "reachable" and "able to
 * send" are different states and only the operator can move between them.
 */
export const ASK_PANEL_VISIBLE = true;

const box: React.CSSProperties = {
  background: 'var(--bg)',
  color: 'var(--ink)',
  border: '1px solid var(--line)',
  borderRadius: 'var(--radius)',
  padding: '6px 8px',
};

export interface ProposalViewProps {
  review: ProposalReview;
  /** The reply exactly as it arrived, before any fence was stripped. */
  raw: string;
  onDiscard(): void;
  /**
   * 🔴 TRUE ⇒ THIS IS ALREADY IN THE EDITOR. It replaces `acceptable`, which
   * described a button that no longer exists. The two states this component now
   * renders are *applied* and *refused*, and they must not look alike: one is a
   * report about the source the operator is now looking at, the other is a
   * report about text that never reached it.
   */
  applied: boolean;
}

/**
 * Everything the operator sees before acceptance means anything.
 *
 * 🔴 SEPARATE FROM {@link AskPanel} SO IT CAN BE RENDERED WITH A REAL REVIEW IN
 * A HARNESS WITH NO EVENTS. The panel's proposal state can only be reached by
 * completing a round trip, which a static render cannot do — so the assertion
 * that *every refused construct is on screen before the accept button* would
 * have had nothing to assert against. It is the one claim in this file whose
 * failure is silent: a proposal that quietly drops `minkowski()` looks exactly
 * like one that had nothing to drop.
 */
export function ProposalView({ review, raw, onDiscard, applied }: ProposalViewProps) {
  const allRefusals = [
    ...review.refused.map((u) => ({ name: u.name, line: u.line, detail: u.detail })),
    ...review.meshRefused,
  ];
  const diffRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (!review.diff || !diffRef.current) return;
    const first = diffRef.current.querySelector('[data-op="add"], [data-op="remove"]');
    if (first) first.scrollIntoView({ block: 'nearest' });
  }, [review.diff]);
  return (
    <div data-testid="cad-ask-proposal" data-applied={applied ? 'yes' : 'no'} style={{ marginTop: 10 }}>
      {/* 🔴 THE HEADING IS THE ONE THING THAT MUST NOT BE WRONG. Before the
          auto-apply this pane always opened with *"nothing has changed in the
          editor"*, which is now false for every proposal that landed — and a
          stale reassurance about whether the operator's source was overwritten
          is the most expensive sentence this pane could carry. */}
      {applied ? (
        <strong className="warn" data-testid="cad-ask-applied">
          APPLIED — this reply is now in the editor, and it replaced everything that was there. The
          toolbar above offers to put your source back, one step. Read the notes below: they are the
          same ones that used to be read before pressing Accept.
        </strong>
      ) : (
        <strong>This is a proposal. Nothing has changed in the editor.</strong>
      )}

      {review.blocked ? (
        <p className="bad" data-testid="cad-ask-blocked" data-kind={review.blocked.kind}>
          {/* 🔴 A BLOCKED PROPOSAL SURFACES. It did not land, and it did not
              quietly vanish either — the reply is below in full. An auto-apply
              whose refusals are silent is an auto-ignore. */}
          <strong>NOT applied — {review.blocked.headline}.</strong> {review.blocked.detail} The editor
          is untouched.
        </p>
      ) : null}

      <div className="grid2" data-testid="cad-ask-summary" style={{ margin: '6px 0' }}>
        <span>refused by name</span>
        <strong style={{ color: allRefusals.length ? 'var(--bad)' : undefined }}>
          {allRefusals.length}
        </strong>
        <span>parse errors</span>
        <strong style={{ color: review.errors.length ? 'var(--bad)' : undefined }}>
          {review.errors.length}
        </strong>
        <span>mesh audit</span>
        <strong>{review.proposed.mesh.trust}</strong>
        <span>solids</span>
        <strong>
          {review.shape.solidsBefore} → {review.shape.solidsAfter}
        </strong>
        <span>triangles</span>
        <strong>
          {review.shape.trianglesBefore} → {review.shape.trianglesAfter}
        </strong>
        <span>bounding box change</span>
        <strong style={{ color: review.shape.changed ? 'var(--warn)' : undefined }}>
          {review.shape.sizeDeltaMm.map((d) => `${d >= 0 ? '+' : ''}${d.toFixed(2)}`).join(' × ')} mm
        </strong>
      </div>

      {/* 🔴 EVERY REFUSED CONSTRUCT, BY NAME AND LINE, ABOVE THE ACCEPT BUTTON —
          not a count, not a link to another pane. A refusal is geometry the
          reply has and the tree does not, and a model reaches outside this
          subset far more readily than a human does: it has read all of OpenSCAD
          and none of our subset. */}
      {allRefusals.length > 0 ? (
        <div data-testid="cad-ask-refusals" style={{ margin: '6px 0' }}>
          <span className="warn">Refused in this proposal — each contributes NOTHING:</span>
          <ul style={{ margin: '4px 0 0', paddingLeft: 18, font: '11.5px/1.5 var(--mono)' }}>
            {allRefusals.map((u, i) => (
              <li key={`${u.name}-${u.line}-${i}`} data-testid="cad-ask-refusal" data-line={u.line}>
                <strong>{u.name}</strong> — line {u.line} of the proposal. {u.detail}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {review.errors.length > 0 ? (
        <ul
          data-testid="cad-ask-errors"
          style={{ margin: '4px 0', paddingLeft: 18, font: '11.5px/1.5 var(--mono)' }}
        >
          {review.errors.map((e, i) => (
            <li key={i} className="bad">
              line {e.line}: {e.message}
            </li>
          ))}
        </ul>
      ) : null}

      {/* 🔴 THE CAUTIONS SURVIVED LOSING THE CLICK, AND THEY GOT LOUDER FOR IT.
          They used to be read on the way to a button; there is no button now, so
          they are read AFTER the editor has already changed — which makes them
          the only thing standing between an operator and a silent no-op. The
          worst case is not a refusal: it is *"the evaluated geometry is
          IDENTICAL"*, which does not block, applies cleanly, and is the sentence
          that tells you the model did nothing. At `notes` weight under an
          already-applied edit it is a grey line nobody reads. */}
      {review.cautions.length > 0 ? (
        <ul
          className={applied ? 'notes warn' : 'notes'}
          data-testid="cad-ask-cautions"
          style={
            applied
              ? { border: '1px solid var(--warn)', borderRadius: 'var(--radius)', padding: '6px 8px 6px 26px', margin: '6px 0' }
              : undefined
          }
        >
          {review.cautions.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      ) : null}

      <details open data-testid="cad-ask-diff-wrap" style={{ margin: '6px 0' }}>
        <summary className="note" style={{ cursor: 'pointer' }}>
          What it changed — every − line is yours, every + line is the reply’s
        </summary>
        {review.diff === null ? (
          <p className="warn" data-testid="cad-ask-diff-too-big">
            One of these is longer than {DIFF_LINE_CAP} lines, so no diff was computed. A truncated
            diff reads as a complete one, so none is shown at all — read the reply in full below
            instead.
          </p>
        ) : (
          <pre
            ref={diffRef}
            data-testid="cad-ask-diff"
            style={{
              ...box,
              font: '11px/1.45 var(--mono)',
              maxHeight: 260,
              overflow: 'auto',
              margin: 0,
            }}
          >
            {review.diff.map((d, i) => (
              <div
                key={i}
                data-op={d.op}
                style={{
                  color:
                    d.op === 'add' ? 'var(--ok)' : d.op === 'remove' ? 'var(--bad)' : 'var(--muted)',
                  whiteSpace: 'pre',
                }}
              >
                {d.op === 'add' ? '+' : d.op === 'remove' ? '−' : ' '} {d.text}
              </div>
            ))}
          </pre>
        )}
      </details>

      <details data-testid="cad-ask-raw-wrap">
        <summary className="note" style={{ cursor: 'pointer' }}>
          The reply in full, exactly as it arrived
        </summary>
        <pre
          data-testid="cad-ask-raw"
          style={{
            ...box,
            font: '11px/1.45 var(--mono)',
            maxHeight: 220,
            overflow: 'auto',
            margin: 0,
            whiteSpace: 'pre-wrap',
          }}
        >
          {raw}
        </pre>
      </details>

      <p className="note">
        {applied
          ? 'Line numbers above are lines of this reply — which IS what is in the editor now, so they are editor lines.'
          : 'Line numbers above are lines of the PROPOSAL, which is not what is in the editor and never became it.'}
      </p>

      {/* 🔴 THE ACCEPT BUTTON IS GONE, NOT DISABLED. With the apply happening on
          the reply, the only proposals that could reach it are the blocked ones
          — which it already refused — so it would be permanently dead. What is
          left is one control that clears this report. */}
      <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
        <button type="button" data-testid="cad-ask-discard" onClick={onDiscard}>
          {applied ? 'Clear this report' : 'Clear it'}
        </button>
      </div>
      {/* 🔴 THIS LINE USED TO REPEAT THE HEADING AT THE TOP OF THE SAME BLOCK —
          *"replaced everything in the editor"* and *"the toolbar offers to put it
          back, one step"*, both already said above, and on the refused side
          *"nothing reached the editor"* said above TWICE (the heading and the
          refusal). A header restated under itself is the shape the founder
          removed elsewhere on 2026-08-11.
          ⚠ WHAT IS LEFT IS ONLY WHAT IS SAID NOWHERE ELSE, and both halves are
          limits rather than reassurance: the put-back is not an undo for typing,
          and the button beside this one does NOT undo anything. Neither is
          derivable from the heading, so neither was dropped. */}
      <p className="warn" style={{ marginBottom: 0 }}>
        {applied
          ? 'The put-back is not an undo for your typing, and clearing this report does not put anything back.'
          : 'Clearing this report discards the reply; your source is untouched either way.'}
      </p>
    </div>
  );
}

/**
 * 🔴 THE PRIVACY DISCLOSURE. IT IS NOT DECORATION AND IT DOES NOT GET DELETED.
 *
 * Founder 2026-08-11: *"when endpoint set move it to the settings tab under File
 * and hide"*. **HIDE, and hiding is what happened** — this paragraph moved into
 * `File → Settings…` with the fields it belongs to. It states what leaves the
 * machine and what does not, every word of it is checkable (this is an AGPL
 * bundle: a reader has the source), and it is the only place the app tells an
 * operator that this pane is the sole outbound path. Removing it to satisfy
 * "hide" would have been deleting a true statement about data leaving a
 * computer, which is not a layout change.
 *
 * ⚠ IT IS A CONSTANT SO THAT A TEST CAN ASSERT IT REACHED THE NEW SURFACE. Text
 * inline in a JSX tree that moved is text nothing watched move.
 */
export const OUTBOUND_DISCLOSURE =
  '🔴 This is the only thing in this app that sends anything anywhere. Everything else — the ' +
  'editor, the parser, the mesh audit, the drawings list, the CNC tab — works with no network at ' +
  'all, and that does not change. There is no endpoint and no key in this app: they are yours, ' +
  'you type them, and they stay in this browser.';

/**
 * 🔴 THE SENTENCE THE FOUNDER KEPT. He listed three things to hide and wrote out
 * the one to leave visible: *"leaving: What should change? Plain words. The
 * source in the editor is sent with it."* The second half of that is a
 * disclosure too — the whole file in the editor travels, not just the words
 * typed in the box — and it is the half most easily lost in a move, because it
 * reads like a prompt label. It is a constant for the same reason as above.
 */
export const PROMPT_LABEL = 'What should change? Plain words. The source in the editor is sent with it.';

export interface AskSettingsProps {
  cfg: AskConfig;
  onPatch(p: Partial<AskConfig>): void;
  /**
   * Dismiss. `null` ⇒ this is the INLINE copy shown while nothing is configured,
   * which has nothing to dismiss to — the panel would be empty without it.
   */
  onClose: (() => void) | null;
}

/**
 * Endpoint, model, key — and the disclosure that explains why they are yours.
 *
 * 🔴 ONE COMPONENT, TWO PLACES, AND THAT IS THE POINT. It is the body of
 * `File → Settings…` and it is what the Ask pane shows inline while nothing is
 * configured. A second copy of a credential form is a second place for the key
 * handling to drift, and the key handling is the part of this file that must not
 * drift: it is never logged, never in an error string, never in a saved model,
 * and stored only behind an explicit opt-in.
 *
 * ⚠ THE MODEL LIST LIVES HERE NOW. It starts `idle` and only a PRESS moves it —
 * not on mount, not when the endpoint field changes, not on a timer. A settings
 * dialog that called a gateway because it opened would be an automated caller,
 * which the founder's standing MiMo Token Plan ruling permits for a human
 * clicking and forbids for a script.
 */
export function AskSettings({ cfg, onPatch, onClose }: AskSettingsProps) {
  const [modelList, setModelList] = useState<ModelListState>({ phase: 'idle' });

  const listModels = useCallback(async () => {
    setModelList({ phase: 'asking' });
    setModelList(await fetchModelList(cfg, fetch));
  }, [cfg]);

  /* ⚠ A LIST BELONGS TO THE ENDPOINT IT CAME FROM. Change the endpoint and the
   * previous gateway's models are still on screen, ready to be chosen for a host
   * that never advertised them — a stale green with a plausible shape. So the
   * list is dropped the moment the endpoint it describes stops being the one in
   * the box. This CLEARS; it does not re-fetch. */
  const listedFor = useRef(cfg.endpoint);
  if (listedFor.current !== cfg.endpoint) {
    listedFor.current = cfg.endpoint;
    if (modelList.phase !== 'idle') setModelList({ phase: 'idle' });
  }

  return (
    <div data-testid="cad-ask-settings-panel">
      <strong>Ask a model to change this source — endpoint settings</strong>
      <p className="note" data-testid="cad-ask-first-send">
        {OUTBOUND_DISCLOSURE}
      </p>

      <div data-testid="cad-ask-settings" style={{ display: 'grid', gap: 6, marginBottom: 8 }}>
              <label style={{ display: 'grid', gap: 2 }}>
                <span className="note" style={{ margin: 0 }}>
                  Endpoint — a full OpenAI-protocol chat-completions URL, ending in /chat/completions
                </span>
                <input
                  data-testid="cad-ask-endpoint"
                  value={cfg.endpoint}
                  /* 🔴 PLACEHOLDER, NOT VALUE — see {@link ENDPOINT_EXAMPLE}. An
                   * example that is pre-filled is a setting nobody chose, and this
                   * one would decide where the operator's source goes. */
                  placeholder={ENDPOINT_EXAMPLE}
                  onChange={(e) => onPatch({ endpoint: e.target.value })}
                  style={box}
                />
              </label>
              <label style={{ display: 'grid', gap: 2 }}>
                <span className="note" style={{ margin: 0 }}>
                  Model id, exactly as your endpoint spells it
                </span>
                {/* 🔴 THE TYPED FIELD REMAINS THE AUTHORITY. The list below writes
                    into it; it never replaces it. A gateway that cannot list, or
                    that lists nothing, or that this page cannot reach for CORS
                    reasons, must not be a gateway you cannot use. */}
                <input
                  data-testid="cad-ask-model"
                  value={cfg.model}
                  placeholder="nothing configured"
                  onChange={(e) => onPatch({ model: e.target.value })}
                  style={box}
                />
              </label>

              {/* ---- what this endpoint says it has --------------------------- */}
              <div style={{ display: 'grid', gap: 4 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    data-testid="cad-ask-list-models"
                    disabled={modelList.phase === 'asking' || modelsUrl(cfg.endpoint) === null}
                    onClick={() => void listModels()}
                  >
                    {modelList.phase === 'asking' ? 'asking…' : 'List the models this endpoint advertises'}
                  </button>
                  {modelsUrl(cfg.endpoint) === null ? (
                    <span className="note" data-testid="cad-ask-models-underivable" style={{ margin: 0 }}>
                      Needs an endpoint URL ending in <code>/chat/completions</code> — the list lives at{' '}
                      <code>/models</code> beside it.
                    </span>
                  ) : null}
                </div>

                {/* 🔴 FOUR OUTCOMES, FOUR DIFFERENT THINGS ON SCREEN. An endpoint
                    that advertises nothing and one that could not be reached are
                    opposite facts and must never share a rendering. */}
                {modelList.phase === 'failed' ? (
                  <div className="bad" data-testid="cad-ask-models-failed" style={{ margin: 0 }}>
                    <strong>{modelList.headline}</strong> {modelList.detail}
                  </div>
                ) : null}
                {modelList.phase === 'empty' ? (
                  <p className="warn" data-testid="cad-ask-models-empty" style={{ margin: 0 }}>
                    The endpoint answered and advertises NO models. That is its answer, not a failed
                    request — it reached the host and the list was genuinely empty. Type the model id by
                    hand if you know one it will serve.
                  </p>
                ) : null}
                {modelList.phase === 'listed' ? (
                  <>
                    <label style={{ display: 'grid', gap: 2 }}>
                      <span className="note" style={{ margin: 0 }}>
                        {modelList.ids.length} model(s) this endpoint ADVERTISES. Choosing one fills the
                        box above.
                      </span>
                      <select
                        data-testid="cad-ask-model-list"
                        aria-label="models this endpoint advertises"
                        value={modelList.ids.includes(cfg.model) ? cfg.model : ''}
                        onChange={(e) => {
                          if (e.target.value) onPatch({ model: e.target.value });
                        }}
                        style={box}
                      >
                        <option value="">choose a model…</option>
                        {modelList.ids.map((id) => (
                          <option key={id} value={id}>
                            {id}
                          </option>
                        ))}
                      </select>
                    </label>
                    {/* 🔴 THE LABEL IS THE WHOLE POINT AND IT IS NOT DECORATION.
                        Our own gateway advertises models it then refuses at call
                        time, and the refusal points back at this same list as if it
                        were authoritative. The honest fix is to say what the list
                        is; filtering it would need a call per model, and a silently
                        narrowed list is worse than an honest wide one. */}
                    <p className="warn" data-testid="cad-ask-models-advertised" style={{ margin: 0 }}>
                      ⚠ This is what the endpoint SAYS it has, not what it will serve. A gateway can list
                      a model and then refuse it when asked — if that happens, the refusal is the truth
                      and this list is not. Nothing here has been verified by calling it.
                    </p>
                  </>
                ) : null}
              </div>
              <label style={{ display: 'grid', gap: 2 }}>
                <span className="note" style={{ margin: 0 }}>
                  API key — sent as an Authorization: Bearer header to the endpoint above and nowhere
                  else
                </span>
                <input
                  data-testid="cad-ask-key"
                  type="password"
                  value={cfg.apiKey}
                  placeholder="not set"
                  onChange={(e) => onPatch({ apiKey: e.target.value })}
                  style={box}
                />
              </label>
              <label style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                <input
                  type="checkbox"
                  data-testid="cad-ask-remember"
                  checked={cfg.rememberKey}
                  onChange={(e) => onPatch({ rememberKey: e.target.checked })}
                />
                <span className="note" style={{ margin: 0 }}>
                  Remember the key in this browser. <strong>Off by default.</strong> Browser storage is
                  readable by anything running on this origin and is not encrypted — leaving this off
                  means retyping the key each session, which is the trade being offered.
                </span>
              </label>
              <p className="note" style={{ margin: 0 }}>
                ⚠ A browser calls this endpoint directly, so the endpoint must send CORS headers that
                allow this origin. If it does not, the request fails with no status and the browser will
                not say why — that is a platform limit, not a fault here.
              </p>
            </div>

      {onClose ? (
        <div style={{ marginTop: 8 }}>
          <button type="button" data-testid="cad-ask-settings-close" onClick={onClose}>
            Close
          </button>
        </div>
      ) : (
        /* ⚠ NO CLOSE HERE. This is the inline copy, shown because nothing is
         * configured — closing it would leave a pane with a prompt box that
         * cannot send and no way to make it able to. */
        <p className="note" style={{ marginBottom: 0 }}>
          Once an endpoint and a model id are set, this moves out of the way and the pane becomes the
          prompt box alone. It stays reachable at File → Settings…
        </p>
      )}
    </div>
  );
}

export interface AskPanelProps {
  /** The text in the editor RIGHT NOW. Sent verbatim; never written to. */
  source: string;
  /** Install this text in the editor. Called only from {@link applicationOf}. */
  onApply(next: string, kind: Application['kind']): void;
  /**
   * 🔴 THE CONFIG IS THE TAB'S NOW, NOT THIS PANEL'S. It used to be a `useState`
   * in here reading `localStorage` directly. `File → Settings…` edits the same
   * values from a different surface, and two components each owning a copy of
   * one preference is how a dialog saves a model id the panel then does not use.
   * One writer, in `CadTab.tsx`, which is also where the persistence lives.
   */
  cfg: AskConfig;
  onPatch(p: Partial<AskConfig>): void;
  /**
   * Bring up `File → Settings…`. Rendered on the FAILURE path, because an
   * endpoint that is set and broken collapses this panel and would otherwise
   * leave no control that could fix it.
   */
  onOpenSettings(): void;
  /** Injected in tests. `fetchTransport` in the product. */
  transport?: AskTransport;
  /** Injected in tests. `navigator.onLine` in the product. */
  online?: boolean;
}

/* ⚠ THERE IS DELIBERATELY NO `onGoToLine` HERE, and the first draft had one.
 * Every line number in a proposal is a line of the PROPOSAL — a text that is
 * not in the editor and may never be. A "go to line 42" control on this pane
 * would take the caret to line 42 of a different document, which is the exact
 * defect `editor.tsx` opens by warning about: the user goes confidently to the
 * wrong line and concludes the tool is lying. The review says the numbers are
 * the proposal's instead. */

export function AskPanel({
  source,
  onApply,
  cfg,
  onPatch,
  onOpenSettings,
  transport = fetchTransport,
  online,
}: AskPanelProps) {
  const [state, setState] = useState<AskState>(INITIAL_ASK_STATE);
  const abort = useRef<AbortController | null>(null);
  const configured = askConfigured(cfg);

  /**
   * What this endpoint says it has (founder, 2026-08-11: *"once the url set get
   * all the models to a drop down"*).
   *
   * 🔴 IT STARTS `idle` AND ONLY A PRESS MOVES IT. Not on mount, not when the
   * endpoint field changes, not on a timer: an editor pane that called a gateway
   * because somebody typed a character is an automated caller, which the
   * founder's standing MiMo Token Plan ruling permits for a human clicking and
   * forbids for a script.
   */
  const effectiveOnline =
    online ?? (typeof navigator === 'undefined' ? true : navigator.onLine !== false);

  /* The request is built from the CURRENT config, prompt and source so what the
   * summary shows is what a press would send — not a snapshot from earlier. */
  const request = useMemo(
    () => buildRequest(cfg, state.prompt, source),
    [cfg, state.prompt, source],
  );
  const blockedBefore = useMemo(
    () => preflight(cfg, state.prompt, effectiveOnline),
    [cfg, state.prompt, effectiveOnline],
  );

  const dispatch = useCallback(
    (a: AskAction) => {
      setState((old) => {
        const next = askReducer(old, a);
        const app = applicationOf(next);
        if (app) onApply(app.next, app.kind);
        return next;
      });
    },
    [onApply],
  );

  /* Every decision — including whether anything is sent at all — is
   * `askOnce`'s. This callback owns the abort controller, the timer and the
   * dispatch, and nothing else. */
  const send = useCallback(async () => {
    dispatch({ t: 'send' });
    const controller = new AbortController();
    abort.current = controller;
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    try {
      const out = await askOnce({
        cfg,
        prompt: state.prompt,
        source,
        online: effectiveOnline,
        transport,
        signal: controller.signal,
      });
      if (out.ok) dispatch({ t: 'reply', source: out.source, raw: out.raw, review: out.review });
      else dispatch({ t: 'failed', failure: out.failure });
    } finally {
      clearTimeout(timer);
      abort.current = null;
    }
  }, [cfg, state.prompt, source, effectiveOnline, transport, dispatch]);

  const review = state.proposal?.review ?? null;

  return (
    <div
      data-testid="cad-ask"
      data-phase={state.phase}
      style={{ height: '100%', overflow: 'auto', padding: 8, ...box, borderRadius: 0 }}
    >
      {/* 🔴 CONFIGURED ⇒ THE PROMPT BOX ALONE (founder, 2026-08-11: *"when
          endpoint set move it to the settings tab under File and hide"*). The
          heading, the disclosure and the endpoint fields are all in
          `File → Settings…` — moved, not deleted; see {@link OUTBOUND_DISCLOSURE}.

          🔴 NOT CONFIGURED ⇒ THE SETTINGS ARE HERE, INLINE. There is nothing to
          ask with, so a bare prompt box would be a control that cannot work
          beside no way to make it work. `askConfigured` is the one place that
          decides which of the two this is, and it answers the narrow question —
          "is there enough to build a request?" — rather than "does it work". */}
      {configured ? null : <AskSettings cfg={cfg} onPatch={onPatch} onClose={null} />}

      {/* ---- the request ------------------------------------------------- */}
      <label style={{ display: 'grid', gap: 2, marginBottom: 6 }}>
        <span className="note" style={{ margin: 0 }}>
          {/* 🔴 THE ONE LINE THE FOUNDER NAMED AS THE THING TO LEAVE VISIBLE,
              verbatim — *"leaving: What should change? Plain words. The source
              in the editor is sent with it."*. Its second half is a disclosure
              wearing a prompt label's clothes: the WHOLE FILE in the editor
              travels, not only the words typed in this box, and that is the
              sentence most easily lost when a preamble moves to a dialog. It is
              {@link PROMPT_LABEL}, a constant, so a test can watch it stay. */}
          {PROMPT_LABEL}{' '}
          <strong>Enter sends · Shift+Enter is a new line.</strong> A reply that this tab can read is
          put straight in the editor — the notes it comes with are worth reading, and the toolbar
          puts your source back.
        </span>
        <textarea
          data-testid="cad-ask-prompt"
          aria-label="what should change"
          rows={5}
          value={state.prompt}
          placeholder="make the wall 8mm and add a 5mm fillet-free chamfer relief at the base…"
          onChange={(e) => dispatch({ t: 'prompt', text: e.target.value })}
          /* 🔴 ENTER SENDS (founder, 2026-08-11). Every condition is in
           * {@link enterSends}, which is pure and exported — a rule that lived
           * only in this handler is a rule nothing can watch going red, and one
           * of its clauses (do not fire during IME composition) has a failure
           * mode nobody on this box can reproduce: for a Japanese, Chinese or
           * Korean operator the Enter that commits a candidate is the same key,
           * so every attempt to type a word would fire a paid request.
           *
           * ⚠ `preventDefault` ONLY WHEN WE SEND. When the rule says no, the
           * textarea keeps the key and types a newline. A key that is swallowed
           * and does nothing is indistinguishable from a broken app, and the
           * reason it did not send is already on screen under the button. */
          onKeyDown={(e) => {
            const native = e.nativeEvent as KeyboardEvent & { isComposing?: boolean };
            if (
              !enterSends(
                {
                  key: e.key,
                  shiftKey: e.shiftKey,
                  ctrlKey: e.ctrlKey,
                  metaKey: e.metaKey,
                  altKey: e.altKey,
                  isComposing: native.isComposing,
                  keyCode: native.keyCode,
                },
                { prompt: state.prompt, sending: state.phase === 'sending', blocked: !!blockedBefore },
              )
            ) {
              return;
            }
            e.preventDefault();
            void send();
          }}
          style={{ ...box, font: '12px/1.5 var(--mono)', resize: 'vertical' }}
        />
      </label>

      <details data-testid="cad-ask-transmits" style={{ marginBottom: 6 }}>
        <summary className="note" style={{ cursor: 'pointer' }}>
          Exactly what leaves this browser when you press Ask
        </summary>
        <ul className="notes" style={{ marginTop: 4 }}>
          {transmissionSummary(request, source, state.prompt).map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
        <p className="note">The fixed instruction, in full:</p>
        <pre
          data-testid="cad-ask-system"
          style={{ ...box, font: '11px/1.5 var(--mono)', whiteSpace: 'pre-wrap', margin: 0 }}
        >
          {SYSTEM_INSTRUCTION}
        </pre>
      </details>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          type="button"
          data-testid="cad-ask-send"
          disabled={!!blockedBefore || state.phase === 'sending'}
          onClick={() => void send()}
        >
          {state.phase === 'sending' ? 'Asking…' : 'Ask'}
        </button>
        {state.phase === 'sending' ? (
          <button
            type="button"
            data-testid="cad-ask-stop"
            onClick={() => abort.current?.abort()}
          >
            Stop
          </button>
        ) : null}
        {/* 🔴 NO PUT-BACK BUTTON HERE ANY MORE — it is the toolbar's, once, for
            every replacement. See the header. */}
      </div>

      {blockedBefore ? (
        <p className="bad" data-testid="cad-ask-preflight" style={{ marginTop: 6 }}>
          <strong>{blockedBefore.headline}.</strong> {blockedBefore.detail}
        </p>
      ) : null}

      {state.failure ? (
        <div className="bad" data-testid="cad-ask-failure" data-kind={state.failure.kind} style={{ marginTop: 6 }}>
          <strong>{state.failure.headline}.</strong> {state.failure.detail} The editor is untouched.
          {/* 🔴 THE ROUTE BACK. `askConfigured` says an endpoint is SET; it
              cannot say it WORKS. A 401 on the key, a model id the gateway
              refuses, a URL missing its path, a host with no CORS header — every
              one of those collapses this panel to a prompt box and is fixed in
              the settings the collapse just hid. A failure with no way back to
              the only control that could cure it is a dead end, so the way back
              is rendered here, on the failure itself, rather than left to an
              operator remembering which menu it went to. */}
          <div style={{ marginTop: 6 }}>
            <button type="button" data-testid="cad-ask-open-settings" onClick={onOpenSettings}>
              Open endpoint settings
            </button>
          </div>
        </div>
      ) : null}

      {/* ---- the proposal ------------------------------------------------ */}
      {review && state.proposal ? (
        <ProposalView
          review={review}
          raw={state.proposal.raw}
          applied={state.phase === 'applied'}
          onDiscard={() => dispatch({ t: 'discard' })}
        />
      ) : null}
    </div>
  );
}

export default AskPanel;
