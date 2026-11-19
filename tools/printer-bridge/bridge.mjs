#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// printer-bridge — step 3 of the 2bee.app product scope ("send it to the
// printer"): copies ONE G-code job onto the Bambu Lab X2D's storage over the
// LAN, then (with --serial) starts, pauses, resumes or stops it over the
// printer's LAN MQTT (founder 2026-10-20: "add remote start", "remote pause,
// remote stop"; supersedes 2026-10-14 "Upload only").
//
//   POST /v1/upload  {name, gcode, amsMapping?, expectTypes?}  -> {ok, remote, bytes, remoteBytes, md5, started:false}
//   POST /v1/check   {}             -> {reachable, haveCode, haveSerial, printer}
//   POST /v1/status  {}             -> the printer's own report, by name
//   POST /v1/start   {remote, amsMapping, expectTypes, bedType, confirm:'at-printer'}
//   POST /v1/resume {confirm:'at-printer'} · POST /v1/pause {} · POST /v1/stop {}
//   POST /v1/light {on} · POST /v1/fan {id, percent} · POST /v1/fanmode {mode}
//   POST /v1/speed {level} · POST /v1/skip {ids, confirm:'skip'}  -> the status reply, read back after
//
// ═══════════════════════════════════════════════════════════════════════════
// WHAT THIS DOES NOT DO
// ═══════════════════════════════════════════════════════════════════════════
//   · 🔴 IT SENDS NO PRINTER COMMAND OUTSIDE TWO ALLOWLISTS. FTP: the verbs in
//     FTP_VERBS (an upload and a size check). MQTT: the print commands in
//     MQTT_COMMANDS (project_file, pause, resume, stop) plus the pushall status
//     request, the chamber light, one fan speed (set_fan), the fan mode
//     (set_airduct), the print speed level (print_speed) and skipping objects of
//     the running file (skip_objects). Each has ONE exact shape (see the *Valid
//     functions). No G-code line, no AMS write, no calibration. Anything
//     else throws before a byte is written, and the tests assert what the fake
//     printer actually received.
//   · It never reports a command as done because it was SENT. Each print
//     command reads the state first, refuses the wrong state (409), and answers
//     with the state the printer reports afterwards, or 504.
//   · It never starts a file it did not upload and size-confirm in this run,
//     nor for other filament than that file was built for: a start must carry
//     the file's own `; filament_type` list and the AMS mapping it was uploaded
//     with, or it is 409 before the printer is contacted (START-STALE).
//   · It never reads OrcaSlicer's config. The access code comes from
//     --code-file or env X2D_ACCESS_CODE and nowhere else. It is never logged,
//     never echoed, and is replaced by *** in every error text.
//   · It does not validate the G-code. The core and the gates upstream own
//     that; this bridge carries bytes and confirms their size on the printer.
//   · It binds 127.0.0.1 and nothing else. `--host` with any other value is a
//     refusal (exit 2).
//   · It talks to ONE printer, by IP literal, on a private/loopback address.
//     The printer's self-signed certificate is accepted for THAT IP only
//     (see tlsOptionsFor). A hostname is refused: a name can be re-pointed.
//   · It never logs a token, an access code or a body: one line per request
//     (time, method, path, origin, status, ms).
//
// No npm dependencies: node:http, node:tls, node:net, node:zlib, node:crypto,
// node:fs, node:url only.

import http from 'node:http';
import tls from 'node:tls';
import net from 'node:net';
import { deflateRawSync, crc32, gunzipSync } from 'node:zlib';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listenBambu, searchBambu } from './ssdp.mjs';
import { peers as registryPeers, register as registerBridge } from '../bridge-registry.mjs';

export const DEFAULT_PORT = 8788;
export const BIND_HOST = '127.0.0.1';
export const DEFAULT_ORIGINS = ['http://localhost:5178', 'http://127.0.0.1:5178', 'https://2bee.app'];
export const DEFAULT_TIMEOUT_S = 120;
export const DEFAULT_MAX_BODY = 64 * 1024 * 1024;
export const DEFAULT_PRINTER_PORT = 990; // Bambu LAN FTPS, implicit TLS
export const FTP_USER = 'bblp';
export const MAX_QUEUE = 4;

/**
 * 🔴 THE ONLY FTP VERBS THIS CLIENT CAN SEND. Upload + size check + polite exit.
 * There is deliberately no DELE, RETR, LIST, CWD, MKD, SITE, RNFR/RNTO — and no
 * protocol here for starting a print at all (that is MQTT on 8883, which this
 * file never opens). FtpsClient.cmd() refuses anything else before writing.
 */
export const FTP_VERBS = Object.freeze(['USER', 'PASS', 'PBSZ', 'PROT', 'TYPE', 'EPSV', 'PASV', 'STOR', 'SIZE', 'QUIT']);

/* ─────────────────────────────── arguments ─────────────────────────────── */

/** True for a loopback or private (RFC 1918 / link-local / ULA) IP literal. */
export function isLanIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    return l === '::1' || /^f[cd][0-9a-f]{0,2}:/.test(l) || /^fe[89ab][0-9a-f]?:/.test(l);
  }
  return false;
}

export function parseArgs(argv) {
  const o = {
    port: DEFAULT_PORT,
    host: BIND_HOST,
    origins: [...DEFAULT_ORIGINS],
    tokenFile: null,
    codeFile: null,
    printer: null,
    printerPort: DEFAULT_PRINTER_PORT,
    mqttPort: DEFAULT_MQTT_PORT,
    serial: null,
    ffmpeg: 'ffmpeg',
    cameraPort: DEFAULT_CAMERA_PORT,
    certSha256: null,
    timeoutS: DEFAULT_TIMEOUT_S,
    maxBody: DEFAULT_MAX_BODY,
    discover: true,
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
    else if (a === '--code-file') o.codeFile = val();
    else if (a === '--printer') o.printer = val();
    else if (a === '--printer-port') o.printerPort = int(val(), '--printer-port', 1);
    else if (a === '--mqtt-port') o.mqttPort = int(val(), '--mqtt-port', 1);
    else if (a === '--serial') o.serial = val();
    else if (a === '--no-discover') o.discover = false;
    else if (a === '--ffmpeg') o.ffmpeg = val();
    else if (a === '--camera-port') o.cameraPort = int(val(), '--camera-port', 1);
    else if (a === '--printer-cert-sha256') o.certSha256 = normaliseFingerprint(val());
    else if (a === '--timeout') o.timeoutS = int(val(), '--timeout', 1);
    else if (a === '--max-body') o.maxBody = int(val(), '--max-body', 1);
    else throw new Error(`unknown argument: ${a}`);
  }
  if (o.port > 65535) throw new Error('--port must be <= 65535');
  if (o.printerPort > 65535) throw new Error('--printer-port must be <= 65535');
  if (o.mqttPort > 65535) throw new Error('--mqtt-port must be <= 65535');
  // The serial names the printer's MQTT topic. On the command line it is in
  // `ps` for every local user, so env X2D_SERIAL is accepted too (--serial still
  // wins), and the banner never prints the value.
  if (o.serial === null && process.env.X2D_SERIAL) o.serial = process.env.X2D_SERIAL.trim();
  if (o.serial !== null && !/^[A-Z0-9]{8,24}$/.test(o.serial)) throw new Error('--serial must be the printer serial (8-24 capitals and digits)');
  if (o.host !== BIND_HOST) {
    throw new Error(`refusing to bind ${o.host}: this bridge binds ${BIND_HOST} only`);
  }
  if (!o.printer) {
    throw new Error('no printer: pass --printer <ip> (the X2D\'s LAN IP, shown on the printer under Settings → Network)');
  }
  if (!net.isIP(o.printer)) {
    throw new Error(`--printer ${o.printer} is not an IP literal; a hostname is refused because the certificate exemption is keyed to the IP`);
  }
  if (!isLanIp(o.printer)) {
    throw new Error(`--printer ${o.printer} is not a private or loopback address; this bridge sends the access code only to a printer on the LAN`);
  }
  return o;
}

function normaliseFingerprint(v) {
  const hex = v.replace(/:/g, '').toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(hex)) throw new Error('--printer-cert-sha256 must be a SHA-256 fingerprint (64 hex digits, colons optional)');
  return hex;
}

/**
 * The bridge's OWN bearer token (not the printer's code). Precedence:
 * --token-file, env PRINTER_BRIDGE_TOKEN, generated. `printable` is true ONLY
 * for a generated token — a token the operator supplied is never echoed.
 */
export function resolveToken(tokenFile, env) {
  let token;
  let source;
  if (tokenFile) {
    token = readFileSync(tokenFile, 'utf8').trim();
    source = `--token-file ${tokenFile}`;
  } else if (env.PRINTER_BRIDGE_TOKEN !== undefined) {
    token = env.PRINTER_BRIDGE_TOKEN.trim();
    source = 'env PRINTER_BRIDGE_TOKEN';
  } else {
    return { token: randomBytes(24).toString('base64url'), source: 'generated', printable: true };
  }
  if (token.length < 16) throw new Error(`the token from ${source} is shorter than 16 characters`);
  if (/\s/.test(token)) throw new Error(`the token from ${source} contains whitespace`);
  return { token, source, printable: false };
}

/**
 * The printer's LAN access code. --code-file wins over env X2D_ACCESS_CODE;
 * neither is allowed (the bridge starts, /v1/check says haveCode:false and an
 * upload is a 409). NEVER read from OrcaSlicer's config. The error messages
 * name the source, never the value.
 */
export function resolveAccessCode(codeFile, env) {
  let code;
  let source;
  if (codeFile) {
    code = readFileSync(codeFile, 'utf8').trim();
    source = `--code-file ${codeFile}`;
  } else if (env.X2D_ACCESS_CODE !== undefined && env.X2D_ACCESS_CODE !== '') {
    code = env.X2D_ACCESS_CODE.trim();
    source = 'env X2D_ACCESS_CODE';
  } else {
    return { code: null, source: 'none' };
  }
  // Printable ASCII, no spaces: it goes on the FTP control line, so a CR/LF in
  // it would be a command injection, not a typo.
  if (!/^[\x21-\x7e]{4,64}$/.test(code)) {
    throw new Error(`the access code from ${source} must be 4-64 printable characters with no spaces or line breaks`);
  }
  return { code, source };
}

/* ─────────────────────────────── 3MF ─────────────────────────────── */

/** Remote file name: [\w-] only, at most 64 chars of the caller's name, then
 *  the first 8 hex of the G-code's MD5 (same G-code -> same name), then .gcode.3mf. */
export function remoteName(name, md5hex) {
  let base = String(name ?? '').replace(/\.(gcode\.3mf|3mf|gcode|gco|g|stl)$/i, '');
  base = base.replace(/[^\w-]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64);
  if (!base) base = 'job';
  return `${base}_${md5hex.slice(0, 8).toLowerCase()}.gcode.3mf`;
}

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Top-view footprint per object label id: the convex hull (mm, bed coordinates, 0.1 mm) of every
 * EXTRUDING move inside `; start printing object, unique label id: N` … `; stop printing object`.
 * Moves: G0/G1 lines, and G2/G3 arcs sampled from their I/J centre (a hull of arc END points
 * alone would cut the bulge off). Positioning G90/G91 and extrusion M82/M83 are both tracked.
 * Travel, wipes with no extrusion, and everything outside a label are not part of an object.
 */
