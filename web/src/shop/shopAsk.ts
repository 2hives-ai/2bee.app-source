/**
 * The design page's assistant — what the model is told, and what it may DO.
 *
 * Founder 2026-10-16: *"Add an ai assistant to the design page as well"*.
 *
 * The model answers questions about the catalogue and may change the VIEW of
 * the page through a small action set. It never sees a design's source: it gets
 * one compact line per entry (id, title, family, kind, machine, size, trust,
 * cad's own sentence), which is everything the cards themselves show.
 *
 * 🔴 EVERY ACTION IS CHECKED AGAINST THE REAL LISTS BEFORE IT REACHES A SETTER.
 * An id the catalogue does not hold, a filter value the page does not offer, a
 * target a card does not offer — each is refused and named, and ONE refused
 * action refuses the whole set (same rule as `machines/machineAsk.ts`): a reply
 * that broke the rules once is not trusted to have got the rest right, and
 * applying half of it would be guessing which half the user meant. The answer
 * text is still shown, because a refusal of the actions is not a refusal of
 * the explanation.
 *
 * ⚠ "Open in …" goes through the page's OWN `open()` — the same fetch, mesh and
 * refusals as the card's button. Nothing here is a second path into a tab.
 * ⚠ The answer is the model's reading of the summary lines below. It is not a
 * check of any design, and the chat says nothing has been cut or printed.
 */
import type { AskConfig, AskRequest } from '../cad/ask';
import type { ShopEntry } from './catalogue';

export type ShowFilter = 'all' | '3d' | 'cad' | 'pcb' | 'mine' | 'archived';
export const SHOW_VALUES: readonly ShowFilter[] = ['all', '3d', 'cad', 'pcb', 'mine', 'archived'];
export type ShopOpenTarget = 'cad' | 'cnc' | '3d' | 'pnp';

export type ShopAction =
  | { type: 'search'; text: string }
  | { type: 'show'; value: ShowFilter }
  | { type: 'family'; value: string }
  | { type: 'view'; id: string }
  | { type: 'open'; id: string; target: ShopOpenTarget }
  /* Founder 2026-10-16 "in the design able to archive": hide/unhide a card in THIS browser
   * (`archive.ts`). Nothing is deleted, which is why the model may do it at all. */
  | { type: 'archive'; id: string }
  | { type: 'restore'; id: string };

/** What the model may name. Built from the page's real lists, never from the reply. */
export interface ShopAskContext {
  entries: readonly Pick<ShopEntry, 'id' | 'title' | 'family' | 'kind' | 'path' | 'sizeMm' | 'trust' | 'describes' | 'partNames' | 'parts'>[];
  /** pnp boards (open in pnp only). Empty when the list is absent or still loading. */
  boards: readonly { id: string; name: string; detail: string }[];
  families: readonly string[];
  /** The view now, so "clear the filter" and follow-ups have something to work from. */
  view: { search: string; show: ShowFilter; family: string };
  /** `machineFor` from make/setup, injected so this file stays free of the app graph. */
  machineOf: (path: string) => 'printer' | 'router' | null;
  /** Design and board ids the user has archived (hidden from the list in this browser). */
  archivedIds?: readonly string[];
}

const MAX_SEARCH = 80;
const MAX_DESC = 160;

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** One line per entry: what a card shows, no sources. */
export function catalogueSummary(ctx: ShopAskContext): string {
  const arch = new Set(ctx.archivedIds ?? []);
  const tag = (id: string) => (arch.has(id) ? ' | ARCHIVED (hidden)' : '');
  const lines = ctx.entries.map((e) => {
    const m = ctx.machineOf(e.path);
    const made = m === 'router' ? 'cnc-cut (flat panel part)' : m === 'printer' ? '3d-printed' : 'neither (assembly/model)';
    const size = e.sizeMm ? `${e.sizeMm.map((n) => Math.round(n * 10) / 10).join('x')} mm` : 'size not measured';
    const desc = (e.describes ?? []).map((d) => clip(d.text, MAX_DESC)).join(' / ');
    const parts = (e.partNames ?? []).length ? ` | parts: ${(e.partNames ?? []).slice(0, 6).join(', ')}` : '';
    return `${e.id} | ${e.title} | family ${e.family} | ${made} | ${size} | mesh ${e.trust}${parts}${desc ? ` | ${desc}` : ''}${tag(e.id)}`;
  });
  const boards = ctx.boards.map((b) => `${b.id} | ${b.name} | PCB (opens in pnp only) | ${clip(b.detail, 100)}${tag(b.id)}`);
  return [
    `DESIGNS (${lines.length}): id | title | family | how it is made | size | mesh verdict | parts | description`,
    ...lines,
    ...(boards.length ? [`PCB BOARDS (${boards.length}): id | name | kind | detail`, ...boards] : []),
  ].join('\n');
}

