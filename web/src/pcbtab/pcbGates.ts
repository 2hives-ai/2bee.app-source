/**
 * The pcb tab's gates (founder 2026-10-16: *"create a new pcb tab (left is ai
 * assistant, have the 3d pcb view, right all gates (migrate all gates from local
 * disk)"*).
 *
 * WHAT THIS IS: the gates `pcb` has RECORDED on disk for one board, read back and
 * shown, plus a few gates DERIVED from the board's fab files themselves. Nothing
 * here runs `pcb`'s python (`gate_check.py`, `verify_<board>.py`, kicad-cli). The
 * records are collected by `scripts/build-pcb-gates.ts` into
 * `public/pcb-gates/index.json`; this file turns that snapshot into gates.
 *
 * THREE STATES, NEVER TWO. PASS = a record (or a fab file) says it holds AND that
 * record still describes today's board. FAIL = it says it does not. PENDING = no
 * record, an undated record, a record older than the board's last change, a WARN
 * or SKIP, or a board the snapshot cannot be tied to. ⚠ PENDING IS NOT A PASS.
 *
 * DIRECTION OF ERROR: over-block. A false PENDING sends someone to re-run a gate;
 * a false PASS sends a stale board to the fab. So freshness is decided with an
 * UPPER BOUND on the board's last change (`changedBound` in the generator), and
 * every record is also tied to the live board by content: the tab hashes the
 * .kicad_pcb it loaded, and if that differs from the hash in the snapshot, every
 * recorded gate is PENDING until the snapshot is re-collected.
 *
 * Every gate says where its record came from (file + date) in `source`.
 */
import type { PanelGate } from '../gates/GatesPanel';
import { SINGLE_SIDED } from '../pnp/singleSided';

/** When a board source last changed, as an upper bound, and how that was known. */
export interface DatedChange {
  file: string;
  date: string;
  /** `mtime` = uncommitted edit, its mtime · `commit` = committed, min(commit, mtime). */
  how: 'mtime' | 'commit';
}

export interface RptRecord {
  file: string;
  /** The date the report carries inside it (kicad-cli writes one); null = none. */
  date: string | null;
  kind: 'erc' | 'drc';
  errors: number | null;
  warnings: number | null;
  /** DRC only. */
  violations?: number | null;
  unconnected?: number | null;
  footprintErrors?: number | null;
  /** `[type]` → count, for the AI and the why line. */
  types: Record<string, number>;
}

export interface MatrixRow {
  status: string;
  detail: string;
}

export interface BoardRecords {
  id: string;
  /** Repo-relative board dir and fab dir. */
  dir: string;
  fabDir: string;
  board: {
    kicadPcb: string | null;
    /** sha256 of the .kicad_pcb when the snapshot was taken. */
    sha256: string | null;
    pcbChanged: DatedChange | null;
    schChanged: DatedChange | null;
    /** `pcb_<id>.py` and its sha256 at snapshot time (what matrix rows are stamped with). */
    generator: string | null;
    generatorSha: string | null;
  };
  fab: {
    /** File names in fabDir that belong to this board (plus order markers). */
    files: string[];
    /** First token of `<id>.source.sha` — the board sha the fab set was exported from. */
    sourceSha: string | null;
    /** `%TF.CreationDate` of the Edge_Cuts gerber. */
    gerberCreated: string | null;
    /** `GeneralSpecs.LayerNumber` from `<id>-job.gbrjob`. */
    jobCopperLayers: number | null;
    doNotOrder: { file: string; title: string }[];
    ordered: { file: string; title: string } | null;
  };
  erc: RptRecord[];
  drc: RptRecord[];
  verifiers: string[];
  adjudications: string[];
  matrix: {
    file: string;
    /** Last commit date of the matrix FILE — not of any one row. */
    committed: string | null;
    generatorSha: string | null;
    rows: Record<string, MatrixRow>;
  } | null;
}

export interface GatesSnapshot {
  generatedAt: string;
  generator: string;
  /** gate_check.py's register: id → "G5 Fab". */
  gateNames: Record<string, string>;
  /** gate_check.py's FAB_BLOCKING: id → what it stops and the physical failure. */
  guards: Record<string, string>;
  /** gate_check.py's ORDER. */
  order: string[];
  boards: BoardRecords[];
}

export interface PcbGate extends PanelGate {
  /** Where the verdict came from: a file path (+ date), or "derived: …". */
  source: string;
  group: 'snapshot' | 'fab' | 'record' | 'matrix';
}

