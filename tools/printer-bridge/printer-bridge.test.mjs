// SPDX-License-Identifier: AGPL-3.0-or-later
// node --test tools/printer-bridge/printer-bridge.test.mjs
//
// The HTTP tests run the REAL bridge.mjs as a subprocess (the shipped
// invocation), pointed at a FAKE implicit-FTPS printer on 127.0.0.1 that this
// file starts. The fake records every command and the stored bytes, refuses a
// data connection that does not reuse the control TLS session (as vsftpd-style
// servers, and reportedly Bambu's, do), and echoes the password in its 530
// reply so redaction is tested against a server that leaks it.
//
// The fake needs a throwaway self-signed certificate from `openssl`. Without
// openssl those tests are SKIPPED with a "PENDING" reason — visible in the
// summary as skipped, never counted as passed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import os from 'node:os';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// Bridges started by these tests register in a throwaway dir, never the real one (tools/bridge-registry.mjs).
process.env.TWOBEE_BRIDGE_REGISTRY = (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'bridge-reg-'));
import { inflateRawSync, crc32 } from 'node:zlib';
import { createHash, randomBytes, X509Certificate } from 'node:crypto';
import {
  buildGcode3mf, remoteName, ENTRY_NAMES, FTP_VERBS, FtpsClient, parseArgs, resolveAccessCode, isLanIp, tlsOptionsFor,
  uploadToPrinter, MQTT_COMMANDS, MqttClient, startCommand, fanCommand, fansFromReport, gcodeMeta, hmsFromReport, stageFromReport, statusFromReport, STAGES, hmsCode, splitJpegs, slotsFromReport, trayColor, gcodeFilamentTypes,
  Camera,
} from './bridge.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BRIDGE = join(HERE, 'bridge.mjs');
const TOKEN = 'test-token-0123456789abcdef';
const CODE = 'Zq7Kx9Lm'; // fake access code; must never appear in bridge output
const ORIGIN = 'http://localhost:5178';
const SERIAL = '20P9TEST0000001';
const GCODE = [
  '; HEADER_BLOCK_START',
  '; total estimated time: 1h 2m 3s',
  '; HEADER_BLOCK_END',
  '; CONFIG_BLOCK_START',
  '; nozzle_diameter = 0.4,0.4',
  '; filament_type = PETG',
  '; filament_colour = #F2754E',
  '; curr_bed_type = Textured PEI Plate',
  '; CONFIG_BLOCK_END',
  'G28',
  'G1 X10 Y10 Z0.2 F3000',
  'G1 X20 E1.5',
  'M400',
  '',
].join('\n');
const ALLOWED = new Set(['USER', 'PASS', 'PBSZ', 'PROT', 'TYPE', 'EPSV', 'PASV', 'STOR', 'SIZE', 'QUIT']);

/* ───────────────────────────── certificate ───────────────────────────── */

let CERT = null;
let CERT_PENDING = null;
{
  const dir = mkdtempSync(join(os.tmpdir(), 'printer-bridge-cert-'));
  const r = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'),
    '-days', '1', '-subj', '/CN=fake-x2d'], { encoding: 'utf8' });
  if (r.error || r.status !== 0) {
    CERT_PENDING = `PENDING: openssl unavailable (${r.error ? r.error.code : `exit ${r.status}`}) — the fake FTPS printer cannot be started, so the upload path is NOT tested`;
  } else {
    CERT = { key: readFileSync(join(dir, 'k.pem')), cert: readFileSync(join(dir, 'c.pem')) };
  }
}
const needCert = (t) => {
  if (!CERT) { t.skip(CERT_PENDING); return false; }
  return true;
};

/* ───────────────────────────── fake printer ───────────────────────────── */

function fakePrinter({ epsv = true, lieSize = false, requireReuse = true } = {}) {
  const ticketKeys = randomBytes(48);
  const rec = { commands: [], files: {}, dataReused: [], connections: 0, maxConcurrent: 0 };
  let live = 0;
  const server = tls.createServer({ ...CERT, ticketKeys }, (sock) => {
    rec.connections++;
    live++;
    rec.maxConcurrent = Math.max(rec.maxConcurrent, live);
    sock.on('close', () => { live--; rec.live = live; });
    rec.live = live;
    sock.on('error', () => {});
    const say = (s) => sock.write(s + '\r\n');
    let data = null; // { server, sockP }
    let user = null;
    let buf = '';
    say('220 fake-x2d FTPS ready');
    sock.on('data', async (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const sp = line.indexOf(' ');
        const verb = (sp < 0 ? line : line.slice(0, sp)).toUpperCase();
        const arg = sp < 0 ? undefined : line.slice(sp + 1);
        rec.commands.push({ verb, arg });
        await handle(verb, arg);
      }
    });
    const openData = () => {
      // A stalled printer keeps its half of the data socket open (no auto-FIN), so the client's close never comes.
      const ds = tls.createServer({ ...CERT, ticketKeys, allowHalfOpen: !!rec.stall && !rec.stalled });
      const sockP = new Promise((resolve) => ds.once('secureConnection', (s) => {
        rec.dataReused.push(s.isSessionReused());
        resolve(s);
      }));
      return new Promise((r) => ds.listen(0, '127.0.0.1', () => { data = { server: ds, sockP }; r(ds.address().port); }));
    };
    async function handle(verb, arg) {
      if (verb === 'USER') { user = arg; return say('331 password please'); }
      if (verb === 'PASS') {
        if (user === 'bblp' && arg === CODE) return say('230 logged in');
        return say(`530 Login incorrect for password ${arg}`); // a leaky server, on purpose
      }
      if (verb === 'PBSZ') return say('200 PBSZ=0');
      if (verb === 'PROT') return say(arg === 'P' ? '200 PROT now Private' : '536 only P');
      if (verb === 'TYPE') return say('200 Switching to Binary mode');
      if (verb === 'EPSV') {
        if (!epsv) return say('500 EPSV not understood');
        const port = await openData();
        return say(`229 Entering Extended Passive Mode (|||${port}|)`);
      }
      if (verb === 'PASV') {
        const port = await openData();
        // Names a DIFFERENT host on purpose: the client must ignore it and use the control host.
        return say(`227 Entering Passive Mode (10,99,99,99,${port >> 8},${port & 255})`);
      }
      if (verb === 'STOR') {
        if (!data) return say('425 use PASV first');
        say('150 Ok to send data');
        const s = await data.sockP;
        if (requireReuse && !s.isSessionReused()) {
          s.destroy();
          data.server.close();
          data = null;
          return say('522 SSL connection failed: session reuse required');
        }
        if (rec.stall && !rec.stalled) { rec.stalled = true; rec.stallSock = s; rec.stallServer = data.server; s.on('data', () => {}); return; } // never closes, never replies
        const chunks = [];
        s.on('data', (c) => chunks.push(c));
        s.on('end', () => {
          rec.files[arg] = Buffer.concat(chunks);
          s.end();
          data.server.close();
          data = null;
          say('226 Transfer complete');
        });
        return;
      }
      if (verb === 'SIZE') {
        const f = rec.files[arg];
        if (!f) return say('550 Could not get file size');
        return say(`213 ${lieSize || rec.lie ? f.length - 1 : f.length}`);
      }
      if (verb === 'QUIT') { say('221 Goodbye'); return sock.end(); }
      return say('502 Command not implemented');
    }
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({
    port: server.address().port, rec, close: () => new Promise((c) => server.close(c)),
  })));
}

/* ───────────────────────────── bridge harness ───────────────────────────── */

function start(args = [], env = {}) {
  const proc = spawn(process.execPath, [BRIDGE, '--port', '0', ...args], {
    env: { ...process.env, PRINTER_BRIDGE_TOKEN: TOKEN, X2D_ACCESS_CODE: CODE, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  proc.stdout.on('data', (d) => (out += d));
  proc.stderr.on('data', (d) => (err += d));
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`bridge did not start: ${err}`)), 5000);
    proc.on('exit', (code) => { clearTimeout(t); resolve({ exited: code, out, err }); });
    proc.stdout.on('data', () => {
      const m = /listening on http:\/\/([\d.]+):(\d+)/.exec(out);
      if (m && out.includes('one upload at a time')) {
        clearTimeout(t);
        resolve({
          proc, address: m[1], port: Number(m[2]), get out() { return out; }, get err() { return err; },
          stop: () => new Promise((r) => { proc.once('exit', r); proc.kill('SIGTERM'); }),
        });
      }
    });
  });
}

function request(port, { method = 'POST', path = '/v1/check', headers = {}, body, timeoutMs = 15000 } = {}) {
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
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`no response within ${timeoutMs / 1000} s`)));
    if (data) req.write(data);
    req.end();
  });
}

const good = { authorization: `Bearer ${TOKEN}`, origin: ORIGIN, 'content-type': 'application/json' };
const job = { name: 'feeder lid v2.gcode', gcode: GCODE };
const printerArgs = (port) => ['--printer', '127.0.0.1', '--printer-port', String(port)];

