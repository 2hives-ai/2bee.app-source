// PnP SLICE 1 — TRAY MANIFEST + JOB PRE-FLIGHT. Pure data: no camera, no controller.
//
// Acceptance is `pnp`'s, not this lane's: `handover/2bee_app/_done/2026-10-11-08-45-33-
// pnp-tray-manifest-first-slice-acceptance.md`. Each refusal below carries the number
// it has in that ticket's §2, so a reader can check one against the other. `pnp`'s
// rulings on the first build: `…/_done/2026-10-11-09-02-33-pnp-rulings-on-slice1-…`.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHAT THIS DOES
// ═══════════════════════════════════════════════════════════════════════════
//
// Given a BOM, a CPL, the trays on hand and a board count, it gives every placed
// PART NUMBER (Mfr_PN — two BOM lines with one Mfr_PN share one lane, counts summed,
// pnp ruling 3) ONE lane of a tray whose tape fits, and reports how many parts each
// lane must carry. It refuses — by name — anything that would make that manifest
// wrong, and it reports every refusal in one pass rather than stopping at the first.
//
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 WHAT THIS DOES NOT DO
// ═══════════════════════════════════════════════════════════════════════════
//
// · It does not drive a machine and does not check a tray. OpenPnP is the runtime;
//   until `pnp` specifies the importer on the fork side, a HUMAN reads this output.
// · It does not tell a 10k from a 100k. Two lanes of one package with different
//   values are a swap no camera here can see (§4bh §3). They are WARNED, never
//   claimed caught.
// · NO ADJACENCY RULE (pnp ruling 1). §4bh's "never the same class in neighbouring
//   pockets" defended loose parts hopping between POCKETS in transport. In a lane
//   tray the tape holds pitch and a wall separates lanes, so that swap cannot happen.
//   The lane-tray failure is a person loading the WRONG TAPE, which ordering cannot
//   catch. Slice 1 refused same-package neighbours and padded with empty lanes; that
//   is removed. (Slice-2 candidate, pnp's, untested: scan the reel label at load and
//   refuse a Mfr_PN that is not the lane's.)
// · PACKAGE → TAPE FIT is a DEFAULT, from EIA-481 norms pnp EXPECTS but has not
//   measured on our reels. A per-Mfr_PN OVERRIDE (variant + real pocket pitch, from
//   the vendor packaging field) wins over it. A package with no default and no
//   override is REFUSED, never guessed. That covers a through-hole terminal, a module,
//   and R2512 / 4030 / VQFN, whose tape varies by vendor. Rows the PCBA provider
//   places need an explicit BOM field that does not exist yet (pnp → bom/pcb). Until
//   then they are refused by name, not skipped.
// · TRAY GEOMETRY IS READ, NOT COPIED: `cad`'s `hardware/cad/2bee_pnp/
//   pnp_blinds_vspec.json`, generated from the scad's own VSPEC echo. Its pockets per
//   lane are COMPUTED by the scad (4 mm sprocket margin), not counted on a real tape.
//   A missing or malformed file is could-not-run (exit 2).
// · Bottom-side CPL rows are REFUSED by Ref. Nothing here handles a second side.

/** A tray variant name as `pnp_blinds_vspec.json` spells it. */
export type Variant = string;

export interface VariantSpec {
  lanes: number;
  tapeLengthMm: number;
  pocketPitchMm: number;
  pocketsPerLane: number;
}
export type Vspec = Record<Variant, VariantSpec>;

/** The scad's sprocket margin, per `cad`: pockets = floor((tape_length - 4) / pitch).
 *  Used ONLY for an override's own pitch; a JSON variant's count is read, never
 *  recomputed. A test pins this formula against every JSON row so it cannot drift. */
export const SPROCKET_MARGIN_MM = 4;

/** Validate `pnp_blinds_vspec.json`. Throws, naming the field, on anything else. */
export function parseVspec(json: unknown): Vspec {
  const rows = (json as { variants?: unknown })?.variants;
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('vspec: no "variants" array');
  const out: Vspec = {};
  for (const r of rows as Record<string, unknown>[]) {
    const n = (k: string) => {
      const v = r[k];
      if (typeof v !== 'number' || !(v > 0)) throw new Error(`vspec ${String(r.variant)}: ${k} is not a positive number`);
      return v;
    };
    if (typeof r.variant !== 'string' || !r.variant) throw new Error('vspec: a row has no variant name');
    if (r.variant in out) throw new Error(`vspec: variant ${r.variant} listed twice`);
    out[r.variant] = {
      lanes: n('lanes'),
      tapeLengthMm: n('tape_length_mm'),
      pocketPitchMm: n('pocket_pitch_mm'),
      pocketsPerLane: n('pockets_per_lane'),
    };
  }
  return out;
}

