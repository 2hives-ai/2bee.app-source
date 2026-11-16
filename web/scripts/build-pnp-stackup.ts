// THE REAL BOARD FOR THE PnP 3D VIEW — rendered from `pcb`'s GERBERS, at build
// time, never committed. Founder 2026-10-15: *"on the pnp put the top and bottom
// gerber to the pcb"*.
//
//   in   hardware/pcb/<board>/fab/[<sub>/]<id>-*.gbr  + *.drl   (pcb's fab output)
//   out  web/public/pnp-stackup/<id>-top.svg, <id>-bottom.svg, index.json
//
// Rendered by `pcb-stackup` 4.2.8 (MIT; its whole dependency tree is MIT, plus
// `inherits` ISC — checked 2026-10-15, AGPL-compatible). The outline is the
// Edge_Cuts gerber (`useOutline`), so the board has its real shape and holes;
// the top SVG is seen from above, the bottom one from below (mirrored in X).
//
// ⚠ WHY GENERATED AND NOT COMMITTED: the same reason as `public/shop/`. A copy of
// pcb's gerbers rendered into this lane's git would drift the day pcb re-exports.
// Here the render follows the gerbers on every build.
//
// ⚠ IT RENDERS THE GERBERS, NOT THE .kicad_pcb. When the two disagree the render
// shows what the FAB FILES say — which is the point (buck48_05/24 ship with no
// F_Cu/F_Mask gerber; their top face is drawn without them, and `index.json`
// lists the missing layers so the tab can say so).
//
// Exit: 0 written (per-board failures are RECORDED in index.json, not fatal) ·
// 2 could not run (no hardware/pcb, or the output could not be written).
//
// Run: `npm run pnp:stackup` (also chained into `npm run build`).

