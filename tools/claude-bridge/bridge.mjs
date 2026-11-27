#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// claude-bridge — lets the 2bee.app "Ask a model" panels use the operator's
// LOCAL `claude` CLI (founder 2026-10-14: *"local ai bridge is claude-cli"*,
// *"use the claude executable (I will update the token manually)"*).
//
// It speaks the two OpenAI-protocol routes `web/src/cad/ask.tsx` already uses:
//   POST /v1/chat/completions  {model, messages[]} -> {choices:[{message:{role,content}}]}
//        (text parts, and — since 2026-10-15 — `image_url` parts carrying a
//        `data:image/...;base64,` URL, for the Tools tab's "photo the cutter")
//   GET  /v1/models                                -> {data:[{id}]}
// and answers each chat request by running ONE `claude -p` child with NO tools.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHAT THIS DOES NOT DO
// ═══════════════════════════════════════════════════════════════════════════
//   · It never touches Claude's own credentials. It does not log in, refresh,
//     read, copy or write them; the child `claude` uses whatever login the
//     operator already has. An auth failure is reported verbatim, not fixed.
//   · It never calls an API directly and carries no SDK — the only model path
//     is the `claude` executable (override `CLAUDE_BIN` exists for the tests).
//   · The model gets NO tools, NO MCP servers, NO extra directories, and runs
//     in an EMPTY temporary cwd that is deleted afterwards. See CLAUDE_FLAGS.
//   · It binds 127.0.0.1 and nothing else. `--host` with any other value is a
//     refusal (exit 2), not a warning.
//   · It does not stream, and it does not honour `temperature` (the CLI has no
//     such flag). `stream: true` is refused with 400 rather than faked.
//   · It never logs a token or a request/response body: one line per request
//     (time, method, path, origin, status, ms).
//   · It never runs `claude` while the fleet AI pause file exists
//     (~/.local/state/2hives/llm-pause, PAUSE_FILE_REL). Checked on EVERY chat
//     request, again just before the child starts (a queued request can wait),
//     and every PAUSE_POLL_MS while a child runs: a pause kills that child and
//     the request answers 503. A pause file that cannot be checked (any error
//     but "does not exist") counts as PAUSED. Why it is in code and not only in
//     the unit: systemd's ConditionPathExists is read at START, so a bridge that
//     is already running would ignore the pause (cyber 2026-11-26-14-07-53;
//     ceo 2026-11-27-14-32-12, legal 2026-11-27-14-40-58: precondition for any
//     restart). The pause file's path has no flag and no env knob on purpose.
//
// No npm dependencies: node:http, node:child_process, node:crypto, node:fs,
// node:os, node:path only.

import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { peers as registryPeers, register as registerBridge } from '../bridge-registry.mjs';

export const DEFAULT_PORT = 8787;
export const BIND_HOST = '127.0.0.1';
/** What GET /v1/hello names this bridge. Must match web/src/cad/aiBridge.ts. */
export const HELLO_ID = '2bee.claude-bridge';

export const DEFAULT_ORIGINS = ['http://localhost:5178', 'http://127.0.0.1:5178', 'https://2bee.app'];
export const DEFAULT_TIMEOUT_S = 120;
export const DEFAULT_MAX_BODY = 2 * 1024 * 1024;
export const MAX_QUEUE = 8;
/** Images per request. The Tools tab sends one; a few more is headroom, not a use. */
export const MAX_IMAGES = 4;
/** Media types the CLI's image block accepts. Anything else is a 400. */
export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
/** The fleet's AI stop switch, relative to $HOME (the same file the llm-pause drop-in names). */
export const PAUSE_FILE_REL = '.local/state/2hives/llm-pause';
/** How often a RUNNING child is re-checked against the pause file. */
export const PAUSE_POLL_MS = 500;

/**
 * True when the pause file exists. Fails CLOSED: only "does not exist"
 * (ENOENT, or ENOTDIR for a missing parent) means "not paused"; a permission
 * error or anything else means we cannot tell, so we are paused.
 */
export function isPaused(file) {
  try {
    statSync(file);
    return true;
  } catch (e) {
    return !(e && (e.code === 'ENOENT' || e.code === 'ENOTDIR'));
  }
}
const pausedError = (file) =>
  new HttpError(503, `AI is paused: ${file} exists, so this bridge does not run claude. Nothing was sent.`);