export interface PcbPartIn {
  ref: string;
  side: 'top' | 'bottom';
  /** `parts.ts` By: machine | hand-tht | hand | fab | not-placed | dnp | unknown. */
  by: string;
  from: 'cpl' | 'kicad_pcb';
  /** Every footprint pad is thru_hole (parts.ts; absent when the .kicad_pcb was not read). */
  allThroughHole?: boolean;
}

export interface PcbGateInput {
  boardId: string;
  /** The snapshot, a sentence saying why there is none, or null while loading. */
  snapshot: GatesSnapshot | string | null;
  /** sha256 of the .kicad_pcb as the tab loaded it now; null = not (yet) loaded / no board file. */
  liveBoardSha: string | null;
  /** The board's parts (`parts.ts` boardParts) — null while loading. */
  parts: { parts: PcbPartIn[]; unplaced: { ref: string; by: string }[] } | null;
  bomRefs: string[];
  cplRefs: string[];
  /** Footprint references on the .kicad_pcb ([] when it did not load). */
  footprintRefs: string[];
}

// ─── parsing (shared with the generator, tested here) ──────────────────────

/** kicad writes `+1000`; `Date.parse` wants `+10:00`. */
export function normDate(s: string): string {
  return s.trim().replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
}

function countTypes(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of text.matchAll(/^\[([\w-]+)\]:/gm)) out[m[1]] = (out[m[1]] ?? 0) + 1;
  return out;
}

/** A kicad-cli ERC or DRC text report. Unknown shape → every count null (the gate goes PENDING). */
export function parseRpt(file: string, text: string): RptRecord {
  const types = countTypes(text);
  const n = (re: RegExp) => {
    const m = re.exec(text);
    return m ? Number(m[1]) : null;
  };
  if (/^ERC report/m.test(text)) {
    const d = /ERC report \(([^,)]+)/.exec(text);
    const m = /ERC messages:\s*(\d+)\s+Errors\s+(\d+)\s+Warnings\s+(\d+)/.exec(text);
    return { file, kind: 'erc', date: d ? normDate(d[1]) : null, errors: m ? Number(m[2]) : null, warnings: m ? Number(m[3]) : null, types };
  }
  const d = /Created on (\S+) \*\*/.exec(text);
  const sev = (s: string) => (text.match(new RegExp(`; ${s}\\s*$`, 'gm')) ?? []).length;
  const violations = n(/Found (\d+) DRC violations/);
  return {
    file,
    kind: 'drc',
    date: d ? normDate(d[1]) : null,
    violations,
    unconnected: n(/Found (\d+) unconnected pads/),
    footprintErrors: n(/Found (\d+) Footprint errors/),
    errors: violations === null ? null : sev('error'),
    warnings: violations === null ? null : sev('warning'),
    types,
  };
}

/** kicad-cli's `--format json` DRC report. */
export function parseDrcJson(file: string, text: string): RptRecord {
  try {
    const j = JSON.parse(text) as {
      date?: string;
      violations?: { type?: string; severity?: string }[];
      unconnected_items?: unknown[];
      schematic_parity?: unknown[];
    };
    const v = Array.isArray(j.violations) ? j.violations : null;
    const types: Record<string, number> = {};
    for (const x of v ?? []) if (x.type) types[x.type] = (types[x.type] ?? 0) + 1;
    return {
      file,
      kind: 'drc',
      date: j.date ? normDate(j.date) : null,
      violations: v ? v.length : null,
      unconnected: Array.isArray(j.unconnected_items) ? j.unconnected_items.length : null,
      footprintErrors: Array.isArray(j.schematic_parity) ? j.schematic_parity.length : null,
      errors: v ? v.filter((x) => x.severity === 'error').length : null,
      warnings: v ? v.filter((x) => x.severity === 'warning').length : null,
      types,
    };
  } catch {
    return { file, kind: 'drc', date: null, violations: null, unconnected: null, footprintErrors: null, errors: null, warnings: null, types: {} };
  }
}

// ─── freshness ──────────────────────────────────────────────────────────────

/** Every date in a why line in ONE zone (records carry +10:00, +11:00 and Z). */
const day = (s: string) => {
  const t = Date.parse(s);
  return Number.isFinite(t) ? `${new Date(t).toISOString().slice(0, 16).replace('T', ' ')} UTC` : s;
};