/** A ZIP reader built only on the central directory + node:zlib. */
function unzip(buf) {
  let e = buf.length - 22;
  while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  assert.ok(e >= 0, 'no end-of-central-directory record');
  const count = buf.readUInt16LE(e + 10);
  let p = buf.readUInt32LE(e + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, 'central header signature');
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString('utf8');
    assert.equal(buf.readUInt32LE(off), 0x04034b50, `local header signature for ${name}`);
    const ds = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
    const raw = buf.slice(ds, ds + csize);
    const data = method === 8 ? inflateRawSync(raw) : raw;
    assert.equal(data.length, usize, `size of ${name}`);
    assert.equal(crc32(data) >>> 0, crc, `CRC of ${name}`);
    out.push({ name, data });
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

/* ───────────────────────────── tests: auth + HTTP rules ───────────────────────────── */

test('401 without a token, and with a wrong one; the printer is never contacted', async (t) => {
  if (!needCert(t)) return;
  const fp = await fakePrinter();
  const b = await start(printerArgs(fp.port));
  try {
    const none = await request(b.port, { path: '/v1/upload', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: job });
    assert.equal(none.status, 401);
    assert.equal(none.headers['access-control-allow-origin'], ORIGIN, '401 must be readable by the allowed page');
    const wrong = await request(b.port, { path: '/v1/upload', headers: { ...good, authorization: 'Bearer nope-nope-nope-nope' }, body: job });
    assert.equal(wrong.status, 401);
    const chk = await request(b.port, { path: '/v1/check', headers: { origin: ORIGIN } });
    assert.equal(chk.status, 401);
    assert.equal(fp.rec.connections, 0, 'the printer must not be contacted on a 401');
  } finally { await b.stop(); await fp.close(); }
});

test('403 for a bad Origin (even with the token) and for a non-loopback Host', async (t) => {
  if (!needCert(t)) return;
  const fp = await fakePrinter();
  const b = await start(printerArgs(fp.port));
  try {
    const r = await request(b.port, { path: '/v1/upload', headers: { ...good, origin: 'https://evil.example' }, body: job });
    assert.equal(r.status, 403);
    assert.equal(r.headers['access-control-allow-origin'], undefined);
    const pre = await request(b.port, { method: 'OPTIONS', path: '/v1/upload', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
    assert.equal(pre.status, 403);
    const h = await request(b.port, { path: '/v1/upload', headers: { ...good, host: `attacker.example:${b.port}` }, body: job });
    assert.equal(h.status, 403);
    assert.equal(fp.rec.connections, 0);
  } finally { await b.stop(); await fp.close(); }
});

test('OPTIONS preflight: CORS headers, and PNA only when asked', async () => {
  const b = await start(['--printer', '127.0.0.1', '--printer-port', '1']);
  try {
    const r = await request(b.port, {
      method: 'OPTIONS', path: '/v1/upload',
      headers: { origin: ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-private-network': 'true' },
    });
    assert.equal(r.status, 204);
    assert.equal(r.headers['access-control-allow-origin'], ORIGIN);
    assert.match(r.headers['access-control-allow-methods'], /POST/);
    assert.equal(r.headers['access-control-allow-private-network'], 'true');
    const noPna = await request(b.port, { method: 'OPTIONS', path: '/v1/check', headers: { origin: ORIGIN, 'access-control-request-method': 'POST' } });
    assert.equal(noPna.headers['access-control-allow-private-network'], undefined);
  } finally { await b.stop(); }
});

test('refuses to start: no --printer, a hostname, a public IP, --host not 127.0.0.1, a bad code (all exit 2)', async () => {
  const none = await start([]);
  assert.equal(none.exited, 2);
  assert.match(none.err, /no printer: pass --printer <ip>/);
  const name = await start(['--printer', 'x2d.local']);
  assert.equal(name.exited, 2);
  assert.match(name.err, /not an IP literal/);
  const pub = await start(['--printer', '8.8.8.8']);
  assert.equal(pub.exited, 2);
  assert.match(pub.err, /not a private or loopback address/);
  const host = await start(['--printer', '127.0.0.1', '--host', '0.0.0.0']);
  assert.equal(host.exited, 2);
  assert.match(host.err, /refusing to bind 0\.0\.0\.0/);
  const inj = await start(['--printer', '127.0.0.1'], { X2D_ACCESS_CODE: 'abcd\r\nDELE x' });
  assert.equal(inj.exited, 2);
  assert.ok(!inj.err.includes('DELE'), 'the refused code is not echoed');
});

test('binds 127.0.0.1 only (refused on a non-loopback interface)', async (t) => {
  const b = await start(['--printer', '127.0.0.1', '--printer-port', '1']);
  try {
    assert.equal(b.address, '127.0.0.1');
    const ext = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
    if (!ext) return t.skip('PENDING: no non-loopback IPv4 interface — cannot show the bridge is unreachable from one');
    const outcome = await new Promise((resolve) => {
      const s = net.connect({ host: ext.address, port: b.port });
      s.once('connect', () => { s.destroy(); resolve('connected'); });
      s.once('error', (e) => resolve(e.code));
    });
    assert.equal(outcome, 'ECONNREFUSED');
  } finally { await b.stop(); }
});

test('400s, 409 without an access code, 413 over the body cap; nothing reaches the printer', async (t) => {
  if (!needCert(t)) return;
  const fp = await fakePrinter();
  const b = await start([...printerArgs(fp.port), '--max-body', '4096']);
  const nc = await start(printerArgs(fp.port), { X2D_ACCESS_CODE: '' });
  try {
    assert.equal((await request(b.port, { path: '/v1/upload', headers: good, body: 'not json' })).status, 400);
    assert.equal((await request(b.port, { path: '/v1/upload', headers: good, body: { name: 'x' } })).status, 400);
    assert.equal((await request(b.port, { path: '/v1/upload', headers: good, body: { name: 'x', gcode: '   ' } })).status, 400);
    assert.equal((await request(b.port, { path: '/v1/upload', headers: good, body: { name: 'x', gcode: 'G1\0' } })).status, 400);
    assert.equal((await request(b.port, { path: '/v1/upload', headers: good, body: { name: 'x', gcode: 'x'.repeat(5000) } })).status, 413);
    assert.equal((await request(b.port, { method: 'GET', path: '/v1/upload', headers: good })).status, 405);
    const r = await request(nc.port, { path: '/v1/upload', headers: good, body: job });
    assert.equal(r.status, 409);
    assert.equal(r.json.started, false);
    assert.equal(fp.rec.connections, 0);
  } finally { await b.stop(); await nc.stop(); await fp.close(); }
});

/* ───────────────────────────── tests: check ───────────────────────────── */

test('/v1/check: reachable + haveCode, without logging in or uploading', async (t) => {
  if (!needCert(t)) return;
  const fp = await fakePrinter();
  const b = await start(printerArgs(fp.port));
  const nc = await start(printerArgs(fp.port), { X2D_ACCESS_CODE: '' });
  const closedPort = await new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const down = await start(['--printer', '127.0.0.1', '--printer-port', String(closedPort)]);
  try {
    const r = await request(b.port, { headers: good, body: {} });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.reachable, true);
    assert.equal(r.json.haveCode, true);
    assert.equal((await request(nc.port, { headers: good, body: {} })).json.haveCode, false);
    assert.equal((await request(down.port, { headers: good, body: {} })).json.reachable, false);
    await new Promise((r2) => setTimeout(r2, 100));
    assert.deepEqual(fp.rec.commands, [], 'check sends no FTP command');
    assert.ok(!r.text.includes(CODE));
  } finally { await b.stop(); await nc.stop(); await down.stop(); await fp.close(); }
});

/* ───────────────────────────── tests: the upload ───────────────────────────── */

test('upload: 200, the stored bytes ARE the built 3mf, entries + MD5 correct, SIZE checked, upload verbs only, code never echoed', async (t) => {
  if (!needCert(t)) return;
  const fp = await fakePrinter();
  const b = await start(printerArgs(fp.port));
  try {
    const r = await request(b.port, { path: '/v1/upload', headers: good, body: job });
    assert.equal(r.status, 200, r.text);
    const { zip, md5 } = buildGcode3mf(GCODE);
    const expectedRemote = remoteName(job.name, md5);
    assert.equal(expectedRemote, `feeder_lid_v2_${md5.slice(0, 8).toLowerCase()}.gcode.3mf`);
    assert.deepEqual(r.json, { ok: true, remote: expectedRemote, bytes: zip.length, remoteBytes: zip.length, md5, started: false });

    // The bytes on the "printer" are exactly what buildGcode3mf produces.
    const stored = fp.rec.files[expectedRemote];
    assert.ok(stored, `nothing stored as ${expectedRemote}: ${Object.keys(fp.rec.files)}`);
    assert.ok(stored.equals(zip), 'stored bytes differ from the built 3mf');

    // The package: entry list, the G-code verbatim, and its MD5.
    const entries = unzip(stored);
    assert.deepEqual(entries.map((e) => e.name), [...ENTRY_NAMES]);
    const get = (n) => entries.find((e) => e.name === n).data;
    // A 3MF names its 3D model start part in the root rels, and that part exists (the X2D
    // said "3MF file is invalid" for a package whose root rels was empty, 2026-10-20).
    const rels = get('_rels/.rels').toString('utf8');
    assert.match(rels, /Target="\/3D\/3dmodel.model"[^>]*Type="http:\/\/schemas.microsoft.com\/3dmanufacturing\/2013\/01\/3dmodel"/);
    for (const [, target] of rels.matchAll(/Target="\/([^"]+)"/g)) assert.ok(entries.some((e) => e.name === target), `root rels points at a missing part: ${target}`);
    assert.match(get('3D/3dmodel.model').toString('utf8'), /<model unit="millimeter"[\s\S]*<build>/);
    assert.equal(get('Metadata/plate_1.gcode').toString('utf8'), GCODE);
    const realMd5 = createHash('md5').update(Buffer.from(GCODE, 'utf8')).digest('hex').toUpperCase();
    assert.equal(get('Metadata/plate_1.gcode.md5').toString('utf8'), realMd5, 'plate_1.gcode.md5 must be the MD5 of plate_1.gcode');
    assert.equal(md5, realMd5);
    const plate = JSON.parse(get('Metadata/plate_1.json').toString('utf8'));
    assert.equal(plate.nozzle_diameter, 0.4);
    assert.deepEqual(plate.filament_colors, ['#F2754E']);
    assert.equal(plate.bed_type, 'textured_plate', 'an exact plate name maps as Orca wrote it for the same plate (o1-cube_10mm on the X2D, 2026-10-20)');
    const si = get('Metadata/slice_info.config').toString('utf8');
    assert.match(si, /key="prediction" value="3723"/);
    assert.match(si, /<filament id="1" type="PETG" color="#F2754E"\/>/);
    assert.match(get('Metadata/model_settings.config').toString('utf8'), /key="gcode_file" value="Metadata\/plate_1.gcode"/);

    // The conversation with the printer.
    const verbs = fp.rec.commands.map((c) => c.verb);
    for (const v of verbs) assert.ok(ALLOWED.has(v), `bridge sent a non-upload command: ${v}`);
    assert.deepEqual(verbs, ['USER', 'PBSZ', 'PROT', 'TYPE', 'EPSV', 'STOR', 'SIZE', 'QUIT'].flatMap((v) => (v === 'USER' ? ['USER', 'PASS'] : [v])));
    assert.equal(fp.rec.commands.find((c) => c.verb === 'USER').arg, 'bblp');
    assert.equal(fp.rec.commands.find((c) => c.verb === 'PASS').arg, CODE);
    assert.equal(fp.rec.commands.filter((c) => c.arg === CODE).length, 1, 'the code is sent once, to PASS, and nowhere else');
    assert.ok(verbs.indexOf('SIZE') > verbs.indexOf('STOR'), 'SIZE is checked after STOR');
    assert.deepEqual(fp.rec.dataReused, [true], 'the data channel reused the control TLS session');

    await new Promise((r2) => setTimeout(r2, 100));
    for (const s of [r.text, b.out, b.err]) assert.ok(!s.includes(CODE), 'the access code leaked');
    assert.match(b.out, /POST \/v1\/upload origin=http:\/\/localhost:5178 200 \d+ms/);
    assert.ok(!b.out.includes('G28') && !b.out.includes(TOKEN), 'log carries no body and no token');
  } finally { await b.stop(); await fp.close(); }
});

test('--printer-cert-sha256: the pin holds on the RESUMED data channel too, and a wrong pin is refused', async (t) => {
  // Found on the real X2D, 2026-11-12: every pinned upload failed "printer certificate fingerprint (none)
  // does not match". The data channel resumes the control TLS session, and a resumed handshake carries
  // no certificate, so getPeerCertificate() is empty there. The pin was never run against a printer.
  if (!needCert(t)) return;
  const pin = new X509Certificate(CERT.cert).fingerprint256;
  for (const [fp256, want] of [[pin, 200], ['AB'.repeat(32), 502]]) {
    const fp = await fakePrinter();
    const b = await start([...printerArgs(fp.port), '--printer-cert-sha256', fp256]);
    try {
      const r = await request(b.port, { path: '/v1/upload', headers: good, body: job });
      assert.equal(r.status, want, r.text);
      if (want === 200) assert.deepEqual(fp.rec.dataReused, [true], 'the data channel reused the pinned control session');
      else {
        assert.match(r.text, /does not match --printer-cert-sha256/);
        assert.deepEqual(Object.keys(fp.rec.files), [], 'nothing stored behind a wrong pin');
      }
    } finally { await b.stop(); await fp.close(); }
  }
});

test('PASV fallback when EPSV is refused; a PASV reply naming another host is NOT followed', async (t) => {
  if (!needCert(t)) return;
  const fp = await fakePrinter({ epsv: false });
  const b = await start(printerArgs(fp.port));
  try {
    const r = await request(b.port, { path: '/v1/upload', headers: good, body: job });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(fp.rec.commands.map((c) => c.verb).filter((v) => /PASV|EPSV/.test(v)), ['EPSV', 'PASV']);
  } finally { await b.stop(); await fp.close(); }
});

test('a size mismatch on the printer is ok:false (502), never a 200', async (t) => {
  if (!needCert(t)) return;
  const fp = await fakePrinter({ lieSize: true });
  const b = await start(printerArgs(fp.port));
  try {
    const r = await request(b.port, { path: '/v1/upload', headers: good, body: job });
    assert.equal(r.status, 502, r.text);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.started, false);
    assert.equal(r.json.remoteBytes, r.json.bytes - 1);
  } finally { await b.stop(); await fp.close(); }
});

test('a wrong access code: 502, and the code is redacted even when the printer echoes it', async (t) => {
  if (!needCert(t)) return;
  const fp = await fakePrinter();
  const wrongCode = 'Wr0ngC0de';
  const b = await start(printerArgs(fp.port), { X2D_ACCESS_CODE: wrongCode });
  try {
    const r = await request(b.port, { path: '/v1/upload', headers: good, body: job });
    assert.equal(r.status, 502);
    assert.match(r.json.error.message, /PASS -> 530 Login incorrect for password \*\*\*/);
    await new Promise((r2) => setTimeout(r2, 100));
    for (const s of [r.text, b.out, b.err]) assert.ok(!s.includes(wrongCode), 'the access code leaked');
    assert.deepEqual(Object.keys(fp.rec.files), [], 'nothing stored');
  } finally { await b.stop(); await fp.close(); }
});

test('one upload at a time: two concurrent requests never hold two printer sessions', async (t) => {
  if (!needCert(t)) return;
  const fp = await fakePrinter();
  const b = await start(printerArgs(fp.port));
  try {
    const [r1, r2] = await Promise.all([
      request(b.port, { path: '/v1/upload', headers: good, body: job }),
      request(b.port, { path: '/v1/upload', headers: good, body: { name: 'other', gcode: GCODE + 'G1 X1\n' } }),
    ]);
    assert.equal(r1.status, 200, r1.text);
    assert.equal(r2.status, 200, r2.text);
    assert.equal(fp.rec.connections, 2);
    assert.equal(fp.rec.maxConcurrent, 1);
  } finally { await b.stop(); await fp.close(); }
});

test('a 504 upload CLOSES its printer session: the stalled control and data sockets do not run on beside the next upload', async (t) => {
  // 🔴 Until 2026-11-14 the 504 came from a race and the FTPS client was left running (no timeout on the data
  // socket's end), so the queue moved on with a stalled session still open to the printer.
  if (!needCert(t)) return;
  const fp = await fakePrinter();
  fp.rec.stall = true;
  const b = await start([...printerArgs(fp.port), '--timeout', '2']);
  try {
    const r1 = await request(b.port, { path: '/v1/upload', headers: good, body: job });
    assert.equal(r1.status, 504, r1.text);
    const t0 = Date.now();
    while (fp.rec.live > 0 && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 50));
    assert.equal(fp.rec.live, 0, 'the stalled session was still open on the printer after the 504');
    assert.ok(fp.rec.stallSock.destroyed || fp.rec.stallSock.readableEnded, 'the stalled data socket was left open');
    const r2 = await request(b.port, { path: '/v1/upload', headers: good, body: job });
    assert.equal(r2.status, 200, r2.text);
    assert.equal(fp.rec.maxConcurrent, 1);
  } finally { await b.stop(); fp.rec.stallSock?.destroy(); fp.rec.stallServer?.close(); await fp.close(); }
});

test('upload progress: connecting -> sending in STOR_CHUNK steps -> confirming, monotonic, ending at the full size the printer stored', async (t) => {
  // Founder 2026-11-20: "When it is Uploading... can the button became a progress bar?" The bar is only
  // honest if the count is the bytes handed to the printer's data socket, in order, and stops at the file size.
  if (!needCert(t)) return;
  const fp = await fakePrinter();
  try {
    // Random comments do not deflate, so the package is several chunks long.
    const big = GCODE + Array.from({ length: 8000 }, () => `; ${randomBytes(48).toString('hex')}`).join('\n') + '\n';
    const { zip } = buildGcode3mf(big);
    assert.ok(zip.length > 3 * 64 * 1024, `test package too small: ${zip.length}`);
    const ev = [];
    const r = await uploadToPrinter({ printerIp: '127.0.0.1', printerPort: fp.port, certSha256: null, code: CODE, remote: 'p.gcode.3mf', zip, timeoutMs: 10000, onProgress: (e) => ev.push(e) });
    assert.equal(r.remoteBytes, zip.length);
    assert.ok(fp.rec.files['p.gcode.3mf'].equals(zip));
    assert.deepEqual(ev[0], { phase: 'connecting', sent: 0, total: zip.length });
    const sending = ev.filter((e) => e.phase === 'sending' && e.sent > 0);
    assert.ok(sending.length >= 3, `expected several sending steps, got ${sending.length}`);
    for (let i = 1; i < ev.length; i++) assert.ok(ev[i].sent >= ev[i - 1].sent, `sent went backwards at ${i}: ${JSON.stringify(ev.slice(i - 1, i + 1))}`);
    for (const e of ev) assert.ok(e.sent <= zip.length && e.total === zip.length);
    assert.deepEqual(ev.at(-1), { phase: 'confirming', sent: zip.length, total: zip.length });
    assert.ok(ev.every((e) => e.phase !== 'confirming' || e.sent === zip.length), 'confirming before every byte was sent');
  } finally { await fp.close(); }
});

test('/v1/progress: shows the upload in flight from the bridge own counter, null after it ends, and never contacts the printer', async (t) => {
  if (!needCert(t)) return;
  const fp = await fakePrinter();
  fp.rec.stall = true; // the printer never closes the data channel, so the upload hangs at "confirming"
  const b = await start([...printerArgs(fp.port), '--timeout', '3']);
  try {
    const idle = await request(b.port, { path: '/v1/progress', headers: good, body: {} });
    assert.equal(idle.status, 200, idle.text);
    assert.deepEqual(idle.json, { upload: null, queued: 0 });
    assert.equal(fp.rec.connections, 0, '/v1/progress contacted the printer');

    const upP = request(b.port, { path: '/v1/upload', headers: good, body: job });
    const { zip, md5 } = buildGcode3mf(GCODE);
    let seen = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 2500) {
      const r = await request(b.port, { path: '/v1/progress', headers: good, body: {} });
      if (r.json?.upload?.phase === 'confirming') { seen = r.json; break; }
      await new Promise((r2) => setTimeout(r2, 50));
    }
    assert.ok(seen, 'never saw the upload in flight');
    assert.deepEqual(seen, { upload: { remote: remoteName(job.name, md5), phase: 'confirming', sent: zip.length, total: zip.length }, queued: 0 });
    assert.equal(fp.rec.connections, 1, 'progress reads opened printer sessions');

    const up = await upP;
    assert.equal(up.status, 504, up.text);
    const after = await request(b.port, { path: '/v1/progress', headers: good, body: {} });
    assert.deepEqual(after.json, { upload: null, queued: 0 }, 'a finished (failed) upload still shows as in flight');

    const anon = await request(b.port, { path: '/v1/progress', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: {} });
    assert.equal(anon.status, 401);
  } finally { await b.stop(); fp.rec.stallSock?.destroy(); fp.rec.stallServer?.close(); await fp.close(); }
});

