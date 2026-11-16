// EXTERNAL DESIGNS — WHAT THIS IS, AND THE THREE THINGS IT DELIBERATELY IS NOT.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHAT IT IS
// ═══════════════════════════════════════════════════════════════════════════
//
// A second, clearly-separated shelf in the Designs tab holding designs that are
// NOT ours: openly-licensed geometry found on the public internet, discovered by
// `scripts/collect-external-designs.ts` and then actually OPENED by
// `scripts/verify-external-designs.ts` using the same reader the app ships.
//
// The founder's ask was that a visitor to Designs should see more mature
// designs than this company has authored so far. The honest way to do that is
// to show other people's work AS other people's work.
//
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 NOT #1 — IT IS NOT A MIRROR, AND NO DESIGN FILE IS REPUBLISHED BY US
// ═══════════════════════════════════════════════════════════════════════════
//
// The collector stores METADATA: repository, resolved commit, SPDX licence,
// attribution, and the paths of the geometry files. The verifier downloads a
// file to a gitignored scratch directory, evaluates it locally, and records what
// happened. Nothing is copied into `git`, and the catalogue card links OUT to
// the source.
//
// ⚠ That is a licence position, not a storage preference. Displaying a link and
// an attribution is not republication; serving someone else's CAD from our own
// origin is, and it drags share-alike terms onto a served AGPL work. If that is
// ever wanted it is a separate, deliberate decision with `legal` in it — so the
// entry records `shareAlike` now, while the fact is cheap to capture.
//
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 NOT #2 — AN EXTERNAL DESIGN IS NEVER PRESENTED AS ONE OF OURS
// ═══════════════════════════════════════════════════════════════════════════
//
// Separate index, separate type, separate shelf, and every card carries the
// author and the licence. `cad`'s designs are the company's; these are not, and
// a visitor who cannot tell them apart has been misled about what this company
// has built — which is the same claim-integrity rule the rest of this tree runs
// on, arriving on a product surface.
//
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 NOT #3 — "FOUND" IS NOT "WORKS", AND THE TWO ARE STORED SEPARATELY
// ═══════════════════════════════════════════════════════════════════════════
//
// Discovery can only say a repository declares a licence and contains a file
// with a promising extension. Whether THIS app can open it is a different fact,
// produced by a different run, and it lives in `verified`. An entry with
// `verified === undefined` has not been tested — which is not "it failed" and
// is emphatically not "it works". The tab must not blur those three states.

/** Formats this app can open. Anything else is not a design surface here. */
export const OPENABLE_EXT = ['.scad', '.dxf', '.svg', '.stl'] as const;

export type OpenableExt = (typeof OPENABLE_EXT)[number];

/**
 * SPDX ids this lane has reviewed and accepts for a LINKED, ATTRIBUTED card.
 *
 * 🔴 AN ALLOWLIST, NEVER A BLOCKLIST. A blocklist admits every licence nobody
 * has thought about yet, including every future one, and the failure is silent —
 * a card appears and nothing says why it was allowed. The refusal path names the
 * reason for every repository it drops, so "we found nothing" and "we refused
 * eleven things and here is why" are different, readable outcomes.
 *
 * ⚠ WHAT MEMBERSHIP MEANS, EXACTLY: the licence permits commercial use and
 * redistribution, so linking to it and naming it inside a commercial product is
 * unproblematic. It does NOT mean the file may be served from our origin — see
 * `shareAlike`.
 */
export const LICENCE_ALLOW: readonly string[] = [
  'CC0-1.0',
  'MIT',
  'MIT-0',
  'ISC',
  'Zlib',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'Apache-2.0',
  'Unlicense',
  'MPL-2.0',
  'CC-BY-4.0',
  'CC-BY-3.0',
  'CC-BY-SA-4.0',
  'CC-BY-SA-3.0',
  'GPL-2.0',
  'GPL-3.0',
  'LGPL-2.1',
  'LGPL-3.0',
  'AGPL-3.0',
  'CERN-OHL-P-2.0',
  'CERN-OHL-W-2.0',
  'CERN-OHL-S-2.0',
];

