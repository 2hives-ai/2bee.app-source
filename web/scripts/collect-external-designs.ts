// COLLECT EXTERNAL DESIGNS — DISCOVERY ONLY, AND IT REFUSES MORE THAN IT KEEPS.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHAT THIS RUN PRODUCES, AND WHAT IT CANNOT
// ═══════════════════════════════════════════════════════════════════════════
//
// It searches public GitHub for repositories that (a) declare a licence this
// lane has reviewed and (b) contain at least one file this app claims to open,
// and writes them to `public/designs/external.json` — gitignored, exactly like the
// cad catalogue beside it, and for the same reason: a committed copy of someone
// else's index is a second source of truth that rots quietly.
//
// 🔴 IT DOES NOT DOWNLOAD ANY DESIGN FILE AND IT DOES NOT TEST ANYTHING.
// "This repository declares CC-BY-4.0 and contains three `.scad` files" is the
// whole of what discovery can honestly say. Whether this app can open them is a
// different fact, produced by `verify-external-designs.ts`, stored in a
// different field, and absent until that run happens.
//
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 WHY GITHUB, AND WHY NOT THE OBVIOUS MODEL SITES
// ═══════════════════════════════════════════════════════════════════════════
//
// Measured 2026-09-09 while choosing sources, not assumed:
//
//   - `thingiverse.com/legal/api` returns **HTTP 403** to this box, so its API
//     terms COULD NOT BE READ. An unread terms-of-service is not a permissive
//     one, and a pipeline built on an unread ToS is a licence claim with no
//     source behind it. Excluded until someone reads it.
//   - Printables publishes **no official public API**; the endpoints its own
//     front end uses are internal and unversioned, so a collector built on them
//     is scraping with extra steps. Excluded.
//   - GitHub's REST API answers **anonymously**, returns a machine-readable
//     `license.spdx_id`, and the repository's own licence is exactly the fact
//     this pipeline must have. That is the whole reason it is the first source.
//
// ⚠ `SOURCES` is a list so a second one is an addition rather than a rewrite.
// Any new source must supply a machine-readable licence per item; a source that
// cannot is not cheaper to add, it is impossible to add honestly.
//
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 REFUSED, UNCHECKED AND KEPT ARE THREE OUTCOMES, NEVER TWO
// ═══════════════════════════════════════════════════════════════════════════
//
// The anonymous API allows ~10 searches/minute and 60 core calls/hour. A run
// that hits that ceiling has NOT discovered that the internet contains fewer
// designs — it has run out of quota. Folding those into `refused` would report a
// quota as a licence finding and send the next reader hunting a legal problem.
// So they are counted in `unchecked`, with the reason, and the run still writes
// a valid index. `.external-cache.json` (also gitignored) carries resolved
// repositories between runs so a rate-limited run resumes instead of restarting.
//
// USAGE
//   node --import ./tests/register.mjs scripts/collect-external-designs.ts
//   ... --max 40     how many candidate repositories to resolve this run
//   ... --query "topic:openscad license:mit"   run one query instead of the list

import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OPENABLE_EXT,
  ruleLicence,
  type ExternalDesign,
  type ExternalIndex,
} from '../src/shop/external.ts';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(WEB, 'public', 'designs');
const CACHE = join(OUT, '.external-cache.json');

/**
 * The searches. Every row is a TOPIC, because GitHub's free-text relevance is
 * useless here: `cnc` alone returns controller software, G-code senders and
 * nesting libraries — programs, not parts.
 *
 * ⚠ MEASURED, NOT GUESSED (2026-09-09, anonymous): `topic:openscad
 * license:cc0-1.0` → 17 repositories, every one with a real SPDX id;
 * `beehive+openscad` as free text → **0**. A query that stops returning
 * anything is PRINTED as unchecked, not quietly deleted.
 *
 * 🔴 THE ROWS WITHOUT A `license:` QUALIFIER ARE THE ONLY REASON THE LICENCE
 * GATE IS TESTED, and this list did not have them at first. The first run used
 * licence-qualified queries exclusively and reported `refused: 0` across 130
 * repositories — a gate that never fires because its input was pre-filtered by
 * the very property it checks. It would have stayed green forever and proved
 * nothing. ⇒ ***A control fed only admissible input is not a control.*** The
 * unqualified rows feed it real unlicensed, NOASSERTION and NON-COMMERCIAL
 * repositories, so `refusedReasons` is a live measurement rather than an empty
 * list that reads like a clean bill.
 *
 * ⚠ The qualified rows stay, and they are not redundant: they are what makes the
 * run YIELD anything, because most topic hits are refused. Discovery and control
 * want opposite inputs, and the list carries both on purpose.
 */