/* ───────────────────────────── tests: by construction ───────────────────────────── */

test('FTP side uploads only: verb allowlist and client refusal (the print commands live on MQTT, below)', async () => {
  assert.deepEqual([...FTP_VERBS].sort(), [...ALLOWED].sort());
  const c = new FtpsClient({ host: '127.0.0.1', port: 1, printerIp: '127.0.0.1' });
  c.sock = { write: () => assert.fail('a refused verb must not reach the socket') };
  for (const v of ['DELE', 'SITE', 'RETR', 'LIST', 'CWD', 'RNFR', 'MKD']) {
    await assert.rejects(c.cmd(v, 'x'), /refusing FTP verb/);
  }
  await assert.rejects(c.cmd('STOR', 'a\r\nDELE b'), /line break/);
});

test('slotsFromReport: type and colour per tray as the printer reports them; a colour that is not hex is null, never guessed', () => {
  const p = {
    ams: { ams: [{ id: '0', tray: [{ id: '0', tray_type: 'PLA', tray_color: 'FF6A13FF' }, { id: '1', tray_type: '', tray_color: '00000000' }, { id: '2', tray_type: 'PETG' }, { id: '3', tray_type: 'ABS', tray_color: 'nonsense' }] }] },
    vt_tray: { tray_type: 'TPU', tray_color: '161616' },
  };
  assert.deepEqual(slotsFromReport(p).map(({ id, type, color }) => ({ id, type, color })), [
    { id: 'ams1-1', type: 'PLA', color: '#ff6a13' },
    { id: 'ams1-2', type: '', color: '#000000' },
    { id: 'ams1-3', type: 'PETG', color: null },
    { id: 'ams1-4', type: 'ABS', color: null },
    { id: 'ext', type: 'TPU', color: '#161616' },
  ]);
  assert.equal(trayColor(undefined), null);
  assert.deepEqual(slotsFromReport({}), []);
});

test('MQTT side: only project_file, pause, resume, stop (+ pushall) can be published', () => {
  assert.deepEqual([...MQTT_COMMANDS].sort(), ['pause', 'project_file', 'resume', 'stop']);
  const c = new MqttClient({ host: '127.0.0.1', port: 1, printerIp: '127.0.0.1', serial: SERIAL });
  c.sock = { write: () => assert.fail('a refused command must not reach the socket') };
  for (const cmd of ['gcode_line', 'ams_filament_setting', 'calibration', 'unload_filament', 'set_ctt', undefined]) {
    assert.throws(() => c.publish({ print: { sequence_id: '0', command: cmd } }), /refusing MQTT command/);
  }
  // The one system command allowed: the chamber light, on or off. Anything else is refused.
  assert.throws(() => c.publish({ system: { command: 'ledctrl' } }), /refusing MQTT command/);
  assert.throws(() => c.publish({ system: { command: 'ledctrl', led_node: 'work_light', led_mode: 'on' } }), /refusing MQTT command/);
  assert.throws(() => c.publish({ system: { command: 'ledctrl', led_node: 'chamber_light', led_mode: 'flashing' } }), /refusing MQTT command/);
  assert.throws(() => c.publish({ system: { command: 'reboot' } }), /refusing MQTT command/);
  let wrote = 0;
  c.sock = { write: () => { wrote++; } };
  c.publish({ system: { command: 'ledctrl', led_node: 'chamber_light', led_mode: 'off' } });
  assert.equal(wrote, 1);
});