/** Licences whose terms follow a derivative — recorded so a future decision to
 *  HOST a file has the fact already, rather than discovering it at that moment. */
export const SHARE_ALIKE: readonly string[] = [
  'CC-BY-SA-4.0',
  'CC-BY-SA-3.0',
  'GPL-2.0',
  'GPL-3.0',
  'LGPL-2.1',
  'LGPL-3.0',
  'AGPL-3.0',
  'MPL-2.0',
  'CERN-OHL-S-2.0',
  'CERN-OHL-W-2.0',
];

export interface LicenceRuling {
  allowed: boolean;
  shareAlike: boolean;
  /** Present when `allowed` is false. A sentence, not a code. */
  why?: string;
}

/**
 * Rule on one SPDX id as GitHub reports it.
 *
 * ⚠ `null` and `'NOASSERTION'` are the common cases and they are NOT the same
 * as a restrictive licence — GitHub says it could not identify one. Both are
 * refused, and the reason says which, because "the author chose no licence" and
 * "our detector could not read the licence" send a reader to different places.
 */
export function ruleLicence(spdx: string | null | undefined): LicenceRuling {
  const id = (spdx ?? '').trim();
  if (id === '') return { allowed: false, shareAlike: false, why: 'no licence field at all — an unlicensed work is all-rights-reserved by default, not free to use' };
  if (id === 'NOASSERTION') {
    return {
      allowed: false,
      shareAlike: false,
      why: 'the source reports NOASSERTION — it found a licence file it could not identify, which is "unknown", not "permissive". A human read of that file could still clear it',
    };
  }
  // Creative Commons non-commercial / no-derivatives, in any version.
  if (/(^|-)NC(-|$)/.test(id)) return { allowed: false, shareAlike: false, why: `${id} is NON-COMMERCIAL and this is a commercial product` };
  if (/(^|-)ND(-|$)/.test(id)) return { allowed: false, shareAlike: false, why: `${id} forbids derivative works, and opening a design in a CAM tool produces one` };
  if (!LICENCE_ALLOW.includes(id)) {
    return { allowed: false, shareAlike: false, why: `${id} is not on the reviewed allowlist — it may well be fine, but nobody here has read it, and an unreviewed licence must not admit itself` };
  }
  return { allowed: true, shareAlike: SHARE_ALIKE.includes(id) };
}

/** What the animation probe found. See `verify-external-designs.ts`. */
export interface AnimationProbe {
  /** The source text references `$t`. */
  mentionsT: boolean;
  /** How many steps were evaluated. 0 when the design does not open. */
  frames: number;
  /**
   * The geometry actually CHANGED between steps.
   *
   * 🔴 `mentionsT && !moves` is a real finding, not a null result: the design
   * declares an animation that does not move under this reader — either it uses
   * `$t` for something non-geometric, or a construct this reader dropped is the
   * part that moved. Either way a card must not advertise an animation on it.
   */
  moves: boolean;
  note: string;
}

export interface ExternalVerification {
  checkedAt: string;
  /** The file that was opened, relative to the repository root. */
  entry: string;
  opens: boolean;
  errors: number;
  firstError?: string;
  /** NAMED, never a bare count — see the intake rule in the lane's AGENTS.md. */
  unsupported: string[];
  parts: number;
  triangles: number;
  /** `meshScene`'s own verdict, carried unmodified. */
  trust: 'nothing' | 'trusted' | 'suspect' | 'untrusted';
  trustDetail: string;
  sizeMm: [number, number, number] | null;
  animation: AnimationProbe;
}

export interface ExternalDesign {
  id: string;
  source: 'github';
  /** `owner/name`. */
  repo: string;
  url: string;
  /** The commit the file list was read at. Recorded so a later run can diff. */
  commit: string;
  title: string;
  description: string;
  stars: number;
  licence: string;
  licenceUrl: string;
  /** Rendered on the card. The licence obligation this lane can actually meet. */
  attribution: string;
  shareAlike: boolean;
  /** Openable geometry files found in the tree, capped by the collector. */
  files: { path: string; ext: string }[];
  /** Absent means NOT TESTED — neither pass nor fail. */
  verified?: ExternalVerification;
}

