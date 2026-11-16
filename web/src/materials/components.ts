/**
 * materials tab — PCB components (founder 2026-10-16: "add pcb components to the
 * materials as well").
 *
 * Every part the boards need, aggregated by part (LCSC code, else Mfr_PN, else
 * value + package), from three sources this lane READS and never writes:
 *   - pcb's fab BOMs  `hardware/pcb/<board>/fab/<board>-bom.csv` (via pnp/boards.ts)
 *   - bom's records   `hardware/bom/sourced_parts.csv`  (part,value,footprint,lcsc,status,note)
 *   - JLC stock       `hardware/bom/stock-snapshot.json` (`parts[LCSC].stock`, `_meta.date`)
 *
 * The ONE fact the user enters here is ON HAND — "your count" — per part, in
 * this browser. Nothing else is editable on this page.
 *
 * ⚠ WHAT THIS DOES NOT DO
 *  - The JLC number is the SUPPLIER's stock on the snapshot date, not ours. It is
 *    labelled that way everywhere and never feeds "enough for N boards".
 *  - A part with no count is counted as ZERO for buildability and named as
 *    "not counted", never assumed present.
 *  - DNP rows are not needed and are left out. Everything else in the BOM is
 *    needed, whoever fits it (JLC, in-house machine, by hand).
 *  - Attrition / spares per reel are NOT added: "enough for N boards" is the
 *    bare BOM quantity. A pick-and-place run loses parts; that margin is pnp's.
 *
 * Pure: no `import.meta.glob`, so the node tests load it. The browser loader is
 * `componentsData.ts`.
 */
import type { AskConfig, AskRequest } from '../cad/ask';
import { parseCsv } from '../pnp/manifest';

export interface BoardBom {
  boardId: string;
  /** The BOM csv text. */
  bom: string;
}

export interface BomRecord {
  status: string;
  note: string;
  part: string;
}

export interface ComponentRow {
  /** LCSC code, else Mfr_PN, else `value · package`. The on-hand key. */
  key: string;
  keyKind: 'lcsc' | 'mpn' | 'none';
  lcsc: string;
  mpn: string;
  value: string;
  pkg: string;
  manufacturer: string;
  /** Qty per ONE board, by board id. */
  perBoard: Record<string, number>;
  /** bom's records for this LCSC (sourced_parts.csv may hold more than one). */
  bom: BomRecord[];
  /** True when any bom record says the part is dead / wrong / rejected. */
  bad: boolean;
  /** JLC stock on the snapshot date; null when the snapshot does not list it. */
  jlcStock: number | null;
}

/** A status that means "do not build with this part number". */
export const BAD_STATUS = /DEAD|WRONG|REJECT|DISQUALIF|SUSPECT|NO-SUCH/i;

export function readSourcedParts(csv: string): Map<string, BomRecord[]> {
  const out = new Map<string, BomRecord[]>();
  let rows: Record<string, string>[] = [];
  try {
    rows = parseCsv(csv);
  } catch {
    return out;
  }
  for (const r of rows) {
    const k = (r.lcsc ?? '').trim().toUpperCase();
    if (!/^C\d+$/.test(k)) continue;
    const list = out.get(k) ?? [];
    list.push({ status: (r.status ?? '').trim(), note: (r.note ?? '').trim(), part: (r.part ?? '').trim() });
    out.set(k, list);
  }
  return out;
}

export interface StockSnapshot {
  date: string | null;
  stock: Map<string, number>;
}

export function readStockSnapshot(json: string): StockSnapshot {
  try {
    const v = JSON.parse(json) as { _meta?: { date?: unknown }; parts?: Record<string, { stock?: unknown }> };
    const stock = new Map<string, number>();
    for (const [k, p] of Object.entries(v.parts ?? {})) {
      const n = p?.stock;
      if (typeof n === 'number' && Number.isFinite(n) && n >= 0) stock.set(k.toUpperCase(), n);
    }
    return { date: typeof v._meta?.date === 'string' ? v._meta.date : null, stock };
  } catch {
    return { date: null, stock: new Map() };
  }
}

const truthy = (s: string | undefined) => !!s && !/^(|0|no|false|n)$/i.test(s.trim());

