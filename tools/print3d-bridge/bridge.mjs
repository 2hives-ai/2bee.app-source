#!/usr/bin/env node
// print3d-bridge — the 2bee.3d job engine behind a loopback HTTP API for 2bee.app's 3D print tab.
//
// ENGINE (2bee_app 2026-10-16, founder: "no orcaslicer anymore!"): the DEFAULT is 2bee.fdm, this app's own Rust
// slicer (fdm/src/bin/fdmslice.rs --presets). It reads Orca PRESET FILES (~/.config/OrcaSlicer, read only) and
// orca-defaults-x2d.config as its settings source; it never runs, stats or reads the orca-slicer binary.
// `--engine orca` brings the OrcaSlicer CLI back, for the parity tool only. 🔴 2bee.fdm HAS NOT PRINTED ANYTHING.
//
// It SLICES. It never talks to a printer: no MQTT, no FTP(S), no start / pause / stop, and it never reads OrcaSlicer's
// own config for a printer or its access code. Uploading a sliced plate is tools/printer-bridge's job (upload only,
// founder 2026-10-14); starting a print is done by a person at the printer's own screen.
//
// Shape (auth, Host guard, Origin allowlist, PNA preflight, token rules, exit 2 on bad arguments) follows
// tools/printer-bridge/bridge.mjs on purpose: one pattern for every local bridge this app talks to.
//
// Run:  node tools/print3d-bridge/bridge.mjs [--port 8789] [--token-file F] ...   (see README.md for every flag)

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { peers as registryPeers, register as registerBridge } from '../bridge-registry.mjs';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

const require = createRequire(import.meta.url);

export const DEFAULT_PORT = 8789;
export const BIND_HOST = '127.0.0.1';
export const DEFAULT_ORIGINS = ['http://localhost:5178', 'http://127.0.0.1:5178', 'https://2bee.app'];
export const DEFAULT_MAX_BODY = 110 * 1024 * 1024;
const HOME = os.homedir();
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_FDM_BIN = path.resolve(HERE, '../../target/release/fdmslice');
export const DEFAULT_FDM_DEFAULTS = path.join(HERE, 'orca-defaults-x2d.config');

/* ─────────────────────────────── arguments ─────────────────────────────── */

export function parseArgs(argv, env = process.env) {
  const o = {
    port: DEFAULT_PORT,
    host: BIND_HOST,
    origins: [...DEFAULT_ORIGINS],
    tokenFile: null,
    engine: 'twobee-fdm',
    fdmBin: env.FDM_BIN || DEFAULT_FDM_BIN,
    fdmDefaults: DEFAULT_FDM_DEFAULTS,
    orcaBin: env.ORCA_BIN || path.join(HOME, 'build/OrcaSlicer/build/package/bin/orca-slicer'),
    orcaConfig: env.ORCA_CONFIG || path.join(HOME, '.config/OrcaSlicer'),
    dataDir: path.join(HOME, '.local/share/2bee-print3d'),
    maxBody: DEFAULT_MAX_BODY,
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
    else if (a === '--engine') { o.engine = val(); if (!['twobee-fdm', 'orca'].includes(o.engine)) throw new Error('--engine must be twobee-fdm (default) or orca'); }
    else if (a === '--fdm-bin') o.fdmBin = val();
    else if (a === '--fdm-defaults') o.fdmDefaults = val();
    else if (a === '--orca-bin') o.orcaBin = val();
    else if (a === '--orca-config') o.orcaConfig = val();
    else if (a === '--data-dir') o.dataDir = val();
    else if (a === '--max-body') o.maxBody = int(val(), '--max-body', 1);
    else throw new Error(`unknown argument: ${a}`);
  }
  if (o.port > 65535) throw new Error('--port must be <= 65535');
  if (o.host !== BIND_HOST) throw new Error(`refusing to bind ${o.host}: this bridge binds ${BIND_HOST} only`);
  return o;
}

