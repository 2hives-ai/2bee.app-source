/**
 * materials tab — the stock the shop HAS (founder 2026-10-16: a materials tab,
 * "same concept as the machines tab", pills sheets · filaments).
 *
 * A sheet or a filament spool is a NAME plus the facts the operator (or a page
 * they linked) stated. Nothing is defaulted: a field nobody stated stays `null`
 * and shows as "not stated". The lists live in this browser.
 *
 * ⚠ WHAT THIS DOES NOT DO
 *  - It does not pick a sheet for a job. The sheet basis is contested in the
 *    repo (2700×1200 / 600×900 / 2400×1200 — AGENTS.md), so nothing here is a
 *    default and no list order means "preferred". cnc reads `readSheets` and the
 *    OPERATOR chooses.
 *  - A thickness here is what the operator or a supplier page SAID. Nominal
 *    thickness is a label (see `../materials.ts` header: "18mm" ply spans at
 *    least two real thicknesses). A through-cut depth still needs a caliper.
 *  - A material the planner does not carry is ALLOWED (the shop may hold it) and
 *    FLAGGED, because the planner cannot plan feeds for it. It is never mapped
 *    to a near name silently.
 *
 * The AI reader follows `machines/printers.ts`: a proposal with any unknown key
 * or out-of-bounds value is refused WHOLE; the model never fills a value nobody
 * stated (a `null` in its patch is read as "not stated" and named as missing).
 */
import type { AskConfig, AskRequest } from '../cad/ask';

type Store = Pick<Storage, 'getItem'> | null | undefined;
type WStore = Pick<Storage, 'setItem'> | null | undefined;

// ───────────────────────────── field specs ─────────────────────────────

type Spec =
  | { kind: 'num'; label: string; unit: string; min: number; max: number }
  | { kind: 'int'; label: string; unit: string; min: number; max: number }
  | { kind: 'choice'; label: string; unit: string; values: readonly number[] }
  | { kind: 'text'; label: string; max: number; re?: RegExp; reWhy?: string };

function checkValue(spec: Spec, val: unknown): { ok: true; v: number | string } | { ok: false; why: string } {
  if (spec.kind === 'text') {
    if (typeof val !== 'string') return { ok: false, why: `${spec.label} must be text.` };
    const s = val.trim();
    if (!s) return { ok: false, why: `${spec.label} is empty.` };
    if (s.length > spec.max) return { ok: false, why: `${spec.label} is longer than ${spec.max} characters.` };
    if (spec.re && !spec.re.test(s)) return { ok: false, why: `${spec.label} "${s.slice(0, 40)}" ${spec.reWhy ?? 'is not in the expected form'}.` };
    return { ok: true, v: s };
  }
  if (typeof val !== 'number' || !Number.isFinite(val)) return { ok: false, why: `${spec.label} must be a number.` };
  if (spec.kind === 'choice') {
    if (!spec.values.includes(val)) return { ok: false, why: `${spec.label} ${val} ${spec.unit} is not one of ${spec.values.join(' | ')} ${spec.unit}.` };
    return { ok: true, v: val };
  }
  if (spec.kind === 'int' && !Number.isInteger(val)) return { ok: false, why: `${spec.label} must be a whole number.` };
  if (val < spec.min || val > spec.max) return { ok: false, why: `${spec.label} ${val} ${spec.unit} is outside ${spec.min}–${spec.max} ${spec.unit}.` };
  return { ok: true, v: val };
}

