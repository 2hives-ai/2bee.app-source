/**
 * cad's gates (founder 2026-10-16: "do the same on the cad"): is the design on
 * screen fit to send to cnc or 3d? Three states, PENDING is not a pass, same
 * contract as cnc/runGates.ts. They gate "Open in cnc" / "Open in 3d".
 *
 * WHY: 2026-10-16 an AI edit "lost an operand" of a difference() (the audit said
 * so, in a sentence), the design was sent to cnc anyway and refused there. A
 * design that does not parse, drops constructs, or does not mesh closed is the
 * wrong part before any machine sees it.
 */
import type { MeshResult } from './mesh';
import type { ScadResult } from './scad';

export type CadGateState = 'PASS' | 'FAIL' | 'PENDING';
export interface CadGate {
  id: 'parse' | 'complete' | 'mesh' | 'cnc' | 'print';
  name: string;
  guards: string;
  state: CadGateState;
  why: string;
}

/** Thickest panel a cnc job here is planned from: a part thicker than this is not a flat sheet part. */
export const CNC_MAX_THICKNESS_MM = 40;

function extents(m: MeshResult): [number, number, number] | null {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of m.parts) {
    if (p.dim !== 3) continue;
    for (let i = 0; i < p.positions.length; i += 3) for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], p.positions[i + k]);
      hi[k] = Math.max(hi[k], p.positions[i + k]);
    }
  }
  return Number.isFinite(lo[0]) ? [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]] : null;
}

/**
 * Founder 2026-10-16: "On cad have the user notified somehow if the object(s)
 * are not possible to cnc or 3d print". Two coarse, honest checks; each gates
 * only its own "Open in …" button:
 *   cnc   — a flat part: its thinnest extent is at most CNC_MAX_THICKNESS_MM (laid
 *           flat on that side, as Open in cnc does). It does NOT prove every
 *           feature is cuttable from above; the cnc planner says that.
 *   print — fits the build volume of a 3D printer declared in machines, in some
 *           axis-aligned orientation. No printer declared -> PENDING.
 */
export function cadGates(i: { parse: ScadResult; mesh: MeshResult; building: boolean; printers?: { name: string; build: [number, number, number] }[] }): CadGate[] {
  // Every unsupported construct is REFUSED by the parser (scad.ts): it is missing from the part.
  const refused = i.parse.unsupported;
  return [
    {
      id: 'parse',
      name: 'The source reads',
      guards: 'a design with errors producing a part nobody wrote',
      ...(i.parse.errors.length
        ? { state: 'FAIL' as const, why: `${i.parse.errors.length} error(s); first: ${i.parse.errors[0].message} (line ${i.parse.errors[0].line}).` }
        : { state: 'PASS' as const, why: 'No errors.' }),
    },
    {
      id: 'complete',
      name: 'Every construct is drawn',
      guards: 'a construct the app cannot draw silently missing from the part',
      ...(refused.length
        ? { state: 'FAIL' as const, why: `Not drawn: ${[...new Set(refused.map((u) => u.name))].join(', ')} (line ${refused[0].line}).` }
        : { state: 'PASS' as const, why: 'Nothing refused.' }),
    },
    {
      id: 'mesh',
      name: 'The solid is closed and trusted',
      guards: 'a hole in the mesh, or a boolean that lost an operand, becoming the cut or printed part',
      ...(i.building
        ? { state: 'PENDING' as const, why: 'The model is still updating.' }
        : i.mesh.trust === 'trusted'
          ? { state: 'PASS' as const, why: 'Every solid is watertight and nothing was altered.' }
          : i.mesh.trust === 'nothing' && i.parse.scene.children.length === 0 && !i.parse.errors.length && !refused.length
            ? /* Founder 2026-11-13, after New: an empty design has nothing to check yet. It is
               * not a failing solid; a design that DRAWS nothing from what it wrote still fails. */
              { state: 'PENDING' as const, why: 'Empty design: nothing to check yet.' }
            : i.mesh.trust === 'nothing'
            ? { state: 'FAIL' as const, why: 'Nothing is drawn.' }
            : { state: 'FAIL' as const, why: 'The mesh audit does not stand behind this solid (see the warning on the picture).' }),
    },
    ...targetGates(i),
  ];
}

function targetGates(i: { mesh: MeshResult; building: boolean; printers?: { name: string; build: [number, number, number] }[] }): CadGate[] {
  const e = i.building ? null : extents(i.mesh);
  const sorted = e ? [...e].sort((a, b) => a - b) : null;
  const fmt = (v: number[]) => v.map((x) => Math.round(x)).join(' x ');
  const cnc: CadGate = {
    id: 'cnc',
    name: 'Can be cut on the cnc',
    guards: 'sending a 3D object to a 2.5D router that cuts flat parts from one workpiece',
    ...(!sorted
      ? { state: 'PENDING' as const, why: i.building ? 'The model is still updating.' : 'Nothing is drawn.' }
      : sorted[0] > CNC_MAX_THICKNESS_MM
        ? { state: 'FAIL' as const, why: `Thinnest side ${Math.round(sorted[0])} mm: thicker than a ${CNC_MAX_THICKNESS_MM} mm workpiece, so it is not a flat part. Print it, or split it into flat panels.` }
        : { state: 'PASS' as const, why: `Flat part: ${fmt(sorted.slice().reverse())} mm, cut from ${Math.round(sorted[0])} mm stock.` }),
  };
  const fits = (b: [number, number, number]) => {
    if (!sorted) return false;
    const bs = [...b].sort((x, y) => x - y);
    return sorted.every((v, k) => v <= bs[k] + 1e-6);
  };
  const ok = (i.printers ?? []).filter((p) => fits(p.build));
  const print: CadGate = {
    id: 'print',
    name: 'Fits a 3D printer',
    guards: 'sending a part bigger than any declared printer can build',
    ...(!sorted
      ? { state: 'PENDING' as const, why: i.building ? 'The model is still updating.' : 'Nothing is drawn.' }
      : !(i.printers ?? []).length
        ? { state: 'PENDING' as const, why: 'No 3D printer is declared in machines (3d), so the size cannot be checked.' }
        : ok.length
          ? { state: 'PASS' as const, why: `${fmt(sorted.slice().reverse())} mm fits ${ok.map((p) => p.name).join(', ')}.` }
          : { state: 'FAIL' as const, why: `${fmt(sorted.slice().reverse())} mm does not fit any declared printer (largest: ${(i.printers ?? []).map((p) => `${p.name} ${fmt(p.build)}`).join('; ')}). Split it into parts.` }),
  };
  return [cnc, print];
}

/**
 * Send to `target` when every DESIGN gate PASSES and THAT target's gate does not
 * FAIL (PENDING there = "could not check here", e.g. no printer declared; the
 * target tab runs its own checks before anything reaches a machine).
 */
export const cadMaySend = (g: readonly CadGate[], target: 'cnc' | '3d') =>
  g.every((x) =>
    x.id === 'cnc' ? target !== 'cnc' || x.state !== 'FAIL' : x.id === 'print' ? target !== '3d' || x.state !== 'FAIL' : x.state === 'PASS',
  );