export interface ExternalIndex {
  generatedAt: string;
  note: string;
  queries: string[];
  scanned: number;
  listed: number;
  refused: number;
  refusedReasons: { repo: string; why: string }[];
  /**
   * Candidates the run could not decide on — almost always the anonymous API
   * rate limit.
   *
   * 🔴 SEPARATE FROM `refused` ON PURPOSE. A rate-limited run that folded these
   * into refusals would report a shrinking catalogue as a licence finding, and
   * the next reader would go looking for a licence problem that is a quota.
   */
  unchecked: number;
  uncheckedReasons: { repo: string; why: string }[];
  entries: ExternalDesign[];
}

/**
 * 🔴 A SEPARATE DIRECTORY FROM `public/shop/`, AND IT WAS NOT AT FIRST.
 * `build-shop-catalogue.ts` `rmSync`s its whole output directory before writing,
 * so the first version of this shelf — which shared it — was DELETED by the next
 * `npm run shop`, silently, leaving `external.json` missing and the tab reporting
 * "no external shelf in this build" as if nothing had ever been collected.
 * ⚠ Two pipelines writing one directory where only one of them wipes it is a
 * silent-loss shape, not a tidiness question.
 */
export const EXTERNAL_BASE = 'designs';

export type ExternalState =
  | { kind: 'loading' }
  | { kind: 'ready'; index: ExternalIndex }
  /** Absent is a BUILD fact. It is never rendered as "there are no designs". */
  | { kind: 'absent'; why: string };

export async function loadExternal(fetchImpl: typeof fetch = fetch): Promise<ExternalState> {
  let r: Response;
  try {
    r = await fetchImpl(`${EXTERNAL_BASE}/external.json`);
  } catch (e) {
    return { kind: 'absent', why: `the external shelf could not be fetched: ${String(e)}` };
  }
  if (!r.ok) {
    return {
      kind: 'absent',
      why:
        `${EXTERNAL_BASE}/external.json answered ${r.status}. It is generated and not in git — ` +
        'run `npm run designs:collect` (and `npm run designs:verify`) in web/.',
    };
  }
  let index: ExternalIndex;
  try {
    index = (await r.json()) as ExternalIndex;
  } catch (e) {
    return { kind: 'absent', why: `the external shelf is not readable JSON: ${String(e)}` };
  }
  if (!index || !Array.isArray(index.entries)) {
    return { kind: 'absent', why: 'the external shelf has no `entries` array — it is not a catalogue.' };
  }
  return { kind: 'ready', index };
}

/**
 * The three display states, computed in one place so the tab cannot invent a
 * fourth or collapse two.
 *
 * ⚠ `untested` exists because it is the state a fresh collect-only run leaves
 * every entry in, and it is the one most likely to be rendered as a pass.
 */
export type DesignStatus = 'opens' | 'refused-by-reader' | 'untested';

export function statusOf(d: ExternalDesign): DesignStatus {
  if (!d.verified) return 'untested';
  return d.verified.opens ? 'opens' : 'refused-by-reader';
}

export function statusLine(d: ExternalDesign): string {
  const v = d.verified;
  if (!v) return 'Not tested in this app yet — this says nothing about whether it opens.';
  if (!v.opens) {
    return v.errors > 0
      ? `This reader could not open it: ${v.errors} error(s), first — ${v.firstError ?? 'unreported'}`
      : 'This reader parsed it but produced no geometry.';
  }
  const bits = [`opens · ${v.parts} part(s), ${v.triangles} triangle(s)`];
  if (v.unsupported.length) bits.push(`${v.unsupported.length} unsupported construct(s): ${v.unsupported.slice(0, 3).join(', ')}`);
  if (v.animation.mentionsT) bits.push(v.animation.moves ? `animates over ${v.animation.frames} step(s)` : 'mentions $t but does not move under this reader');
  return bits.join(' · ');
}