export function objectFootprints(gcode) {
  const pts = new Map();
  let id = null, absXY = true, absE = true, x = 0, y = 0, e = 0;
  const num = (line, k) => {
    const m = new RegExp(`(?:^|\\s)${k}(-?\\d*\\.?\\d+)`, 'i').exec(line);
    return m ? Number(m[1]) : null;
  };
  for (const raw of gcode.split('\n')) {
    if (raw.startsWith(';')) {
      const st = /^; start printing object, unique label id: (\d+)/.exec(raw);
      if (st) id = Number(st[1]);
      else if (/^; stop printing object, unique label id:/.test(raw)) id = null;
      continue;
    }
    const line = raw.split(';')[0].trim();
    if (!line) continue;
    const cmd = line.split(/\s+/)[0].toUpperCase();
    if (cmd === 'G90') { absXY = true; continue; }
    if (cmd === 'G91') { absXY = false; continue; }
    if (cmd === 'M82') { absE = true; continue; }
    if (cmd === 'M83') { absE = false; continue; }
    if (cmd === 'G92') { const ne = num(line, 'E'); if (ne !== null) e = ne; continue; }
    if (!['G0', 'G1', 'G2', 'G3'].includes(cmd)) continue;
    const nx = num(line, 'X'), ny = num(line, 'Y'), ne = num(line, 'E');
    const tx = nx === null ? x : absXY ? nx : x + nx;
    const ty = ny === null ? y : absXY ? ny : y + ny;
    let extrudes = false;
    if (ne !== null) {
      extrudes = absE ? ne > e : ne > 0;
      e = absE ? ne : e + ne;
    }
    if (extrudes && id !== null && (tx !== x || ty !== y)) {
      let list = pts.get(id);
      if (!list) pts.set(id, (list = []));
      list.push([x, y], [tx, ty]);
      const i = num(line, 'I'), j = num(line, 'J');
      if ((cmd === 'G2' || cmd === 'G3') && (i !== null || j !== null)) {
        const cx = x + (i ?? 0), cy = y + (j ?? 0), r = Math.hypot(x - cx, y - cy);
        let a0 = Math.atan2(y - cy, x - cx), a1 = Math.atan2(ty - cy, tx - cx);
        if (cmd === 'G3' && a1 <= a0) a1 += 2 * Math.PI;
        if (cmd === 'G2' && a1 >= a0) a1 -= 2 * Math.PI;
        for (let k = 1; k < 16; k++) {
          const a = a0 + ((a1 - a0) * k) / 16;
          list.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
        }
      }
    }
    x = tx;
    y = ty;
  }
  const out = new Map();
  for (const [k, list] of pts) out.set(k, convexHull(list).map(([px, py]) => [Math.round(px * 10) / 10, Math.round(py * 10) / 10]));
  return out;
}