export function partKey(r: { LCSC_PN?: string; Mfr_PN?: string; Value?: string; Package?: string }): { key: string; kind: ComponentRow['keyKind'] } {
  const lcsc = (r.LCSC_PN ?? '').trim().toUpperCase();
  if (/^C\d+$/.test(lcsc)) return { key: lcsc, kind: 'lcsc' };
  const mpn = (r.Mfr_PN ?? '').trim();
  if (mpn) return { key: mpn, kind: 'mpn' };
  return { key: `${(r.Value ?? '').trim()} · ${(r.Package ?? '').trim()}`, kind: 'none' };
}

/** Aggregate every board's BOM by part. Rows sorted by key; boards in input order. */
export function aggregateComponents(boards: BoardBom[], sourced: Map<string, BomRecord[]>, snap: StockSnapshot): ComponentRow[] {
  const rows = new Map<string, ComponentRow>();
  for (const b of boards) {
    let bom: Record<string, string>[] = [];
    try {
      bom = parseCsv(b.bom);
    } catch {
      continue;
    }
    for (const r of bom) {
      if (truthy(r.DNP)) continue;
      const refs = (r.Reference ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      const qty = refs.length || Number(r.Qty) || 0;
      if (qty <= 0) continue;
      const { key, kind } = partKey(r);
      let row = rows.get(key);
      if (!row) {
        const lcsc = kind === 'lcsc' ? key : '';
        const recs = lcsc ? sourced.get(lcsc) ?? [] : [];
        row = {
          key,
          keyKind: kind,
          lcsc,
          mpn: (r.Mfr_PN ?? '').trim(),
          value: (r.Value ?? '').trim(),
          pkg: (r.Package ?? '').trim(),
          manufacturer: (r.Manufacturer ?? '').trim(),
          perBoard: {},
          bom: recs,
          bad: recs.some((x) => BAD_STATUS.test(x.status)),
          jlcStock: lcsc ? snap.stock.get(lcsc) ?? null : null,
        };
        rows.set(key, row);
      }
      row.perBoard[b.boardId] = (row.perBoard[b.boardId] ?? 0) + qty;
    }
  }
  return [...rows.values()].sort((a, b) => a.key.localeCompare(b.key));
}

// ───────────────────────────── on hand ─────────────────────────────

export const ONHAND_KEY = '2bee.app.materials.onhand';
export const ONHAND_MAX = 10_000_000;

export type OnHand = Record<string, number>;

export function readOnHand(store: Pick<Storage, 'getItem'> | null | undefined): OnHand {
  try {
    const raw = store?.getItem(ONHAND_KEY);
    const v = raw ? (JSON.parse(raw) as unknown) : {};
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    const out: OnHand = {};
    for (const [k, n] of Object.entries(v as Record<string, unknown>))
      if (k && typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= ONHAND_MAX) out[k] = n;
    return out;
  } catch {
    return {};
  }
}

export function writeOnHand(store: Pick<Storage, 'setItem'> | null | undefined, v: OnHand): string | null {
  try {
    store?.setItem(ONHAND_KEY, JSON.stringify(v));
    return null;
  } catch (e) {
    return `This browser refused to store your counts: ${e instanceof Error ? e.message : String(e)}`;
  }
}

export interface Buildable {
  boardId: string;
  /** Whole boards your counts cover. A part with no count counts as 0. */
  boards: number;
  /** Parts that stop one more board: need per board, what you have (null = not counted). */
  short: { key: string; value: string; need: number; have: number | null }[];
  /** Parts on this board with no count at all. */
  notCounted: string[];
  /** Parts on this board whose bom status is dead / wrong. */
  bad: string[];
  /** Distinct parts the board needs. */
  parts: number;
}

export function buildable(boardId: string, rows: ComponentRow[], onHand: OnHand): Buildable {
  const mine = rows.filter((r) => (r.perBoard[boardId] ?? 0) > 0);
  if (!mine.length) return { boardId, boards: 0, short: [], notCounted: [], bad: [], parts: 0 };
  let n = Infinity;
  for (const r of mine) n = Math.min(n, Math.floor((onHand[r.key] ?? 0) / r.perBoard[boardId]));
  const short = mine
    .filter((r) => (onHand[r.key] ?? 0) < (n + 1) * r.perBoard[boardId])
    .map((r) => ({ key: r.key, value: r.value, need: r.perBoard[boardId], have: r.key in onHand ? onHand[r.key] : null }));
  return {
    boardId,
    boards: n,
    short,
    notCounted: mine.filter((r) => !(r.key in onHand)).map((r) => r.key),
    bad: mine.filter((r) => r.bad).map((r) => r.key),
    parts: mine.length,
  };
}

// ───────────────────────────── the AI reader ─────────────────────────────

export type OnHandProposal = { ok: true; set: OnHand; why: string; missing: string[] } | { ok: false; problems: string[] };

/**
 * `{"onHand": {"C13585": 8000}, "why": …}`. Any key that is not a part the
 * boards need, or a count that is not a whole number 0–10,000,000, refuses the
 * WHOLE reply. A count is what the operator SAID — never a JLC stock figure.
 */
export function readOnHandProposal(raw: string, rows: ComponentRow[]): OnHandProposal {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw);
  const text = fenced ? fenced[1] : raw;
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  let v: { onHand?: unknown; why?: unknown; missing?: unknown } | undefined;
  try {
    v = a >= 0 && b > a ? JSON.parse(text.slice(a, b + 1)) : undefined;
  } catch {
    v = undefined;
  }
  if (!v || typeof v !== 'object') return { ok: false, problems: ['The reply was not the JSON object asked for.'] };
  const o = v.onHand ?? {};
  if (!o || typeof o !== 'object' || Array.isArray(o)) return { ok: false, problems: ['The reply has no "onHand" object.'] };
  const byUpper = new Map(rows.map((r) => [r.key.toUpperCase(), r.key]));
  const problems: string[] = [];
  const set: OnHand = {};
  for (const [k, n] of Object.entries(o as Record<string, unknown>)) {
    const key = byUpper.get(k.trim().toUpperCase());
    if (!key) {
      problems.push(`"${k}" is not a part any board needs.`);
      continue;
    }
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > ONHAND_MAX) {
      problems.push(`${key}: the count must be a whole number 0–${ONHAND_MAX.toLocaleString('en')}, not ${JSON.stringify(n)}.`);
      continue;
    }
    set[key] = n;
  }
  if (problems.length) return { ok: false, problems };
  const missing = Array.isArray(v.missing) ? v.missing.filter((m): m is string => typeof m === 'string').slice(0, 10) : [];
  return { ok: true, set, why: typeof v.why === 'string' ? v.why : '', missing };
}

