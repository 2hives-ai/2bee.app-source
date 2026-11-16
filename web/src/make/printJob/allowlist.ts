// The print job's allow-list: the ONLY settings a chip or the model may change
// on the 3D-printer path, and the check every one of them goes through.
//
// 🔴 SOURCE OF TRUTH: pnp's contract, `/home/gbacs/build/web-slicer/CONTRACT-chat-job.md`
// (handed to 2bee_app 2026-10-14), and the file it names, `allowlist.js` (same
// directory, read 2026-10-14). The keys, types, ranges, enums and X2D limits
// below are a PORT of that file's `TABLE`, not a second opinion. If pnp's table
// moves, this one is stale until re-ported. Measured on 2026-10-14 by
// `node -e "Object.keys(require('./allowlist.js').TABLE).length"`: **72 keys**
// (the contract's prose says 70; the code is what was ported).
//
// ⚠ ONE DELIBERATE DIFFERENCE FROM pnp, AND WHY. pnp CLAMPS an out-of-range
// number to the nearest bound (and rounds a fraction given to a whole-number
// key) and reports it. This port REFUSES both. This lane's rule is "refuse
// rather than approximate": a model that asked for a 0.5 mm layer did not ask
// for 0.28 mm, and applying 0.28 would be a setting nobody proposed. The person
// sees the refusal and its reason and can tap a chip instead.
//
// ⚠ NO FILAMENT CONTEXT. pnp narrows temperature and flow limits with the
// loaded filament's profile (`ctx.filament`). The app has no filament profile,
// so only the absolute ranges below apply here. pnp's server validates the job
// again WITH the filament context before Orca sees it (`cleanJob` → `setOk`).
//
// 🔴 G-code, script, template and path-bearing keys are refused ALWAYS, by name
// pattern, before the table is even consulted, so a key added to the table by
// mistake still cannot carry a program. The model never writes G-code (founder
// ruling, AGENTS.md § Scope: option B — settings, never G-code).

export type Scope = 'process' | 'filament';

export type KeySpec =
  | { key: string; scope: Scope; type: 'int' | 'float' | 'percent'; min: number; max: number; unit?: string; label: string }
  | { key: string; scope: Scope; type: 'bool'; label: string }
  | { key: string; scope: Scope; type: 'enum'; values: readonly string[]; label: string };

export const NOZZLE_MM = 0.4;
/** X2D 0.4 nozzle machine profile: `min_layer_height` / `max_layer_height`. */
export const LAYER_MIN_MM = 0.08;
export const LAYER_MAX_MM = 0.28;

/** OrcaSlicer's bed names (`PrintConfig.cpp` `s_keys_map_BedType`), as in pnp's table. */
export const BED_TYPES = [
  'Cool Plate',
  'Engineering Plate',
  'High Temp Plate',
  'Textured PEI Plate',
  'Textured Cool Plate',
  'Supertack Plate',
] as const;
export type BedType = (typeof BED_TYPES)[number];

const SPARSE = ['grid', 'gyroid', 'cubic', 'triangles', 'honeycomb', 'lightning', 'crosshatch', 'line', 'adaptivecubic', 'concentric', 'rectilinear'];

const T: Record<string, KeySpec> = {};
const num = (key: string, scope: Scope, type: 'int' | 'float' | 'percent', min: number, max: number, label: string, unit?: string) => {
  T[key] = { key, scope, type, min, max, label, ...(unit ? { unit } : {}) };
};
const bool = (key: string, scope: Scope, label: string) => {
  T[key] = { key, scope, type: 'bool', label };
};
const en = (key: string, scope: Scope, values: readonly string[], label: string) => {
  T[key] = { key, scope, type: 'enum', values, label };
};
const spd = (key: string, label: string, max = 500, min = 5) => num(key, 'process', 'float', min, max, label, 'mm/s');
const acc = (key: string, label: string, max = 20000, min = 100) => num(key, 'process', 'float', min, max, label, 'mm/s2');

