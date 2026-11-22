// SPDX-License-Identifier: AGPL-3.0-or-later
// node --test tools/claude-bridge/
//
// Every test runs the REAL bridge.mjs as a subprocess (the shipped invocation),
// with the `claude` binary replaced by test-fixtures/fake-claude.mjs via CLAUDE_BIN.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAVEMAN_RULES } from './bridge.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BRIDGE = join(HERE, 'bridge.mjs');
const FAKE = join(HERE, 'test-fixtures', 'fake-claude.mjs');
const TOKEN = 'test-token-0123456789abcdef';
const ORIGIN = 'http://localhost:5178';

function start(args = [], env = {}) {
  const dir = mkdtempSync(join(os.tmpdir(), 'bridge-test-'));
  const record = join(dir, 'record.json');
  const proc = spawn(process.execPath, [BRIDGE, '--port', '0', ...args], {
    env: { ...process.env, CLAUDE_BIN: FAKE, CLAUDE_BRIDGE_TOKEN: TOKEN, FAKE_RECORD: record, TWOBEE_BRIDGE_REGISTRY: join(dir, 'registry'), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  proc.stdout.on('data', (d) => (out += d));
  proc.stderr.on('data', (d) => (err += d));
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`bridge did not start: ${err}`)), 5000);
    proc.on('exit', (code) => {
      clearTimeout(t);
      resolve({ exited: code, out, err });
    });
    proc.stdout.on('data', () => {
      const m = /listening on http:\/\/([\d.]+):(\d+)/.exec(out);
      if (m && out.includes('one request at a time')) {
        clearTimeout(t);
        resolve({
          proc, address: m[1], port: Number(m[2]), record, get out() { return out; },
          stop: () => new Promise((r) => { proc.once('exit', r); proc.kill('SIGTERM'); }),
        });
      }
    });
  });
}

function request(port, { method = 'GET', path = '/v1/models', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    const req = http.request(
      { host: '127.0.0.1', port, method, path, headers: { ...(data ? { 'content-length': Buffer.byteLength(data) } : {}), ...headers } },
      (res) => {
        let text = '';
        res.on('data', (d) => (text += d));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(text); } catch { /* not json */ }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      },
    );
    req.on('error', reject);
    // A hang is a FAILURE, never a wait: without this a bridge that never answers stalls the suite.
    req.setTimeout(15000, () => req.destroy(new Error('no response within 15 s')));
    if (data) req.write(data);
    req.end();
  });
}

const good = { authorization: `Bearer ${TOKEN}`, origin: ORIGIN, 'content-type': 'application/json' };
// The body ask.tsx's buildRequest() sends, field for field.
const askBody = {
  model: 'claude-sonnet',
  messages: [
    { role: 'system', content: 'SYSTEM INSTRUCTION' },
    { role: 'user', content: 'Request: make it taller\n\ncube(10);' },
  ],
  temperature: 0,
  stream: false,
};

test('GET /v1/hello names the bridge with no token, never says the token, and registers for discovery', async () => {
  const b = await start();
  try {
    const r = await request(b.port, { path: '/v1/hello', headers: { origin: 'https://2bee.app' } });
    assert.equal(r.status, 200);
    assert.equal(r.json.bridge, '2bee.claude-bridge');
    assert.equal(r.json.needsToken, true);
    assert.ok(r.json.models.includes('claude-sonnet'));
    assert.equal(r.headers['access-control-allow-origin'], 'https://2bee.app', 'the live page must be able to read the hello');
    assert.ok(!JSON.stringify(r.json).includes(TOKEN), 'hello must never carry the token');
    assert.ok(r.json.peers.some((p) => p.bridge === '2bee.claude-bridge' && p.port === b.port), 'the bridge must list itself in the registry');
    const evil = await request(b.port, { path: '/v1/hello', headers: { origin: 'https://evil.example' } });
    assert.equal(evil.status, 403, 'a page not on the allowlist learns nothing');
    assert.equal(existsSync(b.record), false, 'hello must not run claude');
  } finally { await b.stop(); }
});