const QUERIES: string[] = [
  'topic:openscad',
  'topic:beehive',
  'topic:laser-cutting',
  'topic:cnc-router',
  'topic:woodworking',
  'topic:parametric-design',
  'topic:openscad license:cc0-1.0',
  'topic:openscad license:mit',
  'topic:openscad license:cc-by-4.0',
  'topic:openscad license:gpl-3.0',
  'topic:laser-cutting license:mit',
  'topic:laser-cutting license:cc0-1.0',
  'topic:cnc license:cc0-1.0',
  'topic:woodworking license:mit',
  'topic:beehive license:mit',
  'topic:beehive license:gpl-3.0',
  'topic:parametric-design topic:openscad license:mit',
  'topic:3d-printing topic:openscad license:cc-by-sa-4.0',
];

const API = 'https://api.github.com';
const UA = '2bee.app-design-collector';

interface Fetched<T> {
  ok: boolean;
  body?: T;
  /** Present when `ok` is false. The sentence a reader needs, not a code. */
  why?: string;
  /** True when the failure was a quota, which is UNCHECKED and not a refusal. */
  quota?: boolean;
}

async function api<T>(path: string): Promise<Fetched<T>> {
  let r: Response;
  try {
    r = await fetch(`${API}${path}`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': UA } });
  } catch (e) {
    return { ok: false, why: `the request did not complete: ${String(e)}` };
  }
  if (r.status === 403 || r.status === 429) {
    const remaining = r.headers.get('x-ratelimit-remaining');
    return {
      ok: false,
      quota: true,
      why: `HTTP ${r.status} from the anonymous API (x-ratelimit-remaining=${remaining ?? 'unset'}) — this is a QUOTA, not an answer about the repository`,
    };
  }
  if (!r.ok) return { ok: false, why: `HTTP ${r.status}` };
  try {
    return { ok: true, body: (await r.json()) as T };
  } catch (e) {
    return { ok: false, why: `the response was not JSON: ${String(e)}` };
  }
}

interface RepoHit {
  full_name: string;
  html_url: string;
  description: string | null;
  stargazers_count: number;
  default_branch: string;
  license: { spdx_id: string | null; url: string | null } | null;
}

const argv = process.argv.slice(2);
const argOf = (name: string): string | null => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
};
const MAX = Number.parseInt(argOf('--max') ?? '24', 10);
const ONE = argOf('--query');
const queries = ONE ? [ONE] : QUERIES;

/** Repositories resolved by an earlier run, keyed `owner/name`. */
type Cache = Record<string, { commit: string; files: { path: string; ext: string }[] }>;
const cache: Cache = existsSync(CACHE) ? (JSON.parse(readFileSync(CACHE, 'utf8')) as Cache) : {};

const seen = new Map<string, RepoHit>();
const refusedReasons: { repo: string; why: string }[] = [];
const uncheckedReasons: { repo: string; why: string }[] = [];

// ── 1. search ──────────────────────────────────────────────────────────────
for (const q of queries) {
  const r = await api<{ total_count: number; items: RepoHit[] }>(
    `/search/repositories?q=${encodeURIComponent(q)}&per_page=12&sort=stars`,
  );
  if (!r.ok || !r.body) {
    uncheckedReasons.push({ repo: `query ${q}`, why: r.why ?? 'no answer' });
    continue;
  }
  if (r.body.items.length === 0) {
    // A query that returns nothing is PRINTED. A silently-dropped query is how
    // a collector reports a shrinking internet when what shrank was the query.
    uncheckedReasons.push({ repo: `query ${q}`, why: 'returned 0 repositories — the query itself may have gone stale' });
    continue;
  }
  for (const it of r.body.items) if (!seen.has(it.full_name)) seen.set(it.full_name, it);
  // The anonymous search quota is ~10/minute. Spacing the calls is cheaper than
  // being told to stop and reporting a dozen repositories as UNCHECKED.
  await new Promise((res) => setTimeout(res, 6500));
}

// ── 2. licence ruling, before a single further request ─────────────────────
//
// 🔴 THE ORDER IS THE POINT. Ruling first means a repository we may not use
// costs zero further calls, so a run's quota is spent entirely on candidates
// that could actually be listed.
const admissible: RepoHit[] = [];
for (const hit of seen.values()) {
  const ruling = ruleLicence(hit.license?.spdx_id ?? null);
  if (!ruling.allowed) {
    refusedReasons.push({ repo: hit.full_name, why: ruling.why ?? 'refused' });
    continue;
  }
  admissible.push(hit);
}

