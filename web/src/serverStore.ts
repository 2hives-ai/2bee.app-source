// Server document store client — the browser half of "store to the server".
//
// Founder 2026-11-17, verbatim: "When I store something it should store back to
// the server, not into the browser!" Plan and triage: docs/plan-server-store.md.
// Server half: software/backend/functions/api/app_docs.py (backend lane,
// commit 0fde20e02b). This file follows the contract written in that file's
// header. It does not invent one.
//
// 🔴 THE ONE RULE: A SAVE THAT DID NOT REACH THE SERVER NEVER LOOKS SAVED.
// Every call returns a Result. `ok: true` exists only when the server answered
// 2xx with the JSON shape the contract names. Everything else is `ok: false`
// with a reason the UI must show: offline, signed out, conflict, too large,
// or a server that answered something this client does not recognise (for
// example API Gateway's 403 "Missing Authentication Token" for a route that is
// not deployed). There is no fallback to localStorage in here. A caller that
// keeps a local copy as an offline cache must still show "NOT saved".
//
// WHAT THIS IS NOT:
//  - not wired to any button yet. B1 (CAD Save + drawings) wires it.
//  - not a sync engine. Conflicts are reported (409 + current_version), never
//    merged or overwritten. The user decides.
//  - not a cache. It holds no state between calls.
//
// Auth: the API's Cognito User Pools authorizer has no OAuth scopes, so API
// Gateway expects the ID token (not the access token) in `Authorization`.

import { isTokenExpired, loadTokens } from './auth';

/** Default API base. The `/app/{proxy+}` route is on the TwoBeeApi REST API
 *  behind api.2bee.farm. Overridable for tests and the dev server. */
export const DEFAULT_DOCS_BASE = 'https://api.2bee.farm/app/docs';

/** Mirror of `KINDS` in app_docs.py. The server rejects any other kind with
 *  400, so a typo here fails loudly there; this union makes it fail at compile
 *  time first. Change both in the same breath. */
export const DOC_KINDS = [
  'drawing', 'machine', 'workpiece', 'spoilboard', 'operation', 'inventory', 'cncjob',
  'machine-registry', 'printers', 'router-measured', 'stock', 'components-onhand',
  'tool-photo', 'spec', 'shop-archive', 'cad-session', 'cnc-session',
] as const;
export type DocKind = (typeof DOC_KINDS)[number];

/** Same pattern as the server's `_DOC_ID`. Checked here so a bad id is
 *  refused before any request, with a reason, instead of as a 400. */
export const DOC_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

/** Server's INLINE_LIMIT (300 KB of compact JSON). Above it, the body goes to
 *  S3 through a presigned PUT. */
export const INLINE_LIMIT = 300 * 1024;
/** Server's BODY_LIMIT. */
export const BODY_LIMIT = 50 * 1024 * 1024;

export interface DocMeta {
  kind: DocKind;
  doc_id: string;
  version: number;
  size: number;
  has_body: boolean;
  created_at: number;
  updated_at: number;
}

export interface DocFull<T = unknown> extends DocMeta {
  data?: T;
  meta?: unknown;
  download_url?: string;
}

export type FailReason =
  | 'offline'          // fetch threw: no network, DNS, CORS refusal
  | 'unauthenticated'  // no usable token here, or the server said 401
  | 'not_found'
  | 'conflict'         // 409: someone saved a newer version
  | 'too_large'
  | 'bad_request'
  | 'unavailable'      // 503 from the server (e.g. body store not configured)
  | 'unexpected';      // any answer outside the contract

export type Fail = {
  ok: false;
  reason: FailReason;
  /** HTTP status, 0 when no answer arrived. */
  status: number;
  /** One sentence for the user. Always says the data was NOT saved/loaded. */
  message: string;
  /** Set on `conflict`: the version now on the server. */
  currentVersion?: number;
  /** Set on `too_large`. */
  limitBytes?: number;
};
export type Result<T> = { ok: true; value: T } | Fail;

export interface StoreOptions {
  base?: string;
  fetchImpl?: typeof fetch;
  /** Returns the Cognito ID token, or null when signed out / expired. */
  getIdToken?: () => string | null;
}

/** The ID token from this tab's session, or null if absent or expired. */
export function currentIdToken(): string | null {
  const t = loadTokens();
  if (!t || isTokenExpired(t)) return null;
  return t.id_token;
}

function fail(reason: FailReason, status: number, message: string, extra: Partial<Fail> = {}): Fail {
  return { ok: false, reason, status, message, ...extra };
}

