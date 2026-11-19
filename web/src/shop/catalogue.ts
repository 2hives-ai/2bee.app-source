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

import type { Variant } from './variants';
import type { Resolution } from '../cad/resolution';

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
  /** The parts this one file makes and the defines that select each (src/shop/variants.ts). Absent for a one-part file. */
  variants?: Variant[];
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
  /**
   * The machine build's resolution-ladder tier (`cad/machine.ts`): `print` is the fine render; anything else means
   * the render only fit the in-browser kernel with coarser curves, and `parts`/`trust`/`sizeMm` are from THAT build.
   * Absent in a catalogue built before 2026-11-13.
   */
  resolution?: Resolution;
  /** Bounding size in mm, or `null` when the mesher produced no bounds. */
  sizeMm: [number, number, number] | null;
  /** Files in the import closure that travels with this design. */
  files: number;
  bytes: number;
  /** Path under `public/shop/`, or `null` when nothing could be rendered. */
  thumb: string | null;
  /**
   * cad's functional specification for this design, copied by the build (founder
   * 2026-10-16). `file` is under `public/shop/`. OPTIONAL: an index built before it
   * existed has no field, and that must not read as "cad wrote none".
   */
  spec?: {
    kind: 'per-file' | 'directory' | 'none' | 'withheld';
    path: string | null;
    file: string | null;
    tracked: boolean | null;
    why?: string;
  };
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
    // 🔴 `no-cache` (revalidate every time), founder 403 on 2026-11-17. S3 serves
    // these files with no Cache-Control, so a browser may keep an old index.json
    // for days on a heuristic (10% of its age). A deploy then deletes a design the
    // stale index still lists, and opening it returns S3's 403 AccessDenied for a
    // missing key. The index and the design files are one generated set; they
    // must be read from the same deploy.
    r = await fetchImpl(`${SHOP_BASE}/index.json`, { cache: 'no-cache' });
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
  /* 🔴 A DEV SERVER ANSWERS A MISSING PUBLIC FILE WITH THE APP'S OWN HTML AND STATUS 200
   * (Vite's SPA fallback), so `!r.ok` never fires for "not built". The founder saw the raw
   * "Unexpected token '<'" parse error instead of the build instruction (2026-10-15). An
   * HTML body is read as what it is: the file is not there. */
  const body = await r.text();
  if (/^\s*</.test(body)) {
    return {
      kind: 'absent',
      why:
        `${SHOP_BASE}/index.json is not there (the server answered with a web page instead). ` +
        'The catalogue is generated at build time and is not in git — run `npm run shop` in web/.',
    };
  }
  let index: ShopIndex;
  try {
    index = JSON.parse(body) as ShopIndex;
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
  const r = await fetchImpl(`${SHOP_BASE}/d/${id}.json`, { cache: 'no-cache' });
  if (r.status === 403 || r.status === 404) {
    // S3 answers 403, not 404, for a key that does not exist. Either way the
    // design is not in the deployed catalogue: say that, not a bare status.
    throw new Error(
      `design ${id} is not in the current catalogue (the server answered ${r.status}). ` +
        'It was listed by an older version of this page. Reload the page to get the current list.',
    );
  }
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

/**
 * The card's visible line: an EXCERPT of {@link trustLine}, never a paraphrase
 * (the reason is in trustLine's header). The full sentence stays in the card's
 * tooltip. Founder 2026-10-12, *"too many words"*: the Designs tab printed 7,230
 * visible words, and most of them were this line repeated on every card.
 *
 * The excerpt is the mesher's first sentence, minus the shared "the mesh is
 * closed — but" preamble, and cut at a colon. A cause the mesher adds later is
 * still quoted in its own words. `''` for `trusted`, because the badge already
 * says it.
 */
export function trustShort(e: ShopEntry): string {
  if (e.trust === 'trusted') return '';
  const full = trustLine(e);
  const afterBut = full.replace(/^Every solid drawn is watertight and manifold[^—]*—\s*but\s+/, '');
  const first = afterBut.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? afterBut;
  // The parser/kernel split is for whoever debugs the mesher; it stays in the tooltip.
  const short = first.split(':')[0].replace(/\s*\(\d+ by the parser, \d+ by the kernel\)/, '').trim();
  return short.length > 0 ? short : full;
}