export const SHOP_SYSTEM_INSTRUCTION = [
  'You are the assistant on the Designs page of 2bee.app (beehive parts and tools). You answer questions about the catalogue listed below and may change what the page SHOWS.',
  'Answer only from the listed lines. Never invent a design, a material, a price or a fact the lines do not state. If the lines do not say (e.g. which panel thickness a part needs), say so plainly. Nothing in the catalogue has been cut or printed; do not say a design is proven.',
  '"cnc-cut" designs are flat parts cut from a panel on the CNC router; "3d-printed" designs are printed on the 3D printer.',
  'Page filters: show = all | 3d (3d-printed only) | cad (cnc-cut only — the page labels the CNC filter "cad") | pcb (circuit boards) | mine (the user\'s own saved designs) | archived (designs and boards the user hid). family = all | one of the families listed. search = text matched against title, path and family.',
  'Actions you may return:',
  '{"type":"search","text":"<words, or empty to clear>"}',
  '{"type":"show","value":"all|3d|cad|pcb|mine|archived"}',
  '{"type":"family","value":"all|<exact family name>"}',
  '{"type":"view","id":"<design id>"} — opens the 3D viewer for one design (not for PCB boards)',
  '{"type":"open","id":"<design or board id>","target":"cad|cnc|3d|pnp"} — designs open in cad, cnc or 3d; PCB boards open in pnp only. Use open ONLY when the user asked to open/edit/cut/print a specific item, and only with an id from the list. At most one open and one view per reply.',
  '{"type":"archive","id":"<design or board id>"} / {"type":"restore","id":"<id marked ARCHIVED>"} — hides a card from the list in this browser, or shows it again. Nothing is deleted. Use ONLY when the user asked to archive/hide or restore/unhide a specific item.',
  'To show a set of designs, prefer show + family over search. Clear a filter that would hide what the user asked for. Use the exact ids from the list; never make one up. If the user names something ambiguous, ask instead of opening.',
  'Reply with ONE JSON object and nothing else: {"answer":"<short plain-text answer for the user, naming designs by title>","actions":[...]}. "actions" may be empty.',
].join('\n');

export function buildShopRequest(cfg: AskConfig, prompt: string, ctx: ShopAskContext, pages = ''): AskRequest {
  const v = ctx.view;
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
        { role: 'system', content: SHOP_SYSTEM_INSTRUCTION },
        {
          role: 'user',
          content:
            `${catalogueSummary(ctx)}\n\nFAMILIES: ${ctx.families.join(', ')}\n` +
            `CURRENT VIEW: show=${v.show} family=${v.family} search=${JSON.stringify(v.search)}\n\nUser: ${prompt}${pages}`,
        },
      ],
      temperature: 0,
      stream: false,
    },
  };
}

export type ShopReply =
  | { ok: true; answer: string; actions: ShopAction[] }
  | { ok: false; answer: string; problems: string[] };

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

const OPEN_TARGETS: readonly ShopOpenTarget[] = ['cad', 'cnc', '3d', 'pnp'];

/**
 * Read and CHECK a reply. A reply that is not JSON is shown as a plain answer
 * with no actions (and says so): the model talked instead of following the
 * format, which is not a reason to hide what it said, and not a licence to act.
 */
