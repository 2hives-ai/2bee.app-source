/**
 * 2bee.cnc — "Ask a model" for a JOB, not for a text file.
 *
 * Founder 2026-10-12, option (B): the model proposes a change to the job's
 * SETTINGS, the core re-plans with it, every existing refusal and check runs,
 * and the operator applies it or does not. Option (C), the model editing the
 * G-code, was refused: hand-edited G-code lands AFTER every check this lane has
 * (entry ramps, depth caps, clamps, spindle dwell, off-material, spoilboard).
 *
 * What this module decides, and why each rule is a rule:
 *
 *  1. 🔴 THE MODEL MAY CHANGE HOW TO CUT, NEVER WHAT IS TRUE. Only cutting
 *     strategy is patchable: the operation settings and which cutters are in the
 *     set. Machine travel, stock size and thickness, material, clamps, the
 *     datum and `confirmed_clear` are FACTS about the shop. A model that could
 *     declare the sheet thicker or the clamps absent could make a refusal go
 *     away by lying to the planner, and every check downstream would agree.
 *  2. 🔴 A PROPOSAL IS APPLIED WHOLE OR NOT AT ALL. One unknown field, one wrong
 *     type, one tool that is not in the library refuses the whole reply, by
 *     name. Applying the valid half would be a change nobody proposed.
 *  3. The bounds below are TYPE SANITY ONLY (positive, finite, not absurd).
 *     They are not cutting limits. The core decides what is cuttable, with the
 *     machine, material and tool it actually has.
 *  4. Nothing here plans or applies anything. `App.tsx` plans the candidate
 *     with the same `planImportMany` the tab already uses, and a candidate the
 *     core refuses cannot be applied (see {@link mayApplyJob}).
 */
import type { AskConfig, AskRequest } from '../cad/ask';
import type { JobConfig } from '../cam';

/** The op settings the model may change, keyed by the core's own field names. */
export type OpKey =
  | 'depth_per_pass_mm'
  | 'rpm'
  | 'entry'
  | 'direction'
  | 'dogbone'
  | 'finish_allowance_mm'
  | 'lead_mm'
  | 'tabs_enabled'
  | 'tab_height_mm'
  | 'tab_width_mm'
  | 'tab_min_spacing_mm';

type FieldSpec =
  | { kind: 'number'; label: string; unit: string; min: number; max: number; zeroOk: boolean }
  | { kind: 'enum'; label: string; options: readonly string[] }
  | { kind: 'bool'; label: string };

/**
 * Every patchable op field. The enum options are the ones the Operation panel
 * offers (`panels/OperationPanel.tsx`); `Helix` is offered there and refused by
 * the core as unimplemented, and is kept here for the same reason — the core's
 * refusal is the one that should say so.
 */
export const OP_FIELDS: Readonly<Record<OpKey, FieldSpec>> = {
  depth_per_pass_mm: { kind: 'number', label: 'Depth per pass', unit: 'mm', min: 0, max: 50, zeroOk: false },
  rpm: { kind: 'number', label: 'Spindle speed', unit: 'rpm', min: 0, max: 60000, zeroOk: false },
  entry: { kind: 'enum', label: 'Entry', options: ['Ramp', 'Helix', 'Plunge'] },
  direction: { kind: 'enum', label: 'Direction', options: ['Climb', 'Conventional'] },
  dogbone: { kind: 'enum', label: 'Dogbone', options: ['Corner', 'TBoneX', 'TBoneY', 'None'] },
  finish_allowance_mm: { kind: 'number', label: 'Finish allowance', unit: 'mm', min: 0, max: 5, zeroOk: true },
  lead_mm: { kind: 'number', label: 'Lead in/out', unit: 'mm', min: 0, max: 50, zeroOk: true },
  tabs_enabled: { kind: 'bool', label: 'Tabs' },
  tab_height_mm: { kind: 'number', label: 'Tab height', unit: 'mm', min: 0, max: 50, zeroOk: false },
  tab_width_mm: { kind: 'number', label: 'Tab width', unit: 'mm', min: 0, max: 100, zeroOk: false },
  tab_min_spacing_mm: { kind: 'number', label: 'Tab min spacing', unit: 'mm', min: 0, max: 2000, zeroOk: false },
};

export const OP_KEYS = Object.keys(OP_FIELDS) as OpKey[];

/** A validated proposal. `op` and `tool_ids` hold only fields that CHANGE. */
export interface JobPatch {
  op: Partial<Record<OpKey, number | string | boolean>>;
  tool_ids?: string[];
}

export type JobProposal =
  | { ok: true; patch: JobPatch; why: string; unchanged: string[] }
  | { ok: false; problems: string[] };