/** null = fresh; otherwise the sentence that makes the gate PENDING. */
export function staleness(recorded: string | null, changed: DatedChange | null, what = 'board'): string | null {
  if (!recorded) return 'the record carries no date, so it cannot be shown to describe the current board';
  if (!changed) return `recorded ${day(recorded)}, but when the ${what} last changed is not known`;
  const r = Date.parse(recorded);
  const c = Date.parse(changed.date);
  if (!Number.isFinite(r) || !Number.isFinite(c)) return `recorded ${recorded}, ${what} changed ${changed.date}: a date could not be read`;
  return r >= c ? null : `stale: recorded ${day(recorded)}, ${what} changed ${day(changed.date)} (${changed.file}, ${changed.how === 'mtime' ? 'uncommitted edit' : 'commit'})`;
}

// ─── the gates ──────────────────────────────────────────────────────────────

const SIDE = { top: 'F', bottom: 'B' } as const;
const list = (xs: string[], n = 8) => (xs.length > n ? `${xs.slice(0, n).join(', ')} … (+${xs.length - n})` : xs.join(', '));

function g(id: string, name: string, state: PcbGate['state'], why: string, source: string, group: PcbGate['group'], guards?: string): PcbGate {
  return { id, name, state, why: `${why} — ${source}`, source, group, ...(guards ? { guards } : {}) };
}

