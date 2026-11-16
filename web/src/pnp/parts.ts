// EVERY PART ON THE BOARD, AND WHO FITS IT — not only the ones the pick-and-place
// places. Founder 2026-10-15, on buck48_05: *"there are only 5 components
// needed?"* — the tab said "5 parts" because the CPL lists only the machine-placed
// rows; the board has 14 BOM parts, 9 of them fitted by hand.
//
// Sources, all `pcb`'s, read in place:
//   · BOM (`fab/<id>-bom.csv`) — the PARTS: refs, value, package, Mfr_PN, DNP and
//     the `Assembly` tier (or the `-pns.csv` sidecar's, joined on Mfr_PN);
//   · CPL (`fab/<id>-cpl.csv`) — positions of the machine-placed parts;
//   · `.kicad_pcb` — positions of every OTHER footprint (the CPL leaves the hand
//     parts out). KiCad's page Y runs down; the CPL's and the gerbers' run up, so
//     a footprint at (x, y) is drawn at (x, −y) — checked against the CPL for the
//     parts that are in both (tests/pnp-ask.test.ts).
//
// A footprint that is not in the BOM (fiducials, mounting holes, test points) is
// not a part and is not listed; it is counted as `nonParts`.

import { bodySize, type BoardPart } from './boardModel';
import { assemblyFromSidecar, parseCsv } from './manifest';

/** Who fits the part. `machine` = our pick-and-place (the Assembly tiers it places). */
export type By = 'machine' | 'hand-tht' | 'hand' | 'fab' | 'not-placed' | 'dnp' | 'unknown';

export const BY_LABEL: Record<By, string> = {
  machine: 'PnP',
  'hand-tht': 'hand (THT)',
  hand: 'hand',
  fab: 'by the fab',
  'not-placed': 'not placed',
  dnp: 'DNP',
  unknown: 'tier unknown',
};

/**
 * 🔴 A CPL row is a POSITION only when X, Y AND rotation all read as numbers. Only PosX was
 * checked for empty, and `Number('')` is 0: a row with no exported Y was placed at y = 0
 * and G-CPL passed it; an empty or unreadable rotation became 0° by `|| 0` (bughunt
 * 2026-11-15). Such a row is not a position — the part falls back to the board file or is
 * listed unplaced, by name.
 */
function cplXY(c: { PosX?: string; PosY?: string; Rot?: string }): boolean {
  const num = (v: string | undefined) => v !== undefined && v.trim() !== '' && Number.isFinite(Number(v));
  return num(c.PosX) && num(c.PosY) && num(c.Rot);
}

export function byOfTier(tier: string, dnp: boolean): By {
  if (dnp) return 'dnp';
  switch (tier.trim()) {
    case '':
    case 'INHOUSE':
    case 'INHOUSE-STENCIL':
      return 'machine';
    case 'THT-HAND':
      return 'hand-tht';
    case 'HAND':
      return 'hand';
    case 'JLCPCB':
      return 'fab';
    case 'NOT-PLACED':
      return 'not-placed';
    default:
      return 'unknown';
  }
}

export interface ModelRef {
  path: string;
  offset: [number, number, number];
  scale: [number, number, number];
  rotate: [number, number, number];
}

export interface Footprint {
  ref: string;
  footprint: string;
  side: 'top' | 'bottom';
  /** In the CPL / gerber frame: x, and −(KiCad page y). */
  x: number;
  y: number;
  rot: number;
  models: ModelRef[];
  /** Pad types in this footprint: through-hole vs surface (np_thru_hole holes are neither). */
  pads: { tht: number; smd: number };
}

const num3 = (s: string | undefined): [number, number, number] => {
  const v = (s ?? '').trim().split(/\s+/).map(Number);
  return [v[0] || 0, v[1] || 0, v[2] || 0];
};

