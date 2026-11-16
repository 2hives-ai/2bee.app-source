// VENDORED from pnp's 2bee.3d: /home/gbacs/build/web-slicer/allowlist.js.js at commit 65227d3 (unchanged vs HEAD on 2026-10-15).
// Source sha256: 7af6e483ab1cbc2e7db5e02497676d2a9bec0f7221e7140c731d7f89ec5a010c
// Only edits: this 3-line header and require('./x') -> require('./x.cjs'). Re-vendor rather than edit; see README.md.
'use strict';
// allowlist.js - the CORE validation of the chat print job (M2). Every override key/value, from a chip or from the AI,
// goes through validate()/validateAll() BEFORE it can reach Orca. Nothing else decides what is allowed.
//
// Policy (stated, not implied):
//   - a key that is not in TABLE            -> REFUSED ("unknown key")
//   - a G-code / script bearing key         -> REFUSED, always ("never allowed"), even if someone adds it to TABLE by mistake
//   - a value of the wrong type / not in the enum / not finite -> REFUSED
//   - a number outside its range            -> CLAMPED to the nearest bound and reported (status 'clamped')
//   - a float given to an int key           -> ROUNDED and reported (status 'clamped')
// The result always names which of the three happened. Nothing is silently changed.
//
// X2D 0.4 nozzle limits come from the machine profile (measured 2026-10-14): nozzle 0.4, layer 0.08..0.28
// (min_layer_height/max_layer_height), max accel 20000 (travel 9000), max speed 1000, filament flow limit =
// filament_max_volumetric_speed (15 mm3/s for the coupon PETG; passed in ctx, may only be LOWERED, never raised).

const NOZZLE = 0.4;
const LAYER_MIN = 0.08, LAYER_MAX = 0.28;      // X2D 0.4: min_layer_height / max_layer_height of the machine profile
// Orca's own enum keys (PrintConfig.cpp s_keys_map_BedType). NOTE: web-slicer server.js BED_TYPES uses two labels Orca does not know
// ('Smooth PEI Plate / High Temp Plate', 'Cool Plate (SuperTack)'): they silently become Cool Plate.
const BED_TYPES = ['Cool Plate', 'Engineering Plate', 'High Temp Plate', 'Textured PEI Plate', 'Textured Cool Plate', 'Supertack Plate'];

const BED_TEMP_KEY = { 'Cool Plate': 'cool_plate_temp', 'Engineering Plate': 'eng_plate_temp', 'High Temp Plate': 'hot_plate_temp', 'Textured PEI Plate': 'textured_plate_temp', 'Textured Cool Plate': 'textured_cool_plate_temp', 'Supertack Plate': 'supertack_plate_temp' };
const SPARSE = ['grid', 'gyroid', 'cubic', 'triangles', 'honeycomb', 'lightning', 'crosshatch', 'line', 'adaptivecubic', 'concentric', 'rectilinear'];

// scope: 'process' keys go into process.json, 'filament' keys into filament.json (Orca ignores a filament key placed in
// process.json: measured, nozzle_temperature=200 in process.json left the G-code at 235).
const T = {};
const def = (key, o) => { T[key] = Object.assign({ key }, o); };
const spd = (key, label, max = 500, min = 5) => def(key, { scope: 'process', type: 'float', min, max, unit: 'mm/s', label });
const acc = (key, label, max = 20000, min = 100) => def(key, { scope: 'process', type: 'float', min, max, unit: 'mm/s2', label });

