/**
 * 3D printers on the machines tab (founder 2026-10-15: "able to add 3d printers
 * to the machines").
 *
 * A printer is a NAME and the facts the operator (or a page they linked) stated.
 * Nothing is defaulted: a field nobody stated stays `null` and shows as "not
 * stated". The list lives in this browser. It is a description, not a
 * connection: uploads go through tools/printer-bridge, which is configured on
 * its own (address + access code) and never from here.
 *
 * The AI reader follows machineAsk.ts: a proposal outside the keys or bounds is
 * refused WHOLE, a page's text counts as stated, power is not speed.
 */
import type { AskConfig, AskRequest } from '../cad/ask';

export interface PrinterFields {
  buildX: number | null;
  buildY: number | null;
  buildZ: number | null;
  nozzleMm: number | null;
  maxHotendC: number | null;
  maxBedC: number | null;
  filamentSlots: number | null;
  enclosed: boolean | null;
}
export type PrinterKey = keyof PrinterFields;

export interface Printer {
  id: string;
  name: string;
  fields: PrinterFields;
  /** Where the facts came from, as the chat said it ("operator", a URL). */
  source: string;
  addedAt: number;
}

export const PRINTER_FIELDS: Record<PrinterKey, { label: string; unit: string; min?: number; max?: number; kind: 'num' | 'int' | 'bool' }> = {
  buildX: { label: 'Build X', unit: 'mm', min: 30, max: 2000, kind: 'num' },
  buildY: { label: 'Build Y', unit: 'mm', min: 30, max: 2000, kind: 'num' },
  buildZ: { label: 'Build Z', unit: 'mm', min: 30, max: 2000, kind: 'num' },
  nozzleMm: { label: 'Nozzle', unit: 'mm', min: 0.1, max: 2, kind: 'num' },
  maxHotendC: { label: 'Max hotend', unit: '°C', min: 150, max: 500, kind: 'num' },
  maxBedC: { label: 'Max plate', unit: '°C', min: 30, max: 200, kind: 'num' },
  filamentSlots: { label: 'Filament slots', unit: '', min: 1, max: 32, kind: 'int' },
  enclosed: { label: 'Enclosed', unit: '', kind: 'bool' },
};
export const PRINTER_KEYS = Object.keys(PRINTER_FIELDS) as PrinterKey[];

export const NO_PRINTER_FIELDS: PrinterFields = {
  buildX: null, buildY: null, buildZ: null, nozzleMm: null, maxHotendC: null, maxBedC: null, filamentSlots: null, enclosed: null,
};

export const PRINTERS_KEY = '2bee.app.machines.printers';

/**
 * 🔴 Every stored field is RE-CHECKED on read against the same rules the AI reader uses
 * (as `materials/stock.ts` does); a value that fails reads as NOT STATED. It was merged
 * unchecked, and CadTab's "Fits a 3D printer" gate compared a part against a stored string
 * "300" — `v <= "300" + 1e-6` is `v <= "3000.000001"` — and passed a 2999 mm part
 * (bughunt 2026-11-15).
 */
function storedFields(raw: unknown): PrinterFields {
  const out: PrinterFields = { ...NO_PRINTER_FIELDS };
  if (!raw || typeof raw !== 'object') return out;
  for (const k of PRINTER_KEYS) {
    const v = (raw as Record<string, unknown>)[k];
    if (v === null || v === undefined) continue;
    const r = readPrinterProposal(JSON.stringify({ patch: { [k]: v } }), NO_PRINTER_FIELDS);
    if (r.ok && k in r.patch) (out as unknown as Record<string, unknown>)[k] = (r.patch as Record<string, unknown>)[k];
  }
  return out;
}

export function readPrinters(store: Pick<Storage, 'getItem'> | null | undefined): Printer[] {
  try {
    const raw = store?.getItem(PRINTERS_KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(v)) return [];
    return v.filter(
      (p): p is Printer =>
        !!p && typeof p === 'object' && typeof (p as Printer).id === 'string' && typeof (p as Printer).name === 'string' && !!(p as Printer).fields,
    ).map((p) => ({ ...p, fields: storedFields(p.fields) }));
  } catch {
    return [];
  }
}

/** Returns why it was not saved, or null. */
export function writePrinters(store: Pick<Storage, 'setItem'> | null | undefined, list: Printer[]): string | null {
  try {
    store?.setItem(PRINTERS_KEY, JSON.stringify(list));
    return null;
  } catch (e) {
    return `This browser refused to store the printer list: ${e instanceof Error ? e.message : String(e)}`;
  }
}

export function printerId(name: string, taken: readonly string[]): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'printer';
  let id = base;
  for (let i = 2; taken.includes(id); i++) id = `${base}-${i}`;
  return id;
}