/** Monotone-chain convex hull, counter-clockwise, no repeated first point. */
function convexHull(points) {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper = [];
  for (let k = p.length - 1; k >= 0; k--) {
    const q = p[k];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/**
 * Values read from the G-code's own CONFIG/HEADER comments (Orca/Bambu style
 * `; key = value`). A value that is not there is OMITTED from the metadata —
 * never defaulted, because the printer's screen would show it as fact.
 */
export function gcodeMeta(gcode) {
  const head = gcode.length > 4e6 ? gcode.slice(0, 4e6) : gcode;
  const key = (k) => {
    const m = new RegExp(`^;\\s*${k}\\s*=\\s*(.*?)\\s*$`, 'm').exec(head);
    return m ? m[1] : null;
  };
  const list = (v) => (v == null ? null : v.split(/[;,]/).map((s) => s.trim()).filter(Boolean));
  const meta = {};
  const nd = list(key('nozzle_diameter'));
  if (nd && nd.every((x) => Number.isFinite(Number(x)))) meta.nozzleDiameters = nd.map(Number);
  const ft = list(key('filament_type'));
  if (ft) meta.filamentTypes = ft;
  const fc = list(key('filament_colour'));
  if (fc && fc.every((c) => /^#[0-9A-Fa-f]{6,8}$/.test(c))) meta.filamentColours = fc;
  // bed_type: only an EXACT plate name found in BED_TYPES (below). Until 2026-10-20 this
  // was not derived at all. Then an Orca package on the X2D was read: it wrote
  // "textured_plate" for `curr_bed_type = Textured PEI Plate`, the table's own entry.
  // Dual-nozzle facts the X2D reads from the package (Orca writes them; added 2026-10-20 after
  // the X2D refused a package without them, HMS 0500-4046). Each is taken from the G-code's own
  // config block, or omitted.
  const fm = list(key('filament_map'));
  if (fm && fm.every((x) => /^\d+$/.test(x))) meta.filamentMap = fm.map(Number);
  const et = list(key('extruder_type'));
  const ET = { 'Direct Drive': 0, Bowden: 1 };
  if (et && et.every((x) => x in ET)) meta.extruderTypes = et.map((x) => ET[x]);
  const fid = list(key('filament_ids'));
  if (fid) meta.filamentIds = fid;
  const bed = key('curr_bed_type');
  if (bed && BED_TYPES[bed]) meta.bedType = BED_TYPES[bed];
  const fmm = key('filament_map_mode');
  if (fmm) meta.filamentMapMode = fmm;
  // slice_info facts (2026-10-20: the X2D called the 3MF invalid until slice_info carried
  // Orca's field set; proven by swapping ONLY Orca's slice_info into our package).
  const layers = /^;\s*total layer number:\s*(\d+)\s*$/m.exec(head);
  if (layers) meta.layers = Number(layers[1]);
  const usedG = list(key('filament used \\[g\\]'));
  if (usedG && usedG.every((x) => Number.isFinite(Number(x)))) meta.usedG = usedG.map(Number);
  const usedMm = list(key('filament used \\[mm\\]'));
  if (usedMm && usedMm.every((x) => Number.isFinite(Number(x)))) meta.usedM = usedMm.map((x) => Number(x) / 1000);
  const nvt = list(key('nozzle_volume_type')) || list(key('default_nozzle_volume_type'));
  const NVT = { Standard: 0, 'High Flow': 1 };
  if (nvt && nvt[0] in NVT) meta.nozzleVolumeType = NVT[nvt[0]];
  const tl = key('timelapse_type');
  if (tl && /^\d+$/.test(tl)) meta.timelapseType = tl;
  const t = /^;.*total estimated time:\s*((?:\d+d\s*)?(?:\d+h\s*)?(?:\d+m\s*)?(?:\d+s)?)\s*$/m.exec(head);
  if (t && t[1].trim()) {
    const u = { d: 86400, h: 3600, m: 60, s: 1 };
    let s = 0;
    for (const [, n, k] of t[1].matchAll(/(\d+)([dhms])/g)) s += Number(n) * u[k];
    meta.predictionS = s;
  }
  // Object labels (skip objects, founder 2026-11-13). Orca's and 2bee.fdm's own lines:
  // "; printing object <name> id:<n> copy 0" then "; start printing object, unique label id: <id>".
  // Read from the whole file, first occurrence per id. None found = no objects, never guessed.
  const objects = [];
  let lastName = null;
  for (const m of gcode.matchAll(/^; (?:printing object (.+?) id:\d+ copy \d+|start printing object, unique label id: (\d+))\s*$/gm)) {
    if (m[1] !== undefined) lastName = m[1];
    else if (!objects.some((o) => o.id === Number(m[2]))) objects.push({ id: Number(m[2]), name: lastName ?? `object ${m[2]}` });
  }
  if (objects.length) {
    // The plate picture on the printer card (founder 2026-11-13): each object's footprint, read off
    // THIS file's own extrusion, so the picture is the file that prints and needs no match to a
    // 3D view. An object with no extrusion read gets no outline, never a guessed one.
    const fp = objectFootprints(gcode);
    for (const o of objects) {
      const hull = fp.get(o.id);
      if (hull) o.hull = hull;
    }
    meta.objects = objects.sort((a, b) => a.id - b.id);
    const pa = /^;\s*printable_area\s*=\s*(.*?)\s*$/m.exec(gcode);
    const pts = pa ? pa[1].split(',').map((xy) => xy.split('x').map(Number)) : [];
    if (pts.length >= 3 && pts.every((q) => q.length === 2 && q.every(Number.isFinite))) meta.printableArea = pts;
  }
  return meta;
}

// Verbatim from an OrcaSlicer 2.5.0-dev export (job.gcode.3mf, 2026-10-14).
const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
 <Default Extension="png" ContentType="image/png"/>
 <Default Extension="gcode" ContentType="text/x.gcode"/>
</Types>
`;
// 🔴 The root .rels MUST name the 3D model start part. Until 2026-10-20 it was
// empty, on the reasoning that a G-code-only package has no model. The X2D's
// screen then said "3MF file is invalid" (founder, 2026-10-20): a 3MF without
// its /3D/3dmodel.model start part is not a 3MF. Orca also lists plate PNGs
// here. Its own o1-cube package on the X2D carries no PNGs at all, so they are
// left out: a relationship to a missing part is worse than none.
const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>
`;
// The start part, with Orca's header metadata and NO geometry: the job is the
// G-code, and a mesh written here would be a second, unchecked copy of the part.
// An empty <resources/> and <build/> is valid 3MF core.
const MODEL = `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021">
 <metadata name="Application">BambuStudio-02.08.01.55</metadata>
 <metadata name="BambuStudio:3mfVersion">1</metadata>
 <metadata name="Title">2bee printer-bridge job</metadata>
 <resources>
 </resources>
 <build>
 </build>
</model>
`;
const MODEL_SETTINGS_RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/Metadata/plate_1.gcode" Id="rel-1" Type="http://schemas.bambulab.com/package/2021/gcode"/>
</Relationships>
`;
function modelSettings(meta) {
  const extra = meta.filamentMap
    ? `    <metadata key="filament_map_mode" value="${xml(meta.filamentMapMode || 'Auto For Flush')}"/>\n    <metadata key="filament_maps" value="${meta.filamentMap.join(' ')}"/>\n`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <plate>
    <metadata key="plater_id" value="1"/>
    <metadata key="plater_name" value=""/>
    <metadata key="locked" value="false"/>
${extra}    <metadata key="gcode_file" value="Metadata/plate_1.gcode"/>
  </plate>
</config>
`;
}

/** Orca's filament_sequence.json, written only for the one case seen in an Orca export: one filament. */
function filamentSequence(meta) {
  if (!meta.filamentMap || meta.filamentMap.length !== 1) return null;
  const n = meta.filamentMap[0] - 1;
  return JSON.stringify({ plate_1: { nozzle_sequence: [n], optimal_assignment: [n], sequence: [1] } });
}

function plateJson(meta) {
  const j = { bbox_objects: [], filament_ids: [], first_extruder: 0, is_seq_print: false, version: 2 };
  if (meta.filamentColours) {
    j.filament_colors = meta.filamentColours;
    j.filament_ids = meta.filamentColours.map((_, i) => i);
  }
  if (meta.nozzleDiameters) j.nozzle_diameter = meta.nozzleDiameters[0];
  // An exact plate name from the G-code, through the same table the start command uses
  // ("Textured PEI Plate" -> "textured_plate", as Orca wrote for the same plate).
  if (meta.bedType) j.bed_type = meta.bedType;
  return JSON.stringify(j);
}

/**
 * slice_info.config in OrcaSlicer's field set and order. 🔴 THE X2D REJECTS A
 * SHORTER ONE ("3MF file is invalid", HMS 0500-4046). Proven 2026-10-20 at the
 * printer: our package failed. The same package with ONLY Orca's slice_info
 * swapped in started (stopped at once). Every value comes from the G-code's own
 * header/config, or is Orca's constant for a field we do not use (timelapse 0,
 * no filament switcher). A value the G-code does not state is left out.
 */
function sliceInfo(meta) {
  const md = [['index', '1']];
  if (meta.extruderTypes) md.push(['extruder_type', meta.extruderTypes.join(' ')]);
  if (meta.nozzleVolumeType !== undefined) md.push(['nozzle_volume_type', String(meta.nozzleVolumeType)]);
  md.push(['printer_model_id', '']);
  if (meta.nozzleDiameters) md.push(['nozzle_diameters', meta.nozzleDiameters.join(',')]);
  md.push(['timelapse_type', meta.timelapseType ?? '0']);
  if (meta.predictionS !== undefined) md.push(['prediction', String(meta.predictionS)]);
  if (meta.usedG) md.push(['weight', meta.usedG.reduce((x, y) => x + y, 0).toFixed(2)]);
  md.push(['first_layer_time', '0.000000'], ['outside', 'false'], ['support_used', 'false'], ['label_object_enabled', meta.objects ? 'true' : 'false'],
    ['enable_filament_dynamic_map', 'false'], ['has_filament_switcher', 'false']);
  if (meta.filamentMap) md.push(['filament_maps', meta.filamentMap.join(' ')], ['limit_filament_maps', '0']);
  const lines = md.map(([k, v]) => `    <metadata key="${xml(k)}" value="${xml(v)}"/>`);
  // One <object> per label, after the metadata, as Orca writes them for a multi-object plate
  // (read 2026-11-13 from ~/build/web-slicer/test/fixtures/now-printing.gcode.3mf). Orca's
  // single-object X2D package (pnp_blinds, printed) has label_object_enabled true and no line.
  if (meta.objects && meta.objects.length > 1) {
    for (const o of meta.objects) lines.push(`    <object identify_id="${o.id}" name="${xml(o.name)}" skipped="false" />`);
  }
  const n = Math.max(meta.filamentTypes?.length || 0, meta.filamentColours?.length || 0);
  for (let i = 0; i < n; i++) {
    const attrs = [`id="${i + 1}"`];
    if (meta.filamentIds?.[i]) attrs.push(`tray_info_idx="${xml(meta.filamentIds[i])}"`);
    if (meta.filamentTypes?.[i]) attrs.push(`type="${xml(meta.filamentTypes[i])}"`);
    if (meta.filamentColours?.[i]) attrs.push(`color="${xml(meta.filamentColours[i])}"`);
    if (meta.usedM?.[i] !== undefined) attrs.push(`used_m="${meta.usedM[i].toFixed(2)}"`);
    if (meta.usedG?.[i] !== undefined) attrs.push(`used_g="${meta.usedG[i].toFixed(2)}"`);
    const ext = meta.filamentMap?.[i];
    if (ext && meta.nozzleDiameters?.[ext - 1] !== undefined) {
      attrs.push(`group_id="${ext - 1}"`, `nozzle_diameter="${meta.nozzleDiameters[ext - 1].toFixed(2)}"`, 'volume_type="Standard"', 'used_for_object="true"', 'used_for_support="false"');
    }
    lines.push(`    <filament ${attrs.join(' ')}/>`);
  }
  for (const e of [...new Set(meta.filamentMap || [])].sort()) {
    const d = meta.nozzleDiameters?.[e - 1];
    if (d !== undefined) lines.push(`    <nozzle id="${e - 1}" extruder_id="${e}" nozzle_diameter="${d}" volume_type="Standard"/>`);
  }
  // Which filament on which layers. Stated only for one filament over every layer;
  // a multi-filament layer map is not in the G-code header and is not guessed.
  if (n === 1 && meta.layers) {
    lines.push('    <layer_filament_lists>', `      <layer_filament_list filament_list="0" layer_ranges="0 ${meta.layers - 1}" />`, '    </layer_filament_lists>');
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <header>
    <header_item key="X-BBL-Client-Type" value="slicer"/>
    <header_item key="X-BBL-Client-Version" value="02.08.01.55"/>
  </header>
  <plate>
${lines.join('\n')}
  </plate>
</config>
`;
}

/** The entry list, in the order OrcaSlicer writes the same entries. */
export const ENTRY_NAMES = Object.freeze([
  '[Content_Types].xml',
  'Metadata/plate_1.json',
  '3D/3dmodel.model',
  'Metadata/plate_1.gcode.md5',
  'Metadata/plate_1.gcode',
  'Metadata/_rels/model_settings.config.rels',
  'Metadata/model_settings.config',
  'Metadata/slice_info.config',
  '_rels/.rels',
]);

/** MD5 of the G-code bytes, upper-case hex — the case OrcaSlicer writes. */
export const gcodeMd5 = (buf) => createHash('md5').update(buf).digest('hex').toUpperCase();

/**
 * The filament type per filament, in the G-code's own filament order, from its
 * `; filament_type = A;B` line, searched over the WHOLE text (Orca writes its
 * CONFIG_BLOCK at the end of the file, past gcodeMeta's 4 MB head). This is what
 * the file was sliced for, and the only filament fact a start is checked
 * against (START-STALE). null = the file does not say.
 */
export function gcodeFilamentTypes(gcode) {
  const m = /^;[ \t]*filament_type[ \t]*=[ \t]*(.*?)[ \t]*$/m.exec(gcode);
  if (!m) return null;
  const v = m[1].split(/[;,]/).map((x) => x.trim()).filter(Boolean);
  return v.length ? v : null;
}

const sameTypes = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => String(x).toUpperCase() === String(b[i]).toUpperCase());
const validMapping = (m) => Array.isArray(m) && m.length > 0 && m.every((n) => Number.isInteger(n) && n >= 0 && (n <= 15 || n === 254));

/**
 * G-code text -> a .gcode.3mf (a ZIP, DEFLATE, no ZIP64). Deterministic:
 * fixed DOS timestamp, so the same G-code always yields the same bytes.
 */
export function buildGcode3mf(gcode) {
  const g = Buffer.from(gcode, 'utf8');
  const md5 = gcodeMd5(g);
  const meta = gcodeMeta(gcode);
  const content = {
    '[Content_Types].xml': CONTENT_TYPES,
    '3D/3dmodel.model': MODEL,
    'Metadata/plate_1.json': plateJson(meta),
    'Metadata/plate_1.gcode.md5': md5,
    'Metadata/plate_1.gcode': g,
    'Metadata/_rels/model_settings.config.rels': MODEL_SETTINGS_RELS,
    'Metadata/model_settings.config': modelSettings(meta),
    'Metadata/slice_info.config': sliceInfo(meta),
    '_rels/.rels': ROOT_RELS,
  };
  const names = [...ENTRY_NAMES];
  const seq = filamentSequence(meta);
  if (seq) {
    content['Metadata/filament_sequence.json'] = seq;
    names.splice(names.indexOf('Metadata/model_settings.config'), 0, 'Metadata/filament_sequence.json');
  }
  return { zip: zipStore(names.map((n) => [n, Buffer.from(content[n])])), md5 };
}

const DOS_TIME = 0; // 00:00:00
const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01

function zipStore(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const comp = deflateRawSync(data, { level: 6 });
    const crc = crc32(data) >>> 0;
    if (data.length >= 0xffffffff || comp.length >= 0xffffffff || offset >= 0xffffffff) {
      throw new Error('job too large for a non-ZIP64 archive');
    }
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4); // version needed
    lh.writeUInt16LE(0, 6); // flags
    lh.writeUInt16LE(8, 8); // DEFLATE
    lh.writeUInt16LE(DOS_TIME, 10);
    lh.writeUInt16LE(DOS_DATE, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, nameBuf, comp);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4); // version made by
    ch.writeUInt16LE(20, 6); // version needed
    ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(DOS_TIME, 12);
    ch.writeUInt16LE(DOS_DATE, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    // extra len, comment len, disk start, internal attrs, external attrs = 0
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

/* ─────────────────────────────── FTPS client ─────────────────────────────── */

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * TLS options for a connection to `host`. The printer's certificate is
 * self-signed, so verification is relaxed — for the ONE configured printer IP
 * and nothing else. If a pin was given, the peer certificate must match it
 * (checked in FtpsClient before USER/PASS are sent).
 */
export function tlsOptionsFor(host, printerIp) {
  const o = { host, minVersion: 'TLSv1.2' };
  if (host === printerIp) o.rejectUnauthorized = false;
  return o;
}

/**
 * A minimal implicit-FTPS client: TLS from the first byte on the control
 * port, PROT P data channel that REUSES the control TLS session (vsftpd-style
 * servers refuse a data connection that does not). Only FTP_VERBS can be sent.
 */
export class FtpsClient {
  constructor({ host, port, printerIp, certSha256 = null, timeoutMs = 30000 }) {
    this.host = host;
    this.port = port;
    this.printerIp = printerIp;
    this.certSha256 = certSha256;
    this.timeoutMs = timeoutMs;
    this.sock = null;
    this.session = null;
    this.buf = '';
    this.lines = [];
    this.waiter = null;
    this.closed = false;
    this.error = null;
  }

  _tls(port) {
    return new Promise((resolve, reject) => {
      const s = tls.connect({ ...tlsOptionsFor(this.host, this.printerIp), port, ...(this.session ? { session: this.session } : {}) });
      const t = setTimeout(() => { s.destroy(); reject(new Error(`TLS connect to port ${port} timed out`)); }, this.timeoutMs);
      s.once('secureConnect', () => {
        clearTimeout(t);
        // A RESUMED handshake (the data channel reuses the control session) carries no certificate, so
        // getPeerCertificate() is empty there. Resumption itself proves the server holds the secret of the
        // control handshake, and this.session is only ever taken from a control socket that passed the pin.
        // Found on the X2D 2026-11-12: every pinned upload failed with "fingerprint (none)".
        if (this.certSha256 && !(this.session && s.isSessionReused())) {
          const fp = String(s.getPeerCertificate().fingerprint256 || '').replace(/:/g, '').toUpperCase();
          if (fp !== this.certSha256) {
            s.destroy();
            return reject(new Error(`printer certificate fingerprint ${fp || '(none)'} does not match --printer-cert-sha256`));
          }
        }
        resolve(s);
      });
      s.once('error', (e) => { clearTimeout(t); reject(e); });
    });
  }

  async connect() {
    this.sock = await this._tls(this.port);
    this.sock.setEncoding('utf8');
    this.sock.on('session', (sess) => { this.session = sess; });
    this.sock.on('data', (d) => this._data(d));
    this.sock.on('error', (e) => { this.error = e; this._wake(); });
    this.sock.on('close', () => { this.closed = true; this._wake(); });
    const greet = await this._reply();
    if (greet.code !== 220) throw new Error(`greeting -> ${greet.text}`);
  }

  _data(d) {
    this.buf += d;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      this.lines.push(this.buf.slice(0, i).replace(/\r$/, ''));
      this.buf = this.buf.slice(i + 1);
    }
    this._wake();
  }

  _wake() {
    if (this.waiter) { const w = this.waiter; this.waiter = null; w(); }
  }

  /** One complete reply (multi-line `123-` ... `123 ` handled). */
  async _reply() {
    const deadline = Date.now() + this.timeoutMs;
    let first = null;
    const text = [];
    for (;;) {
      while (this.lines.length) {
        const l = this.lines.shift();
        text.push(l);
        if (!first) {
          const m = /^(\d{3})([ -])/.exec(l);
          if (!m) throw new Error(`malformed FTP reply: ${l.slice(0, 120)}`);
          first = m[1];
          if (m[2] === ' ') return { code: Number(first), text: text.join(' | ') };
        } else if (l.startsWith(first + ' ')) {
          return { code: Number(first), text: text.join(' | ') };
        }
      }
      if (this.error) throw this.error;
      if (this.closed) throw new Error('printer closed the control connection');
      const left = deadline - Date.now();
      if (left <= 0) throw new Error('printer did not reply in time');
      await new Promise((r) => {
        const t = setTimeout(r, left);
        this.waiter = () => { clearTimeout(t); r(); };
      });
    }
  }

  /** Send one command. Refuses any verb outside FTP_VERBS, and any CR/LF. */
  async cmd(verb, arg) {
    if (!FTP_VERBS.includes(verb)) throw new Error(`refusing FTP verb ${verb}: this client uploads and checks size, nothing else`);
    if (arg !== undefined && /[\r\n\0]/.test(arg)) throw new Error(`refusing ${verb}: argument contains a line break`);
    this.sock.write(arg === undefined ? `${verb}\r\n` : `${verb} ${arg}\r\n`);
    return this._reply();
  }

  /** cmd() that requires one of `ok`; errors name the VERB, never the argument. */
  async expect(verb, arg, ok) {
    const r = await this.cmd(verb, arg);
    if (!ok.includes(r.code)) throw new Error(`${verb} -> ${r.text}`);
    return r;
  }

  async login(user, password) {
    const u = await this.expect('USER', user, [230, 331]);
    if (u.code === 331) await this.expect('PASS', password, [230]);
    await this.expect('PBSZ', '0', [200]);
    await this.expect('PROT', 'P', [200]);
    await this.expect('TYPE', 'I', [200]);
  }

  /** EPSV first, PASV if refused. The data host is ALWAYS the control host:
   *  a PASV reply naming another address is ignored, never followed. */
  async passivePort() {
    const e = await this.cmd('EPSV');
    if (e.code === 229) {
      const m = /\(\|\|\|(\d+)\|\)/.exec(e.text);
      if (!m) throw new Error(`EPSV -> unparseable reply ${e.text}`);
      return Number(m[1]);
    }
    const p = await this.expect('PASV', undefined, [227]);
    const m = /(\d+),(\d+),(\d+),(\d+),(\d+),(\d+)/.exec(p.text);
    if (!m) throw new Error(`PASV -> unparseable reply ${p.text}`);
    return Number(m[5]) * 256 + Number(m[6]);
  }

  async stor(remote, data) {
    const port = await this.passivePort();
    this.session = this.session || this.sock.getSession();
    const dataSockP = this._tls(port);
    dataSockP.catch(() => {}); // handled below
    const pre = await this.cmd('STOR', remote);
    if (pre.code !== 125 && pre.code !== 150) {
      dataSockP.then((s) => s.destroy(), () => {});
      throw new Error(`STOR -> ${pre.text}`);
    }
    const ds = await dataSockP;
    this.dataSock = ds;
    await new Promise((resolve, reject) => {
      ds.once('error', reject);
      ds.once('close', resolve);
      ds.end(data);
    });
    const done = await this._reply();
    if (done.code !== 226 && done.code !== 250) throw new Error(`STOR (completion) -> ${done.text}`);
  }

  async size(remote) {
    const r = await this.cmd('SIZE', remote);
    if (r.code !== 213) return { size: null, text: r.text };
    const n = Number(r.text.replace(/^213\s+/, '').split(' | ')[0]);
    return { size: Number.isFinite(n) ? n : null, text: r.text };
  }

  async quit() {
    try {
      if (this.sock && !this.closed) await Promise.race([this.cmd('QUIT'), new Promise((r) => setTimeout(r, 2000))]);
    } catch { /* closing anyway */ }
    this.close();
  }

  close() {
    if (this.dataSock) this.dataSock.destroy();
    if (this.sock) this.sock.destroy();
  }
}

/** Upload one built package. Throws Error with the code already redacted.
 *  🔴 `signal` aborts it: the route's 504 used to leave this client RUNNING (control + data sockets, no timeout on the
 *  data socket's end), so the queue moved on and the next upload ran beside a stalled session to the same printer
 *  (2026-11-14). Aborting closes both sockets. */
export async function uploadToPrinter({ printerIp, printerPort, certSha256, code, remote, zip, timeoutMs, signal }) {
  const c = new FtpsClient({ host: printerIp, port: printerPort, printerIp, certSha256, timeoutMs });
  const onAbort = () => c.close();
  if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); }
  try {
    await c.connect();
    await c.login(FTP_USER, code);
    await c.stor(remote, zip);
    const s = await c.size(remote);
    await c.quit();
    return { remoteBytes: s.size, sizeReply: s.text };
  } catch (e) {
    c.close();
    throw new Error(redact(String(e && e.message), code));
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

export function redact(text, code) {
  return code ? String(text).split(code).join('***') : String(text);
}

/** TCP connect to the printer's FTPS port. No TLS, no login, nothing sent. */
export function tcpReachable(host, port, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

/* ─────────────────────────────── MQTT ─────────────────────────────── */
//
// 🔴 THE PRINT COMMAND CHANNEL (founder 2026-10-20: "add remote start", then
// "remote pause, remote stop"). It supersedes the 2026-10-14 "Upload only" ruling.
// The command format is the documented Bambu LAN one. It was run on THIS X2D
// on 2026-10-14 by pnp's prototype: `project_file` with `url: ftp:///<file>`.
// It was accepted the first time (PREPARE/RUNNING). Pause, resume and stop are
// the documented one-word commands. On this X2D they had NOT been run when this
// was written.
//
// No print command is trusted on its own: each command reads the printer's
// state before it acts, and the bridge reports the state the printer gives
// AFTER the command. A command the printer did not act on is an error, not a success.

export const DEFAULT_MQTT_PORT = 8883;
export const DEFAULT_CAMERA_PORT = 322; // Bambu LAN live view, RTSPS

/* ─────────────────────────────── camera ─────────────────────────────── */
//
// The X2D's live view (founder 2026-10-20: "can I see the video stream in 3d?").
// One ffmpeg reads the printer's RTSPS stream ONLY while someone is watching. It
// stops 20 s after the last frame request. It writes ~2 JPEG frames a second to
// stdout. The bridge keeps the latest frame and serves it on /v1/camera.jpg.
//
// 🔴 THE STREAM URL CARRIES THE ACCESS CODE, so it is NEVER on ffmpeg's command line,
// because any user on the machine can read a process command line. It goes into an
// ffconcat file in a fresh 0700 directory, mode 0600, which is deleted once ffmpeg
// has read it. The tests assert that the code is not in the argv ffmpeg receives.

/** Split a byte stream into JPEG frames (SOI ffd8 ... EOI ffd9). Returns [frames, rest]. */
export function splitJpegs(buf) {
  const frames = [];
  for (;;) {
    const s = buf.indexOf(Buffer.from([0xff, 0xd8]));
    if (s < 0) return [frames, Buffer.alloc(0)];
    const e = buf.indexOf(Buffer.from([0xff, 0xd9]), s + 2);
    if (e < 0) return [frames, buf.subarray(s)];
    frames.push(buf.subarray(s, e + 2));
    buf = buf.subarray(e + 2);
  }
}

export class Camera {
  constructor({ ffmpeg = 'ffmpeg', printerIp, port = DEFAULT_CAMERA_PORT, code, idleMs = 20000, log = () => {} }) {
    Object.assign(this, { ffmpeg, printerIp, port, code, idleMs, log });
    this.proc = null;
    this.frame = null;
    this.frameAt = 0;
    this.lastAsk = 0;
    this.error = '';
    this.waiters = new Set();
  }

  _start() {
    const dir = mkdtempSync(join(os.tmpdir(), 'x2d-cam-')); // 0700
    const file = join(dir, 'stream.ffconcat');
    writeFileSync(file, `ffconcat version 1.0\nfile 'rtsps://bblp:${this.code}@${this.printerIp}:${this.port}/streaming/live/1'\n`, { mode: 0o600 });
    const args = ['-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0',
      '-protocol_whitelist', 'file,rtsp,rtsps,tcp,tls,udp', '-i', file,
      '-vf', 'fps=2,scale=960:-1', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-q:v', '6', '-'];
    const p = spawn(this.ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = p;
    this.error = '';
    const drop = () => rmSync(dir, { recursive: true, force: true });
    this.drop = drop;
    const dropTimer = setTimeout(drop, 8000);
    let buf = Buffer.alloc(0);
    let err = '';
    p.stdout.on('data', (d) => {
      const [frames, rest] = splitJpegs(Buffer.concat([buf, d]));
      buf = rest;
      if (frames.length) {
        this.frame = Buffer.from(frames[frames.length - 1]);
        this.frameAt = Date.now();
        for (const w of [...this.waiters]) w();
      }
      if (Date.now() - this.lastAsk > this.idleMs) p.kill('SIGTERM');
    });
    p.stderr.on('data', (d) => { err = (err + d).slice(-400); });
    const done = (why) => {
      clearTimeout(dropTimer);
      drop();
      if (this.proc === p) this.proc = null;
      if (why) this.error = redact(why, this.code);
      for (const w of [...this.waiters]) w();
    };
    p.on('error', (e) => done(`camera reader could not start: ${e.message}`));
    p.on('exit', (c, sig) => done(sig === 'SIGTERM' ? '' : `camera reader stopped (exit ${c})${err ? `: ${err.trim()}` : ''}`));
  }

  /** The newest frame, at most `freshMs` old, waiting up to `waitMs` for one. */
  async latest(freshMs = 4000, waitMs = 12000) {
    this.lastAsk = Date.now();
    if (!this.proc) this._start();
    const deadline = Date.now() + waitMs;
    while (!(this.frame && Date.now() - this.frameAt <= freshMs)) {
      if (!this.proc && this.error) throw new HttpError(502, this.error);
      const left = deadline - Date.now();
      if (left <= 0) throw new HttpError(504, `no camera frame within ${Math.round(waitMs / 1000)} s${this.error ? `: ${this.error}` : ''}`);
      await new Promise((r) => {
        const t = setTimeout(() => { this.waiters.delete(w); r(); }, left);
        const w = () => { clearTimeout(t); this.waiters.delete(w); r(); };
        this.waiters.add(w);
      });
    }
    return { jpeg: this.frame, ageMs: Date.now() - this.frameAt };
  }

  /** Kill the reader and delete the URL file NOW: a bridge that exits right after
   *  must not leave the file (it holds the access code) for the 8 s timer. */
  stop() {
    if (this.proc) this.proc.kill('SIGTERM');
    if (this.drop) this.drop();
  }
}
/** The only `print.command` values this client can publish. */
export const MQTT_COMMANDS = Object.freeze(['project_file', 'pause', 'resume', 'stop']);
/** States in which a new print may start. */
export const IDLE_STATES = Object.freeze(['IDLE', 'FINISH', 'FAILED']);
/** States in which a print is underway (stop applies). */
export const ACTIVE_STATES = Object.freeze(['PREPARE', 'RUNNING', 'PAUSE', 'SLICING']);

/** The human build-plate name -> Bambu `bed_type`. Unknown -> 'auto' (the printer decides). */
export const BED_TYPES = Object.freeze({
  'Textured PEI Plate': 'textured_plate',
  'Cool Plate': 'cool_plate',
  'Textured Cool Plate': 'cool_plate',
  'Cool Plate (SuperTack)': 'cool_plate',
  'Supertack Plate': 'cool_plate',
  'Engineering Plate': 'eng_plate',
  'High Temp Plate': 'hot_plate',
  'Smooth PEI Plate / High Temp Plate': 'hot_plate',
});

function mqttLen(n) {
  const out = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return Buffer.from(out);
}
const mqttStr = (s) => {
  const b = Buffer.from(String(s), 'utf8');
  const l = Buffer.alloc(2);
  l.writeUInt16BE(b.length, 0);
  return Buffer.concat([l, b]);
};
const mqttPacket = (type, body) => Buffer.concat([Buffer.from([type]), mqttLen(body.length), body]);

/**
 * A minimal MQTT 3.1.1 client over TLS: CONNECT, SUBSCRIBE (QoS 0), PUBLISH
 * (QoS 0), DISCONNECT. Enough for Bambu's `device/<serial>/request|report`
 * topics, and nothing more. Every received `print` report is merged into
 * `this.print`, because the printer sends partial updates after the first full one.
 */
export class MqttClient {
  constructor({ host, port, printerIp, certSha256 = null, serial, timeoutMs = 15000 }) {
    Object.assign(this, { host, port, printerIp, certSha256, serial, timeoutMs });
    this.sock = null;
    this.buf = Buffer.alloc(0);
    this.print = null;
    this.reports = 0;
    this.replies = [];
    this.waiters = new Set();
    this.error = null;
    this.closed = false;
  }

  _wake() {
    for (const w of [...this.waiters]) w();
  }

  async connect(password) {
    this.sock = await new Promise((resolve, reject) => {
      const s = tls.connect({ ...tlsOptionsFor(this.host, this.printerIp), port: this.port });
      const t = setTimeout(() => { s.destroy(); reject(new Error(`TLS connect to MQTT port ${this.port} timed out`)); }, this.timeoutMs);
      s.once('secureConnect', () => {
        clearTimeout(t);
        if (this.certSha256) {
          const fp = String(s.getPeerCertificate().fingerprint256 || '').replace(/:/g, '').toUpperCase();
          if (fp !== this.certSha256) { s.destroy(); return reject(new Error(`printer certificate fingerprint ${fp || '(none)'} does not match --printer-cert-sha256`)); }
        }
        resolve(s);
      });
      s.once('error', (e) => { clearTimeout(t); reject(e); });
    });
    this.sock.on('data', (d) => this._data(d));
    this.sock.on('error', (e) => { this.error = e; this._wake(); });
    this.sock.on('close', () => { this.closed = true; this._wake(); });
    this.connack = null;
    const body = Buffer.concat([
      mqttStr('MQTT'), Buffer.from([4, 0xc2, 0, 60]),
      mqttStr(`2bee-bridge-${randomBytes(4).toString('hex')}`), mqttStr(FTP_USER), mqttStr(password),
    ]);
    this.sock.write(mqttPacket(0x10, body));
    await this._until(() => this.connack !== null, 'the printer did not answer the MQTT login');
    if (this.connack !== 0) throw new Error(`MQTT login refused (CONNACK ${this.connack}${this.connack === 4 || this.connack === 5 ? ': wrong access code' : ''})`);
    this.suback = false;
    this.sock.write(mqttPacket(0x82, Buffer.concat([Buffer.from([0, 1]), mqttStr(`device/${this.serial}/report`), Buffer.from([0])])));
    await this._until(() => this.suback, 'the printer did not confirm the report subscription');
  }

  _data(d) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      if (this.buf.length < 2) return;
      let len = 0;
      let mul = 1;
      let i = 1;
      for (;;) {
        if (i >= this.buf.length) return;
        const b = this.buf[i++];
        len += (b & 0x7f) * mul;
        mul *= 128;
        if (!(b & 0x80)) break;
        if (i > 4) { this.error = new Error('malformed MQTT length'); this.sock.destroy(); return; }
      }
      if (this.buf.length < i + len) return;
      const head = this.buf[0];
      const body = this.buf.subarray(i, i + len);
      this.buf = this.buf.subarray(i + len);
      const type = head >> 4;
      if (type === 2) this.connack = body[1];
      else if (type === 9) this.suback = true;
      else if (type === 3) {
        const tl = body.readUInt16BE(0);
        const qos = (head >> 1) & 3;
        const payload = body.subarray(2 + tl + (qos ? 2 : 0));
        let j;
        try { j = JSON.parse(payload.toString('utf8')); } catch { continue; }
        if (j && j.print && typeof j.print === 'object') {
          // A reply to a command (anything but push_status) is kept APART from the merged state,
          // because the next push_status overwrites `command`/`result`/`reason`. Before
          // 2026-10-20 the printer's own answer to project_file was lost this way.
          if (j.print.command && j.print.command !== 'push_status') this.replies.push(j.print);
          else {
            this.print = { ...(this.print || {}), ...j.print };
            this.reports++;
          }
        }
      }
      this._wake();
    }
  }

  async _until(pred, why, ms = this.timeoutMs) {
    const deadline = Date.now() + ms;
    for (;;) {
      if (pred()) return;
      if (this.error) throw this.error;
      if (this.closed) throw new Error('printer closed the MQTT connection');
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(why);
      await new Promise((r) => {
        const t = setTimeout(() => { this.waiters.delete(w); r(); }, left);
        const w = () => { clearTimeout(t); this.waiters.delete(w); r(); };
        this.waiters.add(w);
      });
    }
  }

  publish(obj) {
    const cmd = obj && obj.print ? obj.print.command : obj && obj.pushing ? 'pushall' : null;
    // The chamber light (founder 2026-10-20: "Able to turn off/on the lights"). ONE system
    // command, ONE node, on or off. No other `system` command can be published.
    const light = obj && obj.system && obj.system.command === 'ledctrl' && obj.system.led_node === 'chamber_light'
      && ['on', 'off'].includes(obj.system.led_mode) && Object.keys(obj).length === 1;
    if (light) {
      this.sock.write(mqttPacket(0x30, Buffer.concat([mqttStr(`device/${this.serial}/request`), Buffer.from(JSON.stringify(obj), 'utf8')])));
      return;
    }
    // One fan, one speed (founder 2026-11-13: "able to change the fan options"). Exactly the
    // shape fanCommand builds; any other key, fan or speed is refused here, in the shared callee.
    const one = Object.keys(obj).length === 1;
    const fan = one && ((cmd === 'set_fan' && fanCommandValid(obj.print)) || (cmd === 'set_airduct' && fanModeCommandValid(obj.print))
      || (cmd === 'print_speed' && speedCommandValid(obj.print)) || (cmd === 'skip_objects' && skipCommandValid(obj.print)));
    if (fan) {
      this.sock.write(mqttPacket(0x30, Buffer.concat([mqttStr(`device/${this.serial}/request`), Buffer.from(JSON.stringify(obj), 'utf8')])));
      return;
    }
    if (cmd !== 'pushall' && !MQTT_COMMANDS.includes(cmd)) throw new Error(`refusing MQTT command ${cmd}: this client starts, pauses, resumes and stops a print, nothing else`);
    this.sock.write(mqttPacket(0x30, Buffer.concat([mqttStr(`device/${this.serial}/request`), Buffer.from(JSON.stringify(obj), 'utf8')])));
  }

  /** Ask for a full report and wait for one that carries `gcode_state`. */
  async refresh() {
    const n = this.reports;
    this.publish({ pushing: { sequence_id: '0', command: 'pushall', version: 1, push_target: 1 } });
    await this._until(() => this.reports > n && this.print && 'gcode_state' in this.print, 'the printer did not report its state');
    return this.print;
  }

  /** Wait until `pred(print)` holds, asking for a report every 2 s. */
  async waitFor(pred, ms, why) {
    const deadline = Date.now() + ms;
    for (;;) {
      if (this.print && pred(this.print)) return this.print;
      const left = deadline - Date.now();
      if (left <= 0) throw new HttpError(504, `${why} (state ${this.print?.gcode_state ?? 'unknown'})`);
      const n = this.reports;
      try { this.publish({ pushing: { sequence_id: '0', command: 'pushall', version: 1, push_target: 1 } }); } catch { /* closed: _until throws */ }
      await this._until(() => this.reports > n, why, Math.min(2000, left)).catch((e) => {
        if (this.error || this.closed) throw e;
      });
    }
  }

  close() {
    if (this.sock && !this.closed) {
      try { this.sock.end(Buffer.from([0xe0, 0])); } catch { /* closing anyway */ }
      this.sock.destroy();
    }
  }
}

/** Bambu's tray_color "RRGGBBAA" as "#rrggbb"; null when absent or not hex (never guessed). */
export function trayColor(c) {
  const m = /^([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(String(c ?? ''));
  return m ? `#${m[1].toLowerCase()}` : null;
}

/** Slot list read from the printer's AMS report, in the app's slot ids. */
export function slotsFromReport(p) {
  const out = [];
  for (const u of (p && p.ams && p.ams.ams) || []) {
    for (const t of u.tray || []) out.push({ id: `ams${Number(u.id) + 1}-${Number(t.id) + 1}`, index: Number(u.id) * 4 + Number(t.id), type: t.tray_type || '', color: trayColor(t.tray_color) });
  }
  const ext = p && (p.vt_tray || (Array.isArray(p.vir_slot) ? p.vir_slot[0] : null));
  if (ext) out.push({ id: 'ext', index: 254, type: ext.tray_type || '', color: trayColor(ext.tray_color) });
  return out;
}

/* Fans. The X2D reports its fans in `device.airduct` (Bambu's newer protocol) and takes
 * `set_fan {fan_index, speed}` with speed 0-100 in steps of 10. Source: Bambu Studio
 * src/slic3r/GUI/DeviceCore/DevFan.cpp (ParseV3_0, command_control_fan_new) and
 * Widgets/FanControl.cpp (new protocol when the report has cfg/fun/aux/stat and an airduct,
 * which this X2D's report has, read 2026-11-13). Part id: bits 4-11 of `id` = the fan index,
 * bits 0-7 of `state` = percent. Names: resources/printers/N6.json (the X2D) `fan`, by mode;
 * Bambu Studio's own defaults where N6.json names none.
 * The fan MODE (Strong Cooling / Heating: set_airduct) is sent by /v1/fanmode only (founder
 * 2026-11-13 "add all"; this line said "NOT sent" until 2026-11-14). It moves the duct doors, and
 * only fans the current mode lists in `ctrl` are settable; the rest the printer runs itself. */
export const FAN_INDEXES = Object.freeze([1, 2, 3, 10]);
const FAN_MODE_NAMES = { 0: 'Strong Cooling', 1: 'Heating' };
const FAN_NAMES = {
  0: { 1: 'Parts', 2: 'Left (Aux)', 3: 'Exhaust', 10: 'Right (Aux)' },
  1: { 1: 'Parts', 2: 'Left (Heating)', 3: 'Exhaust', 10: 'Right (Filter)' },
};
const fanIndex = (id) => (Number(id) >> 4) & 0xff;

export function fanCommandValid(p) {
  return !!p && Object.keys(p).sort().join(',') === 'command,fan_index,sequence_id,speed'
    && p.command === 'set_fan' && typeof p.sequence_id === 'string'
    && FAN_INDEXES.includes(p.fan_index) && Number.isInteger(p.speed) && p.speed >= 0 && p.speed <= 100 && p.speed % 10 === 0;
}

export function fanCommand(id, percent) {
  if (!FAN_INDEXES.includes(id)) throw new HttpError(400, `fan id must be one of ${FAN_INDEXES.join(', ')}`);
  if (!Number.isInteger(percent) || percent < 0 || percent > 100 || percent % 10) throw new HttpError(400, 'percent must be 0-100 in steps of 10');
  return { print: { sequence_id: '0', command: 'set_fan', fan_index: id, speed: percent } };
}

/** The fans the printer reports, by name. null when the report has no airduct (not guessed from the old fields). */
export function fansFromReport(p) {
  const d = p && p.device && p.device.airduct;
  if (!d || !Array.isArray(d.parts)) return null;
  const mode = Number(d.modeCur);
  const m = Array.isArray(d.modeList) ? d.modeList.find((x) => Number(x.modeId) === mode) : null;
  const ctrl = new Set((m?.ctrl ?? []).map(fanIndex));
  const off = new Set((m?.off ?? []).map(fanIndex));
  return {
    mode: FAN_MODE_NAMES[mode] ?? `mode ${mode}`,
    fans: d.parts.map((x) => {
      const id = fanIndex(x.id);
      return { id, name: FAN_NAMES[mode]?.[id] ?? `Fan ${id}`, percent: num(x.state) == null ? null : Number(x.state) & 0xff, control: off.has(id) ? 'off' : ctrl.has(id) ? 'set' : 'auto' };
    }),
  };
}

/* Fan mode (set_airduct {modeId, submode:-1}, Bambu Studio DevFan.cpp command_control_air_duct). */
export function fanModeCommandValid(p) {
  return !!p && Object.keys(p).sort().join(',') === 'command,modeId,sequence_id,submode'
    && p.command === 'set_airduct' && typeof p.sequence_id === 'string' && Number.isInteger(p.modeId) && p.modeId >= 0 && p.modeId <= 15 && p.submode === -1;
}

/* Print speed (print_speed {param:"1".."4"}, Bambu Studio DeviceManager.cpp command_set_printing_speed).
 * Names as Bambu's own screens give them. */
export const SPEED_LEVELS = Object.freeze({ 1: 'Silent', 2: 'Standard', 3: 'Sport', 4: 'Ludicrous' });
export function speedCommandValid(p) {
  return !!p && Object.keys(p).sort().join(',') === 'command,param,sequence_id'
    && p.command === 'print_speed' && typeof p.sequence_id === 'string' && ['1', '2', '3', '4'].includes(p.param);
}

/* Skip objects (skip_objects {obj_list:[label ids]}, DeviceManager.cpp command_task_partskip). */
export function skipCommandValid(p) {
  return !!p && Object.keys(p).sort().join(',') === 'command,obj_list,sequence_id'
    && p.command === 'skip_objects' && typeof p.sequence_id === 'string' && Array.isArray(p.obj_list) && p.obj_list.length > 0
    && p.obj_list.every((n) => Number.isInteger(n) && n >= 0);
}

/* What the printer is doing (stg_cur): Bambu Studio DeviceManager.cpp get_stage_string, 0-77.
 * A number outside the table is shown as its number, never guessed. */
export const STAGES = Object.freeze(["Printing", "Auto bed leveling", "Heatbed preheating", "Vibration compensation", "Changing filament", "M400 pause", "Paused (filament ran out)", "Heating nozzle", "Calibrating dynamic flow", "Scanning bed surface", "Inspecting first layer", "Identifying build plate type", "Calibrating Micro Lidar", "Homing toolhead", "Cleaning nozzle tip", "Checking extruder temperature", "Paused by the user", "Pause (front cover fall off)", "Calibrating the micro lidar", "Calibrating flow ratio", "Pause (nozzle temperature malfunction)", "Pause (heatbed temperature malfunction)", "Filament unloading", "Pause (step loss)", "Filament loading", "Motor noise cancellation", "Pause (AMS offline)", "Pause (low speed of the heatbreak fan)", "Pause (chamber temperature control problem)", "Cooling chamber", "Pause (Gcode inserted by user)", "Motor noise showoff", "Pause (nozzle clumping)", "Pause (cutter error)", "Pause (first layer error)", "Pause (nozzle clog)", "Measuring motion precision", "Enhancing motion precision", "Measure motion accuracy", "Nozzle offset calibration", "high temperature auto bed levelling", "Auto Check: Quick Release Lever", "Auto Check: Door and Upper Cover", "Laser Calibration", "Auto Check: Platform", "Confirming BirdsEye Camera location", "Calibrating BirdsEye Camera", "Auto bed leveling -phase 1", "Auto bed leveling -phase 2", "Heating chamber", "Adjusting heatbed temperature", "Printing calibration lines", "Auto Check: Material", "Live View Camera Calibration", "Waiting for heatbed to reach target temperature", "Auto Check: Material Position", "Cutting Module Offset Calibration", "Measuring Surface", "Thermal Preconditioning for first layer optimization", "Homing Blade Holder", "Calibrating Camera Offset", "Calibrating Blade Holder Position", "Hotend Pick and Place Test", "Waiting for the Chamber temperature to equalize", "Preparing Hotend", "Calibrating the detection position of nozzle clumping", "Purifying the chamber air", "Measuring Rotary Attachment", "The toolhead moves above the purge chute", "Cooling down the nozzle", "The toolhead moves to the center of the heatbed", "Active Arc Fitting", "Hotend Type Detection", "Build plate alignment detection", "Heatbed surface foreign object detection", "Heatbed underside foreign object detection", "Pre-extrusion before printing", "Preparing AMS"]);
export function stageFromReport(p) {
  const n = num(p.stg_cur);
  if (n == null || n < 0 || n === 255) return null;
  return { id: n, name: STAGES[n] ?? `stage ${n}` };
}

/* HMS: Bambu's message table for the X2D (serial prefix 20P), hms_en_20P.json.gz beside this
 * file, built from Bambu Studio resources/hms/hms_en_20P.json. Key = attr (8 hex) + code (8 hex),
 * as DevHMS.cpp get_long_error_code. A code the table does not describe is shown as a code. */
let hmsTable;
function hmsTexts() {
  if (hmsTable === undefined) {
    try { hmsTable = JSON.parse(gunzipSync(readFileSync(new URL('./hms_en_20P.json.gz', import.meta.url))).toString('utf8')); } catch { hmsTable = null; }
  }
  return hmsTable;
}
const HMS_LEVELS = { 1: 'fatal', 2: 'serious', 3: 'common', 4: 'info' };
const hex = (n, w) => (Number(n) >>> 0).toString(16).toUpperCase().padStart(w, '0');
export function hmsFromReport(p) {
  if (!Array.isArray(p.hms)) return [];
  return p.hms.filter((h) => Number.isFinite(Number(h?.attr)) && Number.isFinite(Number(h?.code))).map((h) => {
    const key = hex(h.attr, 8) + hex(h.code, 8);
    return { code: key.match(/.{4}/g).join('-'), level: HMS_LEVELS[Number(h.code) >>> 16] ?? 'unknown', text: hmsTexts()?.hms?.[key] || null };
  });
}

/** print_error as Bambu's HMS form: 83902534 -> "0500-4046". */
export function hmsCode(n) {
  const h = Number(n).toString(16).toUpperCase().padStart(8, '0');
  return `${h.slice(0, 4)}-${h.slice(4)}`;
}

const num = (v) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/** The status reply: what the printer said, by name. Absent values are null, never guessed. */
export function statusFromReport(p) {
  return {
    state: String(p.gcode_state ?? ''),
    task: String(p.subtask_name ?? ''),
    percent: num(p.mc_percent),
    layer: num(p.layer_num),
    layers: num(p.total_layer_num),
    remainMin: num(p.mc_remaining_time),
    nozzle: num(p.nozzle_temper),
    nozzleTarget: num(p.nozzle_target_temper),
    bed: num(p.bed_temper),
    bedTarget: num(p.bed_target_temper),
    error: num(p.print_error) ?? 0,
    errorCode: num(p.print_error) ? hmsCode(p.print_error) : null,
    slots: slotsFromReport(p).map(({ id, type, color }) => ({ id, type, color })),
    light: (Array.isArray(p.lights_report) ? p.lights_report.find((l) => l.node === 'chamber_light')?.mode : null) ?? null,
    fanMode: fansFromReport(p)?.mode ?? null,
    fanModeId: num(p.device?.airduct?.modeCur),
    fanModes: Array.isArray(p.device?.airduct?.modeList) ? p.device.airduct.modeList.map((m) => ({ id: Number(m.modeId), name: FAN_MODE_NAMES[Number(m.modeId)] ?? `mode ${m.modeId}` })) : null,
    fans: fansFromReport(p)?.fans ?? null,
    errorText: num(p.print_error) ? hmsTexts()?.error?.[hex(p.print_error, 8)] || null : null,
    hms: hmsFromReport(p),
    stage: stageFromReport(p),
    speed: num(p.spd_lvl) ? { level: num(p.spd_lvl), name: SPEED_LEVELS[num(p.spd_lvl)] ?? `level ${p.spd_lvl}` } : null,
    skipped: Array.isArray(p.s_obj) ? p.s_obj.map(Number) : [],
  };
}

/** The `project_file` command. `amsMapping[n]` = the tray that feeds filament n+1 (254 = external spool). */
export function startCommand({ remote, bedType, amsMapping, fileMd5 }) {
  if (!/^[\w-]+\.gcode\.3mf$/.test(remote)) throw new HttpError(400, 'remote must be a file name this bridge uploaded (<name>.gcode.3mf)');
  if (!/^[0-9a-f]{32}$/.test(String(fileMd5))) throw new HttpError(500, 'no MD5 recorded for the uploaded file');
  if (!Array.isArray(amsMapping) || !amsMapping.length || amsMapping.some((n) => !Number.isInteger(n) || n < 0 || (n > 15 && n !== 254))) {
    throw new HttpError(400, 'amsMapping must be a non-empty list of tray indexes (0-15, or 254 for the external spool)');
  }
  return {
    print: {
      sequence_id: '0', command: 'project_file', param: 'Metadata/plate_1.gcode',
      project_id: '0', profile_id: '0', task_id: '0', subtask_id: '0',
      subtask_name: remote.replace(/\.gcode\.3mf$/, ''), file: '', url: `ftp:///${remote}`,
      // The MD5 of the uploaded .gcode.3mf FILE, lowercase hex, as pnp's prototype sent on the
      // start that worked on this X2D (2026-10-14). 🔴 It was sent EMPTY until 2026-10-20 and the
      // X2D answered FAILED with print_error 0x05004046 (HMS 0500-4046) on both tries.
      md5: fileMd5,
      timelapse: false, bed_type: BED_TYPES[bedType] || 'auto', bed_leveling: true, flow_cali: true,
      vibration_cali: false, layer_inspect: false,
      use_ams: amsMapping.some((n) => n !== 254), ams_mapping: amsMapping,
    },
  };
}

/** One MQTT session: connect, read the state, run `fn`, always close. Errors are redacted. */
export async function withPrinter({ printerIp, mqttPort, certSha256, code, serial, timeoutMs }, fn) {
  const c = new MqttClient({ host: printerIp, port: mqttPort, printerIp, certSha256, serial, timeoutMs });
  try {
    await c.connect(code);
    const p = await c.refresh();
    return await fn(c, p);
  } catch (e) {
    if (e instanceof HttpError) throw new HttpError(e.status, redact(e.message, code));
    throw new HttpError(502, `printer: ${redact(String(e && e.message), code)}`);
  } finally {
    c.close();
  }
}

/* ─────────────────────────────── server ─────────────────────────────── */

const digest = (s) => createHash('sha256').update(s).digest();
function tokenMatches(header, token) {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header || '');
  if (!m) return false;
  return timingSafeEqual(digest(m[1]), digest(token));
}

export function createBridge(opts) {
  const {
    token,
    code = null,
    printer,
    printerPort = DEFAULT_PRINTER_PORT,
    certSha256 = null,
    origins = DEFAULT_ORIGINS,
    timeoutS = DEFAULT_TIMEOUT_S,
    maxBody = DEFAULT_MAX_BODY,
    serial = null,
    mqttPort = DEFAULT_MQTT_PORT,
    ffmpeg = 'ffmpeg',
    cameraPort = DEFAULT_CAMERA_PORT,
    /** () => { listening, error, seen: SeenPrinters } from ssdp.mjs listenBambu, or null (no discovery). */
    discovery = null,
    log = (line) => process.stdout.write(line + '\n'),
  } = opts;
  if (!token) throw new Error('createBridge needs a token');
  if (!printer) throw new Error('createBridge needs a printer IP');
  const allowed = new Set(origins.map((o) => o.replace(/\/+$/, '')));

  // One upload at a time. A chain of promises; `pending` bounds the backlog.
  let chain = Promise.resolve();
  let pending = 0;
  /** Files THIS run uploaded and saw at full size on the printer. Only these may be started.
   *  remote -> { md5: of the uploaded FILE, gcodeMd5: of plate_1.gcode, types: the G-code's own filament_type list
   *  (or null), amsMapping: the tray per filament the page uploaded it for (or null) }. A start must ask for
   *  exactly these (START-STALE). */
  const uploaded = new Map();
  const camera = new Camera({ ffmpeg, printerIp: printer, port: cameraPort, code });
  /** One printer command at a time: two Starts racing would both read IDLE. */
  let printerBusy = false;
  // 🔴 Pause and Stop WAIT for the running command instead of being refused (2026-11-14). The
  // lock is shared with the page's 5 s status read, so a Stop clicked during one got 429
  // "another printer command is running", nothing was sent and the print went on. The safe
  // direction queues here (FIFO, bounded); the lock is HANDED to the next waiter, so a status
  // read arriving meanwhile cannot take it first.
  let busyWaiters = [];
  const SAFE_WAIT_MS = 60000;
  const releasePrinter = () => {
    const next = busyWaiters.shift();
    if (next) next();
    else printerBusy = false;
  };

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
      const data = redact(JSON.stringify(body), code);
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(data),
        'Cache-Control': 'no-store',
        ...cors,
        ...extra,
      });
      res.end(data);
    };
    const fail = (status, message, extra, more = {}) =>
      send(status, { ok: false, started: false, ...more, error: { message, type: 'printer_bridge_error', code: status } }, extra);

    // DNS-rebinding guard: the Host must name this loopback listener.
    const host = String(req.headers.host || '').toLowerCase();
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) {
      return fail(403, 'Host header is not a loopback address');
    }
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

    // Discovery (founder 2026-11-19): the ONE route without a token. It says what this is and
    // nothing else — never the printer address, serial or access code — so the page can put this
    // address in the right row. Host guard and Origin allowlist above still apply.
    if (req.method === 'GET' && path === '/v1/hello') {
      return send(200, { ok: true, bridge: '2bee.printer-bridge', api: 1, needsToken: true, peers: registryPeers() });
    }

    const ROUTES = { '/v1/upload': 'upload', '/v1/check': 'check', '/v1/status': 'status', '/v1/start': 'start', '/v1/pause': 'pause', '/v1/resume': 'resume', '/v1/stop': 'stop', '/v1/camera.jpg': 'camera', '/v1/light': 'light', '/v1/fan': 'fan', '/v1/fanmode': 'fanmode', '/v1/speed': 'speed', '/v1/skip': 'skip' };
    const route = ROUTES[path] ?? null;
    if (!route) return fail(404, `no route ${path}; this bridge serves POST ${Object.keys(ROUTES).join(', ')}`);
    if (req.method !== 'POST') return fail(405, 'use POST', { Allow: 'POST, OPTIONS' });

    if (!tokenMatches(req.headers.authorization, token)) {
      return fail(401, 'missing or wrong bearer token', { 'WWW-Authenticate': 'Bearer' });
    }

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

      if (route === 'check') {
        const reachable = await tcpReachable(printer, printerPort);
        // Every Bambu printer heard on the LAN (ssdp.mjs). Reported, never acted on: the bridge keeps
        // talking to --printer. `isThisPrinter` compares the announced serial with --serial; the serial
        // itself is not sent, only its last 4 characters, as on the printer's own label.
        const d = discovery ? discovery() : null;
        const seen = d
          ? d.seen.list().map((x) => ({ ip: x.ip, model: x.model, name: x.name, connect: x.connect, serialTail: x.serial.slice(-4), isThisPrinter: !!serial && x.serial === serial, ageS: Math.round((Date.now() - x.at) / 1000) }))
          : null;
        const discoveryState = !d ? 'off' : d.listening ? 'listening' : `not listening: ${d.error || 'starting'}`;
        return send(200, { reachable, haveCode: !!code, haveSerial: !!serial, printer, seen, discovery: discoveryState });
      }

      if (route === 'camera') {
        if (!code) return fail(409, 'no printer access code: the camera needs it too (--code-file)');
        try {
          const { jpeg, ageMs } = await camera.latest();
          if (res.headersSent || res.destroyed) return;
          res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': jpeg.length, 'Cache-Control': 'no-store', 'X-Frame-Age-Ms': String(ageMs), ...cors });
          return res.end(jpeg);
        } catch (e) {
          return fail(e.status ?? 502, redact(String(e.message), code));
        }
      }
      if (route !== 'upload') return printerCommand(route, chunks, send, fail);

      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return fail(400, 'request body is not JSON; send {"name": "...", "gcode": "..."}');
      }
      if (!body || typeof body !== 'object') return fail(400, 'request body must be a JSON object');
      if (typeof body.gcode !== 'string' || body.gcode.trim() === '') return fail(400, 'gcode must be a non-empty string');
      if (body.gcode.includes('\0')) return fail(400, 'gcode contains a NUL byte; it is not G-code text');
      if (body.name !== undefined && typeof body.name !== 'string') return fail(400, 'name must be a string');
      // What the page uploads this file for: optional as a pair, checked against the G-code's own filament types.
      const hasMap = body.amsMapping !== undefined, hasTypes = body.expectTypes !== undefined;
      if (hasMap !== hasTypes) return fail(400, 'amsMapping and expectTypes go together, or neither');
      if (hasMap && !validMapping(body.amsMapping)) return fail(400, 'amsMapping must be a non-empty list of tray indexes (0-15, or 254 for the external spool)');
      if (hasTypes && (!Array.isArray(body.expectTypes) || body.expectTypes.length !== body.amsMapping.length || body.expectTypes.some((x) => typeof x !== 'string' || !x))) {
        return fail(400, 'expectTypes must be one filament type per amsMapping entry');
      }
      const fileTypes = gcodeFilamentTypes(body.gcode);
      if (hasTypes && fileTypes && !sameTypes(fileTypes, body.expectTypes)) {
        return fail(409, `the G-code was sliced for ${fileTypes.join(', ')}, but the upload says ${body.expectTypes.join(', ')}: slice the plate again`);
      }
      if (!code) return fail(409, 'no printer access code: start the bridge with --code-file <path> or env X2D_ACCESS_CODE');
      if (pending >= MAX_QUEUE) return fail(429, `bridge is busy (${pending} uploads queued)`);

      let built;
      try {
        built = buildGcode3mf(body.gcode);
      } catch (e) {
        return fail(400, e.message);
      }
      const remote = remoteName(body.name, built.md5);
      const bytes = built.zip.length;

      // A client that goes away does NOT abort an upload in flight: a
      // half-written file on the printer is worse than a finished one nobody saw.
      pending++;
      const job = chain.then(async () => {
        let timer;
        const ac = new AbortController();
        // 🔴 FORGET THIS NAME BEFORE OVERWRITING IT. The record of the previous
        // upload survived a re-upload that failed (size mismatch, STOR error), so
        // /v1/start started a file the bridge had just reported as NOT
        // size-confirmed — possibly truncated. With the record gone from here,
        // a start during the overwrite is refused too. It comes back only below,
        // after the printer has confirmed the size.
        uploaded.delete(remote);
        try {
          const r = await Promise.race([
            uploadToPrinter({ printerIp: printer, printerPort, certSha256, code, remote, zip: built.zip, timeoutMs: timeoutS * 1000, signal: ac.signal }),
            new Promise((_, rej) => { timer = setTimeout(() => { ac.abort(); rej(new HttpError(504, `upload did not finish within ${timeoutS} s`)); }, timeoutS * 1000); }),
          ]);
          if (r.remoteBytes !== bytes) {
            return fail(502, `uploaded, but the printer reports ${r.remoteBytes ?? 'no size'} bytes for ${remote}, not ${bytes} (SIZE reply: ${r.sizeReply})`, {}, { remote, bytes, remoteBytes: r.remoteBytes });
          }
          const gm = gcodeMeta(body.gcode);
          uploaded.set(remote, { md5: createHash('md5').update(built.zip).digest('hex'), gcodeMd5: built.md5, types: fileTypes, amsMapping: hasMap ? [...body.amsMapping] : null, objects: gm.objects ?? null, printableArea: gm.printableArea ?? null });
          send(200, { ok: true, remote, bytes, remoteBytes: r.remoteBytes, md5: built.md5, started: false });
        } catch (e) {
          fail(e instanceof HttpError ? e.status : 502, `printer upload failed: ${redact(e.message, code)}`, {}, { remote, bytes });
        } finally {
          clearTimeout(timer);
        }
      });
      chain = job.finally(() => { pending--; });
    });
  });
  server.requestTimeout = 0; // the upload timeout governs
  server.on('close', () => camera.stop());
  server.stopCamera = () => camera.stop();

  /* Status, start, pause, resume, stop: one MQTT session each. Every command reads the
   * state first, refuses in the wrong state, and returns the state the printer
   * reports AFTER it. "Sent" is never reported as "done". */
  async function printerCommand(route, chunks, send, fail) {
    let body = {};
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (raw) {
      try { body = JSON.parse(raw); } catch { return fail(400, 'request body is not JSON'); }
    }
    if (!body || typeof body !== 'object') return fail(400, 'request body must be a JSON object');
    if (!code) return fail(409, 'no printer access code: start the bridge with --code-file <path> or env X2D_ACCESS_CODE');
    if (!serial) return fail(409, 'no printer serial: start the bridge with --serial <serial> (on the printer: Settings → Device)');
    // Start and resume move and heat the machine: the page must say a person is there.
    // Pause and stop are the safe direction and need no confirm.
    if (['start', 'resume'].includes(route) && body.confirm !== 'at-printer') {
      return fail(400, `${route} needs confirm: "at-printer" (a person at the printer)`);
    }
    let cmd = null;
    if (route === 'start') {
      if (typeof body.remote !== 'string' || !uploaded.has(body.remote)) {
        return fail(409, `${String(body.remote ?? '(none)').slice(0, 80)} was not uploaded by this bridge since it started: upload the plate again, then start it`);
      }
      // START-STALE: the start must ask for exactly what THIS file was built and uploaded for. Checked before the
      // printer is contacted; the tray check below still runs on top of it.
      const f = uploaded.get(body.remote);
      const name = body.remote.slice(0, 80);
      if (!f.types) return fail(409, `${name} does not state its filament types (no "; filament_type" line in its G-code): not starting it`);
      if (!sameTypes(f.types, body.expectTypes)) {
        return fail(409, `${name} was built for ${f.types.join(', ')}, but the start asks for ${Array.isArray(body.expectTypes) ? body.expectTypes.join(', ') || 'nothing' : 'nothing'}: the plate changed since upload, upload it again`);
      }
      if (!f.amsMapping) return fail(409, `${name} was uploaded without its AMS mapping: upload the plate again`);
      if (!Array.isArray(body.amsMapping) || body.amsMapping.length !== f.amsMapping.length || body.amsMapping.some((n, i) => n !== f.amsMapping[i])) {
        return fail(409, `${name} was uploaded for AMS mapping [${f.amsMapping.join(', ')}], but the start asks for ${JSON.stringify(body.amsMapping ?? null)}: upload the plate again`);
      }
      if (body.md5 !== undefined && body.md5 !== f.gcodeMd5) return fail(409, `the md5 in the start is not the G-code of ${name}: upload the plate again`);
      try { cmd = startCommand({ ...body, fileMd5: f.md5 }); } catch (e) { return fail(e.status ?? 400, e.message); }
    }
    if (route === 'fan') {
      try { cmd = fanCommand(body.id, body.percent); } catch (e) { return fail(e.status ?? 400, e.message); }
    }
    if (route === 'fanmode' && !(Number.isInteger(body.mode) && body.mode >= 0 && body.mode <= 15)) return fail(400, 'fanmode needs {"mode": <modeId the printer lists>}');
    if (route === 'speed' && !(Number.isInteger(body.level) && SPEED_LEVELS[body.level])) return fail(400, 'speed needs {"level": 1|2|3|4} (Silent, Standard, Sport, Ludicrous)');
    if (route === 'skip') {
      // Skipping cannot be undone: the page says which objects, and says so.
      if (body.confirm !== 'skip') return fail(400, 'skip needs confirm: "skip"');
      if (!Array.isArray(body.ids) || !body.ids.length || !body.ids.every((n) => Number.isInteger(n) && n >= 0)) return fail(400, 'skip needs {"ids": [label ids]}');
    }
    if (printerBusy) {
      if (!['pause', 'stop'].includes(route)) return fail(429, 'another printer command is running');
      const handed = await new Promise((res) => {
        const w = () => { clearTimeout(t); res(true); };
        const t = setTimeout(() => { busyWaiters = busyWaiters.filter((x) => x !== w); res(false); }, SAFE_WAIT_MS);
        busyWaiters.push(w);
      });
      if (!handed) return fail(429, `another printer command was still running after ${SAFE_WAIT_MS / 1000} s: ${route} was NOT sent`);
    }
    printerBusy = true;
    const ctx = { printerIp: printer, mqttPort, certSha256, code, serial, timeoutMs: 15000 };
    try {
      const r = await withPrinter(ctx, async (c, p) => {
        const st = String(p.gcode_state ?? '');
        // The objects of the running file, when this bridge uploaded it (its name is the task name).
        const running = [...uploaded.entries()].find(([remote]) => remote.replace(/\.gcode\.3mf$/, '') === String(p.subtask_name ?? ''));
        const objects = running?.[1].objects ?? null;
        const printableArea = running?.[1].printableArea ?? null;
        const reply = (q) => ({ ok: true, ...statusFromReport(q), objects, printableArea });
        if (route === 'status') return reply(p);
        if (route === 'fanmode') {
          const modes = Array.isArray(p.device?.airduct?.modeList) ? p.device.airduct.modeList.map((m) => Number(m.modeId)) : [];
          if (!modes.includes(body.mode)) throw new HttpError(409, `the printer lists no fan mode ${body.mode} (it lists ${modes.join(', ') || 'none'})`);
          c.publish({ print: { sequence_id: String(Date.now() % 1e9), command: 'set_airduct', modeId: body.mode, submode: -1 } });
          const after = await c.waitFor((q) => Number(q.device?.airduct?.modeCur) === body.mode, 15000, `fan mode ${FAN_MODE_NAMES[body.mode] ?? body.mode} sent, but the printer did not report it`);
          return reply(after);
        }
        if (route === 'speed') {
          if (!['RUNNING', 'PAUSE', 'PREPARE'].includes(st)) throw new HttpError(409, `the printer is ${st || 'in an unknown state'}: print speed is set during a print`);
          c.publish({ print: { sequence_id: String(Date.now() % 1e9), command: 'print_speed', param: String(body.level) } });
          const after = await c.waitFor((q) => Number(q.spd_lvl) === body.level, 10000, `speed ${SPEED_LEVELS[body.level]} sent, but the printer did not report it`);
          return reply(after);
        }
        if (route === 'skip') {
          if (!['RUNNING', 'PAUSE'].includes(st)) throw new HttpError(409, `the printer is ${st || 'in an unknown state'}: objects are skipped during a print`);
          if (!objects) throw new HttpError(409, 'the running file was not uploaded by this bridge since it started, or names no objects: its objects are not known here');
          const done = new Set((Array.isArray(p.s_obj) ? p.s_obj : []).map(Number));
          const unknown = body.ids.filter((n) => !objects.some((o) => o.id === n));
          if (unknown.length) throw new HttpError(409, `the running file has no object ${unknown.join(', ')}`);
          if (objects.every((o) => done.has(o.id) || body.ids.includes(o.id))) throw new HttpError(409, 'that would skip every object left: use Stop');
          const ids = body.ids.filter((n) => !done.has(n));
          if (!ids.length) return reply(p);
          c.publish({ print: { sequence_id: String(Date.now() % 1e9), command: 'skip_objects', obj_list: ids } });
          const after = await c.waitFor((q) => Array.isArray(q.s_obj) && ids.every((n) => q.s_obj.map(Number).includes(n)), 15000, `skip ${ids.join(', ')} sent, but the printer did not report it`);
          return reply(after);
        }
        if (route === 'light') {
          if (typeof body.on !== 'boolean') throw new HttpError(400, 'light needs {"on": true|false}');
          const mode = body.on ? 'on' : 'off';
          c.publish({ system: { sequence_id: '0', command: 'ledctrl', led_node: 'chamber_light', led_mode: mode, led_on_time: 500, led_off_time: 500, loop_times: 0, interval_time: 0 } });
          const after = await c.waitFor((q) => Array.isArray(q.lights_report) && q.lights_report.find((l) => l.node === 'chamber_light')?.mode === mode, 10000, `light ${mode} sent, but the printer did not report it`);
          return reply(after);
        }
        if (route === 'fan') {
          const f = fansFromReport(p);
          if (!f) throw new HttpError(409, 'the printer does not report its fans in the form this bridge reads (device.airduct): not sending');
          const fan = f.fans.find((x) => x.id === body.id);
          if (!fan) throw new HttpError(409, `the printer reports no fan ${body.id}`);
          if (fan.control !== 'set') throw new HttpError(409, `${fan.name} is ${fan.control === 'off' ? 'off' : 'run by the printer'} in ${f.mode} mode: not settable from here`);
          cmd.print.sequence_id = String(Date.now() % 1e9);
          c.publish(cmd);
          const after = await c.waitFor((q) => fansFromReport(q)?.fans.find((x) => x.id === body.id)?.percent === body.percent, 10000, `${fan.name} ${body.percent} % sent, but the printer did not report it`);
          return reply(after);
        }
        if (route === 'start') {
          if (!IDLE_STATES.includes(st)) throw new HttpError(409, `the printer is ${st || 'in an unknown state'}, not idle: not starting`);
          const want = Array.isArray(body.expectTypes) ? body.expectTypes : [];
          const slots = slotsFromReport(p);
          for (let k = 0; k < cmd.print.ams_mapping.length; k++) {
            if (!want[k]) continue;
            const idx = cmd.print.ams_mapping[k];
            const s = slots.find((x) => x.index === idx);
            if (!s || String(s.type).toUpperCase() !== String(want[k]).toUpperCase()) {
              throw new HttpError(409, `the printer reports ${s ? s.type || 'nothing' : 'no such slot'} in ${idx === 254 ? 'the external spool' : `AMS slot ${idx + 1}`}, the plate needs ${want[k]}: not starting`);
            }
          }
          const errBefore = p.print_error;
          const seq = String(Date.now() % 1e9);
          cmd.print.sequence_id = seq;
          c.publish(cmd);
          // The printer's direct answer, if it gives one: {command:'project_file', result, reason, ...}.
          const answer = () => {
            const a = c.replies.find((x) => x.command === 'project_file');
            if (!a) return '';
            const bits = ['result', 'reason', 'err_code', 'error_code', 'msg'].filter((k) => a[k] !== undefined && a[k] !== '').map((k) => `${k} ${JSON.stringify(a[k])}`);
            return bits.length ? `; the printer answered project_file with ${bits.join(', ')}` : '; the printer acknowledged project_file with no result field';
          };
          const rejected = () => c.replies.some((x) => x.command === 'project_file' && /fail/i.test(String(x.result ?? '')));
          let after;
          try {
            after = await c.waitFor((q) => rejected() || ['PREPARE', 'RUNNING', 'SLICING'].includes(q.gcode_state)
              || (q.gcode_state === 'FAILED' && st !== 'FAILED'), 30000, 'start sent, but the printer did not start');
          } catch (e) {
            // FAILED before and after with the SAME error: the printer may have refused again, or
            // may not have acted at all. Say exactly that, never "refused" as fact.
            if (c.print?.gcode_state === 'FAILED') {
              throw new HttpError(502, `the printer is still FAILED${c.print.print_error ? ` (error ${hmsCode(c.print.print_error)})` : ''} 30 s after the start${answer() || '; it sent no answer to project_file'}`);
            }
            throw new HttpError(e.status ?? 504, `${e.message}${answer()}`);
          }
          if (rejected() || after.gcode_state === 'FAILED') {
            throw new HttpError(502, `the printer refused the job: ${after.gcode_state}${after.print_error ? `, error ${hmsCode(after.print_error)}` : ''}${answer()}`);
          }
          return { ok: true, started: true, remote: body.remote, ...statusFromReport(after) };
        }
        const need = { pause: ['RUNNING', 'PREPARE'], resume: ['PAUSE'], stop: ACTIVE_STATES }[route];
        if (!need.includes(st)) throw new HttpError(409, `the printer is ${st || 'in an unknown state'}: nothing to ${route}`);
        c.publish({ print: { sequence_id: '0', command: route, param: '' } });
        const done = { pause: (q) => q.gcode_state === 'PAUSE', resume: (q) => q.gcode_state === 'RUNNING' || q.gcode_state === 'PREPARE', stop: (q) => !ACTIVE_STATES.includes(q.gcode_state) }[route];
        const after = await c.waitFor(done, 30000, `${route} sent, but the printer did not ${route}`);
        return { ok: true, ...statusFromReport(after) };
      });
      send(200, r);
    } catch (e) {
      fail(e instanceof HttpError ? e.status : 502, redact(String(e && e.message), code));
    } finally {
      releasePrinter();
    }
  }

  return server;
}

