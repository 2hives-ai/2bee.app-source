/* toolPhotoAsk.ts — PHOTO A CUTTER, LET THE AI PROPOSE WHAT IT IS.
 *
 * Founder, 2026-10-15: *"In the tools section able to photo the tool and ai
 * should recognise it."*
 *
 * ── WHAT THIS DOES ─────────────────────────────────────────────────────────
 *
 * (2026-10-15, later: founder *"cnc.tools is the same (ai is on the left side,
 * and user should able to add/phot a new tool"* — the same parser now also
 * reads the chat's WORDS, with or without a photo; see `ToolChat.tsx`.)
 *
 * Sends ONE downscaled photo to the operator's configured "Ask a model"
 * endpoint (the same config `cad/ask.tsx` reads — in practice the local
 * `claude` CLI behind `tools/claude-bridge/`), and turns the reply into a
 * PROPOSAL: a `ToolDraft` for the existing add-cutter form, plus the list of
 * what it could not read.
 *
 * ── WHAT THIS DOES NOT DO ──────────────────────────────────────────────────
 *
 * - 🔴 It never registers a cutter. The proposal fills the form; a human checks
 *   it and presses Register, and `validateToolDraft` (the form's own rule) is
 *   the only gate a value passes.
 * - It does not "fix" a value. A type outside `TOOL_TYPES`, a number that is
 *   not a positive finite number, a whole-number field that is not whole, an
 *   angle on a non-angular type — each is left EMPTY and NAMED, never mapped to
 *   the nearest plausible thing.
 * - It does not treat the model's numbers as measurements. A size read from a
 *   photo is a guess at a scale the camera never had; the page says so, and the
 *   cutter is a 2.2 kW-spindle safety item.
 * - It does not fetch. The image goes as a `data:` URL; the bridge refuses
 *   anything else.
 */

import { fieldGuide, FLUTE_DIRECTIONS, isToolType, ANGULAR_TYPES, EMPTY_DRAFT, TOOL_TYPES, type ToolDraft } from './toolRegistry';
import type { AskConfig, AskFailure, AskTransportResult } from '../cad/ask';

/** The fields the model may fill. `label` stays the human's. */
export const PROPOSED_FIELDS = [
  'type',
  'diameter_mm',
  'flutes',
  'cutting_length_mm',
  'shank_mm',
  'overall_length_mm',
  'included_angle_deg',
  'flute_type',
  'material',
] as const;
export type ProposedField = (typeof PROPOSED_FIELDS)[number];

const NUMERIC: readonly ProposedField[] = ['diameter_mm', 'flutes', 'cutting_length_mm', 'shank_mm', 'overall_length_mm', 'included_angle_deg'];

/** Human names for every field, for the "could not read" list. */
export function fieldName(f: ProposedField): string {
  if (f === 'type') return 'Type';
  if (f === 'flute_type') return 'Flute direction';
  if (f === 'material') return 'Cutter material';
  return fieldGuide(f).label;
}

export const PHOTO_SYSTEM_INSTRUCTION = [
  'You identify CNC router cutters from a photo and/or the operator\'s description. Answer with ONE JSON object and nothing else — no prose, no code fence.',
  'If the current form values are given, return the COMPLETE cutter: keep those values unless the operator or the photo changes them.',
  'Keys (use null for anything you cannot read with confidence; NEVER guess a number to fill a gap):',
  `  "type": exactly one of ${TOOL_TYPES.map((t) => JSON.stringify(t)).join(', ')}, or null`,
  '  "diameter_mm": cutting diameter in millimetres (number) or null',
  '  "flutes": number of cutting edges (whole number) or null',
  '  "cutting_length_mm": length of the fluted part, mm, or null',
  '  "shank_mm": shank diameter, mm, or null',
  '  "overall_length_mm": tip to back end, mm, or null',
  '  "included_angle_deg": full V angle in degrees, only for V-Bit/Chamfer/Countersink/Engraving, else null',
  `  "flute_type": one of ${FLUTE_DIRECTIONS.map((t) => JSON.stringify(t)).join(', ')}, or null`,
  '  "material": cutter material/coating if visible or printed (e.g. "carbide", "HSS", "TiAlN-coated carbide"), or null',
  '  "confidence": "high", "medium" or "low" — for the identification as a whole',
  '  "unreadable": array of the key names above you could not read, each with a short reason, e.g. ["overall_length_mm: no scale in the photo"]',
  '  "notes": one short sentence on what you based it on (e.g. "6.35 printed on shank"), or null',
  'A size is only readable if the operator stated it, it is printed/engraved on the cutter or its packaging, or a ruler/calipers with a legible scale is in the photo. Otherwise return null for it.',
  'Never fill a value from what is "standard" or "typical" for that kind of cutter (e.g. 2 flutes for a twist drill): only what is stated, printed, or countable in the photo.',
  'If the text or photo is a SET of several cutters in different sizes, set "diameter_mm" to null and add "set": {"variants": [{"name": "<variant as the seller names it, e.g. 25pcs>", "diameters_mm": [numbers]}]} — one variant per option the listing offers (one variant if there is only one). Facts shared by every cutter in the set (type, material, flutes, angle, flute direction) go in the top-level keys.',
].join('\n');