/** Every top-level footprint of a `.kicad_pcb`, by its reference. */
export function parseKicadFootprints(text: string): Footprint[] {
  const out: Footprint[] = [];
  const starts: number[] = [];
  // Footprints are only ever top-level in a .kicad_pcb, so ANY indent is one:
  // two spaces (older writer), a tab (KiCad 9), or none (hbs57_usb6 has a
  // footprint pasted at column 0 — missed by an indent-anchored match).
  const re = /\n[ \t]*\(footprint "/g;
  for (let m = re.exec(text); m; m = re.exec(text)) starts.push(m.index + 1);
  for (let i = 0; i < starts.length; i++) {
    const blk = text.slice(starts[i], i + 1 < starts.length ? starts[i + 1] : text.length);
    const head = /^[ \t]*\(footprint "([^"]*)"[\s\S]*?\(layer "([^"]+)"\)[\s\S]*?\(at ([-\d.]+) ([-\d.]+)(?: ([-\d.]+))?\)/.exec(blk);
    const ref = /\(fp_text reference "([^"]*)"|\(property "Reference" "([^"]*)"/.exec(blk);
    if (!head || !ref) continue;
    const models: ModelRef[] = [];
    // Two writers: one line "(offset (xyz …)) (scale …) (rotate …)" or KiCad 9's
    // one-token-per-line nesting — whitespace is free in both.
    const mre = /\(model "([^"]+)"([\s\S]{0,600}?\(rotate\s*\(xyz\s[^)]*\)\s*\))/g;
    for (let m = mre.exec(blk); m; m = mre.exec(blk)) {
      const body = m[2];
      models.push({
        path: m[1],
        offset: num3(/\(offset\s*\(xyz\s([^)]*)\)/.exec(body)?.[1]),
        scale: num3(/\(scale\s*\(xyz\s([^)]*)\)/.exec(body)?.[1] ?? '1 1 1'),
        rotate: num3(/\(rotate\s*\(xyz\s([^)]*)\)/.exec(body)?.[1]),
      });
    }
    const padTypes = [...blk.matchAll(/\(pad\s+(?:"[^"]*"|\S+)\s+(thru_hole|smd|np_thru_hole|connect)\b/g)].map((m) => m[1]);
    out.push({
      ref: ref[1] ?? ref[2],
      footprint: head[1],
      pads: { tht: padTypes.filter((t) => t === 'thru_hole').length, smd: padTypes.filter((t) => t === 'smd').length },
      side: head[2].startsWith('B.') ? 'bottom' : 'top',
      x: Number(head[3]),
      y: -Number(head[4]),
      rot: Number(head[5] ?? 0) || 0,
      models,
    });
  }
  return out;
}

export interface PartRow extends BoardPart {
  by: By;
  mfrPn: string;
  /** Where the position came from. */
  from: 'cpl' | 'kicad_pcb';
  /** True when the .kicad_pcb was read and EVERY pad of this part's footprint is
   *  thru_hole (undefined when no .kicad_pcb, or the footprint was not found). */
  allThroughHole?: boolean;
}

export interface BoardParts {
  /** Parts with a position, every tier. */
  parts: PartRow[];
  /** BOM parts with no position anywhere (no CPL row, no footprint). */
  unplaced: { ref: string; value: string; pkg: string; by: By }[];
  /** BOM parts per tier (with or without a position). */
  counts: Record<By, number>;
  /** Machine-placed parts per side. */
  machineSides: { top: number; bottom: number };
  /** Footprints on the board that are not BOM parts (fiducials, holes, test points). */
  nonParts: number;
  total: number;
}

const truthy = (s: string | undefined) => !!s && !/^(|0|no|false|n)$/i.test(s.trim());

/** pcb's stand-in models are named by their size: `box_8.50x10.00x10.00.step`
 *  = 8.5 × 10 × 10 mm. When a footprint carries one, that is pcb's own statement
 *  of the body, and it beats a guess from the package name. */
export function bodyFromModels(models: ModelRef[]): BoardPart['body'] | null {
  for (const m of models) {
    const b = /\/box_([\d.]+)x([\d.]+)x([\d.]+)\.(step|stp|wrl)$/i.exec(m.path);
    if (b) return { l: Number(b[1]), w: Number(b[2]), h: Number(b[3]), from: 'name' };
  }
  return null;
}

export function boardParts(input: { bom: string; cpl: string; sidecar?: string; kicad?: string }): BoardParts {
  const bom = parseCsv(input.bom);
  const cpl = new Map(parseCsv(input.cpl).map((r) => [r.Ref, r]));
  const fps = input.kicad ? parseKicadFootprints(input.kicad) : [];
  const fpBy = new Map(fps.map((f) => [f.ref, f]));
  const side = input.sidecar ? assemblyFromSidecar(input.sidecar).map : {};
  const counts = Object.fromEntries(Object.keys(BY_LABEL).map((k) => [k, 0])) as Record<By, number>;
  const parts: PartRow[] = [];
  const unplaced: BoardParts['unplaced'] = [];
  const bomRefs = new Set<string>();
  for (const r of bom) {
    const tier = 'Assembly' in r ? r.Assembly : side[r.Mfr_PN] ?? '';
    const by = byOfTier(tier ?? '', truthy(r.DNP));
    for (const ref of (r.Reference ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
      bomRefs.add(ref);
      counts[by]++;
      const c = cpl.get(ref);
      const f = fpBy.get(ref);
      const pkg = c?.Package || r.Package || f?.footprint || '';
      if (c && cplXY(c)) {
        parts.push({
          ref,
          value: c.Val || r.Value,
          pkg,
          x: Number(c.PosX),
          y: Number(c.PosY),
          rot: Number(c.Rot),
          side: (c.Side ?? '').toLowerCase() === 'bottom' ? 'bottom' : 'top',
          body: (f && bodyFromModels(f.models)) || bodySize(pkg),
          by,
          mfrPn: r.Mfr_PN ?? '',
          from: 'cpl',
          ...(f ? { allThroughHole: f.pads.tht > 0 && f.pads.smd === 0 } : {}),
        });
      } else if (f) {
        parts.push({
          ref,
          value: r.Value,
          pkg,
          x: f.x,
          y: f.y,
          rot: f.rot,
          side: f.side,
          body: bodyFromModels(f.models) || bodySize(pkg),
          by,
          mfrPn: r.Mfr_PN ?? '',
          from: 'kicad_pcb',
          allThroughHole: f.pads.tht > 0 && f.pads.smd === 0,
        });
      } else unplaced.push({ ref, value: r.Value, pkg, by });
    }
  }
  // A CPL row the BOM does not name is still a placed part (preflight refuses it,
  // by name, as rule 5); shown so the 3D and the list agree with the CPL.
  for (const [ref, c] of cpl)
    if (!bomRefs.has(ref) && cplXY(c))
      parts.push({
        ref,
        value: c.Val,
        pkg: c.Package,
        x: Number(c.PosX),
        y: Number(c.PosY),
        rot: Number(c.Rot),
        side: (c.Side ?? '').toLowerCase() === 'bottom' ? 'bottom' : 'top',
        body: bodySize(c.Package),
        by: 'machine',
        mfrPn: '',
        from: 'cpl',
      });
  const machine = parts.filter((p) => p.by === 'machine');
  return {
    parts,
    unplaced,
    counts,
    machineSides: { top: machine.filter((p) => p.side === 'top').length, bottom: machine.filter((p) => p.side === 'bottom').length },
    nonParts: fps.filter((f) => !bomRefs.has(f.ref) && !cpl.has(f.ref)).length,
    total: [...bomRefs].length,
  };
}

/** "14 parts: 5 by machine (bottom), 9 by hand" — the count line. */
export function countLine(b: Pick<BoardParts, 'counts' | 'machineSides' | 'total'>): string {
  const c = b.counts;
  const placed = b.machineSides.top + b.machineSides.bottom;
  const sides = !placed
    ? ''
    : b.machineSides.top && b.machineSides.bottom
      ? `${b.machineSides.top} top, ${b.machineSides.bottom} bottom`
      : b.machineSides.bottom
        ? 'bottom'
        : 'top';
  const bits = [`${c.machine} by machine${sides ? ` (${sides})` : ''}`];
  const hand = c['hand-tht'] + c.hand;
  if (hand) bits.push(`${hand} by hand${c['hand-tht'] ? ` (${c['hand-tht']} THT)` : ''}`);
  if (c.fab) bits.push(`${c.fab} by the fab`);
  if (c['not-placed']) bits.push(`${c['not-placed']} not placed`);
  if (c.dnp) bits.push(`${c.dnp} DNP`);
  if (c.unknown) bits.push(`${c.unknown} tier unknown`);
  return `${b.total} parts: ${bits.join(', ')}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// THE ASSEMBLY SEQUENCE — founder 2026-10-16: *"On the pnp order the components
// based how those components should be soldered / placed"*.
//
//   0. at the fab (JLCPCB-placed parts arrive fitted)
//   1. machine SMD, FIRST reflow side      ┐ within a side: chip passives small
//   2. machine SMD, second reflow side     ┘ → large, then discretes, ICs, tall
//   3. hand, THT — by height, lowest first (so the board rests flat on the
//      parts already fitted while soldering the next)
//   4. hand (not THT)
//   5. not fitted (DNP / not placed)
//
// THE SIDE ORDER comes from pcb's assembly notes where pcb has ruled it, cited
// by path (`SIDE_RULINGS`); otherwise from a stated heuristic: the side with
// FEWER machine parts reflows first (the lighter side is the one that hangs
// upside down through the second reflow). Every group says which basis it used.
// ⚠ Height is the part's body height when known (package table / name / model);
// unknown heights sort after known ones, in reference order — said, not guessed.
// ═══════════════════════════════════════════════════════════════════════════

export const SIDE_RULINGS: Record<string, { first: 'top' | 'bottom'; status: 'ruled' | 'provisional'; source: string }> = {
  sensor_pod_v3_io: {
    first: 'top',
    status: 'ruled',
    source: 'hardware/pcb/sensor_pod_v3/fab/io/sensor_pod_v3_io-assembly-notes.md §1 (pcb 2026-09-06: TOP first, unconditional — open-port MEMS mic)',
  },
  pico_zero_carrier: {
    first: 'top',
    status: 'provisional',
    source: 'hardware/pcb/pico_zero_carrier/fab/pico_zero_carrier-assembly-notes.md §1 (TOP first, PROVISIONAL pending the piezo’s weighing)',
  },
};

/** Placement rank within a reflow side: chip passives by size, then discretes, ICs, everything else. */
export function placementRank(pkg: string): number {
  const p = pkg.trim();
  const chip = /(?:^|[^0-9])(0201|0402|0603|0805|1206|1210|1812|2010|2512)(?:[^0-9]|$)/.exec(p);
  if (chip && /^(?:[RCLF]\s?|Fuse\s|Bead\s)?\d{4}\b|^\d{4} 2-term/.test(p)) return 10 + ['0201', '0402', '0603', '0805', '1206', '1210', '1812', '2010', '2512'].indexOf(chip[1]);
  if (/^(SOD|SOT|SC-|SMA|SMB|SMC|TVS|DO-)/i.test(p)) return 30;
  if (/(SOIC|SOP|SSOP|TSSOP|MSOP|VSSOP|HSOP|QFN|WQFN|VQFN|DFN|USON|LGA|BGA|QFP)/i.test(p)) return 40;
  return 50;
}

export interface SequenceGroup {
  /** "1. Top reflow · machine" */
  title: string;
  basis: string;
  refs: string[];
}

export function assemblySequence(boardId: string, parts: PartRow[]): SequenceGroup[] {
  const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  const h = (p: PartRow) => (p.body.from === 'unknown' ? Infinity : p.body.h);
  const byHeight = (a: PartRow, b: PartRow) => h(a) - h(b) || natural.compare(a.ref, b.ref);
  const byPlacement = (a: PartRow, b: PartRow) =>
    placementRank(a.pkg) - placementRank(b.pkg) || byHeight(a, b);
  const machine = parts.filter((p) => p.by === 'machine');
  const top = machine.filter((p) => p.side === 'top');
  const bottom = machine.filter((p) => p.side === 'bottom');
  const ruling = SIDE_RULINGS[boardId];
  let first: 'top' | 'bottom';
  let sideBasis: string;
  if (ruling) {
    first = ruling.first;
    sideBasis = `${ruling.status === 'ruled' ? 'pcb’s ruling' : 'pcb’s PROVISIONAL ruling'}: ${ruling.source}`;
  } else if (top.length && bottom.length) {
    first = bottom.length <= top.length ? 'bottom' : 'top';
    sideBasis = `no ruling in pcb’s notes; heuristic: the side with fewer machine parts (${Math.min(top.length, bottom.length)} vs ${Math.max(top.length, bottom.length)}) reflows first, so the lighter side is the one that hangs in the second pass`;
  } else {
    first = bottom.length ? 'bottom' : 'top';
    sideBasis = 'single-sided machine placement';
  }
  const sides = first === 'top' ? (['top', 'bottom'] as const) : (['bottom', 'top'] as const);
  const fab = parts.filter((p) => p.by === 'fab');
  const out: { label: string; basis: string; parts: PartRow[] }[] = [];
  if (fab.length) out.push({ label: 'At the fab · already fitted', basis: 'Assembly = JLCPCB (pcb’s tier)', parts: [...fab].sort(byPlacement) });
  sides.forEach((s, i) => {
    const list = s === 'top' ? top : bottom;
    if (list.length)
      out.push({
        label: `${s === 'top' ? 'Top' : 'Bottom'} reflow${machine.length !== list.length ? (i === 0 ? ' (first)' : ' (second)') : ''} · machine`,
        basis: `${sideBasis} · within the side: chip passives smallest first, then discretes, ICs, then the rest by height`,
        parts: [...list].sort(byPlacement),
      });
  });
  const tht = parts.filter((p) => p.by === 'hand-tht');
  for (const s of ['top', 'bottom'] as const) {
    const list = tht.filter((p) => p.side === s);
    if (list.length)
      out.push({
        label: `${s === 'top' ? 'Top' : 'Bottom'} · hand, THT`,
        basis: 'after reflow; lowest first so the board rests flat (height from the package when known, unknown last)',
        parts: [...list].sort(byHeight),
      });
  }
  const hand = parts.filter((p) => p.by === 'hand');
  if (hand.length) out.push({ label: 'Hand-fitted', basis: 'Assembly = HAND; lowest first', parts: [...hand].sort(byHeight) });
  const rest = parts.filter((p) => p.by === 'dnp' || p.by === 'not-placed' || p.by === 'unknown');
  if (rest.length) out.push({ label: 'Not fitted / tier unknown', basis: 'DNP, NOT-PLACED or an Assembly tier this tool does not know', parts: [...rest].sort((a, b) => natural.compare(a.ref, b.ref)) });
  return out.map((g, i) => ({ title: `${i + 1}. ${g.label}`, basis: g.basis, refs: g.parts.map((p) => p.ref) }));
}