/** What the model is shown about the job. Everything in it is listed to the operator. */
export interface JobContext {
  op: Record<OpKey, number | string | boolean>;
  toolIds: string[];
  /** Every tool id the library holds: the only ids a proposal may use. */
  library: string[];
  /** Read-only facts, sent so the model can reason, never patchable. */
  facts: Record<string, unknown>;
  /** The current plan, as the core reported it. */
  plan: { ok: boolean; refusals: string[]; warnings: string[]; notes: string[]; summary: string };
}

/** Pick the patchable part of the config the tab is planning with. */
export function opOf(config: JobConfig): Record<OpKey, number | string | boolean> {
  const op = (config.op ?? {}) as Record<string, unknown>;
  const out = {} as Record<OpKey, number | string | boolean>;
  for (const k of OP_KEYS) out[k] = op[k] as number | string | boolean;
  return out;
}

export const JOB_SYSTEM_INSTRUCTION = [
  'You help an operator change the settings of a CNC routing job planned by 2bee.cnc.',
  'You may change ONLY the fields listed under "patchable", and the cutter set under "tool_ids".',
  'Everything under "facts" is a fact about the shop (machine, workpiece, material, clamps). You may',
  'not change it, and you must not assume it is different from what it says.',
  'You do NOT write G-code. The planner writes the program from the settings and runs its own checks.',
  'Reply with ONE JSON object and nothing else, in this shape:',
  '{"changes": {"<field>": <value>, ...}, "tool_ids": ["<id>", ...], "why": "<one or two sentences>"}',
  'Omit "tool_ids" to keep the cutter set. Use only ids listed under "library". Numbers are millimetres',
  'or rpm as labelled. If nothing should change, reply with {"changes": {}, "why": "<reason>"}.',
].join('\n');

export function jobUserMessage(prompt: string, ctx: JobContext): string {
  const patchable: Record<string, unknown> = {};
  for (const k of OP_KEYS) {
    const f = OP_FIELDS[k];
    patchable[k] = {
      label: f.label,
      current: ctx.op[k],
      ...(f.kind === 'enum' ? { options: f.options } : {}),
      ...(f.kind === 'number' ? { unit: f.unit } : {}),
    };
  }
  return [
    `Request: ${prompt}`,
    '',
    JSON.stringify(
      { patchable, tool_ids: ctx.toolIds, library: ctx.library, facts: ctx.facts, plan: ctx.plan },
      null,
      2,
    ),
  ].join('\n');
}

export function buildJobRequest(cfg: AskConfig, prompt: string, ctx: JobContext): AskRequest {
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
        { role: 'system', content: JOB_SYSTEM_INSTRUCTION },
        { role: 'user', content: jobUserMessage(prompt, ctx) },
      ],
      temperature: 0,
      stream: false,
    },
  };
}

/** What leaves the browser, in words, shown before anything is sent. */
export function jobTransmissionSummary(req: AskRequest, prompt: string, ctx: JobContext): string[] {
  return [
    `POST to ${req.url || '(no endpoint configured)'}`,
    req.headers.authorization ? 'your API key, as an Authorization: Bearer header' : 'no Authorization header',
    `the model id: ${req.body.model || '(none)'}`,
    `your request (${prompt.length} characters)`,
    `the ${OP_KEYS.length} operation settings, the cutter set and the ${ctx.library.length} library tool names`,
    'the machine, workpiece, material and clamp settings, marked as facts it may not change',
    `the current plan's refusals, warnings and notes, and its summary line`,
    'NOT the drawings, NOT the G-code, no identifier, no telemetry',
  ];
}

/**
 * Read the model's text into a proposal, or into named problems.
 *
 * Accepts the object bare or inside one ```json fence. Anything else — prose
 * around it, two objects, a field it may not touch — is a problem by name.
 */
