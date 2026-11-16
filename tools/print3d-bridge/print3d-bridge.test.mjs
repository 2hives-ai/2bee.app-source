// print3d-bridge tests. Run from software/2bee.app:
//   node --test tools/print3d-bridge/print3d-bridge.test.mjs
// (Name the FILE: `node --test <directory>` does not work on Node 22.)
//
// The HTTP tests spawn the REAL bridge.mjs as a subprocess on a free loopback port with a throwaway data dir.
// The default engine is 2bee.fdm (fdm/src/bin/fdmslice.rs). The shared bridge below is started with a FAKE orca-slicer
// that leaves a marker file if it is ever spawned, and a WRAPPER around the real fdmslice that logs every argv: the
// tests assert the orca marker never appears and the engine argv is the presets mode.
// The real-engine tests need target/release/fdmslice (cargo build --release -p twobee-fdm) and the X2D preset files;
// the real-Orca test needs the OrcaSlicer binary (it runs a second bridge with --engine orca). Without them a test is
// SKIPPED with a `PENDING:` reason, shows in the `# skipped` count, and is never counted as passed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(HERE, 'bridge.mjs');
const TOKEN = 'test-token-0123456789abcdef';
const HOME = os.homedir();
const ORCA_BIN = process.env.ORCA_BIN || path.join(HOME, 'build/OrcaSlicer/build/package/bin/orca-slicer');
const ORCA_CONFIG = process.env.ORCA_CONFIG || path.join(HOME, '.config/OrcaSlicer');
const MACHINE = path.join(ORCA_CONFIG, 'system/BBL/machine/Bambu Lab X2D 0.4 nozzle.json');
const PNP = '/home/gbacs/build/web-slicer';
const REAL_FDM = path.resolve(HERE, '../../target/release/fdmslice');
const FAKES = fs.mkdtempSync(path.join(os.tmpdir(), 'p3d-fakes-'));
const ORCA_MARKER = path.join(FAKES, 'orca-was-spawned');
const FAKE_ORCA = path.join(FAKES, 'orca-slicer');
fs.writeFileSync(FAKE_ORCA, `#!/bin/sh\necho "$@" >> '${ORCA_MARKER}'\nexit 1\n`, { mode: 0o755 });
const FDM_ARGV = path.join(FAKES, 'fdm-argv.log');
const FDM_WRAP = path.join(FAKES, 'fdmslice');
fs.writeFileSync(FDM_WRAP, `#!/usr/bin/env node\nconst fs=require('fs');fs.appendFileSync(${JSON.stringify(FDM_ARGV)}, JSON.stringify(process.argv.slice(2))+'\\n');\nconst r=require('child_process').spawnSync(${JSON.stringify(REAL_FDM)}, process.argv.slice(2), {stdio:'inherit'});\nprocess.exit(r.status===null?1:r.status);\n`, { mode: 0o755 });
const fdmArgv = () => (fs.existsSync(FDM_ARGV) ? fs.readFileSync(FDM_ARGV, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

function runToExit(args, env = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [BRIDGE, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (b) => { out += b; });
    p.stderr.on('data', (b) => { err += b; });
    const t = setTimeout(() => p.kill('SIGKILL'), 5000);
    p.on('exit', (code) => { clearTimeout(t); resolve({ code, out, err }); });
  });
}

async function startBridge(extra = [], { orcaBin = FAKE_ORCA, fdmBin = FDM_WRAP, orcaConfig = ORCA_CONFIG } = {}) {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'p3d-test-'));
  const p = spawn(process.execPath, [BRIDGE, '--port', String(port), '--data-dir', dataDir, '--orca-bin', orcaBin, '--fdm-bin', fdmBin, '--orca-config', orcaConfig, ...extra],
    { env: { ...process.env, PRINT3D_BRIDGE_TOKEN: TOKEN }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  p.stdout.on('data', (b) => { log += b; });
  p.stderr.on('data', (b) => { log += b; });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('bridge did not start: ' + log)), 8000);
    const iv = setInterval(() => { if (/listening on/.test(log)) { clearInterval(iv); clearTimeout(t); resolve(); } }, 30);
    p.on('exit', (c) => { clearInterval(iv); clearTimeout(t); reject(new Error('bridge exited ' + c + ': ' + log)); });
  });
  return { port, dataDir, proc: p, log: () => log, stop: () => new Promise((r) => { p.once('exit', r); p.kill('SIGTERM'); }) };
}

/** Raw request so Host / Origin can be set freely. */
function req(port, method, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buf.toString('utf8')); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, buf, json });
      });
    });
    r.on('error', reject);
    if (body !== undefined) r.write(Buffer.isBuffer(body) ? body : typeof body === 'string' ? body : JSON.stringify(body));
    r.end();
  });
}
const auth = { authorization: `Bearer ${TOKEN}` };

