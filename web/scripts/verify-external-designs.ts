// VERIFY EXTERNAL DESIGNS — OPEN EACH ONE IN THIS APP'S OWN READER, AND SAY SO.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHY A SECOND RUN INSTEAD OF ONE PIPELINE
// ═══════════════════════════════════════════════════════════════════════════
//
// Discovery can say *"this repository declares CC-BY-4.0 and contains four
// `.scad` files"*. It cannot say the app opens them, and the gap between those
// two sentences is exactly where a catalogue starts lying: a card that promises
// "pick this and it opens in 2bee.cad" is a promise redeemed at the one moment
// the user is watching. So the claim is MEASURED, by running the design through
// `parseScad` + `makeLibraryHost` + `meshScene` — the same three the tab uses —
// and the result is stored in its own field. `verified === undefined` means NOT
// TESTED, which is neither a pass nor a failure, and the tab renders all three.
//
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 THE ANIMATION PROBE, AND THE FINDING IT EXISTS TO PRODUCE
// ═══════════════════════════════════════════════════════════════════════════
//
// OpenSCAD animates by re-evaluating the whole source with `$t` stepped from 0
// to 1. This reader bound `$t` to a constant 0 until 2026-09-09; it now takes it
// as an option (`ScadOptions.t`, default 0, so nothing that existed moved).
//
// The probe evaluates FRAMES steps and compares a fingerprint of the resulting
// geometry. It reports two facts that are easy to confuse and must not be:
//
//   `mentionsT`  the source text references `$t` at all
//   `moves`      the geometry actually DIFFERED between steps
//
// 🔴 `mentionsT && !moves` IS A REAL FINDING, NOT A NULL RESULT. It means this
// reader produced a still picture of a design that declares an animation —
// either `$t` drives something non-geometric, or the construct that moved is one
// this reader dropped. A card that advertised "animated" on that evidence would
// be describing the plan instead of the output, which is the defect this lane
// has been bitten by four times and now checks for by rule.
//
// ⚠ THE FINGERPRINT IS DELIBERATELY CHEAP AND ITS WEAKNESS IS NAMED: triangle
// count, rounded bounds, and a sum of vertex coordinates. A motion that permutes
// vertices without moving any of them, or that moves two parts by exactly
// opposite amounts, is invisible to it. It cannot report a FALSE animation —
// a changed fingerprint means the geometry really changed — so its error runs
// only in the direction of saying "does not move" about something that did.
//
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 WHAT IS DOWNLOADED, WHERE IT GOES, AND WHAT IS NEVER REPUBLISHED
// ═══════════════════════════════════════════════════════════════════════════
//
// Sources are fetched from `raw.githubusercontent.com` AT THE PINNED COMMIT the
// collector recorded — never at a branch name, which is a CDN answer about a
// cache rather than about the repository. They land in `web/.design-src/`
// (gitignored, and OUTSIDE `public/` so the build cannot serve them) so a re-run
// is free. They are NOT copied into git and NOT served. The card links out.
//
// ⚠ ONLY `.scad` IS TESTED BY THIS RUN. `.dxf`/`.svg`/`.stl` intake is the CLI's
// path (`2bee-slice import`) and is not wired in here; those entries are recorded
// as untested WITH THAT REASON rather than being silently dropped, so "we did not
// test it" cannot be read as "it failed".
//
// USAGE
//   node --import ./tests/register.mjs scripts/verify-external-designs.ts
//   ... --limit 8    how many designs to test this run
//   ... --all        re-test designs that already carry a verification
//   ... --frames 5   animation steps (default 4)

import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseScad } from '../src/cad/scad.ts';
import { makeLibraryHost, normalisePath, type ScadLibrary } from '../src/cad/library.ts';
import { meshScene } from '../src/cad/mesh.ts';
import type { AnimationProbe, ExternalIndex, ExternalVerification } from '../src/shop/external.ts';

/** `normalisePath` returns null for a path that escapes the library root. Such a
 *  path cannot name a file here, so it is dropped BY NAME with a reason rather
 *  than coerced — every escaping path would otherwise collapse onto one key. */
const norm = (p: string): string | null => normalisePath(p);

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(WEB, 'public', 'designs');
/**
 * 🔴 OUTSIDE `public/`, AND THIS WAS A REAL DEFECT CAUGHT BEFORE IT SHIPPED.
 * The cache first lived at `public/designs/.external-src/`, and Vite copies
 * `public/` into `dist/` verbatim — so every third-party source file fetched to
 * TEST a design would have been SERVED from our own origin. ⇒ ***The one thing
 * this pipeline states it does not do — republish other people's work — would
 * have happened as a side effect of where a scratch directory was put.***
 * ⚠ It would also have been invisible: the shelf's cards link out, so nothing on
 * screen would have shown the copies were there.
 */