test('MQTT side: set_fan only in the exact shape fanCommand builds', () => {
  const c = new MqttClient({ host: '127.0.0.1', port: 1, printerIp: '127.0.0.1', serial: SERIAL });
  c.sock = { write: () => assert.fail('a refused command must not reach the socket') };
  const ok = { sequence_id: '0', command: 'set_fan', fan_index: 3, speed: 30 };
  for (const bad of [
    { ...ok, speed: 35 }, { ...ok, speed: 110 }, { ...ok, speed: -10 }, { ...ok, speed: '30' },
    { ...ok, fan_index: 0 }, { ...ok, fan_index: 5 }, { ...ok, extra: 1 }, { command: 'set_fan', fan_index: 3, speed: 30 },
  ]) assert.throws(() => c.publish({ print: bad }), /refusing MQTT command/, JSON.stringify(bad));
  assert.throws(() => c.publish({ print: ok, system: {} }), /refusing MQTT command/);
  assert.throws(() => c.publish({ print: { sequence_id: '0', command: 'set_airduct', modeId: 0, submode: 1 } }), /refusing MQTT command/);
  assert.throws(() => fanCommand(3, 35), /steps of 10/);
  assert.throws(() => fanCommand(4, 30), /fan id/);
  let wrote = 0;
  c.sock = { write: () => { wrote++; } };
  c.publish(fanCommand(10, 0));
  assert.equal(wrote, 1);
});

test('MQTT side: set_airduct, print_speed, skip_objects only in their one shape each', () => {
  const c = new MqttClient({ host: '127.0.0.1', port: 1, printerIp: '127.0.0.1', serial: SERIAL });
  c.sock = { write: () => assert.fail('a refused command must not reach the socket') };
  for (const bad of [
    { sequence_id: '0', command: 'set_airduct', modeId: 0 }, { sequence_id: '0', command: 'set_airduct', modeId: 0, submode: -1, x: 1 },
    { sequence_id: '0', command: 'set_airduct', modeId: 16, submode: -1 },
    { sequence_id: '0', command: 'print_speed', param: '5' }, { sequence_id: '0', command: 'print_speed', param: 2 }, { sequence_id: '0', command: 'print_speed', param: '0' },
    { sequence_id: '0', command: 'skip_objects', obj_list: [] }, { sequence_id: '0', command: 'skip_objects', obj_list: ['55'] },
    { sequence_id: '0', command: 'skip_objects', obj_list: [55], extra: 1 },
  ]) assert.throws(() => c.publish({ print: bad }), /refusing MQTT command/, JSON.stringify(bad));
  let wrote = 0;
  c.sock = { write: () => { wrote++; } };
  c.publish({ print: { sequence_id: '0', command: 'set_airduct', modeId: 0, submode: -1 } });
  c.publish({ print: { sequence_id: '0', command: 'print_speed', param: '3' } });
  c.publish({ print: { sequence_id: '0', command: 'skip_objects', obj_list: [55] } });
  assert.equal(wrote, 3);
});

test('status texts: HMS from Bambu\'s X2D table, stage names, print_error text; unknown stays a code', () => {
  // The X2D's live hms item on 2026-11-13: Bambu's table has this code with an empty text.
  assert.deepEqual(hmsFromReport({ hms: [{ attr: 83887616, code: 131184 }] }), [{ code: '0500-0600-0002-0070', level: 'serious', text: null }]);
  const [h] = hmsFromReport({ hms: [{ attr: 0x07032200, code: 0x00020026 }] });
  assert.equal(h.code, '0703-2200-0002-0026');
  assert.match(h.text, /AMS D slot 3 assist motor overloaded/);
  assert.deepEqual(hmsFromReport({}), []);
  assert.equal(STAGES.length, 78);
  assert.deepEqual(stageFromReport({ stg_cur: 0 }), { id: 0, name: 'Printing' });
  assert.deepEqual(stageFromReport({ stg_cur: 14 }), { id: 14, name: 'Cleaning nozzle tip' });
  assert.deepEqual(stageFromReport({ stg_cur: 99 }), { id: 99, name: 'stage 99' });
  assert.equal(stageFromReport({ stg_cur: 255 }), null);
  assert.equal(stageFromReport({}), null);
  const st = statusFromReport({ gcode_state: 'FAILED', print_error: 83902534, spd_lvl: 3, s_obj: [55] });
  assert.match(st.errorText, /3MF file is invalid/);
  assert.deepEqual(st.speed, { level: 3, name: 'Sport' });
  assert.deepEqual(st.skipped, [55]);
});

const LABELLED = `${GCODE}
; printing object cubeA id:1 copy 0
; start printing object, unique label id: 55
; stop printing object, unique label id: 55
; printing object cube <B> id:2 copy 0
; start printing object, unique label id: 77
; printing object cubeA id:1 copy 0
; start printing object, unique label id: 55
`;

test('objects: read from the label lines; slice_info carries them as Orca writes a multi-object plate', () => {
  assert.deepEqual(gcodeMeta(LABELLED).objects, [{ id: 55, name: 'cubeA' }, { id: 77, name: 'cube <B>' }]);
  assert.equal(gcodeMeta(GCODE).objects, undefined);
  const si = (g) => unzip(buildGcode3mf(g).zip).find((x) => x.name === 'Metadata/slice_info.config').data.toString();
  const two = si(LABELLED);
  assert.match(two, /key="label_object_enabled" value="true"/);
  assert.match(two, /<object identify_id="55" name="cubeA" skipped="false" \/>\n {4}<object identify_id="77" name="cube &lt;B&gt;" skipped="false" \/>/);
  assert.ok(two.indexOf('<object ') > two.indexOf('limit_filament_maps') || !two.includes('limit_filament_maps'));
  const plain = si(GCODE);
  assert.match(plain, /key="label_object_enabled" value="false"/);
  assert.ok(!plain.includes('<object '));
  const one = si(`${GCODE}\n; printing object a id:1 copy 0\n; start printing object, unique label id: 14\n`);
  assert.match(one, /key="label_object_enabled" value="true"/);
  assert.ok(!one.includes('<object '), 'Orca\'s single-object X2D package has no <object> line');
});

// The X2D's own airduct block, read from the printer on 2026-11-13 (Heating mode, mid-print).
const X2D_AIRDUCT = {
  modeCur: 1, modeFunc: 1, subFunc: 0, subMode: -1, version: 1,
  modeList: [{ ctrl: [16, 32, 160, 48], modeId: 0, off: [] }, { ctrl: [16, 160, 48], modeId: 1, off: [] }],
  parts: [
    { func: 0, id: 16, range: 6553600, state: 0, tar_state: 0 },
    { func: 7, id: 32, range: 6553600, state: 100, tar_state: 100 },
    { func: 8, id: 160, range: 6553600, state: 100, tar_state: 100 },
    { func: 2, id: 48, range: 6553600, state: 70, tar_state: 70 },
  ],
};

test('fansFromReport: names, percent and who controls each fan, from the X2D report', () => {
  assert.deepEqual(fansFromReport({ device: { airduct: X2D_AIRDUCT } }), {
    mode: 'Heating',
    fans: [
      { id: 1, name: 'Parts', percent: 0, control: 'set' },
      { id: 2, name: 'Left (Heating)', percent: 100, control: 'auto' },
      { id: 10, name: 'Right (Filter)', percent: 100, control: 'set' },
      { id: 3, name: 'Exhaust', percent: 70, control: 'set' },
    ],
  });
  assert.equal(fansFromReport({ device: { airduct: { ...X2D_AIRDUCT, modeCur: 0 } } }).fans[1].control, 'set');
  assert.equal(fansFromReport({ cooling_fan_speed: '15' }), null, 'old-protocol fields are not guessed into fans');
});

test('startCommand: the shape run on the X2D on 2026-10-14 (ftp:/// url, plate_1, ams_mapping), and its refusals', () => {
  const M = '0123456789abcdef0123456789abcdef';
  const c = startCommand({ remote: 'lid_abcdef01.gcode.3mf', bedType: 'Textured PEI Plate', amsMapping: [2], fileMd5: M }).print;
  assert.equal(c.command, 'project_file');
  assert.equal(c.param, 'Metadata/plate_1.gcode');
  assert.equal(c.url, 'ftp:///lid_abcdef01.gcode.3mf');
  assert.equal(c.subtask_name, 'lid_abcdef01');
  assert.equal(c.bed_type, 'textured_plate');
  assert.deepEqual(c.ams_mapping, [2]);
  assert.equal(c.use_ams, true);
  assert.equal(c.md5, M);
  assert.equal(startCommand({ remote: 'a.gcode.3mf', bedType: 'Nonsense', amsMapping: [254], fileMd5: M }).print.use_ams, false);
  assert.equal(startCommand({ remote: 'a.gcode.3mf', bedType: 'Nonsense', amsMapping: [254], fileMd5: M }).print.bed_type, 'auto');
  assert.throws(() => startCommand({ remote: 'a.gcode.3mf', amsMapping: [0], fileMd5: '' }), /no MD5/);
  assert.equal(hmsCode(83902534), '0500-4046');
  assert.throws(() => startCommand({ remote: '../x.gcode.3mf', amsMapping: [0] }), /remote must be/);
  assert.throws(() => startCommand({ remote: 'a.gcode.3mf', amsMapping: [], fileMd5: M }), /amsMapping/);
  assert.throws(() => startCommand({ remote: 'a.gcode.3mf', amsMapping: [99], fileMd5: M }), /amsMapping/);
});

test('remote names: [\\w-] only, .gcode.3mf suffix, MD5-keyed', () => {
  const md5 = 'ABCDEF0123456789ABCDEF0123456789';
  assert.equal(remoteName('../../etc/passwd\r\nDELE x', md5), 'etc_passwd_DELE_x_abcdef01.gcode.3mf');
  assert.equal(remoteName('part.gcode.3mf', md5), 'part_abcdef01.gcode.3mf');
  assert.equal(remoteName('', md5), 'job_abcdef01.gcode.3mf');
  assert.equal(remoteName(undefined, md5), 'job_abcdef01.gcode.3mf');
  assert.match(remoteName('ü'.repeat(200) + 'x'.repeat(200), md5), /^[\w-]{1,64}_abcdef01\.gcode\.3mf$/);
});