test('401 without a token, and with a wrong one', async () => {
  const b = await start();
  try {
    const none = await request(b.port, { headers: { origin: ORIGIN } });
    assert.equal(none.status, 401);
    assert.equal(none.headers['access-control-allow-origin'], ORIGIN, '401 must be readable by the allowed page');
    const wrong = await request(b.port, { method: 'POST', path: '/v1/chat/completions', headers: { ...good, authorization: 'Bearer nope-nope-nope-nope' }, body: askBody });
    assert.equal(wrong.status, 401);
    assert.equal(typeof wrong.json.error.message, 'string');
    assert.equal(existsSync(b.record), false, 'claude must not run on a 401');
  } finally { await b.stop(); }
});

test('403 for an Origin not on the allowlist (even with the right token)', async () => {
  const b = await start();
  try {
    const r = await request(b.port, { method: 'POST', path: '/v1/chat/completions', headers: { ...good, origin: 'https://evil.example' }, body: askBody });
    assert.equal(r.status, 403);
    assert.equal(r.headers['access-control-allow-origin'], undefined);
    const pre = await request(b.port, { method: 'OPTIONS', path: '/v1/chat/completions', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
    assert.equal(pre.status, 403);
    assert.equal(existsSync(b.record), false);
  } finally { await b.stop(); }
});

test('--allow-origin adds an origin', async () => {
  const b = await start(['--allow-origin', 'http://localhost:9999']);
  try {
    const r = await request(b.port, { headers: { ...good, origin: 'http://localhost:9999' } });
    assert.equal(r.status, 200);
  } finally { await b.stop(); }
});

test('403 for a non-loopback Host header (DNS rebinding)', async () => {
  const b = await start();
  try {
    const r = await request(b.port, { headers: { ...good, host: `attacker.example:${b.port}` } });
    assert.equal(r.status, 403);
  } finally { await b.stop(); }
});

test('200 + OpenAI shape for the exact ask.tsx body; argv carries the no-tools flags', async () => {
  const b = await start();
  try {
    const r = await request(b.port, { method: 'POST', path: '/v1/chat/completions', headers: good, body: askBody });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.headers['access-control-allow-origin'], ORIGIN);
    assert.equal(r.json.choices[0].message.role, 'assistant');
    assert.equal(r.json.choices[0].message.content, 'canned reply');

    const rec = JSON.parse(readFileSync(b.record, 'utf8'));
    const a = rec.argv;
    const after = (f) => a[a.indexOf(f) + 1];
    assert.ok(a.includes('-p'));
    assert.equal(after('--output-format'), 'stream-json');
    assert.ok(a.includes('--tools') && after('--tools') === '', '--tools "" disables every built-in tool');
    assert.ok(a.includes('--strict-mcp-config'));
    assert.equal(after('--mcp-config'), '{"mcpServers":{}}');
    assert.ok(a.includes('--safe-mode'));
    assert.equal(after('--permission-mode'), 'dontAsk');
    assert.equal(after('--model'), 'sonnet');
    for (const banned of ['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--add-dir', 'bypassPermissions', '--bare']) {
      assert.ok(!a.includes(banned), `argv must not contain ${banned}`);
    }
    assert.ok(rec.system.startsWith('SYSTEM INSTRUCTION\n\n'), 'system message goes to --system-prompt-file, first');
    assert.ok(rec.system.endsWith(CAVEMAN_RULES), 'caveman style rules follow it by default');
    assert.deepEqual(JSON.parse(rec.stdin).message.content, [{ type: 'text', text: askBody.messages[1].content }], 'user message goes on stdin verbatim, as one stream-json text block');
    assert.ok(!a.includes(askBody.messages[1].content), 'the prompt is not on argv');
    assert.deepEqual(rec.cwdEntries, [], 'claude runs in an EMPTY cwd');
    assert.ok(rec.cwd.startsWith(os.tmpdir()));
    assert.equal(existsSync(rec.cwd), false, 'the temp cwd is removed afterwards');
  } finally { await b.stop(); }
});

test('GET /v1/models lists the aliases in the shape parseModelList reads', async () => {
  const b = await start();
  try {
    const r = await request(b.port, { headers: good });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.data.map((d) => d.id).sort(), ['claude-fable', 'claude-haiku', 'claude-opus', 'claude-sonnet']);
  } finally { await b.stop(); }
});