export const PHOTO_USER_TEXT = 'Which cutter is this? Reply with the JSON object only.';

/** The structured request. Same shape as `cad/ask.tsx::AskRequest`, but the user turn carries an image. */
export interface PhotoAskRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: {
    model: string;
    messages: (
      | { role: 'system'; content: string }
      | { role: 'user'; content: ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } })[] }
    )[];
    temperature: number;
    stream: false;
  };
}

/** Largest data URL this sends. The bridge's default body cap is 2 MiB; a
 *  1024 px JPEG is normally a few hundred kB. Above this it refuses, naming why. */
export const MAX_PHOTO_DATA_URL = 1_500_000;

export function buildPhotoRequest(cfg: AskConfig, dataUrl: string): PhotoAskRequest {
  return buildToolRequest(cfg, { dataUrl });
}

/** The values the form holds now, as context for a follow-up ("make it 3 flutes"). */
function formContext(d: ToolDraft | null | undefined): string {
  if (!d) return '';
  const set = PROPOSED_FIELDS.filter((f) => d[f].trim() !== '').map((f) => `${f}=${JSON.stringify(d[f].trim())}`);
  return set.length ? `\n\nCurrent form values: ${set.join(', ')}` : '';
}

/**
 * One request: the operator's words, a photo, or both. The photo is the only
 * image; earlier chat turns are NOT sent — the form is the conversation's
 * state, so it goes along instead.
 */
export function buildToolRequest(cfg: AskConfig, ask: { text?: string; dataUrl?: string; current?: ToolDraft | null }): PhotoAskRequest {
  const words = (ask.text ?? '').trim();
  const text = (words ? `Operator: ${words}` : PHOTO_USER_TEXT) + formContext(ask.current) + (words ? '\nReply with the JSON object only.' : '');
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
        { role: 'system', content: PHOTO_SYSTEM_INSTRUCTION },
        {
          role: 'user',
          content: [{ type: 'text', text }, ...(ask.dataUrl ? [{ type: 'image_url' as const, image_url: { url: ask.dataUrl } }] : [])],
        },
      ],
      temperature: 0,
      stream: false,
    },
  };
}

export type PhotoTransport = (req: PhotoAskRequest, signal: AbortSignal) => Promise<AskTransportResult>;

/** `fetch`, as `cad/ask.tsx::fetchTransport` does it. */
export const photoFetchTransport: PhotoTransport = async (req, signal) => {
  const res = await fetch(req.url, { method: req.method, headers: req.headers, body: JSON.stringify(req.body), signal });
  return { status: res.status, ok: res.ok, text: await res.text() };
};

/* ── The proposal ──────────────────────────────────────────────────────────── */

export type Confidence = 'high' | 'medium' | 'low' | 'not stated';

export interface Unread {
  field: ProposedField;
  why: string;
}