const MAX_STDOUT = 16 * 1024 * 1024;
const MAX_STDERR = 64 * 1024;

/** The ids the browser sees -> the value passed to `claude --model`. */
export const MODELS = {
  'claude-sonnet': 'sonnet',
  'claude-opus': 'opus',
  'claude-haiku': 'haiku',
  'claude-fable': 'fable',
};

/** Used only when the request carries no system message, so the CLI's default
 *  coding-agent prompt (which describes tools this child does not have) is never sent. */
const NEUTRAL_SYSTEM = 'You are a helpful assistant. Answer the user directly.';

/**
 * Caveman reply style (founder 2026-10-16: "setup caveman for all llm
 * communications", https://github.com/juliusbrussee/caveman). Every Claude Code
 * session on this machine gets it from the user-level plugin, but this child runs
 * --safe-mode (no plugins), so the rules are appended to the system prompt here.
 * It shortens PROSE only. JSON, code, numbers, units and exact errors stay as
 * asked, and a reply format the request demands wins over the style. Safety
 * warnings keep full sentences. `--no-caveman` turns it off.
 */
export const CAVEMAN_RULES = [
  'Reply style (caveman): terse. Drop articles, filler, pleasantries and hedging. Fragments are fine. Short sentences, active voice, one idea per sentence.',
  'Keep exact: code, JSON, commands, paths, numbers, units, names and error text. Never drop "not", "never", "no", "only" or "except".',
  'If the instructions above ask for a specific output format (for example ONE JSON object), produce exactly that format; the style applies only to prose inside it.',
  'Safety warnings and steps where order matters: write them in full, clear sentences.',
].join('\n');

/**
 * 🔴 THE EXACT FLAGS EVERY CHILD GETS. Each one is here for a stated reason;
 * the tests assert the safety-relevant ones are present and that the
 * permission-bypass flags are absent.
 *
 *   -p                          print mode: one turn, print, exit. No TTY UI.
 *   --output-format json        a single JSON object; we return its `result`.
 *   --tools ""                  the built-in tool set is EMPTY ("" = disable all,
 *                               per `claude --help`). Verified 2026-10-14: the model
 *                               reports NONE when asked to list its tools.
 *   --strict-mcp-config         ignore every MCP config on the machine ...
 *   --mcp-config {"mcpServers":{}}  ... and load exactly none.
 *   --safe-mode                 no CLAUDE.md, skills, plugins, hooks, MCP, custom
 *                               agents or commands — none of the operator's fleet
 *                               config leaks into the prompt or runs as a hook.
 *                               Auth is unaffected (per `claude --help`).
 *   --disable-slash-commands    a prompt starting "/" is text, not a skill.
 *   --permission-mode dontAsk   belt and braces: anything that would need a
 *                               permission is denied, never prompted for.
 *   --no-session-persistence    the conversation is not saved to disk.
 *   --system-prompt-file <f>    REPLACES the default system prompt with the
 *                               request's system message(s). File, not argv,
 *                               because Linux caps one argv string at 128 KiB.
 *   --model <alias>             from MODELS.
 *
 * Deliberately ABSENT: --dangerously-skip-permissions,
 * --allow-dangerously-skip-permissions, --add-dir, --permission-mode
 * bypassPermissions, --bare (it would skip OAuth, i.e. the operator's login).
 * The conversation goes on STDIN, not argv.
 */
export function claudeArgs(cliModel, systemFile, { streamJson = false } = {}) {
  return [
    '-p',
    /* IMAGES: the CLI takes an image only as a content block in
     * `--input-format stream-json`, and refuses that input format unless the
     * output is stream-json too, and refuses stream-json output under -p
     * without --verbose (all three measured against claude 2.1.299,
     * 2026-10-15). --verbose changes what is printed to OUR pipe, not what the
     * model can do; the bridge never forwards that stream, only `result`. */
    ...(streamJson
      ? ['--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose']
      : ['--output-format', 'json']),
    '--tools', '',
    '--strict-mcp-config',
    '--mcp-config', '{"mcpServers":{}}',
    '--safe-mode',
    '--disable-slash-commands',
    '--permission-mode', 'dontAsk',
    '--no-session-persistence',
    '--system-prompt-file', systemFile,
    '--model', cliModel,
  ];
}