test('OPTIONS preflight: CORS headers, and PNA only when asked', async () => {
  const b = await start();
  try {
    const r = await request(b.port, {
      method: 'OPTIONS', path: '/v1/chat/completions',
      headers: { origin: ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type', 'access-control-request-private-network': 'true' },
    });
    assert.equal(r.status, 204);
    assert.equal(r.headers['access-control-allow-origin'], ORIGIN);
    assert.match(r.headers['access-control-allow-methods'], /POST/);
    assert.equal(r.headers['access-control-allow-headers'], 'authorization, content-type');
    assert.equal(r.headers['access-control-allow-private-network'], 'true');
    const noPna = await request(b.port, { method: 'OPTIONS', path: '/v1/models', headers: { origin: ORIGIN, 'access-control-request-method': 'GET' } });
    assert.equal(noPna.status, 204);
    assert.equal(noPna.headers['access-control-allow-private-network'], undefined);
  } finally { await b.stop(); }
});

test('binds 127.0.0.1 only; --host anything else is refused with exit 2', async () => {
  const refused = await start(['--host', '0.0.0.0']);
  assert.equal(refused.exited, 2);
  assert.match(refused.err, /refusing to bind 0\.0\.0\.0/);

  const b = await start();
  try {
    assert.equal(b.address, '127.0.0.1');
    const ext = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
    if (!ext) {
      assert.fail('no non-loopback IPv4 interface on this machine — cannot show the bridge is unreachable from one (PENDING, not PASS)');
    }
    const outcome = await new Promise((resolve) => {
      const s = net.connect({ host: ext.address, port: b.port });
      s.once('connect', () => { s.destroy(); resolve('connected'); });
      s.once('error', (e) => resolve(e.code));
    });
    assert.equal(outcome, 'ECONNREFUSED', `reachable on ${ext.address}`);
  } finally { await b.stop(); }
});

test('413 when the body exceeds the cap (default 2 MB)', async () => {
  const b = await start();
  try {
    const big = JSON.stringify({ ...askBody, messages: [{ role: 'user', content: 'x'.repeat(2 * 1024 * 1024 + 10) }] });
    const r = await request(b.port, { method: 'POST', path: '/v1/chat/completions', headers: good, body: big });
    assert.equal(r.status, 413);
    assert.equal(existsSync(b.record), false);
  } finally { await b.stop(); }
});

test('timeout kills the child and answers 504', async () => {
  const b = await start(['--timeout', '1'], { FAKE_MODE: 'sleep' });
  try {
    const t0 = Date.now();
    const r = await request(b.port, { method: 'POST', path: '/v1/chat/completions', headers: good, body: askBody });
    assert.equal(r.status, 504, r.text);
    assert.ok(Date.now() - t0 < 5000);
    const { pid } = JSON.parse(readFileSync(b.record, 'utf8'));
    await new Promise((r2) => setTimeout(r2, 2500)); // SIGTERM, then SIGKILL after 2 s
    try {
      assert.throws(() => process.kill(pid, 0), /ESRCH/, `child ${pid} still alive after timeout`);
    } finally {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already dead — the passing case */ }
    }
  } finally { await b.stop(); }
});

test('a claude error (e.g. not logged in) is a 502 carrying its text, never a 200', async () => {
  const b = await start([], { FAKE_MODE: 'error' });
  try {
    const r = await request(b.port, { method: 'POST', path: '/v1/chat/completions', headers: good, body: askBody });
    assert.equal(r.status, 502);
    assert.match(r.json.error.message, /Not logged in/);
  } finally { await b.stop(); }
});

test('400 for unknown model and for stream:true; claude never runs', async () => {
  const b = await start();
  try {
    assert.equal((await request(b.port, { method: 'POST', path: '/v1/chat/completions', headers: good, body: { ...askBody, model: 'gpt-4' } })).status, 400);
    assert.equal((await request(b.port, { method: 'POST', path: '/v1/chat/completions', headers: good, body: { ...askBody, stream: true } })).status, 400);
    assert.equal(existsSync(b.record), false);
  } finally { await b.stop(); }
});