export interface ToolProposal {
  /** EMPTY_DRAFT with only the readable fields filled. `label` is always ''. */
  draft: ToolDraft;
  /** Fields the reply filled, in form order. */
  filled: ProposedField[];
  /** Every field left empty, and why. Never silently dropped. */
  unread: Unread[];
  confidence: Confidence;
  notes: string | null;
  /**
   * A SET of cutters (founder 2026-10-15, a 25-piece drill set: "it has several
   * drills"): each variant the listing offers and its diameters. The shared
   * facts are in `draft`; the human picks the variant and the sizes they own.
   */
  set: { variants: { name: string; diameters: number[] }[] } | null;
}

export type ProposalResult = { ok: true; proposal: ToolProposal } | { ok: false; why: string };

/** The JSON object in a reply: the whole text, a fenced block, or the outermost {…}. */
function jsonObjectIn(text: string): unknown {
  const t = text.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  const candidates = [t, fence?.[1]?.trim() ?? '', t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1)];
  for (const c of candidates) {
    if (!c) continue;
    try {
      const v = JSON.parse(c);
      if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    } catch {
      /* next candidate */
    }
  }
  return null;
}

function asNumber(v: unknown): number | null | 'bad' {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 'bad';
  if (typeof v === 'string') {
    const s = v.trim().replace(/\s*mm$/i, '').replace(/\s*°$/, '').replace(',', '.');
    if (!s) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : 'bad';
  }
  return 'bad';
}

/**
 * Turn the model's text into a proposal. Pure; the parser the node tests pin.
 *
 * Every field is either FILLED with a value the form can hold, or listed in
 * `unread` with a reason. The model's own `unreadable` reasons are kept where it
 * gave one; a value this function rejected says why it was rejected.
 */
