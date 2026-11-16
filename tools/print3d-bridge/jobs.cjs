// VENDORED from pnp's 2bee.3d: /home/gbacs/build/web-slicer/jobs.js.js at commit 65227d3 (unchanged vs HEAD on 2026-10-15).
// Source sha256: c74b768f296e14796cdcf15565f1a4c4843aa67aeca3ef895775bb53da99c9de
// Only edits: this 3-line header and require('./x') -> require('./x.cjs'). Re-vendor rather than edit; see README.md.
'use strict';
// jobs.js (M1, server side): the print-job model of the web slicer and everything about it that is not HTTP.
//
// A JOB is plain JSON (what the page holds as window.__job, what /api/job/save writes, what /api/job/load returns):
//   { version: 1, name, bed,                       // bed = Orca bed type name, e.g. "Textured PEI Plate"
//     process,                                      // process preset name
//     files:   [ { name, size, sha256 } ],          // STL files; the bytes are embedded as base64 "data" in a SAVED job file
//     objects: [ { file: <index into files>, slot: "ams1-3",
//                  placement: { x, y, rot } | null } ],   // x,y = mm, world position of the centre of the STL's own XY
//                                                          // bounding box AFTER rotating it by rot degrees (CCW, about Z)
//                                                          // about that centre; z is always dropped onto the bed. null = let Orca arrange.
//                  placement.tilt (optional) = [rx, ry] degrees, multiples of 90: the part lies on another face (Rx then Ry about its bbox centre, before rot).
//   allowTilt (optional bool, default true): the objective optimiser may lay tall slender parts flat (placement.tilt) when that is measurably better.
//     slotPresets: { "ams1-3": "<filament preset name>" },   // one Orca filament preset per distinct slot in use
//     overrides:   { "wall_loops": "3" } }                    // Orca process keys (the `set=` keys of /api/slice), validated by setOk()
//
// Placement convention was MEASURED against Orca 2.5.0-dev (3mf build item transform = rotation (3MF row-vector
// convention, theta = atan2(m[1], m[0])) + translation; world centre of the unrotated bbox = item.t + R * component.t).
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const JOBS_DIR = process.env.WS_JOBS_DIR || path.join(__dirname, 'jobs');          // saved jobs (small, durable)
const UPLOAD_DIR = process.env.WS_UPLOAD_DIR || path.join(os.tmpdir(), 'web-slicer-uploads'); // STL bytes by hash (swept after a day)
// No product limits on object, copy, group-member or bed counts. SANE_TOTAL only keeps a typo (qty 1e9) from exhausting the machine: it is a memory guard, not a rule.
const SANE_TOTAL = 100000;
const OBJECTIVES = ['fastest', 'quality', 'balanced']; // arrangement objective ids (weights live in beds.js)
const MAX_STL = 100 * 1024 * 1024;

// ---------- STL ----------
// -> Float32Array of 9 floats per triangle. Binary (size matches 84+50n) or ASCII.
function parseStl(buf) {
  if (buf.length >= 84) {
    const n = buf.readUInt32LE(80);
    if (n > 0 && buf.length === 84 + 50 * n) {
      const out = new Float32Array(n * 9);
      for (let i = 0; i < n; i++) { const o = 84 + 50 * i + 12; for (let k = 0; k < 9; k++) out[i * 9 + k] = buf.readFloatLE(o + 4 * k); }
      return out;
    }
  }
  const txt = buf.toString('latin1');
  if (!/^\s*solid/.test(txt)) return new Float32Array(0);
  const v = []; const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g; let m;
  while ((m = re.exec(txt))) v.push(+m[1], +m[2], +m[3]);
  if (v.length % 9) return new Float32Array(0);
  return Float32Array.from(v);
}
const finite = (t) => { for (let i = 0; i < t.length; i++) if (!Number.isFinite(t[i])) return false; return true; };

