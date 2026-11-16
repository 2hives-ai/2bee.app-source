// Plan one catalogue design for 2bee.cnc — the SAME path the three-step Make
// screen uses (`make/MakeFlow.tsx::useRouterPlan`), composed from the same
// exported pieces, because that hook is not exported:
//
//   design → evaluate → `layFlat` (+ clamp margin) → `jobFor` (registered
//   cutters only) → the operator's material from the 2bee.cnc store →
//   `planImportBytes` (the core's import plan) → `setupFactsForImport` on the
//   same bytes, accepted only if its `gcode_sha256` equals the planned
//   program's SHA-256.
//
// Nothing here plans in TypeScript. An AI or chip change is a `JobPatch` laid
// over the config by `jobAsk.ts::candidateConfig` and re-planned by the core;
// the patch never touches G-code.

import { loadDesign, type ShopEntry } from '../shop/catalogue';
import { evaluateForMachine } from '../cad/machine';
import { makeLibraryHost, type ScadLibrary } from '../cad/library';
import { CLAMP_MARGIN_MM, cutSolids, flatStl, jobFor, layFlat, ownedToolIds, type FlatMesh } from '../make/autoPlan';
import { planImportBytes, setupFactsForImport, toolLibrary, type JobConfig, type Report, type SetupFacts } from '../cam';
import { readInventory } from '../inventory';
import { operatorMaterial } from '../jobMaterial';
import { machineConfig, shopFields, type MachineProfile } from './machines';
import { useCncStore } from '../store/cncStore';
import { candidateConfig, type JobPatch } from '../cnc/jobAsk';
import type { MeshResult } from '../cad/mesh';

export interface Planned {
  entry: ShopEntry;
  flat: FlatMesh;
  /** The design's evaluated mesh, laid flat, for the 3D view. */
  mesh: MeshResult;
  stl: Uint8Array;
  config: JobConfig;
  sectionZ: number;
  chosen: string[];
  report: Report;
  sha256: string | null;
  facts: SetupFacts | null;
  factsWhy: string | null;
  stock: { x: number; y: number; t: number };
}

export type PlanResult = { ok: true; plan: Planned } | { ok: false; why: string };

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The evaluated design laid flat, as a mesh the 3D view can draw. */
export async function flatDesign(designId: string): Promise<{ flat: FlatMesh; mesh: MeshResult } | { why: string }> {
  const d = await loadDesign(designId);
  const lib: ScadLibrary = { files: new Map(Object.entries(d.sources)), rootName: '', pickedAt: 0, skipped: [] };
  const ev = evaluateForMachine(d.sources[d.path], { path: d.path, host: makeLibraryHost(lib) });
  if (ev.exhausted !== null) return { why: `The design is too large for the in-browser kernel at every resolution: ${ev.exhausted}` };
  const solids = cutSolids(ev.mesh.parts);
  const flat = layFlat(solids, CLAMP_MARGIN_MM);
  if (!flat) return { why: 'The design produced no solid to cut.' };
  const parts = solids.map((p, i) => {
    const pos = flat.solids[i].positions;
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < pos.length; k += 3) for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a], pos[k + a]);
      max[a] = Math.max(max[a], pos[k + a]);
    }
    return { ...p, positions: pos, bounds: { min, max } };
  });
  return { flat, mesh: { ...ev.mesh, parts } };
}

/**
 * Cutters a job config asks for that the shop (and this machine) does not hold.
 *
 * 🔴 The patch is laid over the config AFTER the owned/machine filter, and the proposal reader
 * only checks `tool_ids` against the whole LIBRARY. So an AI or chip proposal could put a cutter
 * nobody owns into the 2bee.cnc plan — "Cutters: only the N this machine holds" while the
 * program used another, and the job queued; only Start's loaded check caught it (bughunt
 * 2026-11-15). The plan is refused instead.
 */
export function unownedTools(config: { tool_ids?: unknown }, owned: readonly string[]): string[] {
  const ids = Array.isArray(config.tool_ids) ? (config.tool_ids as unknown[]).filter((x): x is string => typeof x === 'string') : [];
  return ids.filter((t) => !owned.includes(t));
}