test('token: env/file token is never printed; a generated one is printed once', async () => {
  const env = await start();
  try { assert.ok(!env.out.includes(TOKEN)); assert.match(env.out, /env CLAUDE_BRIDGE_TOKEN \(not printed\)/); } finally { await env.stop(); }

  const dir = mkdtempSync(join(os.tmpdir(), 'bridge-tok-'));
  const f = join(dir, 'tok');
  writeFileSync(f, 'file-token-abcdefghijklmnop\n');
  const file = await start(['--token-file', f], { CLAUDE_BRIDGE_TOKEN: TOKEN });
  try {
    assert.ok(!file.out.includes('file-token-abcdefghijklmnop'));
    assert.equal((await request(file.port, { headers: { ...good, authorization: 'Bearer file-token-abcdefghijklmnop' } })).status, 200, '--token-file wins over env');
    assert.equal((await request(file.port, { headers: good })).status, 401);
  } finally { await file.stop(); }

  const gen = await start([], { CLAUDE_BRIDGE_TOKEN: undefined });
  try {
    const m = /Key {6}: (\S+) {4}\(generated/.exec(gen.out);
    assert.ok(m, gen.out);
    assert.equal(gen.out.split(m[1]).length - 1, 1, 'printed exactly once');
    assert.equal((await request(gen.port, { headers: { ...good, authorization: `Bearer ${m[1]}` } })).status, 200);
  } finally { await gen.stop(); }

  const short = await start([], { CLAUDE_BRIDGE_TOKEN: 'short' });
  assert.equal(short.exited, 2);
});

test('log lines carry no token and no body', async () => {
  const b = await start();
  try {
    await request(b.port, { method: 'POST', path: '/v1/chat/completions', headers: good, body: askBody });
    await new Promise((r) => setTimeout(r, 100));
    assert.match(b.out, /POST \/v1\/chat\/completions origin=http:\/\/localhost:5178 200 \d+ms/);
    assert.ok(!b.out.includes(TOKEN));
    assert.ok(!b.out.includes('make it taller'));
    assert.ok(!b.out.includes('canned reply'));
  } finally { await b.stop(); }
});

test('one child at a time: two concurrent requests do not overlap', async () => {
  const log = join(mkdtempSync(join(os.tmpdir(), 'bridge-q-')), 'runs.jsonl');
  const b = await start([], { FAKE_MODE: 'slow', FAKE_LOG: log });
  try {
    const opts = { method: 'POST', path: '/v1/chat/completions', headers: good, body: askBody };
    const [r1, r2] = await Promise.all([request(b.port, opts), request(b.port, opts)]);
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    const runs = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).sort((x, y) => x.start - y.start);
    assert.equal(runs.length, 2);
    assert.ok(runs[1].start >= runs[0].end, `overlap: ${JSON.stringify(runs)}`);
  } finally { await b.stop(); }
});

/* ── Images (the Tools tab's "photo the cutter", 2026-10-15) ─────────────── */

// A 1×1 PNG. The bridge does not decode images; it only checks the data URL's shape.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const imageBody = (url = `data:image/png;base64,${PNG_B64}`) => ({
  model: 'claude-haiku',
  messages: [
    { role: 'system', content: 'TOOL PHOTO INSTRUCTION' },
    { role: 'user', content: [{ type: 'text', text: 'What cutter is this?' }, { type: 'image_url', image_url: { url } }] },
  ],
  temperature: 0,
  stream: false,
});

test('an image_url data URL reaches the CLI as a stream-json image block, with every no-tools flag kept', async () => {
  const b = await start();
  try {
    const r = await request(b.port, { method: 'POST', path: '/v1/chat/completions', headers: good, body: imageBody() });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.choices[0].message.content, 'canned reply (1 image)');
    const rec = JSON.parse(readFileSync(b.record, 'utf8'));
    const a = rec.argv;
    const after = (f) => a[a.indexOf(f) + 1];
    assert.equal(after('--input-format'), 'stream-json');
    assert.equal(after('--output-format'), 'stream-json');
    assert.ok(a.includes('--verbose'));
    assert.ok(a.includes('--tools') && after('--tools') === '');
    assert.ok(a.includes('--strict-mcp-config'));
    assert.equal(after('--mcp-config'), '{"mcpServers":{}}');
    assert.ok(a.includes('--safe-mode'));
    assert.equal(after('--permission-mode'), 'dontAsk');
    for (const banned of ['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--add-dir', 'bypassPermissions', '--bare']) {
      assert.ok(!a.includes(banned), `argv must not contain ${banned}`);
    }
    assert.equal(rec.system, `TOOL PHOTO INSTRUCTION\n\n${CAVEMAN_RULES}`);
    const ev = JSON.parse(rec.stdin);
    assert.equal(ev.type, 'user');
    assert.deepEqual(ev.message.content, [
      { type: 'text', text: 'What cutter is this?' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_B64 } },
    ]);
    assert.ok(!a.some((x) => x.includes(PNG_B64)), 'the image is not on argv');
    assert.deepEqual(rec.cwdEntries, [], 'claude runs in an EMPTY cwd');
    assert.equal(existsSync(rec.cwd), false);
  } finally { await b.stop(); }
});

