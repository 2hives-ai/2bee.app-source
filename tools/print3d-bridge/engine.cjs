'use strict';
// engine.cjs — the 2bee.3d print-job engine, PORTED from pnp's /home/gbacs/build/web-slicer/server.js (commit 65227d3).
//
// The body of createEngine() below is server.js lines 62-79 (pruneJobs), 87-173 (profiles, pickFile, flatten, HttpError,
// the one-at-a-time queue, run, gcodeStats), 222-415 (runJob and its helpers), 418-688 (optimiseBed, bedGeometry,
// arrangeSet, repackFewerBeds, planBeds, sliceKey, sliceRoute) and 922-929 (sweep), extracted by line range and kept
// byte-for-byte EXCEPT three edits, each named here so a re-port can redo them:
//   1. `chat.applyOverrides(p, f, job.overrides)` -> `applyOverrides(...)`, defined below exactly as chat.js:56-63 has it.
//   2. `loadSlots(job.printerId || undefined)` -> `loadSlots()`: there is no printer registry here. The bed plate and the
//      filament slots come from ONE local file the person edits through PUT /v1/slots (they are declared, not read from
//      a printer: this engine has no printer connection of any kind).
//   3. The `unknown printer` check on job.printerId is deleted (no registry to check against; the field is ignored).
//   4. (2bee_app 2026-10-16, founder: "no orcaslicer anymore!") server.js runJob is renamed runJobOrca and `runJob` is
//      now a dispatcher: the DEFAULT engine is 2bee.fdm (`runJobFdm`, below the extract: our Rust CLI
//      fdm/src/bin/fdmslice.rs --presets), and OrcaSlicer runs ONLY when the bridge was started with `--engine orca`.
//      Nothing on the default path spawns, stats or reads the orca-slicer binary.
//   5. User-facing strings that named Orca as the arranger/slicer say `${WHO}` (the engine that actually ran).
//   6. (2bee_app 2026-11-13) profiles() also returns bed.extruderAreas / bed.extruderHeights from the machine file.
//   7. (2bee_app 2026-11-13) PER-OBJECT settings: every cleanJob call goes through `cleanJobO`, which validates an
//      object's `overrides` (OBJECT_KEYS only) and puts them back on the cleaned objects (the vendored cleanJob drops
//      them). 2bee.fdm gets them as `--oset N:key=value`; Orca refuses them (not wired for per-object settings here).
//
// 🔴 What this file does NOT contain, on purpose: server.js printerInfo() (it read the printer's access code out of
// OrcaSlicer's own config), sendToPrinter (FTPS), the MQTT status / slot-write / start / stop routes, the camera,
// compareJob (Rust binaries) and the chat routes. It slices. Uploading is tools/printer-bridge's job, and starting a
// print is nobody's in this app (founder 2026-10-14: upload only).
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');
const jobs = require('./jobs.cjs');
const beds = require('./beds.cjs');
const multipart = require('./multipart.cjs');
const A = require('./allowlist.cjs');

// Copied from web-slicer/printers.js:22-24 (where 2bee.3d defines them).
const BED_PLATES = ['Cool Plate', 'Engineering Plate', 'High Temp Plate', 'Textured PEI Plate', 'Textured Cool Plate', 'Supertack Plate'];
const DEFAULT_BED_PLATE = 'Textured PEI Plate';
const FILAMENT_TYPES = ['', 'PLA', 'PETG', 'ASA', 'ABS', 'TPU', 'PA', 'PC', 'PVA', 'HIPS', 'PLA-CF', 'PETG-CF', 'PA-CF'];
const SLOT_IDS = ['ams1-1', 'ams1-2', 'ams1-3', 'ams1-4', 'ext'];
const SLOT_LABEL = { 'ams1-1': 'AMS slot 1', 'ams1-2': 'AMS slot 2', 'ams1-3': 'AMS slot 3', 'ams1-4': 'AMS slot 4', ext: 'External spool' };
// server.js DEFAULT_SLOTS
const DEFAULT_SLOTS = [{ id: 'ams1-1', label: 'AMS slot 1', type: '', color: '#ffffff' }, { id: 'ams1-2', label: 'AMS slot 2', type: '', color: '#ffffff' },
  { id: 'ams1-3', label: 'AMS slot 3', type: 'PETG', color: '#2e9e5b' }, { id: 'ams1-4', label: 'AMS slot 4', type: '', color: '#ffffff' }, { id: 'ext', label: 'External spool', type: '', color: '#ffffff' }];
const MACHINE_NAME = 'Bambu Lab X2D 0.4 nozzle';

// chat.js:56-63, unchanged.
const first = (v) => (Array.isArray(v) ? v[0] : v);
const numOf = (v) => { const x = Number(first(v)); return Number.isFinite(x) ? x : undefined; };
function filamentCtx(f) {
  const plateTemps = {};
  for (const k of ['cool_plate_temp', 'eng_plate_temp', 'hot_plate_temp', 'textured_plate_temp', 'textured_cool_plate_temp', 'supertack_plate_temp']) plateTemps[k] = numOf(f[k]);
  const t = first(f.filament_type);
  return { filament: { type: t == null ? undefined : String(t), tempLow: numOf(f.nozzle_temperature_range_low), tempHigh: numOf(f.nozzle_temperature_range_high), maxVolumetricSpeed: numOf(f.filament_max_volumetric_speed), plateTemps } };
}
// Per-object settings (founder 2026-11-13: "the variables should be assigned to 1 object"). ONLY keys 2bee.fdm applies
// per object (fdmslice --oset): the ones its per-object planning reads. Everything else stays plate-wide.
const OBJECT_KEYS = Object.freeze({
  wall_loops: /^(?:[0-9]|[1-4][0-9]|50)$/,
  top_shell_layers: /^(?:[0-9]|[1-4][0-9]|50)$/,
  bottom_shell_layers: /^(?:[0-9]|[1-4][0-9]|50)$/,
  sparse_infill_density: /^(?:100|[1-9]?[0-9])%$/,
});
function cleanObjectOverrides(o, i) {
  const ov = o && o.overrides;
  if (ov === undefined || ov === null) return {};
  if (typeof ov !== 'object' || Array.isArray(ov)) throw new Error(`object ${i + 1}: overrides must be an object`);
  const out = {};
  for (const [k, v] of Object.entries(ov)) {
    if (!OBJECT_KEYS[k]) throw new Error(`object ${i + 1}: ${k} cannot be set per object (only ${Object.keys(OBJECT_KEYS).join(', ')}); set it for the whole plate`);
    if (!OBJECT_KEYS[k].test(String(v))) throw new Error(`object ${i + 1}: bad value for ${k}: ${String(v).slice(0, 20)}`);
    // 🔴 The plate-wide range applies per object too (2026-11-14). The pattern above allows 0-50, so wall_loops "0"
    // sliced a part with NO perimeters and said nothing, while the same value plate-wide is 1-10. Per object nothing
    // is clamped: out of range is refused, naming the range.
    const r = A.validate(k, String(v));
    if (!r.ok || r.status !== 'accepted') throw new Error(`object ${i + 1}: ${k} = ${String(v).slice(0, 20)} is not allowed (${r.reason || 'refused'})`);
    out[k] = String(v);
  }
  return out;
}
// jobs.cleanJob, plus each object's per-object `overrides`, in cleanJob's own order (qty copies share them).
function cleanJobO(body, opts) {
  const job = jobs.cleanJob(body, opts);
  const per = [];
  (Array.isArray(body.objects) ? body.objects : []).forEach((o, i) => {
    const q = o && o.qty !== undefined && o.qty !== null && o.qty !== '' ? Number(o.qty) : 1;
    const ov = cleanObjectOverrides(o, i);
    const n = opts && opts.keepQty ? 1 : q;
    for (let k = 0; k < n; k++) per.push(ov);
  });
  if (per.length !== job.objects.length) throw new Error('per-object settings do not line up with the objects');
  job.objects.forEach((o, i) => { if (Object.keys(per[i]).length) o.overrides = per[i]; });
  return job;
}

const clampNote = (c) => `${c.key}: asked ${c.from}, sliced with ${c.to} (${c.reason})`;
function applyOverrides(proc, fil, overrides) { return A.applyToProfiles(proc, fil, overrides, filamentCtx(fil)); }

/** The slots file: { bedPlate, slots:[{id,label,type,color}] }. Missing or unreadable -> the defaults (said by `source`). */
function readSlotsFile(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const v = validateSlots(j);
    return { ...v, source: 'file' };
  } catch (e) {
    return { bedPlate: DEFAULT_BED_PLATE, slots: DEFAULT_SLOTS.map((s) => ({ ...s })), source: fs.existsSync(file) ? 'defaults (file unreadable: ' + e.message + ')' : 'defaults' };
  }
}
/** Validate a PUT /v1/slots body. Throws with a reason; never coerces. */
function validateSlots(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new Error('body must be a JSON object {bedPlate?, slots:[...]}');
  const bedPlate = b.bedPlate === undefined ? DEFAULT_BED_PLATE : b.bedPlate;
  if (!BED_PLATES.includes(bedPlate)) throw new Error('bedPlate must be one of: ' + BED_PLATES.join(', '));
  if (!Array.isArray(b.slots) || !b.slots.length || b.slots.length > SLOT_IDS.length) throw new Error('slots must be a list of 1 to ' + SLOT_IDS.length + ' entries');
  const seen = new Set(), slots = [];
  b.slots.forEach((s, i) => {
    if (!s || typeof s !== 'object') throw new Error('slot ' + i + ' is not an object');
    if (!SLOT_IDS.includes(s.id)) throw new Error('slot ' + i + ': id must be one of ' + SLOT_IDS.join(', '));
    if (seen.has(s.id)) throw new Error('slot ' + s.id + ' is listed twice'); seen.add(s.id);
    if (typeof s.type !== 'string' || !FILAMENT_TYPES.includes(s.type)) throw new Error('slot ' + s.id + ': filament type not in the list (' + FILAMENT_TYPES.filter(Boolean).join(', ') + ', or empty)');
    if (typeof s.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(s.color)) throw new Error('slot ' + s.id + ': colour must be #rrggbb');
    slots.push({ id: s.id, label: SLOT_LABEL[s.id], type: s.type, color: s.color.toLowerCase() });
  });
  slots.sort((x, y) => SLOT_IDS.indexOf(x.id) - SLOT_IDS.indexOf(y.id));
  return { bedPlate, slots };
}
function writeSlotsFile(file, body) {
  const v = validateSlots(body);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(v, null, 1));
  fs.renameSync(tmp, file);
  return v;
}

