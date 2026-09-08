// THE SHOP'S DATA — AND THE DIFFERENCE BETWEEN "NO DESIGNS" AND "NO CATALOGUE".
//
// `public/shop/` is written by `scripts/build-shop-catalogue.ts` at build time
// and is NOT in git (see that file's header for why a committed copy of cad's
// designs would rot silently). So it can legitimately be missing: a tree that
// has never run `npm run shop`, a checkout, a CI job that skipped it.
//
// 🔴 MISSING IS REPORTED, NEVER RENDERED AS AN EMPTY SHOP. Those two states look
// identical on screen — a page with no cards — and they mean opposite things:
// "cad has no designs this reader can open" is a finding worth acting on, and
// "nobody built the catalogue" is a build step. A shop that renders the second
// as the first tells every viewer the design library is empty, and it is the
// reassuring direction, so nothing escalates it.
//
// That is why {@link CatalogueState} has a `kind` and not just an array.

export interface ShopEntry {
  id: string;
  /** Path inside `hardware/cad/`, e.g. `2bee_hive/2bee_hive_quilt.scad`. */
  path: string;
  title: string;
  family: string;
  familyBlurb: string;
  /** What the filename suffix says it is: sheet part, 3D print, assembly. */
  kind: string;
  /**
   * The beekeeper-facing sentence(s) for this design, written by `cad` from
   * each part's own .scad header (hardware/cad/shop_descriptions.yaml).
   *
   * 🔴 A LIST, because one file can be several registered parts. And OPTIONAL,
   * because most designs have none: this lane does not write them and will not
   * generate one — a confident description of another lane's part, written by
   * someone who did not design it, is a claim wearing a fact's clothes. A card
   * with no sentence shows no sentence.
   */
  describes?: { part: string; text: string }[];
  partNames?: string[];
  /** Top-level solids the mesher produced. */
  parts: number;
  triangles: number;
  /**
   * `meshScene`'s OWN verdict, carried unmodified.
   *
   * 🔴 THE CARD MUST SHOW THIS. `suspect` and `untrusted` mean the picture is
   * INCOMPLETE or the solid is non-manifold — constructs the kernel refused are
   * missing from the thumbnail entirely. A catalogue that showed the render and
   * hid the verdict would be advertising a part the app does not produce, which
   * is the one failure this whole lane is built to refuse.
   */
  trust: 'nothing' | 'trusted' | 'suspect' | 'untrusted';
  trustDetail: string;
  /** Bounding size in mm, or `null` when the mesher produced no bounds. */
  sizeMm: [number, number, number] | null;
  /** Files in the import closure that travels with this design. */
  files: number;
  bytes: number;
  /** Path under `public/shop/`, or `null` when nothing could be rendered. */
  thumb: string | null;
}

export interface ShopIndex {
  generatedAt: string;
  cadRoot: string;
  note: string;
  scanned: number;
  listed: number;
  dropped: number;
  droppedReasons: { path: string; why: string }[];
  /**
   * Directories holding a design this reader CAN open that the catalogue does
   * not offer — see the generator's note on `FAMILIES`. Optional because an
   * older `index.json` predates it, and an absent field must not be read as a
   * measured zero.
   */
  unlistedFamilies?: { dir: string; count: number }[];
  entries: ShopEntry[];
}

export type CatalogueState =
  | { kind: 'loading' }
  | { kind: 'ready'; index: ShopIndex }
  /** The catalogue is absent or unreadable — a BUILD fact, not a design fact. */
  | { kind: 'absent'; why: string };

export const SHOP_BASE = 'shop';

export async function loadCatalogue(
  fetchImpl: typeof fetch = fetch,
): Promise<CatalogueState> {
  let r: Response;
  try {
    r = await fetchImpl(`${SHOP_BASE}/index.json`);
  } catch (e) {
    return { kind: 'absent', why: `the catalogue could not be fetched: ${String(e)}` };
  }
  if (!r.ok) {
    return {
      kind: 'absent',
      why:
        `${SHOP_BASE}/index.json answered ${r.status}. The catalogue is generated at build ` +
        `time and is not in git — run \`npm run shop\` in web/.`,
    };
  }
  let index: ShopIndex;
  try {
    index = (await r.json()) as ShopIndex;
  } catch (e) {
    return { kind: 'absent', why: `the catalogue is not readable JSON: ${String(e)}` };
  }
  if (!index || !Array.isArray(index.entries)) {
    return { kind: 'absent', why: 'the catalogue has no `entries` array — it is not a catalogue.' };
  }
  return { kind: 'ready', index };
}

/** Fetch one design's sources (entry + import closure). */
export async function loadDesign(
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ path: string; sources: Record<string, string> }> {
  const r = await fetchImpl(`${SHOP_BASE}/d/${id}.json`);
  if (!r.ok) throw new Error(`design ${id} could not be fetched: ${r.status}`);
  const d = (await r.json()) as { path: string; sources: Record<string, string> };
  if (!d.sources || typeof d.sources[d.path] !== 'string') {
    // The entry file MUST be present in its own closure — otherwise the editor
    // would open empty and the tab would report an unresolved import for the
    // very file the user picked.
    throw new Error(`design ${id} is missing its entry source (${d.path})`);
  }
  return d;
}

/** Families in catalogue order, each with its entries. */
export function byFamily(entries: ShopEntry[]): { family: string; blurb: string; items: ShopEntry[] }[] {
  const out: { family: string; blurb: string; items: ShopEntry[] }[] = [];
  for (const e of entries) {
    let row = out.find((r) => r.family === e.family);
    if (!row) {
      row = { family: e.family, blurb: e.familyBlurb, items: [] };
      out.push(row);
    }
    row.items.push(e);
  }
  return out;
}

/**
 * What the trust verdict means for the PICTURE on the card.
 *
 * 🔴 FOR ANYTHING BUT `trusted` THIS RETURNS THE MESHER'S OWN WORDS, and that
 * is a correction, not a shortcut. This function used to paraphrase each
 * verdict, and `suspect` was rendered as *"Parts of this model were REFUSED and
 * are missing from the picture"* — which stopped being true on 2026-08-31, when
 * `suspect` gained a second cause: a construct that drew something OTHER than
 * what the source describes, with **nothing refused at all**
 * (see `MeshIssue.alters`). The card would then have asserted a refusal that
 * never happened, sending a reader to hunt a refusal list that is empty.
 *
 * A paraphrase of an authority drifts the moment the authority gains a case the
 * paraphrase never knew about, and it drifts SILENTLY because both texts stay
 * grammatical. `trustDetail` is written by the code that made the decision, so
 * quoting it cannot describe a mechanism that did not occur.
 */
export function trustLine(e: ShopEntry): string {
  if (e.trust === 'trusted') return 'Every solid closed and manifold; nothing refused, nothing altered.';
  return e.trustDetail || 'This picture is not the whole model.';
}