test('self-signed acceptance is keyed to the configured printer IP only', () => {
  assert.equal(tlsOptionsFor('192.168.50.151', '192.168.50.151').rejectUnauthorized, false);
  assert.equal(tlsOptionsFor('192.168.50.152', '192.168.50.151').rejectUnauthorized, undefined);
  assert.ok(isLanIp('192.168.50.151') && isLanIp('10.0.0.1') && isLanIp('172.20.0.1') && isLanIp('127.0.0.1') && isLanIp('fd00::1'));
  assert.ok(!isLanIp('8.8.8.8') && !isLanIp('172.32.0.1') && !isLanIp('2001:db8::1'));
  assert.equal(parseArgs(['--printer', '192.168.50.151']).printerPort, 990);
});

test('access code: --code-file wins over env, and is never in the error text', () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'printer-bridge-code-'));
  const f = join(dir, 'code');
  writeFileSync(f, 'FileCode1\n');
  assert.equal(resolveAccessCode(f, { X2D_ACCESS_CODE: CODE }).code, 'FileCode1');
  assert.equal(resolveAccessCode(null, { X2D_ACCESS_CODE: CODE }).code, CODE);
  assert.equal(resolveAccessCode(null, {}).code, null);
  assert.throws(() => resolveAccessCode(null, { X2D_ACCESS_CODE: 'has space' }), (e) => !e.message.includes('has space'));
});

/* ───────────────────────────── fake MQTT printer ───────────────────────────── */

/** A fake Bambu MQTT broker: one printer, state machine driven by the commands it receives. */
function fakeMqtt({ state = 'IDLE', slot1 = '', slot3 = 'PETG', ignore = false, refuse = false } = {}) {
  const rec = { published: [], logins: [], state };
  const len = (n) => { const o = []; do { let b = n % 128; n = Math.floor(n / 128); if (n) b |= 0x80; o.push(b); } while (n); return Buffer.from(o); };
  const str = (x) => { const b = Buffer.from(x); const l = Buffer.alloc(2); l.writeUInt16BE(b.length); return Buffer.concat([l, b]); };
  const server = tls.createServer({ ...CERT }, (sock) => {
    sock.on('error', () => {});
    let buf = Buffer.alloc(0);
    let topic = null;
    const report = () => {
      const print = {
        command: 'push_status', gcode_state: rec.state, subtask_name: rec.task ?? '', mc_percent: rec.state === 'RUNNING' ? 12 : 0,
        layer_num: 3, total_layer_num: 215, mc_remaining_time: 190, print_error: rec.error ?? 0, nozzle_temper: 249.5, nozzle_target_temper: 250, bed_temper: 70, bed_target_temper: 70,
        ams: { ams: [{ id: '0', tray: [{ id: '0', tray_type: slot1 }, { id: '1', tray_type: '' }, { id: '2', tray_type: slot3 }, { id: '3', tray_type: '' }] }] },
        vt_tray: { tray_type: '' },
        lights_report: [{ node: 'chamber_light', mode: rec.light ?? 'on' }],
        stg_cur: rec.state === 'RUNNING' ? 0 : 255, spd_lvl: rec.spd ?? 2, s_obj: rec.sobj ?? [],
        hms: [{ attr: 83887616, code: 131184 }],
        device: { airduct: { ...X2D_AIRDUCT, modeCur: rec.mode ?? 1, parts: X2D_AIRDUCT.parts.map((x) => ({ ...x, state: rec.fans?.[x.id >> 4] ?? x.state })) } },
      };
      const body = Buffer.concat([str(topic), Buffer.from(JSON.stringify({ print }))]);
      sock.write(Buffer.concat([Buffer.from([0x30]), len(body.length), body]));
    };
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (buf.length < 2) return;
        let n = 0, mul = 1, i = 1, b;
        do { if (i >= buf.length) return; b = buf[i++]; n += (b & 0x7f) * mul; mul *= 128; } while (b & 0x80);
        if (buf.length < i + n) return;
        const head = buf[0];
        const body = buf.subarray(i, i + n);
        buf = buf.subarray(i + n);
        const type = head >> 4;
        if (type === 1) {
          let o = 10; // after protocol name (6) + level + flags + keepalive (4)
          const rd = () => { const l = body.readUInt16BE(o); const v = body.subarray(o + 2, o + 2 + l).toString(); o += 2 + l; return v; };
          rd(); const user = rd(); const pass = rd();
          rec.logins.push({ user, pass });
          sock.write(Buffer.from([0x20, 2, 0, user === 'bblp' && pass === CODE ? 0 : 5]));
          if (pass !== CODE) sock.end();
        } else if (type === 8) {
          topic = body.subarray(4, 4 + body.readUInt16BE(2)).toString().replace('/report', '/report');
          rec.subscribed = topic;
          sock.write(Buffer.from([0x90, 3, body[0], body[1], 0]));
        } else if (type === 3) {
          const tl = body.readUInt16BE(0);
          const t = body.subarray(2, 2 + tl).toString();
          const j = JSON.parse(body.subarray(2 + tl).toString());
          rec.published.push({ topic: t, j });
          const cmd = j.print?.command;
          if (j.system?.command === 'ledctrl') rec.light = j.system.led_mode;
          if (!ignore) {
            if (cmd === 'set_fan') rec.fans = { ...rec.fans, [j.print.fan_index]: j.print.speed };
            if (cmd === 'set_airduct') rec.mode = j.print.modeId;
            if (cmd === 'print_speed') rec.spd = Number(j.print.param);
            if (cmd === 'skip_objects') rec.sobj = [...(rec.sobj ?? []), ...j.print.obj_list];
            if (cmd === 'project_file') {
              rec.task = j.print.subtask_name;
              if (refuse || !/^[0-9a-f]{32}$/.test(j.print.md5)) {
                rec.state = 'FAILED'; rec.error = 83902534;
                const ans = Buffer.concat([str(topic), Buffer.from(JSON.stringify({ print: { command: 'project_file', sequence_id: j.print.sequence_id, result: 'fail', reason: 'fake refusal' } }))]);
                sock.write(Buffer.concat([Buffer.from([0x30]), len(ans.length), ans]));
              } else rec.state = 'PREPARE';
            }
            if (cmd === 'pause') rec.state = 'PAUSE';
            if (cmd === 'resume') rec.state = 'RUNNING';
            if (cmd === 'stop') rec.state = 'FAILED';
          }
          if (j.pushing?.command === 'pushall') setTimeout(report, 20);
        }
      }
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({
    port: server.address().port, rec,
    commands: () => rec.published.map((p) => p.j.print?.command ?? p.j.pushing?.command),
    close: () => new Promise((c) => server.close(c)),
  })));
}

const mqttArgs = (ftpPort, mqttPort) => [...printerArgs(ftpPort), '--mqtt-port', String(mqttPort), '--serial', SERIAL];
const upload = async (b, extra = { amsMapping: [2], expectTypes: ['PETG'] }) => {
  const r = await request(b.port, { path: '/v1/upload', headers: good, body: { ...job, ...extra } });
  assert.equal(r.status, 200, r.text);
  return r.json.remote;
};
const startBody = (remote, extra = {}) => ({ remote, amsMapping: [2], expectTypes: ['PETG'], bedType: 'Textured PEI Plate', confirm: 'at-printer', ...extra });

test('print commands: 409 without --serial; nothing is sent to the printer', async (t) => {
  if (!needCert(t)) return;
  const mq = await fakeMqtt();
  const b = await start([...printerArgs(1), '--mqtt-port', String(mq.port)]);
  try {
    for (const path of ['/v1/status', '/v1/stop']) {
      const r = await request(b.port, { path, headers: good, body: {} });
      assert.equal(r.status, 409, r.text);
      assert.match(r.json.error.message, /--serial/);
    }
    assert.equal(mq.rec.logins.length, 0);
    const c = await request(b.port, { path: '/v1/check', headers: good, body: {} });
    assert.equal(c.json.haveSerial, false);
  } finally { await b.stop(); await mq.close(); }
});

test('status: read from the printer report, subscribed to device/<serial>/report, code never echoed', async (t) => {
  if (!needCert(t)) return;
  const mq = await fakeMqtt();
  const b = await start(mqttArgs(1, mq.port));
  try {
    const r = await request(b.port, { path: '/v1/status', headers: good, body: {} });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.state, 'IDLE');
    assert.equal(r.json.layers, 215);
    assert.deepEqual(r.json.slots.find((s) => s.id === 'ams1-3'), { id: 'ams1-3', type: 'PETG', color: null });
    assert.equal(mq.rec.subscribed, `device/${SERIAL}/report`);
    assert.deepEqual(mq.commands(), ['pushall'], 'status sends no print command');
    assert.deepEqual(mq.rec.logins, [{ user: 'bblp', pass: CODE }]);
    for (const s of [r.text, b.out, b.err]) assert.ok(!s.includes(CODE), 'the access code leaked');
  } finally { await b.stop(); await mq.close(); }
});

test('start: refuses without the at-printer confirm, and refuses a file this run did not upload', async (t) => {
  if (!needCert(t)) return;
  const fp = await fakePrinter();
  const mq = await fakeMqtt();
  const b = await start(mqttArgs(fp.port, mq.port));
  try {
    let r = await request(b.port, { path: '/v1/start', headers: good, body: startBody('x_abcdef01.gcode.3mf') });
    assert.equal(r.status, 409, r.text);
    assert.match(r.json.error.message, /not uploaded by this bridge/);
    const remote = await upload(b);
    r = await request(b.port, { path: '/v1/start', headers: good, body: startBody(remote, { confirm: undefined }) });
    assert.equal(r.status, 400, r.text);
    assert.match(r.json.error.message, /at-printer/);
    assert.equal(mq.rec.logins.length, 0, 'a refused start never logs in');
  } finally { await b.stop(); await fp.close(); await mq.close(); }
});

test('start: upload then start -> the printer goes PREPARE, the command is the X2D shape, 200 started:true', async (t) => {
  if (!needCert(t)) return;
  const fp = await fakePrinter();
  const mq = await fakeMqtt();
  const b = await start(mqttArgs(fp.port, mq.port));
  try {
    const remote = await upload(b);
    const r = await request(b.port, { path: '/v1/start', headers: good, body: startBody(remote) });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.started, true);
    assert.equal(r.json.state, 'PREPARE');
    const sent = mq.rec.published.find((p) => p.j.print?.command === 'project_file');
    assert.equal(sent.topic, `device/${SERIAL}/request`);
    assert.equal(sent.j.print.url, `ftp:///${remote}`);
    assert.equal(sent.j.print.md5, createHash('md5').update(fp.rec.files[remote]).digest('hex'), 'md5 is of the FILE the printer holds');
    assert.deepEqual(sent.j.print.ams_mapping, [2]);
    assert.equal(sent.j.print.bed_type, 'textured_plate');
    assert.equal(mq.commands().filter((c) => c === 'project_file').length, 1);
  } finally { await b.stop(); await fp.close(); await mq.close(); }
});