// adhesion
num('skirt_loops', 'process', 'int', 0, 5, 'Skirt loops');
num('skirt_distance', 'process', 'float', 0.5, 10, 'Skirt distance', 'mm');
num('skirt_height', 'process', 'int', 1, 10, 'Skirt height', 'layers');
en('brim_type', 'process', ['auto_brim', 'no_brim', 'outer_only', 'inner_only', 'outer_and_inner', 'brim_ears'], 'Brim');
num('brim_width', 'process', 'float', 0, 20, 'Brim width', 'mm');
num('brim_object_gap', 'process', 'float', 0, 1, 'Brim gap', 'mm');
num('elefant_foot_compensation', 'process', 'float', 0, 1, 'Elephant foot compensation', 'mm');
en('curr_bed_type', 'process', BED_TYPES, 'Build plate');
// support
bool('enable_support', 'process', 'Support');
en('support_type', 'process', ['normal(auto)', 'tree(auto)', 'normal(manual)', 'tree(manual)'], 'Support type');
en('support_style', 'process', ['default', 'grid', 'snug', 'tree_slim', 'tree_strong', 'tree_hybrid'], 'Support style');
num('support_threshold_angle', 'process', 'int', 0, 90, 'Support overhang threshold', 'deg');
bool('support_on_build_plate_only', 'process', 'Support on build plate only');
num('support_top_z_distance', 'process', 'float', 0.05, 0.4, 'Support top gap', 'mm');
num('support_base_pattern_spacing', 'process', 'float', 1, 6, 'Support spacing', 'mm');
num('support_interface_top_layers', 'process', 'int', 0, 5, 'Support interface layers');
num('support_object_xy_distance', 'process', 'float', 0.1, 2, 'Support XY gap', 'mm');
// strength
num('wall_loops', 'process', 'int', 1, 10, 'Wall loops');
num('top_shell_layers', 'process', 'int', 0, 20, 'Top layers');
num('bottom_shell_layers', 'process', 'int', 0, 20, 'Bottom layers');
num('top_shell_thickness', 'process', 'float', 0, 5, 'Top shell thickness', 'mm');
num('bottom_shell_thickness', 'process', 'float', 0, 5, 'Bottom shell thickness', 'mm');
num('sparse_infill_density', 'process', 'percent', 0, 100, 'Infill density');
en('sparse_infill_pattern', 'process', SPARSE, 'Infill pattern');
// quality / speed
num('layer_height', 'process', 'float', LAYER_MIN_MM, LAYER_MAX_MM, 'Layer height', 'mm');
num('initial_layer_print_height', 'process', 'float', 0.1, 0.3, 'First layer height', 'mm');
spd('outer_wall_speed', 'Outer wall speed');
spd('inner_wall_speed', 'Inner wall speed');
spd('sparse_infill_speed', 'Infill speed');
spd('internal_solid_infill_speed', 'Solid infill speed');
spd('top_surface_speed', 'Top surface speed');
spd('gap_infill_speed', 'Gap infill speed');
spd('bridge_speed', 'Bridge speed');
spd('support_speed', 'Support speed');
spd('initial_layer_speed', 'First layer speed', 150);
spd('initial_layer_infill_speed', 'First layer infill speed', 200);
spd('travel_speed', 'Travel speed', 1000, 20);
acc('default_acceleration', 'Default acceleration');
acc('outer_wall_acceleration', 'Outer wall acceleration');
acc('inner_wall_acceleration', 'Inner wall acceleration', 20000, 0);
acc('top_surface_acceleration', 'Top surface acceleration');
acc('initial_layer_acceleration', 'First layer acceleration', 5000);
acc('travel_acceleration', 'Travel acceleration', 9000);
// travel / stringing (process side)
bool('reduce_crossing_wall', 'process', 'Avoid crossing walls');
num('max_travel_detour_distance', 'process', 'float', 0, 200, 'Max travel detour', 'mm');
bool('reduce_infill_retraction', 'process', 'Fewer retractions in infill');
en('seam_position', 'process', ['nearest', 'aligned', 'aligned_back', 'back', 'random'], 'Seam position');
en('ironing_type', 'process', ['no ironing', 'top', 'topmost', 'solid'], 'Ironing');
// filament scope
num('nozzle_temperature', 'filament', 'int', 190, 300, 'Nozzle temperature', 'C');
num('nozzle_temperature_initial_layer', 'filament', 'int', 190, 300, 'First layer nozzle temperature', 'C');
num('filament_retraction_length', 'filament', 'float', 0, 2.5, 'Retraction length', 'mm');
num('filament_retraction_speed', 'filament', 'float', 10, 60, 'Retraction speed', 'mm/s');
bool('filament_wipe', 'filament', 'Wipe while retracting');
num('filament_wipe_distance', 'filament', 'float', 0, 5, 'Wipe distance', 'mm');
num('filament_z_hop', 'filament', 'float', 0, 1, 'Z hop', 'mm');
num('fan_min_speed', 'filament', 'int', 0, 100, 'Fan min', '%');
num('fan_max_speed', 'filament', 'int', 0, 100, 'Fan max', '%');
num('overhang_fan_speed', 'filament', 'int', 0, 100, 'Overhang fan', '%');
num('slow_down_layer_time', 'filament', 'int', 0, 60, 'Slow down below layer time', 's');
num('filament_max_volumetric_speed', 'filament', 'float', 1, 15, 'Max volumetric speed', 'mm3/s');
for (const p of ['cool_plate', 'eng_plate', 'hot_plate', 'textured_plate', 'textured_cool_plate', 'supertack_plate']) {
  num(`${p}_temp`, 'filament', 'int', 30, 110, `${p.replace('_', ' ')} temperature`, 'C');
  num(`${p}_temp_initial_layer`, 'filament', 'int', 30, 110, `${p.replace('_', ' ')} first layer temperature`, 'C');
}