test('a text-only request is tools-checked too: stream-json, and a child reporting a tool or no init is a 502', async () => {
  // 🔴 Until 2026-11-14 a text request took the plain json path, which prints
  // no init event, so the no-tools check ran only for photo requests.
  const b = await start();
  try {
    const r = await request(b.port, { method: 'POST', path: '/v1/chat/completions', headers: good, body: askBody });
    assert.equal(r.status, 200);
    const a = JSON.parse(readFileSync(b.record, 'utf8')).argv;
    assert.equal(a[a.indexOf('--input-format') + 1], 'stream-json');
    assert.equal(a[a.indexOf('--output-format') + 1], 'stream-json');
  } finally { await b.stop(); }
  for (const [mode, re] of [['tools', /reported tools \["Bash"\]/], ['noinit', /without an init event/]]) {
    const t = await start([], { FAKE_MODE: mode });
    try {
      const r = await request(t.port, { method: 'POST', path: '/v1/chat/completions', headers: good, body: askBody });
      assert.equal(r.status, 502, `${mode}: ${r.text}`);
      assert.match(r.json.error.message, re);
    } finally { await t.stop(); }
  }
});

test('images: http URL, bad type, malformed data, earlier-turn image and too many images are 400s; claude never runs', async () => {
  const b = await start();
  try {
    const post = (body) => request(b.port, { method: 'POST', path: '/v1/chat/completions', headers: good, body });
    const http1 = await post(imageBody('https://example.com/cutter.jpg'));
    assert.equal(http1.status, 400);
    assert.match(http1.json.error.message, /fetches nothing/);
    assert.equal((await post(imageBody(`data:image/svg+xml;base64,${PNG_B64}`))).status, 400);
    assert.equal((await post(imageBody('data:image/png;base64,not base64!'))).status, 400);
    const early = imageBody();
    early.messages = [early.messages[1], { role: 'assistant', content: 'ok' }, { role: 'user', content: 'and?' }];
    const er = await post(early);
    assert.equal(er.status, 400);
    assert.match(er.json.error.message, /only in the last user message/);
    const many = imageBody();
    many.messages[1].content = Array.from({ length: 5 }, () => many.messages[1].content[1]);
    assert.equal((await post(many)).status, 400);
    assert.equal(existsSync(b.record), false);
  } finally { await b.stop(); }
});

test('a child whose init event reports a tool is refused (502), never answered', async () => {
  const b = await start([], { FAKE_MODE: 'tools' });
  try {
    const r = await request(b.port, { method: 'POST', path: '/v1/chat/completions', headers: good, body: imageBody() });
    assert.equal(r.status, 502, r.text);
    assert.match(r.json.error.message, /reported tools \["Bash"\]/);
  } finally { await b.stop(); }
});

test('a downscaled photo (~400 kB as base64) fits under the default 2 MiB body cap', async () => {
  const b = await start();
  try {
    // 300 kB of bytes -> 400 kB base64: a 1024 px JPEG at q0.8 is normally well under this.
    const big = Buffer.alloc(300 * 1024, 7).toString('base64');
    const r = await request(b.port, { method: 'POST', path: '/v1/chat/completions', headers: good, body: imageBody(`data:image/jpeg;base64,${big}`) });
    assert.equal(r.status, 200, r.text);
  } finally { await b.stop(); }
});

test('--no-caveman sends the system message unchanged', async () => {
  const b = await start(['--no-caveman']);
  try {
    const r = await request(b.port, { method: 'POST', path: '/v1/chat/completions', headers: good, body: askBody });
    assert.equal(r.status, 200, r.text);
    assert.equal(JSON.parse(readFileSync(b.record, 'utf8')).system, 'SYSTEM INSTRUCTION');
  } finally { await b.stop(); }
});