function bboxOf(t) {
  let a = [Infinity, Infinity, Infinity], b = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < t.length; i += 3) for (let k = 0; k < 3; k++) { if (t[i + k] < a[k]) a[k] = t[i + k]; if (t[i + k] > b[k]) b[k] = t[i + k]; }
  return { min: a, max: b };
}

// Optional tilt = [rx, ry] degrees (multiples of 90 only): the part is first turned about its 3D bbox centre (Rx, then Ry), then everything below applies
// to the tilted mesh. Without tilt this is exactly the original convention.
// Rotate about the XY-bbox centre of the (tilted) mesh by rot degrees, then put that centre at (x,y); z min -> 0.
// Returns { tris, bbox (final world bbox), footprint {w,d,h} }.
function placeMesh(t, rot, x, y, tilt) {
  let src = t;
  if (tilt && (tilt[0] || tilt[1])) {
    const b0 = bboxOf(t), c = [(b0.min[0] + b0.max[0]) / 2, (b0.min[1] + b0.max[1]) / 2, (b0.min[2] + b0.max[2]) / 2];
    const ax = (tilt[0] || 0) * Math.PI / 180, ay = (tilt[1] || 0) * Math.PI / 180, cx_ = Math.round(Math.cos(ax) * 1e9) / 1e9, sx_ = Math.round(Math.sin(ax) * 1e9) / 1e9, cy_ = Math.round(Math.cos(ay) * 1e9) / 1e9, sy_ = Math.round(Math.sin(ay) * 1e9) / 1e9;
    src = new Float64Array(t.length);
    for (let i = 0; i < t.length; i += 3) {
      const px = t[i] - c[0], py = t[i + 1] - c[1], pz = t[i + 2] - c[2];
      const y1 = py * cx_ - pz * sx_, z1 = py * sx_ + pz * cx_;      // Rx
      src[i] = px * cy_ + z1 * sy_; src[i + 1] = y1; src[i + 2] = -px * sy_ + z1 * cy_; // Ry
    }
  }
  const bb = bboxOf(src), cx = (bb.min[0] + bb.max[0]) / 2, cy = (bb.min[1] + bb.max[1]) / 2;
  const th = (rot || 0) * Math.PI / 180, c = Math.cos(th), s = Math.sin(th);
  const o = new Float64Array(src.length);
  for (let i = 0; i < src.length; i += 3) {
    const dx = src[i] - cx, dy = src[i + 1] - cy;
    o[i] = dx * c - dy * s + x; o[i + 1] = dx * s + dy * c + y; o[i + 2] = src[i + 2] - bb.min[2];
  }
  const fb = bboxOf(o);
  return { tris: o, bbox: fb, footprint: { w: fb.max[0] - fb.min[0], d: fb.max[1] - fb.min[1], h: fb.max[2] - fb.min[2] } };
}