export function pcbGates(i: PcbGateInput): PcbGate[] {
  if (!i.boardId) return [];
  const out: PcbGate[] = [];
  const snap = i.snapshot;
  const rec = snap && typeof snap !== 'string' ? snap.boards.find((b) => b.id === i.boardId) ?? null : null;

  // ── 0. the snapshot itself, tied to the live board by content ──
  let tied = false;
  if (snap === null) out.push(g('snapshot', 'Gate records', 'PENDING', 'reading the gate records', 'public/pcb-gates/index.json', 'snapshot'));
  else if (typeof snap === 'string') out.push(g('snapshot', 'Gate records', 'PENDING', snap, 'public/pcb-gates/index.json', 'snapshot'));
  else if (!rec)
    out.push(g('snapshot', 'Gate records', 'PENDING', `the snapshot of ${day(snap.generatedAt)} has no board "${i.boardId}" — run npm run pcb:gates`, 'public/pcb-gates/index.json', 'snapshot'));
  else if (!rec.board.sha256)
    out.push(g('snapshot', 'Gate records', 'PENDING', 'the board has no .kicad_pcb, so no record can be tied to it', `${rec.dir}/`, 'snapshot'));
  else if (!i.liveBoardSha)
    out.push(g('snapshot', 'Gate records', 'PENDING', 'the board file has not been read here yet, so the records cannot be tied to it', rec.board.kicadPcb ?? rec.dir, 'snapshot'));
  else if (i.liveBoardSha !== rec.board.sha256)
    out.push(
      g(
        'snapshot',
        'Gate records',
        'PENDING',
        `the board changed after the records were collected (${day(snap.generatedAt)}); every recorded gate below is PENDING until npm run pcb:gates is run again`,
        `${rec.board.kicadPcb} sha ${i.liveBoardSha.slice(0, 12)} ≠ snapshot ${rec.board.sha256.slice(0, 12)}`,
        'snapshot'
      )
    );
  else {
    tied = true;
    out.push(g('snapshot', 'Gate records', 'PASS', `collected ${day(snap.generatedAt)} from hardware/pcb; the board is byte-identical to what was collected`, `${rec.board.kicadPcb} sha ${i.liveBoardSha.slice(0, 12)}`, 'snapshot'));
  }

  // ── 1. derived from the fab files and the board's own BOM/CPL/footprints ──
  const files = new Set(rec?.fab.files ?? []);
  const has = (layer: string) => files.has(`${i.boardId}-${layer}.gbr`);
  const fabSrc = rec ? `derived: ${rec.fabDir}/ (files as collected ${snap && typeof snap !== 'string' ? day(snap.generatedAt) : ''})` : 'derived: fab/';
  if (!rec) {
    for (const [id, name] of [
      ['fab-top', 'Top layers for the top-side parts'],
      ['fab-bottom', 'Bottom layers for the bottom-side parts'],
      ['fab-outline', 'Outline and copper layer count'],
      ['fab-drill', 'Drill files'],
      ['fab-fresh', 'Fab set exported from this board'],
    ] as const)
      out.push(g(id, name, 'PENDING', 'no record of this board’s fab files', 'public/pcb-gates/index.json', 'fab'));
  } else {
    for (const side of ['top', 'bottom'] as const) {
      const L = SIDE[side];
      const id = side === 'top' ? 'fab-top' : 'fab-bottom';
      const name = side === 'top' ? 'Top layers for the top-side parts' : 'Bottom layers for the bottom-side parts';
      const guards = 'parts on a side with no copper or mask gerber: their pads are not made, or are made bare';
      if (!i.parts) {
        out.push(g(id, name, 'PENDING', 'the board’s parts are not read yet', fabSrc, 'fab', guards));
        continue;
      }
      const on = i.parts.parts.filter((p) => p.side === side);
      /* THT = the BOM tags it hand-tht, or (2026-10-16) the .kicad_pcb shows every
       * pad of its footprint is thru_hole — buck48's Mornsun DC/DC (U_DC) is a 6-pin
       * DIP the BOM tags only "HAND". A part with ANY smd pad stays SMD here. */
      const isTht = (p: (typeof on)[number]) => p.by === 'hand-tht' || p.allThroughHole === true;
      const smd = on.filter((p) => !isTht(p));
      const tht = on.filter(isTht);
      const missCuMask = [`${L}_Cu`, `${L}_Mask`].filter((l) => !has(l));
      const missSilk = [`${L}_Silkscreen`].filter((l) => !has(l));
      if (on.length === 0) {
        out.push(g(id, name, 'PASS', `no parts on the ${side}, so no ${side} layer is required by parts${missCuMask.length ? ` (${missCuMask.join(', ')} absent)` : ''}`, fabSrc, 'fab', guards));
      } else if (missCuMask.length && smd.length) {
        out.push(
          g(
            id,
            name,
            'FAIL',
            `${smd.length} part(s) on the ${side} that the BOM does not tag THT (${list(smd.map((p) => `${p.ref} ${p.by}`))}) and fab/ has no ${missCuMask.join(', ')} gerber — their pads have no ${side} copper`,
            fabSrc,
            'fab',
            guards
          )
        );
      } else if (missCuMask.length && side === 'top' && SINGLE_SIDED[i.boardId]) {
        out.push(
          g(
            id,
            name,
            'PASS',
            `no copper (single-sided board): ${tht.length} hand-fitted THT part(s) on the top (${list(tht.map((p) => p.ref))}), soldered from the bottom; no ${missCuMask.join(', ')} gerber by design — ${SINGLE_SIDED[i.boardId]}`,
            fabSrc,
            'fab',
            guards
          )
        );
      } else if (missCuMask.length) {
        out.push(
          g(
            id,
            name,
            'PENDING',
            `${tht.length} hand-fitted THT part(s) on the ${side} (${list(tht.map((p) => p.ref))}) and fab/ has no ${missCuMask.join(', ')} gerber${
              rec.fab.jobCopperLayers !== null ? `; the job file says ${rec.fab.jobCopperLayers} copper layer(s)` : ''
            }. A single-sided board with THT bodies on the bare side can be right (the leads solder on the other side), but nothing here can prove it — pcb’s call`,
            fabSrc,
            'fab',
            guards
          )
        );
      } else if (missSilk.length) {
        out.push(g(id, name, 'PENDING', `copper and mask present, but no ${missSilk.join(', ')} for the ${on.length} part(s) on the ${side}: no reference designators to assemble by`, fabSrc, 'fab', guards));
      } else {
        out.push(g(id, name, 'PASS', `${on.length} part(s) on the ${side}; ${L}_Cu, ${L}_Mask and ${L}_Silkscreen present`, fabSrc, 'fab', guards));
      }
    }
    // Outline + copper count against the job file.
    const copper = [...files].filter((f) => /-(F|B|In\d+)_Cu\.gbr$/.test(f));
    if (!has('Edge_Cuts')) out.push(g('fab-outline', 'Outline and copper layer count', 'FAIL', 'no Edge_Cuts gerber: the fab has no board outline', fabSrc, 'fab', 'a board cut to the wrong shape, or not cut'));
    else if (rec.fab.jobCopperLayers === null)
      out.push(g('fab-outline', 'Outline and copper layer count', 'PENDING', `Edge_Cuts present, ${copper.length} copper gerber(s); no job file to compare the count with`, fabSrc, 'fab'));
    else if (copper.length !== rec.fab.jobCopperLayers)
      out.push(
        g('fab-outline', 'Outline and copper layer count', 'FAIL', `${copper.length} copper gerber(s) but the job file says ${rec.fab.jobCopperLayers} layer(s)`, `${fabSrc}, ${i.boardId}-job.gbrjob`, 'fab', 'a stackup ordered with a layer missing or extra')
      );
    else out.push(g('fab-outline', 'Outline and copper layer count', 'PASS', `Edge_Cuts present; ${copper.length} copper gerber(s), as the job file says`, `${fabSrc}, ${i.boardId}-job.gbrjob`, 'fab'));
    // Drill.
    const drills = [...files].filter((f) => /\.drl$/i.test(f));
    out.push(
      drills.length
        ? g('fab-drill', 'Drill files', 'PASS', list(drills), fabSrc, 'fab')
        : g('fab-drill', 'Drill files', 'FAIL', 'no .drl in fab/: no holes, no vias', fabSrc, 'fab', 'a board with no holes for THT leads or vias')
    );
    // Fab set exported from THIS board (content, live).
    const fresh = 'gerbers exported from an older board: the fab makes a board that is not the design';
    if (!rec.fab.sourceSha) out.push(g('fab-fresh', 'Fab set exported from this board', 'PENDING', `no ${i.boardId}.source.sha in fab/, so the gerbers cannot be tied to a board`, fabSrc, 'fab', fresh));
    else if (!i.liveBoardSha)
      out.push(g('fab-fresh', 'Fab set exported from this board', 'PENDING', 'the board file has not been read here yet', `${rec.fabDir}/${i.boardId}.source.sha`, 'fab', fresh));
    else if (i.liveBoardSha !== rec.fab.sourceSha)
      out.push(
        g(
          'fab-fresh',
          'Fab set exported from this board',
          'FAIL',
          `fab/ was exported from board sha ${rec.fab.sourceSha.slice(0, 12)} (gerbers created ${rec.fab.gerberCreated ? day(rec.fab.gerberCreated) : '?'}); the board is now ${i.liveBoardSha.slice(0, 12)} — re-run export_fab.sh`,
          `${rec.fabDir}/${i.boardId}.source.sha`,
          'fab',
          fresh
        )
      );
    else
      out.push(
        g('fab-fresh', 'Fab set exported from this board', 'PASS', `source.sha matches the board${rec.fab.gerberCreated ? `; gerbers created ${day(rec.fab.gerberCreated)}` : ''}`, `${rec.fabDir}/${i.boardId}.source.sha`, 'fab', fresh)
      );
  }
  // CPL rows for every machine part; BOM rows for every part — live, from the loaded files.
  if (!i.parts) {
    out.push(g('fab-cpl', 'CPL row for every machine part', 'PENDING', 'the BOM and CPL are not read yet', 'derived: fab/*-cpl.csv', 'fab'));
    out.push(g('fab-bom', 'BOM row for every part', 'PENDING', 'the BOM and CPL are not read yet', 'derived: fab/*-bom.csv', 'fab'));
  } else {
    const machine = [...i.parts.parts.filter((p) => p.by === 'machine'), ...i.parts.unplaced.filter((p) => p.by === 'machine').map((p) => ({ ...p, from: 'none' as const }))];
    const cpl = new Set(i.cplRefs);
    const noRow = machine.filter((p) => !cpl.has(p.ref)).map((p) => p.ref);
    out.push(
      noRow.length
        ? g('fab-cpl', 'CPL row for every machine part', 'FAIL', `${noRow.length} machine part(s) have no CPL row: ${list(noRow)}`, 'derived: fab/*-cpl.csv vs *-bom.csv', 'fab', 'a machine part the pick-and-place never places')
        : g('fab-cpl', 'CPL row for every machine part', 'PASS', machine.length ? `all ${machine.length} machine part(s) have a CPL row` : 'no machine-placed parts on this board', 'derived: fab/*-cpl.csv vs *-bom.csv', 'fab')
    );
    const bom = new Set(i.bomRefs);
    const cplNoBom = i.cplRefs.filter((r) => !bom.has(r));
    const fpNoBom = i.footprintRefs.filter((r) => !bom.has(r) && !cpl.has(r));
    const note = fpNoBom.length ? `; ${fpNoBom.length} footprint(s) on the board are in neither (fiducials, test points, holes?): ${list(fpNoBom)} — not judged here` : '';
    out.push(
      cplNoBom.length
        ? g('fab-bom', 'BOM row for every part', 'FAIL', `${cplNoBom.length} CPL part(s) have no BOM row: ${list(cplNoBom)}${note}`, 'derived: fab/*-bom.csv vs *-cpl.csv, .kicad_pcb', 'fab', 'a part placed with no part number to buy')
        : g('fab-bom', 'BOM row for every part', 'PASS', `every one of ${i.cplRefs.length} CPL part(s) has a BOM row (${i.bomRefs.length} BOM refs)${note}`, 'derived: fab/*-bom.csv vs *-cpl.csv, .kicad_pcb', 'fab')
    );
  }
  if (rec) {
    const notes = rec.fab.files.find((f) => f === `${i.boardId}-assembly-notes.md`);
    out.push(
      notes
        ? g('fab-notes', 'Assembly notes', 'PASS', 'present', `${rec.fabDir}/${notes}`, 'fab')
        : g('fab-notes', 'Assembly notes', 'PENDING', 'no assembly notes in fab/; whether this board needs them is pcb’s G21–G24', fabSrc, 'fab')
    );
    // The order hold pcb's G63/G64 read.
    const stop = rec.fab.doNotOrder;
    out.push(
      stop.length
        ? g('order-hold', 'No order hold', 'FAIL', `pcb holds this fab set: “${stop[0].title}”`, `${rec.fabDir}/${stop.map((s) => s.file).join(', ')}`, 'fab', 'ordering a board pcb has stopped')
        : g('order-hold', 'No order hold', 'PASS', `no _DO-NOT-ORDER*.md in fab/${rec.fab.ordered ? `; ${rec.fab.ordered.file}: “${rec.fab.ordered.title}”` : ''}`, `${rec.fabDir}/`, 'fab')
    );
  }

  // ── 2. recorded reports (ERC, DRC, verifiers) ──
  const gated = (fresh: string | null): string | null => (tied ? fresh : 'the records are not tied to the current board (see "Gate records")');
  if (rec) {
    const newest = (rs: RptRecord[]) => [...rs].sort((a, b) => Date.parse(b.date ?? '') - Date.parse(a.date ?? '') || 0)[0];
    const erc = newest(rec.erc);
    if (!erc) out.push(g('erc', 'ERC (schematic)', 'PENDING', 'no ERC report on disk for this board', `${rec.dir}/${i.boardId}-erc.rpt (absent)`, 'record'));
    else {
      const src = `${erc.file}${erc.date ? ` (${day(erc.date)})` : ''}`;
      const st = gated(staleness(erc.date, rec.board.schChanged, 'schematic'));
      if (st) out.push(g('erc', 'ERC (schematic)', 'PENDING', st, src, 'record'));
      else if (erc.errors === null) out.push(g('erc', 'ERC (schematic)', 'PENDING', 'the report’s totals line could not be read', src, 'record'));
      else
        out.push(
          g('erc', 'ERC (schematic)', erc.errors === 0 ? 'PASS' : 'FAIL', `${erc.errors} error(s), ${erc.warnings ?? '?'} warning(s)${typeList(erc.types)}`, src, 'record', 'a wiring error in the schematic built into copper')
        );
    }
    const drc = newest(rec.drc);
    if (!drc) out.push(g('drc', 'DRC (board)', 'PENDING', 'no DRC report on disk for this board', `${rec.dir}/ (no *-drc*.rpt / drc json)`, 'record'));
    else {
      const adj = rec.adjudications.length ? `; pcb’s adjudication: ${rec.adjudications.join(', ')}` : '';
      const src = `${drc.file}${drc.date ? ` (${day(drc.date)})` : ''}`;
      const st = gated(staleness(drc.date, rec.board.pcbChanged));
      if (st) out.push(g('drc', 'DRC (board)', 'PENDING', st, src, 'record'));
      else if (drc.violations === null) out.push(g('drc', 'DRC (board)', 'PENDING', 'the report’s totals could not be read', src, 'record'));
      else {
        const bad = (drc.errors ?? 0) > 0 || (drc.unconnected ?? 0) > 0;
        out.push(
          g(
            'drc',
            'DRC (board)',
            bad ? 'FAIL' : 'PASS',
            `${drc.violations} violation(s) (${drc.errors ?? '?'} error, ${drc.warnings ?? '?'} warning), ${drc.unconnected ?? '?'} unconnected${typeList(drc.types)}${adj}`,
            src,
            'record',
            'a short, an open or a feature the fab cannot make'
          )
        );
      }
    }
    for (const v of rec.verifiers)
      out.push(
        g(
          `verify-${v.split('/').pop()}`,
          `Verifier ${v.split('/').pop()}`,
          'PENDING',
          `the verifier exists but its result is not recorded on disk (not run from the browser)${rec.matrix?.rows['2a'] ? '; the matrix row G2a below is its recorded run' : ''}`,
          v,
          'record'
        )
      );
  }

  // ── 3. the fleet gate matrix row (gate_check.py's own results) ──
  if (rec?.matrix && snap && typeof snap !== 'string') {
    const m = rec.matrix;
    const ids = [...snap.order.filter((k) => k in m.rows), ...Object.keys(m.rows).filter((k) => !snap.order.includes(k))];
    const rowFresh: string | null = !m.generatorSha
      ? `this row carries no _generator_sha, so it cannot be tied to today’s board (matrix file last committed ${m.committed ? day(m.committed) : '?'}; the row may be much older)`
      : !rec.board.generatorSha
        ? `the row is stamped with generator sha ${m.generatorSha.slice(0, 12)}, but ${rec.board.generator ?? `pcb_${i.boardId}.py`} was not found`
        : m.generatorSha !== rec.board.generatorSha
          ? `stale: recorded against ${rec.board.generator} sha ${m.generatorSha.slice(0, 12)}, the generator is now ${rec.board.generatorSha.slice(0, 12)}${
              rec.board.pcbChanged ? ` (board changed ${day(rec.board.pcbChanged.date)})` : ''
            }`
          : null;
    const st = gated(rowFresh);
    for (const id of ids) {
      const row = m.rows[id];
      const name = snap.gateNames[id] ?? `G${id}`;
      const src = `${m.file} [${i.boardId}][${id}]${m.committed ? ` (file committed ${day(m.committed)})` : ''}`;
      const status = String(row?.status ?? '').toUpperCase();
      const detail = String(row?.detail ?? '').slice(0, 400);
      const state: PcbGate['state'] = st ? 'PENDING' : status === 'PASS' ? 'PASS' : status === 'FAIL' ? 'FAIL' : 'PENDING';
      const why = st
        ? `${st} — recorded ${status || '?'}: ${detail}`
        : status === 'PASS' || status === 'FAIL'
          ? detail
          : status === 'WARN'
            ? `recorded WARN (advisory — a person must judge it): ${detail}`
            : status === 'SKIP'
              ? `recorded SKIP (not checked): ${detail}`
              : `recorded status "${status}" is not one this tab reads: ${detail}`;
      out.push(g(`m-${id}`, name, state, why, src, 'matrix', snap.guards[id]));
    }
  } else if (rec) {
    out.push(g('matrix', 'gate_check.py results', 'PENDING', 'no row for this board in the fleet gate matrix: gate_check.py’s results are not recorded on disk for it', 'hardware/pcb/docs/fleet-gate-matrix-*.json', 'matrix'));
  }
  // A PASS read from the snapshot's FILE LIST is only as good as the snapshot:
  // untied, it is downgraded (FAILs stay — over-block). fab-cpl/fab-bom are read
  // live from the loaded BOM/CPL and are not touched.
  if (!tied)
    for (const x of out)
      if (x.state === 'PASS' && SNAPSHOT_DERIVED.has(x.id))
        Object.assign(x, { state: 'PENDING' as const, why: `${x.why} · not tied: the snapshot this was read from does not match the current board` });
  return out;
}

const SNAPSHOT_DERIVED = new Set(['fab-top', 'fab-bottom', 'fab-outline', 'fab-drill', 'fab-fresh', 'fab-notes', 'order-hold']);

function typeList(t: Record<string, number>): string {
  const e = Object.entries(t).sort((a, b) => b[1] - a[1]);
  return e.length ? ` · ${e.slice(0, 5).map(([k, n]) => `${k}×${n}`).join(', ')}${e.length > 5 ? ', …' : ''}` : '';
}

/** "4 failing, 12 pending, 30 pass" — for the AI's context and the header. */
export function gateTally(gs: readonly PcbGate[]): { pass: number; fail: number; pending: number } {
  return {
    pass: gs.filter((x) => x.state === 'PASS').length,
    fail: gs.filter((x) => x.state === 'FAIL').length,
    pending: gs.filter((x) => x.state === 'PENDING').length,
  };
}