/** Same rules as printer-bridge: --token-file wins, then env, else a token generated for this run. */
export function resolveToken(tokenFile, env) {
  let token;
  let source;
  if (tokenFile) {
    token = fs.readFileSync(tokenFile, 'utf8').trim();
    source = `--token-file ${tokenFile}`;
  } else if (env.PRINT3D_BRIDGE_TOKEN !== undefined) {
    token = env.PRINT3D_BRIDGE_TOKEN.trim();
    source = 'env PRINT3D_BRIDGE_TOKEN';
  } else {
    return { token: randomBytes(24).toString('base64url'), source: 'generated', printable: true };
  }
  if (token.length < 16) throw new Error(`the token from ${source} is shorter than 16 characters`);
  if (/\s/.test(token)) throw new Error(`the token from ${source} contains whitespace`);
  return { token, source, printable: false };
}

/* ─────────────────────────────── server ─────────────────────────────── */

const digest = (s) => createHash('sha256').update(s).digest();
function tokenMatches(header, token) {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header || '');
  if (!m) return false;
  return timingSafeEqual(digest(m[1]), digest(token));
}

class HttpError extends Error {
  constructor(status, msg) {
    super(msg);
    this.status = status;
  }
}

/**
 * opts: { token, orcaBin, orcaConfig, dataDir, origins?, maxBody?, log? }
 * jobs.cjs reads WS_JOBS_DIR / WS_UPLOAD_DIR when it is first required, so they are set here, before the engine is loaded.
 * (One data dir per process: the engine modules are cached after the first require.)
 */