function writeBinaryStl(tris) {
  const n = tris.length / 9, buf = Buffer.alloc(84 + 50 * n);
  buf.write('web-slicer baked placement', 0, 'latin1'); buf.writeUInt32LE(n, 80);
  for (let i = 0; i < n; i++) {
    const p = tris.subarray(i * 9, i * 9 + 9);
    const ux = p[3] - p[0], uy = p[4] - p[1], uz = p[5] - p[2], vx = p[6] - p[0], vy = p[7] - p[1], vz = p[8] - p[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const l = Math.hypot(nx, ny, nz) || 1;
    const o = 84 + 50 * i; buf.writeFloatLE(nx / l, o); buf.writeFloatLE(ny / l, o + 4); buf.writeFloatLE(nz / l, o + 8);
    for (let k = 0; k < 9; k++) buf.writeFloatLE(p[k], o + 12 + 4 * k);
  }
  return buf;
}

// ---------- objects as meshes ----------
// The mesh of job object i for geometry (footprint, arrangement, baked placement): a plain object = its STL; a GROUP = the triangles of all members concatenated in
// their ORIGINAL coordinates, so the union bbox centre / floor are the group's (one footprint). -> { key, tris } (key identifies the shape for caches)
async function objectMesh(job, o) {
  const ids = o.parts ? o.parts.map((p) => p.file) : [o.file], list = [];
  for (const fi of ids) { const buf = await getUpload(job.files[fi].sha256); if (!buf) return null; list.push(parseStl(buf)); }
  const n = list.reduce((s, t) => s + t.length, 0), tris = list.length === 1 ? list[0] : new Float32Array(n);
  if (list.length > 1) { let k = 0; for (const t of list) { tris.set(t, k); k += t.length; } }
  return { key: ids.map((fi) => job.files[fi].sha256).join('+'), tris };
}
const objectSlots = (o) => (o.parts ? o.parts.map((p) => p.slot) : [o.slot]);
const objectName = (job, o) => (o.parts ? o.parts.map((p) => job.files[p.file].name.replace(/\.stl$/i, '')).join(' + ') + '.stl' : job.files[o.file].name);

// ---------- 3mf placement read-back ----------
const unzipText = (file, entry) => new Promise((resolve) => {
  execFile('unzip', ['-p', file, entry], { maxBuffer: 256 * 1024 * 1024, encoding: 'utf8' }, (e, out) => resolve(e ? null : out));
});
// Plates of an Orca 3mf (Metadata/model_settings.config): [{ plate, objects: [objectName...] }]. Orca puts what does not fit on plate 2, 3...
async function platesOf(threeMf) {
  const xml = await unzipText(threeMf, 'Metadata/model_settings.config'); if (!xml) return [];
  const nameOf = {};
  for (const m of xml.matchAll(/<object id="(\d+)">([\s\S]*?)<\/object>/g)) { const n = m[2].match(/<metadata key="name" value="([^"]*)"/); if (n) nameOf[m[1]] = n[1]; }
  return [...xml.matchAll(/<plate>([\s\S]*?)<\/plate>/g)].map((m) => ({ plate: Number((m[1].match(/key="plater_id" value="(\d+)"/) || [0, 0])[1]),
    objects: [...m[1].matchAll(/key="object_id" value="(\d+)"/g)].map((o) => nameOf[o[1]]).filter(Boolean) }));
}
const nums = (s) => String(s || '').trim().split(/\s+/).map(Number);

// Orca's arranged 3mf -> one entry per object, in file order: { x, y, rot }  (x,y = world position of the original XY bbox centre).
async function readPlacement(threeMf) {
  const xml = await unzipText(threeMf, '3D/3dmodel.model');
  if (!xml) return null;
  const comp = {}; // object id -> component translation
  for (const m of xml.matchAll(/<object id="(\d+)"[^>]*>\s*<components>\s*<component [^>]*transform="([^"]+)"/g)) comp[m[1]] = nums(m[2]).slice(9, 12);
  // Orca may list the build items in a different order than the files on the command line (measured with objects of different sizes):
  // map every item to its file number through the object name "o<N>-..." in model_settings.config, else fall back to file order.
  const ms = await unzipText(threeMf, 'Metadata/model_settings.config'), nameOf = {};
  if (ms) for (const m of ms.matchAll(/<object id="(\d+)">([\s\S]*?)<\/object>/g)) { const n = m[2].match(/<metadata key="name" value="o(\d+)-/); if (n) nameOf[m[1]] = Number(n[1]) - 1; }
  const out = [], byName = [];
  for (const m of xml.matchAll(/<item objectid="(\d+)"[^>]*transform="([^"]+)"/g)) {
    const t = nums(m[2]), c = comp[m[1]] || [0, 0, 0];
    const th = Math.atan2(t[1], t[0]), cs = Math.cos(th), sn = Math.sin(th);
    // row-vector convention: v' = v*M  ->  x' = x*cos - y*sin, y' = x*sin + y*cos (CCW theta)
    const p = { x: t[9] + c[0] * cs - c[1] * sn, y: t[10] + c[0] * sn + c[1] * cs, rot: th * 180 / Math.PI };
    out.push(p); if (nameOf[m[1]] !== undefined) byName[nameOf[m[1]]] = p;
  }
  if (byName.length === out.length && byName.every(Boolean)) return byName;
  return out;
}
const round = (v, d = 3) => Math.round(v * 10 ** d) / 10 ** d;


const readPlateJson = (threeMf) => unzipText(threeMf, 'Metadata/plate_1.json');
// <warning msg="bed_temperature_too_high_than_filament" .../> entries of Orca's slice_info.config, as readable text
const WARN_TEXT = { bed_temperature_too_high_than_filament: 'Orca warning bed_temperature_too_high_than_filament: the bed temperature is too high for one of the filaments (check the bed temperatures of the presets used).' };
async function readSliceInfoWarnings(threeMf) {
  const xml = await unzipText(threeMf, 'Metadata/slice_info.config');
  if (!xml) return [];
  return [...xml.matchAll(/<warning msg="([^"]+)"/g)].map((m) => WARN_TEXT[m[1]] || ('Orca warning: ' + m[1]));
}

// ---------- G-code analysis (multi-filament aware) ----------
// Per ";FEATURE:" block: extrusion path length, filament length, time ESTIMATE = path / programmed feedrate (no acceleration:
// it is not Orca's number, Orca's total is reported separately). Per tool (T<n>): filament length. Tool changes counted.
function analyseGcode(text) {
  const g = (re) => { const m = text.match(re); return m ? m[1].trim() : null; };
  const list = (s) => (s ? s.split(',').map((v) => Number(v.trim())) : []);
  const dia = list(g(/^; filament_diameter: (.+)$/m)), dens = list(g(/^; filament_density: (.+)$/m));
  const used = { mm: list(g(/^; filament used \[mm\] = (.+)$/m)), g: list(g(/^; filament used \[g\] = (.+)$/m)), cm3: list(g(/^; filament used \[cm3\] = (.+)$/m)) };
  const feat = new Map(); let cur = 'Start', tool = 0, toolchanges = 0, relE = true;
  let x = 0, y = 0, z = 0, f = 6000, e = 0;
  const tools = new Map();
  const slot = (name) => { let o = feat.get(name); if (!o) { o = { name, pathMm: 0, sec: 0, filMm: 0, byTool: {} }; feat.set(name, o); } return o; };
  let started = false;
  for (const raw of text.split('\n')) {
    const c = raw.charCodeAt(0);
    if (c === 59) { // ';'
      if (raw.startsWith('; FEATURE:')) cur = raw.slice(10).trim();
      else if (/^; toolchange #\d+/.test(raw)) toolchanges++;
      else if (raw.startsWith('; HEADER_BLOCK_END') || raw.startsWith('; EXECUTABLE_BLOCK_START')) started = true;
      continue;
    }
    if (c === 84 && /^T(\d+)\b/.test(raw)) { const n = +raw.match(/^T(\d+)/)[1]; if (n < 200) tool = n; continue; }
    if (c === 77) { if (raw.startsWith('M83')) relE = true; else if (raw.startsWith('M82')) relE = false; continue; }
    if (c !== 71 || !/^G[01] /.test(raw)) { if (/^G92 /.test(raw)) { const m = raw.match(/E(-?[\d.]+)/); if (m) e = +m[1]; } continue; }
    const mx = raw.match(/X(-?[\d.]+)/), my = raw.match(/Y(-?[\d.]+)/), mz = raw.match(/Z(-?[\d.]+)/), me = raw.match(/E(-?[\d.]+)/), mf = raw.match(/F(-?[\d.]+)/);
    if (mf) f = +mf[1];
    const nx = mx ? +mx[1] : x, ny = my ? +my[1] : y, nz = mz ? +mz[1] : z;
    const d = Math.hypot(nx - x, ny - y, nz - z);
    let de = 0; if (me) { const v = +me[1]; de = relE ? v : v - e; e = relE ? e : v; }
    x = nx; y = ny; z = nz;
    const t = d > 0 ? d / (f / 60) : (de ? Math.abs(de) / (f / 60) : 0);
    if (!started && d === 0 && !de) continue;
    const o = slot(cur); o.sec += t;
    if (de > 0 && d > 0) { o.pathMm += d; o.filMm += de; o.byTool[tool] = (o.byTool[tool] || 0) + de; tools.set(tool, (tools.get(tool) || 0) + de); }
    else if (de > 0) { o.filMm += de; o.byTool[tool] = (o.byTool[tool] || 0) + de; tools.set(tool, (tools.get(tool) || 0) + de); } // purge in place
  }
  const mm3 = (tl, mm) => mm * Math.PI * ((dia[tl] || 1.75) / 2) ** 2;
  const gramsOf = (tl, mm) => mm3(tl, mm) / 1000 * (dens[tl] || 1.25);
  const features = [...feat.values()].filter((o) => o.name !== 'Start' || o.filMm > 0).map((o) => ({
    name: o.name, pathMm: round(o.pathMm, 1), filMm: round(o.filMm, 1), secEst: round(o.sec, 1),
    grams: round(Object.entries(o.byTool).reduce((s, [tl, mm]) => s + gramsOf(+tl, mm), 0), 3),
    byTool: Object.fromEntries(Object.entries(o.byTool).map(([tl, mm]) => [tl, { filMm: round(mm, 1), grams: round(gramsOf(+tl, mm), 3) }])) }));
  const tower = feat.get('Prime tower');
  const perFilament = used.mm.map((mm, i) => {
    const towerG = tower && tower.byTool[i] ? gramsOf(i, tower.byTool[i]) : 0;
    const gOrca = used.g[i];
    return { index: i, mm, grams: gOrca, cm3: used.cm3[i], extrudedMm: round(tools.get(i) || 0, 1), towerGrams: round(towerG, 2),
      // Orca's G-code total includes the prime tower; the printer's own flush at a tool change (M620.10) is not E moves in the G-code and is not counted anywhere
      };
  });
  return {
    totalTime: g(/total estimated time: ([^;\n]+)/), printTime: g(/^; model printing time: ([^;\n]+)/m), layers: g(/^; total layer number: (\d+)/m),
    toolChanges: toolchanges, filaments: perFilament, features,
    timeEstimateNote: 'per-feature seconds = path length / programmed feedrate, no acceleration: relative sizes only, not Orca\'s time',
  };
}

// ---------- job validation ----------
// tilt = [rx, ry] in degrees, multiples of 90 (a part laid on another face). null/[0,0] = upright.
function cleanTilt(t, i) {
  if (t === undefined || t === null) return null;
  if (!Array.isArray(t) || t.length !== 2) throw new Error(`object ${i + 1}: tilt must be [rx, ry]`);
  const r = t.map((v) => { const n = Number(v); if (!Number.isFinite(n) || Math.abs(n) > 360 || n % 90 !== 0) throw new Error(`object ${i + 1}: tilt angles must be multiples of 90 degrees`); return ((n % 360) + 360) % 360; });
  return r[0] || r[1] ? r : null;
}
const ID_RE = /^[a-z0-9][a-z0-9_-]{2,60}$/;
const SET_RE = /^([a-z0-9_]+)=([\w .,%\/@+-]*)$/;
const setOk = (k, v) => /^[a-z0-9_]+$/.test(k) && SET_RE.test(k + '=' + v);
const SLOT_RE = /^(ams\d+-[1-4]|ext)$/;
const safeName = (s) => path.basename(String(s || 'model.stl')).replace(/[^\w.\- ]/g, '_').slice(0, 80) || 'model.stl';

// opts.keepQty: keep `qty` entries as they are (saved jobs); default: expand every entry with qty n into n copies (same file, same slot, positions unpinned).
function cleanJob(j, opts) {
  if (!j || typeof j !== 'object') throw new Error('job must be a JSON object');
  const keepQty = !!(opts && opts.keepQty);
  const files = Array.isArray(j.files) ? j.files : [];
  const objects = Array.isArray(j.objects) ? j.objects : [];
  if (!objects.length) throw new Error('job has no objects');
  const qtyOf = (o, i) => {
    if (o && o.qty !== undefined && o.qty !== null && o.qty !== '') { const q = Number(o.qty); if (!Number.isInteger(q) || q < 1) throw new Error(`object ${i + 1}: qty must be a whole number, 1 or more`); return q; }
    return 1;
  };
  const total = objects.reduce((s, o, i) => s + qtyOf(o, i), 0);
  if (total > SANE_TOTAL) throw new Error(`${total} objects cannot be planned on one machine (memory guard at ${SANE_TOTAL}): check the quantities`);
  const out = { version: 1, name: String(j.name || 'job').slice(0, 80), bed: String(j.bed || ''), printerId: /^p_[0-9a-f]{8}$/.test(String(j.printerId || '')) ? String(j.printerId) : '', process: String(j.process || ''),
    files: files.map((f) => ({ name: safeName(f.name), size: Number(f.size) || 0, sha256: String(f.sha256 || '').toLowerCase(), ...(f.data ? { data: String(f.data) } : {}) })),
    objects: objects.flatMap((o, i) => {
      const q = qtyOf(o, i);
      // a GROUP: parts:[{file, slot}] (2..16 members, original STL coordinates kept); file/slot of the object = its first member
      let parts = null;
      if (o.parts !== undefined && o.parts !== null) {
        if (!Array.isArray(o.parts) || o.parts.length < 2) throw new Error(`object ${i + 1}: a group needs at least 2 parts`);
        parts = o.parts.map((p, k) => {
          const f = Number(p && p.file);
          if (!Number.isInteger(f) || f < 0 || f >= files.length) throw new Error(`object ${i + 1} part ${k + 1}: bad file index`);
          if (!SLOT_RE.test(String((p && p.slot) || ''))) throw new Error(`object ${i + 1} part ${k + 1}: bad slot`);
          return { file: f, slot: String(p.slot) };
        });
      }
      const fi = parts ? parts[0].file : Number(o.file), slotId = parts ? parts[0].slot : o.slot;
      if (!Number.isInteger(fi) || fi < 0 || fi >= files.length) throw new Error(`object ${i + 1}: bad file index`);
      if (!SLOT_RE.test(String(slotId || ''))) throw new Error(`object ${i + 1}: bad slot`);
      let placement = null;
      if (o.placement && q === 1) {
        const p = { x: Number(o.placement.x), y: Number(o.placement.y), rot: Number(o.placement.rot || 0) };
        if (![p.x, p.y, p.rot].every(Number.isFinite) || Math.abs(p.x) > 2000 || Math.abs(p.y) > 2000) throw new Error(`object ${i + 1}: bad placement`);
        placement = { x: round(p.x), y: round(p.y), rot: round(((p.rot % 360) + 540) % 360 - 180) };
        const tl = parts ? null : cleanTilt(o.placement.tilt, i); if (tl) placement.tilt = tl; // a group is never tilted
      }
      const out = { file: fi, slot: String(slotId), placement, ...(parts ? { parts } : {}) };
      if (q === 1 && o.bed !== undefined && o.bed !== null && o.bed !== '') { // optional bed number, 1-based; absent = not assigned (older jobs)
        const b = Number(o.bed); if (!Number.isInteger(b) || b < 1) throw new Error(`object ${i + 1}: bed must be a whole number, 1 or more`);
        out.bed = b;
      }
      if (q > 1) return keepQty ? [{ ...out, qty: q }] : Array.from({ length: q }, () => ({ ...out }));
      return [out];
    }),
    slotPresets: {}, overrides: {} };
  if (j.allowTilt !== undefined && j.allowTilt !== null) out.allowTilt = j.allowTilt === true || j.allowTilt === 'true' || j.allowTilt === 1;
  if (j.objective !== undefined && j.objective !== null && j.objective !== '') {
    if (!OBJECTIVES.includes(j.objective)) throw new Error(`objective must be one of ${OBJECTIVES.join(', ')}`);
    out.objective = j.objective;
  }
  if (Array.isArray(j.sent)) out.sent = j.sent.slice(0, 200).map(cleanSent);
  if (typeof j.savedId === 'string' && ID_RE.test(j.savedId)) out.savedId = j.savedId;
  for (const [k, v] of Object.entries(j.slotPresets || {})) { if (!SLOT_RE.test(k) || /[\/\\]|\.\./.test(String(v))) throw new Error('bad slotPresets entry ' + k); out.slotPresets[k] = String(v); }
  for (const [k, v] of Object.entries(j.overrides || {})) { if (!setOk(k, String(v))) throw new Error('bad override ' + k); out.overrides[k] = String(v); }
  return out;
}

// One `sent` record (a bed uploaded to a printer). Whitelisted fields only: nothing from the printer's config (ip, access code, serial) is kept.
const str = (v, n) => String(v == null ? '' : v).slice(0, n);
function cleanSent(r) {
  if (!r || typeof r !== 'object') throw new Error('sent record must be an object');
  const bed = Number(r.bed); if (!Number.isInteger(bed) || bed < 1) throw new Error('sent record: bad bed');
  const t = new Date(r.time); if (isNaN(t)) throw new Error('sent record: bad time');
  const o = { bed, printerId: str(r.printerId, 60), printerName: str(r.printerName, 80), remoteFile: path.basename(str(r.remoteFile, 200)),
    bytes: Number(r.bytes) || 0, md5: /^[0-9a-f]{32}$/i.test(str(r.md5, 40)) ? str(r.md5, 40).toLowerCase() : '', time: t.toISOString(), result: str(r.result, 40) || 'uploaded' };
  if (r.fp) o.fp = str(r.fp, 64).replace(/[^\w-]/g, '');
  if (r.stats && typeof r.stats === 'object') o.stats = { totalTime: str(r.stats.totalTime, 40), layers: str(r.stats.layers, 20), filamentG: Array.isArray(r.stats.filamentG) ? r.stats.filamentG.slice(0, 16).map((x) => ({ slot: str(x && x.slot, 20), grams: Number(x && x.grams) || 0 })) : [] };
  if (Array.isArray(r.objects)) o.objects = r.objects.map((x) => ({ object: Number(x && x.object) | 0, placement: x && x.placement && Number.isFinite(+x.placement.x) ? { x: round(+x.placement.x), y: round(+x.placement.y), rot: round(+x.placement.rot || 0), ...(cleanTilt(x.placement.tilt, 0) ? { tilt: cleanTilt(x.placement.tilt, 0) } : {}) } : null }));
  if (r.overrides && typeof r.overrides === 'object') { o.overrides = {}; for (const [k, v] of Object.entries(r.overrides)) if (setOk(k, String(v))) o.overrides[k] = String(v); }
  if (r.process) o.process = str(r.process, 120);
  if (r.slotPresets && typeof r.slotPresets === 'object') { o.slotPresets = {}; for (const [k, v] of Object.entries(r.slotPresets)) if (SLOT_RE.test(k)) o.slotPresets[k] = str(v, 120); }
  return o;
}

// ---------- uploads (STL bytes by hash) ----------
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
async function putUpload(buf, name) {
  if (buf.length < 84 || buf.length > MAX_STL) throw new Error('empty, too small or too large STL');
  const t = parseStl(buf);
  if (!t.length || !finite(t)) throw new Error('not a readable STL (no triangles or non-finite vertices)');
  const h = sha(buf);
  await fsp.mkdir(UPLOAD_DIR, { recursive: true });
  const f = path.join(UPLOAD_DIR, h + '.stl');
  if (!fs.existsSync(f)) await fsp.writeFile(f, buf); else await fsp.utimes(f, new Date(), new Date());
  const bb = bboxOf(t);
  return { sha256: h, name: safeName(name), size: buf.length, triangles: t.length / 9,
    size3d: { x: round(bb.max[0] - bb.min[0], 2), y: round(bb.max[1] - bb.min[1], 2), z: round(bb.max[2] - bb.min[2], 2) } };
}
const getUpload = async (h) => { if (!/^[0-9a-f]{64}$/.test(h)) return null; return fsp.readFile(path.join(UPLOAD_DIR, h + '.stl')).catch(() => null); };
async function sweepUploads(ttlMs = 24 * 3600 * 1000) {
  const now = Date.now();
  for (const d of await fsp.readdir(UPLOAD_DIR).catch(() => [])) {
    const p = path.join(UPLOAD_DIR, d); const st = await fsp.stat(p).catch(() => null);
    if (st && now - st.mtimeMs > ttlMs) await fsp.rm(p, { force: true });
  }
}

// ---------- saved jobs ----------
async function saveJob(job, { embed = true } = {}) {
  const clean = cleanJob(job, { keepQty: true });
  const reuse = clean.savedId; delete clean.savedId; // re-saving an already saved job (e.g. after a bed was sent) overwrites that file
  for (const f of clean.files) {
    const buf = await getUpload(f.sha256);
    if (!buf) throw new Error(`file ${f.name} is no longer on the server (upload it again before saving)`);
    f.size = buf.length;
    if (embed) f.data = buf.toString('base64');
  }
  const slug = clean.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'job';
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const id = reuse && fs.existsSync(path.join(JOBS_DIR, reuse + '.json')) ? reuse : `${stamp}-${slug}`;
  await fsp.mkdir(JOBS_DIR, { recursive: true });
  await fsp.writeFile(path.join(JOBS_DIR, id + '.json'), JSON.stringify({ ...clean, id, saved: new Date().toISOString() }, null, 1));
  return { id, job: { ...clean, id, savedId: id, files: clean.files.map(({ data, ...r }) => r) } };
}
async function listJobs() {
  const out = [];
  for (const f of (await fsp.readdir(JOBS_DIR).catch(() => [])).filter((x) => x.endsWith('.json')).sort().reverse()) {
    try {
      const j = JSON.parse(await fsp.readFile(path.join(JOBS_DIR, f), 'utf8'));
      out.push({ id: f.slice(0, -5), name: j.name, saved: j.saved, objects: (j.objects || []).reduce((n, o) => n + (Number(o && o.qty) > 1 ? Number(o.qty) : 1), 0), files: (j.files || []).map((x) => x.name) });
    } catch (e) { out.push({ id: f.slice(0, -5), error: 'unreadable: ' + e.message }); }
  }
  return out;
}
async function readSavedJob(id) {
  if (!ID_RE.test(id)) throw new Error('bad job id');
  return JSON.parse(await fsp.readFile(path.join(JOBS_DIR, id + '.json'), 'utf8'));
}
// A job file (saved here or downloaded from the page) -> re-register every embedded STL as an upload and return the job without bytes.
async function loadJob(raw) {
  const clean = cleanJob(raw, { keepQty: true });
  if (typeof raw.id === 'string' && ID_RE.test(raw.id)) clean.savedId = raw.id;
  const src = raw.files || [];
  for (let i = 0; i < clean.files.length; i++) {
    const f = clean.files[i];
    if (src[i].data) {
      const buf = Buffer.from(src[i].data, 'base64');
      const up = await putUpload(buf, f.name);
      if (f.sha256 && f.sha256 !== up.sha256) throw new Error(`file ${f.name}: embedded bytes do not match the recorded sha256`);
      f.sha256 = up.sha256; f.size = up.size; f.size3d = up.size3d; f.triangles = up.triangles;
    } else if (!(await getUpload(f.sha256))) throw new Error(`file ${f.name} has no embedded data and is not on the server`);
    delete f.data;
  }
  return clean;
}

module.exports = { platesOf, readPlateJson, readSliceInfoWarnings, parseStl, bboxOf, placeMesh, writeBinaryStl, readPlacement, analyseGcode, cleanJob, setOk, safeName, putUpload, getUpload, sweepUploads,
  cleanSent, saveJob, listJobs, readSavedJob, loadJob, JOBS_DIR, UPLOAD_DIR, SANE_TOTAL, objectMesh, objectSlots, objectName, OBJECTIVES, round };
