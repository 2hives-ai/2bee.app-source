// 2bee.pnp — asking a model about the board and the tray plan (founder
// 2026-10-15: *"the pnp should be the same concept (left side AI agent, on top
// select the pcb) below the 3d have the machine"*).
//
// Same shape as `cnc/jobAsk.ts` and `machines/machineAsk.ts`: the model answers
// and MAY propose a patch; this file refuses anything outside the two settings
// below before it reaches a setter, and the tab then re-runs `preflight` on the
// candidate and applies it only if `mayApplyPnp` says so.
//
// WHAT THE MODEL MAY CHANGE: the board count, and the trays on the machine
// (tray id + a variant `cad`'s tray spec defines). Nothing else.
// WHAT IT MAY NOT: tape overrides (a fact about a physical reel — it cannot know
// one), the BOM/CPL (pcb's), the tray geometry (cad's), the machine (pnp's).
// It never commands a machine: nothing on this tab talks to one.

import type { AskConfig, AskRequest } from '../cad/ask';
import type { PreflightResult, TrayDef, Vspec } from './manifest';

export interface PnpSettings {
  boards: number;
  trays: TrayDef[];
}
export type PnpPatch = Partial<PnpSettings>;

export const MAX_BOARDS = 1000;
export const MAX_TRAYS = 24;

export interface PnpContext {
  board: string;
  settings: PnpSettings;
  vspec: Vspec;
  result: PreflightResult | string | null;
  machine: string;
}

export const PNP_SYSTEM_INSTRUCTION = [
  'You help an operator plan a pick-and-place job in 2bee.pnp: which parts go in which tray lane.',
  'You can answer questions about the board, its parts, the tray plan and its refusals and warnings.',
  'You may propose changes to ONLY two settings: "boards" (how many boards to build, a whole number 1..' +
    MAX_BOARDS +
    ') and "trays" (the full list of trays on the machine, each {"trayId": "<short id>", "variant": "<a variant from the tray spec>"}, at most ' +
    MAX_TRAYS +
    ').',
  'You cannot change tape overrides, the BOM, the CPL, the tray geometry or the machine, and you never command a machine.',
  'Answer with ONE JSON object and nothing else: {"answer": "<plain-text answer, short>", "patch": {...}}.',
  'Use an empty patch {} when the operator only asked a question or nothing should change. When you change trays, send the WHOLE new list.',
].join('\n');

/** The job, as text the model reads. Bounded, so a 120-part board stays small. */
export function describeContext(c: PnpContext): string {
  const lines: string[] = [];
  lines.push(`Board: ${c.board || '(none selected)'}`);
  lines.push(`Machine: ${c.machine}`);
  lines.push(`Settings: ${JSON.stringify(c.settings)}`);
  lines.push(
    `Tray spec (cad): ${Object.entries(c.vspec)
      .map(([v, s]) => `${v}: ${s.lanes} lanes x ${s.pocketsPerLane} pockets`)
      .join('; ')}`
  );
  const r = c.result;
  if (r === null) lines.push('Plan: nothing loaded.');
  else if (typeof r === 'string') lines.push(`Plan could not run: ${r}`);
  else {
    const verdict = ['MANIFEST OK', 'REFUSED', 'COULD NOT RUN'][r.exit];
    const k = r.counts;
    lines.push(
      `Plan: ${verdict}. BOM ${k.bomRows} rows, CPL ${k.cplRows} rows, placed ${k.placedLines} lines / ${k.placedParts} parts per board, skipped DNP ${k.skippedDnp}, consigned ${k.skippedConsigned}, other assembly tier ${k.skippedAssembly}.`
    );
    for (const p of r.refusals.slice(0, 20)) lines.push(`Refusal [${p.rule}]: ${p.message}`);
    if (r.refusals.length > 20) lines.push(`… ${r.refusals.length - 20} more refusals`);
    for (const w of r.warnings.slice(0, 12)) lines.push(`Warning: ${w}`);
    for (const l of r.lanes.slice(0, 40))
      lines.push(`Lane ${l.trayId}/${l.lane}: ${l.mfrPn} ${l.value} ${l.pkg} need ${l.need} of ${l.capacity}`);
    if (Object.keys(r.lanesNeeded).length)
      lines.push(
        `Lanes needed: ${Object.entries(r.lanesNeeded)
          .map(([v, n]) => `${v} ${n.lanes} lanes = ${n.trays} trays`)
          .join(', ')}`
      );
  }
  return lines.join('\n');
}

export function buildPnpRequest(cfg: AskConfig, prompt: string, c: PnpContext, system = PNP_SYSTEM_INSTRUCTION): AskRequest {
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
        { role: 'system', content: system },
        { role: 'user', content: `${describeContext(c)}\n\nOperator: ${prompt}` },
      ],
      temperature: 0,
      stream: false,
    },
  };
}