/* ─────────────────────────────── main ─────────────────────────────── */

function main() {
  let o;
  let tok;
  let ac;
  try {
    o = parseArgs(process.argv.slice(2));
    tok = resolveToken(o.tokenFile, process.env);
    ac = resolveAccessCode(o.codeFile, process.env);
  } catch (e) {
    process.stderr.write(`printer-bridge: ${e.message}\n`);
    process.exit(2);
  }
  // Two ways in, one list: the printers' own announcements (blocked by a deny-incoming firewall) and
  // the replies to our own search (not blocked). Discovery is "listening" when either one works.
  const discLog = (l) => process.stdout.write(l + '\n');
  const heard = o.discover ? listenBambu({ log: discLog }) : null;
  const asked = heard ? searchBambu({ seen: heard.seen, log: discLog }) : null;
  const server = createBridge({
    discovery: heard
      ? () => ({
          seen: heard.seen,
          listening: heard.listening || asked.searching,
          error: [heard.listening ? '' : `listen: ${heard.error || 'starting'}`, asked.searching ? '' : `search: ${asked.error || 'starting'}`].filter(Boolean).join('; ') || null,
        })
      : null,
    token: tok.token, code: ac.code, printer: o.printer, printerPort: o.printerPort, certSha256: o.certSha256,
    origins: o.origins, timeoutS: o.timeoutS, maxBody: o.maxBody, serial: o.serial, mqttPort: o.mqttPort, ffmpeg: o.ffmpeg, cameraPort: o.cameraPort,
  });
  server.on('error', (e) => {
    process.stderr.write(`printer-bridge: ${e.message}\n`);
    process.exit(2);
  });
  let unregister = () => {};
  process.on('exit', () => unregister());
  server.listen(o.port, BIND_HOST, () => {
    const { address, port } = server.address();
    unregister = registerBridge('2bee.printer-bridge', port);
    const p = (s) => process.stdout.write(s + '\n');
    p(`printer-bridge listening on http://${address}:${port} -> printer ${o.printer}:${o.printerPort} (FTPS upload; MQTT ${o.mqttPort} start/pause/resume/stop)`);
    if (tok.printable) p(`  Key      : ${tok.token}    (generated for this run only)`);
    else p(`  Key      : the token from ${tok.source} (not printed)`);
    p(`  Access code: ${ac.code ? `from ${ac.source} (not printed)` : 'NONE — uploads will be refused (409); pass --code-file or X2D_ACCESS_CODE'}`);
    p(`  Serial     : ${o.serial ? `set (${o.serial.length} chars, not printed)` : 'NONE — status/start/pause/resume/stop will be refused (409); pass --serial or env X2D_SERIAL'}`);
    p(`  Printer certificate: ${o.certSha256 ? 'pinned by --printer-cert-sha256' : `self-signed accepted for ${o.printer} only (no pin)`}`);
    p(`Allowed origins: ${o.origins.join(', ')}`);
    p(`Timeout ${o.timeoutS} s · body cap ${o.maxBody} bytes · one upload at a time`);
  });
  const stop = () => { server.stopCamera(); server.close(() => process.exit(0)); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