const ENGINES = ['twobee-fdm', 'orca'];
const ENGINE_LABEL = { 'twobee-fdm': '2bee.fdm (this app\'s own engine)', orca: 'OrcaSlicer CLI (--engine orca)' };

function createEngine(opts) {
  const ENGINE = opts.engine || 'twobee-fdm';
  if (!ENGINES.includes(ENGINE)) throw new Error(`unknown engine ${ENGINE} (one of ${ENGINES.join(', ')})`);
  const WHO = ENGINE === 'orca' ? 'Orca' : '2bee.fdm';
  const FDM_BIN = opts.fdmBin;
  const FDM_DEFAULTS = opts.fdmDefaults;
  const ORCA_BIN = opts.orcaBin;
  const ORCA_CONFIG = opts.orcaConfig;
  const JOBS = opts.sliceDir;
  const SLOTS_FILE = opts.slotsFile;
  const SYS = path.join(ORCA_CONFIG, 'system/BBL');
  const USER = path.join(ORCA_CONFIG, 'user/default');
  const MACHINE_FILE = path.join(SYS, 'machine', MACHINE_NAME + '.json');
  const SLICE_TIMEOUT_MS = 5 * 60 * 1000;
  const JOB_TTL_MS = 60 * 60 * 1000; // server.js: slice folders are deleted after 1 h
  const BED_TYPES = BED_PLATES;
  const DEFAULT_BED = DEFAULT_BED_PLATE;
  const loadSlots = () => readSlotsFile(SLOTS_FILE);
  fs.mkdirSync(JOBS, { recursive: true });

  // ======================= server.js, extracted (see header) =======================
  // Bytes of STL one slice may write into its folder. Copies are written one STL each BEFORE the engine runs, and the
  // only other limit is SANE_TOTAL (100000 copies, a memory guard): a 20 MB part at qty 5000 wrote ~100 GB before
  // pruning (every 30 min, JOBS_MAX_MB) could look (bughunt 2026-11-14). Same budget as the prune: one slice that
  // alone exceeds what the folder may hold is refused, with its partial folder removed.
  const SLICE_MAX_MB = +process.env.SLICE_MAX_MB || +process.env.JOBS_MAX_MB || 1500;
  function stlBudget(dir) {
    let used = 0;
    return (tris) => {
      used += 84 + 50 * Math.ceil(tris.length / 9);
      if (used > SLICE_MAX_MB * 1024 * 1024) {
        fs.rmSync(dir, { recursive: true, force: true });
        throw new HttpError(413, `this plate's copies need more than ${SLICE_MAX_MB} MB of STL on disk: fewer copies, or a lighter mesh (SLICE_MAX_MB raises the limit)`);
      }
    };
  }

  function pruneJobs(maxAgeH = +process.env.JOBS_MAX_AGE_H || 3, maxMB = +process.env.JOBS_MAX_MB || 1500) {
    let removed = 0, freed = 0;
    try {
      const now = Date.now(), items = [];
      for (const d of fs.readdirSync(JOBS)) {
        const p = path.join(JOBS, d); let st; try { st = fs.statSync(p); } catch (e) { continue; } if (!st.isDirectory()) continue;
        const sent = fs.existsSync(path.join(p, 'remote.json')), age = (now - st.mtimeMs) / 3600000;
        let size = 0; try { for (const f of fs.readdirSync(p)) { try { size += fs.statSync(path.join(p, f)).size; } catch (e) { /* gone */ } } } catch (e) { /* gone */ }
        items.push({ p, age, sent, size, mtime: st.mtimeMs });
      }
      const kill = (it) => { try { fs.rmSync(it.p, { recursive: true, force: true }); removed++; freed += it.size; it.gone = true; } catch (e) { /* busy */ } };
      for (const it of items) if (it.age > (it.sent ? 24 : maxAgeH)) kill(it);
      let total = items.filter((i) => !i.gone).reduce((t, i) => t + i.size, 0);
      for (const it of items.filter((i) => !i.gone).sort((a, b) => a.mtime - b.mtime)) { if (total <= maxMB * 1048576) break; if (it.age < 0.25) continue; kill(it); total -= it.size; }
    } catch (e) { /* JOBS not there yet */ }
    if (removed) console.log(`pruned ${removed} old slice folder(s), ${(freed / 1048576).toFixed(0)} MB`);
    return { removed, freedMB: Math.round(freed / 1048576) };
  }

  const readJson = async (f) => JSON.parse(await fsp.readFile(f, 'utf8'));
  const listJson = async (dir) => (await fsp.readdir(dir).catch(() => [])).filter((f) => f.endsWith('.json'));

  async function profiles() {
    const out = { process: [], filament: [], bedTypes: BED_TYPES, defaultBed: DEFAULT_BED, bed: null };
    const m = await readJson(MACHINE_FILE);
    // 2bee_app 2026-11-13 (edit 6): each extruder's reach, as Orca's machine file states it (X2D: extruder 2 cannot
    // reach x < 20.5 and stops at 256 mm high). The plate draws the area only one nozzle reaches. Absent = not stated.
    out.bed = { area: m.printable_area, height: Number(m.printable_height),
      ...(Array.isArray(m.extruder_printable_area) ? { extruderAreas: m.extruder_printable_area.map(String) } : {}),
      ...(Array.isArray(m.extruder_printable_height) ? { extruderHeights: m.extruder_printable_height.map(Number) } : {}) };
    for (const f of await listJson(path.join(SYS, 'process'))) {
      if (/@BBL X2D\.json$/.test(f)) out.process.push({ name: f.slice(0, -5), source: 'system' });
    }
    for (const f of await listJson(path.join(USER, 'process'))) {
      const d = await readJson(path.join(USER, 'process', f)).catch(() => null);
      if (d && /X2D/.test(String(d.inherits || ''))) out.process.push({ name: f.slice(0, -5), source: 'user' });
    }
    for (const f of await listJson(path.join(SYS, 'filament'))) {
      if (f.endsWith('X2D 0.4 nozzle.json')) out.filament.push({ name: f.slice(0, -5), source: 'system' });
    }
    for (const f of await listJson(path.join(USER, 'filament'))) {
      const d = await readJson(path.join(USER, 'filament', f)).catch(() => null);
      if (!(d && (d.compatible_printers || []).includes(MACHINE_NAME))) continue;
      try { await flatten('filament', d); } catch (e) { console.error('filament preset not offered (' + f + '): ' + e.message); continue; }
      out.filament.push({ name: f.slice(0, -5), source: 'user' });
    }
    out.byFilamentId = await filamentIdMap();
    for (const k of ['process', 'filament']) out[k].sort((a, b) => (a.source === b.source ? a.name.localeCompare(b.name) : a.source === 'user' ? -1 : 1));
    return out;
  }

  function pickFile(kind, name) {
    // name must be a bare profile name; reject anything that could leave the preset directories
    if (!name || /[\/\\]|\.\./.test(name)) throw new HttpError(400, `bad ${kind} name`);
    for (const base of [path.join(USER, kind), path.join(SYS, kind)]) {
      const f = path.join(base, name + '.json');
      if (fs.existsSync(f)) return f;
    }
    throw new HttpError(404, `${kind} profile not found: ${name}`);
  }

  // The CLI resolves a user preset's "inherits" by loose name match and can pick the wrong parent (measured: a PETG
  // preset inheriting "... X2D 0.4 nozzle" got the 0.2-nozzle flow limit, 2 mm3/s). Flatten the chain here instead.
  async function flatten(kind, json) {
    const chain = [json];
    for (let cur = json, n = 0; cur.inherits && n < 10; n++) {
      let parent = null;
      for (const base of [path.join(USER, kind), path.join(SYS, kind)]) {
        const f = path.join(base, cur.inherits + '.json');
        if (fs.existsSync(f)) { parent = await readJson(f); break; }
      }
      if (!parent) throw new HttpError(500, `${kind} parent not found: ${cur.inherits}`);
      chain.push(parent); cur = parent;
    }
    const flat = Object.assign({}, ...chain.reverse());
    delete flat.inherits;
    return flat;
  }

  class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

  let queue = Promise.resolve(); // one slice at a time: CLI is CPU heavy and jobs must not share state
  const enqueue = (fn) => { const p = queue.then(fn, fn); queue = p.catch(() => {}); return p; };

  function run(cmd, args, cwd, cap = 200000) {
    return new Promise((resolve) => {
      const p = spawn(cmd, args, { cwd, env: { ...process.env, LC_ALL: 'C' } });
      let log = '';
      const add = (b) => { log += b; if (log.length > cap) log = log.slice(-Math.floor(cap / 2)); };
      p.stdout.on('data', add); p.stderr.on('data', add);
      const t = setTimeout(() => p.kill('SIGKILL'), SLICE_TIMEOUT_MS);
      p.on('close', (code, sig) => { clearTimeout(t); resolve({ code, sig, log }); });
      p.on('error', (e) => { clearTimeout(t); resolve({ code: -1, sig: null, log: String(e) }); });
    });
  }

  function gcodeStats(text) {
    const g = (re) => { const m = text.match(re); return m ? m[1].trim() : null; };
    return {
      totalTime: g(/total estimated time: ([^;\n]+)/),
      printTime: g(/^; model printing time: ([^;\n]+)/m),
      layers: g(/^; total layer number: (\d+)/m),
      filamentMm: g(/^; filament used \[mm\] = (.+)$/m),
      filamentCm3: g(/^; filament used \[cm3\] = (.+)$/m),
      filamentG: g(/^; filament used \[g\] = (.+)$/m),
      bedType: g(/^; curr_bed_type = (.+)$/m),
      nozzleTemp: g(/^; nozzle_temperature = (.+)$/m),
      layerHeight: g(/^; layer_height = (.+)$/m),
    };
  }

  // ---------------- multi-object job (M1) ----------------
  // body = a job (see jobs.js): files uploaded earlier via /api/job/upload, objects with slot + optional placement, slotPresets, overrides.
  // arrange-only (sliceIt=false): Orca arranges and exports a 3mf, no G-code (fast); sliceIt=true: full slice. Either way the placement
  // is read back from Orca's own 3mf. Objects with placements are passed as pre-positioned STLs and Orca's arrange is switched off.
  const TYPE_RE = /PETG-CF|PLA-CF|PA-CF|PETG|PLA|ASA|ABS|TPU|PVA|HIPS|PC|PA\b/;
  // Bambu filament id (what the printer reports for an installed filament, e.g. GFG99 generic PETG, GFB98 generic ASA) -> Orca X2D 0.4 preset.
  let FID_MAP = null;
  async function filamentIdMap() {
    if (FID_MAP) return FID_MAP;
    const m = {};
    for (const f of await listJson(path.join(SYS, 'filament'))) {
      if (!f.endsWith('X2D 0.4 nozzle.json')) continue;
      try { const j = await flatten('filament', await readJson(path.join(SYS, 'filament', f))); const id = String([].concat(j.filament_id || [])[0] || '');
        if (id) { const name = f.slice(0, -5); if (!m[id] || (/^Generic /.test(name) && !/^Generic /.test(m[id]))) m[id] = name; } } catch (e) { /* skip */ }
    }
    return (FID_MAP = m);
  }
  async function autoPresetFor(type, idx) {
    if (idx) { const hit = (await filamentIdMap())[idx]; if (hit) return hit; }
    const n = `Generic ${type} @BBL X2D 0.4 nozzle`;
    if (fs.existsSync(path.join(SYS, 'filament', n + '.json'))) return n;
    throw new HttpError(400, `no filament preset chosen for a ${type} slot and no "${n}" preset to fall back to`);
  }
  // Fixed placements switch Orca's arrange off, and with it the arrange step that also places the prime tower (it then
  // defaults to a spot that can fall outside the bed: measured "Prime Tower is partially outside the printable area").
  // Pick a free 40 x 40 mm spot, back-right first, clear of every object by 3 mm.
  function chooseTower(bedArea, boxes) { // widest clearance first: tall parts close to the tower give Orca's "G-code conflicts" (extruder clearance)
    for (const gap of [35, 20, 3]) { const t = chooseTowerGap(bedArea, boxes, gap); if (t) return t; }
    return null;
  }
  function chooseTowerGap(bedArea, boxes, gap) {
    const pts = bedArea.map((q) => q.trim().split('x').map(Number));
    const x0 = Math.min(...pts.map((q) => q[0])), x1 = Math.max(...pts.map((q) => q[0])), y0 = Math.min(...pts.map((q) => q[1])), y1 = Math.max(...pts.map((q) => q[1]));
    const W = 40, M = 5, LIM = 55; // LIM: measured, a tower origin beyond bed max - 55 is reported "partially outside the printable area" (200 ok, 205 not)
    for (let y = y1 - LIM; y >= y0 + M; y -= 4) for (let x = x1 - LIM; x >= x0 + M; x -= 4) {
      if (boxes.every((b) => x + W < b.min[0] - gap || x > b.max[0] + gap || y + W < b.min[1] - gap || y > b.max[1] + gap)) return { x, y };
    }
    return null;
  }
  async function runJobOrca(body, sliceIt, reduced, extra) {
    let job; try { job = cleanJobO(body); } catch (e) { throw new HttpError(400, e.message); }
    if (job.objects.some((o) => o.overrides)) throw new HttpError(400, 'per-object settings need the 2bee.fdm engine; this bridge runs Orca');
    if (sliceIt && job.objects.some((o) => o.parts) && !job.objects.every((o) => o.placement)) {
      // a group is sliced from a plate 3MF with FIXED placements: arrange first (Orca arranges the groups' merged shapes), then slice exactly there
      const ar = await runJob(body, false, reduced);
      if (!ar.ok || ar.leftover) return ar;
      return runJob({ ...body, objects: job.objects.map((o, i) => ({ ...o, placement: ar.objects[i].placement })) }, true, true);
    }
    const bed = job.bed || loadSlots().bedPlate; // the bed plate belongs to the printer; job.bed is an explicit override
    if (!BED_TYPES.includes(bed)) throw new HttpError(400, 'bad bed type');
    const procFile = pickFile('process', job.process);
    const slots = loadSlots().slots;
    const slotOrder = [...new Set(job.objects.flatMap(jobs.objectSlots))]; // filament id n+1 = slotOrder[n] (a group contributes every member's slot)
    const id = crypto.randomBytes(8).toString('hex');
    const dir = path.join(JOBS, id);
    await fsp.mkdir(dir, { recursive: true });
    // process
    const p = await flatten('process', await readJson(procFile)); p.type = 'process'; p.curr_bed_type = bed;
    if (!p.compatible_printers) p.compatible_printers = [MACHINE_NAME];
    if (job.objects.every((o) => o.placement) && slotOrder.length > 1 && job.overrides.wipe_tower_x === undefined) {
      const boxes = [];
      for (const o of job.objects) boxes.push(jobs.placeMesh((await jobs.objectMesh(job, o)).tris, o.placement.rot, o.placement.x, o.placement.y, o.placement.tilt).bbox);
      const m = await readJson(MACHINE_FILE);
      const t = chooseTower(m.printable_area, boxes);
      if (!t) throw new HttpError(409, 'no free spot for the prime tower on the plate: move or remove an object');
      p.wipe_tower_x = String(t.x); p.wipe_tower_y = String(t.y);
    }
    // one filament preset per distinct slot
    const filFiles = [], filaments = [], slotChecks = [];
    for (let n = 0; n < slotOrder.length; n++) {
      const sl = slots.find((s) => s.id === slotOrder[n]);
      if (!sl || !sl.type) throw new HttpError(400, `slot ${slotOrder[n]} has no filament declared`);
      let preset = job.slotPresets[sl.id] || await autoPresetFor(sl.type, sl.idx), f;
      try { f = await flatten('filament', await readJson(pickFile('filament', preset))); }
      catch (e) { // e.g. a user preset whose parent preset no longer exists: fall back to the generic one, visibly
        const fb = await autoPresetFor(sl.type, sl.idx);
        if (fb === preset) throw e;
        (job.__warnings = job.__warnings || []).push(`filament preset "${preset}" cannot be built (${e.message}); using "${fb}" for ${sl.label || sl.id}`);
        preset = fb; f = await flatten('filament', await readJson(pickFile('filament', preset)));
      }
      f.type = 'filament';
      if (!f.compatible_printers) f.compatible_printers = [MACHINE_NAME];
      // Measured: with 2+ filaments and no filament_colour Orca's X2D grouping crashes (SIGSEGV in select_best_group_for_ams).
      const col = (sl.color || '#ffffff').toUpperCase();
      f.filament_colour = [col]; f.default_filament_colour = [col];
      const presetType = String([].concat(f.filament_type || [])[0] || (preset.toUpperCase().match(TYPE_RE) || [''])[0]);
      slotChecks.push({ slot: sl.id, slotType: sl.type, preset, presetType, ok: !presetType || presetType === sl.type });
      if (Object.keys(job.overrides).length) {
        const rep = applyOverrides(p, f, job.overrides);
        if (rep.refused && rep.refused.length) throw new HttpError(400, 'override refused: ' + rep.refused.map((x) => x.key + ' (' + x.reason + ')').join('; '));
        if (n === 0) { job.__applied = rep.accepted; for (const c of rep.clamped || []) (job.__warnings = job.__warnings || []).push(clampNote(c)); }
      }
      const ff = path.join(dir, `filament_${n + 1}.json`);
      await fsp.writeFile(ff, JSON.stringify(f)); filFiles.push(ff);
      filaments.push({ id: n + 1, slot: sl.id, slotLabel: sl.label, type: sl.type, color: col, preset });
    }
    await fsp.writeFile(path.join(dir, 'process.json'), JSON.stringify(p));
    // objects
    const objFiles = [], names = [], allPlaced = job.objects.every((o) => o.placement), spend = stlBudget(dir);
    for (let i = 0; i < job.objects.length; i++) {
      const o = job.objects[i], mesh = await jobs.objectMesh(job, o);
      if (!mesh) throw new HttpError(404, `a file of object ${i + 1} is not on the server any more (upload it again)`);
      spend(mesh.tris);
      const name = `o${i + 1}-${jobs.safeName(jobs.objectName(job, o)).replace(/\.stl$/i, '')}.stl`;
      let out;
      if (allPlaced) out = jobs.writeBinaryStl(jobs.placeMesh(mesh.tris, o.placement.rot, o.placement.x, o.placement.y, o.placement.tilt).tris);
      else if (o.parts) out = jobs.writeBinaryStl(mesh.tris); // a group, arrange only: its merged shape (union footprint) is all Orca needs to place it
      else out = await jobs.getUpload(job.files[o.file].sha256);
      await fsp.writeFile(path.join(dir, name), out); objFiles.push(path.join(dir, name)); names.push(name);
    }
    const ids = job.objects.map((o) => slotOrder.indexOf(o.slot) + 1);
    const hasGroup = sliceIt && allPlaced && job.objects.some((o) => o.parts);
    let plate3mf = null;
    if (hasGroup) { // one plate 3MF: every object (a group = one object with one volume per member, each with its own extruder) at its fixed placement
      const g = await bedGeometry(), list = [];
      for (let i = 0; i < job.objects.length; i++) {
        const o = job.objects[i], mem = o.parts || [{ file: o.file, slot: o.slot }], parts = [];
        for (const m of mem) parts.push({ buffer: await jobs.getUpload(job.files[m.file].sha256), name: jobs.safeName(job.files[m.file].name).replace(/\.stl$/i, ''), extruder: slotOrder.indexOf(m.slot) + 1 });
        list.push({ parts, placement: { x: o.placement.x, y: o.placement.y, rot: o.placement.rot || 0 }, name: names[i].replace(/\.stl$/i, '') });
      }
      plate3mf = path.join(dir, 'plate.3mf');
      try { multipart.buildPlate3mf({ objects: list, plateSize: [g.w, g.d], outPath: plate3mf }); }
      catch (e) { throw new HttpError(500, 'could not build the plate 3MF for the group: ' + e.message); }
    }
    const args = ['--load-settings', `${MACHINE_FILE};${path.join(dir, 'process.json')}`, '--load-filaments', filFiles.join(';')];
    if (slotOrder.length > 1 && !plate3mf) args.push('--load-filament-ids', ids.join(','));
    args.push('--orient', '0', '--arrange', allPlaced ? '0' : '1');
    if (extra && extra.allowRotations && !allPlaced) args.push('--allow-rotations');
    if (sliceIt) args.push('--slice', '0');
    args.push('--export-3mf', 'job.gcode.3mf', '--outputdir', dir, ...(plate3mf ? [plate3mf] : objFiles));
    const t0 = Date.now();
    const r = await enqueue(() => run(ORCA_BIN, args, dir));
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const result = await readJson(path.join(dir, 'result.json')).catch(() => null);
    const gfile = path.join(dir, 'plate_1.gcode'), tmf = path.join(dir, 'job.gcode.3mf');
    // A refused slice keeps its id (the log is useful) but NOT its G-code: GET /v1/gcode/<id> must not serve what was refused.
    const fail = (extra) => (fs.rmSync(gfile, { force: true }), fs.rmSync(tmf, { force: true }), { ok: false, id, seconds: secs, error: (result && result.error_string) || `orca-slicer exit ${r.code}${r.sig ? ' ' + r.sig : ''}`, log: r.log.split('\n').filter((l) => l && !/wp_brim/.test(l)).slice(-12).join('\n'), ...extra });
    if (r.code !== 0 || !fs.existsSync(tmf) || (sliceIt && !fs.existsSync(gfile))) return fail({});
    // Everything on ONE bed: Orca puts what does not fit on plate 2, 3...  Keep what is on plate 1, re-run with only those objects, report the rest.
    if (!allPlaced && !reduced) {
      const plates = await jobs.platesOf(tmf);
      if (plates.length > 1) {
        const keep = new Set(((plates.find((p0) => p0.plate === 1) || plates[0]).objects).map((n) => Number((n.match(/^o(\d+)-/) || [0, 0])[1]) - 1));
        const keptIdx = job.objects.map((o, i) => i).filter((i) => keep.has(i)), leftIdx = job.objects.map((o, i) => i).filter((i) => !keep.has(i));
        if (keptIdx.length && leftIdx.length) {
          const sub = await runJob({ ...body, objects: body.objects.filter((o, i) => keep.has(i)) }, sliceIt, true, extra);
          if (sub.ok) {
            sub.objects.forEach((o, k) => { o.index = keptIdx[k]; });
            sub.leftover = leftIdx.map((i) => ({ index: i, name: job.files[job.objects[i].file].name }));
            sub.fitted = keptIdx.length; sub.total = job.objects.length;
          }
          return sub;
        }
      }
    }
    // placement read-back from Orca's 3mf (a fixed placement is read back too: it must come out as it went in)
    const pl = await jobs.readPlacement(tmf);
    if (!pl || pl.length !== job.objects.length) return fail({ error: `could not read ${job.objects.length} object placements from Orca's 3mf (got ${pl ? pl.length : 'none'})` });
    const objects = [], warnings = [...(job.__warnings || [])];
    for (let i = 0; i < job.objects.length; i++) {
      const src = (await jobs.objectMesh(job, job.objects[i])).tris;
      // arranged by Orca: its read-back. Fixed: the baked STLs carry the rotation, so Orca's 3mf shows rot 0 about a different pivot:
      // keep the requested placement and let the plate bbox cross-check below prove it landed.
      const got = allPlaced ? { ...job.objects[i].placement } : { x: jobs.round(pl[i].x, 2), y: jobs.round(pl[i].y, 2), rot: jobs.round(pl[i].rot, 2) };
      const fp = jobs.placeMesh(src, got.rot, got.x, got.y, got.tilt);
      objects.push({ index: i, name: jobs.objectName(job, job.objects[i]), file: job.objects[i].file, slot: job.objects[i].slot, ...(job.objects[i].parts ? { parts: job.objects[i].parts } : {}), filament: ids[i], placement: got,
        footprint: { w: jobs.round(fp.footprint.w, 2), d: jobs.round(fp.footprint.d, 2), h: jobs.round(fp.footprint.h, 2) },
        bbox: { min: fp.bbox.min.map((v) => jobs.round(v, 2)), max: fp.bbox.max.map((v) => jobs.round(v, 2)) } });
    }
    fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({ name: job.name, printerId: job.printerId || null, objects: objects.length, slots: slotOrder, filaments, files: names, sliced: !!sliceIt }));
    const out = { ok: true, id, seconds: secs, arrangedByOrca: !allPlaced, objects, filaments, slotChecks, warnings, multiFilament: slotOrder.length > 1, appliedOverrides: job.__applied || null };
    if (!sliceIt) return out;
    const text = await fsp.readFile(gfile, 'utf8');
    out.stats = gcodeStats(text);
    out.analysis = jobs.analyseGcode(text);
    const warn = result && result.sliced_plates && result.sliced_plates[0] && result.sliced_plates[0].warning_message;
    if (warn) warnings.push(warn);
    const pj = JSON.parse((await jobs.readPlateJson(tmf)) || 'null');
    if (pj) {
      const wt = (pj.bbox_objects || []).find((b) => b.name === 'wipe_tower');
      if (wt) out.wipeTower = { bbox: wt.bbox };
      // cross-check: Orca's own object bboxes against the footprints computed from the read-back placement
      (pj.bbox_objects || []).filter((b) => b.name !== 'wipe_tower').forEach((b, k) => {
        const nm = String(b.name || '').match(/^o(\d+)-/), i = nm ? Number(nm[1]) - 1 : k; // Orca may list the objects in another order: match by the object name o<N>-
        const o = objects[i]; if (!o) return;
        // compare CENTRES: Orca's object box includes a brim, which grows the corners but not the centre
        const d = Math.max(Math.abs((b.bbox[0] + b.bbox[2]) / 2 - (o.bbox.min[0] + o.bbox.max[0]) / 2), Math.abs((b.bbox[1] + b.bbox[3]) / 2 - (o.bbox.min[1] + o.bbox.max[1]) / 2));
        if (d > 3) warnings.push(`object ${i + 1}: footprint computed from the placement differs from Orca's by ${d.toFixed(2)} mm (rotation read-back suspect)`);
      });
    }
    const sx = await jobs.readSliceInfoWarnings(tmf);
    for (const w of sx) warnings.push(w);
    out.warnings = warnings;
    out.name = job.name || 'job';
    out.bedRequested = bed; out.bedHonoured = out.stats.bedType === bed || out.stats.bedType === null ? null : false;
    return out;
  }

  // ================================ arrangement objective (candidates, real slices, measured pick) ================================
  // One bed's objects are arranged several ways (Orca default; our compact and spaced packings; rotated), each is SLICED with Orca, the G-code is measured
  // (beds.gcodeFacts + Orca's own time) and the candidate with the best score for the objective wins (beds.OBJECTIVES holds the weights). The default stays
  // unless a candidate is measurably better. The winner's slice IS the slice the page shows: nothing is sliced twice.
  const meshCache = new Map();
  async function rotBox(sha, tris, rot, tilt) { // footprint of the part (tilted, then rotated by rot about Z): { w, d, h, ox, oy } (ox,oy = bbox centre offset from the placement x,y)
    const k = sha + ':' + rot + ':' + (tilt || ''); if (meshCache.has(k)) return meshCache.get(k);
    const pl = jobs.placeMesh(tris, rot, 0, 0, tilt), b = pl.bbox;
    const r = { w: b.max[0] - b.min[0], d: b.max[1] - b.min[1], h: b.max[2] - b.min[2], ox: (b.max[0] + b.min[0]) / 2, oy: (b.max[1] + b.min[1]) / 2 };
    if (meshCache.size > 400) meshCache.clear(); meshCache.set(k, r); return r;
  }
  const placeKey = (pls) => pls.map((p) => `${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.rot / 5) * 5},${(p.tilt || []).join('/')}`).join(';');
  function geoFacts(objs, g) { // centre = mean distance of the parts from the bed centre; tall = slender-and-tall risk, worse far from the centre
    const cx = (g.x0 + g.x1) / 2, cy = (g.y0 + g.y1) / 2, half = Math.hypot(g.w, g.d) / 2; let dsum = 0, tall = 0;
    for (const o of objs) {
      const mx = (o.bbox.min[0] + o.bbox.max[0]) / 2, my = (o.bbox.min[1] + o.bbox.max[1]) / 2, dist = Math.hypot(mx - cx, my - cy);
      dsum += dist; tall += Math.max(0, o.footprint.h / Math.max(1, Math.min(o.footprint.w, o.footprint.d)) - 3) * (1 + dist / half);
    }
    return { centre: Math.round(dsum / Math.max(1, objs.length) * 10) / 10, tall: Math.round(tall * 100) / 100 };
  }
  // body = the page's job body; sel = indices of the bed's objects in body.objects. -> a runJob(sliced) result for the sub-job (indices 0..sel.length-1) + res.optimise
  async function optimiseBed(body, sel, objective, nBeds) {
    const t0 = Date.now(), g = await bedGeometry();
    const sub = { ...body, objects: sel.map((i) => ({ ...body.objects[i], placement: null, bed: undefined })) };
    const job = cleanJobO(sub);
    const def = await runJob(sub, false);
    if (!def.ok || def.leftover) return null; // cannot arrange as one bed: the plain path reports it
    const meshes = []; for (const o of job.objects) meshes.push(await jobs.objectMesh(job, o));
    const shas = meshes.map((m) => m.key), bufs = meshes.map((m) => m.tris);
    const defPl = def.objects.map((o) => ({ ...o.placement }));
    const gens = [{ id: 'default', label: `${WHO}'s default arrangement`, pls: defPl }];
    const FLAT_RATIO = 2.5, FLAT_GAIN = 0.35; // lay a part on its side only when it is slender (height >= 2.5 x its smaller footprint side) and that cuts its height by >= 35 %
    const pack = async (gap, mode) => { // mode: 'plain' | 'rotate' (smallest footprint about Z) | 'flat' (tall slender parts laid on their side)
      const items = [], picks = [];
      for (let i = 0; i < job.objects.length; i++) {
        let best = { rot: 0, tilt: null, ...(await rotBox(shas[i], bufs[i], 0, null)) };
        if (mode === 'rotate') {
          const mf = beds.minFootprint(bufs[i], null);
          for (const r of [90, mf.rot]) { const b = await rotBox(shas[i], bufs[i], r, null); if (b.w * b.d < best.w * best.d * 0.9) best = { rot: r, tilt: null, ...b }; }
        } else if (mode === 'flat' && !job.objects[i].parts && best.h >= FLAT_RATIO * Math.min(best.w, best.d)) {
          for (const tl of [[90, 0], [0, 90]]) { const b = await rotBox(shas[i], bufs[i], 0, tl); if (b.h < best.h * (1 - FLAT_GAIN) && b.w <= g.w - 10 && b.d <= g.d - 10 && b.h < best.h) best = { rot: 0, tilt: tl, ...b }; }
        }
        items.push({ w: best.w, d: best.d }); picks.push(best);
      }
      const cs = beds.packRects(items, g, gap, 5); if (!cs) return null;
      return { pls: cs.map((c, i) => ({ x: jobs.round(c.cx - picks[i].ox, 2), y: jobs.round(c.cy - picks[i].oy, 2), rot: picks[i].rot, ...(picks[i].tilt ? { tilt: picks[i].tilt } : {}) })), changed: picks.filter((p) => p.rot || p.tilt).length };
    };
    const compact = await pack(5, 'plain'); if (compact) gens.push({ id: 'compact', label: 'compact, no rotation', pls: compact.pls });
    const spaced = await pack(16, 'plain'); if (spaced) gens.push({ id: 'spaced', label: 'spaced out, no rotation', pls: spaced.pls });
    const flat = job.allowTilt === false ? null : await pack(5, 'flat');
    if (flat && flat.changed) gens.push({ id: 'flat', label: `compact, ${flat.changed} tall part${flat.changed > 1 ? 's' : ''} laid on the side`, pls: flat.pls });
    const rot = !(flat && flat.changed) ? await pack(5, 'rotate') : null;
    if (rot && rot.changed) gens.push({ id: 'rotated', label: 'compact, rotated to the smallest footprint', pls: rot.pls });
    const seen = new Set(), cands = [], notes = [];
    const sliceOne = async (gen) => {
      const key = placeKey(gen.pls); if (seen.has(key)) { notes.push(`${gen.label}: identical to an earlier candidate, not sliced`); return; } seen.add(key);
      const r = await runJob({ ...sub, objects: sub.objects.map((o, i) => ({ ...o, placement: gen.pls[i] })) }, true);
      if (!r.ok) { notes.push(`${gen.label}: ${WHO} could not slice it (${String(r.error).slice(0, 80)})`); return; }
      if (r.objects.some((o) => !inBed(o, g))) { notes.push(`${gen.label}: a part ended up outside the bed`); await fsp.rm(path.join(JOBS, r.id), { recursive: true, force: true }); return; }
      const text = await fsp.readFile(path.join(JOBS, r.id, 'plate_1.gcode'), 'utf8');
      cands.push({ id: gen.id, label: gen.label, res: r, timeSec: beds.secs(r.stats.totalTime), facts: beds.gcodeFacts(text), geo: geoFacts(r.objects, g) });
    };
    // large jobs degrade gracefully: the more beds, the fewer alternative arrangements are sliced per bed (never a refusal)
    const cap = Math.min(beds.MAX_CANDIDATES, nBeds <= 4 ? 4 : nBeds <= 10 ? 3 : nBeds <= 20 ? 2 : 1);
    if (cap < Math.min(beds.MAX_CANDIDATES, gens.length)) notes.push(`This job has ${nBeds} beds, so only ${cap === 1 ? `${WHO}'s default arrangement was` : cap + ' arrangements were'} sliced per bed to keep slicing quick.`);
    for (const gen of gens.slice(0, cap)) await sliceOne(gen);
    if (!(flat && flat.changed) && !(rot && rot.changed) && cands.length < cap) { // nothing gains from our own rotation: let Orca try its rotations instead
      const o = await runJob(sub, false, false, { allowRotations: true });
      if (o.ok && !o.leftover) await sliceOne({ id: 'orca-rot', label: `${WHO}'s arrangement with rotations`, pls: o.objects.map((x) => ({ ...x.placement })) });
    }
    if (!cands.length || cands[0].id !== 'default') { for (const c of cands) await fsp.rm(path.join(JOBS, c.res.id), { recursive: true, force: true }); return null; }
    const pick = beds.pickBest(cands, objective), win = cands[pick.chosen];
    for (const c of cands) if (c !== win) await fsp.rm(path.join(JOBS, c.res.id), { recursive: true, force: true }).catch(() => {});
    await fsp.rm(path.join(JOBS, def.id), { recursive: true, force: true }).catch(() => {});
    const m = (c) => beds.metricsOf(c);
    win.res.optimise = { objective, label: beds.OBJECTIVES[objective].label, kept: pick.kept, chosen: { id: win.id, label: win.label }, tried: cands.length, notes, seconds: ((Date.now() - t0) / 1000).toFixed(1),
      reason: beds.explainPick(cands, pick, objective) + (notes.some((x) => /^This job has/.test(x)) ? ' ' + notes.find((x) => /^This job has/.test(x)) : ''),
      candidates: cands.map((c, i) => ({ id: c.id, label: c.label, chosen: c === win, score: Math.round(pick.scores[i] * 1000) / 1000, metrics: m(c) })) };
    return win.res;
  }

  // ================================ multiple beds ================================
  // A job that does not fit on one bed is planned onto several: every bed is a set of object indices that Orca really arranged onto ONE plate.
  // Orca runs one at a time (enqueue: a shared exclusive resource), so the beds are planned serially.
  let BEDGEO = null;
  async function bedGeometry() {
    if (BEDGEO) return BEDGEO;
    const m = await readJson(MACHINE_FILE), pts = m.printable_area.map((q) => q.trim().split('x').map(Number));
    const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
    BEDGEO = { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys), w: Math.max(...xs) - Math.min(...xs), d: Math.max(...ys) - Math.min(...ys), h: Number(m.printable_height) || 250 };
    return BEDGEO;
  }
  const inBed = (o, g) => o.bbox.min[0] >= g.x0 - 0.5 && o.bbox.min[1] >= g.y0 - 0.5 && o.bbox.max[0] <= g.x1 + 0.5 && o.bbox.max[1] <= g.y1 + 0.5;

  // Arrange the objects `idxs` (indices into body.objects) on ONE bed with Orca. -> { ok, placed:[{idx, placement, footprint, bbox}], leftover:[idx], id } .
  // leftover = what Orca put on its plate 2.. plus anything whose box ends up outside the bed (checked here, not trusted from Orca).
  // usePins: every object of the set carries a placement -> keep them (Orca's arrange is off) when they are inside the bed.
  async function arrangeSet(body, idxs, usePins) {
    const g = await bedGeometry();
    const pinned = usePins && idxs.every((i) => body.objects[i].placement);
    const sb = { ...body, objects: idxs.map((i) => ({ ...body.objects[i], placement: pinned ? body.objects[i].placement : null })) };
    let res = await runJob(sb, false);
    if (!res.ok) return { ok: false, error: res.error, log: res.log };
    let placed = res.objects.map((o) => ({ idx: idxs[o.index], placement: o.placement, footprint: o.footprint, bbox: o.bbox }));
    let leftover = (res.leftover || []).map((l) => idxs[l.index]);
    if (pinned && placed.some((p) => !inBed(p, g))) { // the pins do not fit this bed: let Orca arrange it instead
      res = await runJob({ ...sb, objects: sb.objects.map((o) => ({ ...o, placement: null })) }, false);
      if (!res.ok) return { ok: false, error: res.error, log: res.log };
      placed = res.objects.map((o) => ({ idx: idxs[o.index], placement: o.placement, footprint: o.footprint, bbox: o.bbox }));
      leftover = (res.leftover || []).map((l) => idxs[l.index]);
    }
    const outside = placed.filter((p) => !inBed(p, g)).map((p) => p.idx);
    placed = placed.filter((p) => inBed(p, g)); leftover = leftover.concat(outside);
    return { ok: true, placed, leftover, id: res.id, multiFilament: res.multiFilament, pinsKept: !!pinned && !outside.length };
  }


  // ---- fewer beds than Orca's arrange: our own packer, VERIFIED by a real slice at fixed placements ----
  // Orca's arrange keeps a wider distance and, on the X2D, the area both nozzles reach (x 20.5..256) than a single-nozzle job needs, so it can spend a bed for two parts that really fit
  // (measured: tray 115 x 146 + lid 115 x 151.3 -> Orca 2 beds, 6 mm apart on the full 256 mm bed slices fine as 1).
  const PACK_GAP = 6;
  async function repackFewerBeds(body, job, idxs, infos, meshes, g, orcaBeds) {
    const slotCount = new Set(idxs.flatMap((i) => jobs.objectSlots(job.objects[i]))).size;
    // one filament = one nozzle = the full 0..256 width; several filaments may use both nozzles: only x 20.5.. is reachable by both (extruder_printable_area of the X2D profile)
    const reg = { x0: slotCount > 1 ? Math.max(g.x0, 20.5) : g.x0, y0: g.y0, x1: g.x1, y1: g.y1 };
    const opts = new Map();
    for (const i of idxs) { const o = []; for (const rot of [0, 90]) { const b = await rotBox(meshes[i].key, meshes[i].tris, rot, null); o.push({ rot, ...b }); } opts.set(i, o); }
    const order = idxs.slice().sort((a, b) => infos[b].w * infos[b].d - infos[a].w * infos[a].d || a - b);
    const bins = []; // { items:[{w,d}], mem:[{i, o}] }
    for (const i of order) {
      let put = false;
      for (const bin of bins) {
        for (const o of opts.get(i)) { if (beds.packRects(bin.items.concat([{ w: o.w, d: o.d }]), reg, PACK_GAP, 3)) { bin.items.push({ w: o.w, d: o.d }); bin.mem.push({ i, o }); put = true; break; } }
        if (put) break;
      }
      if (!put) { const o = opts.get(i).find((x) => beds.packRects([{ w: x.w, d: x.d }], reg, PACK_GAP, 3)); if (!o) return null; bins.push({ items: [{ w: o.w, d: o.d }], mem: [{ i, o }] }); }
    }
    if (bins.length >= orcaBeds) return null;
    const out = [];
    for (const bin of bins) {
      const cs = beds.packRects(bin.items, reg, PACK_GAP, 3);
      const pls = bin.mem.map((m, k) => ({ x: jobs.round(cs[k].cx - m.o.ox, 2), y: jobs.round(cs[k].cy - m.o.oy, 2), rot: m.o.rot }));
      const sub = { ...body, objects: bin.mem.map((m, k) => ({ ...job.objects[m.i], placement: pls[k], bed: undefined })) };
      const r = await runJob(sub, true); // real slice at --arrange 0: it must not complain about the plate and nothing may stick out
      if (!r.ok || (r.warnings || []).some((w) => /printable|outside|collision|conflict|clearance|prime tower/i.test(w)) || r.objects.some((o) => !inBed(o, g))) return null;
      out.push({ objects: bin.mem.map((m) => m.i), placed: r.objects.map((o) => ({ idx: bin.mem[o.index].i, placement: o.placement, footprint: o.footprint, bbox: o.bbox })), id: r.id });
    }
    return { planned: out, note: `${WHO} needed ${orcaBeds} beds; packing the parts ${PACK_GAP} mm apart ${slotCount > 1 ? 'in the area both nozzles reach' : 'on the full 0-256 mm plate'} fits ${out.length} (checked with a real slice: no warnings, nothing outside the plate).` };
  }

  // body = job JSON + { strategy: 'fit'|'filament'|'balance'|'tall'|'manual', tallMm?, strict? }. strict = a bed that does not fit is an error, not repaired.
  async function planBeds(body) {
    const t0 = Date.now();
    let job; try { job = cleanJobO(body); } catch (e) { throw new HttpError(400, e.message); }
    const bad = (m) => { throw new HttpError(400, m); };
    const strategy = String(body.strategy || 'fit');
    if (strategy !== 'manual' && !beds.STRATEGIES[strategy]) bad('unknown strategy ' + strategy);
    const g = await bedGeometry(), n = job.objects.length;
    const infos = [], tooBig = [], meshesAll = [];
    for (let i = 0; i < n; i++) {
      const mesh = await jobs.objectMesh(job, job.objects[i]); meshesAll.push(mesh);
      if (!mesh) throw new HttpError(404, `file ${jobs.objectName(job, job.objects[i])} is not on the server any more (upload it again)`);
      const info = beds.objInfo(mesh.tris, [...new Set(jobs.objectSlots(job.objects[i]))].join('+'), jobs.objectName(job, job.objects[i]), g); info.slots = jobs.objectSlots(job.objects[i]); infos.push(info);
      const why = beds.tooBigReason(info, g);
      if (why) tooBig.push({ index: i, name: info.name, size: { x: jobs.round(info.w, 1), y: jobs.round(info.d, 1), z: jobs.round(info.h, 1) }, bed: { w: g.w, d: g.d, h: g.h }, reason: why });
    }
    const tooSet = new Set(tooBig.map((t) => t.index)), todo = [...Array(n).keys()].filter((i) => !tooSet.has(i));
    const pins = new Map(); job.objects.forEach((o, i) => { if (o.placement && o.bed && !tooSet.has(i)) pins.set(i, o.bed); });
    let packNote = ''; const repaired = []; const planned = []; // planned: [{ objects:[idx], placed:[...], id }]
    const addBed = (r) => planned.push({ objects: r.placed.map((p) => p.idx), placed: r.placed, id: r.id });
    const fail = (r, idxs) => { throw new HttpError(500, `${WHO} could not arrange the bed: ` + r.error + (r.log ? '\n' + r.log : '')); };

    if (strategy === 'fit' && !pins.size) {
      // Orca's own default: as many as fit on bed 1, then the rest, repeated until every object is on a bed. Each pass keeps Orca's plate-1 set.
      let remaining = todo.slice();
      while (remaining.length) {
        const r = await arrangeSet(body, remaining, false);
        if (!r.ok) { if (remaining.length === 1) { tooBig.push({ index: remaining[0], name: infos[remaining[0]].name, size: { x: jobs.round(infos[remaining[0]].w, 1), y: jobs.round(infos[remaining[0]].d, 1), z: jobs.round(infos[remaining[0]].h, 1) }, bed: { w: g.w, d: g.d, h: g.h }, reason: `${WHO} could not place it alone: ` + r.error }); remaining = []; continue; } fail(r); }
        if (!r.placed.length) { const i = remaining[0]; tooBig.push({ index: i, name: infos[i].name, size: { x: jobs.round(infos[i].w, 1), y: jobs.round(infos[i].d, 1), z: jobs.round(infos[i].h, 1) }, bed: { w: g.w, d: g.d, h: g.h }, reason: `too big for the bed: ${WHO} cannot place it even alone` + (infos[i].fitsRot && ENGINE === 'orca' ? ' (it would only fit rotated on the diagonal, and Orca does not rotate parts: rotate it in your model)' : '') }); remaining = remaining.slice(1); continue; }
        addBed(r); remaining = r.leftover.filter((i) => !r.placed.some((p) => p.idx === i));
      }
      if (planned.length > 1) { // Orca spent several beds: try OUR packer (6 mm apart, 90 degree turns, nozzle-1 area 0..256 for single-filament jobs) and keep it only if a real slice proves fewer beds fit
        const rp = await repackFewerBeds(body, job, todo.filter((i) => planned.some((pl) => pl.objects.includes(i))), infos, meshesAll, g, planned.length).catch((e) => ({ failed: e.message }));
        if (rp && rp.planned) { planned.length = 0; planned.push(...rp.planned); packNote = rp.note; }
      }
    } else {
      let bedOf = [];
      if (strategy === 'manual') { todo.forEach((i) => { bedOf[i] = job.objects[i].bed || 0; }); const mx = Math.max(1, ...todo.map((i) => bedOf[i])); todo.forEach((i) => { if (!bedOf[i]) bedOf[i] = mx; }); }
      else if (strategy === 'fit') { // with pinned objects: area based start, pins forced into their bed
        const o = todo.filter((i) => !pins.has(i)).sort((a, b) => infos[b].area - infos[a].area || a - b);
        bedOf = beds.STRATEGIES.filament.fn(infos.map((x) => ({ ...x, slot: 'x' })), o, g); // one slot label = plain next-fit by area
      } else bedOf = beds.STRATEGIES[strategy].fn(infos, todo, g, { tallMm: body.tallMm });
      for (const [i, b] of pins) bedOf[i] = b;
      // compact the numbers (pins may leave gaps)
      const usedNums = [...new Set(todo.map((i) => bedOf[i]))].sort((a, b) => a - b); todo.forEach((i) => { bedOf[i] = usedNums.indexOf(bedOf[i]) + 1; });
      for (let b = 1; b <= Math.max(1, ...todo.map((i) => bedOf[i])); b++) {
        let idxs = todo.filter((i) => bedOf[i] === b);
        while (idxs.length) {
          const r = await arrangeSet(body, idxs, true);
          if (!r.ok) fail(r);
          if (!r.leftover.length) { addBed(r); break; }
          if (body.strict) { const e = new HttpError(409, `bed ${b} does not fit: ${r.leftover.map((i) => infos[i].name + ' (object ' + i + ')').join(', ')} would not fit on it together with the rest`); e.bedFail = { bed: b, objects: r.leftover }; throw e; }
          if (!r.placed.length) { for (const i of idxs) tooBig.push({ index: i, name: infos[i].name, size: { x: jobs.round(infos[i].w, 1), y: jobs.round(infos[i].d, 1), z: jobs.round(infos[i].h, 1) }, bed: { w: g.w, d: g.d, h: g.h }, reason: `too big for the bed: ${WHO} cannot place it` + (infos[i].fitsRot && ENGINE === 'orca' ? ' (it would only fit rotated on the diagonal, and Orca does not rotate parts: rotate it in your model)' : '') }); idxs = []; break; }
          // repair: what did not fit moves to the next bed (the smallest first would take one Orca run per object; Orca already named the overflow)
          for (const i of r.leftover) { bedOf[i] = b + 1; repaired.push({ object: i, name: infos[i].name, from: b, to: b + 1 }); }
          addBed(r); break; // Orca's reduced re-run holds placements for exactly the objects that stayed on this bed
        }
      }
    }
    const bedList = planned.map((p, k) => {
      const ids = p.objects.slice().sort((a, b) => a - b);
      const time = ids.reduce((s, i) => s + infos[i].timeSec, 0);
      return { index: k + 1, objects: ids, names: ids.map((i) => infos[i].name), slots: [...new Set(ids.flatMap((i) => infos[i].slots))],
        placements: ids.map((i) => ({ object: i, ...p.placed.find((q) => q.idx === i).placement })), arrangeId: p.id,
        estimate: { timeMin: Math.round(time / 60), source: 'heuristic from volume and height, not a slice: slice the bed for the real number' } };
    });
    const assignment = Array.from({ length: n }, (_, i) => { const b = bedList.find((x) => x.objects.includes(i)); return { object: i, bed: b ? b.index : null }; });
    tooBig.sort((a, b) => a.index - b.index);
    return { ok: true, strategy, ...(packNote ? { packNote } : {}), beds: bedList, tooBig, assignment, repaired, bed: { w: g.w, d: g.d, h: g.h }, seconds: ((Date.now() - t0) / 1000).toFixed(1),
      summary: `${bedList.length} bed${bedList.length === 1 ? '' : 's'} for ${n - tooBig.length} of ${n} objects` + (tooBig.length ? `, ${tooBig.length} too big for the bed` : '') };
  }

  // For the chat: an assignment from outside (already shape-validated by beds.validateAssignment) -> really arrange every bed, strict (no repair).
  async function planBedsFromAssignment(jobBody, bedOf) {
    const b = { ...jobBody, strategy: 'manual', strict: true, objects: jobBody.objects.map((o, i) => ({ ...o, bed: bedOf[i], placement: null })) };
    try { return { ok: true, plan: await planBeds(b) }; }
    catch (e) { if (e instanceof HttpError) return { ok: false, reason: e.message }; throw e; }
  }

  // Identical beds (same parts, slots, settings; qty copies make many) are sliced ONCE: the others get a copy of that slice's folder. Key = everything the G-code depends on.
  const sliceCache = new Map();
  function sliceKey(job, sel, optimise, objective) {
    const used = new Set(sel.flatMap((i) => jobs.objectSlots(job.objects[i])));
    const slots = loadSlots().slots.filter((s) => used.has(s.id));
    const objs = sel.map((i) => { const o = job.objects[i]; return [(o.parts || [{ file: o.file, slot: o.slot }]).map((p) => [job.files[p.file].sha256, p.slot]), optimise ? 0 : o.placement, o.overrides || null]; });
    // The bed plate the engine slices for is `job.bed || slots.bedPlate` (runJob): keyed as THAT, not as `job.bed`, which
    // is normally empty — until 2026-11-14 a plate changed in the slots file reused the old plate's G-code (bed temps,
    // curr_bed_type) for an hour, measured on the real bridge. `inputsStamp` covers what the request does not carry.
    const bed = job.bed || loadSlots().bedPlate;
    return crypto.createHash('sha1').update(JSON.stringify([objs, optimise, optimise ? objective : 0, optimise ? job.allowTilt !== false : 0, job.process, bed, job.overrides, job.slotPresets, slots, inputsStamp()])).digest('hex');
  }
  // Files the G-code depends on that no request names: the engine binary, the defaults snapshot, the machine preset,
  // every USER preset (an edit in Orca's preset editor), and every SYSTEM preset file (an Orca update replaces them).
  // Size + mtime, not contents: cheap per slice, and a rebuild or an edit always moves one of them.
  function inputsStamp() {
    const st = (f) => { try { const x = fs.statSync(f); return `${x.size}:${x.mtimeMs}`; } catch { return null; } };
    const dir = (d) => { try { return fs.readdirSync(d).sort().map((n) => [n, st(path.join(d, n))]); } catch { return null; } };
    return [ENGINE, st(FDM_BIN), st(ORCA_BIN), st(FDM_DEFAULTS), st(MACHINE_FILE),
      ...['process', 'filament', 'machine'].map((k) => dir(path.join(USER, k))),
      // Every system preset FILE, not the folder: overwriting a file in place does not move its folder's mtime, so a
      // preset edited where it lives was served from the cache for an hour (measured 2026-11-14: nozzle 220 kept after
      // the file said 240). ~1,950 stats, ~11 ms on jamesave.
      ...['process', 'filament', 'machine'].map((k) => dir(path.join(SYS, k)))];
  }
  // /api/job/slice. With bedIndex: slice that bed only (the objects whose `bed` equals it), with the placements the page holds for them.
  async function sliceRoute(body) {
    const bi = body && body.bedIndex;
    let job; try { job = cleanJobO(body); } catch (e) { throw new HttpError(400, e.message); }
    const idxMap = job.objects.map((o, i) => i);
    let sel = idxMap, b = 1;
    if (bi !== undefined && bi !== null) {
      b = Number(bi); if (!Number.isInteger(b) || b < 1) throw new HttpError(400, 'bedIndex must be an integer >= 1');
      sel = idxMap.filter((i) => job.objects[i].bed === b);
      if (!sel.length) throw new HttpError(400, `bed ${b} has no objects (assign objects to beds with /api/job/beds first)`);
    }
    const sub = { ...body, objects: sel.map((i) => body.objects[i]) };
    // objective: the page asks for it (optimise:true) when no part is pinned by hand. The winner's slice is the reply, nothing is sliced twice.
    let res = null, fromCache = false;
    const key = sliceKey(job, sel, body.optimise === true, job.objective || beds.DEFAULT_OBJECTIVE), hit = sliceCache.get(key);
    if (hit && fs.existsSync(path.join(JOBS, hit.id, 'plate_1.gcode'))) { // an identical bed was sliced already: copy its folder, reuse the numbers
      const nid = crypto.randomBytes(8).toString('hex');
      await fsp.cp(path.join(JOBS, hit.id), path.join(JOBS, nid), { recursive: true });
      res = JSON.parse(hit.json); res.id = nid; res.seconds = '0.0'; res.reusedSlice = true; fromCache = true;
    }
    if (!res && body.optimise === true) res = await optimiseBed({ ...body, objects: sub.objects }, sub.objects.map((x, k) => k), job.objective || beds.DEFAULT_OBJECTIVE, new Set(job.objects.map((o) => o.bed).filter(Boolean)).size || 1);
    if (!res) res = await runJob(sub, true);
    if (!res.ok) return res;
    // 🔴 A plate that does not fit came back as the ARRANGE result (leftover list, no analysis) and crashed below with
    // "Cannot read properties of undefined (reading 'filaments')" — a 500 instead of which parts did not fit (2026-11-14).
    if ((res.leftover && res.leftover.length) || !res.analysis) {
      const kept0 = sel; (res.leftover || []).forEach((l) => { l.index = kept0[l.index]; });
      return { ok: false, id: res.id, engine: res.engine, leftover: res.leftover || [], error: `the plate does not fit: ${(res.leftover || []).length} object(s) could not be placed on the bed; nothing was sliced` };
    }
    if (!fromCache) { sliceCache.set(key, { id: res.id, json: JSON.stringify(res) }); if (sliceCache.size > 40) sliceCache.delete(sliceCache.keys().next().value); }
    // back to the job's own object numbers
    const kept = sel; res.objects.forEach((o) => { o.index = kept[o.index]; });
    if (res.leftover) res.leftover.forEach((l) => { l.index = kept[l.index]; });
    res.bedIndex = b;
    const fil = res.analysis.filaments.map((f, i) => ({ slot: (res.filaments[i] || {}).slot || '', grams: f.grams || 0 }));
    const meta = { bedIndex: b, objects: res.objects.map((o) => ({ object: o.index, placement: o.placement })),
      stats: { totalTime: res.stats.totalTime, layers: res.stats.layers, filamentG: fil }, overrides: res.appliedOverrides || job.overrides, process: job.process, slotPresets: job.slotPresets };
    await fsp.writeFile(path.join(JOBS, res.id, 'bed.json'), JSON.stringify(meta)).catch(() => {});
    return res;
  }

  async function sweep() {
    const now = Date.now();
    for (const d of await fsp.readdir(JOBS).catch(() => [])) {
      const p = path.join(JOBS, d);
      const st = await fsp.stat(p).catch(() => null);
      if (st && now - st.mtimeMs > JOB_TTL_MS) await fsp.rm(p, { recursive: true, force: true });
    }
  }
  // ======================= end of the extract =======================

  // ======================= 2bee.fdm (the default engine) =======================
  // Same reply shapes as runJobOrca, so planBeds / optimiseBed / sliceRoute above run unchanged on top of it.
  // Settings: Orca PRESET FILES under ORCA_CONFIG (machine, the job's process, one filament preset) + FDM_DEFAULTS, the
  // snapshot of the values Orca compiles in for keys no preset sets (tools/print3d-bridge/orca-defaults-x2d.config).
  // What it does NOT do (each is refused or said, never approximated): several filaments on one plate (refused: one slot
  // per plate), a prime tower, Orca's 3mf / plate.json read-back (there is none: the placement check below compares the
  // engine's own report with the placement asked for), Orca's slice_info warnings.
  function runJob(body, sliceIt, reduced, extra) { return ENGINE === 'orca' ? runJobOrca(body, sliceIt, reduced, extra) : runJobFdm(body, sliceIt, reduced, extra); }

  async function runJobFdm(body, sliceIt, reduced) {
    let job; try { job = cleanJobO(body); } catch (e) { throw new HttpError(400, e.message); }
    const allPlaced = job.objects.every((o) => o.placement);
    if (sliceIt && !allPlaced) { // arrange first, then slice exactly there (one path for the engine: fixed placements)
      const ar = await runJobFdm(body, false, reduced);
      if (!ar.ok || ar.leftover) return ar;
      const r = await runJobFdm({ ...body, objects: job.objects.map((o, i) => ({ ...o, placement: ar.objects[i].placement })) }, true, true);
      if (r.ok) r.arrangedBy = WHO;
      return r;
    }
    const bed = job.bed || loadSlots().bedPlate;
    if (!BED_TYPES.includes(bed)) throw new HttpError(400, 'bad bed type');
    pickFile('process', job.process); // validates the name; the engine resolves it itself
    const slots = loadSlots().slots;
    const slotOrder = [...new Set(job.objects.flatMap(jobs.objectSlots))];
    const id = crypto.randomBytes(8).toString('hex');
    const dir = path.join(JOBS, id);
    await fsp.mkdir(dir, { recursive: true });
    const t0 = Date.now();
    const secs = () => ((Date.now() - t0) / 1000).toFixed(1);
    // A refused slice keeps its id (the log is useful) but NOT its G-code: until 2026-11-14 GET /v1/gcode/<id> served a
    // slice refused for FDM-UNRESOLVED start/end G-code or a misplaced object for an hour; only the page declined to ask.
    const fail = (error, log = '') => (fs.rmSync(path.join(dir, 'plate_1.gcode'), { force: true }), { ok: false, id, seconds: secs(), engine: ENGINE, error, log });
    if (slotOrder.length !== 1) return fail(`2bee.fdm slices one filament per plate for now; this plate uses ${slotOrder.length} slots (${slotOrder.join(', ')}). Put its parts on one slot.`);
    const sl = slots.find((s) => s.id === slotOrder[0]);
    if (!sl || !sl.type) throw new HttpError(400, `slot ${slotOrder[0]} has no filament declared`);
    const warnings = [];
    let applied = null;
    let preset = job.slotPresets[sl.id] || await autoPresetFor(sl.type, sl.idx), f;
    try { f = await flatten('filament', await readJson(pickFile('filament', preset))); }
    catch (e) {
      const fb = await autoPresetFor(sl.type, sl.idx);
      if (fb === preset) throw e;
      warnings.push(`filament preset "${preset}" cannot be built (${e.message}); using "${fb}" for ${sl.label || sl.id}`);
      preset = fb; f = await flatten('filament', await readJson(pickFile('filament', preset)));
    }
    const presetType = String([].concat(f.filament_type || [])[0] || (preset.toUpperCase().match(TYPE_RE) || [''])[0]);
    const slotChecks = [{ slot: sl.id, slotType: sl.type, preset, presetType, ok: !presetType || presetType === sl.type }];
    const col = (sl.color || '#ffffff').toUpperCase();
    const filaments = [{ id: 1, slot: sl.id, slotLabel: sl.label, type: sl.type, color: col, preset }];
    const sets = [`curr_bed_type=${bed}`, `filament_colour=${col}`, `default_filament_colour=${col}`], fsets = [];
    if (Object.keys(job.overrides).length) {
      const sp = A.splitByScope(job.overrides, filamentCtx(f));
      if (sp.report.refused && sp.report.refused.length) throw new HttpError(400, 'override refused: ' + sp.report.refused.map((x) => x.key + ' (' + x.reason + ')').join('; '));
      // 🔴 A clamp was reported to nobody until 2026-11-14: wall_loops "0" sliced with 1, layer_height 0.4 with 0.28,
      // and bed.json kept the values as asked. Now each clamp is a warning and the applied values travel with the reply.
      for (const c of sp.report.clamped || []) warnings.push(clampNote(c));
      applied = sp.report.accepted;
      sets.push(...sp.set); fsets.push(...sp.fset);
    }
    // objects: a fixed placement is BAKED into the STL (rotation, tilt, position: jobs.placeMesh, the same function the
    // page's footprint comes from) and handed over at its own bbox centre, so the engine moves nothing.
    const names = [], args = ['--presets', '--machine', MACHINE_NAME, '--process', job.process, '--filament', preset, '--config-dir', ORCA_CONFIG, '--defaults', FDM_DEFAULTS];
    for (const kv of sets) args.push('--set', kv);
    for (const kv of fsets) args.push('--fset', kv);
    const want = [], spend = stlBudget(dir);
    for (let i = 0; i < job.objects.length; i++) {
      const o = job.objects[i], mesh = await jobs.objectMesh(job, o);
      if (!mesh) throw new HttpError(404, `a file of object ${i + 1} is not on the server any more (upload it again)`);
      spend(mesh.tris);
      const name = `o${i + 1}-${jobs.safeName(jobs.objectName(job, o)).replace(/\.stl$/i, '')}.stl`;
      const file = path.join(dir, name);
      if (allPlaced) {
        const pm = jobs.placeMesh(mesh.tris, o.placement.rot, o.placement.x, o.placement.y, o.placement.tilt);
        const c = [(pm.bbox.min[0] + pm.bbox.max[0]) / 2, (pm.bbox.min[1] + pm.bbox.max[1]) / 2];
        await fsp.writeFile(file, jobs.writeBinaryStl(pm.tris));
        want.push(c);
        args.push(`${file}@${c[0]},${c[1]}`);
      } else {
        await fsp.writeFile(file, jobs.writeBinaryStl(mesh.tris));
        args.push(file);
      }
      names.push(name);
    }
    const report = path.join(dir, 'report.json'), gfile = path.join(dir, 'plate_1.gcode');
    // Per-object settings: only on a slice (fdmslice refuses --oset with --arrange-only; they do not move anything).
    if (sliceIt) job.objects.forEach((o, i) => { for (const [k, v] of Object.entries(o.overrides || {})) args.push('--oset', `${i}:${k}=${v}`); });
    args.push('--report', report);
    // --auto-walls (2bee.fdm improve::wallfill): add wall loops where the preset's count would leave a narrow strip of
    // zig-zag infill (a 2.4 mm saucer wall against 2 loops per side). An override of wall_loops wins inside fdmslice.
    if (sliceIt) args.push('--out', gfile, '--auto-walls'); else args.push('--arrange-only');
    const r = await enqueue(() => run(FDM_BIN, args, dir));
    const rep = await readJson(report).catch(() => null);
    const tail = r.log.split('\n').filter(Boolean).slice(-12).join('\n');
    if (!rep || !rep.ok || r.code !== 0) return fail((rep && rep.error) || `fdmslice exit ${r.code}${r.sig ? ' ' + r.sig : ''}`, tail);
    const objects = [];
    if (!sliceIt) {
      const leftIdx = (rep.leftover || []);
      for (const ro of rep.objects) {
        const i = ro.input_index, src = (await jobs.objectMesh(job, job.objects[i])).tris;
        const got = { x: jobs.round(ro.pre_center[0], 2), y: jobs.round(ro.pre_center[1], 2), rot: jobs.round(((ro.rotate_z_deg % 360) + 360) % 360, 2) };
        const fp = jobs.placeMesh(src, got.rot, got.x, got.y);
        objects.push({ index: i, name: jobs.objectName(job, job.objects[i]), file: job.objects[i].file, slot: job.objects[i].slot, ...(job.objects[i].parts ? { parts: job.objects[i].parts } : {}), filament: 1, placement: got,
          footprint: { w: jobs.round(fp.footprint.w, 2), d: jobs.round(fp.footprint.d, 2), h: jobs.round(fp.footprint.h, 2) },
          bbox: { min: fp.bbox.min.map((v) => jobs.round(v, 2)), max: fp.bbox.max.map((v) => jobs.round(v, 2)) } });
      }
      objects.sort((a, b) => a.index - b.index);
      const out = { ok: true, id, seconds: secs(), engine: ENGINE, arrangedByOrca: false, arrangedBy: WHO, objects, filaments, slotChecks, warnings, multiFilament: false };
      if (leftIdx.length) { out.leftover = leftIdx.map((i) => ({ index: i, name: job.files[job.objects[i].file].name })); out.fitted = objects.length; out.total = job.objects.length; }
      return out;
    }
    const text = await fsp.readFile(gfile, 'utf8');
    // A custom-G-code template the engine could not render leaves a marker line; that file must never reach a printer.
    const unresolved = text.split('\n').filter((l) => l.includes('FDM-UNRESOLVED'));
    if (unresolved.length) return fail(`2bee.fdm could not render the printer's start/end G-code (${unresolved[0].replace(/^;\s*!*\s*/, '').slice(0, 160)}): this G-code cannot be used`, tail);
    for (let i = 0; i < job.objects.length; i++) {
      const o = job.objects[i], ro = rep.objects.find((x) => x.input_index === i);
      if (!ro) return fail(`2bee.fdm did not report object ${i + 1}: refusing the slice`, tail);
      const d = Math.max(Math.abs(ro.center[0] - want[i][0]), Math.abs(ro.center[1] - want[i][1]));
      if (d > 0.05) return fail(`object ${i + 1}: 2bee.fdm placed it ${d.toFixed(2)} mm away from where it was asked to: refusing the slice`, tail);
      const fp = jobs.placeMesh((await jobs.objectMesh(job, o)).tris, o.placement.rot, o.placement.x, o.placement.y, o.placement.tilt);
      objects.push({ index: i, name: jobs.objectName(job, o), file: o.file, slot: o.slot, ...(o.parts ? { parts: o.parts } : {}), filament: 1, placement: { ...o.placement },
        footprint: { w: jobs.round(fp.footprint.w, 2), d: jobs.round(fp.footprint.d, 2), h: jobs.round(fp.footprint.h, 2) },
        bbox: { min: fp.bbox.min.map((v) => jobs.round(v, 2)), max: fp.bbox.max.map((v) => jobs.round(v, 2)) } });
    }
    for (const iss of rep.issues || []) warnings.push(`2bee.fdm: ${iss}`);
    for (const c of rep.auto || []) warnings.push(c.value === c.old ? `2bee.fdm kept ${c.key} = ${c.old}: ${c.reason}` : `2bee.fdm set ${c.key} = ${c.value} (preset ${c.old}): ${c.reason}`);
    fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({ name: job.name, engine: ENGINE, objects: objects.length, slots: slotOrder, filaments, files: names, sliced: true, settings: rep.settings }));
    const stats = gcodeStats(text);
    return { ok: true, id, seconds: secs(), engine: ENGINE, arrangedByOrca: false, objects, filaments, slotChecks, warnings, multiFilament: false,
      appliedOverrides: applied,
      stats, analysis: jobs.analyseGcode(text), name: job.name || 'job', bedRequested: bed, bedHonoured: stats.bedType === bed || stats.bedType === null ? null : false,
      settings: rep.settings,
      // what Orca's reply carried and this engine does not compute: absent, never estimated
      notComputed: ['wipeTower (no prime tower: one filament per plate)', "Orca's plate.json object boxes (the placement is checked against the engine's own report instead)", "Orca's slice_info warnings"] };
  }
  // ======================= end 2bee.fdm =======================

  const health = () => (ENGINE === 'orca'
    ? { engine: { id: ENGINE, label: ENGINE_LABEL[ENGINE], bin: ORCA_BIN, found: fs.existsSync(ORCA_BIN), printed: false }, machine: { name: MACHINE_NAME, found: fs.existsSync(MACHINE_FILE) } }
    : { engine: { id: ENGINE, label: ENGINE_LABEL[ENGINE], bin: FDM_BIN, found: !!FDM_BIN && fs.existsSync(FDM_BIN), defaults: FDM_DEFAULTS, defaultsFound: !!FDM_DEFAULTS && fs.existsSync(FDM_DEFAULTS), printed: false },
      machine: { name: MACHINE_NAME, found: fs.existsSync(MACHINE_FILE) } });
  const gcodePath = (id) => (/^[0-9a-f]{16}$/.test(id) ? path.join(JOBS, id, 'plate_1.gcode') : null);
  return { ENGINE, WHO, profiles, runJob, planBeds, sliceRoute, pruneJobs, sweep, health, gcodePath, loadSlots, HttpError, MACHINE_FILE, JOBS };
}

module.exports = { cleanJobO, OBJECT_KEYS, createEngine, ENGINES, ENGINE_LABEL, readSlotsFile, writeSlotsFile, validateSlots, BED_PLATES, DEFAULT_BED_PLATE, FILAMENT_TYPES, SLOT_IDS, MACHINE_NAME, filamentCtx };