export function readJobProposal(text: string, ctx: Pick<JobContext, 'op' | 'toolIds' | 'library'>): JobProposal {
  const problems: string[] = [];
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(trimmed);
  const body = fenced ? fenced[1] : trimmed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return {
      ok: false,
      problems: [
        `the reply is not one JSON object (first 160 characters: ${JSON.stringify(trimmed.slice(0, 160))})`,
      ],
    };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, problems: ['the reply is JSON but not an object'] };
  }
  const obj = parsed as Record<string, unknown>;
  for (const k of Object.keys(obj)) {
    if (!['changes', 'tool_ids', 'why'].includes(k)) problems.push(`unknown top-level key "${k}"`);
  }
  const why = typeof obj.why === 'string' ? obj.why.trim() : '';
  if (!why) problems.push('no "why": a change with no stated reason is not offered');

  const changes = obj.changes ?? {};
  const op: JobPatch['op'] = {};
  const unchanged: string[] = [];
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
    problems.push('"changes" is not an object');
  } else {
    for (const [k, v] of Object.entries(changes as Record<string, unknown>)) {
      if (!Object.prototype.hasOwnProperty.call(OP_FIELDS, k)) {
        problems.push(`"${k}" may not be changed by a model — only the operation settings and the cutter set`);
        continue;
      }
      const key = k as OpKey;
      const f = OP_FIELDS[key];
      if (f.kind === 'number') {
        if (typeof v !== 'number' || !Number.isFinite(v)) {
          problems.push(`${f.label} must be a number, got ${JSON.stringify(v)}`);
          continue;
        }
        if (v < f.min || v > f.max || (!f.zeroOk && v === 0)) {
          problems.push(`${f.label} ${v} ${f.unit} is outside ${f.zeroOk ? '' : 'more than '}${f.min} to ${f.max} ${f.unit}`);
          continue;
        }
      } else if (f.kind === 'enum') {
        if (typeof v !== 'string' || !f.options.includes(v)) {
          problems.push(`${f.label} must be one of ${f.options.join(', ')}, got ${JSON.stringify(v)}`);
          continue;
        }
      } else if (typeof v !== 'boolean') {
        problems.push(`${f.label} must be true or false, got ${JSON.stringify(v)}`);
        continue;
      }
      if (ctx.op[key] === v) unchanged.push(f.label);
      else op[key] = v as number | string | boolean;
    }
  }

  let tool_ids: string[] | undefined;
  if (obj.tool_ids !== undefined) {
    const t = obj.tool_ids;
    if (!Array.isArray(t) || t.length === 0 || !t.every((x) => typeof x === 'string')) {
      problems.push('"tool_ids" must be a non-empty list of tool names');
    } else {
      const unknown = t.filter((x) => !ctx.library.includes(x));
      if (unknown.length) problems.push(`not in the tool library: ${unknown.map((x) => JSON.stringify(x)).join(', ')}`);
      else if (new Set(t).size !== t.length) problems.push('"tool_ids" lists a tool twice');
      else if (t.length !== ctx.toolIds.length || t.some((x, i) => x !== ctx.toolIds[i])) tool_ids = t as string[];
      else unchanged.push('Cutter set');
    }
  }

  if (problems.length) return { ok: false, problems };
  return { ok: true, patch: { op, ...(tool_ids ? { tool_ids } : {}) }, why, unchanged };
}

export function patchIsEmpty(p: JobPatch): boolean {
  return Object.keys(p.op).length === 0 && p.tool_ids === undefined;
}

/**
 * The config the core plans the CANDIDATE with: the tab's own config, with the
 * patch laid over `op` and `tool_ids` and nothing else touched. A test asserts
 * that every other key is carried through by identity.
 */
export function candidateConfig(config: JobConfig, patch: JobPatch): JobConfig {
  return {
    ...config,
    op: { ...(config.op ?? {}), ...patch.op },
    ...(patch.tool_ids ? { tool_ids: patch.tool_ids } : {}),
  };
}

/** One row per changed setting, for the diff the operator reads before applying. */
export function patchRows(before: JobContext['op'], toolIds: string[], patch: JobPatch): { label: string; from: string; to: string }[] {
  const rows = (Object.keys(patch.op) as OpKey[]).map((k) => {
    const f = OP_FIELDS[k];
    const unit = f.kind === 'number' ? ` ${f.unit}` : '';
    return { label: f.label, from: `${String(before[k])}${unit}`, to: `${String(patch.op[k])}${unit}` };
  });
  if (patch.tool_ids) rows.push({ label: 'Cutter set', from: toolIds.join(', '), to: patch.tool_ids.join(', ') });
  return rows;
}

/**
 * 🔴 A candidate the core refused cannot be applied. Same rule as the cad
 * panel's `mayApply`: the core judges the output, not the model. A refused plan
 * carries no program, so "apply and see" would replace a working job with none.
 */
export function mayApplyJob(candidate: { ok: boolean; refusals: string[] } | null, patch: JobPatch | null): boolean {
  return !!candidate && !!patch && candidate.ok && candidate.refusals.length === 0 && !patchIsEmpty(patch);
}

/**
 * The cnc store field each op key is held in — the SAME fields the Operation
 * panel's controls set, so an applied patch is indistinguishable from the
 * operator typing it, and the tab re-plans through its normal path.
 */
export const OP_STORE_FIELD: Readonly<Record<OpKey, string>> = {
  depth_per_pass_mm: 'depthPerPass',
  rpm: 'rpm',
  entry: 'entry',
  direction: 'direction',
  dogbone: 'dogbone',
  finish_allowance_mm: 'finishAllowance',
  lead_mm: 'leadMm',
  tabs_enabled: 'tabsEnabled',
  tab_height_mm: 'tabHeight',
  tab_width_mm: 'tabWidth',
  tab_min_spacing_mm: 'tabSpacing',
};

/** The store update an applied patch makes. Pure, so a test can check the mapping. */
export function storeUpdateOf(patch: JobPatch): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch.op)) out[OP_STORE_FIELD[k as OpKey]] = v;
  if (patch.tool_ids) out.toolIds = patch.tool_ids;
  return out;
}
