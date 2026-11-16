// THE pcb TAB'S GATE RECORDS — collected from `pcb`'s tree on disk, never run.
// Founder 2026-10-16: *"right all gates (migrate all gates from local disk)"*.
//
//   in   hardware/pcb/<board>/            .kicad_pcb, .kicad_sch, pcb_<id>.py, verify_<id>.py,
//                                         <id>-erc.rpt, <id>-drc*.rpt, *drc*.json, logs/audit-*.rpt
//        hardware/pcb/<board>/fab/[sub/]   gerbers, drills, job file, source.sha, order markers
//        hardware/pcb/docs/fleet-gate-matrix-*.json   gate_check.py's per-board rows
//        hardware/pcb/gate_check.py        the gate register (names, FAB_BLOCKING, ORDER) — READ as text
//   out  web/public/pcb-gates/index.json  (generated, not committed — same reason as public/pnp-stackup/)
//
// 🔴 NOTHING OF pcb's IS EXECUTED. Not gate_check.py, not a verifier, not
// kicad-cli. This reads what those tools last WROTE and records when the board
// last changed, so `src/pcbtab/pcbGates.ts` can refuse a record older than the
// board. `git` is run read-only (log, status) for those dates.
//
// "WHEN THE BOARD LAST CHANGED" IS AN UPPER BOUND, ON PURPOSE: an uncommitted
// file → its mtime; a committed one → min(commit date, mtime) (bytes equal to
// HEAD were written no later than either). A bound that is too late makes a
// fresh record look stale (PENDING, a re-run); one too early would let a stale
// record PASS. Only the first error is acceptable.
//
// Exit: 0 written · 2 could not run (no hardware/pcb, or the output could not be written).
// Run: `npm run pcb:gates` (also chained into `npm run build`).

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normDate, parseDrcJson, parseRpt, type BoardRecords, type DatedChange, type GatesSnapshot, type RptRecord } from '../src/pcbtab/pcbGates';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../../..');
const PCB = join(REPO, 'hardware/pcb');
const args = process.argv.slice(2);
if (args.length && !(args.length === 2 && args[0] === '--out')) {
  console.error(`pcb-gates: unknown arguments ${args.join(' ')} — accepted: --out <file>`);
  process.exit(2);
}
const OUT = args[0] === '--out' ? resolve(args[1]) : resolve(HERE, '../public/pcb-gates/index.json');

const rel = (abs: string) => abs.slice(REPO.length + 1);
const sha = (abs: string) => createHash('sha256').update(readFileSync(abs)).digest('hex');
const git = (a: string[]) => {
  try {
    return execFileSync('git', ['-C', REPO, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60_000 }).trim();
  } catch {
    return '';
  }
};

function changed(abs: string): DatedChange | null {
  if (!existsSync(abs)) return null;
  const mtime = statSync(abs).mtime;
  const dirty = git(['status', '--porcelain', '--', rel(abs)]) !== '';
  const commit = dirty ? '' : git(['log', '-1', '--format=%cI', '--', rel(abs)]);
  if (dirty || !commit) return { file: rel(abs), date: mtime.toISOString(), how: 'mtime' };
  const c = new Date(commit);
  return { file: rel(abs), date: (c < mtime ? c : mtime).toISOString(), how: 'commit' };
}

