/**
 * The AI's review of an EDITED functional specification, and the AI draft of a missing one.
 *
 * Founder 2026-10-16: *"user should able to edit what ai will review and work on it if it
 * changes the design"*. On Save the model gets the old spec, the new spec and the design
 * (the .scad source for cad, a board summary for pcb) and answers with ONE JSON object:
 *
 *   { "designChange": boolean, "summary": string, "changes": string[], "conflicts": string[] }
 *
 * 🔴 THE REPLY IS READ STRICTLY. Not JSON, not an object, an unknown key, a missing key, a
 * wrong type: each is refused and named, and nothing from that reply is shown as a review.
 * A lenient reader would turn "the model said something" into "the design must change".
 *
 * ⚠ The review is the model's reading of the text it was sent. It is not a check of the
 * part: the design's own gates still decide what may be cut, printed or sent to pcb.
 * ⚠ The model never changes the design from here. For cad, `changes` is handed to the cad
 * chat, which goes through its own checked apply and Undo; for pcb it is text for a ticket.
 */
import type { AskConfig, AskRequest, AskTransportResult } from '../cad/ask';
import { SPEC_HEADINGS } from './specStore';

/** Design source sent to the model is cut here; the cut is said on screen. */
export const DESIGN_CAP = 60_000;

export interface SpecReview {
  designChange: boolean;
  summary: string;
  changes: string[];
  conflicts: string[];
}

export type ReviewRead = { ok: true; review: SpecReview } | { ok: false; problem: string };

const REVIEW_KEYS = ['designChange', 'summary', 'changes', 'conflicts'] as const;

export const REVIEW_INSTRUCTION = [
  'You review an edit to the functional specification of a physical design (a part modelled in OpenSCAD for CNC routing or 3D printing, or a printed circuit board).',
  'You get the OLD specification, the NEW specification, and the CURRENT design.',
  'Decide whether the current design must change to meet the NEW specification.',
  'Reply with exactly ONE JSON object and nothing else, no prose and no code fence:',
  '{"designChange": true|false, "summary": "<one or two sentences>", "changes": ["<plain-language change request>", ...], "conflicts": ["<requirement the current design violates>", ...]}',
  'Rules: "changes" are concrete requests a designer could act on, each naming the feature and the target value from the NEW specification. "conflicts" name the requirement (its FR number if it has one) and what in the current design breaks it.',
  'Use only what the NEW specification states. Do not add requirements it does not state. If the design does not show enough to decide, say so in "summary" and leave the lists empty.',
  'designChange is true only when "changes" is not empty.',
].join('\n');

export const DRAFT_INSTRUCTION = [
  'You draft a functional specification for a physical design from its source alone.',
  'Write Markdown with exactly these eight headings, in this order, each as "## <heading>":',
  ...SPEC_HEADINGS.map((h) => `- ${h}`),
  'Under "2. Functional requirements" write numbered requirements FR-1, FR-2, … each with: the requirement, why, verified by, source (the line or parameter in the design it comes from).',
  'State ONLY what the design source shows: dimensions and parameters it declares, features it models, comments it carries. Do not invent loads, materials, tolerances, standards or purposes it does not state.',
  'Everything you cannot read from the source goes under "8. Not stated / open questions" as a question.',
  'Reply with the Markdown only.',
].join('\n');

function capDesign(design: string): { text: string; cut: boolean } {
  return design.length > DESIGN_CAP ? { text: design.slice(0, DESIGN_CAP), cut: true } : { text: design, cut: false };
}

function request(cfg: AskConfig, system: string, user: string): AskRequest {
  return {
    url: cfg.endpoint,
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
    body: { model: cfg.model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], temperature: 0, stream: false },
  };
}

export function buildReviewRequest(
  cfg: AskConfig,
  i: { kind: 'cad' | 'pcb'; title: string; oldSpec: string; newSpec: string; design: string },
): { req: AskRequest; cut: boolean } {
  const d = capDesign(i.design);
  const what = i.kind === 'cad' ? 'OpenSCAD source' : 'board summary';
  const user =
    `Design: ${i.title}\n\n----- OLD specification -----\n${i.oldSpec || '(none)'}\n\n` +
    `----- NEW specification -----\n${i.newSpec}\n\n----- CURRENT design (${what}${d.cut ? ', cut to fit' : ''}) -----\n${d.text}`;
  return { req: request(cfg, REVIEW_INSTRUCTION, user), cut: d.cut };
}

