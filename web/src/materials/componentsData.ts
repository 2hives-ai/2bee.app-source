/**
 * Browser loader for the components pill (pure logic: `components.ts`).
 *
 * The boards come from pnp's discovered list (`pnp/boards.ts`, `loadBoard`), so
 * a board pcb adds appears here with no edit. bom's two files are read with
 * `import.meta.glob(… ?raw)`, so a missing file is a NAMED load failure rather
 * than a build break. All three are read-only here.
 */
import { BOARDS, loadBoard } from '../pnp/boards';
import { aggregateComponents, buildable, readOnHand, readSourcedParts, readStockSnapshot, type Buildable, type ComponentRow, type StockSnapshot } from './components';

const SOURCED = import.meta.glob('../../../../../hardware/bom/sourced_parts.csv', { query: '?raw', import: 'default' }) as Record<string, () => Promise<string>>;
const SNAPSHOT = import.meta.glob('../../../../../hardware/bom/stock-snapshot.json', { query: '?raw', import: 'default' }) as Record<string, () => Promise<string>>;

export interface ComponentsData {
  rows: ComponentRow[];
  boards: string[];
  snapshotDate: string | null;
  /** One line per file that did not load, by path. */
  problems: string[];
}

async function one(table: Record<string, () => Promise<string>>, path: string, problems: string[]): Promise<string> {
  const f = Object.values(table)[0];
  if (!f) {
    problems.push(`${path}: not found, so it was not read.`);
    return '';
  }
  try {
    return await f();
  } catch (e) {
    problems.push(`${path}: ${(e as Error).message}`);
    return '';
  }
}

let cache: Promise<ComponentsData> | null = null;

export function loadComponents(): Promise<ComponentsData> {
  cache ??= (async () => {
    const problems: string[] = [];
    const [sourced, snapText, boards] = await Promise.all([
      one(SOURCED, 'hardware/bom/sourced_parts.csv', problems),
      one(SNAPSHOT, 'hardware/bom/stock-snapshot.json', problems),
      Promise.all(
        BOARDS.map(async (b) => {
          try {
            const l = await loadBoard(b, { kicad: false });
            return { boardId: b.id, bom: l.bom };
          } catch (e) {
            problems.push(`${b.bomPath}: ${(e as Error).message}`);
            return null;
          }
        }),
      ),
    ]);
    const ok = boards.filter((b): b is { boardId: string; bom: string } => !!b);
    const snap: StockSnapshot = snapText ? readStockSnapshot(snapText) : { date: null, stock: new Map() };
    return { rows: aggregateComponents(ok, readSourcedParts(sourced), snap), boards: ok.map((b) => b.boardId), snapshotDate: snap.date, problems };
  })();
  return cache;
}

/**
 * How many of `boardId` the counts in THIS browser cover, and what is short.
 * For pnp to show later. A part with no count counts as zero.
 */
export async function boardsBuildable(boardId: string, store: Pick<Storage, 'getItem'> | null = safeStore()): Promise<Buildable> {
  const d = await loadComponents();
  return buildable(boardId, d.rows, readOnHand(store));
}

function safeStore(): Pick<Storage, 'getItem'> | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