import { readdirSync, existsSync, mkdirSync, writeFileSync, rmSync, renameSync, createReadStream, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { parseKicadFootprints } from '../src/pnp/parts';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// pcb-stackup ships its own types; the one call below is narrowed to what this script uses.
import stackupLib from 'pcb-stackup';

interface StackupSide {
  svg: string;
  viewBox: [number, number, number, number];
  units: string;
}
const stackup = stackupLib as unknown as (
  layers: { filename: string; gerber: NodeJS.ReadableStream }[],
  opts: { useOutline: boolean }
) => Promise<{ top: StackupSide; bottom: StackupSide; layers: { side: string; type: string; filename: string }[] }>;

const HERE = dirname(fileURLToPath(import.meta.url));
const PCB = resolve(HERE, '../../../../hardware/pcb');
/** `--out <dir>` (tests) — default `web/public/pnp-stackup`. Any other flag is refused. */
const args = process.argv.slice(2);
if (args.length && !(args.length === 2 && args[0] === '--out')) {
  console.error(`pnp-stackup: unknown arguments ${args.join(' ')} — accepted: --out <dir>`);
  process.exit(2);
}
const OUT = args[0] === '--out' ? resolve(args[1]) : resolve(HERE, '../public/pnp-stackup');

/** The layers a real board needs to look like one; reported when absent. */
const WANTED = ['F_Cu', 'B_Cu', 'F_Mask', 'B_Mask', 'F_Silkscreen', 'B_Silkscreen', 'Edge_Cuts'];

export interface StackupEntry {
  id: string;
  /** Repo-relative fab dir the gerbers came from. */
  source: string;
  /** Gerber coordinates of the board (mm): x ∈ [minX, minX+w], y ∈ [minY, minY+h]. */
  box?: { minX: number; minY: number; w: number; h: number };
  layers: string[];
  missing: string[];
  error?: string;
  /** The board's components as `<id>-parts.glb` (kicad-cli, from the .kicad_pcb's
   *  own `(model …)` references), or why not. */
  parts?: {
    glb: boolean;
    kicadPcb: string;
    footprints: number;
    withModel: number;
    /** Models that are pcb's generic `box_WxDxH.step` stand-ins, not the part's CAD. */
    placeholder: number;
    error?: string;
  };
}

/**
 * The components in 3D: `kicad-cli pcb export glb` on the board's .kicad_pcb
 * (one directory up from fab/, or two for fab/<sub>/). Each glTF node is named by
 * reference designator; the tab hangs them on its parts by that name. The models
 * are whatever pcb's footprints reference — mostly pcb's own `box_*.step`
 * placeholders today — counted here so the tab can say so, never presented as
 * the parts' vendor CAD. kicad-cli is a BUILD-time tool; without it the glb is
 * absent and the reason recorded.
 */
function componentsGlb(fabDir: string, id: string, out: string): StackupEntry['parts'] {
  const boardDir = fabDir.replace(/\/fab(\/[^/]+)?$/, '');
  const pcbFile = join(boardDir, `${id}.kicad_pcb`);
  const rel = pcbFile.slice(PCB.length - 'hardware/pcb'.length);
  if (!existsSync(pcbFile)) return { glb: false, kicadPcb: rel, footprints: 0, withModel: 0, placeholder: 0, error: 'no .kicad_pcb' };
  const fps = parseKicadFootprints(readFileSync(pcbFile, 'utf8'));
  const withModel = fps.filter((f) => f.models.length > 0).length;
  const placeholder = fps.filter((f) => f.models.length > 0 && f.models.every((m) => /\/box_[\d.x]+\.(step|stp|wrl)$/i.test(m.path))).length;
  const base = { kicadPcb: rel, footprints: fps.length, withModel, placeholder };
  if (withModel === 0) return { ...base, glb: false, error: 'no footprint references a 3D model' };
  const target = join(out, `${id}-parts.glb`);
  try {
    execFileSync('kicad-cli', ['pcb', 'export', 'glb', '--force', '-o', target, pcbFile], { stdio: 'pipe', timeout: 120_000 });
    if (!existsSync(target) || statSync(target).size === 0) throw new Error('kicad-cli wrote nothing');
    return { ...base, glb: true };
  } catch (err) {
    const m = (err as { stderr?: Buffer; message: string });
    return { ...base, glb: false, error: `kicad-cli: ${(m.stderr?.toString() || m.message).trim().split('\n').pop()}` };
  }
}

function fabDirs(): string[] {
  const out: string[] = [];
  for (const d of readdirSync(PCB, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const fab = join(PCB, d.name, 'fab');
    if (!existsSync(fab)) continue;
    out.push(fab);
    for (const s of readdirSync(fab, { withFileTypes: true })) if (s.isDirectory()) out.push(join(fab, s.name));
  }
  return out;
}

async function main(): Promise<number> {
  if (!existsSync(PCB)) {
    console.error(`pnp-stackup: ${PCB} does not exist — could not run`);
    return 2;
  }
  const tmp = `${OUT}.building-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const entries: StackupEntry[] = [];
  for (const dir of fabDirs()) {
    const files = readdirSync(dir).filter((f) => /\.(gbr|drl)$/i.test(f));
    for (const edge of files.filter((f) => f.endsWith('-Edge_Cuts.gbr'))) {
      const id = edge.slice(0, -'-Edge_Cuts.gbr'.length);
      const mine = files.filter((f) => f.startsWith(`${id}-`) && !/Paste/i.test(f));
      const layers = mine.map((f) => f.slice(id.length + 1).replace(/\.(gbr|drl)$/i, ''));
      const e: StackupEntry = {
        id,
        source: dir.slice(PCB.length - 'hardware/pcb'.length).replace(/^\/+/, ''),
        layers,
        missing: WANTED.filter((w) => !layers.includes(w)),
      };
      try {
        const s = await stackup(
          mine.map((f) => ({ filename: f, gerber: createReadStream(join(dir, f)) })),
          { useOutline: true }
        );
        const [x, y, w, h] = s.top.viewBox;
        const k = s.top.units === 'in' ? 25.4 / 1000 : 1 / 1000;
        const mm = (v: number) => Math.round(v * k * 1e6) / 1e6;
        e.box = { minX: mm(x), minY: mm(y), w: mm(w), h: mm(h) };
        writeFileSync(join(tmp, `${id}-top.svg`), s.top.svg);
        writeFileSync(join(tmp, `${id}-bottom.svg`), s.bottom.svg);
      } catch (err) {
        e.error = (err as Error).message;
      }
      e.parts = componentsGlb(dir, id, tmp);
      entries.push(e);
    }
  }
  entries.sort((a, b) => a.id.localeCompare(b.id));
  writeFileSync(
    join(tmp, 'index.json'),
    JSON.stringify({ generator: 'pcb-stackup 4.2.8 via scripts/build-pnp-stackup.ts', boards: entries }, null, 1)
  );
  rmSync(OUT, { recursive: true, force: true });
  renameSync(tmp, OUT);
  const bad = entries.filter((e) => e.error);
  console.log(
    `pnp-stackup: ${entries.length} board(s) → ${OUT} · rendered ${entries.length - bad.length} · failed ${bad.length}` +
      (bad.length ? ` (${bad.map((b) => `${b.id}: ${b.error}`).join('; ')})` : '') +
      ` · missing layers: ${entries.filter((e) => e.missing.length).map((e) => `${e.id} [${e.missing.join(',')}]`).join(' ') || 'none'}` +
      ` · component glb: ${entries.filter((e) => e.parts?.glb).length}/${entries.length}`
  );
  return 0;
}

main().then(
  (c) => process.exit(c),
  (e) => {
    console.error(`pnp-stackup: could not run: ${(e as Error).message}`);
    process.exit(2);
  }
);