export type PnpProposal = { ok: true; patch: PnpPatch; answer: string } | { ok: false; problems: string[] };

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
 * Read and CHECK a reply. Any problem refuses the whole patch — half a patch is a
 * guess at which half the operator meant. A reply that is plain text (no JSON) is
 * an ANSWER with no change, not a failure: a question deserves its answer.
 */
export function readPnpProposal(raw: string, current: PnpSettings, vspec: Vspec): PnpProposal {
  const v = firstObject(raw) as { answer?: unknown; patch?: unknown } | undefined;
  if (!v || typeof v !== 'object') {
    const text = raw.trim();
    return text ? { ok: true, patch: {}, answer: text.slice(0, 2000) } : { ok: false, problems: ['The reply was empty.'] };
  }
  const answer = typeof v.answer === 'string' ? v.answer : '';
  const p = v.patch ?? {};
  if (typeof p !== 'object' || Array.isArray(p) || p === null) return { ok: false, problems: ['"patch" is not an object.'] };
  const problems: string[] = [];
  const patch: PnpPatch = {};
  for (const [k, val] of Object.entries(p as Record<string, unknown>)) {
    if (k === 'boards') {
      if (typeof val !== 'number' || !Number.isInteger(val) || val < 1 || val > MAX_BOARDS)
        problems.push(`boards must be a whole number 1–${MAX_BOARDS}, got ${JSON.stringify(val)}.`);
      else if (val !== current.boards) patch.boards = val;
    } else if (k === 'trays') {
      if (!Array.isArray(val)) {
        problems.push('trays must be a list.');
        continue;
      }
      if (val.length > MAX_TRAYS) problems.push(`trays: ${val.length} is more than ${MAX_TRAYS}.`);
      const seen = new Set<string>();
      const trays: TrayDef[] = [];
      for (const t of val as unknown[]) {
        const o = t as { trayId?: unknown; variant?: unknown };
        if (!o || typeof o.trayId !== 'string' || !/^[A-Za-z0-9_-]{1,12}$/.test(o.trayId)) {
          problems.push(`tray ${JSON.stringify(t)}: trayId must be 1–12 letters, digits, - or _.`);
          continue;
        }
        if (typeof o.variant !== 'string' || !(o.variant in vspec)) {
          problems.push(`tray ${o.trayId}: "${String(o.variant)}" is not a variant in cad's tray spec (${Object.keys(vspec).join(', ')}).`);
          continue;
        }
        if (seen.has(o.trayId)) problems.push(`tray ${o.trayId} listed twice.`);
        seen.add(o.trayId);
        trays.push({ trayId: o.trayId, variant: o.variant });
      }
      if (JSON.stringify(trays) !== JSON.stringify(current.trays)) patch.trays = trays;
    } else problems.push(`"${k}" is not a setting this chat may change.`);
  }
  if (problems.length) return { ok: false, problems };
  return { ok: true, patch, answer };
}

export function patchIsEmpty(p: PnpPatch): boolean {
  return p.boards === undefined && p.trays === undefined;
}

export function pnpRows(current: PnpSettings, patch: PnpPatch): string[] {
  const rows: string[] = [];
  if (patch.boards !== undefined) rows.push(`Boards: ${current.boards} → ${patch.boards}`);
  if (patch.trays !== undefined) {
    const f = (ts: TrayDef[]) => ts.map((t) => `${t.trayId}:${t.variant}`).join(' ') || '(none)';
    rows.push(`Trays: ${f(current.trays)} → ${f(patch.trays)}`);
  }
  return rows;
}

/**
 * May a candidate plan replace the current one? The tab's own check, the same
 * role `mayApplyJob` plays for cnc:
 *  · never when the candidate COULD NOT RUN (exit 2) or is not a plan at all;
 *  · always when it is a usable manifest (exit 0);
 *  · when it is REFUSED, only if the current plan is refused too and the
 *    candidate has STRICTLY FEWER refusals — a step towards a usable manifest.
 *    A lateral or worse change is refused, with the candidate's refusals shown.
 * ⚠ Fewer refusals is a count, not a proof that none is new; the chat lists the
 * candidate's remaining refusals so a person sees exactly what is left.
 */
export function mayApplyPnp(current: PreflightResult | string | null, candidate: PreflightResult | string | null): boolean {
  if (candidate === null || typeof candidate === 'string' || candidate.exit === 2) return false;
  if (candidate.exit === 0) return true;
  if (current === null || typeof current === 'string' || current.exit !== 1) return false;
  return candidate.refusals.length < current.refusals.length;
}