const NOT_DONE = 'Nothing was stored on the server.';

async function readJson(r: Response): Promise<unknown> {
  try {
    return JSON.parse(await r.text());
  } catch {
    return undefined;
  }
}

/** Map a non-2xx answer to a Fail. Only shapes named in the contract get a
 *  specific reason; anything else is `unexpected` with its status. */
function failFrom(status: number, body: unknown): Fail {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const code = typeof b.error === 'string' ? b.error : '';
  const detail = typeof b.detail === 'string' ? ` (${b.detail})` : '';
  if (status === 401 || code === 'unauthenticated')
    return fail('unauthenticated', status, `The server did not accept your sign-in. Sign in again. ${NOT_DONE}`);
  if (status === 409 && code === 'version_conflict') {
    const cur = typeof b.current_version === 'number' ? b.current_version : undefined;
    return fail('conflict', status,
      `A newer version (${cur ?? '?'}) was saved from another tab or device. ${NOT_DONE} Reload it before saving again.`,
      { currentVersion: cur });
  }
  if (status === 413 && code === 'too_large') {
    const lim = typeof b.limit_bytes === 'number' ? b.limit_bytes : undefined;
    return fail('too_large', status, `Too large for the server (limit ${lim ?? '?'} bytes). ${NOT_DONE}`, { limitBytes: lim });
  }
  if (status === 404 && code === 'not_found') return fail('not_found', status, 'Not found on the server.');
  if (status === 400 && code === 'bad_request') return fail('bad_request', status, `The server refused the request${detail}. ${NOT_DONE}`);
  if (status === 503) return fail('unavailable', status, `The server store is not available${detail}. ${NOT_DONE}`);
  return fail('unexpected', status, `The server answered ${status}, which this page does not recognise. ${NOT_DONE}`);
}

function isMeta(v: unknown): v is DocMeta {
  const m = v as DocMeta;
  return !!m && typeof m === 'object' && typeof m.doc_id === 'string' && typeof m.kind === 'string' &&
    Number.isInteger(m.version) && m.version >= 1;
}