/* ─────────────────────────────── arguments ─────────────────────────────── */

export function parseArgs(argv) {
  const o = {
    port: DEFAULT_PORT,
    host: BIND_HOST,
    origins: [...DEFAULT_ORIGINS],
    tokenFile: null,
    timeoutS: DEFAULT_TIMEOUT_S,
    maxBody: DEFAULT_MAX_BODY,
    caveman: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    const int = (v, name, min) => {
      if (!/^\d+$/.test(v) || Number(v) < min) throw new Error(`${name} must be an integer >= ${min}`);
      return Number(v);
    };
    if (a === '--port') o.port = int(val(), '--port', 0);
    else if (a === '--host') o.host = val();
    else if (a === '--allow-origin') o.origins.push(val().replace(/\/+$/, ''));
    else if (a === '--token-file') o.tokenFile = val();
    else if (a === '--timeout') o.timeoutS = int(val(), '--timeout', 1);
    else if (a === '--max-body') o.maxBody = int(val(), '--max-body', 1);
    else if (a === '--no-caveman') o.caveman = false;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (o.port > 65535) throw new Error('--port must be <= 65535');
  if (o.host !== BIND_HOST) {
    throw new Error(`refusing to bind ${o.host}: this bridge binds ${BIND_HOST} only`);
  }
  return o;
}

/**
 * The bridge's OWN bearer token (not Claude's). Precedence: --token-file, then
 * env CLAUDE_BRIDGE_TOKEN, then generated. `printable` is true ONLY for a
 * generated token — a token the operator supplied is never echoed.
 */
export function resolveToken(tokenFile, env) {
  let token;
  let source;
  if (tokenFile) {
    token = readFileSync(tokenFile, 'utf8').trim();
    source = `--token-file ${tokenFile}`;
  } else if (env.CLAUDE_BRIDGE_TOKEN !== undefined) {
    token = env.CLAUDE_BRIDGE_TOKEN.trim();
    source = 'env CLAUDE_BRIDGE_TOKEN';
  } else {
    return { token: randomBytes(24).toString('base64url'), source: 'generated', printable: true };
  }
  if (token.length < 16) throw new Error(`the token from ${source} is shorter than 16 characters`);
  if (/\s/.test(token)) throw new Error(`the token from ${source} contains whitespace`);
  return { token, source, printable: false };
}

/* ─────────────────────────────── helpers ─────────────────────────────── */

const digest = (s) => createHash('sha256').update(s).digest();
function tokenMatches(header, token) {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header || '');
  if (!m) return false;
  return timingSafeEqual(digest(m[1]), digest(token));
}

/**
 * One `image_url` part -> the CLI's image block.
 *
 * 🔴 DATA URLs ONLY. An http(s) URL is refused, never fetched: this bridge makes
 * no network request of its own, and fetching a URL the page names would turn a
 * loopback service into a proxy for whatever that page wants to reach.
 */
function imageOf(part) {
  const url = typeof part.image_url === 'string' ? part.image_url : part.image_url && part.image_url.url;
  if (typeof url !== 'string') throw new Error('an image_url part needs image_url.url');
  const m = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(url);
  if (!m) {
    throw new Error(
      /^https?:/i.test(url)
        ? 'image_url must be a data: URL — this bridge fetches nothing from the network'
        : 'image_url must be a data:<type>;base64,<data> URL',
    );
  }
  const mediaType = m[1].toLowerCase();
  if (!IMAGE_TYPES.includes(mediaType)) throw new Error(`image type ${mediaType} is not supported (${IMAGE_TYPES.join(', ')})`);
  return { type: 'image', source: { type: 'base64', media_type: mediaType, data: m[2] } };
}

/** message content -> { text, images[] }. Images only where `allowImages`. */
function contentOf(content, allowImages) {
  if (typeof content === 'string') return { text: content, images: [] };
  if (Array.isArray(content)) {
    const parts = [];
    const images = [];
    for (const p of content) {
      if (p && p.type === 'text' && typeof p.text === 'string') parts.push(p.text);
      else if (p && p.type === 'image_url') {
        if (!allowImages) throw new Error('images are accepted only in the last user message');
        images.push(imageOf(p));
      } else throw new Error('only text and image_url content parts are supported');
    }
    return { text: parts.join('\n'), images };
  }
  throw new Error('message content must be a string or an array of content parts');
}

