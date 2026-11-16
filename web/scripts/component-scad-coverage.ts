// component-scad-coverage — does every part on our boards have an OpenSCAD model in `cad`'s tree?
//
//   node --import ./tests/register.mjs scripts/component-scad-coverage.ts [--json out.json] [--md]
//
// Founder 2026-10-16: *"check on all component's scad file, we have to have all for pcb and pnp"*.
// Audit doc: software/2bee.app/docs/audit/2026-10-16-component-scad-coverage.md
//
// READ-ONLY on hardware/. Everything it reads is `pcb`'s or `cad`'s, in place:
//   · POPULATION — every board dir under hardware/pcb/ with BOTH fab/**/<id>-bom.csv and
//     <id>-cpl.csv (the same rule the PnP tab uses, src/pnp/boards.ts). Classed by marker file:
//     _SUPERSEDED.md → superseded (reported, never counted as a gap) · _DEFERRED.md → deferred ·
//     pnp_* → pnp-wip · otherwise live. pnp_* boards carry NO fab BOM/CPL today, so their parts
//     come from the footprints of their .kicad_pcb instead (value + footprint), reported as a
//     SEPARATE population — they are not BOM parts and must not be read as such.
//   · PARTS are grouped by unique part: Mfr_PN, or value|package when the BOM row has none.
//   · MODELS — every .scad under hardware/cad/ except export/, stl/ and the generated
//     *_pcb_sync.scad data files (those are position arrays, not models). A candidate is a
//     `module` whose name carries an alphanumeric part token found in the part's MPN/value, or a
//     lib/ (or connectors/cables/ref_models) file whose HEADER names a token that prefixes the
//     MPN. A candidate is never a verdict: REVIEWED below holds the verdicts a human checked
//     against the file. A candidate nobody has reviewed is UNSURE, never HAS.
//   · CONTEXT (not the question): the .kicad_pcb `(model …)` per ref — KiCad library body,
//     pcb's common/3dmodels/box_*.step stand-in, other, or none — and whether the ref has a
//     courtyard box in cad's <id>_pcb_sync.scad.
//
// Exit: 0 report produced (gaps are the finding, not a failure) · 2 could not run, INCLUDING an
// empty population (zero boards or zero parts in the live class) — an empty census is not a pass.

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv } from '../src/pnp/manifest';
import { parseKicadFootprints } from '../src/pnp/parts';

const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
// COVERAGE_PCB_ROOT exists for ONE purpose: the negative control (point it at an empty dir and the
// run must exit 2, never print a clean table). Do not use it to scope a real audit.
const PCB = process.env.COVERAGE_PCB_ROOT || join(REPO, 'hardware/pcb');
const CAD = join(REPO, 'hardware/cad');

type Cls = 'HAS' | 'PARTIAL' | 'MISSING' | 'UNSURE';
type BoardClass = 'live' | 'pnp-wip' | 'deferred' | 'superseded';