test('the serial: accepted from env X2D_SERIAL, and the banner never prints it', async (t) => {
  // On the command line it is in `ps` for every local user; the banner printed it.
  if (!needCert(t)) return;
  const fp = await fakePrinter();
  const mq = await fakeMqtt();
  const b = await start([...printerArgs(fp.port), '--mqtt-port', String(mq.port)], { X2D_SERIAL: SERIAL });
  try {
    assert.ok(!b.out.includes(SERIAL), `the banner printed the serial:\n${b.out}`);
    assert.match(b.out, /Serial\s*: set/);
    const r = await request(b.port, { path: '/v1/status', headers: good });
    assert.equal(r.status, 200, `the env serial was not used: ${r.text}`);
  } finally { await b.stop(); await fp.close(); await mq.close(); }
});

test('start: a re-upload that FAILED leaves nothing startable under that name', async (t) => {
  // The record of the first upload survived a second upload of the same file
  // whose size the printer did not confirm, and /v1/start then started the
  // possibly-truncated file it had just reported as unconfirmed.
  if (!needCert(t)) return;
  const fp = await fakePrinter();
  const mq = await fakeMqtt();
  const b = await start(mqttArgs(fp.port, mq.port));
  try {
    const remote = await upload(b);
    fp.rec.lie = true; // the printer now reports a different size
    const r2 = await request(b.port, { path: '/v1/upload', headers: good, body: { ...job, amsMapping: [2], expectTypes: ['PETG'] } });
    assert.equal(r2.status, 502, r2.text);
    const r = await request(b.port, { path: '/v1/start', headers: good, body: startBody(remote) });
    assert.equal(r.status, 409, `start after a failed re-upload: ${r.status} ${r.text}`);
    assert.equal(mq.commands().filter((c) => c === 'project_file').length, 0, 'a project_file was sent');
  } finally { await b.stop(); await fp.close(); await mq.close(); }
});

test('start: refused when the printer is busy, or the slot holds another filament; no project_file is sent', async (t) => {
  if (!needCert(t)) return;
  const fp = await fakePrinter();
  try {
    for (const [opts, re] of [[{ state: 'RUNNING' }, /RUNNING, not idle/], [{ slot3: 'PLA' }, /reports PLA in AMS slot 3, the plate needs PETG/]]) {
      const mq = await fakeMqtt(opts);
      const b = await start(mqttArgs(fp.port, mq.port));
      try {
        const remote = await upload(b);
        const r = await request(b.port, { path: '/v1/start', headers: good, body: startBody(remote) });
        assert.equal(r.status, 409, r.text);
        assert.match(r.json.error.message, re);
        assert.ok(!mq.commands().includes('project_file'), 'nothing was started');
      } finally { await b.stop(); await mq.close(); }
    }
  } finally { await fp.close(); }
});

// START-STALE (reviewer P0, 2026-11-12): the page re-sliced the plate onto another slot and started the OLD
// file with the NEW slice's mapping and types. The bridge holds what each file was BUILT for (the G-code's own
// `; filament_type` list, and the mapping it was uploaded with) and refuses a start that asks for anything else.
// The fake printer here holds PETG in slot 3 AND PLA in slot 1, so the tray check alone would pass the PLA start.
test('gcodeFilamentTypes: the file\'s own list, also from a CONFIG_BLOCK at the END past 4 MB (Orca); null when absent', () => {
  assert.deepEqual(gcodeFilamentTypes(GCODE), ['PETG']);
  assert.deepEqual(gcodeFilamentTypes('G1\n; filament_type = PLA;PETG\n'), ['PLA', 'PETG']);
  assert.deepEqual(gcodeFilamentTypes('G1 X1\n'.repeat(800000) + '; CONFIG_BLOCK_START\n; filament_type = PLA\n; CONFIG_BLOCK_END\n'), ['PLA']);
  assert.equal(gcodeFilamentTypes('G28\n; filament_type_x = PLA\n'), null);
  assert.equal(gcodeFilamentTypes('; filament_type = \n'), null);
});

test('START-STALE: a start whose types or mapping differ from the uploaded file is 409, and nothing is published', async (t) => {
  if (!needCert(t)) return;
  const fp = await fakePrinter();
  const mq = await fakeMqtt({ slot1: 'PLA' });
  const b = await start(mqttArgs(fp.port, mq.port));
  try {
    const remote = await upload(b); // the file says PETG; uploaded for AMS slot 3
    for (const [extra, re] of [
      [{ amsMapping: [0], expectTypes: ['PLA'] }, /built for PETG/],
      [{ amsMapping: [0], expectTypes: ['PETG'] }, /uploaded for AMS mapping \[2\]/],
      [{ amsMapping: [2, 0], expectTypes: ['PETG', 'PLA'] }, /built for PETG/],
      [{ expectTypes: undefined }, /built for PETG/],
      [{ md5: 'f'.repeat(32) }, /not the G-code of/],
    ]) {
      const r = await request(b.port, { path: '/v1/start', headers: good, body: startBody(remote, extra) });
      assert.equal(r.status, 409, `${JSON.stringify(extra)}: ${r.text}`);
      assert.match(r.json.error.message, re);
    }
    assert.ok(!mq.commands().includes('project_file'), 'nothing was started');
    assert.equal(mq.rec.logins.length, 0, 'a refused start never logs in to the printer');
    // The positive control in the SAME run: the request the file was built for still starts.
    const ok = await request(b.port, { path: '/v1/start', headers: good, body: startBody(remote) });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(mq.commands().filter((c) => c === 'project_file').length, 1);
  } finally { await b.stop(); await fp.close(); await mq.close(); }
});

test('START-STALE: upload refuses types that are not the G-code\'s own, and start refuses a file uploaded without a mapping', async (t) => {
  if (!needCert(t)) return;
  const fp = await fakePrinter();
  const mq = await fakeMqtt();
  const b = await start(mqttArgs(fp.port, mq.port));
  try {
    let r = await request(b.port, { path: '/v1/upload', headers: good, body: { ...job, amsMapping: [0], expectTypes: ['PLA'] } });
    assert.equal(r.status, 409, r.text);
    assert.match(r.json.error.message, /G-code was sliced for PETG/);
    assert.equal(Object.keys(fp.rec.files).length, 0, 'nothing reached the printer');
    const remote = await upload(b, {}); // an older page: no mapping sent
    r = await request(b.port, { path: '/v1/start', headers: good, body: startBody(remote) });
    assert.equal(r.status, 409, r.text);
    assert.match(r.json.error.message, /uploaded without its AMS mapping/);
    const noTypes = { name: 'bare', gcode: 'G28\nG1 X1 E1\n', amsMapping: [2], expectTypes: ['PETG'] };
    r = await request(b.port, { path: '/v1/upload', headers: good, body: noTypes });
    assert.equal(r.status, 200, r.text);
    const s = await request(b.port, { path: '/v1/start', headers: good, body: startBody(r.json.remote) });
    assert.equal(s.status, 409, s.text);
    assert.match(s.json.error.message, /does not state its filament types/);
    assert.equal(mq.rec.logins.length, 0);
  } finally { await b.stop(); await fp.close(); await mq.close(); }
});

test('start: a printer that does not act on the command is 504, never a 200', { timeout: 60000 }, async (t) => {
  if (!needCert(t)) return;
  const fp = await fakePrinter();
  const mq = await fakeMqtt({ ignore: true });
  const b = await start(mqttArgs(fp.port, mq.port));
  try {
    const remote = await upload(b);
    const r = await request(b.port, { path: '/v1/start', headers: good, body: startBody(remote), timeoutMs: 45000 });
    assert.equal(r.status, 504, r.text);
    assert.equal(r.json.started, false);
    assert.match(r.json.error.message, /did not start \(state IDLE\)/);
  } finally { await b.stop(); await fp.close(); await mq.close(); }
});

test('stop and pause WAIT for a running status read instead of being refused; a status read meanwhile is still 429', async (t) => {
  // 🔴 Until 2026-11-14 a Stop clicked during the page's 5 s status read got 429 "another
  // printer command is running": nothing was sent and the print went on.
  if (!needCert(t)) return;
  const mq = await fakeMqtt({ state: 'RUNNING' });
  const b = await start(mqttArgs(1, mq.port));
  try {
    const [st, stop] = await Promise.all([
      request(b.port, { path: '/v1/status', headers: good, body: {} }),
      new Promise((r) => setTimeout(r, 5)).then(() => request(b.port, { path: '/v1/stop', headers: good, body: {} })),
    ]);
    assert.equal(st.status, 200, st.text);
    assert.equal(stop.status, 200, `stop during a status read: ${stop.text}`);
    assert.ok(mq.commands().includes('stop'), JSON.stringify(mq.commands()));
  } finally { await b.stop(); await mq.close(); }
  const mq2 = await fakeMqtt({ state: 'RUNNING' });
  const b2 = await start(mqttArgs(1, mq2.port));
  try {
    const [p, st2] = await Promise.all([
      request(b2.port, { path: '/v1/pause', headers: good, body: {} }),
      new Promise((r) => setTimeout(r, 5)).then(() => request(b2.port, { path: '/v1/status', headers: good, body: {} })),
    ]);
    assert.equal(p.status, 200, p.text);
    assert.equal(st2.status, 429, 'a status read is not queued behind a command');
  } finally { await b2.stop(); await mq2.close(); }
});

test('pause, resume, stop: each read back from the printer; wrong-state commands are 409', async (t) => {
  if (!needCert(t)) return;
  const mq = await fakeMqtt({ state: 'RUNNING' });
  const b = await start(mqttArgs(1, mq.port));
  try {
    let r = await request(b.port, { path: '/v1/resume', headers: good, body: { confirm: 'at-printer' } });
    assert.equal(r.status, 409, r.text);
    r = await request(b.port, { path: '/v1/pause', headers: good, body: {} });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.state, 'PAUSE');
    r = await request(b.port, { path: '/v1/resume', headers: good, body: {} });
    assert.equal(r.status, 400, 'resume needs the at-printer confirm');
    r = await request(b.port, { path: '/v1/resume', headers: good, body: { confirm: 'at-printer' } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.state, 'RUNNING');
    r = await request(b.port, { path: '/v1/stop', headers: good, body: {} });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.state, 'FAILED');
    r = await request(b.port, { path: '/v1/stop', headers: good, body: {} });
    assert.equal(r.status, 409, 'nothing to stop');
    assert.deepEqual(mq.commands().filter((c) => c !== 'pushall'), ['pause', 'resume', 'stop']);
  } finally { await b.stop(); await mq.close(); }
});

test('MQTT login with a wrong code: 502, code redacted', async (t) => {
  if (!needCert(t)) return;
  const mq = await fakeMqtt();
  const wrong = 'Wr0ngC0de';
  const b = await start(mqttArgs(1, mq.port), { X2D_ACCESS_CODE: wrong });
  try {
    const r = await request(b.port, { path: '/v1/status', headers: good, body: {} });
    assert.equal(r.status, 502, r.text);
    assert.match(r.json.error.message, /wrong access code/);
    for (const s of [r.text, b.out, b.err]) assert.ok(!s.includes(wrong), 'the access code leaked');
  } finally { await b.stop(); await mq.close(); }
});