// adhesion
def('skirt_loops', { scope: 'process', type: 'int', min: 0, max: 5, label: 'Skirt loops' });
def('skirt_distance', { scope: 'process', type: 'float', min: 0.5, max: 10, unit: 'mm', label: 'Skirt distance' });
def('skirt_height', { scope: 'process', type: 'int', min: 1, max: 10, unit: 'layers', label: 'Skirt height' });
def('brim_type', { scope: 'process', type: 'enum', values: ['auto_brim', 'no_brim', 'outer_only', 'inner_only', 'outer_and_inner', 'brim_ears'], label: 'Brim' });
def('brim_width', { scope: 'process', type: 'float', min: 0, max: 20, unit: 'mm', label: 'Brim width' });
def('brim_object_gap', { scope: 'process', type: 'float', min: 0, max: 1, unit: 'mm', label: 'Brim gap' });
def('elefant_foot_compensation', { scope: 'process', type: 'float', min: 0, max: 1, unit: 'mm', label: 'Elephant foot compensation' });
def('curr_bed_type', { scope: 'process', type: 'enum', values: BED_TYPES, label: 'Bed plate' });
// support
def('enable_support', { scope: 'process', type: 'bool', label: 'Support' });
def('support_type', { scope: 'process', type: 'enum', values: ['normal(auto)', 'tree(auto)', 'normal(manual)', 'tree(manual)'], label: 'Support type' });
def('support_style', { scope: 'process', type: 'enum', values: ['default', 'grid', 'snug', 'tree_slim', 'tree_strong', 'tree_hybrid'], label: 'Support style' });
def('support_threshold_angle', { scope: 'process', type: 'int', min: 0, max: 90, unit: 'deg', label: 'Support overhang threshold' });
def('support_on_build_plate_only', { scope: 'process', type: 'bool', label: 'Support on build plate only' });
def('support_top_z_distance', { scope: 'process', type: 'float', min: 0.05, max: 0.4, unit: 'mm', label: 'Support top gap' });
def('support_base_pattern_spacing', { scope: 'process', type: 'float', min: 1, max: 6, unit: 'mm', label: 'Support spacing' });
def('support_interface_top_layers', { scope: 'process', type: 'int', min: 0, max: 5, label: 'Support interface layers' });
def('support_object_xy_distance', { scope: 'process', type: 'float', min: 0.1, max: 2, unit: 'mm', label: 'Support XY gap' });
// strength
def('wall_loops', { scope: 'process', type: 'int', min: 1, max: 10, label: 'Wall loops' });
def('top_shell_layers', { scope: 'process', type: 'int', min: 0, max: 20, label: 'Top layers' });
def('bottom_shell_layers', { scope: 'process', type: 'int', min: 0, max: 20, label: 'Bottom layers' });
def('top_shell_thickness', { scope: 'process', type: 'float', min: 0, max: 5, unit: 'mm', label: 'Top shell thickness' });
def('bottom_shell_thickness', { scope: 'process', type: 'float', min: 0, max: 5, unit: 'mm', label: 'Bottom shell thickness' });
def('sparse_infill_density', { scope: 'process', type: 'percent', min: 0, max: 100, label: 'Infill density' });
def('sparse_infill_pattern', { scope: 'process', type: 'enum', values: SPARSE, label: 'Infill pattern' });
// quality / speed
def('layer_height', { scope: 'process', type: 'float', min: LAYER_MIN, max: LAYER_MAX, unit: 'mm', label: 'Layer height' });
def('initial_layer_print_height', { scope: 'process', type: 'float', min: 0.1, max: 0.3, unit: 'mm', label: 'First layer height' });
spd('outer_wall_speed', 'Outer wall speed'); spd('inner_wall_speed', 'Inner wall speed'); spd('sparse_infill_speed', 'Infill speed');
spd('internal_solid_infill_speed', 'Solid infill speed'); spd('top_surface_speed', 'Top surface speed'); spd('gap_infill_speed', 'Gap infill speed');
spd('bridge_speed', 'Bridge speed'); spd('support_speed', 'Support speed'); spd('initial_layer_speed', 'First layer speed', 150);
spd('initial_layer_infill_speed', 'First layer infill speed', 200); spd('travel_speed', 'Travel speed', 1000, 20);
acc('default_acceleration', 'Default acceleration'); acc('outer_wall_acceleration', 'Outer wall acceleration'); acc('inner_wall_acceleration', 'Inner wall acceleration', 20000, 0);
acc('top_surface_acceleration', 'Top surface acceleration'); acc('initial_layer_acceleration', 'First layer acceleration', 5000); acc('travel_acceleration', 'Travel acceleration', 9000);
// travel / stringing (process side)
def('reduce_crossing_wall', { scope: 'process', type: 'bool', label: 'Avoid crossing walls' });
def('max_travel_detour_distance', { scope: 'process', type: 'float', min: 0, max: 200, unit: 'mm', label: 'Max travel detour' });
def('reduce_infill_retraction', { scope: 'process', type: 'bool', label: 'Fewer retractions in infill' });
def('seam_position', { scope: 'process', type: 'enum', values: ['nearest', 'aligned', 'aligned_back', 'back', 'random'], label: 'Seam position' });
def('ironing_type', { scope: 'process', type: 'enum', values: ['no ironing', 'top', 'topmost', 'solid'], label: 'Ironing' });
// filament scope
def('nozzle_temperature', { scope: 'filament', type: 'int', min: 190, max: 300, unit: 'C', label: 'Nozzle temperature', tempRange: true });
def('nozzle_temperature_initial_layer', { scope: 'filament', type: 'int', min: 190, max: 300, unit: 'C', label: 'First layer nozzle temperature', tempRange: true });
def('filament_retraction_length', { scope: 'filament', type: 'float', min: 0, max: 2.5, unit: 'mm', label: 'Retraction length' });
def('filament_retraction_speed', { scope: 'filament', type: 'float', min: 10, max: 60, unit: 'mm/s', label: 'Retraction speed' });
def('filament_wipe', { scope: 'filament', type: 'bool', label: 'Wipe while retracting' });
def('filament_wipe_distance', { scope: 'filament', type: 'float', min: 0, max: 5, unit: 'mm', label: 'Wipe distance' });
def('filament_z_hop', { scope: 'filament', type: 'float', min: 0, max: 1, unit: 'mm', label: 'Z hop' });
def('fan_min_speed', { scope: 'filament', type: 'int', min: 0, max: 100, unit: '%', label: 'Fan min' });
def('fan_max_speed', { scope: 'filament', type: 'int', min: 0, max: 100, unit: '%', label: 'Fan max' });
def('overhang_fan_speed', { scope: 'filament', type: 'int', min: 0, max: 100, unit: '%', label: 'Overhang fan' });
def('slow_down_layer_time', { scope: 'filament', type: 'int', min: 0, max: 60, unit: 's', label: 'Slow down below layer time' });
def('filament_max_volumetric_speed', { scope: 'filament', type: 'float', min: 1, max: 15, unit: 'mm3/s', label: 'Max volumetric speed', flowKey: true });
for (const p of ['cool_plate', 'eng_plate', 'hot_plate', 'textured_plate', 'textured_cool_plate', 'supertack_plate']) {
  // 0 in a filament profile means "this plate is not supported by this filament" (Orca refuses to slice on it): such a plate
  // temperature can be neither set nor chosen as the bed; supported plates may be tuned within 30..110 C.
  def(p + '_temp', { scope: 'filament', type: 'int', min: 30, max: 110, unit: 'C', label: p.replace('_', ' ') + ' temperature', plateTemp: p + '_temp' });
  def(p + '_temp_initial_layer', { scope: 'filament', type: 'int', min: 30, max: 110, unit: 'C', label: p.replace('_', ' ') + ' first layer temperature', plateTemp: p + '_temp' });
}
const TABLE = Object.freeze(T);