// ── REVIEWED verdicts. Each was checked by reading the cited file (2026-10-16, 2bee_app). ────────
// A key is the part key (Mfr_PN, or value|package). `none` = the candidate was read and is NOT a
// model of this part (kept so the auto-candidate does not reappear as UNSURE).
const REVIEWED: Record<string, { cls: Cls; at?: string; note: string }> = {
  'ESP32-S3-WROOM-1U-N8R8': {
    cls: 'PARTIAL',
    at: 'hardware/cad/lib/components/esp32_s3.scad:esp32_s3',
    note: 'models ESP32-S3-WROOM-1 (PCB antenna, 18x25.5; variants wroom1/n16/n8r2). The -1U is 18x19.2x3.2 with u.FL (hardware/datasheets/espressif_esp32-s3-wroom-1_datasheet.pdf.md:3144-3161) and is not a variant',
  },
  'ESP32-S3-WROOM-1U-N16R8': {
    cls: 'PARTIAL',
    at: 'hardware/cad/lib/components/esp32_s3.scad:esp32_s3',
    note: 'same as N8R8: the WROOM-1 model (18x25.5), not the -1U outline (18x19.2)',
  },
  INA219AIDR: {
    cls: 'MISSING',
    note: 'candidate lib/components/ina219_gy219.scad:ina219_gy219 is the GY-219 BREAKOUT board, not the bare SOIC-8 chip',
  },
  INA226AIDGSR: { cls: 'MISSING', note: 'only an INA219 breakout exists (ina219_gy219.scad); no INA226 / VSSOP-10 model' },
  RV1106G3: {
    cls: 'MISSING',
    note: 'RV1106 is named only inside luckfox_pico_zero.scad (the whole Luckfox board) and imx219_camera.scad; no bare QFN-128 model',
  },
  '43045-1413': {
    cls: 'MISSING',
    note: 'nearest is a private viz cube _microfit_header in 2bee_autoframe_controller/controller_pcb.scad sized for a 3-ckt header (11.5x5x8.6), not 2x7',
  },
  '43045-1213': {
    cls: 'MISSING',
    note: 'nearest is the private 3-ckt viz cube _microfit_header (controller_pcb.scad), not 2x6',
  },
  '2.54mm 2*20P': {
    cls: 'UNSURE',
    at: 'hardware/cad/lib/components/luckfox_pico_zero.scad:lpz_board',
    note: 'the 2x20 header PIN geometry is drawn inside the Luckfox board model (lpz_hdr_*), not as a standalone header module; whether that counts for the carrier-side header is a cad call',
  },
  '2.54-2*20': {
    cls: 'MISSING',
    note: 'female 2x20 socket: luckfox_pico_zero.scad says its STEP "contains no female socket/carrier" (lpz_hdr_h note)',
  },
  'B2B-XH-A(LF)(SN)': { cls: 'MISSING', note: 'only 2bee_cables.scad:_jst_xh5 exists, a 5-pin CABLE plug cube, not a board header' },
  'B3B-XH-A(LF)(SN)': { cls: 'MISSING', note: 'only 2bee_cables.scad:_jst_xh5 exists, a 5-pin CABLE plug cube, not a board header' },
  'S2B-XH-A-1(LF)(SN)': { cls: 'MISSING', note: 'only 2bee_cables.scad:_jst_xh5 exists, a 5-pin CABLE plug cube, not a board header' },
  'USB-231-ARY': {
    cls: 'MISSING',
    note: 'lib/components/usb_a_panel_dtype.scad is a B1007 D-type PANEL feed-through, a different part from this PCB USB-A receptacle',
  },
  'DS1133-S60BPX': { cls: 'MISSING', note: 'hbs57_driver.scad draws the driver-side RJ12; no board-side 6P6C jack model' },
  BME280: {
    cls: 'MISSING',
    note: 'candidate lib/honey_tank_sensor.scad names a BME280 BREAKOUT pcb inside the honey-tank sensor assembly, not the LGA-8 2.5x2.5x0.93 chip',
  },
  'KF301-5.0-2P': {
    cls: 'MISSING',
    note: 'candidate lib/components/ina219_gy219.scad draws a KF301/KF350 terminal INLINE on the breakout (3.5 mm pitch per its own comment); no standalone 5.0 mm KF301 module',
  },
  // value-keyed (boards whose population comes from a .kicad_pcb, or BOM rows with no Mfr_PN)
  'ESP32-S3-WROOM-1U': {
    cls: 'PARTIAL',
    at: 'hardware/cad/lib/components/esp32_s3.scad:esp32_s3',
    note: 'the WROOM-1 model (18x25.5), not the -1U outline (18x19.2, u.FL)',
  },
  'ESP32-C3-MINI-1': { cls: 'MISSING', note: 'esp32_s3.scad models the S3-WROOM-1 only; no C3-MINI-1 (13.2x16.6) model' },
  'ESP32-C3-MINI-1-N4': { cls: 'MISSING', note: 'esp32_s3.scad models the S3-WROOM-1 only; no C3-MINI-1 (13.2x16.6) model' },
  'ESP32-S3-MINI-1-N8': { cls: 'MISSING', note: 'esp32_s3.scad models the S3-WROOM-1 only; no S3-MINI-1 model' },
  'ICS-43434': {
    cls: 'HAS',
    at: 'hardware/cad/lib/components/ics43434_mic.scad:ics43434_mic',
    note: 'chip-level LGA-6 3.5x2.65 model; footprint sourced from the BOM, body height 0.98 and port flagged PROV in its own header',
  },
};

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const walk = (dir: string, out: string[] = []): string[] => {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (n === 'node_modules' || n === '.git') continue;
      walk(p, out);
    } else out.push(p);
  }
  return out;
};
const rel = (p: string) => relative(REPO, p);

