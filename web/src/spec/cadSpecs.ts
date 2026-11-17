/**
 * cad's functional specifications, as the catalogue build copied them
 * (`scripts/build-shop-catalogue.ts` → `public/shop/s/<id>.md`, `entry.spec`).
 *
 * Pure lookups (`findEntry`, `resolveDrawingName`) are tested in node; the fetches
 * take an injectable `fetch`.
 */
import { SHOP_BASE, loadCatalogue, type CatalogueState, type ShopEntry } from '../shop/catalogue';
import type { OwnerSpec } from './specStore';

let cached: Promise<CatalogueState> | null = null;
/** The catalogue, fetched once per page; a failed fetch is retried next time. */
export function catalogueOnce(fetchImpl: typeof fetch = fetch): Promise<CatalogueState> {
  if (!cached) {
    cached = loadCatalogue(fetchImpl).then((s) => {
      if (s.kind !== 'ready') cached = null;
      return s;
    });
  }
  return cached;
}

export function findEntry(entries: readonly ShopEntry[], path: string | null | undefined): ShopEntry | null {
  if (!path) return null;
  return entries.find((e) => e.path === path) ?? null;
}

/**
 * Which catalogue design a cnc drawing came from. A design opened in cnc is saved
 * under its card TITLE (`shop/toCnc.ts`, with " (2)" … on a clash) or, from cad, under
 * its file name. Only a UNIQUE match counts: two designs with one name is "not known",
 * never a guess.
 */
export function resolveDrawingName(entries: readonly ShopEntry[], name: string): { entry: ShopEntry } | { entry: null; why: string } {
  const base = name.replace(/ \(\d+\)$/, '').trim();
  const stem = (p: string) => p.split('/').pop()!.replace(/\.scad$/, '');
  const hits = entries.filter((e) => e.title === base || stem(e.path) === base);
  if (hits.length === 1) return { entry: hits[0] };
  if (hits.length > 1) return { entry: null, why: `${hits.length} catalogue designs are called "${base}", so this one cannot be told apart` };
  return { entry: null, why: `"${base}" is not one of cad's catalogue designs (a file you opened or saved yourself), so cad has no spec for it` };
}

/** cad's spec for a catalogue entry, read from the copy the build published. */
export async function ownerSpecFor(entry: ShopEntry | null, fetchImpl: typeof fetch = fetch): Promise<OwnerSpec> {
  if (!entry) return { kind: 'none', owner: 'cad', why: 'this design is not one of cad’s catalogue designs, so cad has no spec for it' };
  const s = entry.spec;
  if (!s) return { kind: 'error', owner: 'cad', why: 'the catalogue was built before specs were copied — run `npm run shop` in web/' };
  if (s.kind === 'none') return { kind: 'none', owner: 'cad' };
  if (s.kind === 'withheld') return { kind: 'withheld', owner: 'cad', path: s.path ?? '', why: s.why ?? 'withheld by the build' };
  if (!s.file || !s.path) return { kind: 'error', owner: 'cad', why: 'the catalogue names a spec but no file for it' };
  try {
    const r = await fetchImpl(`${SHOP_BASE}/${s.file}`, { cache: 'no-cache' });
    const text = await r.text();
    if (!r.ok || /^\s*<!doctype html/i.test(text)) return { kind: 'error', owner: 'cad', why: `${s.file} is not there (HTTP ${r.status}) — run \`npm run shop\`` };
    return { kind: s.kind, owner: 'cad', path: `hardware/cad/${s.path}`, text, tracked: s.tracked };
  } catch (e) {
    return { kind: 'error', owner: 'cad', why: String(e instanceof Error ? e.message : e) };
  }
}