const firstHeading = (abs: string) => {
  const t = readFileSync(abs, 'utf8');
  return (/^#+\s*(.+)$/m.exec(t)?.[1] ?? t.split('\n')[0]).replace(/[*`]/g, '').trim().slice(0, 200);
};

/** gate_check.py's register, read as TEXT (never imported, never run). */
function register(): Pick<GatesSnapshot, 'gateNames' | 'guards' | 'order'> {
  const p = join(PCB, 'gate_check.py');
  if (!existsSync(p)) return { gateNames: {}, guards: {}, order: [] };
  const t = readFileSync(p, 'utf8');
  const gateNames: Record<string, string> = {};
  for (const m of t.matchAll(/^\s+"(\w+)":\s*\("(G[^"]+)",\s*gate\w*\)/gm)) gateNames[m[1]] = m[2];
  const guards: Record<string, string> = {};
  const fb = /^FAB_BLOCKING = \{([\s\S]*?)^\}/m.exec(t)?.[1] ?? '';
  for (const m of fb.matchAll(/^\s+"(\w+)":\s*\("(BARE|ASSY)",\s*"((?:[^"\\]|\\.)*)"\)/gm))
    guards[m[1]] = `${m[2] === 'BARE' ? 'stops the bare-board order' : 'stops assembly'}: ${m[3]}`;
  const order = JSON.parse(/^ORDER = (\[[^\]]*\])/m.exec(t)?.[1] ?? '[]') as string[];
  return { gateNames, guards, order };
}

function matrices(): { file: string; committed: string | null; data: Record<string, Record<string, unknown>> }[] {
  const d = join(PCB, 'docs');
  if (!existsSync(d)) return [];
  return readdirSync(d)
    .filter((f) => /^fleet-gate-matrix.*\.json$/.test(f))
    .map((f) => {
      const abs = join(d, f);
      try {
        return { file: rel(abs), committed: git(['log', '-1', '--format=%cI', '--', rel(abs)]) || null, data: JSON.parse(readFileSync(abs, 'utf8')) };
      } catch {
        return { file: rel(abs), committed: null, data: {} };
      }
    });
}

function boardsOnDisk(): { id: string; dir: string; fab: string }[] {
  const out: { id: string; dir: string; fab: string }[] = [];
  for (const d of readdirSync(PCB, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const fab = join(PCB, d.name, 'fab');
    if (!existsSync(fab)) continue;
    const fabs = [fab, ...readdirSync(fab, { withFileTypes: true }).filter((s) => s.isDirectory()).map((s) => join(fab, s.name))];
    for (const f of fabs)
      for (const c of readdirSync(f).filter((x) => x.endsWith('-cpl.csv'))) {
        const id = c.slice(0, -'-cpl.csv'.length);
        if (existsSync(join(f, `${id}-bom.csv`))) out.push({ id, dir: join(PCB, d.name), fab: f });
      }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

function collect(b: { id: string; dir: string; fab: string }, mats: ReturnType<typeof matrices>): BoardRecords {
  const { id, dir, fab } = b;
  const pcb = join(dir, `${id}.kicad_pcb`);
  const sch = join(dir, `${id}.kicad_sch`);
  const gen = join(dir, `pcb_${id}.py`);
  const single = dir.endsWith(`/${id}`); // a dir holding ONE board: its logs/ are that board's
  const fabFiles = readdirSync(fab).filter((f) => statSync(join(fab, f)).isFile());
  const mine = fabFiles.filter((f) => f.startsWith(`${id}-`) || f.startsWith(`${id}.`) || /^(_DO-NOT-ORDER.*|ORDERED|ORDER-STOP-RECORD)\.md$/.test(f));
  const srcSha = existsSync(join(fab, `${id}.source.sha`)) ? readFileSync(join(fab, `${id}.source.sha`), 'utf8').trim().split(/\s+/)[0] || null : null;
  let gerberCreated: string | null = null;
  const edge = join(fab, `${id}-Edge_Cuts.gbr`);
  if (existsSync(edge)) {
    const m = /%TF\.CreationDate,([^*]+)\*%/.exec(readFileSync(edge, 'utf8').slice(0, 4000));
    gerberCreated = m ? normDate(m[1]) : null;
  }
  let jobCopperLayers: number | null = null;
  try {
    const j = JSON.parse(readFileSync(join(fab, `${id}-job.gbrjob`), 'utf8')) as { GeneralSpecs?: { LayerNumber?: number } };
    jobCopperLayers = typeof j.GeneralSpecs?.LayerNumber === 'number' ? j.GeneralSpecs.LayerNumber : null;
  } catch {
    /* no job file: the gate says so */
  }
  const rpts: RptRecord[] = [];
  const tryRpt = (abs: string) => {
    if (!existsSync(abs)) return;
    const t = readFileSync(abs, 'utf8');
    rpts.push(abs.endsWith('.json') ? parseDrcJson(rel(abs), t) : parseRpt(rel(abs), t));
  };
  for (const f of readdirSync(dir)) {
    if (new RegExp(`^${id}-(erc|drc)[\\w-]*\\.rpt$`).test(f)) tryRpt(join(dir, f));
    if (single && /drc[\w-]*\.json$/i.test(f)) tryRpt(join(dir, f));
  }
  for (const f of readdirSync(PCB)) if (new RegExp(`^${id}-drc[\\w-]*\\.rpt$`).test(f)) tryRpt(join(PCB, f));
  if (single && existsSync(join(dir, 'logs'))) for (const f of readdirSync(join(dir, 'logs'))) if (/(erc|drc).*\.rpt$/.test(f)) tryRpt(join(dir, 'logs', f));
  const verifiers = existsSync(join(dir, `verify_${id}.py`)) ? [rel(join(dir, `verify_${id}.py`))] : [];
  const m = mats.find((x) => x.data[id]);
  let matrix: BoardRecords['matrix'] = null;
  if (m) {
    const row = m.data[id] as Record<string, unknown>;
    const rows: Record<string, { status: string; detail: string }> = {};
    for (const [k, v] of Object.entries(row))
      if (!k.startsWith('_') && v && typeof v === 'object') {
        const o = v as { status?: unknown; detail?: unknown };
        rows[k] = { status: String(o.status ?? ''), detail: String(o.detail ?? '') };
      }
    matrix = { file: m.file, committed: m.committed, generatorSha: typeof row._generator_sha === 'string' ? row._generator_sha : null, rows };
  }
  return {
    id,
    dir: rel(dir),
    fabDir: rel(fab),
    board: {
      kicadPcb: existsSync(pcb) ? rel(pcb) : null,
      sha256: existsSync(pcb) ? sha(pcb) : null,
      pcbChanged: changed(pcb),
      schChanged: changed(sch),
      generator: existsSync(gen) ? rel(gen) : null,
      generatorSha: existsSync(gen) ? sha(gen) : null,
    },
    fab: {
      files: mine.sort(),
      sourceSha: srcSha,
      gerberCreated,
      jobCopperLayers,
      doNotOrder: fabFiles.filter((f) => /^_DO-NOT-ORDER.*\.md$/.test(f)).map((f) => ({ file: f, title: firstHeading(join(fab, f)) })),
      ordered: existsSync(join(fab, 'ORDERED.md')) ? { file: 'ORDERED.md', title: firstHeading(join(fab, 'ORDERED.md')) } : null,
    },
    erc: rpts.filter((r) => r.kind === 'erc'),
    drc: rpts.filter((r) => r.kind === 'drc'),
    verifiers,
    adjudications: fabFiles.filter((f) => f === `${id}-drc-adjudication.md`).map((f) => rel(join(fab, f))),
    matrix,
  };
}

function main(): number {
  if (!existsSync(PCB)) {
    console.error(`pcb-gates: ${PCB} does not exist — could not run`);
    return 2;
  }
  const mats = matrices();
  const boards = boardsOnDisk().map((b) => collect(b, mats));
  const snap: GatesSnapshot = {
    generatedAt: new Date().toISOString(),
    generator: 'scripts/build-pcb-gates.ts (reads records; runs nothing of pcb’s)',
    ...register(),
    boards,
  };
  mkdirSync(dirname(OUT), { recursive: true });
  const tmp = `${OUT}.building-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(snap, null, 1));
  renameSync(tmp, OUT);
  console.log(
    `pcb-gates: ${boards.length} board(s) → ${rel(OUT)} · gate names ${Object.keys(snap.gateNames).length} · ` +
      `matrix rows: ${boards.filter((b) => b.matrix).map((b) => `${b.id}(${Object.keys(b.matrix!.rows).length}${b.matrix!.generatorSha ? ',sha' : ''})`).join(' ') || 'none'} · ` +
      `erc ${boards.reduce((n, b) => n + b.erc.length, 0)} · drc ${boards.reduce((n, b) => n + b.drc.length, 0)} · ` +
      `do-not-order ${boards.filter((b) => b.fab.doNotOrder.length).map((b) => b.id).join(',') || 'none'}`
  );
  return 0;
}

try {
  process.exit(main());
} catch (e) {
  console.error(`pcb-gates: could not run: ${(e as Error).message}`);
  process.exit(2);
}