// ── models: the .scad corpus ────────────────────────────────────────────────────────────────────
interface ScadFile {
  path: string;
  modules: string[];
  header: string;
  libLike: boolean;
}
const scadFiles: ScadFile[] = walk(CAD)
  .filter((p) => p.endsWith('.scad'))
  .filter((p) => !/\/hardware\/cad\/(export|stl)\//.test(p))
  .filter((p) => !p.endsWith('_pcb_sync.scad'))
  .map((p) => {
    const t = readFileSync(p, 'utf8');
    const r = rel(p);
    return {
      path: r,
      modules: [...t.matchAll(/^\s*module\s+([A-Za-z0-9_]+)/gm)].map((m) => m[1]),
      header: t.split('\n').slice(0, 60).join('\n'),
      libLike: /^hardware\/cad\/(lib\/|ref_models\/|vendor_models\/|2bee_connectors\.scad|2bee_cables\.scad)/.test(r),
    };
  });
const moduleCount = scadFiles.reduce((a, f) => a + f.modules.length, 0);

// part-number-like token: letters then digits (then anything), >= 5 chars, e.g. ina219, esp32, rv1106
const pnTokens = (s: string) => [...s.toLowerCase().matchAll(/[a-z]+[0-9][a-z0-9]*/g)].map((m) => m[0]).filter((t) => t.length >= 5);

// ── cad's MPN INDEX (cad ticket 2026-10-16-10-20-30): each lib/components/*.scad carries
// `// MPN: a, b c` header lines (tokens split on spaces and commas; surrounding quotes/brackets stripped, so `"LG Q976…"` and `(BOM string: SC-20S,…)` read) (continuation lines start `//` + 2 or more spaces) naming every
// MPN that file serves. A part whose MPN is DECLARED there by cad is HAS — cad's own claim, with
// its SOURCED/PROV marks in the file — and is checked before REVIEWED (those verdicts predate
// the index). Matching: whitespace removed, case ignored, whole token (or 2-4 adjacent tokens
// joined with nothing or a comma, for an MPN that contains spaces or commas) — never a substring, so 0402WGF1000TCE cannot match
// inside a longer code.
/** Strip quotes, and a bracket only when it is UNBALANCED — `(BOM` and `12.5pF)` lose theirs,
 *  `B2B-XH-A(LF)(SN)` keeps its own. */
const cleanTok = (t: string): string => {
  let x = t.replace(/^["']+|["']+$/g, '');
  const opens = (x.match(/\(/g) ?? []).length;
  const closes = (x.match(/\)/g) ?? []).length;
  if (opens > closes) x = x.replace(/^\(/, '');
  if (closes > opens) x = x.replace(/\)$/, '');
  return x;
};
const mpnIndex = new Map<string, string>();
{
  const dir = join(CAD, 'lib/components');
  for (const f of existsSync(dir) ? readdirSync(dir).filter((x) => x.endsWith('.scad')).sort() : []) {
    const lines = readFileSync(join(dir, f), 'utf8').split('\n');
    const toks: string[] = [];
    let inBlock = false;
    for (const l of lines) {
      const m = /^\/\/\s*MPN:\s*(.*)$/.exec(l);
      if (m) {
        inBlock = true;
        toks.push(...m[1].split(/[\s,]+/).map(cleanTok).filter(Boolean));
      } else if (inBlock && /^\/\/ {2,}\S/.test(l)) {
        toks.push(...l.replace(/^\/\//, '').split(/[\s,]+/).map(cleanTok).filter(Boolean));
      } else inBlock = false;
    }
    const at = `hardware/cad/lib/components/${f}`;
    for (let i = 0; i < toks.length; i++) {
      for (let n = 1; n <= 4 && i + n <= toks.length; n++) {
        for (const sep of ['', ',']) {
          const key = toks.slice(i, i + n).join(sep).toLowerCase();
          if (!mpnIndex.has(key)) mpnIndex.set(key, at);
        }
      }
    }
  }
}
const indexed = (mpn: string): string | undefined => (mpn ? mpnIndex.get(mpn.replace(/\s+/g, '').toLowerCase()) : undefined);

function candidates(mpn: string, value: string): string[] {
  const keys = [norm(mpn), norm(value)].filter((k) => k.length >= 5);
  if (!keys.length) return [];
  const out = new Set<string>();
  for (const f of scadFiles) {
    for (const m of f.modules) {
      for (const tok of m.toLowerCase().split('_')) {
        if (tok.length >= 5 && /[a-z]/.test(tok) && /[0-9]/.test(tok) && keys.some((k) => k.startsWith(tok))) out.add(`${f.path}:${m}`);
      }
    }
    if (f.libLike) {
      for (const tok of pnTokens(f.header)) {
        if (keys.some((k) => k.startsWith(tok))) out.add(`${f.path} (header names "${tok}")`);
      }
    }
  }
  return [...out].sort();
}

// ── population ──────────────────────────────────────────────────────────────────────────────────
interface Board {
  id: string;
  dir: string;
  cls: BoardClass;
  bom?: string;
  cpl?: string;
  kicad?: string;
  source: 'fab-bom' | 'kicad_pcb';
}

function classOf(dir: string): BoardClass {
  const d = join(PCB, dir);
  if (existsSync(join(d, '_SUPERSEDED.md'))) return 'superseded';
  if (existsSync(join(d, '_DEFERRED.md'))) return 'deferred';
  if (dir.startsWith('pnp_')) return 'pnp-wip';
  return 'live';
}

const boards: Board[] = [];
for (const dir of readdirSync(PCB).sort()) {
  const d = join(PCB, dir);
  if (!statSync(d).isDirectory()) continue;
  const fab = join(d, 'fab');
  const boms = existsSync(fab) ? walk(fab).filter((p) => p.endsWith('-bom.csv')) : [];
  let added = false;
  for (const bom of boms.sort()) {
    const id = /([^/]+)-bom\.csv$/.exec(bom)![1];
    const cpl = bom.replace(/-bom\.csv$/, '-cpl.csv');
    if (!existsSync(cpl)) continue;
    const kicad = join(d, `${id}.kicad_pcb`);
    boards.push({ id, dir, cls: classOf(dir), bom, cpl, kicad: existsSync(kicad) ? kicad : undefined, source: 'fab-bom' });
    added = true;
  }
  // pnp_* boards have no fab BOM/CPL: take their parts from the board file, as a separate population.
  if (!added && dir.startsWith('pnp_')) {
    for (const k of readdirSync(d).filter((n) => n.endsWith('.kicad_pcb')).sort()) {
      boards.push({ id: k.replace(/\.kicad_pcb$/, ''), dir, cls: classOf(dir), kicad: join(d, k), source: 'kicad_pcb' });
    }
  }
}

// cad's generated sync data, by board id
const syncFiles = new Map<string, string>();
for (const p of walk(CAD).filter((p) => p.endsWith('_pcb_sync.scad') && !/\/hardware\/cad\/(export|stl)\//.test(p))) {
  syncFiles.set(/([^/]+)_pcb_sync\.scad$/.exec(p)![1], p);
}

type ModelKind = 'kicad-lib' | 'box-step' | 'other' | 'none' | 'no-board-file';
function modelKind(paths: string[]): ModelKind {
  if (!paths.length) return 'none';
  if (paths.some((p) => /common\/3dmodels\/box_/.test(p))) return 'box-step';
  if (paths.some((p) => /\$\{KICAD\d*_3DMODEL_DIR\}/.test(p))) return 'kicad-lib';
  return 'other';
}

// Not a component: nothing is placed and nothing has a body to model (holes, fiducials, test pads,
// Tag-Connect TC2030 pads, logos). Excluded from BOTH populations and counted, never silently.
const NON_PART_FP = /Mounting.?Hole|Fiducial|Test.?point|TC2030|Logo|Symbol|NetTie|mouse.?bite|V-?Score/i;
const excluded: { board: string; ref: string; what: string }[] = [];

interface PartAgg {
  key: string;
  mpn: string;
  value: string;
  pkg: string;
  mfr: string;
  boards: Set<string>;
  refs: number;
  dnpOnly: boolean;
  models: Set<ModelKind>;
  syncBox: Set<string>; // 'yes' | 'no' | 'no-sync-file'
}
const byClass = new Map<BoardClass, Map<string, PartAgg>>();
const boardRows: { board: Board; rows: number; refs: number; unique: number }[] = [];

for (const b of boards) {
  const agg = byClass.get(b.cls) ?? new Map<string, PartAgg>();
  byClass.set(b.cls, agg);
  let fps: ReturnType<typeof parseKicadFootprints> = [];
  let kicadText = '';
  if (b.kicad) {
    kicadText = readFileSync(b.kicad, 'utf8');
    fps = parseKicadFootprints(kicadText);
  }
  const fpByRef = new Map(fps.map((f) => [f.ref, f]));
  const sync = syncFiles.get(b.id);
  const syncText = sync ? readFileSync(sync, 'utf8') : '';
  const boxOf = (ref: string) => (!sync ? 'no-sync-file' : syncText.includes(`["${ref}",`) ? 'yes' : 'no');
  const kindOf = (ref: string): ModelKind => (!b.kicad ? 'no-board-file' : modelKind(fpByRef.get(ref)?.models.map((m) => m.path) ?? []));

  const add = (key: string, mpn: string, value: string, pkg: string, mfr: string, refs: string[], dnp: boolean) => {
    const a =
      agg.get(key) ??
      ({ key, mpn, value, pkg, mfr, boards: new Set(), refs: 0, dnpOnly: true, models: new Set(), syncBox: new Set() } as PartAgg);
    a.boards.add(b.id);
    a.refs += refs.length;
    a.dnpOnly = a.dnpOnly && dnp;
    for (const r of refs) {
      a.models.add(kindOf(r));
      a.syncBox.add(boxOf(r));
    }
    agg.set(key, a);
  };

  if (b.source === 'fab-bom') {
    const rows = parseCsv(readFileSync(b.bom!, 'utf8'));
    const keys = new Set<string>();
    let refs = 0;
    for (const r of rows) {
      const mpn = (r.Mfr_PN ?? '').trim();
      const value = (r.Value ?? '').trim();
      const pkg = (r.Package ?? '').trim();
      const key = mpn || `${value}|${pkg}`;
      const rr = (r.Reference ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      if (NON_PART_FP.test(pkg)) {
        for (const ref of rr) excluded.push({ board: b.id, ref, what: pkg });
        continue;
      }
      refs += rr.length;
      keys.add(key);
      add(key, mpn, value, pkg, (r.Manufacturer ?? '').trim(), rr, (r.DNP ?? '').trim() !== '');
    }
    boardRows.push({ board: b, rows: rows.length, refs, unique: keys.size });
  } else {
    // value per ref from the board file (KiCad 6+ property, or older fp_text value)
    const blocks = kicadText.split(/\n[ \t]*\(footprint "/).slice(1);
    const valueOf = new Map<string, string>();
    for (const blk of blocks) {
      const ref = /\(property "Reference" "([^"]*)"|\(fp_text reference "([^"]*)"/.exec(blk);
      const val = /\(property "Value" "([^"]*)"|\(fp_text value "([^"]*)"/.exec(blk);
      if (ref) valueOf.set(ref[1] ?? ref[2], (val?.[1] ?? val?.[2] ?? '').trim());
    }
    const keys = new Set<string>();
    let refs = 0;
    const groups = new Map<string, { value: string; fp: string; refs: string[] }>();
    for (const f of fps) {
      const onlyHoles = f.pads.tht === 0 && f.pads.smd === 0;
      if (NON_PART_FP.test(f.footprint) || f.footprint === '' || onlyHoles) {
        excluded.push({ board: b.id, ref: f.ref, what: f.footprint || '(empty footprint, no plated pads)' });
        continue;
      }
      const value = valueOf.get(f.ref) ?? '';
      const fp = f.footprint.replace(/^[^:]*:/, '');
      // A connector's KiCad value is often its SIGNAL LABEL ("SHLD P01/F0", "12V IN"), one per
      // instance — the part is the footprint. Group J* refs by footprint alone.
      const key = /^J/.test(f.ref) ? `(connector)|${fp}` : `${value}|${fp}`;
      const g = groups.get(key) ?? { value: /^J/.test(f.ref) ? '(connector)' : value, fp, refs: [] };
      g.refs.push(f.ref);
      groups.set(key, g);
    }
    for (const [key, g] of groups) {
      refs += g.refs.length;
      keys.add(key);
      add(key, '', g.value, g.fp, '', g.refs, false);
    }
    boardRows.push({ board: b, rows: groups.size, refs, unique: keys.size });
  }
}

// ── classify ────────────────────────────────────────────────────────────────────────────────────
interface Verdict extends PartAgg {
  cls: Cls;
  at: string;
  note: string;
  cands: string[];
}
const verdicts = new Map<BoardClass, Verdict[]>();
for (const [cls, agg] of byClass) {
  const out: Verdict[] = [];
  for (const a of agg.values()) {
    const cands = candidates(a.mpn, a.value);
    const rv = REVIEWED[a.key] ?? (a.mpn ? undefined : REVIEWED[a.value]);
    const ix = indexed(a.mpn);
    let v: Cls, at = '', note = '';
    if (ix) {
      v = 'HAS';
      at = ix;
      note = "declared in cad's // MPN: index (dimensions SOURCED or PROV_ per the file)";
    } else if (rv) {
      v = rv.cls;
      at = rv.at ?? '';
      note = rv.note;
    } else if (cands.length) {
      v = 'UNSURE';
      at = cands.join(' ; ');
      note = 'auto-candidate, not reviewed';
    } else v = 'MISSING';
    out.push({ ...a, cls: v, at, note, cands });
  }
  out.sort((x, y) => y.boards.size - x.boards.size || x.key.localeCompare(y.key));
  verdicts.set(cls, out);
}

// ── report ──────────────────────────────────────────────────────────────────────────────────────
const ORDER: BoardClass[] = ['live', 'pnp-wip', 'deferred', 'superseded'];
const live = boardRows.filter((r) => r.board.cls === 'live');
console.log(`component-scad-coverage · repo ${REPO}`);
console.log(`cad MPN index: ${mpnIndex.size} keys from hardware/cad/lib/components/*.scad // MPN: headers`);
console.log(`models: ${scadFiles.length} .scad files (excl. export/, stl/, *_pcb_sync.scad), ${moduleCount} modules; ${syncFiles.size} *_pcb_sync.scad`);
console.log('\nPOPULATION');
for (const c of ORDER) {
  const rs = boardRows.filter((r) => r.board.cls === c);
  const uniq = verdicts.get(c)?.length ?? 0;
  console.log(`  ${c.padEnd(10)} boards ${String(rs.length).padStart(2)} · refs ${String(rs.reduce((a, r) => a + r.refs, 0)).padStart(4)} · unique parts ${String(uniq).padStart(3)}`);
  for (const r of rs) console.log(`      ${r.board.id.padEnd(26)} ${r.board.source.padEnd(9)} rows ${String(r.rows).padStart(3)} refs ${String(r.refs).padStart(3)} unique ${String(r.unique).padStart(3)}  ${rel(r.board.bom ?? r.board.kicad!)}`);
}
console.log(`  excluded as non-components (no body to model): ${excluded.length} refs — ${[...new Set(excluded.map((e) => e.what))].sort().join(' · ')}`);
if (!boards.length || !live.length || !(verdicts.get('live')?.length ?? 0)) {
  console.error('\nINCOMPLETE: empty population (no boards, no live boards, or no live parts) — not a pass');
  process.exit(2);
}
console.log('\nCOVERAGE (unique parts per class)');
for (const c of ORDER) {
  const vs = verdicts.get(c) ?? [];
  const n = (k: Cls) => vs.filter((v) => v.cls === k).length;
  const mk = (k: ModelKind) => vs.filter((v) => v.models.has(k)).length;
  console.log(
    `  ${c.padEnd(10)} HAS ${n('HAS')} · PARTIAL ${n('PARTIAL')} · MISSING ${n('MISSING')} · UNSURE ${n('UNSURE')}  of ${vs.length}` +
      `   | kicad 3D: lib ${mk('kicad-lib')} · box_*.step ${mk('box-step')} · other ${mk('other')} · none ${mk('none')} · no board file ${mk('no-board-file')}`
  );
}
console.log('\nNON-MISSING');
for (const c of ORDER)
  for (const v of verdicts.get(c) ?? []) if (v.cls !== 'MISSING') console.log(`  [${c}] ${v.cls.padEnd(7)} ${v.key} — ${v.at} — ${v.note}`);

const argv = process.argv.slice(2);
const ji = argv.indexOf('--json');
if (ji >= 0) {
  const path = argv[ji + 1];
  if (!path) {
    console.error('--json needs a path');
    process.exit(2);
  }
  const ser = Object.fromEntries(
    [...verdicts].map(([c, vs]) => [c, vs.map((v) => ({ ...v, boards: [...v.boards], models: [...v.models], syncBox: [...v.syncBox] }))])
  );
  writeFileSync(path, JSON.stringify({ boards: boardRows.map((r) => ({ ...r.board, rows: r.rows, refs: r.refs, unique: r.unique })), verdicts: ser }, null, 1));
}
if (argv.includes('--md')) {
  for (const c of ORDER) {
    console.log(`\n### ${c}\n\n| # | Part (Mfr_PN or value\\|package) | Value | Package | Boards | Refs | SCAD | Where / why | KiCad 3D | pcb_sync box |\n|---|---|---|---|---|---|---|---|---|---|`);
    (verdicts.get(c) ?? []).forEach((v, i) => {
      const esc = (s: string) => s.replace(/\|/g, '\\|');
      console.log(
        `| ${i + 1} | ${esc(v.key)}${v.dnpOnly ? ' (DNP)' : ''} | ${esc(v.value)} | ${esc(v.pkg)} | ${[...v.boards].join(', ')} | ${v.refs} | ${v.cls} | ${esc([v.at, v.note].filter(Boolean).join(' — '))} | ${[...v.models].join(', ')} | ${[...v.syncBox].join(', ')} |`
      );
    });
  }
}