/** messages[] -> { system, stdin }. Throws with a sentence on anything unreadable. */
export function renderConversation(messages) {
  if (!Array.isArray(messages) || messages.length === 0) throw new Error('messages must be a non-empty array');
  const system = [];
  const turns = [];
  let images = [];
  messages.forEach((m, i) => {
    if (!m || typeof m !== 'object') throw new Error('each message must be an object');
    const last = i === messages.length - 1;
    const c = contentOf(m.content, last && m.role === 'user');
    if (m.role === 'system' || m.role === 'developer') system.push(c.text);
    else if (m.role === 'user' || m.role === 'assistant') turns.push({ role: m.role, text: c.text });
    else throw new Error(`unsupported message role: ${JSON.stringify(m.role)}`);
    if (last) images = c.images;
  });
  if (images.length > MAX_IMAGES) throw new Error(`at most ${MAX_IMAGES} images per request`);
  if (turns.length === 0 || turns[turns.length - 1].role !== 'user') {
    throw new Error('the last non-system message must be from the user');
  }
  const stdin =
    turns.length === 1
      ? turns[0].text
      : 'Earlier turns of this conversation, for context:\n\n' +
        turns
          .slice(0, -1)
          .map((t) => `[${t.role}]\n${t.text}`)
          .join('\n\n') +
        `\n\n[user — answer this]\n${turns[turns.length - 1].text}`;
  const sys = system.length ? system.join('\n\n') : NEUTRAL_SYSTEM;
  /* One stream-json user event: the text, then any images. The CLI exits at
   * EOF after answering it.
   * 🔴 EVERY request takes this path, text-only too (2026-11-14). Until then a
   * text request used `--output-format json`, which prints no `init` event, so
   * the no-tools check in readCliOutput ran only on photo requests — the rare
   * path — and the common one trusted the flags unseen. */
  const event = {
    type: 'user',
    message: { role: 'user', content: [...(stdin ? [{ type: 'text', text: stdin }] : []), ...images] },
  };
  return { system: sys, stdin: JSON.stringify(event) + '\n', streamJson: true };
}

/**
 * The CLI's printed output -> its result object, for either output format.
 *
 * stream-json is one JSON event per line; the answer is the `result` event.
 * 🔴 And in that mode the `init` event lists the tools and MCP servers the
 * child actually loaded, so it is CHECKED: a child that reports any is refused
 * (502) — the flags were meant to give it none, and this is the one place the
 * bridge can see whether they did. (`plugins` is not checked: the CLI lists the
 * operator's installed plugins there even under --safe-mode, with `skills`,
 * `slash_commands` and `tools` all empty — measured 2026-10-15.)
 */
