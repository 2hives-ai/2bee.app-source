// THE BOARDS THE PnP TAB CAN PICK: `pcb`'s own fab outputs, read where `pcb`
// writes them, never copied into this tree.
//
//   hardware/pcb/<board>/fab/<name>-bom.csv     (and fab/<sub>/ for split boards)
//   hardware/pcb/<board>/fab/<name>-cpl.csv
//   hardware/pcb/<board>/<name>-pns.csv          the Assembly-tier sidecar, if any
//
// A board is listed when it has BOTH a BOM and a CPL. Files are loaded on
// selection (`eager: false`), so the bundle carries 15 boards without paying for
// them up front, and a file that will not load is an error ON THAT BOARD, said on
// screen, never an empty plan.
//
// ⚠ `vite dev` REFUSES files outside its `server.fs.allow` list (measured
// 2026-10-15: `/@fs/…/hardware/pcb/outlet/fab/outlet-cpl.csv` → 403, the vspec
// file → 200). A production build and `vite preview` follow the import and are
// unaffected. Under `vite dev` without the allow entry, `loadBoard` rejects and
// the tab names the file — see `vite.config.ts` (not this lane's file to change
// from here; the line is reported to the owner).
//
// Browser-only: `import.meta.glob` is a Vite transform. Pure logic lives in
// `boardModel.ts` and `manifest.ts`, which node tests import.

import { retiredBy, type Retired } from './retired';

const ROOT = '../../../../../hardware/pcb/';

const CPL = import.meta.glob(['../../../../../hardware/pcb/*/fab/*-cpl.csv', '../../../../../hardware/pcb/*/fab/*/*-cpl.csv'], {
  query: '?raw',
  import: 'default',
}) as Record<string, () => Promise<string>>;
const BOM = import.meta.glob(['../../../../../hardware/pcb/*/fab/*-bom.csv', '../../../../../hardware/pcb/*/fab/*/*-bom.csv'], {
  query: '?raw',
  import: 'default',
}) as Record<string, () => Promise<string>>;
const KICAD = import.meta.glob('../../../../../hardware/pcb/*/*.kicad_pcb', {
  query: '?raw',
  import: 'default',
}) as Record<string, () => Promise<string>>;
const PNS = import.meta.glob('../../../../../hardware/pcb/*/*-pns.csv', {
  query: '?raw',
  import: 'default',
}) as Record<string, () => Promise<string>>;

// 🔴 `?raw`, though only the KEYS are read. Without a query each marker is a
// lazy JS module: `vite dev` never loads one, but `vite build` parses every
// globbed file for import analysis and failed on the first `.md` — "Failed to
// parse source for import analysis" — so the production bundle, and with it
// the whole browser suite (I1: webServer timed out), could not be built.
const MARKERS = Object.keys(
  import.meta.glob(
    [
      '../../../../../hardware/pcb/*/_SUPERSEDED.md',
      '../../../../../hardware/pcb/*/fab/_DO-NOT-ORDER*',
      '../../../../../hardware/pcb/*/fab/*/_DO-NOT-ORDER*',
    ],
    { query: '?raw', import: 'default' },
  ),
);

export interface BoardEntry {
  /** `<name>` as the fab files spell it, e.g. `outlet`, `sensor_pod_v3_io`. */
  id: string;
  /** Repo-relative paths, for messages and for the AI's context. */
  cplPath: string;
  bomPath: string;
  pnsPath: string | null;
  /** The board file: positions of the parts the CPL leaves out (hand-fitted). */
  kicadPath: string | null;
  /** pcb's own marker that retires this board (`retired.ts`), or null for a live board. */
  retired: Retired | null;
}

const rel = (k: string) => `hardware/pcb/${k.slice(ROOT.length)}`;

function index(): BoardEntry[] {
  const out: BoardEntry[] = [];
  for (const cpl of Object.keys(CPL)) {
    const m = /\/([^/]+)-cpl\.csv$/.exec(cpl);
    if (!m) continue;
    const id = m[1];
    const bom = cpl.replace(/-cpl\.csv$/, '-bom.csv');
    if (!(bom in BOM)) continue;
    const boardDir = cpl.slice(0, cpl.indexOf('/fab/'));
    const pns = `${boardDir}/${id}-pns.csv`;
    const kicad = `${boardDir}/${id}.kicad_pcb`;
    const r = retiredBy(cpl, MARKERS);
    out.push({ id, cplPath: rel(cpl), bomPath: rel(bom), pnsPath: pns in PNS ? rel(pns) : null, kicadPath: kicad in KICAD ? rel(kicad) : null,
      retired: r ? { ...r, marker: rel(r.marker) } : null });
  }
  // live boards first, retired ones last, each alphabetical
  return out.sort((a, b) => Number(!!a.retired) - Number(!!b.retired) || a.id.localeCompare(b.id));
}

export const BOARDS: readonly BoardEntry[] = index();

export interface LoadedBoard {
  entry: BoardEntry;
  bom: string;
  cpl: string;
  sidecar: string;
  /** '' when the board has no .kicad_pcb, or it did not load (`kicadError`). */
  kicad: string;
  kicadError?: string;
}

/** `kicad: false` skips the board file (1–2 MB) — the Designs page's cards need only the BOM and CPL. */
export async function loadBoard(entry: BoardEntry, opts: { kicad?: boolean } = {}): Promise<LoadedBoard> {
  const get = async (table: Record<string, () => Promise<string>>, path: string) => {
    const key = ROOT + path.slice('hardware/pcb/'.length);
    const f = table[key];
    if (!f) throw new Error(`${path}: not in the bundle`);
    try {
      return await f();
    } catch (e) {
      throw new Error(`${path}: ${(e as Error).message}`);
    }
  };
  const [bom, cpl, sidecar, kicad] = await Promise.all([
    get(BOM, entry.bomPath),
    get(CPL, entry.cplPath),
    entry.pnsPath ? get(PNS, entry.pnsPath) : Promise.resolve(''),
    // The board file is a convenience (hand-part positions): its failure is
    // reported, and the board still opens from the BOM + CPL.
    opts.kicad === false
      ? Promise.resolve({ t: '', e: 'not loaded' as string | undefined })
      : entry.kicadPath
      ? get(KICAD, entry.kicadPath).then(
          (t) => ({ t, e: undefined as string | undefined }),
          (e: Error) => ({ t: '', e: e.message })
        )
      : Promise.resolve({ t: '', e: 'no .kicad_pcb next to the fab files' as string | undefined }),
  ]);
  return { entry, bom, cpl, sidecar, kicad: kicad.t, kicadError: kicad.e };
}