/** Parts one lane holds: the JSON's count, or — for an override with its own pitch
 *  — the scad's formula on that pitch. */
export function laneCapacity(vspec: Vspec, v: Variant, pocketPitchMm?: number): number {
  const s = vspec[v];
  return pocketPitchMm === undefined
    ? s.pocketsPerLane
    : Math.floor((s.tapeLengthMm - SPROCKET_MARGIN_MM) / pocketPitchMm);
}

/** Shown beside every capacity this module reports. */
export const CAPACITY_NOTE =
  "capacities from cad's pnp_blinds_vspec.json — computed by the scad, not counted on a real tape";

/** DEFAULT tape per BOM `Package` (pnp ruling 2, EIA-481 norms, UNVERIFIED on our
 *  reels). Matched exactly against the BOM's Package column. TWO entries = the tape
 *  depends on the part's HEIGHT (0805/1206 come paper or embossed); the first is
 *  tried first, and the lane is WARNED until an override names the real tape.
 *  R2512, 4030 inductors and VQFN are absent on purpose: tape varies by vendor. */
export const FIT: Record<string, readonly Variant[]> = {
  // `coupon0402` is a 40 mm TEST tray and is not a default (pnp 09-23-36);
  // reach it with an override.
  R0402: ['0402'],
  C0402: ['0402'],
  R0603: ['8paper'],
  C0603: ['8paper'],
  R0805: ['8paper', '8emb'],
  C0805: ['8paper', '8emb'],
  R1206: ['8paper', '8emb'],
  C1206: ['8paper', '8emb'],
  'SOT-23-3': ['8emb'],
  'SOT-23-5': ['8emb'],
  'SOT-23-6 (TSOT-23-6)': ['8emb'],
  'SOIC-8': ['12'],
  'SOT-223-3 TabPin2': ['12'],
  SMB: ['12'],
  'Fuse 1812': ['12'],
};

/** Per-Mfr_PN tape, from the vendor packaging field when the reel is bought. Wins
 *  over {@link FIT}; its pitch, not the variant's, sets the lane capacity. */
export type Overrides = Record<
  string,
  { variant: Variant; pocketPitchMm: number; verified?: boolean; source?: string }
>;

/** Read an overrides file. Keys starting `_` are comments. */
export function parseOverrides(json: unknown): Overrides {
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('overrides: not a JSON object');
  return Object.fromEntries(Object.entries(json as Record<string, unknown>).filter(([k]) => !k.startsWith('_'))) as Overrides;
}

/** `Assembly` — pcb's DERIVED tier (`hardware/pcb/common/assembly_tier.py`, gate G71),
 *  computed from the pads, so it cannot drift from the board. Ruled by `ceo`
 *  2026-10-11 over bom's hand-set `PlacedBy` (retired the same day). Read from the
 *  BOM's own `Assembly` column when it has one, else from the board's sidecar
 *  (`hardware/pcb/<board>/<board>-pns.csv`) joined on Mfr_PN — never inferred from a
 *  package or a ref prefix. */
export type AssemblyMap = Record<string, string>;

/** Tiers our pick-and-place places. Blank = no tier stated: placed, and counted. */
export const ASSEMBLY_OURS = new Set(['INHOUSE', 'INHOUSE-STENCIL', '']);
/** Tiers it does not: provider-placed (`JLCPCB`), hand-fitted (`HAND`), not in the fab
 *  BOM (`NOT-PLACED`), through-hole (`THT-HAND`, derived by `tier()` from a thru-hole
 *  pad, added by `pcb` 2026-10-11). Any OTHER value is refused by name — a new tier
 *  must be classified here on purpose, never fall into either set by default. */
export const ASSEMBLY_SKIP = new Set(['JLCPCB', 'HAND', 'NOT-PLACED', 'THT-HAND']);