test('start: a printer that refuses the job is 502 with the HMS code, also when it was already FAILED', { timeout: 60000 }, async (t) => {
  if (!needCert(t)) return;
  const fp = await fakePrinter();
  const mq = await fakeMqtt({ refuse: true });
  const b = await start(mqttArgs(fp.port, mq.port));
  try {
    const remote = await upload(b);
    for (let i = 0; i < 2; i++) {
      const r = await request(b.port, { path: '/v1/start', headers: good, body: startBody(remote), timeoutMs: 45000 });
      assert.equal(r.status, 502, r.text);
      assert.match(r.json.error.message, /refused the job: FAILED, error 0500-4046; the printer answered project_file with result "fail", reason "fake refusal"/);
    }
  } finally { await b.stop(); await fp.close(); await mq.close(); }
});

test('package: dual-nozzle metadata from the G-code (filament_maps, nozzle, bed_type, filament_sequence.json)', () => {
  const g = GCODE.replace('; HEADER_BLOCK_END', '; total layer number: 36\n; HEADER_BLOCK_END')
    .replace('; CONFIG_BLOCK_END', '; filament_map = 1\n; extruder_type = Direct Drive,Bowden\n; filament_ids = GFG00\n; filament used [mm] = 203.68\n; filament used [g] = 0.61\n; nozzle_volume_type = Standard\n; CONFIG_BLOCK_END');
  const e = unzip(buildGcode3mf(g).zip);
  const get = (n) => e.find((x) => x.name === n)?.data.toString('utf8');
  assert.equal(JSON.parse(get('Metadata/plate_1.json')).bed_type, 'textured_plate');
  const si = get('Metadata/slice_info.config');
  assert.match(si, /key="extruder_type" value="0 1"/);
  assert.match(si, /key="filament_maps" value="1"/);
  assert.match(si, /<filament id="1" tray_info_idx="GFG00" type="PETG" color="#F2754E" used_m="0.20" used_g="0.61" group_id="0" nozzle_diameter="0.40" volume_type="Standard"/);
  // The X2D rejected a slice_info without Orca's field set ("3MF file is invalid", 2026-10-20).
  const keys = [...si.matchAll(/<metadata key="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(keys, ['index', 'extruder_type', 'nozzle_volume_type', 'printer_model_id', 'nozzle_diameters', 'timelapse_type', 'prediction',
    'weight', 'first_layer_time', 'outside', 'support_used', 'label_object_enabled', 'enable_filament_dynamic_map', 'has_filament_switcher',
    'filament_maps', 'limit_filament_maps']);
  assert.match(si, /<layer_filament_list filament_list="0" layer_ranges="0 35" \/>/);
  assert.match(si, /used_m="0.20" used_g="0.61"/);
  assert.match(si, /key="weight" value="0.61"/);
  assert.match(si, /<nozzle id="0" extruder_id="1" nozzle_diameter="0.4" volume_type="Standard"\/>/);
  assert.match(get('Metadata/model_settings.config'), /key="filament_maps" value="1"/);
  assert.deepEqual(JSON.parse(get('Metadata/filament_sequence.json')), { plate_1: { nozzle_sequence: [0], optimal_assignment: [0], sequence: [1] } });
  // Without filament_map in the G-code, none of it is invented.
  const plain = unzip(buildGcode3mf(GCODE).zip);
  assert.deepEqual(plain.map((x) => x.name), [...ENTRY_NAMES]);
  assert.ok(!plain.find((x) => x.name === 'Metadata/slice_info.config').data.toString().includes('filament_maps'));
});

/* ───────────────────────────── camera ───────────────────────────── */

test('splitJpegs: whole frames out, a partial frame kept for the next chunk', () => {
  const f1 = Buffer.from([0xff, 0xd8, 1, 2, 0xff, 0xd9]);
  const f2 = Buffer.from([0xff, 0xd8, 3, 0xff, 0xd9]);
  const [a, rest] = splitJpegs(Buffer.concat([Buffer.from([9]), f1, f2.subarray(0, 3)]));
  assert.deepEqual(a.map((x) => [...x]), [[...f1]]);
  const [b] = splitJpegs(Buffer.concat([rest, f2.subarray(3)]));
  assert.deepEqual(b.map((x) => [...x]), [[...f2]]);
});

test('camera: a frame from the reader as image/jpeg; the access code is never in its argv; 409 without a code', async () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'fake-ffmpeg-'));
  const argvFile = join(dir, 'argv.json');
  const fake = join(dir, 'ffmpeg');
  writeFileSync(fake, `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
const file = args[args.indexOf('-i') + 1];
fs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify({ args, mode: (fs.statSync(file).mode & 0o777).toString(8), concat: fs.readFileSync(file, 'utf8') }));
const jpg = Buffer.from([0xff, 0xd8, 0x42, 0x43, 0xff, 0xd9]);
const t = setInterval(() => process.stdout.write(jpg), 100);
process.on('SIGTERM', () => { clearInterval(t); process.exit(0); });
`, { mode: 0o755 });
  const b = await start(['--printer', '127.0.0.1', '--ffmpeg', fake]);
  try {
    const r = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: b.port, method: 'POST', path: '/v1/camera.jpg', headers: good }, (res) => {
        const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: Buffer.concat(c) }));
      });
      req.on('error', reject); req.end();
    });
    assert.equal(r.status, 200, r.body.toString());
    assert.equal(r.type, 'image/jpeg');
    assert.deepEqual([...r.body], [0xff, 0xd8, 0x42, 0x43, 0xff, 0xd9]);
    const seen = JSON.parse(readFileSync(argvFile, 'utf8'));
    assert.ok(!JSON.stringify(seen.args).includes(CODE), 'the access code is on the ffmpeg command line');
    assert.equal(seen.mode, '600');
    assert.match(seen.concat, /rtsps:\/\/bblp:.+@127\.0\.0\.1:322\/streaming\/live\/1/);
    await new Promise((r2) => setTimeout(r2, 100));
    for (const s2 of [b.out, b.err]) assert.ok(!s2.includes(CODE), 'the access code leaked');
  } finally { await b.stop(); }
  // The URL file (it holds the code) is gone once the bridge has exited, not 8 s later.
  const left = readdirSync(os.tmpdir()).filter((n) => n.startsWith('x2d-cam-')).filter((n) => {
    try { return readFileSync(join(os.tmpdir(), n, 'stream.ffconcat'), 'utf8').includes(CODE); } catch { return false; }
  });
  assert.deepEqual(left, [], 'a camera URL file with the code outlived the bridge');
  const nc = await start(['--printer', '127.0.0.1', '--ffmpeg', fake], { X2D_ACCESS_CODE: '' });
  try {
    const r = await request(nc.port, { path: '/v1/camera.jpg', headers: good, body: {} });
    assert.equal(r.status, 409, r.text);
  } finally { await nc.stop(); }
});

test('camera: a reader that stays alive but sends nothing is replaced on a later ask, and the new one serves frames', async () => {
  const dir = mkdtempSync(join(os.tmpdir(), 'fake-ffmpeg-'));
  const runs = join(dir, 'runs');
  const fake = join(dir, 'ffmpeg');
  // First run: connected to nothing, sends no byte, ignores nothing (the 2026-11-22 live state).
  // Every later run: frames.
  writeFileSync(fake, `#!${process.execPath}
const fs = require('fs');
let n = 0; try { n = Number(fs.readFileSync(${JSON.stringify(runs)}, 'utf8')); } catch {}
fs.writeFileSync(${JSON.stringify(runs)}, String(n + 1));
if (n === 0) { setInterval(() => {}, 1000); }
else { const jpg = Buffer.from([0xff, 0xd8, 0x77, 0xff, 0xd9]); setInterval(() => process.stdout.write(jpg), 50); }
process.on('SIGTERM', () => process.exit(0));
`, { mode: 0o755 });
  const cam = new Camera({ ffmpeg: fake, printerIp: '127.0.0.1', code: 'c0de', stallMs: 300 });
  try {
    await assert.rejects(cam.latest(4000, 400), (e) => e.status === 504, 'the stalled reader gives no frame');
    const { jpeg } = await cam.latest(4000, 3000);
    assert.deepEqual([...jpeg], [0xff, 0xd8, 0x77, 0xff, 0xd9]);
    assert.equal(readFileSync(runs, 'utf8'), '2', 'exactly one replacement reader');
  } finally {
    cam.proc?.kill('SIGKILL');
  }
});

test('light: chamber light off then on, read back from the printer report; 400 without a boolean', async (t) => {
  if (!needCert(t)) return;
  const mq = await fakeMqtt({ state: 'RUNNING' });
  const b = await start(mqttArgs(1, mq.port));
  try {
    let r = await request(b.port, { path: '/v1/light', headers: good, body: { on: false } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.light, 'off');
    r = await request(b.port, { path: '/v1/light', headers: good, body: { on: true } });
    assert.equal(r.json.light, 'on');
    r = await request(b.port, { path: '/v1/light', headers: good, body: { on: 'yes' } });
    assert.equal(r.status, 400, r.text);
    assert.equal(mq.rec.state, 'RUNNING', 'a light change does not touch the print');
  } finally { await b.stop(); await mq.close(); }
});

test('fan: set a settable fan, read back from the printer; refuse a fan the mode runs; 400 before contact', async (t) => {
  if (!needCert(t)) return;
  const mq = await fakeMqtt({ state: 'RUNNING' });
  const b = await start(mqttArgs(1, mq.port));
  try {
    let r = await request(b.port, { path: '/v1/status', headers: good, body: {} });
    assert.equal(r.json.fanMode, 'Heating');
    assert.equal(r.json.fans.find((f) => f.id === 3).percent, 70);
    r = await request(b.port, { path: '/v1/fan', headers: good, body: { id: 3, percent: 30 } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.fans.find((f) => f.id === 3).percent, 30);
    const sent = mq.rec.published.filter((p) => p.j.print?.command === 'set_fan');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].j.print.fan_index, 3);
    assert.equal(sent[0].j.print.speed, 30);
    r = await request(b.port, { path: '/v1/fan', headers: good, body: { id: 2, percent: 50 } });
    assert.equal(r.status, 409, r.text);
    assert.match(r.json.error.message, /Left \(Heating\) is run by the printer in Heating mode/);
    const before = mq.rec.published.length;
    r = await request(b.port, { path: '/v1/fan', headers: good, body: { id: 3, percent: 33 } });
    assert.equal(r.status, 400, r.text);
    assert.equal(mq.rec.published.length, before, 'a bad body never reaches the printer');
    assert.equal(mq.commands().filter((c) => c === 'set_fan').length, 1);
    assert.equal(mq.rec.state, 'RUNNING', 'a fan change does not touch the print');
  } finally { await b.stop(); await mq.close(); }
});