const LINK_RE = /^https?:\/\/[^\s<>"]+$/i;

// ───────────────────────────── sheets ─────────────────────────────

export interface SheetFields {
  material: string | null;
  thicknessMm: number | null;
  sizeX: number | null;
  sizeY: number | null;
  quantity: number | null;
  supplier: string | null;
  link: string | null;
  notes: string | null;
}
export type SheetKey = keyof SheetFields;

/**
 * One piece of stock on the shelf. THE type cnc reads (`readSheets`).
 * `null` = not stated. Never treat a null as zero or as a default size.
 */
export interface Sheet extends SheetFields {
  id: string;
  name: string;
  /** Where the facts came from, as the chat said it ("operator", a URL). */
  source: string;
  addedAt: number;
}

export const SHEET_FIELDS: Record<SheetKey, Spec> = {
  material: { kind: 'text', label: 'Material', max: 40 },
  thicknessMm: { kind: 'num', label: 'Thickness', unit: 'mm', min: 0.5, max: 100 },
  sizeX: { kind: 'num', label: 'Size X', unit: 'mm', min: 50, max: 5000 },
  sizeY: { kind: 'num', label: 'Size Y', unit: 'mm', min: 50, max: 5000 },
  quantity: { kind: 'int', label: 'Quantity', unit: '', min: 0, max: 10000 },
  supplier: { kind: 'text', label: 'Supplier', max: 80 },
  link: { kind: 'text', label: 'Link', max: 500, re: LINK_RE, reWhy: 'is not an http(s) link' },
  notes: { kind: 'text', label: 'Notes', max: 500 },
};
export const SHEET_KEYS = Object.keys(SHEET_FIELDS) as SheetKey[];
/** What a sheet needs before cnc can use it; the rest is optional. */
export const SHEET_REQUIRED: SheetKey[] = ['material', 'thicknessMm', 'sizeX', 'sizeY', 'quantity'];
export const NO_SHEET_FIELDS: SheetFields = {
  material: null, thicknessMm: null, sizeX: null, sizeY: null, quantity: null, supplier: null, link: null, notes: null,
};
export const SHEETS_KEY = '2bee.app.materials.sheets';

// ───────────────────────────── filaments ─────────────────────────────

export const FILAMENT_TYPES = ['PLA', 'PETG', 'ASA', 'ABS', 'TPU', 'PA', 'PC', 'PET', 'PP', 'PVA', 'HIPS', 'PEEK'] as const;
/** A base type, optionally with a fibre fill: PLA, PETG-CF, PA-GF … */
const TYPE_RE = new RegExp(`^(${FILAMENT_TYPES.join("|")})(-(CF|GF))?$`, "i");

export interface FilamentFields {
  type: string | null;
  colourName: string | null;
  colourHex: string | null;
  diameterMm: number | null;
  spoolG: number | null;
  brand: string | null;
  remainingG: number | null;
  notes: string | null;
}
export type FilamentKey = keyof FilamentFields;

export interface Filament extends FilamentFields {
  id: string;
  name: string;
  source: string;
  addedAt: number;
}

export const FILAMENT_FIELDS: Record<FilamentKey, Spec> = {
  type: { kind: 'text', label: 'Type', max: 10, re: TYPE_RE, reWhy: `is not one of ${FILAMENT_TYPES.join('/')} (optionally -CF/-GF)` },
  colourName: { kind: 'text', label: 'Colour', max: 40 },
  colourHex: { kind: 'text', label: 'Colour hex', max: 7, re: /^#[0-9a-fA-F]{6}$/, reWhy: 'is not #rrggbb' },
  diameterMm: { kind: 'choice', label: 'Diameter', unit: 'mm', values: [1.75, 2.85] },
  spoolG: { kind: 'num', label: 'Spool', unit: 'g', min: 50, max: 10000 },
  brand: { kind: 'text', label: 'Brand', max: 60 },
  remainingG: { kind: 'num', label: 'Remaining', unit: 'g', min: 0, max: 10000 },
  notes: { kind: 'text', label: 'Notes', max: 500 },
};
export const FILAMENT_KEYS = Object.keys(FILAMENT_FIELDS) as FilamentKey[];
export const FILAMENT_REQUIRED: FilamentKey[] = ['type', 'colourName', 'diameterMm', 'spoolG', 'brand'];
export const NO_FILAMENT_FIELDS: FilamentFields = {
  type: null, colourName: null, colourHex: null, diameterMm: null, spoolG: null, brand: null, remainingG: null, notes: null,
};
export const FILAMENTS_KEY = '2bee.app.materials.filaments';

// ───────────────────────────── storage ─────────────────────────────

/**
 * Every stored field is RE-CHECKED on read against the same bounds the chat
 * uses, so a hand-edited or older store cannot hand cnc a 0 mm thickness; a
 * value that fails reads as not stated.
 */
function sanitise<F extends object>(raw: unknown, specs: Record<string, Spec>, empty: F): F {
  const out = { ...empty } as Record<string, unknown>;
  if (!raw || typeof raw !== 'object') return out as F;
  for (const k of Object.keys(specs)) {
    const v = (raw as Record<string, unknown>)[k];
    if (v === null || v === undefined) continue;
    const c = checkValue(specs[k], v);
    if (c.ok) out[k] = c.v;
  }
  return out as F;
}

function readList<F extends object>(store: Store, key: string, specs: Record<string, Spec>, empty: F): (F & { id: string; name: string; source: string; addedAt: number })[] {
  try {
    const raw = store?.getItem(key);
    const v = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(v)) return [];
    const seen = new Set<string>();
    const out: (F & { id: string; name: string; source: string; addedAt: number })[] = [];
    for (const p of v) {
      if (!p || typeof p !== 'object') continue;
      const r = p as Record<string, unknown>;
      if (typeof r.id !== 'string' || !r.id || seen.has(r.id) || typeof r.name !== 'string' || !r.name.trim()) continue;
      seen.add(r.id);
      out.push({
        ...sanitise(r, specs, empty),
        id: r.id,
        name: r.name.trim().slice(0, 80),
        source: typeof r.source === 'string' ? r.source : 'operator',
        addedAt: typeof r.addedAt === 'number' && Number.isFinite(r.addedAt) ? r.addedAt : 0,
      });
    }
    return out;
  } catch {
    return [];
  }
}

function writeList(store: WStore, key: string, list: unknown[], what: string): string | null {
  try {
    store?.setItem(key, JSON.stringify(list));
    return null;
  } catch (e) {
    return `This browser refused to store the ${what} list: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** The stock sheets this browser holds. Bad JSON / a blocked store → []. Never throws. */
export function readSheets(store: Store): Sheet[] {
  return readList(store, SHEETS_KEY, SHEET_FIELDS, NO_SHEET_FIELDS);
}
/** Returns why it was not saved, or null. */
export function writeSheets(store: WStore, list: Sheet[]): string | null {
  return writeList(store, SHEETS_KEY, list, 'stock');
}
export function readFilaments(store: Store): Filament[] {
  return readList(store, FILAMENTS_KEY, FILAMENT_FIELDS, NO_FILAMENT_FIELDS);
}
export function writeFilaments(store: WStore, list: Filament[]): string | null {
  return writeList(store, FILAMENTS_KEY, list, 'filament');
}

export function stockId(name: string, taken: readonly string[]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'item';
  let id = base;
  for (let i = 2; taken.includes(id); i++) id = `${base}-${i}`;
  return id;
}

/** Case-insensitive match to the planner's own spelling, or null (= flagged). */
export function plannerMaterial(material: string | null, known: readonly string[]): string | null {
  if (!material) return null;
  return known.find((k) => k.toLowerCase() === material.trim().toLowerCase()) ?? null;
}

// ───────────────────────────── the AI reader ─────────────────────────────

/** cnc = stock panels, 3d = filament. */
export type StockKind = 'cnc' | '3d';

export type StockProposal<F> =
  | {
      ok: true;
      action: 'add' | 'edit' | 'remove';
      patch: Partial<F>;
      name?: string;
      why: string;
      /** What the source did not state (the model's list + required fields still empty). */
      missing: string[];
      /** Allowed, but the operator should know (e.g. a material the planner does not carry). */
      flags: string[];
    }
  | { ok: false; problems: string[] };

function firstObject(raw: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  const text = fenced ? fenced[1] : raw;
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a < 0 || b <= a) return undefined;
  try {
    return JSON.parse(text.slice(a, b + 1));
  } catch {
    return undefined;
  }
}

function readProposal<F extends object>(
  raw: string,
  current: F | null,
  specs: Record<string, Spec>,
  required: readonly string[],
  what: string,
): StockProposal<F> {
  const v = firstObject(raw) as { action?: unknown; patch?: unknown; name?: unknown; why?: unknown; missing?: unknown } | undefined;
  if (!v || typeof v !== 'object') return { ok: false, problems: ['The reply was not the JSON object asked for.'] };
  const action = v.action ?? 'edit';
  if (action !== 'add' && action !== 'edit' && action !== 'remove') return { ok: false, problems: [`"action" must be add, edit or remove, not ${JSON.stringify(action)}.`] };
  const p = v.patch ?? {};
  if (!p || typeof p !== 'object' || Array.isArray(p)) return { ok: false, problems: ['The reply has no "patch" object.'] };
  const problems: string[] = [];
  const patch: Record<string, unknown> = {};
  const nulls: string[] = [];
  for (const [k, val] of Object.entries(p as Record<string, unknown>)) {
    if (!(k in specs)) {
      problems.push(`"${k}" is not a ${what} field this chat may set.`);
      continue;
    }
    if (val === null) {
      nulls.push(k);
      continue;
    }
    const c = checkValue(specs[k], val);
    if (c.ok) patch[k] = c.v;
    else problems.push(c.why);
  }
  let name: string | undefined;
  if (v.name !== undefined && v.name !== null) {
    if (typeof v.name !== 'string' || !v.name.trim() || v.name.trim().length > 80) problems.push('"name" must be text of 1–80 characters.');
    else name = v.name.trim();
  }
  if (action !== 'add' && !current) problems.push(`There is no ${what} selected to ${action}. Say "add" to add a new one.`);
  if (problems.length) return { ok: false, problems };
  if (action === 'remove') return { ok: true, action, patch: {}, why: typeof v.why === 'string' ? v.why : '', missing: [], flags: [] };
  if (action === 'edit' && current) for (const k of Object.keys(patch)) if (patch[k] === (current as Record<string, unknown>)[k]) delete patch[k];
  const after = { ...(action === 'add' ? {} : current), ...patch } as Record<string, unknown>;
  const said = Array.isArray(v.missing) ? v.missing.filter((m): m is string => typeof m === 'string').slice(0, 10) : [];
  const missing = [...new Set([...said, ...nulls, ...required.filter((k) => after[k] === null || after[k] === undefined)])];
  return { ok: true, action, patch: patch as Partial<F>, ...(name ? { name } : {}), why: typeof v.why === 'string' ? v.why : '', missing, flags: [] };
}

/**
 * Read and CHECK a sheet proposal. `knownMaterials` is the planner's list
 * (`cam.ts` toolLibrary().materials): a material outside it is allowed and
 * FLAGGED; a material that matches it case-insensitively takes its spelling.
 */
export function readSheetProposal(raw: string, current: SheetFields | null, knownMaterials: readonly string[]): StockProposal<SheetFields> {
  const r = readProposal<SheetFields>(raw, current, SHEET_FIELDS, SHEET_REQUIRED, 'stock');
  if (!r.ok || r.patch.material === undefined || r.patch.material === null) return r;
  const m = plannerMaterial(r.patch.material, knownMaterials);
  if (m) r.patch.material = m;
  else
    r.flags.push(
      knownMaterials.length
        ? `"${r.patch.material}" is not a material the planner carries (${knownMaterials.join(', ')}). Kept, but cnc cannot plan feeds for it.`
        : `The planner's material list did not load, so "${r.patch.material}" is unchecked.`,
    );
  return r;
}

export function readFilamentProposal(raw: string, current: FilamentFields | null): StockProposal<FilamentFields> {
  const r = readProposal<FilamentFields>(raw, current, FILAMENT_FIELDS, FILAMENT_REQUIRED, 'filament');
  if (!r.ok) return r;
  if (typeof r.patch.type === 'string') r.patch.type = r.patch.type.toUpperCase();
  const spool = r.patch.spoolG ?? (r.action === 'edit' ? current?.spoolG : null) ?? null;
  const left = r.patch.remainingG ?? (r.action === 'edit' ? current?.remainingG : null) ?? null;
  if (spool !== null && left !== null && left > spool) return { ok: false, problems: [`Remaining ${left} g is more than the spool's ${spool} g.`] };
  return r;
}

/** The label for an item added with no stated name, built ONLY from stated values. */
export function sheetLabel(f: SheetFields): string {
  const parts = [f.thicknessMm !== null ? `${f.thicknessMm} mm` : '', f.material ?? '', f.sizeX !== null && f.sizeY !== null ? `${f.sizeX} × ${f.sizeY}` : ''].filter(Boolean);
  return parts.join(' ') || 'unnamed stock';
}
export function filamentLabel(f: FilamentFields): string {
  return [f.brand ?? '', f.type ?? '', f.colourName ?? ''].filter(Boolean).join(' ') || 'unnamed filament';
}

export function showValue(spec: Spec, v: unknown): string {
  if (v === null || v === undefined) return 'not stated';
  if (spec.kind === 'text') return String(v);
  return `${String(v)}${spec.unit ? ` ${spec.unit}` : ''}`;
}

export function stockRows<F extends object>(specs: Record<string, Spec>, before: F | null, patch: Partial<F>): string[] {
  return Object.keys(patch).map((k) => {
    const s = specs[k];
    return `${s.label}: ${showValue(s, before ? (before as Record<string, unknown>)[k] : null)} → ${showValue(s, (patch as Record<string, unknown>)[k])}`;
  });
}

export const SHEET_SYSTEM_INSTRUCTION = (known: readonly string[]) =>
  [
    'You help an operator record the CNC STOCK their shop holds (panels of plywood, MDF, acrylic, aluminium …) in 2bee.app.',
    'Fields you may set: ' + SHEET_KEYS.map((k) => `${k} (${SHEET_FIELDS[k].label}${'unit' in SHEET_FIELDS[k] && SHEET_FIELDS[k].unit ? `, ${SHEET_FIELDS[k].unit}` : ''})`).join(', ') + '.',
    `material: use the planner's own name when the stock plainly is one of: ${known.length ? known.join(', ') : '(list not loaded)'} (birch ply → Plywood). If it is none of these, give the material as stated.`,
    'thicknessMm is the thickness as stated (nominal). sizeX x sizeY in mm, X the first number stated. quantity = how many pieces the operator HAS (only if stated).',
    'Only set a value the operator stated or a linked page states (its text is included). Never guess: leave it out and list it in "missing". Never invent a supplier or a link.',
    '"action": "add" for new stock (give "name": a short product name as stated, e.g. "18 mm birch ply 2440 × 1220"), "edit" to change the selected item, "remove" to delete the selected item.',
    'Answer with ONE JSON object and nothing else: {"action": "add|edit|remove", "patch": {<field>: <value>, ...}, "name": "<for add>", "why": "<one short sentence citing the source>", "missing": ["<field>", ...]}.',
  ].join('\n');

export const FILAMENT_SYSTEM_INSTRUCTION = [
  'You help an operator record the 3D-printer FILAMENT spools their shop holds in 2bee.app.',
  'Fields you may set: ' + FILAMENT_KEYS.map((k) => `${k} (${FILAMENT_FIELDS[k].label}${'unit' in FILAMENT_FIELDS[k] && FILAMENT_FIELDS[k].unit ? `, ${FILAMENT_FIELDS[k].unit}` : ''})`).join(', ') + '.',
  `type is one of ${FILAMENT_TYPES.join(', ')}, optionally with -CF or -GF. diameterMm is 1.75 or 2.85. spoolG is the NET filament weight of a full spool in grams (1 kg = 1000).`,
  'colourHex only if the page or operator gives one (#rrggbb). Never derive a hex from a colour name.',
  'Only set a value the operator stated or a linked page states (its text is included). Never guess: leave it out and list it in "missing".',
  '"action": "add" for a new spool (give "name", e.g. "Bambu PLA Basic Jade White"), "edit" to change the selected spool, "remove" to delete it.',
  'Answer with ONE JSON object and nothing else: {"action": "add|edit|remove", "patch": {<field>: <value>, ...}, "name": "<for add>", "why": "<one short sentence citing the source>", "missing": ["<field>", ...]}.',
].join('\n');

export function buildStockRequest(
  cfg: AskConfig,
  kind: StockKind,
  prompt: string,
  current: { name: string; fields: object } | null,
  list: string[],
  knownMaterials: readonly string[],
  pages = '',
): AskRequest {
  return {
    url: cfg.endpoint,
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
    body: {
      model: cfg.model,
      messages: [
        { role: 'system', content: kind === 'cnc' ? SHEET_SYSTEM_INSTRUCTION(knownMaterials) : FILAMENT_SYSTEM_INSTRUCTION },
        {
          role: 'user',
          content:
            `Items held: ${list.length ? list.join('; ') : '(none)'}\n` +
            `Selected: ${current ? `${current.name} ${JSON.stringify(current.fields)}` : '(none)'}\n\nOperator: ${prompt}${pages}`,
        },
      ],
      temperature: 0,
      stream: false,
    },
  };
}