// Anything that carries G-code, a script, a template or a path is refused whatever the table says.
const GCODE_RE = /gcode|g_code|post_process|script|custom|template|notes|filename|thumbnail|macro|file|path|url|command|cmd|ams_drying|filament_start|filament_end|before_layer|layer_change|toolchange|pause_print|change_filament/i;
const isGcodeKey = (k) => GCODE_RE.test(String(k));
const NUM_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)$/;

function parseNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') { const s = v.trim().replace(/%$/, ''); return NUM_RE.test(s) ? Number(s) : null; }
  return null;
}
const fmt = (n) => String(Math.round(n * 1e6) / 1e6);

// ctx (all optional): { filament: { type, tempLow, tempHigh, maxVolumetricSpeed, plateTemps:{cool_plate_temp,...} } }
function limitsFor(spec, ctx) {
  let min = spec.min, max = spec.max, why = '';
  const fil = (ctx && ctx.filament) || {};
  if (spec.tempRange) {
    if (Number.isFinite(fil.tempHigh)) { max = Math.min(max, fil.tempHigh); why = `filament ${fil.type || ''} rated up to ${fil.tempHigh} C`.replace('  ', ' '); }
    if (Number.isFinite(fil.tempLow)) { min = Math.max(min, fil.tempLow - 15); }
  }
  if (spec.flowKey && Number.isFinite(fil.maxVolumetricSpeed)) { max = Math.min(max, fil.maxVolumetricSpeed); why = `flow limit of the filament is ${fil.maxVolumetricSpeed} mm3/s (may only be lowered)`; }
  return { min, max, why };
}