export const ONHAND_SYSTEM_INSTRUCTION = [
  'You help an operator record how many of each PCB part they HAVE ON HAND, in 2bee.app.',
  'You may set only "onHand": a map from a part key in the list below (an LCSC code like C13585, or the part number shown) to a whole-number count.',
  'Only set a count the operator stated. Do arithmetic they imply ("2 reels of 4000" = 8000) and say it in "why". Never use a supplier stock figure as a count. Never guess.',
  'If the operator names a part that is not in the list, set nothing for it and list it in "missing".',
  'Answer with ONE JSON object and nothing else: {"onHand": {"<key>": <count>, ...}, "why": "<one short sentence>", "missing": ["<what was not stated or not found>", ...]}.',
].join('\n');

export function buildOnHandRequest(cfg: AskConfig, prompt: string, rows: ComponentRow[], onHand: OnHand, pages = ''): AskRequest {
  const list = rows.map((r) => `${r.key} | ${r.value} | ${r.pkg}${r.key in onHand ? ` | have ${onHand[r.key]}` : ''}`).join('\n');
  return {
    url: cfg.endpoint,
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
    body: {
      model: cfg.model,
      messages: [
        { role: 'system', content: ONHAND_SYSTEM_INSTRUCTION },
        { role: 'user', content: `Parts the boards need (key | value | package):\n${list}\n\nOperator: ${prompt}${pages}` },
      ],
      temperature: 0,
      stream: false,
    },
  };
}