export function createServerStore(opts: StoreOptions = {}) {
  const base = (opts.base ?? DEFAULT_DOCS_BASE).replace(/\/+$/, '');
  const fetchImpl = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const getIdToken = opts.getIdToken ?? currentIdToken;

  function checkId(kind: DocKind, id?: string): Fail | null {
    if (!(DOC_KINDS as readonly string[]).includes(kind)) return fail('bad_request', 0, `Unknown kind "${kind}". ${NOT_DONE}`);
    if (id !== undefined && !DOC_ID_RE.test(id))
      return fail('bad_request', 0, `"${id}" is not a valid document id (letters, digits, . _ -, at most 128). ${NOT_DONE}`);
    return null;
  }

  /** One authenticated call. `ok` only for 2xx with a JSON body. */
  async function call(method: string, path: string, body?: unknown): Promise<Result<unknown>> {
    const token = getIdToken();
    if (!token) return fail('unauthenticated', 0, `You are not signed in, or the sign-in has expired. ${NOT_DONE}`);
    let r: Response;
    try {
      r = await fetchImpl(`${base}/${path}`, {
        method,
        headers: { Authorization: token, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        cache: 'no-store',
      });
    } catch {
      return fail('offline', 0, `Could not reach the server. ${NOT_DONE}`);
    }
    const json = await readJson(r);
    if (r.status < 200 || r.status > 299) return failFrom(r.status, json);
    if (json === undefined) return fail('unexpected', r.status, `The server answered ${r.status} without a readable body. ${NOT_DONE}`);
    return { ok: true, value: json };
  }

  async function list(kind: DocKind, o: { includeData?: boolean; limit?: number; next?: string } = {}):
    Promise<Result<{ items: DocFull[]; next?: string }>> {
    const bad = checkId(kind);
    if (bad) return bad;
    const q = new URLSearchParams();
    if (o.includeData) q.set('include', 'data');
    if (o.limit) q.set('limit', String(o.limit));
    if (o.next) q.set('next', o.next);
    const r = await call('GET', `${kind}${q.toString() ? `?${q}` : ''}`);
    if (!r.ok) return r;
    const v = r.value as { items?: unknown; next?: unknown };
    if (!Array.isArray(v.items) || !v.items.every(isMeta))
      return fail('unexpected', 200, 'The server list did not have the expected shape.');
    return { ok: true, value: { items: v.items as DocFull[], next: typeof v.next === 'string' ? v.next : undefined } };
  }

  /** Get one document. A body stored in S3 is fetched through its
   *  `download_url` and parsed as JSON into `data`. */
  async function get<T = unknown>(kind: DocKind, id: string): Promise<Result<DocFull<T>>> {
    const bad = checkId(kind, id);
    if (bad) return bad;
    const r = await call('GET', `${kind}/${encodeURIComponent(id)}`);
    if (!r.ok) return r;
    if (!isMeta(r.value)) return fail('unexpected', 200, 'The server document did not have the expected shape.');
    const doc = r.value as DocFull<T>;
    if (doc.has_body) {
      if (typeof doc.download_url !== 'string') return fail('unexpected', 200, 'The server did not give a download link for this document.');
      let b: Response;
      try {
        b = await fetchImpl(doc.download_url, { cache: 'no-store' });
      } catch {
        return fail('offline', 0, 'Could not download the document body.');
      }
      if (!b.ok) return fail('unexpected', b.status, `The document body download answered ${b.status}.`);
      const data = await readJson(b);
      if (data === undefined) return fail('unexpected', b.status, 'The document body is not readable JSON.');
      doc.data = data as T;
    }
    return { ok: true, value: doc };
  }

  /** Save `data` as version `baseVersion + 1`. `baseVersion` is 0 to create,
   *  else the version this client last read; a stale one is `conflict`.
   *  Bodies over INLINE_LIMIT go to S3 first, then the record points at them. */
  async function put<T>(kind: DocKind, id: string, data: T, baseVersion: number, meta?: unknown): Promise<Result<DocMeta>> {
    const bad = checkId(kind, id);
    if (bad) return bad;
    if (!Number.isInteger(baseVersion) || baseVersion < 0) return fail('bad_request', 0, `Bad base version. ${NOT_DONE}`);
    const json = JSON.stringify(data);
    if (json === undefined) return fail('bad_request', 0, `Nothing to save. ${NOT_DONE}`);
    const bytes = new TextEncoder().encode(json);
    const path = `${kind}/${encodeURIComponent(id)}`;
    let r: Result<unknown>;
    if (bytes.length <= INLINE_LIMIT) {
      r = await call('PUT', path, { data, base_version: baseVersion });
    } else {
      if (bytes.length > BODY_LIMIT)
        return fail('too_large', 0, `Too large to store (${bytes.length} bytes, limit ${BODY_LIMIT}). ${NOT_DONE}`, { limitBytes: BODY_LIMIT });
      const u = await call('POST', `${path}/upload`, { size: bytes.length, content_type: 'application/json' });
      if (!u.ok) return u;
      const up = u.value as { upload_url?: unknown; body_key?: unknown; headers?: Record<string, string> };
      if (typeof up.upload_url !== 'string' || typeof up.body_key !== 'string')
        return fail('unexpected', 200, `The server did not give an upload link. ${NOT_DONE}`);
      let s3: Response;
      try {
        s3 = await fetchImpl(up.upload_url, { method: 'PUT', headers: up.headers ?? { 'Content-Type': 'application/json' }, body: bytes });
      } catch {
        return fail('offline', 0, `Could not upload the document body. ${NOT_DONE}`);
      }
      if (!s3.ok) return fail('unexpected', s3.status, `The body upload answered ${s3.status}. ${NOT_DONE}`);
      r = await call('PUT', path, { body_key: up.body_key, base_version: baseVersion, ...(meta !== undefined ? { meta } : {}) });
    }
    if (!r.ok) return r;
    if (!isMeta(r.value) || r.value.version !== baseVersion + 1)
      return fail('unexpected', 200, `The server did not confirm the new version. Treat it as NOT saved.`);
    return { ok: true, value: r.value };
  }

  async function remove(kind: DocKind, id: string): Promise<Result<true>> {
    const bad = checkId(kind, id);
    if (bad) return bad;
    const r = await call('DELETE', `${kind}/${encodeURIComponent(id)}`);
    if (!r.ok) return r;
    if ((r.value as { deleted?: unknown }).deleted !== true) return fail('unexpected', 200, 'The server did not confirm the delete.');
    return { ok: true, value: true };
  }

  return { list, get, put, remove };
}

export type ServerStore = ReturnType<typeof createServerStore>;

/** The status line a save button shows. Only a confirmed save says "Saved". */
export function saveStatusText(r: Result<DocMeta>): string {
  return r.ok ? `Saved to server (version ${r.value.version}).` : `NOT saved: ${r.message}`;
}
