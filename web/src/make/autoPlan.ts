// The Make step's automatic plan for a CNC design: design → flat STL → the
// core's EXISTING import plan → setup facts read off the emitted program.
//
// Founder 2026-10-14: *"Everything else is configured by AI"* — but the physical
// facts a human owns stay declared, never invented. So this file chooses only
// what follows from the design itself and says so for each choice:
//   · workpiece thickness and footprint — from the design's own size;
//   · section height — mid-thickness of the part laid flat;
//   · cutters — ONLY the cutters registered as owned in the Tools tab. With
//     none registered, nothing is planned: the step says to register them.
// Material is NOT chosen here: it is the operator's, and the core default is
// reported as such, never as a fact about this job.
//
// 🔴 ONE PLANNING PATH. `planImportBytes` is the same core call the CNC tab
// uses (K3/HOST parity); nothing here plans in TypeScript.
//
// 🔴 LAID FLAT FIRST. Several `_wcnc` designs are modelled standing on edge
// (`2bee_hive_box_panel_wcnc.scad` measures 19 × 407 × 80). A section at a Z
// height through an edge-standing part is a sliver, not the panel, and it would
// plan, simulate and gate green as a plausible wrong part. The mesh is rotated
// so its smallest extent is Z before anything is sectioned.

import type { MeshPart } from '../cad/mesh';
import { encodeBinaryStl } from '../cad/record';
import type { InventoryDoc } from '../inventory';
import type { JobConfig } from '../cam';

/** Clearance around the part for clamps, mm each side. Declared, not measured. */
export const CLAMP_MARGIN_MM = 20;

export interface FlatMesh {
  solids: { positions: Float32Array; triangles: number }[];
  /** Size after laying flat: [x, y, thickness]. */
  size: [number, number, number];
  /** Which original axis became Z (0 = X, 1 = Y, 2 = Z). */
  upAxis: 0 | 1 | 2;
}

/**
 * Lay a mesh flat: permute axes so the smallest extent is Z, then move it so
 * its footprint starts at (margin, margin) with the bottom face at z = 0. Axis
 * permutation only (a proper rotation: the axes are cycled, never mirrored), so
 * winding is kept.
 *
 * ⚠ The margin is applied HERE, in the mesh, because the import path takes
 * geometry where it lies: `drawing_offset` is deliberately not sent on it
 * (App.tsx, "THE JOB-LEVEL OFFSET IS NOT SENT ON THE IMPORT PATH").
 */
export function layFlat(parts: readonly Pick<MeshPart, 'positions' | 'triangles'>[], marginMm = 0): FlatMesh | null {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const p of parts) {
    for (let i = 0; i < p.positions.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const v = p.positions[i + k];
        if (v < min[k]) min[k] = v;
        if (v > max[k]) max[k] = v;
      }
    }
  }
  if (!Number.isFinite(min[0])) return null;
  const ext = [0, 1, 2].map((k) => max[k] - min[k]);
  const up = ext.indexOf(Math.min(...ext)) as 0 | 1 | 2;
  // Cyclic permutation that puts axis `up` last: (up+1, up+2, up).
  const order = [(up + 1) % 3, (up + 2) % 3, up];
  const solids = parts.map((p) => {
    const out = new Float32Array(p.positions.length);
    for (let i = 0; i < p.positions.length; i += 3) {
      for (let k = 0; k < 3; k++) out[i + k] = p.positions[i + order[k]] - min[order[k]] + (k < 2 ? marginMm : 0);
    }
    return { positions: out, triangles: p.triangles };
  });
  return { solids, size: [ext[order[0]], ext[order[1]], ext[order[2]]], upAxis: up };
}

/**
 * The parts a CNC job is cut from: closed 3D solids with triangles. 2D parts
 * are not material. EVERY lay-flat for the router goes through this, so the
 * Make step, 2bee.cnc and "Open in cnc" choose the same thinnest axis.
 */
export function cutSolids<T extends Pick<MeshPart, 'dim' | 'triangles'>>(parts: readonly T[]): T[] {
  return parts.filter((p) => p.dim === 3 && p.triangles > 0);
}

/** A workpiece: footprint `x × y` (with clamp margin) and thickness `t`, mm. */
export interface Workpiece {
  x: number;
  y: number;
  t: number;
}

/**
 * 🔴 THE ONE PLACE A CNC WORKPIECE IS DERIVED FROM A DESIGN. Thickness is the
 * laid-flat part's own Z extent; the footprint is its X/Y plus
 * {@link CLAMP_MARGIN_MM} each side. `null` when the part has no thickness.
 *
 * The Make step (`jobFor`), 2bee.cnc (`cncjob/plan.ts`, via `jobFor`) and the
 * expert cnc tab ("Open in cnc", `shop/toCnc.ts`) all take it from here. Until
 * 2026-11-12 the cnc tab took none and planned on its remembered thickness
 * (`cncStore` default 18): the Hive cleat (18 × 369 × 14) was planned 14 mm
 * thick on one screen and 18 mm on the other, and the 18 mm program reaches
 * Z-18 — 4 mm into the spoilboard under a 14 mm sheet.
 *
 * This states the stock the PROGRAM ASSUMES. It does not choose a material or
 * a sheet: whether a part is cut from its modelled thickness is cad's / bom's.
 */