export function buildDraftRequest(cfg: AskConfig, i: { kind: 'cad' | 'pcb'; title: string; design: string }): { req: AskRequest; cut: boolean } {
  const d = capDesign(i.design);
  const what = i.kind === 'cad' ? 'OpenSCAD source' : 'board summary';
  return { req: request(cfg, DRAFT_INSTRUCTION, `Design: ${i.title}\n\n----- ${what}${d.cut ? ' (cut to fit)' : ''} -----\n${d.text}`), cut: d.cut };
}

/** `choices[0].message.content` as a string, or a sentence saying why not. */
export function replyContent(r: AskTransportResult): { ok: true; text: string } | { ok: false; problem: string } {
  if (!r.ok) {
    let why = '';
    try {
      const j = JSON.parse(r.text) as { error?: { message?: string } | string } | null;
      why = typeof j?.error === 'string' ? j.error : (j?.error?.message ?? '');
    } catch {
      why = r.text.slice(0, 300);
    }
    return { ok: false, problem: `the AI endpoint refused the request (HTTP ${r.status})${why ? `: ${why}` : ''}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.text);
  } catch {
    return { ok: false, problem: 'the endpoint answered with something that is not JSON' };
  }
  const content = (parsed as { choices?: { message?: { content?: unknown } }[] } | null)?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') return { ok: false, problem: 'the reply was not in the chat-completions shape (choices[0].message.content)' };
  return { ok: true, text: content };
}

const isStrList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/**
 * Read the model's review. ONE optional ```json fence around the whole reply is
 * tolerated (models add it despite being told not to); anything else is refused.
 */
export function readReview(content: string): ReviewRead {
  let t = content.trim();
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(t);
  if (fence) t = fence[1].trim();
  let v: unknown;
  try {
    v = JSON.parse(t);
  } catch {
    return { ok: false, problem: `the review was not one JSON object (it began: ${JSON.stringify(t.slice(0, 80))})` };
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, problem: 'the review was JSON but not an object' };
  const o = v as Record<string, unknown>;
  const unknown = Object.keys(o).filter((k) => !(REVIEW_KEYS as readonly string[]).includes(k));
  if (unknown.length) return { ok: false, problem: `the review carried key(s) this app does not read: ${unknown.join(', ')}` };
  const missing = REVIEW_KEYS.filter((k) => !(k in o));
  if (missing.length) return { ok: false, problem: `the review is missing: ${missing.join(', ')}` };
  if (typeof o.designChange !== 'boolean') return { ok: false, problem: '"designChange" must be true or false' };
  if (typeof o.summary !== 'string') return { ok: false, problem: '"summary" must be text' };
  if (!isStrList(o.changes)) return { ok: false, problem: '"changes" must be a list of texts' };
  if (!isStrList(o.conflicts)) return { ok: false, problem: '"conflicts" must be a list of texts' };
  const changes = o.changes.map((c) => c.trim()).filter(Boolean);
  if (o.designChange && changes.length === 0) {
    return { ok: false, problem: 'the review said the design must change and named no change' };
  }
  return { ok: true, review: { designChange: o.designChange, summary: o.summary, changes, conflicts: o.conflicts.map((c) => c.trim()).filter(Boolean) } };
}

/** Headings of the template that a draft lacks — a draft missing any is refused. */
export function missingHeadings(md: string): string[] {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const have = md
    .split('\n')
    .filter((l) => /^#{1,4}\s/.test(l))
    .map((l) => norm(l.replace(/^#+\s*/, '')));
  return SPEC_HEADINGS.filter((h) => !have.some((x) => x.startsWith(norm(h))));
}

/** The request handed to the cad chat when the user asks for the design to change. */
export function changeRequestText(review: SpecReview): string {
  return (
    'Change the design to meet its edited functional specification, keeping everything else as it is: ' +
    review.changes.map((c, i) => `(${i + 1}) ${c}`).join(' ')
  );
}

/** Clipboard text for pcb — a request the user files; this app cannot change a board. */
export function pcbRequestText(board: string, review: SpecReview, newSpec: string): string {
  return [
    `Request to pcb — board ${board}: the functional specification was edited and the AI review says the board must change.`,
    '',
    `Summary: ${review.summary}`,
    '',
    'Change requests:',
    ...review.changes.map((c, i) => `${i + 1}. ${c}`),
    ...(review.conflicts.length ? ['', 'Conflicts with the current board:', ...review.conflicts.map((c) => `- ${c}`)] : []),
    '',
    '(An AI reading of the edited spec against a board summary, from 2bee.app. Not checked against the board files.)',
    '',
    '----- edited specification -----',
    newSpec,
  ].join('\n');
}