const SRC = join(WEB, '.design-src');
const INDEX = join(OUT, 'external.json');

const argv = process.argv.slice(2);
const argOf = (n: string): string | null => {
  const i = argv.indexOf(n);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
};
const LIMIT = Number.parseInt(argOf('--limit') ?? '8', 10);
const FRAMES = Math.max(2, Number.parseInt(argOf('--frames') ?? '4', 10));
const ALL = argv.includes('--all');

if (!existsSync(INDEX)) {
  console.error(`no ${INDEX} — run \`npm run designs:collect\` first. This run measured nothing.`);
  process.exit(2);
}
const index = JSON.parse(readFileSync(INDEX, 'utf8')) as ExternalIndex;

const RAW = 'https://raw.githubusercontent.com';
const MAX_FILE_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;

async function fetchSource(repo: string, commit: string, path: string): Promise<string | null> {
  const cached = join(SRC, repo.replace('/', '__'), commit.slice(0, 12), path);
  if (existsSync(cached)) return readFileSync(cached, 'utf8');
  let r: Response;
  try {
    r = await fetch(`${RAW}/${repo}/${commit}/${path}`, { headers: { 'User-Agent': '2bee.app-design-verifier' } });
  } catch {
    return null;
  }
  if (!r.ok) return null;
  const text = await r.text();
  if (text.length > MAX_FILE_BYTES) return null;
  mkdirSync(dirname(cached), { recursive: true });
  writeFileSync(cached, text);
  return text;
}

/**
 * Which file to open.
 *
 * ⚠ A REPOSITORY IS NOT A DESIGN, and this is a guess with a stated rule rather
 * than a judgement: the SHALLOWEST `.scad`, then the shortest name. Libraries
 * live under `lib/`; the thing a human opens is usually at the top. When the
 * guess is wrong the verification is still honest — it reports what happened to
 * the file it names in `entry`, and `entry` is on the card.
 */