// ── 3. does it actually contain geometry this app claims to open? ──────────
const entries: ExternalDesign[] = [];
let resolved = 0;
for (const hit of admissible) {
  const cached = cache[hit.full_name];
  let commit: string;
  let files: { path: string; ext: string }[];

  if (cached) {
    ({ commit, files } = cached);
  } else if (resolved >= MAX) {
    uncheckedReasons.push({ repo: hit.full_name, why: `not resolved this run — --max ${MAX} reached; re-run to continue where this left off` });
    continue;
  } else {
    // 🔴 RESOLVE THE REF TO A COMMIT SHA, THEN READ THE TREE AT THE SHA. The
    // same rule the AGPL gate runs on, and for the same reason: a read keyed on
    // a branch NAME answers about whatever that name points at when the cache
    // feels like it, and the recorded provenance is then a name rather than a
    // fact. It also makes `commit` below meaningful — a later run can diff.
    const head = await api<{ sha: string }>(`/repos/${hit.full_name}/commits/${encodeURIComponent(hit.default_branch)}`);
    if (!head.ok || !head.body?.sha) {
      uncheckedReasons.push({ repo: hit.full_name, why: `could not resolve ${hit.default_branch} to a commit: ${head.why ?? 'no sha'}` });
      if (head.quota) break;
      continue;
    }
    commit = head.body.sha;
    const tree = await api<{ truncated: boolean; tree: { path: string; type: string }[] }>(
      `/repos/${hit.full_name}/git/trees/${commit}?recursive=1`,
    );
    if (!tree.ok || !Array.isArray(tree.body?.tree)) {
      uncheckedReasons.push({ repo: hit.full_name, why: `could not list the tree at ${commit.slice(0, 12)}: ${tree.why ?? 'no tree'}` });
      if (tree.quota) break;
      continue;
    }
    if (tree.body.truncated) {
      // A truncated listing looks exactly like a complete short one.
      uncheckedReasons.push({ repo: hit.full_name, why: `GitHub TRUNCATED the tree listing at ${commit.slice(0, 12)} — a short list would read as "no designs here"` });
      continue;
    }
    files = tree.body.tree
      .filter((e) => e.type === 'blob')
      .map((e) => ({ path: e.path, ext: extname(e.path).toLowerCase() }))
      .filter((e) => (OPENABLE_EXT as readonly string[]).includes(e.ext))
      .slice(0, 40);
    cache[hit.full_name] = { commit, files };
    resolved += 1;
  }

  if (files.length === 0) {
    refusedReasons.push({ repo: hit.full_name, why: `licence is fine but the tree holds no ${OPENABLE_EXT.join('/')} file — this is a program, not a design` });
    continue;
  }

  const spdx = hit.license?.spdx_id ?? '';
  const ruling = ruleLicence(spdx);
  const [owner] = hit.full_name.split('/');
  entries.push({
    id: hit.full_name.replace(/[^A-Za-z0-9]+/g, '_').toLowerCase(),
    source: 'github',
    repo: hit.full_name,
    url: hit.html_url,
    commit,
    title: hit.full_name.split('/')[1],
    description: (hit.description ?? '').slice(0, 300),
    stars: hit.stargazers_count,
    licence: spdx,
    licenceUrl: hit.license?.url ?? `${hit.html_url}#readme`,
    attribution: `${owner} — ${hit.full_name}, ${spdx}`,
    shareAlike: ruling.shareAlike,
    files,
  });
}

entries.sort((a, b) => b.stars - a.stars || a.repo.localeCompare(b.repo));

mkdirSync(OUT, { recursive: true });
writeFileSync(CACHE, JSON.stringify(cache, null, 1));

const index: ExternalIndex = {
  generatedAt: new Date().toISOString(),
  note:
    'Designs found on public GitHub whose repository declares a licence this lane has reviewed AND which ' +
    'contain a file this app claims to open. NOTHING HERE IS OURS and no design file is republished by us: ' +
    'each card links to the source and names its author and licence. Discovery does NOT mean the design ' +
    'opens — that is `verified`, written by a separate run, and absent until it happens.',
  queries,
  scanned: seen.size,
  listed: entries.length,
  refused: refusedReasons.length,
  refusedReasons: refusedReasons.slice(0, 120),
  unchecked: uncheckedReasons.length,
  uncheckedReasons: uncheckedReasons.slice(0, 120),
  entries,
};

// 🔴 A COLLECT RUN MUST NOT DESTROY VERIFICATION. `verify-external-designs.ts`
// writes `verified` back into this same file, and a naive rewrite would silently
// discard every test result on the next discovery run — leaving a shelf whose
// cards all read "not tested" with no event to explain it.
const prior = existsSync(join(OUT, 'external.json'))
  ? (JSON.parse(readFileSync(join(OUT, 'external.json'), 'utf8')) as ExternalIndex)
  : null;
if (prior?.entries) {
  const was = new Map(prior.entries.map((e) => [e.id, e]));
  for (const e of index.entries) {
    const old = was.get(e.id);
    // Carried only when the COMMIT is unchanged: a verification is a statement
    // about specific bytes, and re-attaching it to a moved repository would be
    // exactly the stale-evidence defect this tree keeps finding.
    if (old?.verified && old.commit === e.commit) e.verified = old.verified;
  }
}

writeFileSync(join(OUT, 'external.json'), JSON.stringify(index, null, 1));
console.log(
  `\nscanned ${index.scanned} repo(s) · listed ${index.listed} · refused ${index.refused} · unchecked ${index.unchecked}`,
);
for (const r of refusedReasons.slice(0, 12)) console.log(`  refused   ${r.repo}: ${r.why}`);
for (const r of uncheckedReasons.slice(0, 12)) console.log(`  unchecked ${r.repo}: ${r.why}`);
console.log(`-> public/designs/external.json`);