/** The allow-list. Frozen: nothing at runtime may add a key. */
export const ALLOWED: Readonly<Record<string, KeySpec>> = Object.freeze(T);
export const ALLOWED_KEYS: readonly string[] = Object.freeze(Object.keys(T));

/**
 * Anything that could carry G-code, a script, a template, a file or a path.
 * Copied from pnp's `GCODE_RE` unchanged.
 */
const GCODE_RE =
  /gcode|g_code|post_process|script|custom|template|notes|filename|thumbnail|macro|file|path|url|command|cmd|ams_drying|filament_start|filament_end|before_layer|layer_change|toolchange|pause_print|change_filament/i;
export const isGcodeKey = (k: string): boolean => GCODE_RE.test(k);

const NUM_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)$/;
/** At most this many keys are looked at in one object (pnp's cap). */
export const MAX_KEYS = 64;

export interface Refusal {
  key: string;
  why: string;
}

export interface Validation {
  /** Canonical Orca strings, keyed by allow-listed key. Only these may be applied. */
  accepted: Record<string, string>;
  refused: Refusal[];
}

const fmt = (n: number) => String(Math.round(n * 1e6) / 1e6);
const show = (v: unknown) => {
  try {
    return JSON.stringify(v)?.slice(0, 40) ?? String(v);
  } catch {
    return String(v);
  }
};