function refuse(key, value, reason) { return { key, ok: false, status: 'refused', value: null, input: value, reason }; }

function validate(key, value, ctx) {
  if (typeof key !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(key)) return refuse(String(key).slice(0, 40), value, 'invalid key name');
  if (isGcodeKey(key)) return refuse(key, value, 'G-code / script / path bearing keys are never allowed');
  if (!Object.prototype.hasOwnProperty.call(TABLE, key)) return refuse(key, value, 'unknown key (not in the allow-list)');
  const s = TABLE[key];
  if (value !== null && typeof value === 'object') return refuse(key, value, 'value must be a plain number, string or boolean');
  if (typeof value === 'string' && /[\r\n;{}\[\]$`\\]/.test(value) && s.type !== 'enum') return refuse(key, value, 'value contains forbidden characters');
  if (s.type === 'bool') {
    const v = (typeof value === 'string' ? value.trim().toLowerCase() : value);
    if (v === true || v === 1 || v === '1' || v === 'true' || v === 'yes' || v === 'on') return { key, ok: true, status: 'accepted', value: '1', scope: s.scope };
    if (v === false || v === 0 || v === '0' || v === 'false' || v === 'no' || v === 'off') return { key, ok: true, status: 'accepted', value: '0', scope: s.scope };
    return refuse(key, value, 'expected a boolean (0/1)');
  }
  if (s.type === 'enum') {
    if (typeof value !== 'string') return refuse(key, value, 'expected one of: ' + s.values.join(', '));
    const hit = s.values.find((e) => e === value.trim()) || s.values.find((e) => e.toLowerCase() === value.trim().toLowerCase());
    if (hit && key === 'curr_bed_type' && ctx && ctx.filament && ctx.filament.plateTemps) {
      const pk = BED_TEMP_KEY[hit];
      if (ctx.filament.plateTemps[pk] === 0) return refuse(key, value, `this filament is not supported on the ${hit} (${pk} is 0 in its profile); Orca would refuse to slice`);
    }
    return hit ? { key, ok: true, status: 'accepted', value: hit, scope: s.scope } : refuse(key, value, 'not an allowed value; allowed: ' + s.values.join(', '));
  }
  let n = parseNum(value);
  if (n === null) return refuse(key, value, 'expected a finite number');
  if (s.plateTemp && ctx && ctx.filament && ctx.filament.plateTemps && ctx.filament.plateTemps[s.plateTemp] === 0) return refuse(key, value, 'this filament has no setting for that plate (0 in its profile), so it is not supported on it');
  const { min, max, why } = limitsFor(s, ctx);
  let status = 'accepted', reason = '';
  if (s.type === 'int' && !Number.isInteger(n)) { n = Math.round(n); status = 'clamped'; reason = 'rounded to a whole number'; }
  if (n < min) { n = min; status = 'clamped'; reason = `below the minimum ${fmt(min)}${s.unit ? ' ' + s.unit : ''}, raised to it`; }
  else if (n > max) { n = max; status = 'clamped'; reason = `above the maximum ${fmt(max)}${s.unit ? ' ' + s.unit : ''}${why ? ' (' + why + ')' : ''}, lowered to it`; }
  return { key, ok: true, status, value: s.type === 'percent' ? fmt(n) + '%' : fmt(n), scope: s.scope, reason };
}

// Validate a whole map. Cross-key rule: first-layer height may not exceed 0.3 and, with layer_height, the pair must be
// consistent with the nozzle (layer <= 0.8 x nozzle); the machine range already enforces it (0.28 < 0.32).
function validateAll(map, ctx) {
  const out = { accepted: {}, clamped: [], refused: [], results: [] };
  if (map === null || typeof map !== 'object' || Array.isArray(map)) { out.refused.push({ key: '(root)', reason: 'overrides must be an object' }); return out; }
  for (const k of Object.keys(map).slice(0, 64)) {
    const r = validate(k, map[k], ctx);
    out.results.push(r);
    if (!r.ok) { out.refused.push({ key: r.key, value: typeof r.input === 'object' ? '(object)' : String(r.input).slice(0, 60), reason: r.reason }); continue; }
    out.accepted[k] = r.value;
    if (r.status === 'clamped') out.clamped.push({ key: k, from: String(map[k]).slice(0, 40), to: r.value, reason: r.reason });
  }
  if (Object.keys(map).length > 64) out.refused.push({ key: '(more)', reason: 'more than 64 keys, the rest were not looked at' });
  return out;
}

// Write validated overrides into the flattened Orca profile objects. Vector options in the profiles (the X2D has 4
// print variants) are filled in every position, scalars stay strings. Only keys that pass validate() are written.
function applyToProfiles(proc, fil, overrides, ctx) {
  const v = validateAll(overrides, ctx);
  for (const [k, val] of Object.entries(v.accepted)) {
    const target = TABLE[k].scope === 'filament' ? fil : proc;
    target[k] = Array.isArray(target[k]) ? target[k].map(() => val) : (TABLE[k].scope === 'filament' ? [val] : val);
  }
  return v;
}

// Split for the ?set= / ?fset= query of /api/slice style APIs (the same values, scoped).
function splitByScope(overrides, ctx) {
  const v = validateAll(overrides, ctx);
  const set = [], fset = [];
  for (const [k, val] of Object.entries(v.accepted)) (TABLE[k].scope === 'filament' ? fset : set).push(`${k}=${val}`);
  return { set, fset, report: v };
}

// Answer kind 'beds' (multiple beds): the model may only answer with an assignment of objects to bed numbers. Shape check lives in beds.js
// (pure, no I/O); the real "does each bed fit" check is an Orca arrangement done by the server before anything is applied.
function validateBedAssignment(list, nObjects, maxBeds) { return require('./beds.cjs').validateAssignment(list, nObjects, maxBeds); }


// =====================================================================================================================
// ACTIONS (bed arrangement, process preset, per-slot filament preset, default slot). Not Orca overrides: they are page
// functions of window.__job (arrange / resetArrangement / setProcess / setSlotPreset / setDefaultSlot). The same validator
// serves chips, the rule-based parser (works with the AI offline) and the AI's optional `actions` list; nothing reaches the
// page unless validateAction() accepted it. Names are matched against a catalog {processes[], filaments[], slots[{id,label,type}]}.
const ARRANGE_STRATEGIES = { fit: 'Fit as many as possible', filament: 'Group by filament', balance: 'Balance print time across beds', tall: 'Keep tall parts apart' };
const ARRANGE_OBJECTIVES = { fastest: 'Fastest', quality: 'Best quality', balanced: 'Balanced' };
const ACTION_TYPES = ['arrange', 'reset', 'process', 'slotPreset', 'defaultSlot'];

function normTokens(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/(\d+(?:\.\d+)?)\s*(mm|c|g|%)/g, '$1 $2').replace(/\bhigh[- ]flow\b/g, 'hf')
    .replace(/[^a-z0-9.]+/g, ' ').split(' ').filter(Boolean).map((t) => (/^\d+(\.\d+)?$/.test(t) ? String(Number(t)) : t.replace(/\.$/, '')));
}
const NOISE = new Set(['bbl', 'x2d', '0.4', 'nozzle', 'preset', 'the', 'a', 'an', 'filament', 'process']);
// Resolve a user's wording to one name of the list: exact (case-insens) -> all query tokens present, fewest extra tokens wins.
// Returns {ok:true, value} | {ok:false, reason, candidates[]}. Ambiguity (same number of extra tokens) is NOT guessed: it is reported.
function matchName(query, names, what) {
  names = (Array.isArray(names) ? names : []).filter((n) => typeof n === 'string');
  const q = String(query == null ? '' : query).trim();
  if (!q) return { ok: false, reason: `no ${what} name given`, candidates: [] };
  if (!names.length) return { ok: false, reason: `the list of ${what} presets is not available`, candidates: [] };
  const exact = names.find((n) => n === q) || names.find((n) => n.toLowerCase() === q.toLowerCase());
  if (exact) return { ok: true, value: exact };
  const qt = normTokens(q).filter((t) => !NOISE.has(t) || normTokens(q).length === 1);
  if (!qt.length) return { ok: false, reason: `"${q.slice(0, 60)}" is not a ${what} preset`, candidates: names.slice(0, 6) };
  const scored = names.map((n) => { const nt = normTokens(n); const has = qt.every((t) => nt.includes(t)); return { n, has, extra: nt.filter((t) => !qt.includes(t) && !NOISE.has(t)).length, hit: qt.filter((t) => nt.includes(t)).length }; });
  const full = scored.filter((x) => x.has).sort((a, b) => a.extra - b.extra);
  if (full.length && (full.length === 1 || full[0].extra < full[1].extra)) return full.length === 1 ? { ok: true, value: full[0].n } : { ok: true, value: full[0].n, note: 'took the closest name; also fit: ' + full.slice(1, 4).map((x) => x.n).join(', ') };
  if (full.length > 1) { const nat = full.filter((x) => x.extra === full[0].extra && /^bambu\b/i.test(x.n)); if (nat.length === 1) return { ok: true, value: nat[0].n, note: 'several presets fit; took the Bambu one (the printer-native preset)' }; }
  if (full.length) return { ok: false, reason: `"${q.slice(0, 60)}" matches several ${what} presets`, candidates: full.slice(0, 6).map((x) => x.n) };
  const near = scored.filter((x) => x.hit > 0).sort((a, b) => b.hit - a.hit || a.extra - b.extra).slice(0, 6).map((x) => x.n);
  return { ok: false, reason: `there is no ${what} preset called "${q.slice(0, 60)}"`, candidates: near };
}
function resolveSlot(v, slots) {
  slots = Array.isArray(slots) ? slots.filter((s) => s && typeof s.id === 'string') : [];
  const t = String(v == null ? '' : v).trim().toLowerCase();
  if (!t) return null;
  let hit = slots.find((s) => s.id.toLowerCase() === t);
  if (!hit && /^(ext|external)/.test(t)) hit = slots.find((s) => s.id === 'ext');
  if (!hit && /^\d{1,2}$/.test(t)) hit = slots.find((s) => s.id === 'ams1-' + Number(t)) || slots.find((s) => new RegExp('\\b' + Number(t) + '$').test(s.label || ''));
  return hit || null;
}
const cleanCatalog = (c) => {
  c = c && typeof c === 'object' ? c : {};
  const names = (a) => (Array.isArray(a) ? a : []).filter((x) => typeof x === 'string' && x.length <= 200).slice(0, 600);
  return { processes: names(c.processes), filaments: names(c.filaments),
    slots: (Array.isArray(c.slots) ? c.slots : []).filter((s) => s && typeof s.id === 'string' && /^[\w-]{1,16}$/.test(s.id)).slice(0, 12).map((s) => ({ id: s.id, label: String(s.label || s.id).slice(0, 40), type: String(s.type || '').slice(0, 12) })) };
};
// -> {ok:true, action:{type, ...normalized}} | {ok:false, type, reason, candidates?}. The text shown to the user ("label") is built here.
function validateAction(a, catalog) {
  const cat = cleanCatalog(catalog);
  if (!a || typeof a !== 'object' || Array.isArray(a)) return { ok: false, type: '?', reason: 'action must be an object' };
  const type = a.type;
  if (!ACTION_TYPES.includes(type)) return { ok: false, type: String(type).slice(0, 20), reason: 'unknown action type' };
  if (type === 'reset') return { ok: true, action: { type, label: 'Automatic arrangement' } };
  if (type === 'arrange') {
    const st = typeof a.strategy === 'string' ? a.strategy.toLowerCase() : null, ob = typeof a.objective === 'string' ? a.objective.toLowerCase() : null;
    if (st && ob) return { ok: false, type, reason: 'give a strategy or an objective, not both' };
    if (st) return Object.prototype.hasOwnProperty.call(ARRANGE_STRATEGIES, st) ? { ok: true, action: { type, strategy: st, label: ARRANGE_STRATEGIES[st] } } : { ok: false, type, reason: `unknown strategy; allowed: ${Object.keys(ARRANGE_STRATEGIES).join(', ')}` };
    if (ob) return Object.prototype.hasOwnProperty.call(ARRANGE_OBJECTIVES, ob) ? { ok: true, action: { type, objective: ob, label: ARRANGE_OBJECTIVES[ob] } } : { ok: false, type, reason: `unknown objective; allowed: ${Object.keys(ARRANGE_OBJECTIVES).join(', ')}` };
    return { ok: false, type, reason: 'arrange needs a strategy or an objective' };
  }
  if (type === 'process') { const m = matchName(a.name, cat.processes, 'process'); return m.ok ? { ok: true, action: { type, name: m.value, label: 'Process: ' + m.value } } : Object.assign({ type }, m); }
  const slot = resolveSlot(a.slot, cat.slots);
  if (!slot) return { ok: false, type, reason: `unknown slot "${String(a.slot).slice(0, 20)}"; known: ${cat.slots.map((s) => s.id).join(', ') || '(none)'}`, candidates: cat.slots.map((s) => s.id) };
  if (type === 'defaultSlot') return { ok: true, action: { type, slot: slot.id, slotLabel: slot.label, label: 'Default slot: ' + slot.label } };
  const m = matchName(a.preset, cat.filaments, 'filament');
  return m.ok ? { ok: true, action: { type, slot: slot.id, slotLabel: slot.label, preset: m.value, note: m.note, label: `${slot.label}: ${m.value}` } } : Object.assign({ type, slot: slot.id }, m);
}

// Rule-based reading of one sentence (no AI). Returns {actions:[raw...], handled:bool}. Raw actions still go through validateAction.
function parseCommand(text) {
  let t = ' ' + String(text == null ? '' : text).slice(0, 500).replace(/\s+/g, ' ').trim().replace(/\b(?:the\s+)?external(?:\s+spool)?\b/gi, 'slot ext') + ' ';
  const out = [];
  const lc = () => t.toLowerCase();
  const SLOT = '(?:slot|ams)\\s*(?:1-)?\\s*(\\d{1,2}|ext\\w*|external(?: spool)?)';
  // default slot first ("default slot 2"), so its number is not read as a filament slot
  let m = new RegExp('\\bdefault\\s+(?:filament\\s+)?(?:slot|ams)\\s*(?:to|is|=|:)?\\s*(?:slot\\s*)?(\\d{1,2}|ext\\w*|external)', 'i').exec(t);
  if (m) { out.push({ type: 'defaultSlot', slot: m[1] }); t = t.replace(m[0], ' '); }
  // "use PETG HF for slot 3" / "slot 3 use PETG HF" / "set slot 3 to PETG HF" / "slot 3 filament PETG HF"
  m = new RegExp('\\b(?:use|set|put|load|change|switch)\\s+(?:the\\s+)?(.+?)\\s+(?:for|in|on|to)\\s+(?:the\\s+)?' + SLOT + '\\b', 'i').exec(t);
  if (m) { out.push({ type: 'slotPreset', slot: m[2], preset: m[1].replace(/\b(filament|preset)\b/gi, '').trim() }); t = t.replace(m[0], ' '); }
  else {
    m = new RegExp('\\b' + SLOT + '\\s*(?:to|=|:|use|uses|with|filament|preset)\\s+(?:filament\\s+|preset\\s+|to\\s+)*(.+?)\\s*$', 'i').exec(t) ||
        new RegExp('\\b(?:set|change|switch)\\s+' + SLOT + '\\s+(?:filament\\s+)?(?:to\\s+)?(.+?)\\s*$', 'i').exec(t);
    if (m) { out.push({ type: 'slotPreset', slot: m[1], preset: m[2].replace(/\b(filament|preset)\b/gi, '').trim() }); t = t.replace(m[0], ' '); }
  }
  const s = lc();
  const arrangeCue = /\b(arrang\w*|layout|beds?|plates?|place|placement|pack)\b/.test(s);
  if (/\b(reset|restore|back to|undo)\b.*\b(arrang\w*|layout|placement|auto\w*)\b|\barrange\s+(it\s+)?auto\w*|\bautomatic (arrangement|layout)\b/.test(s)) out.push({ type: 'reset' });
  else if (/\bas many as (possible|you can)\b|\bfit (as )?many\b|\bfewest beds\b|\bpack (them|it)\b/.test(s)) out.push({ type: 'arrange', strategy: 'fit' });
  else if (/\b(group|sort|split)\w*\s+(them\s+)?by\s+(filament|material|colou?r)\b|\bsame (filament|material) together\b|\bone (filament|material) per bed\b/.test(s)) out.push({ type: 'arrange', strategy: 'filament' });
  else if (/\bbalanc\w*\s+(the\s+)?(print\s+)?(time|duration)\b|\bequal (print )?times?\b|\beven(ly)? (print )?time\b/.test(s)) out.push({ type: 'arrange', strategy: 'balance' });
  else if (/\b(keep|put|place)\s+tall\b|\btall (parts?|objects?|ones)\b.*\b(apart|separate\w*|different beds?)\b|\bseparate tall\b/.test(s)) out.push({ type: 'arrange', strategy: 'tall' });
  else if (arrangeCue && /\b(fastest|quickest|shortest|fast|quick|speed)\b/.test(s)) out.push({ type: 'arrange', objective: 'fastest' });
  else if (arrangeCue && /\b(best|highest|better|top)\s+quality\b|\bquality\b/.test(s)) out.push({ type: 'arrange', objective: 'quality' });
  else if (arrangeCue && /\bbalanced\b|\bbest overall\b|\bcompromise\b/.test(s)) out.push({ type: 'arrange', objective: 'balanced' });
  // process: "process 0.2mm standard", "use the 0.16mm high quality process", "switch process to 0.24mm"
  if (!out.some((x) => x.type === 'arrange' || x.type === 'reset')) {
    m = /\bprocess(?:\s+preset)?\s*(?:to|=|:|is)?\s+(.+?)\s*$/i.exec(t) || /\b(?:use|set|switch to|change to|print (?:at|with))\s+(?:the\s+)?(\d\.\d+\s*mm[\w @.\-]*?)\s*(?:process|profile|preset)?\s*$/i.exec(t);
    if (m) out.push({ type: 'process', name: m[1].replace(/\b(preset|profile|process)\b/gi, '').trim() });
  }
  return { actions: out, handled: out.length > 0 };
}
function parseAndValidate(text, catalog) {
  const p = parseCommand(text), ok = [], bad = [];
  for (const a of p.actions) { const v = validateAction(a, catalog); (v.ok ? ok : bad).push(v.ok ? v.action : Object.assign(v, { asked: a })); }
  return { handled: p.handled, actions: ok, failed: bad };
}

module.exports = { cleanCatalog, ARRANGE_STRATEGIES, ARRANGE_OBJECTIVES, ACTION_TYPES, matchName, resolveSlot, validateAction, parseCommand, parseAndValidate, validateBedAssignment, TABLE, BED_TYPES, NOZZLE, LAYER_MIN, LAYER_MAX, isGcodeKey, validate, validateAll, applyToProfiles, splitByScope };