function pickEntries(files: { path: string; ext: string }[], limit = 4): string[] {
  const scad = files.filter((f) => f.ext === '.scad');
  if (scad.length === 0) return [];
  const score = (p: string) => {
    const name = p.toLowerCase();
    let s = p.split('/').length * 10 + p.length / 100;
    // 🔴 A LIBRARY IS NOT A DESIGN, and the first version of this could not tell
    // them apart. It picked the single shallowest `.scad`, which for `BOSL2` is
    // `math.scad` and for `NopSCADlib` is `lib.scad` — both opened fine and drew
    // NOTHING, so the shelf reported two well-known design libraries as "this
    // reader refused it". ⚠ The verdict was true about the file and false about
    // the repository, which is the worse kind of wrong: it reads as a finding.
    if (/(^|\/)(lib|libs|library|math|utils?|common|constants?)\.scad$/.test(name)) s += 40;
    if (/(^|\/)(examples?|demos?|models?|parts?)\//.test(name)) s -= 15;
    if (/(example|demo|assembly|main)/.test(name)) s -= 8;
    return s;
  };
  return [...scad].sort((a, b) => score(a.path) - score(b.path) || a.path.localeCompare(b.path)).slice(0, limit).map((f) => f.path);
}

/** Triangle count, rounded bounds and a coordinate sum. See the header for the
 *  one direction this can be wrong in. */
function fingerprint(parts: { positions: Float32Array; triangles: number }[]): string {
  let tri = 0;
  let sum = 0;
  let lo = [Infinity, Infinity, Infinity];
  let hi = [-Infinity, -Infinity, -Infinity];
  for (const p of parts) {
    tri += p.triangles;
    for (let i = 0; i < p.positions.length; i += 3) {
      const x = p.positions[i], y = p.positions[i + 1], z = p.positions[i + 2];
      sum += x + y + z;
      lo = [Math.min(lo[0], x), Math.min(lo[1], y), Math.min(lo[2], z)];
      hi = [Math.max(hi[0], x), Math.max(hi[1], y), Math.max(hi[2], z)];
    }
  }
  const r = (n: number) => (Number.isFinite(n) ? n.toFixed(3) : 'na');
  return `${tri}|${sum.toFixed(3)}|${lo.map(r).join(',')}|${hi.map(r).join(',')}`;
}

const targets = index.entries.filter((e) => (ALL ? true : !e.verified)).slice(0, LIMIT);
let tested = 0;
let opened = 0;
let animated = 0;
let crashed = 0;
const skipped: { repo: string; why: string }[] = [];

for (const design of targets) {
  const candidates = pickEntries(design.files);
  if (candidates.length === 0) {
    skipped.push({
      repo: design.repo,
      why: `no .scad file — this run tests OpenSCAD sources only; ${design.files.map((f) => f.ext).join('/')} intake is the CLI's path (2bee-slice import) and is not wired in here`,
    });
    continue;
  }

  // The import closure is approximated by the repository's own .scad files, which
  // is what `include`/`use` can name. Capped, and the cap is REPORTED through the
  // library's `skipped` list rather than by quietly reading fewer files.
  const lib: ScadLibrary = { files: new Map(), rootName: design.repo, pickedAt: Date.now(), skipped: [] };
  let bytes = 0;
  for (const f of design.files.filter((f) => f.ext === '.scad')) {
    if (bytes >= MAX_TOTAL_BYTES) {
      lib.skipped.push({ path: f.path, why: `not fetched — this run's ${MAX_TOTAL_BYTES}-byte budget was already spent` });
      continue;
    }
    const text = await fetchSource(design.repo, design.commit, f.path);
    if (text === null) {
      lib.skipped.push({ path: f.path, why: 'could not be fetched at the pinned commit, or exceeded the per-file cap' });
      continue;
    }
    bytes += text.length;
    const key = norm(f.path);
    if (key === null) {
      lib.skipped.push({ path: f.path, why: 'the path escapes the repository root and cannot be addressed' });
      continue;
    }
    lib.files.set(key, text);
  }

  /**
   * 🔴 SEVERAL CANDIDATES ARE TRIED, AND THE ONE THAT DRAWS WINS. Opening the
   * first plausible file and reporting its verdict as the repository's is how a
   * design library gets published as a broken design. Up to four are evaluated
   * locally (the sources are already fetched, so this costs no network) and the
   * FIRST that produces geometry is kept; if none do, the best-scoring one's
   * verdict is reported, and `entry` on the card says which file that was.
   */
  let entry = '';
  let entryKey: string | null = null;
  let src: string | undefined;
  for (const c of candidates) {
    const k = norm(c);
    const text = k === null ? undefined : lib.files.get(k);
    if (text === undefined) continue;
    entry = c;
    entryKey = k;
    src = text;
    break;
  }
  if (src === undefined) {
    skipped.push({ repo: design.repo, why: `none of ${candidates.length} candidate entr(ies) could be fetched at ${design.commit.slice(0, 12)}` });
    continue;
  }

  const host = makeLibraryHost(lib);
  /**
   * 🔴 A DESIGN THAT CRASHES THE READER IS A RESULT, NOT AN ABORT — and the
   * first real run of this verifier proved it the hard way: `meshScene` threw
   * `RangeError: Maximum call stack size exceeded` inside `quickhull` on a
   * third-party model, the process died, and NOTHING was recorded for any
   * design, including the ones already tested.
   *
   * ⚠ THE SAME CODE RUNS IN THE BROWSER. This is not a harness quirk: a visitor
   * who opens that design in 2bee.cad gets the same throw on the main thread.
   * Filed as a finding rather than swallowed — see the run's summary line.
   *
   * So every evaluation is wrapped, and a throw becomes `opens: false` with the
   * message, which is the honest answer to "can this app open it".
   */
  const frame = (t: number) => {
    try {
      const parsed = parseScad(src, { host, path: entryKey ?? entry, t });
      const mesh = meshScene(parsed.scene);
      return { parsed, mesh, threw: null as string | null };
    } catch (e) {
      return { parsed: null, mesh: null, threw: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
    }
  };

  const f0 = frame(0);
  tested += 1;
  if (f0.threw !== null || !f0.parsed || !f0.mesh) {
    crashed += 1;
    design.verified = {
      checkedAt: new Date().toISOString(),
      entry,
      opens: false,
      errors: 1,
      firstError: `the reader THREW while opening this design: ${f0.threw ?? 'no result and no error'}`,
      unsupported: [],
      parts: 0,
      triangles: 0,
      trust: 'nothing',
      trustDetail: 'not meshed — the mesher threw',
      sizeMm: null,
      animation: { mentionsT: false, frames: 0, moves: false, note: 'not probed — the reader threw' },
    };
    console.log(`  THREW  ${design.repo} (${entry}) — ${f0.threw}`);
    continue;
  }

  let best = f0;
  let bestEntry = entry;
  let bestKey = entryKey;
  let triedEntries = 1;
  if (!(f0.parsed.errors.length === 0 && f0.mesh.stats.triangles > 0)) {
    for (const c of candidates.slice(1)) {
      const k = norm(c);
      const text = k === null ? undefined : lib.files.get(k);
      if (text === undefined) continue;
      triedEntries += 1;
      const alt = (() => {
        try {
          const parsed = parseScad(text, { host, path: k ?? c, t: 0 });
          return { parsed, mesh: meshScene(parsed.scene), threw: null as string | null };
        } catch (e) {
          return { parsed: null, mesh: null, threw: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
        }
      })();
      if (alt.parsed && alt.mesh && alt.parsed.errors.length === 0 && alt.mesh.stats.triangles > 0) {
        best = alt as typeof f0;
        bestEntry = c;
        bestKey = k;
        break;
      }
    }
  }
  entry = bestEntry;
  entryKey = bestKey;
  const opens = best.parsed!.errors.length === 0 && best.mesh!.stats.triangles > 0;
  if (opens) opened += 1;

  let lo = [Infinity, Infinity, Infinity];
  let hi = [-Infinity, -Infinity, -Infinity];
  for (const p of best.mesh!.parts) {
    if (!p.bounds) continue;
    for (let a = 0; a < 3; a += 1) {
      lo[a] = Math.min(lo[a], p.bounds.min[a]);
      hi[a] = Math.max(hi[a], p.bounds.max[a]);
    }
  }
  const sizeMm: [number, number, number] | null = Number.isFinite(lo[0])
    ? [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]]
    : null;

  // ── the animation probe ──────────────────────────────────────────────────
  //
  // `$t` is looked for in EVERY source that was read, not only the entry: a
  // design whose animation lives in an included module would otherwise be
  // reported as static, which is the reassuring direction.
  const mentionsT = [...lib.files.values()].some((s) => /\$t\b/.test(s));
  let animation: AnimationProbe;
  if (!opens) {
    animation = { mentionsT, frames: 0, moves: false, note: 'not probed — the design does not open, so there is nothing to step' };
  } else if (!mentionsT) {
    animation = { mentionsT: false, frames: 0, moves: false, note: 'no $t anywhere in the sources read — nothing to animate' };
  } else {
    const base = fingerprint(best.mesh!.parts);
    let moved = false;
    let steps = 1;
    for (let i = 1; i < FRAMES; i += 1) {
      const t = i / FRAMES;
      const f = frame(t);
      steps += 1;
      if (f.threw !== null || !f.mesh) {
        // A throw at a later step is itself a finding: the design opens at t=0
        // and takes the reader down when animated.
        animation = { mentionsT: true, frames: steps, moves: false, note: `the reader THREW at step ${steps - 1}: ${f.threw}` };
        break;
      }
      if (fingerprint(f.mesh.parts) !== base) {
        moved = true;
        break;
      }
    }
    animation = {
      mentionsT: true,
      frames: steps,
      moves: moved,
      note: moved
        ? `geometry changed by step ${steps - 1}/${FRAMES}`
        : `evaluated ${steps} step(s) and the geometry fingerprint never changed — the source mentions $t but this reader produces a still picture. That is a finding about THIS READER as much as about the design`,
    };
    if (moved) animated += 1;
  }

  const verification: ExternalVerification = {
    checkedAt: new Date().toISOString(),
    entry,
    opens,
    errors: best.parsed!.errors.length,
    firstError: best.parsed!.errors[0]?.message?.slice(0, 200) ?? undefined,
    unsupported: [...new Set(best.parsed!.unsupported.map((u) => u.name))].slice(0, 12),
    parts: best.mesh!.parts.length,
    triangles: best.mesh!.stats.triangles,
    trust: best.mesh!.trust,
    trustDetail: best.mesh!.trustDetail,
    sizeMm,
    animation,
  };
  design.verified = verification;

  console.log(
    `  ${opens ? 'opens ' : 'REFUSED'} ${design.repo} (${entry}) — ${verification.parts} part(s), ` +
      `${verification.triangles} tri, trust=${verification.trust}` +
      (mentionsT ? `, $t ${animation.moves ? 'ANIMATES' : 'mentioned but still'}` : ''),
  );
}

writeFileSync(INDEX, JSON.stringify(index, null, 1));
console.log(
  `\ntested ${tested} · opens ${opened} · refused-by-reader ${tested - opened} · THREW ${crashed} · animated ${animated} · skipped ${skipped.length}`,
);
for (const s of skipped.slice(0, 12)) console.log(`  skipped ${s.repo}: ${s.why}`);
console.log(
  `\n⚠ "tested" is a statement about ${tested} design(s), not about the shelf: ` +
    `${index.entries.length - index.entries.filter((e) => e.verified).length} entry/entries remain UNTESTED, which is not a pass.`,
);
console.log(`-> ${INDEX}`);