/** A binary STL box x*y*z mm, corner at the origin. */
function boxStl(x, y, z) {
  const v = [[0, 0, 0], [x, 0, 0], [x, y, 0], [0, y, 0], [0, 0, z], [x, 0, z], [x, y, z], [0, y, z]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const buf = Buffer.alloc(84 + 50 * f.length);
  buf.writeUInt32LE(f.length, 80);
  f.forEach((t, i) => { const o = 84 + 50 * i + 12; t.forEach((vi, k) => v[vi].forEach((c, j) => buf.writeFloatLE(c, o + 12 * k + 4 * j))); });
  return buf;
}

/** A binary STL cube, `s` mm, 12 triangles, corner at the origin. */
function cubeStl(s = 10) {
  const v = [[0, 0, 0], [s, 0, 0], [s, s, 0], [0, s, 0], [0, 0, s], [s, 0, s], [s, s, s], [0, s, s]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const buf = Buffer.alloc(84 + 50 * f.length);
  buf.writeUInt32LE(f.length, 80);
  f.forEach((t, i) => { const o = 84 + 50 * i + 12; t.forEach((vi, k) => v[vi].forEach((c, j) => buf.writeFloatLE(c, o + 12 * k + 4 * j))); });
  return buf;
}

let B;
test.before(async () => { B = await startBridge(); });
test.after(async () => { if (B) await B.stop(); });

test('401 without a token and with a wrong one; no work is done', async () => {
  const stl = cubeStl(7);
  const none = await req(B.port, 'POST', '/v1/job/upload?name=x.stl', { body: stl });
  assert.equal(none.status, 401);
  assert.equal(none.json.ok, false);
  const wrong = await req(B.port, 'POST', '/v1/job/upload?name=x.stl', { headers: { authorization: 'Bearer nope-nope-nope-nope-nope' }, body: stl });
  assert.equal(wrong.status, 401);
  const sha = createHash('sha256').update(stl).digest('hex');
  assert.equal(fs.existsSync(path.join(B.dataDir, 'uploads', sha + '.stl')), false, 'an unauthorised upload must not reach the disk');
  const h = await req(B.port, 'GET', '/v1/health');
  assert.equal(h.status, 401, 'even health needs the token');
  const put = await req(B.port, 'PUT', '/v1/slots', { body: { slots: [{ id: 'ams1-1', type: 'PLA', color: '#ff0000' }] } });
  assert.equal(put.status, 401);
  assert.equal(fs.existsSync(path.join(B.dataDir, 'slots.json')), false);
});

test('403 for a non-loopback Host and for a disallowed Origin', async () => {
  const h = await req(B.port, 'GET', '/v1/health', { headers: { ...auth, host: 'evil.example:80' } });
  assert.equal(h.status, 403);
  const o = await req(B.port, 'GET', '/v1/health', { headers: { ...auth, origin: 'https://evil.example' } });
  assert.equal(o.status, 403);
  assert.equal(o.headers['access-control-allow-origin'], undefined);
  const ok = await req(B.port, 'GET', '/v1/health', { headers: { ...auth, origin: 'http://localhost:5178' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers['access-control-allow-origin'], 'http://localhost:5178');
});

test('OPTIONS preflight answers CORS + Private Network Access for an allowed origin, without a token', async () => {
  const r = await req(B.port, 'OPTIONS', '/v1/job/slice', { headers: { origin: 'http://127.0.0.1:5178', 'access-control-request-method': 'POST', 'access-control-request-private-network': 'true' } });
  assert.equal(r.status, 204);
  assert.equal(r.headers['access-control-allow-origin'], 'http://127.0.0.1:5178');
  assert.match(r.headers['access-control-allow-methods'], /PUT/);
  assert.match(r.headers['access-control-allow-headers'], /authorization/);
  assert.equal(r.headers['access-control-allow-private-network'], 'true');
});

test('start refusals exit 2: non-loopback host, unknown flag, short token', async () => {
  const a = await runToExit(['--host', '0.0.0.0'], { PRINT3D_BRIDGE_TOKEN: TOKEN });
  assert.equal(a.code, 2); assert.match(a.err, /127\.0\.0\.1 only/);
  const b = await runToExit(['--printer', '192.168.1.2'], { PRINT3D_BRIDGE_TOKEN: TOKEN });
  assert.equal(b.code, 2); assert.match(b.err, /unknown argument/);
  const c = await runToExit([], { PRINT3D_BRIDGE_TOKEN: 'short' });
  assert.equal(c.code, 2); assert.match(c.err, /shorter than 16/);
});

test('binds 127.0.0.1 only', async () => {
  const addrs = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
  if (!addrs.length) return; // no LAN address to try; the loopback-only bind is still asserted by --host refusing above
  const reached = await new Promise((resolve) => { const s = net.connect({ host: addrs[0], port: B.port }); s.setTimeout(1500, () => { s.destroy(); resolve(false); }); s.once('connect', () => { s.destroy(); resolve(true); }); s.once('error', () => resolve(false)); });
  assert.equal(reached, false, `the bridge answered on ${addrs[0]}`);
});

test('/v1/health shape: says it slices only and never prints', async () => {
  const r = await req(B.port, 'GET', '/v1/health', { headers: auth });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.engine.id, 'twobee-fdm', 'the default engine is 2bee.fdm');
  assert.match(r.json.engine.label, /2bee\.fdm/);
  assert.equal(r.json.engine.bin, FDM_WRAP);
  assert.equal(r.json.engine.printed, false, 'the engine has never printed: the health must say so');
  assert.equal(r.json.orca, undefined, 'no orca field on the default engine');
  assert.equal(r.json.printing, false);
  assert.equal(r.json.machine.name, 'Bambu Lab X2D 0.4 nozzle');
  assert.equal(typeof r.json.machine.found, 'boolean');
  assert.match(r.json.note, /never talks to a printer/);
  assert.match(r.json.note, /calibration print/);
  assert.match(B.log(), /slices with 2bee\.fdm/);
  assert.match(B.log(), /Settings : Orca preset files in .* \+ Orca's compiled defaults from .*orca-defaults-x2d\.config; the orca-slicer binary is not used/);
});

test('printer-shaped paths do not exist (404)', async () => {
  for (const [m, p] of [['POST', '/api/printer/start'], ['POST', '/api/printer/stop'], ['POST', '/v1/print'], ['POST', '/v1/send'], ['POST', '/v1/upload'], ['GET', '/api/camera'], ['GET', '/api/printer/status']]) {
    const r = await req(B.port, m, p, { headers: auth, body: m === 'POST' ? '{}' : undefined });
    assert.equal(r.status, 404, `${m} ${p}`);
  }
});

test('PUT /v1/slots round-trips; invalid bodies are 400 and leave the file unchanged', async () => {
  const good = { bedPlate: 'Cool Plate', slots: [{ id: 'ams1-3', type: 'PETG', color: '#2E9E5B' }, { id: 'ams1-1', type: 'PLA', color: '#ffffff' }] };
  const r = await req(B.port, 'PUT', '/v1/slots', { headers: auth, body: good });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.bedPlate, 'Cool Plate');
  assert.deepEqual(r.json.slots, [{ id: 'ams1-1', label: 'AMS slot 1', type: 'PLA', color: '#ffffff' }, { id: 'ams1-3', label: 'AMS slot 3', type: 'PETG', color: '#2e9e5b' }]);
  const g = await req(B.port, 'GET', '/v1/slots', { headers: auth });
  assert.deepEqual(g.json.slots, r.json.slots);
  assert.ok(g.json.types.includes('PETG'));
  const file = path.join(B.dataDir, 'slots.json');
  const before = fs.readFileSync(file);
  for (const bad of [
    { slots: [{ id: 'ams1-1', type: 'WOOD', color: '#ffffff' }] },
    { slots: [{ id: 'ams1-1', type: 'PLA', color: 'red' }] },
    { slots: [{ id: 'ams9-9', type: 'PLA', color: '#ffffff' }] },
    { bedPlate: 'Glass', slots: [{ id: 'ams1-1', type: 'PLA', color: '#ffffff' }] },
    { slots: [] },
  ]) {
    const x = await req(B.port, 'PUT', '/v1/slots', { headers: auth, body: bad });
    assert.equal(x.status, 400, JSON.stringify(bad));
    assert.equal(x.json.ok, false);
  }
  assert.ok(fs.readFileSync(file).equals(before), 'a refused PUT changed the slots file');
  // restore the PETG slot the real-Orca test uses
  await req(B.port, 'PUT', '/v1/slots', { headers: auth, body: { slots: [{ id: 'ams1-3', type: 'PETG', color: '#2e9e5b' }] } });
});

test('upload a binary cube: sha256 + size3d; the file reads back byte for byte; garbage is 400', async () => {
  const stl = cubeStl(10);
  const r = await req(B.port, 'POST', '/v1/job/upload?name=cube.stl', { headers: auth, body: stl });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.sha256, createHash('sha256').update(stl).digest('hex'));
  assert.deepEqual(r.json.size3d, { x: 10, y: 10, z: 10 });
  assert.equal(r.json.triangles, 12);
  const back = await req(B.port, 'GET', '/v1/job/file/' + r.json.sha256, { headers: auth });
  assert.equal(back.status, 200);
  assert.ok(back.buf.equals(stl));
  const junk = await req(B.port, 'POST', '/v1/job/upload?name=junk.stl', { headers: auth, body: Buffer.alloc(200, 7) });
  assert.equal(junk.status, 400);
  const missing = await req(B.port, 'GET', '/v1/job/file/' + '0'.repeat(64), { headers: auth });
  assert.equal(missing.status, 404);
});

// GET /v1/gcode/<id>: the sliced-plate preview (web/src/print3d/gcodePath.ts) reads the G-code from here. Harness only:
// a plate_1.gcode is written into this bridge's own throwaway data dir, so no engine has to run.
test('GET /v1/gcode/<id>: 200 for a slice id, 404 unknown, traversal never reaches a file, 401 without a token', async () => {
  const id = '0123456789abcdef';
  const body = '; generated by twobee-fdm (test)\nM83\n; CHANGE_LAYER\n; Z_HEIGHT: 0.2\nG1 X10 Y10 Z.2\nG1 X20 Y10 E.5\n';
  fs.mkdirSync(path.join(B.dataDir, 'slices', id), { recursive: true });
  fs.writeFileSync(path.join(B.dataDir, 'slices', id, 'plate_1.gcode'), body);
  fs.writeFileSync(path.join(B.dataDir, 'secret.gcode'), 'SECRET');
  fs.writeFileSync(path.join(B.dataDir, 'slices', id, 'other.txt'), 'SECRET');

  const ok = await req(B.port, 'GET', `/v1/gcode/${id}`, { headers: { ...auth, origin: 'http://localhost:5178' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.buf.toString('utf8'), body, 'the file comes back byte for byte');
  assert.match(ok.headers['content-type'], /^text\/plain/);
  assert.equal(ok.headers['access-control-allow-origin'], 'http://localhost:5178');

  const unknown = await req(B.port, 'GET', '/v1/gcode/fedcba9876543210', { headers: auth });
  assert.equal(unknown.status, 404);
  assert.match(unknown.json.error, /G-code not found/);

  for (const p of [
    '/v1/gcode/..%2Fsecret.gcode',
    '/v1/gcode/..%2F..%2Fsecret.gcode',
    `/v1/gcode/${id}%2F..%2F..%2Fsecret.gcode`,
    `/v1/gcode/${id}/../other.txt`,
    '/v1/gcode/../../secret.gcode',
    `/v1/gcode/${id}x`,
    `/v1/gcode/${id.toUpperCase()}`,
    '/v1/gcode/0123456789abcde',
  ]) {
    const r = await req(B.port, 'GET', p, { headers: auth });
    assert.ok(r.status === 400 || r.status === 404, `${p}: ${r.status}`);
    assert.doesNotMatch(r.buf.toString('utf8'), /SECRET/, `${p} returned a file it must not`);
  }

  const none = await req(B.port, 'GET', `/v1/gcode/${id}`);
  assert.equal(none.status, 401);
  assert.doesNotMatch(none.buf.toString('utf8'), /twobee-fdm/);
  const badOrigin = await req(B.port, 'GET', `/v1/gcode/${id}`, { headers: { ...auth, origin: 'https://evil.example' } });
  assert.equal(badOrigin.status, 403);
  const badHost = await req(B.port, 'GET', `/v1/gcode/${id}`, { headers: { ...auth, host: 'evil.example' } });
  assert.equal(badHost.status, 403);
});

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

test('no printer channel by construction: engine.cjs + bridge.mjs carry no MQTT / FTP / access-code path', () => {
  const bad = /mqtt|8883|basic-ftp|OrcaSlicer\.conf|access_code|project_file|\bftp\b/i;
  for (const f of ['engine.cjs', 'bridge.mjs', 'jobs.cjs', 'beds.cjs', 'allowlist.cjs', 'multipart.cjs']) {
    const code = stripComments(fs.readFileSync(path.join(HERE, f), 'utf8'));
    const m = code.match(bad);
    assert.equal(m, null, `${f} contains ${m && m[0]}`);
  }
});

test('vendored files match the pnp source they name', (t) => {
  if (!fs.existsSync(PNP)) { t.skip(`PENDING: ${PNP} is not on this machine, so the recorded hashes cannot be compared`); return; }
  for (const m of ['jobs', 'beds', 'allowlist', 'multipart']) {
    const v = fs.readFileSync(path.join(HERE, m + '.cjs'), 'utf8');
    const rec = (v.match(/^\/\/ Source sha256: ([0-9a-f]{64})$/m) || [])[1];
    assert.ok(rec, `${m}.cjs has no provenance hash`);
    const src = fs.readFileSync(path.join(PNP, m + '.js'));
    assert.equal(createHash('sha256').update(src).digest('hex'), rec, `${m}.js in pnp's tree has moved since it was vendored: re-vendor`);
    // and the vendored body IS that source, apart from the header and the require paths
    const body = v.split('\n').slice(3).join('\n').replace(/require\('\.\/(jobs|beds)\.cjs'\)/g, "require('./$1')");
    assert.equal(body, src.toString('utf8'), `${m}.cjs differs from the source beyond the documented edits`);
  }
});

const haveFdm = () => fs.existsSync(REAL_FDM) && fs.existsSync(MACHINE);
const sliceJob = (sha, proc, slot = 'ams1-3', placement = { x: 128, y: 128, rot: 0 }) => ({ version: 1, name: 'cube10', process: proc, files: [{ name: 'cube10.stl', size: 684, sha256: sha }],
  objects: [{ file: 0, slot, bed: 1, placement }], slotPresets: {}, overrides: {}, bedIndex: 1, optimise: false });

test('DEFAULT ENGINE 2bee.fdm: the app path (fixed placement, optimise off) slices a cube; orca is never spawned; argv is the presets mode', { timeout: 120000 }, async (t) => {
  if (!haveFdm()) { t.skip(`PENDING: ${REAL_FDM} (cargo build --release -p twobee-fdm) or the X2D preset files are not on this machine`); return; }
  await req(B.port, 'PUT', '/v1/slots', { headers: auth, body: { slots: [{ id: 'ams1-3', type: 'PETG', color: '#2e9e5b' }] } });
  const stl = cubeStl(10);
  const up = (await req(B.port, 'POST', '/v1/job/upload?name=cube10.stl', { headers: auth, body: stl })).json;
  const before = fdmArgv().length;
  const sl = (await req(B.port, 'POST', '/v1/job/slice', { headers: auth, body: sliceJob(up.sha256, '0.20mm Standard @BBL X2D', 'ams1-3', { x: 100, y: 120, rot: 0 }) })).json;
  assert.equal(sl.ok, true, JSON.stringify(sl).slice(0, 600));
  assert.equal(sl.engine, 'twobee-fdm');
  assert.equal(Number(sl.stats.layers), 50, '10 mm at 0.2 mm layers');
  assert.match(sl.stats.totalTime, /\d+m/);
  assert.ok(Number(sl.stats.filamentG) > 0);
  assert.equal(sl.stats.bedType, 'Textured PEI Plate');
  assert.equal(sl.wipeTower, undefined, 'no prime tower is computed: absent, not invented');
  assert.ok(Array.isArray(sl.notComputed) && sl.notComputed.length > 0);
  assert.deepEqual(sl.objects[0].placement, { x: 100, y: 120, rot: 0 });
  const g = await req(B.port, 'GET', '/v1/gcode/' + sl.id, { headers: auth });
  assert.equal(g.status, 200);
  const text = g.buf.toString('utf8');
  assert.match(text, /; generated by twobee-fdm/);
  assert.doesNotMatch(text, /FDM-UNRESOLVED/);
  const ext = text.match(/^; FEATURE: Outer wall[\s\S]*?^G1 X([\d.]+) Y([\d.]+)/m);
  assert.ok(ext && Math.abs(Number(ext[1]) - 100) < 6 && Math.abs(Number(ext[2]) - 120) < 6, 'the walls are where the page placed the part');
  const calls = fdmArgv().slice(before);
  assert.equal(calls.length, 1, 'one engine run for one plate');
  assert.equal(calls[0][0], '--presets');
  assert.ok(calls[0].includes('--defaults') && calls[0].includes('--config-dir'));
  assert.equal(fs.existsSync(ORCA_MARKER), false, 'the orca-slicer binary was spawned on the default path: ' + (fs.existsSync(ORCA_MARKER) ? fs.readFileSync(ORCA_MARKER, 'utf8') : ''));
  t.diagnostic(`2bee.fdm: ${sl.stats.totalTime}, ${sl.stats.layers} layers, ${sl.stats.filamentG} g, ${sl.seconds} s`);
});

test('DEFAULT ENGINE 2bee.fdm: the bridge arrange route (plates) works without orca, and two slots on one plate are refused, not approximated', { timeout: 120000 }, async (t) => {
  if (!haveFdm()) { t.skip(`PENDING: ${REAL_FDM} or the X2D preset files are not on this machine`); return; }
  await req(B.port, 'PUT', '/v1/slots', { headers: auth, body: { slots: [{ id: 'ams1-1', type: 'PLA', color: '#ffffff' }, { id: 'ams1-3', type: 'PETG', color: '#2e9e5b' }] } });
  const stl = cubeStl(10);
  const up = (await req(B.port, 'POST', '/v1/job/upload?name=cube10.stl', { headers: auth, body: stl })).json;
  const job = { version: 1, name: 'two', process: '0.20mm Standard @BBL X2D', files: [{ name: 'cube10.stl', size: stl.length, sha256: up.sha256 }], objects: [{ file: 0, slot: 'ams1-3', placement: null }, { file: 0, slot: 'ams1-3', placement: null }], slotPresets: {}, overrides: {} };
  const plan = (await req(B.port, 'POST', '/v1/job/plates', { headers: auth, body: { ...job, strategy: 'fit' } })).json;
  assert.equal(plan.ok, true, JSON.stringify(plan).slice(0, 400));
  assert.equal(plan.beds.length, 1);
  assert.equal(plan.beds[0].placements.length, 2);
  const two = (await req(B.port, 'POST', '/v1/job/slice', { headers: auth, body: { ...job, objects: [{ file: 0, slot: 'ams1-1', bed: 1, placement: { x: 80, y: 128, rot: 0 } }, { file: 0, slot: 'ams1-3', bed: 1, placement: { x: 160, y: 128, rot: 0 } }], bedIndex: 1, optimise: false } })).json;
  assert.equal(two.ok, false);
  assert.match(two.error, /one filament per plate/);
  assert.equal(fs.existsSync(ORCA_MARKER), false, 'orca was spawned');
});

test('missing engine binary: every slicing route answers 503 with the reason, and nothing else is tried', async () => {
  const X = await startBridge([], { fdmBin: path.join(FAKES, 'no-such-fdmslice') });
  try {
    for (const [m, p, body] of [['GET', '/v1/profiles'], ['POST', '/v1/job/slice', { version: 1, objects: [] }], ['POST', '/v1/job/plates', { version: 1, objects: [] }], ['POST', '/v1/job/arrange', { version: 1, objects: [] }]]) {
      const r = await req(X.port, m, p, { headers: auth, body });
      assert.equal(r.status, 503, `${m} ${p}: ${JSON.stringify(r.json)}`);
      assert.match(r.json.error, /2bee\.fdm engine \(fdmslice\) is not at .*no-such-fdmslice/);
    }
    const h = (await req(X.port, 'GET', '/v1/health', { headers: auth })).json;
    assert.equal(h.engine.found, false);
    assert.match(X.log(), /NOT FOUND — slicing routes answer 503/);
    assert.equal(fs.existsSync(ORCA_MARKER), false, 'a missing engine must not fall back to orca');
  } finally { await X.stop(); }
});

test('missing defaults file: 503 with the reason', async () => {
  const X = await startBridge(['--fdm-defaults', path.join(FAKES, 'nope.config')]);
  try {
    const r = await req(X.port, 'GET', '/v1/profiles', { headers: auth });
    assert.equal(r.status, 503);
    assert.match(r.json.error, /defaults file .*nope\.config is missing/);
  } finally { await X.stop(); }
});

test('--engine takes twobee-fdm or orca only (exit 2 otherwise)', async () => {
  const a = await runToExit(['--engine', 'cura'], { PRINT3D_BRIDGE_TOKEN: TOKEN });
  assert.equal(a.code, 2); assert.match(a.err, /--engine must be/);
});

test('REAL ORCA (--engine orca, the parity path): plan one 10 mm cube onto a plate, slice plate 1, read the G-code back', { timeout: 300000 }, async (t) => {
  if (!fs.existsSync(ORCA_BIN) || !fs.existsSync(MACHINE)) { t.skip(`PENDING: OrcaSlicer (${ORCA_BIN}) or the X2D machine profile is not on this machine`); return; }
  const O = await startBridge(['--engine', 'orca'], { orcaBin: ORCA_BIN });
  t.after(() => O.stop());
  const B = O; // the rest of this test talks to the orca bridge
  assert.equal((await req(B.port, 'GET', '/v1/health', { headers: auth })).json.engine.id, 'orca');
  await req(B.port, 'PUT', '/v1/slots', { headers: auth, body: { slots: [{ id: 'ams1-3', type: 'PETG', color: '#2e9e5b' }] } });
  const prof = (await req(B.port, 'GET', '/v1/profiles', { headers: auth })).json;
  const names = prof.process.map((p) => p.name);
  const proc = names.find((n) => n === '0.20mm Standard @BBL X2D') || names.find((n) => /0\.20mm Standard @BBL X2D/.test(n)) || names[0];
  const stl = cubeStl(10);
  const up = (await req(B.port, 'POST', '/v1/job/upload?name=cube10.stl', { headers: auth, body: stl })).json;
  const job = { version: 1, name: 'cube10', process: proc, files: [{ name: 'cube10.stl', size: stl.length, sha256: up.sha256 }], objects: [{ file: 0, slot: 'ams1-3', placement: null }], slotPresets: {}, overrides: {} };
  const plan = (await req(B.port, 'POST', '/v1/job/plates', { headers: auth, body: { ...job, strategy: 'fit' } })).json;
  assert.equal(plan.ok, true, JSON.stringify(plan));
  assert.equal(plan.beds.length, 1);
  const pl = plan.beds[0].placements[0];
  const sl = (await req(B.port, 'POST', '/v1/job/slice', { headers: auth, body: { ...job, objects: [{ file: 0, slot: 'ams1-3', bed: 1, placement: { x: pl.x, y: pl.y, rot: pl.rot } }], bedIndex: 1, optimise: false } })).json;
  assert.equal(sl.ok, true, JSON.stringify(sl).slice(0, 600));
  assert.ok(sl.stats.totalTime && sl.stats.totalTime.length > 0);
  assert.ok(Number(sl.stats.layers) > 0);
  assert.match(sl.id, /^[0-9a-f]{16}$/);
  const g = await req(B.port, 'GET', '/v1/gcode/' + sl.id, { headers: auth });
  assert.equal(g.status, 200);
  const text = g.buf.toString('utf8');
  assert.match(text, /^G1 /m);
  assert.match(text, /; total layer number/);
  t.diagnostic(`process "${proc}": ${sl.stats.totalTime}, ${sl.stats.layers} layers, ${sl.stats.filamentG} g, Orca ${sl.seconds} s`);
});

/* ── per-object settings (founder 2026-11-13: "the variables should be assigned to 1 object") ── */
import { createRequire } from 'node:module';
const { cleanJobO, OBJECT_KEYS } = createRequire(import.meta.url)('./engine.cjs');
const twoObj = (sha, ov0, ov1) => ({ version: 1, name: 'two', process: '0.20mm Standard @BBL X2D', files: [{ name: 'cube10.stl', size: 684, sha256: sha }],
  objects: [{ file: 0, slot: 'ams1-3', bed: 1, placement: { x: 80, y: 128, rot: 0 }, ...(ov0 ? { overrides: ov0 } : {}) }, { file: 0, slot: 'ams1-3', bed: 1, placement: { x: 170, y: 128, rot: 0 }, ...(ov1 ? { overrides: ov1 } : {}) }],
  slotPresets: {}, overrides: {}, bedIndex: 1, optimise: false });

test('per-object settings: only OBJECT_KEYS, each value checked; qty copies share them; kept through cleaning', () => {
  const sha = 'a'.repeat(64);
  assert.deepEqual(Object.keys(OBJECT_KEYS).sort(), ['bottom_shell_layers', 'sparse_infill_density', 'top_shell_layers', 'wall_loops']);
  const j = cleanJobO(twoObj(sha, null, { wall_loops: '4', sparse_infill_density: '40%' }));
  assert.equal(j.objects[0].overrides, undefined);
  assert.deepEqual(j.objects[1].overrides, { wall_loops: '4', sparse_infill_density: '40%' });
  assert.throws(() => cleanJobO(twoObj(sha, { layer_height: '0.1' })), /layer_height cannot be set per object/);
  assert.throws(() => cleanJobO(twoObj(sha, { wall_loops: '-1' })), /bad value for wall_loops/);
  assert.throws(() => cleanJobO(twoObj(sha, { sparse_infill_density: '40' })), /bad value for sparse_infill_density/);
  // 🔴 The plate-wide range holds per object (2026-11-14): '0' walls passed the 0-50 pattern and sliced a part with no
  // perimeters; 50 shells is above the plate-wide 20.
  assert.throws(() => cleanJobO(twoObj(sha, { wall_loops: '0' })), /wall_loops = 0 is not allowed/);
  assert.throws(() => cleanJobO(twoObj(sha, { top_shell_layers: '50' })), /top_shell_layers = 50 is not allowed/);
  const q = cleanJobO({ ...twoObj(sha), objects: [{ file: 0, slot: 'ams1-3', qty: 3, overrides: { wall_loops: '5' } }, { file: 0, slot: 'ams1-3' }] });
  assert.deepEqual(q.objects.map((o) => o.overrides?.wall_loops ?? null), ['5', '5', '5', null]);
  assert.deepEqual(cleanJobO(q).objects.map((o) => o.overrides?.wall_loops ?? null), ['5', '5', '5', null], 'a cleaned job cleans again without losing them');
});

test('per-object settings reach 2bee.fdm as --oset N:key=value for that object only; a refused key is 400 before the engine', { timeout: 120000 }, async (t) => {
  await req(B.port, 'PUT', '/v1/slots', { headers: auth, body: { slots: [{ id: 'ams1-3', type: 'PETG', color: '#2e9e5b' }] } });
  const up = (await req(B.port, 'POST', '/v1/job/upload?name=cube10.stl', { headers: auth, body: cubeStl(10) })).json;
  let before = fdmArgv().length;
  const bad = await req(B.port, 'POST', '/v1/job/slice', { headers: auth, body: twoObj(up.sha256, { layer_height: '0.1' }) });
  assert.equal(bad.status, 400, bad.text);
  assert.equal(fdmArgv().length, before, 'a refused per-object key never reaches the engine');
  if (!haveFdm()) { t.skip(`PENDING: ${REAL_FDM} or the X2D preset files are not on this machine`); return; }
  before = fdmArgv().length;
  const sl = (await req(B.port, 'POST', '/v1/job/slice', { headers: auth, body: twoObj(up.sha256, null, { wall_loops: '4' }) })).json;
  const calls = fdmArgv().slice(before);
  assert.ok(calls.length >= 1);
  const last = calls[calls.length - 1];
  const osets = last.flatMap((a, k) => (a === '--oset' ? [last[k + 1]] : []));
  assert.deepEqual(osets, ['1:wall_loops=4']);
  assert.equal(sl.ok, true, JSON.stringify(sl).slice(0, 600));
});

test('slice cache: a bed plate changed in the slots file is a NEW slice, the same plate again is reused (bughunt 2026-11-14)', { timeout: 180000 }, async (t) => {
  if (!haveFdm()) { t.skip(`PENDING: ${REAL_FDM} or the X2D preset files are not on this machine`); return; }
  const slots = (bedPlate) => req(B.port, 'PUT', '/v1/slots', { headers: auth, body: { bedPlate, slots: [{ id: 'ams1-3', type: 'PETG', color: '#2e9e5b' }] } });
  const up = (await req(B.port, 'POST', '/v1/job/upload?name=cube10.stl', { headers: auth, body: cubeStl(10) })).json;
  const job = sliceJob(up.sha256, '0.20mm Standard @BBL X2D', 'ams1-3', { x: 90, y: 110, rot: 0 });
  const slice = async () => (await req(B.port, 'POST', '/v1/job/slice', { headers: auth, body: job })).json;
  const bedOf = async (id) => ((await req(B.port, 'GET', '/v1/gcode/' + id, { headers: auth })).buf.toString('utf8').match(/^; curr_bed_type = (.*)$/m) || [])[1];
  await slots('Textured PEI Plate');
  const a = await slice();
  assert.equal(a.ok, true, JSON.stringify(a).slice(0, 400));
  assert.equal(await bedOf(a.id), 'Textured PEI Plate');
  await slots('Engineering Plate');
  const b = await slice();
  assert.equal(b.reusedSlice ?? false, false, 'the Textured PEI slice was reused for an Engineering Plate');
  assert.equal(await bedOf(b.id), 'Engineering Plate');
  const c = await slice();
  assert.equal(c.reusedSlice, true, 'control: the same plate again must still come from the cache');
  await slots('Textured PEI Plate');
});

test('plate-wide clamps are WARNINGS and bed.json keeps what was sliced; a plate that does not fit is ok:false with its leftovers, not a 500 (bughunt 2026-11-14)', { timeout: 180000 }, async (t) => {
  if (!haveFdm()) { t.skip(`PENDING: ${REAL_FDM} or the X2D preset files are not on this machine`); return; }
  await req(B.port, 'PUT', '/v1/slots', { headers: auth, body: { slots: [{ id: 'ams1-3', type: 'PETG', color: '#2e9e5b' }] } });
  const up = (await req(B.port, 'POST', '/v1/job/upload?name=cube10.stl', { headers: auth, body: cubeStl(10) })).json;
  const job = { ...sliceJob(up.sha256, '0.20mm Standard @BBL X2D', 'ams1-3', { x: 70, y: 140, rot: 0 }), overrides: { wall_loops: '0' } };
  const r = (await req(B.port, 'POST', '/v1/job/slice', { headers: auth, body: job })).json;
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 400));
  assert.ok((r.warnings || []).some((w) => /^wall_loops: asked 0, sliced with 1/.test(w)), `clamp not reported: ${JSON.stringify(r.warnings)}`);
  const bed = JSON.parse(fs.readFileSync(path.join(B.dataDir, 'slices', r.id, 'bed.json'), 'utf8'));
  assert.equal(bed.overrides.wall_loops, '1', 'bed.json must record the value sliced, not the one asked');
  const slab = (await req(B.port, 'POST', '/v1/job/upload?name=slab.stl', { headers: auth, body: boxStl(150, 150, 3) })).json;
  const big = { version: 1, name: 'slabs', process: '0.20mm Standard @BBL X2D', files: [{ name: 'slab.stl', size: 684, sha256: slab.sha256 }],
    objects: [{ file: 0, slot: 'ams1-3', qty: 4 }], slotPresets: {}, overrides: {} };
  const s2 = await req(B.port, 'POST', '/v1/job/slice', { headers: auth, body: big });
  const txt = s2.buf.toString('utf8').slice(0, 300);
  assert.notEqual(s2.status, 500, txt);
  assert.equal(s2.json.ok, false, txt);
  assert.ok(Array.isArray(s2.json.leftover) && s2.json.leftover.length > 0, txt);
});

test('slice cache: a SYSTEM preset edited in place is a new slice (its folder mtime does not move) (bughunt 2026-11-14)', { timeout: 240000 }, async (t) => {
  if (!haveFdm()) { t.skip(`PENDING: ${REAL_FDM} or the X2D preset files are not on this machine`); return; }
  // A private copy of the presets: this test edits a system file.
  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'p3d-orca-'));
  for (const d of ['system', 'user', 'printers']) if (fs.existsSync(path.join(ORCA_CONFIG, d))) fs.cpSync(path.join(ORCA_CONFIG, d), path.join(cfg, d), { recursive: true });
  const b = await startBridge([], { orcaConfig: cfg });
  try {
    await req(b.port, 'PUT', '/v1/slots', { headers: auth, body: { slots: [{ id: 'ams1-3', type: 'PETG', color: '#2e9e5b' }] } });
    const up = (await req(b.port, 'POST', '/v1/job/upload?name=cube10.stl', { headers: auth, body: cubeStl(10) })).json;
    const job = sliceJob(up.sha256, '0.20mm Standard @BBL X2D', 'ams1-3', { x: 90, y: 110, rot: 0 });
    const slice = async () => (await req(b.port, 'POST', '/v1/job/slice', { headers: auth, body: job })).json;
    const a = await slice();
    assert.equal(a.ok, true, JSON.stringify(a).slice(0, 400));
    const proc = path.join(cfg, 'system/BBL/process/0.20mm Standard @BBL X2D.json');
    const dirM = fs.statSync(path.dirname(proc)).mtimeMs;
    const j = JSON.parse(fs.readFileSync(proc, 'utf8'));
    j.wall_loops = String(Number(j.wall_loops ?? 2) + 1);
    fs.writeFileSync(proc, JSON.stringify(j, null, 4));
    assert.equal(fs.statSync(path.dirname(proc)).mtimeMs, dirM, 'precondition: an in-place write leaves the folder mtime alone');
    const c = await slice();
    assert.equal(c.reusedSlice ?? false, false, 'the slice from before the preset edit was reused');
  } finally { await b.stop(); fs.rmSync(cfg, { recursive: true, force: true }); }
});