export function createBridge(opts) {
  const { token, engine: engineId = 'twobee-fdm', fdmBin = DEFAULT_FDM_BIN, fdmDefaults = DEFAULT_FDM_DEFAULTS, orcaBin, orcaConfig, dataDir, origins = DEFAULT_ORIGINS, maxBody = DEFAULT_MAX_BODY, log = (l) => process.stdout.write(l + '\n') } = opts;
  if (!token) throw new Error('createBridge needs a token');
  if (!dataDir) throw new Error('createBridge needs a dataDir');
  process.env.WS_JOBS_DIR = path.join(dataDir, 'jobs');
  process.env.WS_UPLOAD_DIR = path.join(dataDir, 'uploads');
  const E = require('./engine.cjs');
  const jobs = require('./jobs.cjs');
  const beds = require('./beds.cjs');
  const slotsFile = path.join(dataDir, 'slots.json');
  const engine = E.createEngine({ engine: engineId, fdmBin, fdmDefaults, orcaBin: engineId === 'orca' ? orcaBin : null, orcaConfig, sliceDir: path.join(dataDir, 'slices'), slotsFile });
  const allowed = new Set(origins.map((o) => o.replace(/\/+$/, '')));

  const timers = [setInterval(() => { engine.sweep().catch(() => {}); jobs.sweepUploads().catch(() => {}); }, 10 * 60 * 1000), setInterval(() => engine.pruneJobs(), 30 * 60 * 1000)];
  for (const t of timers) t.unref();
  engine.sweep().catch(() => {});
  engine.pruneJobs();

  const readBody = (req) => new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    let over = false;
    req.on('data', (c) => {
      if (over) return;
      n += c.length;
      if (n > maxBody) { over = true; reject(new HttpError(413, `request body exceeds ${maxBody} bytes`)); req.resume(); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!over) resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
  const asJson = async (req) => {
    const b = await readBody(req);
    try { return JSON.parse(b.toString('utf8')); } catch { throw new HttpError(400, 'body is not valid JSON'); }
  };
  // server.js norm(): qty copies are expanded for every route, so object indices are copies.
  // (2bee_app 2026-11-13) through E.cleanJobO: the vendored cleanJob drops per-object `overrides`.
  const norm = (b) => { try { return { ...b, objects: E.cleanJobO(b).objects }; } catch (e) { throw new HttpError(400, e.message); } };
  // Per-object settings of a job in keepQty order (one entry per saved object), validated; null where none.
  const perObject = (j) => { try { return E.cleanJobO(j, { keepQty: true }).objects.map((o) => o.overrides || null); } catch (e) { throw new HttpError(400, e.message); } };
  const guard = (fn) => fn().catch((e) => { throw e && e.status ? e : new HttpError(400, e.message); });
  // 503 with the reason when what slicing needs is missing. Never a fallback to another engine.
  const needEngine = () => {
    const h = engine.health();
    if (engineId === 'orca' && !h.engine.found) throw new HttpError(503, `orca-slicer not found at ${h.engine.bin} (start the bridge with --orca-bin <path> or env ORCA_BIN)`);
    if (engineId !== 'orca' && !h.engine.found) throw new HttpError(503, `the 2bee.fdm engine (fdmslice) is not at ${h.engine.bin}: build it with \`cargo build --release -p twobee-fdm\` or start the bridge with --fdm-bin <path>`);
    if (engineId !== 'orca' && !h.engine.defaultsFound) throw new HttpError(503, `the settings defaults file ${h.engine.defaults} is missing (start the bridge with --fdm-defaults <file>)`);
    if (!h.machine.found) throw new HttpError(503, `the ${h.machine.name} machine profile is not in ${orcaConfig}: the slicer reads its settings from these preset files (start with --orca-config <dir>)`);
  };
  const slotsReply = () => { const s = engine.loadSlots(); return { ok: true, bedPlate: s.bedPlate, slots: s.slots, types: E.FILAMENT_TYPES, bedTypes: E.BED_PLATES }; };

  const server = http.createServer(async (req, res) => {
    const t0 = Date.now();
    const origin = req.headers.origin;
    const urlPath = (req.url || '').split('?')[0];
    res.on('finish', () => log(`${new Date().toISOString()} ${req.method} ${urlPath} origin=${origin || '-'} ${res.statusCode} ${Date.now() - t0}ms`));

    const cors = {};
    if (origin && allowed.has(origin)) { cors['Access-Control-Allow-Origin'] = origin; cors['Vary'] = 'Origin'; }
    const send = (status, body, extra = {}) => {
      if (res.headersSent || res.destroyed) return;
      const data = JSON.stringify(body);
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data), 'Cache-Control': 'no-store', ...cors, ...extra });
      res.end(data);
    };
    const sendRaw = (status, buf, type, extra = {}) => {
      res.writeHead(status, { 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': 'no-store', ...cors, ...extra });
      res.end(buf);
    };
    const fail = (status, message, extra) => send(status, { ok: false, error: message }, extra);

    // DNS-rebinding guard: the Host must name this loopback listener.
    const host = String(req.headers.host || '').toLowerCase();
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) return fail(403, 'Host header is not a loopback address');
    if (origin && !allowed.has(origin)) return fail(403, `origin ${origin} is not allowed (start the bridge with --allow-origin ${origin})`);

    if (req.method === 'OPTIONS') {
      const extra = { 'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS', 'Access-Control-Allow-Headers': 'authorization, content-type', 'Access-Control-Max-Age': '600' };
      if (String(req.headers['access-control-request-private-network']).toLowerCase() === 'true') extra['Access-Control-Allow-Private-Network'] = 'true';
      res.writeHead(204, { ...cors, ...extra, 'Content-Length': '0' });
      return res.end();
    }

    // Discovery (founder 2026-11-19): the ONE route without a token. It says what this is and
    // nothing else — no engine path, no data dir, no version — so the page can put this address in
    // the right row. Host guard and Origin allowlist above still apply.
    if (req.method === 'GET' && urlPath === '/v1/hello') return send(200, { ok: true, bridge: '2bee.print3d-bridge', api: 1, needsToken: true, peers: registryPeers() });

    if (!tokenMatches(req.headers.authorization, token)) {
      req.resume();
      return fail(401, 'missing or wrong bearer token', { 'WWW-Authenticate': 'Bearer' });
    }

    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBody) {
      req.resume();
      return fail(413, `request body exceeds ${maxBody} bytes`, { Connection: 'close' });
    }

    const url = new URL(req.url, 'http://127.0.0.1');
    const m = req.method;
    const p = url.pathname;
    try {
      if (m === 'GET' && p === '/v1/health') {
        const h = engine.health();
        return send(200, { ok: true, ...h, printing: false, note: 'slices only; it never talks to a printer' + (engineId === 'orca' ? '' : '; 2bee.fdm has not printed anything yet: the first print on a printer is a calibration print') });
      }
      if (m === 'GET' && p === '/v1/profiles') { needEngine(); return send(200, await engine.profiles()); }
      if (m === 'GET' && p === '/v1/slots') return send(200, slotsReply());
      if (m === 'PUT' && p === '/v1/slots') {
        const b = await asJson(req);
        try { E.writeSlotsFile(slotsFile, b); } catch (e) { throw new HttpError(400, e.message); }
        return send(200, slotsReply());
      }
      if (m === 'POST' && p === '/v1/job/upload') {
        const buf = await readBody(req);
        return send(200, { ok: true, ...(await guard(async () => jobs.putUpload(buf, url.searchParams.get('name') || 'model.stl'))) });
      }
      const fm = p.match(/^\/v1\/job\/file\/([0-9a-f]{64})$/);
      if (m === 'GET' && fm) {
        const buf = await jobs.getUpload(fm[1]);
        if (!buf) throw new HttpError(404, 'file not on the bridge (upload it again)');
        return sendRaw(200, buf, 'model/stl');
      }
      if (m === 'POST' && p === '/v1/job/arrange') { needEngine(); return send(200, await engine.runJob(norm(await asJson(req)), false)); }
      if (m === 'POST' && p === '/v1/job/slice') { needEngine(); return send(200, await engine.sliceRoute(norm(await asJson(req)))); }
      if (m === 'POST' && p === '/v1/job/plates') { needEngine(); return send(200, await engine.planBeds(norm(await asJson(req)))); }
      if (m === 'GET' && p === '/v1/job/strategies') {
        return send(200, { ok: true, strategies: beds.strategyList(), objectives: Object.entries(beds.OBJECTIVES).map(([id, o]) => ({ id, label: o.label, blurb: o.blurb, weights: o.w })), defaultObjective: beds.DEFAULT_OBJECTIVE });
      }
      if (m === 'POST' && p === '/v1/job/save') {
        const b = await asJson(req);
        const per = perObject(b.job || b);
        const r = await guard(() => jobs.saveJob(b.job || b));
        // The vendored saveJob drops per-object settings: written back into the saved file and the reply, object by object.
        if (per.some(Boolean)) {
          const f = path.join(jobs.JOBS_DIR, r.id + '.json'), d = JSON.parse(fs.readFileSync(f, 'utf8'));
          if (d.objects.length !== per.length || r.job.objects.length !== per.length) throw new HttpError(500, 'saved job objects do not line up with the per-object settings');
          d.objects.forEach((o, i) => { if (per[i]) o.overrides = per[i]; });
          r.job.objects.forEach((o, i) => { if (per[i]) o.overrides = per[i]; });
          fs.writeFileSync(f, JSON.stringify(d, null, 1));
        }
        return send(200, { ok: true, id: r.id, path: path.join(jobs.JOBS_DIR, r.id + '.json'), job: r.job });
      }
      if (m === 'GET' && p === '/v1/job/list') return send(200, { ok: true, dir: jobs.JOBS_DIR, jobs: await jobs.listJobs() });
      if (m === 'POST' && p === '/v1/job/load') {
        const b = await asJson(req);
        const raw = b.id ? await guard(() => jobs.readSavedJob(String(b.id))) : (b.job || b);
        const per = perObject(raw);
        const job = await guard(() => jobs.loadJob(raw));
        if (job.objects.length !== per.length) throw new HttpError(500, 'loaded job objects do not line up with the per-object settings');
        job.objects.forEach((o, i) => { if (per[i]) o.overrides = per[i]; });
        return send(200, { ok: true, job });
      }
      const sm = p.match(/^\/v1\/job\/saved\/([a-z0-9][a-z0-9_-]{2,60})$/);
      if (m === 'GET' && sm) {
        const raw = await guard(() => jobs.readSavedJob(sm[1])).catch(() => { throw new HttpError(404, 'saved job not found'); });
        return sendRaw(200, Buffer.from(JSON.stringify(raw)), 'application/json', { 'Content-Disposition': `attachment; filename="${sm[1]}.job.json"` });
      }
      const gm = p.match(/^\/v1\/gcode\/([0-9a-f]{16})$/);
      if (m === 'GET' && gm) {
        const f = engine.gcodePath(gm[1]);
        if (!f || !fs.existsSync(f)) throw new HttpError(404, 'G-code not found (slices expire after 1 h)');
        return sendRaw(200, fs.readFileSync(f), 'text/plain; charset=utf-8');
      }
      throw new HttpError(404, `no route ${m} ${p}; this bridge slices and serves job files only (see README.md)`);
    } catch (e) {
      const status = e && e.status ? e.status : 500;
      if (status === 500) process.stderr.write(`print3d-bridge: ${e && e.stack ? e.stack : e}\n`);
      if (!res.headersSent) fail(status, (e && e.message) || String(e));
      else res.end();
    }
  });
  server.requestTimeout = 0; // a multi-plate slice can take minutes; the engine run's own timeout (5 min per run) governs
  server.on('close', () => timers.forEach(clearInterval));
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
    process.stderr.write(`print3d-bridge: ${e.message}\n`);
    process.exit(2);
  }
  const server = createBridge({ token: tok.token, engine: o.engine, fdmBin: o.fdmBin, fdmDefaults: o.fdmDefaults, orcaBin: o.orcaBin, orcaConfig: o.orcaConfig, dataDir: o.dataDir, origins: o.origins, maxBody: o.maxBody });
  server.on('error', (e) => {
    process.stderr.write(`print3d-bridge: ${e.message}\n`);
    process.exit(2);
  });
  let unregister = () => {};
  process.on('exit', () => unregister());
  server.listen(o.port, BIND_HOST, () => {
    const { address, port } = server.address();
    unregister = registerBridge('2bee.print3d-bridge', port);
    const p = (s) => process.stdout.write(s + '\n');
    const fdm = o.engine !== 'orca';
    const binOk = fs.existsSync(fdm ? o.fdmBin : o.orcaBin);
    p(`print3d-bridge listening on http://${address}:${port} (slices with ${fdm ? '2bee.fdm, this app\'s own engine (it has not printed anything yet)' : 'OrcaSlicer (--engine orca)'}; never talks to a printer)`);
    if (tok.printable) p(`  Key      : ${tok.token}    (generated for this run only)`);
    else p(`  Key      : the token from ${tok.source} (not printed)`);
    if (fdm) {
      p(`  Engine   : 2bee.fdm ${o.fdmBin}${binOk ? '' : '  NOT FOUND — slicing routes answer 503'}`);
      p(`  Settings : Orca preset files in ${o.orcaConfig} (read only) + Orca's compiled defaults from ${o.fdmDefaults}${fs.existsSync(o.fdmDefaults) ? '' : '  NOT FOUND — slicing routes answer 503'}; the orca-slicer binary is not used`);
    } else {
      p(`  Engine   : OrcaSlicer ${o.orcaBin}${binOk ? '' : '  NOT FOUND — slicing routes answer 503'}`);
      p(`  Profiles : ${o.orcaConfig} (read only)`);
    }
    p(`  Data     : ${o.dataDir}`);
    p(`Allowed origins: ${o.origins.join(', ')}`);
  });
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