test('fan: a printer that ignores set_fan is 504, not "done"', async (t) => {
  if (!needCert(t)) return;
  const mq = await fakeMqtt({ state: 'RUNNING', ignore: true });
  const b = await start(mqttArgs(1, mq.port));
  try {
    const r = await request(b.port, { path: '/v1/fan', headers: good, body: { id: 1, percent: 100 } });
    assert.equal(r.status, 504, r.text);
    assert.match(r.json.error.message, /Parts 100 % sent, but the printer did not report it/);
  } finally { await b.stop(); await mq.close(); }
});

test('speed: set during a print and read back; 409 when idle, 400 for an unknown level', async (t) => {
  if (!needCert(t)) return;
  const mq = await fakeMqtt({ state: 'RUNNING' });
  const b = await start(mqttArgs(1, mq.port));
  try {
    let r = await request(b.port, { path: '/v1/status', headers: good, body: {} });
    assert.deepEqual(r.json.speed, { level: 2, name: 'Standard' });
    assert.deepEqual(r.json.stage, { id: 0, name: 'Printing' });
    assert.equal(r.json.hms[0].code, '0500-0600-0002-0070');
    r = await request(b.port, { path: '/v1/speed', headers: good, body: { level: 3 } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.speed, { level: 3, name: 'Sport' });
    const before = mq.rec.published.length;
    r = await request(b.port, { path: '/v1/speed', headers: good, body: { level: 5 } });
    assert.equal(r.status, 400, r.text);
    assert.equal(mq.rec.published.length, before);
    mq.rec.state = 'IDLE';
    r = await request(b.port, { path: '/v1/speed', headers: good, body: { level: 1 } });
    assert.equal(r.status, 409, r.text);
    assert.equal(mq.commands().filter((c) => c === 'print_speed').length, 1);
  } finally { await b.stop(); await mq.close(); }
});

test('fanmode: switch to a mode the printer lists, read back; 409 for one it does not list', async (t) => {
  if (!needCert(t)) return;
  const mq = await fakeMqtt({ state: 'RUNNING' });
  const b = await start(mqttArgs(1, mq.port));
  try {
    let r = await request(b.port, { path: '/v1/fanmode', headers: good, body: { mode: 0 } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.fanMode, 'Strong Cooling');
    assert.equal(r.json.fanModeId, 0);
    assert.deepEqual(r.json.fanModes, [{ id: 0, name: 'Strong Cooling' }, { id: 1, name: 'Heating' }]);
    assert.equal(r.json.fans.find((f) => f.id === 2).control, 'set', 'Left (Aux) is settable in Strong Cooling');
    r = await request(b.port, { path: '/v1/fanmode', headers: good, body: { mode: 3 } });
    assert.equal(r.status, 409, r.text);
    assert.equal(mq.commands().filter((c) => c === 'set_airduct').length, 1);
  } finally { await b.stop(); await mq.close(); }
});

test('skip: only objects of a running file this bridge uploaded; read back; never every object; confirm needed', async (t) => {
  if (!needCert(t)) return;
  const ftp = await fakePrinter();
  const mq = await fakeMqtt({ state: 'IDLE', slot3: 'PETG' });
  const b = await start(mqttArgs(ftp.port, mq.port));
  try {
    let r = await request(b.port, { path: '/v1/upload', headers: good, body: { name: 'two cubes', gcode: LABELLED, amsMapping: [2], expectTypes: ['PETG'] } });
    assert.equal(r.status, 200, r.text);
    const remote = r.json.remote;
    r = await request(b.port, { path: '/v1/skip', headers: good, body: { ids: [55], confirm: 'skip' } });
    assert.equal(r.status, 409, 'nothing running: ' + r.text);
    r = await request(b.port, { path: '/v1/start', headers: good, body: startBody(remote) });
    assert.equal(r.status, 200, r.text);
    mq.rec.state = 'RUNNING';
    r = await request(b.port, { path: '/v1/status', headers: good, body: {} });
    assert.deepEqual(r.json.objects, [{ id: 55, name: 'cubeA' }, { id: 77, name: 'cube <B>' }]);
    const before = mq.rec.published.length;
    r = await request(b.port, { path: '/v1/skip', headers: good, body: { ids: [55] } });
    assert.equal(r.status, 400, r.text);
    assert.equal(mq.rec.published.length, before, 'no confirm: nothing reaches the printer');
    r = await request(b.port, { path: '/v1/skip', headers: good, body: { ids: [55, 77], confirm: 'skip' } });
    assert.equal(r.status, 409, r.text);
    assert.match(r.json.error.message, /every object/);
    r = await request(b.port, { path: '/v1/skip', headers: good, body: { ids: [12], confirm: 'skip' } });
    assert.equal(r.status, 409, r.text);
    r = await request(b.port, { path: '/v1/skip', headers: good, body: { ids: [55], confirm: 'skip' } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.skipped, [55]);
    const sent = mq.rec.published.filter((p) => p.j.print?.command === 'skip_objects');
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].j.print.obj_list, [55]);
    r = await request(b.port, { path: '/v1/skip', headers: good, body: { ids: [77], confirm: 'skip' } });
    assert.equal(r.status, 409, 'the last object left is a Stop: ' + r.text);
  } finally { await b.stop(); await mq.close(); await ftp.close(); }
});

test('objectFootprints: the hull of each label\'s EXTRUDING moves; travel, wipes and unlabelled lines are not part of it', async () => {
  const { objectFootprints } = await import('./bridge.mjs');
  const g = [
    'G90', 'M83',
    'G1 X500 Y500 E1', // extrusion outside any label (prime line): no object's
    '; start printing object, unique label id: 7',
    'G0 X10 Y10', // travel in
    'G1 X20 Y10 E0.5', 'G1 X20 Y20 E0.5', 'G1 X10 Y20 E0.5', 'G1 X10 Y10 E0.5',
    'G1 X90 Y90', // travel inside the label, no E: not the object
    'G1 X95 Y95 E-0.8', // retract: not the object
    '; stop printing object, unique label id: 7',
    '; start printing object, unique label id: 8',
    'G0 X40 Y15',
    'G3 X40 Y25 I0 J5 E1', // CCW half circle about (40,20): bulges to X45; a hull of end points alone would miss it
    '; stop printing object, unique label id: 8',
    '; start printing object, unique label id: 9',
    'G0 X40 Y15',
    'G2 X40 Y25 I0 J5 E1', // the same points clockwise: bulges to X35
    '; stop printing object, unique label id: 9',
  ].join('\n');
  const fp = objectFootprints(g);
  const box = (h) => [Math.min(...h.map((p) => p[0])), Math.min(...h.map((p) => p[1])), Math.max(...h.map((p) => p[0])), Math.max(...h.map((p) => p[1]))];
  assert.deepEqual(box(fp.get(7)), [10, 10, 20, 20]);
  assert.deepEqual([box(fp.get(8))[0], box(fp.get(8))[2]], [40, 45], 'G3 bulges to +X');
  assert.deepEqual([box(fp.get(9))[0], box(fp.get(9))[2]], [35, 40], 'G2 bulges to -X');
  // Absolute E (M82): a move is extruding only when E grows.
  const abs = objectFootprints(['M82', '; start printing object, unique label id: 1', 'G1 X0 Y0 E5', 'G1 X10 Y0 E6', 'G1 X10 Y10 E6', 'G1 X0 Y10 E7'].join('\n'));
  assert.deepEqual(box(abs.get(1)), [0, 0, 10, 10]);
});

test('objectFootprints on real Orca G-code: every label has an outline, and two side-by-side cubes do not overlap', async (t) => {
  const f = new URL(`file://${process.env.HOME}/build/fdm-corpus/mm/orca.gcode`);
  const { existsSync, readFileSync } = await import('node:fs');
  if (!existsSync(f)) return t.skip(`PENDING: ${f.pathname} is not on this machine, so no real file was read`);
  const m = gcodeMeta(readFileSync(f, 'utf8'));
  assert.equal(m.objects.length, 2);
  assert.ok(m.objects.every((o) => o.hull && o.hull.length >= 3));
  const [a, b] = m.objects.map((o) => Math.max(...o.hull.map((p) => p[0])));
  const bMin = Math.min(...m.objects[1].hull.map((p) => p[0]));
  assert.ok(a < bMin, `the outlines overlap: a ends at ${a}, b starts at ${bMin}`);
  assert.ok(b > bMin);
  assert.deepEqual(m.printableArea, [[0, 0], [256, 0], [256, 256], [0, 256]]);
});

test('/v1/hello: the one route without a token, names the bridge and never the printer; guards still apply', async () => {
  const b = await start(['--printer', '127.0.0.1', '--printer-port', '1']);
  try {
    const r = await request(b.port, { method: 'GET', path: '/v1/hello', headers: { origin: 'https://2bee.app' } });
    assert.equal(r.status, 200);
    const { peers, ...rest } = r.json;
    assert.deepEqual(rest, { ok: true, bridge: '2bee.printer-bridge', api: 1, needsToken: true });
    assert.ok(peers.some((x) => x.bridge === '2bee.printer-bridge' && x.port === b.port), 'a running bridge lists itself among the peers');
    assert.equal(r.headers['access-control-allow-origin'], 'https://2bee.app');
    assert.doesNotMatch(r.text, /127\.0\.0\.1/, 'the printer address is not discovery information');
    assert.equal((await request(b.port, { method: 'GET', path: '/v1/hello', headers: { origin: 'https://evil.example' } })).status, 403);
    assert.equal((await request(b.port, { method: 'GET', path: '/v1/hello', headers: { host: 'evil.example:80' } })).status, 403);
    // Negative control: every other route still needs the token, and GET is still refused elsewhere.
    assert.equal((await request(b.port, { path: '/v1/check' })).status, 401);
    assert.equal((await request(b.port, { method: 'GET', path: '/v1/status' })).status, 405);
  } finally { await b.stop(); }
});

test('camera: when the live view port is closed the failure SAYS so (measured on the X2D 2026-11-20); an open port keeps the reader error', async () => {
  // A closed port: bind one, note it, close it.
  const closed = await new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const b = await start(['--printer', '127.0.0.1', '--ffmpeg', '/bin/false', '--camera-port', String(closed)]);
  try {
    const r = await request(b.port, { path: '/v1/camera.jpg', headers: good, body: {} });
    assert.ok(r.status >= 500, r.text);
    assert.match(r.json.error.message, new RegExp(`port ${closed} on 127\\.0\\.0\\.1 is closed`));
    assert.match(r.json.error.message, /LAN live view/);
    assert.ok(!r.text.includes(CODE), 'the access code leaked');
  } finally { await b.stop(); }
  // Positive control: the port IS open (something listens), so the message must NOT blame the port.
  const open = net.createServer((c) => c.destroy());
  await new Promise((r) => open.listen(0, '127.0.0.1', r));
  const b2 = await start(['--printer', '127.0.0.1', '--ffmpeg', '/bin/false', '--camera-port', String(open.address().port)]);
  try {
    const r = await request(b2.port, { path: '/v1/camera.jpg', headers: good, body: {} });
    assert.ok(r.status >= 500, r.text);
    assert.doesNotMatch(r.json.error.message, /is closed/);
  } finally { await b2.stop(); open.close(); }
});
