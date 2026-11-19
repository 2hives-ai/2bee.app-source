// One-time move of a browser's saved data to the server document store.
//
// Founder 2026-11-19, verbatim: "Can you migrate all mine from localhost to
// the 2bee.app server?" Plan: docs/plan-server-store.md (the (b) list).
//
// INPUT is a SNAPSHOT of one browser origin's storage, in the shape written by
// the CDP export (scripts/migrate-local-to-server.ts documents it): the (b)
// localStorage keys as raw strings, and every IndexedDB row as {key, value},
// with binary fields encoded as {__bytes, b64} / {__blob, b64}. The snapshot is
// stored as it is. Nothing is re-shaped, so nothing can be lost in a re-shape;
// the B1..B13 tickets that teach the app to READ these docs decode them.
//
// 🔴 RULES:
//  - Never overwrites. A doc already on the server with DIFFERENT content is
//    reported as a conflict and left alone. Same content is reported as
//    already there. Only a missing doc is created (base_version 0, which the
//    server refuses if someone created it meanwhile).
//  - Never deletes or changes local storage. The local copy stays until a
//    person decides otherwise.
//  - Every doc gets a line in the report. A doc that failed says so; the
//    total is never "done" while one failed.

import type { DocKind, Result, ServerStore } from './serverStore';
import { DOC_ID_RE } from './serverStore';
import { SHEETS_KEY } from './materials/stock';

export const MIGRATE_SCHEMA = '2bee.app.migrate/1';

export interface Snapshot {
  origin: string;
  exported_at: string;
  localStorage: Record<string, string>;
  indexedDB: Record<string, Record<string, { key: unknown; value: unknown }[]>>;
}

export interface PlannedDoc {
  kind: DocKind;
  docId: string;
  /** Where it came from, for the report: `idb 2bee.slicer/drawings "Feeder"`. */
  source: string;
  data: MigratedDoc;
}

export interface MigratedDoc {
  schema: typeof MIGRATE_SCHEMA;
  from_origin: string;
  exported_at: string;
  /** The storage key exactly as it was in the browser. */
  source_key: string;
  /** IndexedDB value, or the localStorage string parsed as JSON when it is JSON. */
  record: unknown;
  /** True when `record` is the raw localStorage string (it was not JSON). */
  record_is_text?: boolean;
}

/** IndexedDB stores (database 2bee.slicer, plus tool photos) -> kind. */
const IDB_KINDS: Record<string, Record<string, DocKind>> = {
  '2bee.slicer': {
    drawings: 'drawing', machines: 'machine', workpieces: 'workpiece',
    spoilboards: 'spoilboard', operations: 'operation', inventory: 'inventory',
  },
  '2bee.app-tool-photos': { photos: 'tool-photo' },
};

/** localStorage key -> kind + doc id. `2bee.app.spec.<x>` is handled apart. */
const LS_KINDS: Record<string, { kind: DocKind; id: string }> = {
  '2bee.app.cncjob.jobs': { kind: 'cncjob', id: 'jobs' },
  '2bee.app.cncjob.machines': { kind: 'machine-registry', id: 'registry' },
  '2bee.app.machines.printers': { kind: 'printers', id: 'printers' },
  '2bee.app.router.measured': { kind: 'router-measured', id: 'measured' },
  '2bee.app.shop.archived': { kind: 'shop-archive', id: 'archived' },
  [SHEETS_KEY]: { kind: 'stock', id: 'flat-stock' },
  '2bee.app.materials.filaments': { kind: 'stock', id: 'filaments' },
  '2bee.app.materials.onhand': { kind: 'components-onhand', id: 'onhand' },
  '2bee.app.cad.session': { kind: 'cad-session', id: 'session' },
  '2bee.app.session': { kind: 'cnc-session', id: 'session' },
};
const SPEC_PREFIX = '2bee.app.spec.';

/** FNV-1a 32-bit, hex. Stable across runs and hosts; collisions are checked. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (const ch of new TextEncoder().encode(s)) {
    h ^= ch;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** A server doc id for a browser key. A key that already fits the server's
 *  pattern is kept as it is. Any other key becomes a readable slug plus a hash
 *  of the FULL key, so two keys that slug alike ("x (2)", "x (3)") stay apart
 *  and a re-run maps each key to the same id again. */
