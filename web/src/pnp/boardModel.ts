// THE BOARD AS THE PnP 3D VIEW DRAWS IT — pure, no three.js, no Vite, so a node
// test can drive it.
//
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 WHAT THIS DOES NOT KNOW
// ═══════════════════════════════════════════════════════════════════════════
//
// · THE BOARD OUTLINE. A CPL carries part centres, not Edge.Cuts. The plate drawn
//   under the parts is the EXTENT OF THE PART CENTRES plus a margin, and it is
//   labelled that way on screen. Reading the real outline means parsing the
//   `.kicad_pcb`, which `pnp`'s `board_geometry.py` does in Python; nothing here
//   copies that parser.
// · BODY SIZES. A CPL has no body dimensions. A size comes from (1) the small
//   table below for packages whose size the name fixes (EIA chip codes, SOT-23,
//   SOIC-8 …), else (2) an `AxB` written in the package name itself, else (3) it
//   is UNKNOWN and drawn as a grey placeholder. Every part says which, and the
//   legend counts all three, so a guessed size is never shown as a measured one.

import { parseCsv } from './manifest';

export interface BodySize {
  l: number;
  w: number;
  h: number;
  /** `table` = nominal for the package family · `name` = read from the package
   *  name · `unknown` = a placeholder, nothing known. */
  from: 'table' | 'name' | 'unknown';
}

export interface BoardPart {
  ref: string;
  value: string;
  pkg: string;
  x: number;
  y: number;
  rot: number;
  side: 'top' | 'bottom';
  body: BodySize;
}

export interface BoardModel {
  parts: BoardPart[];
  /** Extent of the part centres, plus `PLATE_MARGIN_MM`. Not the board outline. */
  plate: { minX: number; minY: number; maxX: number; maxY: number };
  /** CPL rows that could not be placed (no number in PosX/PosY), by Ref. */
  unreadable: string[];
  sizes: Record<BodySize['from'], number>;
}

export const PLATE_MARGIN_MM = 3;

/** Nominal L × W × H (mm) by package family. Matched against the START of the
 *  CPL `Package` with the family's own spellings (`R0402`, `C 0805`, `0603 2-term`). */
const TABLE: [RegExp, number, number, number][] = [
  [/^(?:[RCL]\s?)?0402\b/, 1.0, 0.5, 0.35],
  [/^(?:[RCL]\s?)?0603\b/, 1.6, 0.8, 0.45],
  [/^(?:[RCL]\s?|Bead\s)?0805\b/, 2.0, 1.25, 0.6],
  [/^(?:[RCL]\s?|Fuse\s)?1206\b/, 3.2, 1.6, 0.6],
  [/^Fuse 1812\b/, 4.5, 3.2, 1.0],
  [/^R2512\b/, 6.3, 3.2, 0.6],
  [/^SOT-23-[356]\b/, 2.9, 1.6, 1.1],
  [/^SOT-223/, 6.5, 3.5, 1.6],
  [/^SOIC-8\b/, 4.9, 3.9, 1.5],
  [/^SOD-523\b|^TVS SOD-523/, 1.2, 0.8, 0.6],
  [/^SOD-123\b/, 2.7, 1.6, 1.1],
  [/^SMA\b/, 4.3, 2.6, 2.1],
  [/^SMB\b/, 4.3, 3.6, 2.2],
  [/^SMC\b/, 6.9, 5.9, 2.2],
  [/^TSSOP-16\b/, 5.0, 4.4, 1.1],
  [/^TSSOP-24\b/, 7.8, 4.4, 1.1],
];

export function bodySize(pkg: string): BodySize {
  const p = pkg.trim();
  for (const [re, l, w, h] of TABLE) if (re.test(p)) return { l, w, h, from: 'table' };
  // "… 9x9mm …", "… 7.8x5.4mm", "… 3.2x2.5mm", "LGA-8 2.5x2.5x0.93mm"
  const m = /(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)(?:\s*[x×]\s*(\d+(?:\.\d+)?))?\s*mm/i.exec(p);
  if (m) {
    const l = Number(m[1]);
    const w = Number(m[2]);
    if (l > 0 && w > 0 && l < 80 && w < 80) return { l, w, h: m[3] ? Number(m[3]) : 1, from: 'name' };
  }
  return { l: 2, w: 2, h: 0.5, from: 'unknown' };
}