/**
 * Plan a design. `toolIds` narrows the registered cutters to a machine's
 * (empty = every registered cutter). `patch` is an accepted assistant change.
 */
export async function planDesign(entry: ShopEntry, opts: { toolIds?: readonly string[]; patch?: JobPatch | null; machine?: { hostname: string; profile: MachineProfile | null } | null } = {}): Promise<PlanResult> {
  try {
    const fd = await flatDesign(entry.id);
    if ('why' in fd) return { ok: false, why: fd.why };
    const inv = await readInventory().catch(() => null);
    const lib = await toolLibrary();
    const libIds = lib.tools.map((t) => t.id);
    let owned = ownedToolIds(inv?.doc ?? null, libIds);
    const machineNote: string[] = [];
    if (opts.toolIds && opts.toolIds.length) {
      owned = owned.filter((t) => opts.toolIds!.includes(t));
      machineNote.push(`Cutters: only the ${owned.length} this machine holds.`);
    }
    const job = jobFor(fd.flat, owned);
    if (!job.ok) return { ok: false, why: job.why };
    const mv = operatorMaterial(useCncStore.getState(), (lib.materials ?? []).map((m) => m.name));
    if (mv.state !== 'known') return { ok: false, why: `Material: ${mv.why} Set it in Expert tools (Material).` };
    const material = mv.name;
    const mc = machineConfig(opts.machine);
    machineNote.push(mc.note);
    const base = { ...job.config, material, machine: { ...(mc.machine ?? {}), ...shopFields(useCncStore.getState()) } };
    const config = opts.patch ? candidateConfig(base, opts.patch) : base;
    const notHeld = unownedTools(config, owned);
    if (notHeld.length) {
      return { ok: false, why: `The change asks for ${notHeld.join(', ')}, which ${opts.toolIds && opts.toolIds.length ? 'this machine does not hold' : 'the shop does not own'}. Nothing was planned with it.` };
    }
    const stl = flatStl(fd.flat, entry.title);
    const report = await planImportBytes(stl, 'stl', config, job.sectionZ);
    const st = config.stock as { size_x_mm: number; size_y_mm: number; thickness_mm: number };
    let facts: SetupFacts | null = null;
    let factsWhy: string | null = null;
    let sha: string | null = null;
    if (report.ok) {
      sha = await sha256Hex(report.gcode);
      const ans = await setupFactsForImport(stl, 'stl', config, job.sectionZ);
      if (!ans.facts) factsWhy = `Setup could not be read: ${ans.refused.join('; ')}`;
      else if (ans.gcode_sha256 !== sha) factsWhy = 'The setup facts were read from a different program than the one planned.';
      else facts = ans.facts;
    }
    return {
      ok: true,
      plan: {
        entry,
        flat: fd.flat,
        mesh: fd.mesh,
        stl,
        config,
        sectionZ: job.sectionZ,
        chosen: [...job.chosen, ...machineNote, `Material: ${material}, from your 2bee.cnc settings.`],
        report,
        sha256: sha,
        facts,
        factsWhy,
        stock: { x: st.size_x_mm, y: st.size_y_mm, t: st.thickness_mm },
      },
    };
  } catch (e) {
    return { ok: false, why: `The job could not be planned: ${String((e as Error).message ?? e)}` };
  }
}

/** Plan a candidate config for the assistant (same core call, same bytes). */
export async function planCandidate(p: Planned, config: JobConfig): Promise<Report> {
  return planImportBytes(p.stl, 'stl', config, p.sectionZ);
}

/** The results line: time · cutters · tool changes · deepest cut. */
export function resultsLine(r: Pick<Report, 'estimated_seconds' | 'tools_used' | 'tool_changes' | 'deepest_z_mm'>): string {
  const min = Math.max(1, Math.round(r.estimated_seconds / 60));
  const n = new Set(r.tools_used).size;
  return `${min} min · ${n} cutter${n === 1 ? '' : 's'} · ${r.tool_changes} tool change${r.tool_changes === 1 ? '' : 's'} · deepest ${Math.round(-r.deepest_z_mm * 10) / 10} mm`;
}