export function assemblyFromSidecar(csv: string): { map: AssemblyMap; problems: string[] } {
  const map: AssemblyMap = {};
  const problems: string[] = [];
  const rows = parseCsv(csv);
  if (!rows.length) problems.push('sidecar: 0 rows read');
  else if (!('Assembly' in rows[0] && 'Mfr_PN' in rows[0])) problems.push('sidecar: no Assembly and Mfr_PN columns');
  for (const r of rows) {
    const v = (r.Assembly ?? '').trim();
    if (r.Mfr_PN in map && map[r.Mfr_PN] !== v)
      problems.push(`sidecar: Mfr_PN ${r.Mfr_PN} has Assembly ${map[r.Mfr_PN] || '(blank)'} and ${v || '(blank)'}`);
    map[r.Mfr_PN] = v;
  }
  return { map, problems };
}

export interface TrayDef {
  trayId: string;
  variant: Variant;
}

export interface Problem {
  /** The acceptance item it answers (`pnp` 08-45-33 §2), or `extra` for one this
   *  lane added — said so, so nobody reads it as pnp's. */
  rule: '1' | '2' | '3' | '4' | '5' | '6' | 'extra';
  message: string;
}

export interface LaneRow {
  trayId: string;
  lane: number; // 1-based, in tray order
  variant: Variant;
  mfrPn: string;
  value: string;
  pkg: string;
  refs: string[];
  need: number;
  capacity: number;
  /** Parts IN THIS LANE. A part that spills over several lanes has one row each. */
  // (need is per lane; see `tests/pnp-manifest.test.ts` 'overflow')
  /** Where the tape came from: an override, a single default, or an ambiguous default. */
  tape: 'override' | 'default' | 'default-ambiguous';
  /** Set when another lane in the job holds the same package with a different value. */
  swapUndetectable: boolean;
}

export interface Counts {
  bomRows: number;
  cplRows: number;
  skippedDnp: number;
  skippedConsigned: number;
  /** BOM lines whose `Assembly` tier says our machine does not place them. */
  skippedAssembly: number;
  /** BOM lines per `Assembly` value read — every value, so a mapping can be checked. */
  assembly: Record<string, number>;
  placedLines: number;
  placedParts: number; // per board
}

export interface PreflightResult {
  /** 0 = manifest is usable · 1 = refused (see `refusals`) · 2 = could not run. */
  exit: 0 | 1 | 2;
  counts: Counts;
  lanes: LaneRow[];
  traysUsed: string[];
  /** Lanes the job needs per variant, and trays that makes — whether or not the
   *  trays on hand have them. Keyed by each part's first fitting variant. */
  lanesNeeded: Record<Variant, { lanes: number; trays: number }>;
  refusals: Problem[];
  warnings: string[];
}