test('slice disk budget: copies that need more STL than SLICE_MAX_MB are refused with 413 before the engine, and leave no folder', { timeout: 60000 }, async (t) => {
  if (!haveFdm()) { t.skip(`PENDING: ${REAL_FDM} or the X2D preset files are not on this machine`); return; }
  const was = process.env.SLICE_MAX_MB;
  process.env.SLICE_MAX_MB = '0.0015'; // 1572 B: the 684-byte cube fits twice (1368), not three times (2052)
  const S = await startBridge();
  try {
    await req(S.port, 'PUT', '/v1/slots', { headers: auth, body: { slots: [{ id: 'ams1-3', type: 'PETG', color: '#2e9e5b' }] } });
    const up = (await req(S.port, 'POST', '/v1/job/upload?name=cube10.stl', { headers: auth, body: cubeStl(10) })).json;
    const one = sliceJob(up.sha256, '0.20mm Standard @BBL X2D');
    const three = { ...one, objects: [0, 1, 2].map((k) => ({ ...one.objects[0], placement: { x: 60 + 30 * k, y: 120, rot: 0 } })) };
    const before = fdmArgv().length;
    const r = await req(S.port, 'POST', '/v1/job/slice', { headers: auth, body: three });
    assert.equal(r.status, 413, r.buf.toString().slice(0, 300));
    assert.match(r.json.error, /SLICE_MAX_MB/);
    assert.equal(fdmArgv().length, before, 'the engine ran for a refused plate');
    const left = fs.readdirSync(path.join(S.dataDir, 'slices')).filter((d) => /^[0-9a-f]{16}$/.test(d));
    assert.deepEqual(left, [], 'the refused plate left its folder behind');
    const ok = await req(S.port, 'POST', '/v1/job/slice', { headers: auth, body: one });
    assert.equal(ok.json.ok, true, 'control: one copy is under the budget and still slices');
  } finally {
    if (was === undefined) delete process.env.SLICE_MAX_MB; else process.env.SLICE_MAX_MB = was;
    await S.stop();
  }
});