export function parseToolProposal(text: string): ProposalResult {
  const o = jsonObjectIn(text) as Record<string, unknown> | null;
  if (!o) return { ok: false, why: 'The model did not answer with a JSON object, so nothing was filled.' };

  const modelReasons = new Map<string, string>();
  if (Array.isArray(o.unreadable)) {
    for (const u of o.unreadable) {
      if (typeof u !== 'string') continue;
      const m = /^\s*"?([a-z_]+)"?\s*[:—-]\s*(.*)$/i.exec(u);
      if (m && (PROPOSED_FIELDS as readonly string[]).includes(m[1])) modelReasons.set(m[1], m[2].trim() || 'not readable from the photo');
      else if ((PROPOSED_FIELDS as readonly string[]).includes(u.trim())) modelReasons.set(u.trim(), 'not readable from the photo');
    }
  }

  const draft: ToolDraft = { ...EMPTY_DRAFT };
  const filled: ProposedField[] = [];
  const unread: Unread[] = [];
  const skip = (field: ProposedField, why: string) => unread.push({ field, why });
  const notGiven = (field: ProposedField) => skip(field, modelReasons.get(field) ?? 'not readable from the photo');

  // Type — exact core spelling only.
  const type = typeof o.type === 'string' ? o.type.trim() : o.type;
  if (type === null || type === undefined || type === '') notGiven('type');
  else if (typeof type === 'string' && isToolType(type)) {
    draft.type = type;
    filled.push('type');
  } else skip('type', `the model said ${JSON.stringify(type)}, which is not a type this app knows — choose it yourself`);

  const angular = isToolType(draft.type) && ANGULAR_TYPES.includes(draft.type);

  for (const f of NUMERIC) {
    const v = asNumber(o[f]);
    const label = fieldName(f);
    if (v === null) {
      // The angle is not asked of a non-angular type (or an unknown one), so its absence is not news.
      if (f === 'included_angle_deg' && !angular) continue;
      notGiven(f);
      continue;
    }
    if (f === 'included_angle_deg' && !angular) {
      skip(f, draft.type ? `${label} applies only to ${ANGULAR_TYPES.join(', ')}, not ${draft.type} — not filled` : `${label} was given but the type is unknown — not filled`);
      continue;
    }
    if (v === 'bad') {
      skip(f, `the model gave ${JSON.stringify(o[f])}, which is not a number — not filled`);
      continue;
    }
    if (v <= 0) {
      skip(f, `the model gave ${v}, which is not a real size — not filled`);
      continue;
    }
    if (f === 'flutes' && !Number.isInteger(v)) {
      skip(f, `the model gave ${v} flutes, which is not a whole number — not filled`);
      continue;
    }
    draft[f] = String(v);
    filled.push(f);
  }

  const ft = typeof o.flute_type === 'string' ? o.flute_type.trim() : o.flute_type;
  if (ft === null || ft === undefined || ft === '') notGiven('flute_type');
  else if (typeof ft === 'string' && (FLUTE_DIRECTIONS as readonly string[]).includes(ft)) {
    draft.flute_type = ft;
    filled.push('flute_type');
  } else skip('flute_type', `the model said ${JSON.stringify(ft)}, which is not a flute direction this app knows — not filled`);

  const mat = typeof o.material === 'string' ? o.material.trim() : null;
  if (mat) {
    draft.material = mat.slice(0, 80);
    filled.push('material');
  } else notGiven('material');

  const c = typeof o.confidence === 'string' ? o.confidence.trim().toLowerCase() : '';
  const confidence: Confidence = c === 'high' || c === 'medium' || c === 'low' ? c : 'not stated';
  const notes = typeof o.notes === 'string' && o.notes.trim() ? o.notes.trim().slice(0, 300) : null;

  let set: ToolProposal['set'] = null;
  const rawSet = o.set as { variants?: unknown } | undefined;
  if (rawSet && typeof rawSet === 'object' && Array.isArray(rawSet.variants)) {
    const variants = rawSet.variants
      .map((v) => {
        const r = v as { name?: unknown; diameters_mm?: unknown };
        const ds = Array.isArray(r.diameters_mm)
          ? [...new Set(r.diameters_mm.map(asNumber).filter((n): n is number => typeof n === 'number' && n > 0 && n <= 100))].sort((a, b) => a - b)
          : [];
        return { name: typeof r.name === 'string' && r.name.trim() ? r.name.trim().slice(0, 40) : `${ds.length} pcs`, diameters: ds.slice(0, 60) };
      })
      .filter((v) => v.diameters.length > 0)
      .slice(0, 12);
    if (variants.length) {
      set = { variants };
      /* The single-cutter diameter does not apply to a set. */
      const i = unread.findIndex((u) => u.field === 'diameter_mm');
      if (i >= 0) unread[i] = { field: 'diameter_mm', why: 'a set: choose the sizes below' };
    }
  }

  if (filled.length === 0 && !set) {
    return { ok: false, why: 'The AI could not tell anything about the cutter from that, so nothing was filled. ' + unread.map((u) => `${fieldName(u.field)}: ${u.why}`).join('; ') + '.' };
  }
  return { ok: true, proposal: { draft, filled, unread, confidence, notes, set } };
}

/** Turn a transport result into a proposal, or a sentence. */
export function readPhotoReply(r: AskTransportResult): ProposalResult {
  if (!r.ok) {
    let why: string;
    try {
      const j = JSON.parse(r.text) as { error?: { message?: string } | string } | null;
      const e = j?.error;
      why = typeof e === 'string' ? e : (e?.message ?? '');
    } catch {
      why = r.text.slice(0, 300);
    }
    return { ok: false, why: `The AI endpoint refused the photo (HTTP ${r.status})${why ? `: ${why}` : ''}.` };
  }
  let content: unknown;
  try {
    content = (JSON.parse(r.text) as { choices?: { message?: { content?: unknown } }[] } | null)?.choices?.[0]?.message?.content;
  } catch {
    return { ok: false, why: 'The AI endpoint answered with something that is not JSON.' };
  }
  if (typeof content !== 'string') return { ok: false, why: 'The AI reply was not in the chat-completions shape this app reads.' };
  return parseToolProposal(content);
}

/** A failure from `cad/ask.tsx::preflight` / `classifyThrow`, as one sentence. */
export function failureSentence(f: AskFailure): string {
  const h = f.headline.charAt(0).toUpperCase() + f.headline.slice(1);
  return `${h}. ${f.detail}`;
}

/** Blob → `data:` URL. Browser-only (FileReader). */
export function blobToDataUrl(b: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error('the photo could not be read'));
    r.readAsDataURL(b);
  });
}