export function readShopReply(raw: string, ctx: ShopAskContext): ShopReply {
  const v = firstObject(raw) as { answer?: unknown; actions?: unknown } | undefined;
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    const text = raw.trim();
    return text
      ? { ok: false, answer: text, problems: ['The reply was not the JSON asked for, so nothing on the page was changed.'] }
      : { ok: false, answer: '', problems: ['The reply was empty.'] };
  }
  const answer = typeof v.answer === 'string' ? v.answer.trim() : '';
  if (v.actions !== undefined && !Array.isArray(v.actions)) {
    return { ok: false, answer, problems: ['"actions" is not a list, so nothing on the page was changed.'] };
  }
  const list = (v.actions ?? []) as unknown[];
  const problems: string[] = [];
  const actions: ShopAction[] = [];
  const entryIds = new Set(ctx.entries.map((e) => e.id));
  const boardIds = new Set(ctx.boards.map((b) => b.id));
  const archivedIds = new Set(ctx.archivedIds ?? []);
  const familyByLower = new Map(ctx.families.map((f) => [f.toLowerCase(), f]));
  let opens = 0;
  let views = 0;
  if (list.length > 6) problems.push(`${list.length} actions is more than this page needs for one request.`);
  for (const a of list.slice(0, 6)) {
    if (!a || typeof a !== 'object') {
      problems.push('An action was not an object.');
      continue;
    }
    const o = a as Record<string, unknown>;
    switch (o.type) {
      case 'search': {
        if (typeof o.text !== 'string') problems.push('search needs "text".');
        else if (o.text.length > MAX_SEARCH) problems.push(`search text longer than ${MAX_SEARCH} characters.`);
        else actions.push({ type: 'search', text: o.text.trim() });
        break;
      }
      case 'show': {
        if (typeof o.value === 'string' && (SHOW_VALUES as readonly string[]).includes(o.value)) actions.push({ type: 'show', value: o.value as ShowFilter });
        else problems.push(`"${String(o.value)}" is not a filter on this page (${SHOW_VALUES.join(', ')}).`);
        break;
      }
      case 'family': {
        const f = typeof o.value === 'string' ? (o.value.toLowerCase() === 'all' ? 'all' : familyByLower.get(o.value.toLowerCase())) : undefined;
        if (f) actions.push({ type: 'family', value: f });
        else problems.push(`"${String(o.value)}" is not a family in the catalogue.`);
        break;
      }
      case 'view': {
        if (typeof o.id === 'string' && entryIds.has(o.id)) {
          if (++views > 1) problems.push('More than one 3D view in one reply.');
          else actions.push({ type: 'view', id: o.id });
        } else problems.push(`No design has the id "${String(o.id)}", so no 3D view was opened.`);
        break;
      }
      case 'open': {
        const id = typeof o.id === 'string' ? o.id : '';
        const target = o.target;
        if (!(OPEN_TARGETS as readonly unknown[]).includes(target)) {
          problems.push(`"${String(target)}" is not somewhere a design opens (cad, cnc, 3d, pnp).`);
        } else if (entryIds.has(id)) {
          if (target === 'pnp') problems.push(`"${id}" is a design, not a PCB; it opens in cad, cnc or 3d.`);
          else if (++opens > 1) problems.push('More than one "open" in one reply.');
          else actions.push({ type: 'open', id, target: target as ShopOpenTarget });
        } else if (boardIds.has(id)) {
          if (target !== 'pnp') problems.push(`"${id}" is a PCB; it opens in pnp only.`);
          else if (++opens > 1) problems.push('More than one "open" in one reply.');
          else actions.push({ type: 'open', id, target: 'pnp' });
        } else {
          problems.push(`No design or board has the id "${id || String(o.id)}", so nothing was opened.`);
        }
        break;
      }
      case 'archive':
      case 'restore': {
        const id = typeof o.id === 'string' ? o.id : '';
        if (!entryIds.has(id) && !boardIds.has(id)) problems.push(`No design or board has the id "${id || String(o.id)}", so nothing was ${o.type}d.`);
        else if (o.type === 'archive' && archivedIds.has(id)) problems.push(`"${id}" is already archived.`);
        else if (o.type === 'restore' && !archivedIds.has(id)) problems.push(`"${id}" is not archived, so there is nothing to restore.`);
        else actions.push({ type: o.type, id });
        break;
      }
      default:
        problems.push(`"${String(o.type)}" is not an action this page has.`);
    }
  }
  if (problems.length) return { ok: false, answer, problems };
  /* The open runs last, after the view changes, because it leaves the page. */
  actions.sort((a, b) => Number(a.type === 'open') - Number(b.type === 'open'));
  return { ok: true, answer: answer || 'Done.', actions };
}

/** A short sentence per action, for the chat's notes. */
export function describeAction(a: ShopAction, titleOf: (id: string) => string): string {
  switch (a.type) {
    case 'search':
      return a.text ? `Search: "${a.text}"` : 'Search cleared';
    case 'show':
      return `Showing: ${a.value === 'cad' ? 'cad (cnc-cut)' : a.value}`;
    case 'family':
      return a.value === 'all' ? 'All families' : `Family: ${a.value}`;
    case 'view':
      return `3D view: ${titleOf(a.id)}`;
    case 'open':
      return `Opening ${titleOf(a.id)} in ${a.target}`;
    case 'archive':
      return `Archived (hidden in this browser): ${titleOf(a.id)}`;
    case 'restore':
      return `Restored: ${titleOf(a.id)}`;
  }
}