/** RFC 4180 CSV: quoted fields, doubled quotes, commas and newlines inside quotes. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else q = false;
      } else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== '')) rows.push(row);
  if (rows.length === 0) return [];
  const head = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, j) => [h, (r[j] ?? '').trim()])));
}

const BOM_COLS = ['Reference', 'Value', 'Package', 'Mfr_PN', 'DNP', 'Consigned'];
const CPL_COLS = ['Ref', 'Val', 'Package', 'Side'];

const truthy = (s: string | undefined) => !!s && !/^(|0|no|false|n)$/i.test(s.trim());

interface Line {
  refs: string[];
  value: string;
  pkg: string;
  mfrPn: string;
}

export function preflight(input: {
  bomCsv: string;
  cplCsv: string;
  trays: TrayDef[];
  boards: number;
  vspec: Vspec;
  overrides?: Overrides;
  assembly?: AssemblyMap;
}): PreflightResult {
  const assembly = input.assembly ?? {};
  const vspec = input.vspec;
  const overrides = input.overrides ?? {};
  const refusals: Problem[] = [];
  const warnings: string[] = [];
  const bom = parseCsv(input.bomCsv);
  const cpl = parseCsv(input.cplCsv);
  const counts: Counts = {
    bomRows: bom.length,
    cplRows: cpl.length,
    skippedDnp: 0,
    skippedConsigned: 0,
    skippedAssembly: 0,
    assembly: {},
    placedLines: 0,
    placedParts: 0,
  };
  const out = (
    exit: 0 | 1 | 2,
    lanes: LaneRow[] = [],
    traysUsed: string[] = [],
    lanesNeeded: PreflightResult['lanesNeeded'] = {}
  ): PreflightResult => ({
    exit,
    counts,
    lanes,
    traysUsed,
    lanesNeeded,
    refusals,
    warnings,
  });

  // ── 6: zero rows, or a file that is not the format we read, is COULD-NOT-RUN ──
  const missing = (rows: Record<string, string>[], cols: string[]) =>
    rows.length ? cols.filter((c) => !(c in rows[0])) : [];
  if (bom.length === 0) refusals.push({ rule: '6', message: 'BOM: 0 rows read — nothing was checked' });
  if (cpl.length === 0) refusals.push({ rule: '6', message: 'CPL: 0 rows read — nothing was checked' });
  for (const [name, rows, cols] of [
    ['BOM', bom, BOM_COLS],
    ['CPL', cpl, CPL_COLS],
  ] as const) {
    const m = missing(rows, cols as unknown as string[]);
    if (m.length) refusals.push({ rule: '6', message: `${name}: missing column(s) ${m.join(', ')}` });
  }
  if (!Number.isInteger(input.boards) || input.boards < 1)
    refusals.push({ rule: '6', message: `boards must be a whole number ≥ 1, got ${input.boards}` });
  for (const [pn, o] of Object.entries(overrides))
    if (!o || !(o.variant in vspec) || !(o.pocketPitchMm > 0))
      refusals.push({ rule: '6', message: `override ${pn}: needs a known variant and a pocketPitchMm > 0` });
  if (refusals.length) return out(2);

  // ── trays: 4 (duplicate id) and unknown variants ──────────────────────────
  const seenTray = new Set<string>();
  for (const t of input.trays) {
    if (seenTray.has(t.trayId)) refusals.push({ rule: '4', message: `duplicate trayId ${t.trayId}` });
    seenTray.add(t.trayId);
    if (!(t.variant in vspec))
      refusals.push({ rule: 'extra', message: `tray ${t.trayId}: unknown variant "${t.variant}"` });
  }

  // ── BOM lines to place ────────────────────────────────────────────────────
  const lines: Line[] = [];
  const bomRefs = new Set<string>();
  for (const r of bom) {
    const refs = r.Reference.split(',').map((s) => s.trim()).filter(Boolean);
    // A sidecar was given and this part is not in it: that is a FAILED JOIN, not "no
    // tier". Read as blank it would be placed silently — the outlet fab BOM of
    // 2026-09-01 against today's sidecar missed 8 lines exactly that way.
    const joinMiss = !('Assembly' in r) && Object.keys(assembly).length > 0 && !(r.Mfr_PN in assembly);
    if (joinMiss)
      refusals.push({ rule: 'extra', message: `BOM ${r.Reference}: Mfr_PN ${r.Mfr_PN} is not in the sidecar — Assembly tier unknown` });
    const tier = ('Assembly' in r ? r.Assembly : assembly[r.Mfr_PN] ?? '').trim();
    const label = joinMiss ? '(not in sidecar)' : tier || '(blank)';
    counts.assembly[label] = (counts.assembly[label] ?? 0) + 1;
    if (!ASSEMBLY_OURS.has(tier) && !ASSEMBLY_SKIP.has(tier))
      refusals.push({ rule: 'extra', message: `BOM ${r.Reference}: Assembly "${tier}" is a tier this tool does not know` });
    const skip = truthy(r.DNP) ? 'dnp' : truthy(r.Consigned) ? 'consigned' : ASSEMBLY_SKIP.has(tier) ? 'assembly' : null;
    for (const ref of refs) {
      if (bomRefs.has(ref)) refusals.push({ rule: 'extra', message: `BOM: Reference ${ref} appears on two lines` });
      bomRefs.add(ref);
    }
    if (skip === 'dnp') counts.skippedDnp++;
    else if (skip === 'consigned') counts.skippedConsigned++;
    else if (skip === 'assembly') counts.skippedAssembly++;
    else lines.push({ refs, value: r.Value, pkg: r.Package, mfrPn: r.Mfr_PN });
  }
  counts.placedLines = lines.length;

  // ── 5: BOM and CPL must name the same placed parts ────────────────────────
  const cplRefs = new Map<string, number>();
  for (const c of cpl) cplRefs.set(c.Ref, (cplRefs.get(c.Ref) ?? 0) + 1);
  for (const [ref, n] of cplRefs) {
    if (n > 1) refusals.push({ rule: '5', message: `CPL: Ref ${ref} placed ${n} times` });
    if (!bomRefs.has(ref)) refusals.push({ rule: '5', message: `CPL Ref ${ref} is not in the BOM` });
  }
  for (const l of lines)
    for (const ref of l.refs)
      if (!cplRefs.has(ref)) refusals.push({ rule: '5', message: `BOM Reference ${ref} has no CPL row` });

  // ── a placed line with NO Mfr_PN cannot share a lane with another ─────────
  // 🔴 Lanes group by Mfr_PN, and nothing refused an empty one: every blank-Mfr_PN line
  // of a package became the part "", and `10k` and `100k` R0603 were planned into ONE
  // lane at MANIFEST OK — the machine would place 100k where 10k belongs (bughunt
  // 2026-11-15; seen live in hbs57_mux: R_ENPU 100k + R_LED0-2 1k). Refused by Ref.
  for (const l of lines)
    if (!l.mfrPn || !l.mfrPn.trim())
      refusals.push({ rule: '4', message: `BOM line ${l.refs.join(',')} (${l.value}, ${l.pkg}) has no Mfr_PN — a lane is one part, and a part with no number cannot be told from the others` });

  // ── 4: one Value + Package under two different Mfr_PN is ambiguous ────────
  // Same Value AND same Package — "100nF" in C0603 and in C0805 are legitimately two
  // parts. Confirmed by pnp (ruling 3).
  const byVP = new Map<string, Set<string>>();
  for (const l of lines) {
    const k = `${l.value}\u0000${l.pkg}`;
    (byVP.get(k) ?? byVP.set(k, new Set()).get(k)!).add(l.mfrPn);
  }
  for (const [k, pns] of byVP)
    if (pns.size > 1) {
      const [v, p] = k.split('\u0000');
      refusals.push({ rule: '4', message: `Value ${v} (${p}) maps to ${pns.size} Mfr_PN: ${[...pns].join(', ')}` });
    }
  // ── bottom side: not handled, so it must not pass silently (pnp ruling) ──
  for (const c of cpl)
    if (c.Side.toLowerCase() !== 'top')
      refusals.push({ rule: 'extra', message: `CPL Ref ${c.Ref} is on side "${c.Side}" — only top is handled` });

  // ── one lane per Mfr_PN (pnp ruling 3): lines sharing a part number merge ──
  const placed = (l: Line) => l.refs.filter((r) => cplRefs.has(r));
  counts.placedParts = lines.reduce((s, l) => s + placed(l).length, 0);
  const parts = new Map<string, Line>();
  for (const l of lines) {
    const p = parts.get(l.mfrPn);
    if (!p) parts.set(l.mfrPn, { ...l, refs: [...l.refs] });
    else if (p.pkg !== l.pkg)
      refusals.push({ rule: 'extra', message: `Mfr_PN ${l.mfrPn} is listed as ${p.pkg} and as ${l.pkg}` });
    else {
      p.refs.push(...l.refs);
      if (!p.value.split(' / ').includes(l.value)) p.value += ` / ${l.value}`;
    }
  }

  // ── assign parts to lanes by tape; 1 (no lane) and 2 (not enough lanes) ───
  // A part whose need exceeds one lane SPILLS into further lanes of a fitting tray
  // (pnp 09-27-11: the OpenPnP fork fails over from an empty BlindsFeeder lane to
  // the next lane holding the same part). Lanes fill in tray order. No ordering rule.
  const trays = input.trays.filter((t) => t.variant in vspec);
  const used = new Map(trays.map((t) => [t.trayId, 0]));
  const lanes: LaneRow[] = [];
  const lanesNeeded = new Map<string, number>();
  for (const l of parts.values()) {
    const o = overrides[l.mfrPn];
    const fits = o ? [o.variant] : FIT[l.pkg];
    if (!fits) {
      refusals.push({
        rule: '3',
        message: `${l.refs.join(',')} (${l.pkg}, ${l.mfrPn}): no tape known for this package — add a Mfr_PN override, or mark the row in the BOM`,
      });
      continue;
    }
    const need = placed(l).length * input.boards;
    const tape = o ? 'override' : fits.length > 1 ? 'default-ambiguous' : 'default';
    // Lanes this part would need on its FIRST fitting variant — counted whether or
    // not the trays on hand have them, so the summary says how many trays to print.
    const capOf = (v: Variant) => laneCapacity(vspec, v, o?.pocketPitchMm);
    lanesNeeded.set(fits[0], (lanesNeeded.get(fits[0]) ?? 0) + Math.max(1, Math.ceil(need / capOf(fits[0]))));
    let left = need;
    const mine: LaneRow[] = [];
    do {
      // 🔴 ONE reel is paper OR embossed, never both. Once a lane is chosen, the spill
      // stays on THAT variant: 400 C0805 spilled from 8paper lanes into 8emb lanes while
      // the warning said only "put in 8paper" (bughunt 2026-11-15).
      const allowed = mine.length ? [mine[0].variant] : fits;
      const tray = allowed
        .flatMap((v) => trays.filter((t) => t.variant === v))
        .find((t) => used.get(t.trayId)! < vspec[t.variant].lanes);
      if (!tray) break;
      used.set(tray.trayId, used.get(tray.trayId)! + 1);
      const cap = capOf(tray.variant);
      mine.push({
        trayId: tray.trayId,
        lane: used.get(tray.trayId)!,
        variant: tray.variant,
        mfrPn: l.mfrPn,
        value: l.value,
        pkg: l.pkg,
        refs: l.refs,
        need: Math.min(left, cap),
        capacity: cap,
        tape,
        swapUndetectable: false,
      });
      left -= cap;
    } while (left > 0);
    if (!mine.length) {
      refusals.push({
        rule: '1',
        message: `${l.refs.join(',')} (${l.value}, ${l.pkg}): no free lane in a ${fits.join('/')} tray`,
      });
      continue;
    }
    if (left > 0)
      refusals.push({
        rule: '2',
        message: `${l.mfrPn} (${l.value}, ${l.pkg}): need ${need}, ${mine.length} lane(s) free hold ${need - left} (${mine
          .map((m) => `tray ${m.trayId} lane ${m.lane}`)
          .join(', ')}) — short ${left}`,
      });
    if (mine.length > 1)
      warnings.push(
        `${l.mfrPn} (${l.value}, ${l.pkg}) is split over ${mine.length} lanes: ${mine.map((m) => m.need).join(' + ')} — check the last lane is worth a lane`
      );
    if (o && o.verified === false)
      warnings.push(`${l.mfrPn} (${l.pkg}): tape unverified — ${o.source ?? 'no source given'}`);
    if (tape === 'default-ambiguous')
      warnings.push(
        `${l.mfrPn} (${l.value}, ${l.pkg}): put in ${mine[0].variant}, but ${l.pkg} comes on ${fits.join(' or ')} depending on part height — confirm the reel or add an override`
      );
    lanes.push(...mine);
  }

  // ── warn: same package, different value = a swap the camera cannot see ────
  const valsByPkg = new Map<string, Set<string>>();
  for (const r of lanes) (valsByPkg.get(r.pkg) ?? valsByPkg.set(r.pkg, new Set()).get(r.pkg)!).add(r.value);
  for (const r of lanes) r.swapUndetectable = valsByPkg.get(r.pkg)!.size > 1;
  for (const [p, vs] of valsByPkg)
    if (vs.size > 1) warnings.push(`${p}: ${vs.size} values (${[...vs].join(', ')}) — swap undetectable by camera`);

  // Read by a person loading trays: tray by tray, lane by lane — not in BOM order.
  const order = new Map(trays.map((t, i) => [t.trayId, i]));
  lanes.sort((x, y) => order.get(x.trayId)! - order.get(y.trayId)! || x.lane - y.lane);
  const traysUsed = trays.filter((t) => used.get(t.trayId)! > 0).map((t) => t.trayId);
  const summary: PreflightResult['lanesNeeded'] = {};
  for (const [v, n] of lanesNeeded) summary[v] = { lanes: n, trays: Math.ceil(n / vspec[v].lanes) };
  return out(refusals.length ? 1 : 0, lanes, traysUsed, summary);
}