/** A model from parts already positioned (e.g. `parts.ts`'s, every tier). */
export function modelFromParts<P extends BoardPart>(parts: P[], unreadable: string[] = []): BoardModel & { parts: P[] } {
  const sizes: BoardModel['sizes'] = { table: 0, name: 0, unknown: 0 };
  for (const p of parts) sizes[p.body.from]++;
  const xs = parts.map((p) => p.x);
  const ys = parts.map((p) => p.y);
  const plate = parts.length
    ? {
        minX: Math.min(...xs) - PLATE_MARGIN_MM,
        minY: Math.min(...ys) - PLATE_MARGIN_MM,
        maxX: Math.max(...xs) + PLATE_MARGIN_MM,
        maxY: Math.max(...ys) + PLATE_MARGIN_MM,
      }
    : { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { parts, plate, unreadable, sizes };
}

export function boardModel(cplCsv: string): BoardModel {
  const parts: BoardPart[] = [];
  const unreadable: string[] = [];
  const sizes: BoardModel['sizes'] = { table: 0, name: 0, unknown: 0 };
  for (const r of parseCsv(cplCsv)) {
    const x = Number(r.PosX);
    const y = Number(r.PosY);
    // Rotation too: an empty or unreadable `Rot` was read as 0° (`|| 0`).
    if (r.PosX === '' || r.PosY === '' || !Number.isFinite(x) || !Number.isFinite(y) || (r.Rot ?? '').trim() === '' || !Number.isFinite(Number(r.Rot))) {
      unreadable.push(r.Ref || '(no Ref)');
      continue;
    }
    const body = bodySize(r.Package ?? '');
    sizes[body.from]++;
    parts.push({
      ref: r.Ref,
      value: r.Val ?? '',
      pkg: r.Package ?? '',
      x,
      y,
      rot: Number(r.Rot),
      side: (r.Side ?? '').toLowerCase() === 'bottom' ? 'bottom' : 'top',
      body,
    });
  }
  const xs = parts.map((p) => p.x);
  const ys = parts.map((p) => p.y);
  const plate = parts.length
    ? {
        minX: Math.min(...xs) - PLATE_MARGIN_MM,
        minY: Math.min(...ys) - PLATE_MARGIN_MM,
        maxX: Math.max(...xs) + PLATE_MARGIN_MM,
        maxY: Math.max(...ys) + PLATE_MARGIN_MM,
      }
    : { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { parts, plate, unreadable, sizes };
}

/**
 * A top-down SVG of the board as a `data:` URL, for a catalogue card: the plate
 * (part extent, NOT the outline — same caveat as the 3D view) and every part as
 * its body rectangle, rotated. Bottom-side parts are drawn hollow. Colours are
 * fixed because a `data:` image cannot read CSS variables.
 */
export function boardThumbnailSvg(m: BoardModel, px = 240): string {
  const { minX, minY, maxX, maxY } = m.plate;
  const w = maxX - minX || 1;
  const h = maxY - minY || 1;
  const s = (px - 8) / Math.max(w, h);
  const W = Math.round(w * s + 8);
  const H = Math.round(h * s + 8);
  const f = (n: number) => n.toFixed(1);
  // KiCad's CPL Y is up; SVG's is down — flip so the thumbnail matches the board.
  const rects = m.parts
    .map((p) => {
      const cx = 4 + (p.x - minX) * s;
      const cy = 4 + (maxY - p.y) * s;
      const bw = Math.max(1, p.body.l * s);
      const bh = Math.max(1, p.body.w * s);
      const fill = p.side === 'top' ? '#c47a14' : 'none';
      return `<rect x="${f(cx - bw / 2)}" y="${f(cy - bh / 2)}" width="${f(bw)}" height="${f(bh)}" fill="${fill}" stroke="#2a2a2a" stroke-width="0.5" transform="rotate(${f(-p.rot)} ${f(cx)} ${f(cy)})"/>`;
    })
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="3" fill="#3d6b4a"/>${rects}</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

/**
 * Where the board sits on the machine, for dragging it in the 3D view (founder
 * 2026-10-15: *"able to drag and drop the pcb on the 3d with mouse"*).
 *
 * `x`/`y` is the LOWER-LEFT corner of the part extent (the plate above), in
 * machine millimetres. The machine travel is `pnpMachines.ts`'s rail strokes,
 * which are NOT a placement area — so "inside" here means inside the strokes,
 * the only numbers `pnp` states. With no travel stated, nothing is checked and
 * the result says so (`checked: false`).
 */
export interface BoardPlacement {
  x: number;
  y: number;
  /** True when the asked position was moved to keep the board inside. */
  held: boolean;
  /** False when the board is bigger than the travel on some axis. */
  fits: boolean;
  checked: boolean;
}

export function placeOnTravel(
  asked: { x: number; y: number },
  size: { w: number; h: number },
  travel: { x: number; y: number } | null
): BoardPlacement {
  if (!travel) return { x: asked.x, y: asked.y, held: false, fits: true, checked: false };
  const fits = size.w <= travel.x && size.h <= travel.y;
  const clamp = (v: number, span: number, lim: number) => (span > lim ? 0 : Math.min(Math.max(v, 0), lim - span));
  const x = clamp(asked.x, size.w, travel.x);
  const y = clamp(asked.y, size.h, travel.y);
  return { x, y, held: x !== asked.x || y !== asked.y, fits, checked: true };
}

/** The board centred on the travel, or at the origin when no travel is known. */
export function defaultPlacement(size: { w: number; h: number }, travel: { x: number; y: number } | null): BoardPlacement {
  if (!travel) return placeOnTravel({ x: 0, y: 0 }, size, null);
  const p = placeOnTravel({ x: (travel.x - size.w) / 2, y: (travel.y - size.h) / 2 }, size, travel);
  return { ...p, held: false };
}