/** One key/value. `{ value }` when it may be applied, `{ why }` when it may not. */
export function validateOne(key: unknown, value: unknown): { value: string } | { why: string } {
  if (typeof key !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(key)) return { why: 'not a valid setting name' };
  if (isGcodeKey(key)) return { why: 'G-code, script and path settings are never allowed' };
  if (!Object.prototype.hasOwnProperty.call(ALLOWED, key)) return { why: 'not on the allow-list' };
  const s = ALLOWED[key];
  if (value === null || value === undefined || typeof value === 'object') return { why: 'the value must be a plain number, word or yes/no' };
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return { why: 'the value must be a plain number, word or yes/no' };
  if (typeof value === 'string' && /[\r\n;{}[\]$`\\<>]/.test(value)) return { why: `the value ${show(value)} contains characters a setting never has` };
  if (s.type === 'bool') {
    const v = typeof value === 'string' ? value.trim().toLowerCase() : value;
    if (v === true || v === 1 || v === '1' || v === 'true' || v === 'yes' || v === 'on') return { value: '1' };
    if (v === false || v === 0 || v === '0' || v === 'false' || v === 'no' || v === 'off') return { value: '0' };
    return { why: `expected yes or no, got ${show(value)}` };
  }
  if (s.type === 'enum') {
    if (typeof value !== 'string') return { why: `expected one of: ${s.values.join(', ')}` };
    const t = value.trim();
    const hit = s.values.find((e) => e === t) ?? s.values.find((e) => e.toLowerCase() === t.toLowerCase());
    return hit ? { value: hit } : { why: `${show(value)} is not one of: ${s.values.join(', ')}` };
  }
  let n: number | null = null;
  if (typeof value === 'number') n = Number.isFinite(value) ? value : null;
  else if (typeof value === 'string') {
    const t = s.type === 'percent' ? value.trim().replace(/%$/, '') : value.trim();
    n = NUM_RE.test(t) ? Number(t) : null;
  }
  if (n === null) return { why: `expected a number, got ${show(value)}` };
  const unit = 'unit' in s && s.unit ? ` ${s.unit}` : s.type === 'percent' ? '%' : '';
  if (s.type === 'int' && !Number.isInteger(n)) return { why: `expected a whole number, got ${fmt(n)}` };
  if (n < s.min || n > s.max) return { why: `${fmt(n)}${unit} is outside ${fmt(s.min)}..${fmt(s.max)}${unit}` };
  return { value: s.type === 'percent' ? `${fmt(n)}%` : fmt(n) };
}

/**
 * 🔴 THE ONE CHECK. Every override — from a chip, from the model, from a saved
 * job — goes through this before it can be applied. What is refused is named
 * with its reason and is never applied; there is no partial or coerced value.
 *
 * Accepts the parsed object OR the raw text of a reply: text that is not one
 * JSON object is refused as a whole (`(reply)`), never searched for something
 * that looks like settings.
 */
export function validateOverrides(obj: unknown): Validation {
  const out: Validation = { accepted: {}, refused: [] };
  let o = obj;
  if (typeof o === 'string') {
    try {
      o = JSON.parse(o);
    } catch {
      out.refused.push({ key: '(reply)', why: 'not JSON, so nothing in it was applied' });
      return out;
    }
  }
  if (o === null || typeof o !== 'object' || Array.isArray(o)) {
    out.refused.push({ key: '(overrides)', why: 'the settings must be one JSON object of name: value' });
    return out;
  }
  const keys = Object.keys(o);
  for (const k of keys.slice(0, MAX_KEYS)) {
    const r = validateOne(k, (o as Record<string, unknown>)[k]);
    if ('value' in r) out.accepted[k] = r.value;
    else out.refused.push({ key: k.slice(0, 64), why: r.why });
  }
  if (keys.length > MAX_KEYS) out.refused.push({ key: '(more)', why: `more than ${MAX_KEYS} settings; the rest were not looked at` });
  return out;
}

/** The person-facing name of a key, and its value with a unit. */
export function describe(key: string, value: string): string {
  const s = ALLOWED[key];
  if (!s) return `${key} = ${value}`;
  if (s.type === 'bool') return `${s.label}: ${value === '1' ? 'on' : 'off'}`;
  const unit = 'unit' in s && s.unit ? ` ${s.unit}` : '';
  return `${s.label}: ${value}${unit}`;
}

/** The allow-list as the model is shown it: key [type] range - meaning. No G-code key can appear. */
export function allowedKeysText(): string {
  return Object.values(ALLOWED)
    .map((s) => {
      const dom =
        s.type === 'enum'
          ? s.values.join(' | ')
          : s.type === 'bool'
            ? '0 | 1'
            : `${s.min}..${s.max}${s.type === 'percent' ? ' (percent, e.g. 20%)' : ''}${'unit' in s && s.unit ? ` ${s.unit}` : ''}`;
      return `${s.key} [${s.type}] ${dom} - ${s.label}`;
    })
    .join('\n');
}