export function readCliOutput(out, streamJson) {
  if (!streamJson) return JSON.parse(out);
  let result = null;
  let sawInit = false;
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const ev = JSON.parse(line);
    if (ev && ev.type === 'system' && ev.subtype === 'init') {
      sawInit = true;
      const tools = Array.isArray(ev.tools) ? ev.tools : null;
      const mcp = Array.isArray(ev.mcp_servers) ? ev.mcp_servers : null;
      if (!tools || tools.length || !mcp || mcp.length) {
        return { type: 'result', subtype: 'refused', is_error: true, result: `the claude child reported tools ${JSON.stringify(ev.tools)} / MCP servers ${JSON.stringify(ev.mcp_servers)}; this bridge runs it with none, so the answer was discarded` };
      }
    }
    if (ev && ev.type === 'result') result = ev;
  }
  if (!result) throw new Error('no result event');
  // An answer with no init event is an answer whose tool list nobody saw: the
  // check above would have passed by never running. An error result is let
  // through, because it is a 502 either way and its text is the diagnosis.
  if (!sawInit && !result.is_error) {
    return { type: 'result', subtype: 'refused', is_error: true, result: 'the claude child answered without an init event, so its tools and MCP servers could not be checked; the answer was discarded' };
  }
  return result;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Run one `claude -p`. Returns two promises:
 *   result — settles as soon as there is an ANSWER for the client (the reply,
 *            or the 504 the instant the timeout fires — not when the kill lands);
 *   closed — resolves only when the child process has actually exited.
 * The queue waits on `closed`, so "one at a time" means one CHILD at a time,
 * while the client's 504 never waits on a kill that might not land.
 * (Split 2026-10-14 after a planted no-op kill made the old single promise hang
 * the request forever: the 504 was only ever sent from the child's 'close'.)
 */
function runClaude({ bin, cliModel, system, stdin, streamJson = false, timeoutMs, signal }) {
  let answer;
  let markClosed;
  const result = new Promise((res, rej) => { answer = { res, rej }; });
  const closed = new Promise((r) => { markClosed = r; });
  let answered = false;
  const settle = (ok, v) => {
    if (answered) return;
    answered = true;
    if (ok) answer.res(v); else answer.rej(v);
  };

  const root = mkdtempSync(join(tmpdir(), 'claude-bridge-'));
  const work = join(root, 'cwd');
  mkdirSync(work);
  const systemFile = join(root, 'system.txt');
  writeFileSync(systemFile, system, { mode: 0o600 });
  const cleanup = () => rmSync(root, { recursive: true, force: true });

  let child;
  try {
    child = spawn(bin, claudeArgs(cliModel, systemFile, { streamJson }), {
      cwd: work,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true, // own process group, so a kill reaches its children too
    });
  } catch (e) {
    cleanup();
    settle(false, new HttpError(502, `could not start ${bin}: ${e.message}`));
    markClosed();
    return { result, closed };
  }

  let out = '';
  let err = '';
  let killedFor = null;
  const kill = (why) => {
    if (killedFor || child.exitCode !== null || child.signalCode !== null) return;
    killedFor = why;
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
    setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    }, 2000).unref();
  };
  const timer = setTimeout(() => {
    kill('timeout');
    settle(false, new HttpError(504, `claude did not answer within ${timeoutMs / 1000} s and was killed`));
  }, timeoutMs);
  const onAbort = () => {
    // A reason that is an HttpError (the pause) is answered as itself; anything else is the client leaving.
    const why = signal.reason instanceof HttpError ? signal.reason : null;
    kill(why ? 'llm-pause' : 'client-abort');
    settle(false, why || new HttpError(499, 'client went away; claude was killed'));
  };
  signal.addEventListener('abort', onAbort, { once: true });

  let ended = false;
  const end = (fn) => {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
    cleanup();
    fn();
    markClosed();
  };

  child.stdout.on('data', (d) => {
    out += d;
    if (out.length > MAX_STDOUT) {
      kill('stdout-too-large');
      settle(false, new HttpError(502, 'claude produced more output than this bridge accepts and was killed'));
    }
  });
  child.stderr.on('data', (d) => {
    if (err.length < MAX_STDERR) err += d;
  });
  child.on('error', (e) =>
    end(() => settle(false, new HttpError(502, `could not run ${bin}: ${e.message}`))),
  );
  child.on('close', (code, sig) =>
    end(() => {
      if (killedFor) return settle(false, new HttpError(502, `claude was killed (${killedFor})`));
      let j;
      try {
        j = readCliOutput(out, streamJson);
      } catch {
        const tail = (err || out).trim().slice(0, 600);
        return settle(false, new HttpError(502, `claude exited ${code ?? sig} without a JSON result: ${tail || '(no output)'}`));
      }
      if (j.is_error || j.subtype !== 'success' || typeof j.result !== 'string') {
        const why = typeof j.result === 'string' && j.result ? j.result : (j.subtype || 'unknown error');
        return settle(false, new HttpError(502, `claude reported an error: ${String(why).slice(0, 600)}`));
      }
      settle(true, { text: j.result, usage: j.usage || {} });
    }),
  );

  child.stdin.on('error', () => { /* child died before reading; 'close' reports it */ });
  child.stdin.end(stdin);
  return { result, closed };
}

/* ─────────────────────────────── server ─────────────────────────────── */