export function docIdFor(key: string): string {
  if (DOC_ID_RE.test(key)) return key;
  const slug = key.normalize('NFKD').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100) || 'doc';
  return `${slug}-${fnv1a(key)}`;
}

export function planMigration(snap: Snapshot): { docs: PlannedDoc[]; skipped: string[] } {
  const docs: PlannedDoc[] = [];
  const skipped: string[] = [];
  const base = { schema: MIGRATE_SCHEMA, from_origin: snap.origin, exported_at: snap.exported_at } as const;

  for (const [dbName, stores] of Object.entries(snap.indexedDB ?? {})) {
    for (const [store, rows] of Object.entries(stores)) {
      const kind = IDB_KINDS[dbName]?.[store];
      if (!kind) {
        if (rows.length) skipped.push(`idb ${dbName}/${store}: ${rows.length} row(s), no server kind for this store`);
        continue;
      }
      for (const row of rows) {
        const key = typeof row.key === 'string' ? row.key : JSON.stringify(row.key);
        docs.push({
          kind, docId: docIdFor(key), source: `idb ${dbName}/${store} ${JSON.stringify(key)}`,
          data: { ...base, source_key: key, record: row.value },
        });
      }
    }
  }

  for (const [key, raw] of Object.entries(snap.localStorage ?? {})) {
    let target = LS_KINDS[key];
    if (!target && key.startsWith(SPEC_PREFIX)) target = { kind: 'spec', id: docIdFor(key.slice(SPEC_PREFIX.length)) };
    if (!target) {
      skipped.push(`localStorage ${key}: not on the server list (UI setting, device config or cache)`);
      continue;
    }
    let record: unknown = raw;
    let isText = true;
    try {
      record = JSON.parse(raw);
      isText = false;
    } catch {
      /* kept as text, and flagged */
    }
    docs.push({
      kind: target.kind, docId: target.id, source: `localStorage ${key}`,
      data: { ...base, source_key: key, record, ...(isText ? { record_is_text: true } : {}) },
    });
  }

  // Two sources must never land on one doc: that would be a silent overwrite.
  const seen = new Map<string, string>();
  for (const d of docs) {
    const k = `${d.kind}/${d.docId}`;
    const prev = seen.get(k);
    if (prev) throw new Error(`two sources map to ${k}: ${prev} and ${d.source}`);
    seen.set(k, d.source);
  }
  return { docs, skipped };
}

export type Outcome = 'created' | 'already-there' | 'conflict' | 'failed' | 'would-create' | 'would-check';
export interface ReportLine { kind: DocKind; docId: string; source: string; outcome: Outcome; detail: string }

/** Stable JSON for comparing the server copy with ours (key order ignored). */
function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

/** The part of a doc that identifies its content: everything except when it was exported. */
function contentOf(d: unknown): string {
  if (!d || typeof d !== 'object') return canon(d);
  const { exported_at: _e, ...rest } = d as Record<string, unknown>;
  return canon(rest);
}

export async function runMigration(
  store: ServerStore, docs: PlannedDoc[], opts: { apply: boolean; onLine?: (l: ReportLine) => void },
): Promise<{ lines: ReportLine[]; ok: boolean }> {
  const lines: ReportLine[] = [];
  const say = (d: PlannedDoc, outcome: Outcome, detail: string) => {
    const l = { kind: d.kind, docId: d.docId, source: d.source, outcome, detail };
    lines.push(l);
    opts.onLine?.(l);
  };
  for (const d of docs) {
    const cur = await store.get(d.kind, d.docId);
    if (cur.ok) {
      if (contentOf(cur.value.data) === contentOf(d.data)) say(d, 'already-there', `version ${cur.value.version}`);
      else say(d, 'conflict', `the server already has different content (version ${cur.value.version}); left alone`);
      continue;
    }
    if (cur.reason !== 'not_found') {
      say(d, 'failed', cur.message);
      continue;
    }
    if (!opts.apply) {
      say(d, 'would-create', 'not on the server yet');
      continue;
    }
    const r: Result<{ version: number }> = await store.put(d.kind, d.docId, d.data, 0);
    if (r.ok) say(d, 'created', `version ${r.value.version}`);
    else say(d, 'failed', r.message);
  }
  const bad = lines.some((l) => l.outcome === 'failed' || l.outcome === 'conflict');
  return { lines, ok: !bad };
}
