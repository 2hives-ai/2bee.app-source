/**
 * cnc.machines — asking a model to change the MACHINE settings (founder
 * 2026-10-15: "Decouple the machine from 2bee.cnc into 2bee.cnc.machines (same
 * view as all others - AI chat + 3d view)").
 *
 * Same shape as `cnc/jobAsk.ts`: the model proposes a patch, and this file
 * refuses anything outside the keys and bounds below before it can reach a
 * setter. What it may set is what the Machine panel's own fields set, nothing
 * else.
 *
 * ⚠ A MACHINE FACT IS THE OPERATOR'S, NOT THE MODEL'S. The model cannot know
 * this router's travel or collet. It turns what the operator SAID into fields;
 * the bounds only stop numbers no hobby/shop router has. They do not make a
 * number true, and the reply in the chat says so.
 */
import type { AskConfig, AskRequest } from '../cad/ask';

export interface MachineFields {
  travelX: number;
  travelY: number;
  travelZ: number;
  safeZ: number;
  colletMm: number;
  spindleMax: number;
  supportsArcs: boolean;
}

export type MachineKey = keyof MachineFields;

export const MACHINE_FIELDS: Record<MachineKey, { label: string; unit: string; min?: number; max?: number }> = {
  travelX: { label: 'Travel X', unit: 'mm', min: 50, max: 5000 },
  travelY: { label: 'Travel Y', unit: 'mm', min: 50, max: 5000 },
  travelZ: { label: 'Travel Z', unit: 'mm', min: 10, max: 500 },
  safeZ: { label: 'Safe Z', unit: 'mm', min: 0.5, max: 100 },
  colletMm: { label: 'Collet', unit: 'mm', min: 1, max: 25.4 },
  spindleMax: { label: 'Spindle max', unit: 'rpm', min: 1000, max: 60000 },
  supportsArcs: { label: 'Arcs (G2/G3)', unit: '' },
};

export const MACHINE_KEYS = Object.keys(MACHINE_FIELDS) as MachineKey[];

export const MACHINE_SYSTEM_INSTRUCTION = [
  'You help an operator describe their CNC router to 2bee.cnc.',
  'You may change ONLY these fields: ' +
    MACHINE_KEYS.map((k) => `${k} (${MACHINE_FIELDS[k].label}${MACHINE_FIELDS[k].unit ? `, ${MACHINE_FIELDS[k].unit}` : ''})`).join(', ') +
    '.',
  'Only set a value the operator stated, that a linked page they gave states (its text is included), or that follows directly from those (e.g. "a 6090" means 600 x 900 mm travel). Never guess a value nobody stated: leave it out and list it in "missing".',
  'If the machine asked about is NOT a CNC router (e.g. a 3D printer or a laser), set nothing and say in "why" that it belongs in a different machine list.',
  'A spindle POWER (kW) is not spindle max rpm; working area is travel X/Y (X is the first number unless the page says otherwise).',
  'If the operator wants a machine ADDED, also give "name": the machine model name as the page or operator states it.',
  'Answer with ONE JSON object and nothing else: {"patch": {<field>: <value>, ...}, "name": "<optional>", "why": "<one short sentence citing the source>", "missing": ["<field the source did not state>", ...]}.',
  'Numbers are millimetres or rpm, never strings. supportsArcs is true or false. An empty patch is allowed when nothing should change.',
].join('\n');

export function buildMachineRequest(cfg: AskConfig, prompt: string, current: MachineFields, name: string, pages = ''): AskRequest {
  return {
    url: cfg.endpoint,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
    },
    body: {
      model: cfg.model,
      messages: [
        { role: 'system', content: MACHINE_SYSTEM_INSTRUCTION },
        {
          role: 'user',
          content: `Machine: ${name}\nCurrent fields: ${JSON.stringify(current)}\n\nOperator: ${prompt}${pages}`,
        },
      ],
      temperature: 0,
      stream: false,
    },
  };
}

export type MachineProposal =
  | { ok: true; patch: Partial<MachineFields>; why: string; name?: string; missing: string[] }
  | { ok: false; problems: string[] };

/** The first top-level JSON object in a reply, fenced or not. */
function firstObject(raw: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  const text = fenced ? fenced[1] : raw;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/**
 * Read and CHECK a proposal. Any problem refuses the whole patch: a reply with
 * one good and one bad field is a reply that did not follow the rules, and
 * applying half of it would be guessing which half the operator meant.
 */
export function readMachineProposal(raw: string, current: MachineFields): MachineProposal {
  const v = firstObject(raw) as { patch?: unknown; why?: unknown; name?: unknown; missing?: unknown } | undefined;
  if (!v || typeof v !== 'object') return { ok: false, problems: ['The reply was not the JSON object asked for.'] };
  const p = v.patch;
  if (!p || typeof p !== 'object' || Array.isArray(p)) return { ok: false, problems: ['The reply has no "patch" object.'] };
  const problems: string[] = [];
  const patch: Partial<MachineFields> = {};
  for (const [k, val] of Object.entries(p as Record<string, unknown>)) {
    if (!(MACHINE_KEYS as string[]).includes(k)) {
      problems.push(`"${k}" is not a machine field this chat may set.`);
      continue;
    }
    const key = k as MachineKey;
    const f = MACHINE_FIELDS[key];
    if (key === 'supportsArcs') {
      if (typeof val !== 'boolean') problems.push(`${f.label} must be true or false.`);
      else patch.supportsArcs = val;
      continue;
    }
    if (typeof val !== 'number' || !Number.isFinite(val)) {
      problems.push(`${f.label} must be a number.`);
      continue;
    }
    if ((f.min !== undefined && val < f.min) || (f.max !== undefined && val > f.max)) {
      problems.push(`${f.label} ${val} ${f.unit} is outside ${f.min}–${f.max} ${f.unit}.`);
      continue;
    }
    (patch as Record<string, number>)[key] = val;
  }
  const next = { ...current, ...patch };
  if (next.safeZ >= next.travelZ) problems.push(`Safe Z ${next.safeZ} mm must be below Travel Z ${next.travelZ} mm.`);
  if (problems.length) return { ok: false, problems };
  for (const k of Object.keys(patch) as MachineKey[]) if (patch[k] === current[k]) delete patch[k];
  const name = typeof v.name === 'string' && v.name.trim() && v.name.length <= 80 ? v.name.trim() : undefined;
  const missing = Array.isArray(v.missing) ? v.missing.filter((m): m is string => typeof m === 'string').slice(0, 10) : [];
  return { ok: true, patch, why: typeof v.why === 'string' ? v.why : '', ...(name ? { name } : {}), missing };
}

export function machineRows(current: MachineFields, patch: Partial<MachineFields>): string[] {
  return (Object.keys(patch) as MachineKey[]).map((k) => {
    const f = MACHINE_FIELDS[k];
    const u = f.unit ? ` ${f.unit}` : '';
    return `${f.label}: ${String(current[k])}${u} → ${String(patch[k])}${u}`;
  });
}