export function createBridge(opts) {
  const {
    token,
    origins = DEFAULT_ORIGINS,
    timeoutS = DEFAULT_TIMEOUT_S,
    maxBody = DEFAULT_MAX_BODY,
    bin = 'claude',
    caveman = true,
    peersOf = () => [],
    pauseFile = join(homedir(), PAUSE_FILE_REL),
    log = (line) => process.stdout.write(line + '\n'),
  } = opts;
  if (!token) throw new Error('createBridge needs a token');
  const allowed = new Set(origins.map((o) => o.replace(/\/+$/, '')));

  // One child at a time. A chain of promises; `pending` bounds the backlog.
  let chain = Promise.resolve();
  let pending = 0;

  const server = http.createServer((req, res) => {
    const t0 = Date.now();
    const origin = req.headers.origin;
    const path = (req.url || '').split('?')[0];
    res.on('finish', () => {
      log(`${new Date().toISOString()} ${req.method} ${path} origin=${origin || '-'} ${res.statusCode} ${Date.now() - t0}ms`);
    });

    const cors = {};
    if (origin && allowed.has(origin)) {
      cors['Access-Control-Allow-Origin'] = origin;
      cors['Vary'] = 'Origin';
    }
    const send = (status, body, extra = {}) => {
      if (res.headersSent || res.destroyed) return;
      const data = JSON.stringify(body);
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(data),
        'Cache-Control': 'no-store',
        ...cors,
        ...extra,
      });
      res.end(data);
    };
    const fail = (status, message, extra) =>
      send(status, { error: { message, type: 'claude_bridge_error', code: status } }, extra);

    // DNS-rebinding guard: the Host must name this loopback listener.
    const host = String(req.headers.host || '').toLowerCase();
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) {
      return fail(403, 'Host header is not a loopback address');
    }
    // Browsers always send Origin on cross-origin requests; a request without
    // one is a non-browser local client and still needs the token.
    if (origin && !allowed.has(origin)) {
      return fail(403, `origin ${origin} is not allowed (start the bridge with --allow-origin ${origin})`);
    }

    if (req.method === 'OPTIONS') {
      const extra = {
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'authorization, content-type',
        'Access-Control-Max-Age': '600',
      };
      if (String(req.headers['access-control-request-private-network']).toLowerCase() === 'true') {
        extra['Access-Control-Allow-Private-Network'] = 'true';
      }
      res.writeHead(204, { ...cors, ...extra, 'Content-Length': '0' });
      return res.end();
    }

    // Founder 2026-11-22: "It should be automatically connected via bridge like the printer?"
    // GET /v1/hello says what this is, with no token and no body, exactly like the printer
    // and slicer bridges, so 2bee.app can fill the address by itself. It never says the token:
    // the key is still pasted once (and remembered only if the person ticks it).
    if (path === '/v1/hello') {
      if (req.method !== 'GET') return fail(405, 'use GET', { Allow: 'GET, OPTIONS' });
      return send(200, { ok: true, bridge: HELLO_ID, api: 1, needsToken: true, models: Object.keys(MODELS), peers: peersOf(), paused: isPaused(pauseFile) });
    }

    const route =
      path === '/v1/models' ? 'models' : path === '/v1/chat/completions' ? 'chat' : null;
    if (!route) return fail(404, `no route ${path}; this bridge serves /v1/hello, /v1/models and /v1/chat/completions`);
    if (route === 'models' && req.method !== 'GET') return fail(405, 'use GET', { Allow: 'GET, OPTIONS' });
    if (route === 'chat' && req.method !== 'POST') return fail(405, 'use POST', { Allow: 'POST, OPTIONS' });

    if (!tokenMatches(req.headers.authorization, token)) {
      return fail(401, 'missing or wrong bearer token — paste the bridge token into the Key field', {
        'WWW-Authenticate': 'Bearer',
      });
    }

    if (route === 'models') {
      return send(200, {
        object: 'list',
        data: Object.keys(MODELS).map((id) => ({ id, object: 'model', owned_by: 'local-claude-cli' })),
      });
    }

    // POST /v1/chat/completions — refused while the fleet AI pause is on, before the body is read.
    if (isPaused(pauseFile)) {
      req.resume();
      return fail(503, pausedError(pauseFile).message);
    }
    // Read the body under a cap.
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBody) {
      fail(413, `request body exceeds ${maxBody} bytes`, { Connection: 'close' });
      req.resume();
      return;
    }
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', (c) => {
      if (over) return;
      size += c.length;
      if (size > maxBody) {
        over = true;
        fail(413, `request body exceeds ${maxBody} bytes`, { Connection: 'close' });
        return;
      }
      chunks.push(c);
    });
    req.on('end', async () => {
      if (over) return;
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return fail(400, 'request body is not JSON');
      }
      if (!body || typeof body !== 'object') return fail(400, 'request body must be a JSON object');
      const cliModel = MODELS[body.model];
      if (!cliModel) {
        return fail(400, `unknown model ${JSON.stringify(body.model)}; this bridge serves ${Object.keys(MODELS).join(', ')}`);
      }
      if (body.stream === true) return fail(400, 'stream: true is not supported by this bridge');
      let conv;
      try {
        conv = renderConversation(body.messages);
        if (caveman) conv = { ...conv, system: `${conv.system}\n\n${CAVEMAN_RULES}` };
      } catch (e) {
        return fail(400, e.message);
      }
      if (pending >= MAX_QUEUE) return fail(429, `bridge is busy (${pending} requests queued)`);

      const abort = new AbortController();
      res.on('close', () => {
        if (!res.writableFinished) abort.abort();
      });
      pending++;
      const job = chain.then(async () => {
        if (abort.signal.aborted) return;
        // Re-checked here: this request may have waited in the queue while the pause was switched on.
        if (isPaused(pauseFile)) return fail(503, pausedError(pauseFile).message);
        const run = runClaude({ bin, cliModel, ...conv, timeoutMs: timeoutS * 1000, signal: abort.signal });
        // And while it runs: a pause switched on mid-answer kills the child.
        const watch = setInterval(() => {
          if (isPaused(pauseFile)) abort.abort(pausedError(pauseFile));
        }, PAUSE_POLL_MS);
        try {
          const r = await run.result;
          const pt = (r.usage.input_tokens || 0) + (r.usage.cache_read_input_tokens || 0) + (r.usage.cache_creation_input_tokens || 0);
          const ct = r.usage.output_tokens || 0;
          send(200, {
            id: `chatcmpl-${randomBytes(9).toString('hex')}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: body.model,
            choices: [{ index: 0, message: { role: 'assistant', content: r.text }, finish_reason: 'stop' }],
            usage: { prompt_tokens: pt, completion_tokens: ct, total_tokens: pt + ct },
          });
        } catch (e) {
          fail(e instanceof HttpError ? e.status : 500, e.message);
        } finally {
          clearInterval(watch);
        }
        await run.closed; // the next child starts only after this one has exited
      });
      chain = job.finally(() => { pending--; });
    });
  });
  server.requestTimeout = 0; // the child timeout governs; node's default would cut long answers
  return server;
}

/* ─────────────────────────────── main ─────────────────────────────── */

function main() {
  let o;
  let tok;
  try {
    o = parseArgs(process.argv.slice(2));
    tok = resolveToken(o.tokenFile, process.env);
  } catch (e) {
    process.stderr.write(`claude-bridge: ${e.message}\n`);
    process.exit(2);
  }
  const bin = process.env.CLAUDE_BIN || 'claude';
  const server = createBridge({ token: tok.token, origins: o.origins, timeoutS: o.timeoutS, maxBody: o.maxBody, bin, caveman: o.caveman, peersOf: () => registryPeers() });
  let unregister = () => {};
  process.on('exit', () => unregister());
  server.on('error', (e) => {
    process.stderr.write(`claude-bridge: ${e.message}\n`);
    process.exit(2);
  });
  server.listen(o.port, BIND_HOST, () => {
    const { address, port } = server.address();
    unregister = registerBridge(HELLO_ID, port);
    const p = (s) => process.stdout.write(s + '\n');
    p(`claude-bridge listening on http://${address}:${port} (claude binary: ${bin})`);
    p('Paste into the app\'s Ask settings:');
    p(`  Endpoint : http://${address}:${port}/v1/chat/completions`);
    p(`  Model    : ${Object.keys(MODELS).join(' | ')}`);
    if (tok.printable) p(`  Key      : ${tok.token}    (generated for this run only)`);
    else p(`  Key      : the token from ${tok.source} (not printed)`);
    p(`Allowed origins: ${o.origins.join(', ')}`);
    p(`Timeout ${o.timeoutS} s · body cap ${o.maxBody} bytes · one request at a time`);
    const pf = join(homedir(), PAUSE_FILE_REL);
    p(isPaused(pf) ? `AI PAUSED: ${pf} exists; every chat request answers 503 until it is removed.` : `AI pause file: ${pf} (absent; checked on every request)`);
    p(o.caveman ? 'Reply style: caveman (terse prose; formats and exact values kept). --no-caveman turns it off.' : 'Reply style: normal (--no-caveman).');
  });
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