export function workpieceFor(flat: Pick<FlatMesh, 'size'>): Workpiece | null {
  const [x, y, t] = flat.size;
  if (!(t > 0) || !Number.isFinite(t) || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  return {
    x: Math.ceil(x + 2 * CLAMP_MARGIN_MM),
    y: Math.ceil(y + 2 * CLAMP_MARGIN_MM),
    t: Math.round(t * 100) / 100,
  };
}

export function flatStl(flat: FlatMesh, title: string): Uint8Array {
  return encodeBinaryStl(flat.solids, `2bee.app make: ${title} (laid flat)`);
}

/**
 * Core tool ids the shop has registered as owned.
 *
 * ⚠ Keyed on the id being in the core's cutter list, NOT on `definition`: both
 * registration doors (`App.tsx::claimOwnership`, `registerCatalogueTool`) write
 * a list cutter with `definition: 'operator'`, so a `definition === 'catalogue'`
 * filter matched nothing (found 2026-10-14 by journey J7).
 */
export function ownedToolIds(doc: InventoryDoc | null, libraryIds: readonly string[]): string[] {
  if (!doc) return [];
  const lib = new Set(libraryIds);
  return doc.entries.filter((e) => e.kind === 'tool' && lib.has(e.id)).map((e) => e.id);
}

/** Registered cutters the core's list does not carry, which it cannot plan with yet. */
export function measuredOnlyTools(doc: InventoryDoc | null, libraryIds: readonly string[]): string[] {
  if (!doc) return [];
  const lib = new Set(libraryIds);
  return doc.entries.filter((e) => e.kind === 'tool' && !lib.has(e.id)).map((e) => e.label ?? e.id);
}

export type JobDecision =
  | { ok: true; config: JobConfig; sectionZ: number; chosen: string[] }
  | { ok: false; why: string };

/** The job for a design laid flat with {@link CLAMP_MARGIN_MM}, or why there is none. */
export function jobFor(flat: FlatMesh, toolIds: readonly string[]): JobDecision {
  if (!toolIds.length) {
    return {
      ok: false,
      why: 'No cutters are registered. Add the cutters you own under Expert tools → Tools, and the job will be planned with them.',
    };
  }
  const wp = workpieceFor(flat);
  if (!wp) return { ok: false, why: 'The design has no thickness, so there is nothing to cut.' };
  const { x: sx, y: sy, t: thickness } = wp;
  return {
    ok: true,
    sectionZ: thickness / 2,
    config: {
      stock: {
        size_x_mm: sx,
        size_y_mm: sy,
        thickness_mm: thickness,
        z_zero_at_top: true,
        origin_x_mm: 0,
        origin_y_mm: 0,
        rotation_deg: 0,
      },
      tool_ids: [...toolIds],
    },
    chosen: [
      `Workpiece ${sx} × ${sy} × ${thickness} mm: the design laid flat, plus ${CLAMP_MARGIN_MM} mm each side for clamps.`,
      `Outline taken at ${thickness / 2} mm, half the thickness.`,
      `Cutters: only the ${toolIds.length} you registered.`,
    ],
  };
}

export interface PlanSummary {
  ok: boolean;
  refusals: string[];
  tools: string[];
  toolChanges: number;
  deepestZ: number;
  seconds: number;
}

/** The parts of a core Report the Make step reads. */
export function summarise(r: { ok: boolean; refusals: string[]; tools_used: string[]; tool_changes: number; deepest_z_mm: number; estimated_seconds: number }): PlanSummary {
  return { ok: r.ok, refusals: r.refusals, tools: r.tools_used, toolChanges: r.tool_changes, deepestZ: r.deepest_z_mm, seconds: r.estimated_seconds };
}

/**
 * Checklist lines that come from the PLANNED job, replacing the generic ones.
 * `thickness` is the workpiece thickness the job was planned for.
 */
export function planSteps(p: PlanSummary, stock: { x: number; y: number; t: number }): { text: string; why: string }[] {
  const mm = (v: number) => (Math.round(v * 10) / 10).toString();
  const out = [
    {
      text: `Put in the workpiece: ${mm(stock.t)} mm thick, at least ${mm(stock.x)} × ${mm(stock.y)} mm.`,
      why: 'The size the job was planned for: the part laid flat plus room for clamps.',
    },
  ];
  if (p.tools.length) {
    out.push({
      text: `Fit ${p.tools[0]} first, and check it is tight in the collet.`,
      why: 'The first cutter in the planned program.',
    });
  }
  if (p.toolChanges > 0) {
    out.push({
      text: `The job stops ${p.toolChanges} time${p.toolChanges > 1 ? 's' : ''} for a tool change: ${p.tools.slice(1).join(', ')}. Swap the cutter when it stops, then resume.`,
      why: 'Each stop is a TOOL CHANGE pause in the planned program.',
    });
  }
  const depth = -p.deepestZ;
  out.push({
    text:
      depth > stock.t + 0.05
        ? `It cuts ${mm(depth - stock.t)} mm into the spoilboard. Check the spoilboard can take it.`
        : depth >= stock.t - 0.05
          ? 'It cuts right through the workpiece. Hold the parts down so they do not move at the end.'
          : `It cuts ${mm(depth)} mm deep, not all the way through.`,
    why: `Deepest cut in the planned program: Z ${mm(p.deepestZ)} mm, with Z zero on top of the workpiece.`,
  });
  return out;
}
