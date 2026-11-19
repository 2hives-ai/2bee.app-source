// One design file, several registered parts: the variants a design card can switch between.
//
// Founder 2026-11-20: "Can you create a Variable to switch to buck holder?". The CNC PCB holder
// (`2bee_cnc_table/cnc_pcb_holder_3d.scad`) is ONE file that makes THREE prints, chosen with
// `-D board="skr_pi" | "bucks" | "hbs57_usb6"`. The card built only the file's default (skr_pi),
// so the 2026-11-20 print from the card was the SKR + Pi holder whoever meant the bucks one.
//
// The variants are not invented here. cad registers them in `hardware/cad/fleet_parts.yaml`, one row
// per part, each with the `defines:` its print uses (43 such rows on 2026-11-20). A row of the same
// file WITHOUT defines is the file as it stands.
//
// 🔴 A variant is applied by rewriting the file's own top-level assignment (`setParam`), the same
// edit the Variables panel makes. A define this file does not assign at top level is REFUSED, not
// appended: OpenSCAD's -D and a later assignment do not mean the same thing, and a guessed override
// would build the default while the card names the variant.

import { scanParams, setParam, type ParamValue } from '../cad/params';

export interface Variant {
  /** The registered part name, e.g. `cnc_pcb_holder_bucks`. */
  part: string;
  /** name -> OpenSCAD literal text, exactly as fleet_parts.yaml writes it: `"bucks"`, `true`, `12`. */
  defines: Record<string, string>;
}

/** `{ board: '"bucks"', print_ready: true }` (the inside of fleet_parts' `defines:` braces) -> literal text per name. */
export function parseDefines(body: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  const re = /\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*('([^']*)'|"([^"]*)"|[^,\s}]+)\s*(,|$)/y;
  let i = 0;
  const s = body.trim();
  while (i < s.length) {
    re.lastIndex = i;
    const m = re.exec(s);
    if (!m) return null;
    // '…' holds the literal text ('"bucks"' -> "bucks"); "…" is YAML for a bare string; bare is a literal.
    out[m[1]] = m[3] !== undefined ? m[3] : m[4] !== undefined ? JSON.stringify(m[4]) : m[2];
    i = re.lastIndex;
  }
  return out;
}

function literalValue(text: string): ParamValue | undefined {
  const t = text.trim();
  if (t === 'true' || t === 'false') return t === 'true';
  if (/^[-+]?(?:\d+\.?\d*|\.\d+)$/.test(t)) return Number(t);
  if (/^"([^"\\]|\\.)*"$/.test(t)) return JSON.parse(t) as string;
  return undefined;
}

/** The source with the variant's defines written in, or why it cannot be. */
export function applyVariant(src: string, v: Variant): { ok: true; source: string } | { ok: false; why: string } {
  let out = src;
  for (const [name, text] of Object.entries(v.defines)) {
    const value = literalValue(text);
    if (value === undefined) return { ok: false, why: `${v.part}: ${name} = ${text} is not a literal this page can write` };
    const p = scanParams(out).params.find((q) => q.name === name);
    if (!p) return { ok: false, why: `${v.part}: this file has no top-level variable ${name} to set` };
    if (typeof p.value !== typeof value) return { ok: false, why: `${v.part}: ${name} is a ${typeof p.value} here, the part sets a ${typeof value}` };
    out = setParam(out, p, value);
  }
  return { ok: true, source: out };
}

/** Which variant the source is, by its current variable values; null when it matches none (edited by hand). */
export function currentVariant(src: string, variants: readonly Variant[]): Variant | null {
  const params = new Map(scanParams(src).params.map((p) => [p.name, p.value]));
  const hit = variants.filter((v) => Object.entries(v.defines).every(([n, t]) => params.get(n) === literalValue(t)));
  // A variant with no defines is "the file as it stands": it matches only when no other one does.
  return hit.find((v) => Object.keys(v.defines).length > 0) ?? hit[0] ?? null;
}

/** `cnc_pcb_holder_bucks` among `cnc_pcb_holder_*` -> `bucks`. */
export function variantLabel(v: Variant, all: readonly Variant[]): string {
  const names = all.map((x) => x.part);
  let pre = names[0] ?? '';
  for (const n of names) while (pre && !n.startsWith(pre)) pre = pre.slice(0, -1);
  const cut = pre.lastIndexOf('_') + 1;
  const label = v.part.slice(cut).replace(/_/g, ' ');
  return label || v.part;
}