export const PRINTER_SYSTEM_INSTRUCTION = [
  'You help an operator describe a 3D PRINTER to 2bee.app.',
  'Fields you may set: ' +
    PRINTER_KEYS.map((k) => `${k} (${PRINTER_FIELDS[k].label}${PRINTER_FIELDS[k].unit ? `, ${PRINTER_FIELDS[k].unit}` : ''})`).join(', ') +
    '.',
  'Only set a value the operator stated or a linked page they gave states (its text is included). Never guess: leave it out and list it in "missing".',
  'Build volume is buildX x buildY x buildZ in mm (X is the first number unless the page says otherwise). A heater wattage is not a temperature.',
  'If the operator wants a printer ADDED, also give "name": the printer model as the page or operator states it.',
  'Answer with ONE JSON object and nothing else: {"patch": {<field>: <value>, ...}, "name": "<optional>", "why": "<one short sentence citing the source>", "missing": ["<field>", ...]}.',
].join('\n');

export function buildPrinterRequest(cfg: AskConfig, prompt: string, current: PrinterFields, name: string, pages = ''): AskRequest {
  return {
    url: cfg.endpoint,
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
    body: {
      model: cfg.model,
      messages: [
        { role: 'system', content: PRINTER_SYSTEM_INSTRUCTION },
        { role: 'user', content: `Printer: ${name || '(none selected)'}\nCurrent fields: ${JSON.stringify(current)}\n\nOperator: ${prompt}${pages}` },
      ],
      temperature: 0,
      stream: false,
    },
  };
}

export type PrinterProposal =
  | { ok: true; patch: Partial<PrinterFields>; name?: string; why: string; missing: string[] }
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

/** Any problem refuses the whole patch, as in machineAsk.ts. */
export function readPrinterProposal(raw: string, current: PrinterFields): PrinterProposal {
  const v = firstObject(raw) as { patch?: unknown; name?: unknown; why?: unknown; missing?: unknown } | undefined;
  if (!v || typeof v !== 'object') return { ok: false, problems: ['The reply was not the JSON object asked for.'] };
  const p = v.patch;
  if (!p || typeof p !== 'object' || Array.isArray(p)) return { ok: false, problems: ['The reply has no "patch" object.'] };
  const problems: string[] = [];
  const patch: Partial<PrinterFields> = {};
  for (const [k, val] of Object.entries(p as Record<string, unknown>)) {
    if (!(PRINTER_KEYS as string[]).includes(k)) {
      problems.push(`"${k}" is not a printer field this chat may set.`);
      continue;
    }
    const key = k as PrinterKey;
    const f = PRINTER_FIELDS[key];
    if (f.kind === 'bool') {
      if (typeof val !== 'boolean') problems.push(`${f.label} must be true or false.`);
      else (patch as Record<string, unknown>)[key] = val;
      continue;
    }
    if (typeof val !== 'number' || !Number.isFinite(val)) {
      problems.push(`${f.label} must be a number.`);
      continue;
    }
    if (f.kind === 'int' && !Number.isInteger(val)) {
      problems.push(`${f.label} must be a whole number.`);
      continue;
    }
    if ((f.min !== undefined && val < f.min) || (f.max !== undefined && val > f.max)) {
      problems.push(`${f.label} ${val} ${f.unit} is outside ${f.min}–${f.max} ${f.unit}.`);
      continue;
    }
    (patch as Record<string, unknown>)[key] = val;
  }
  if (problems.length) return { ok: false, problems };
  for (const k of Object.keys(patch) as PrinterKey[]) if (patch[k] === current[k]) delete patch[k];
  const name = typeof v.name === 'string' && v.name.trim() && v.name.length <= 80 ? v.name.trim() : undefined;
  const missing = Array.isArray(v.missing) ? v.missing.filter((m): m is string => typeof m === 'string').slice(0, 10) : [];
  return { ok: true, patch, why: typeof v.why === 'string' ? v.why : '', ...(name ? { name } : {}), missing };
}

export function printerRows(current: PrinterFields, patch: Partial<PrinterFields>): string[] {
  const show = (k: PrinterKey, v: unknown) =>
    v === null || v === undefined ? 'not stated' : PRINTER_FIELDS[k].kind === 'bool' ? (v ? 'yes' : 'no') : `${String(v)}${PRINTER_FIELDS[k].unit ? ` ${PRINTER_FIELDS[k].unit}` : ''}`;
  return (Object.keys(patch) as PrinterKey[]).map((k) => `${PRINTER_FIELDS[k].label}: ${show(k, current[k])} → ${show(k, patch[k])}`);
}
